import { hostname } from 'node:os'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import type { Database } from 'better-sqlite3'
import { SyncServer } from './server'
import { lanAddresses } from './network-address'

/**
 * 同步服务门面：Electron Main 进程持有，renderer 只能通过白名单 IPC 触达。
 *
 * 状态持久化在 `local_state`：sync.enabled / sync.desktopDeviceId。
 * 服务端口首选 47821，被占时由 server 自动回落并回填实际端口。
 * Bonjour 增强后置：二维码携带 host 直连信息（见 BREWPING_REUSE_AUDIT.md §1.3）。
 */

export const SYNC_PORT = 47821
export const SYNC_PROTOCOL_VERSION = 1

type Row = Record<string, unknown>

export type SyncStatus = {
  enabled: boolean
  running: boolean
  port: number | null
  addresses: string[]
  desktopDeviceId: string
  desktopDeviceName: string
  pairing: { qrText: string; qrDataUrl: string; expiresAt: number } | null
  devices: Array<{
    id: string
    name: string
    pairedAt: number
    lastSyncAt: number | null
  }>
  conflicts: number
}

export class SyncService {
  private server: SyncServer | null = null
  private pairing: { qrText: string; qrDataUrl: string; expiresAt: number } | null = null
  private readonly desktopDeviceId: string
  private readonly desktopDeviceName: string

  constructor(
    private readonly sqlite: Database,
    private readonly onEvent: (event: { type: string }) => void
  ) {
    this.desktopDeviceId = this.loadOrCreateDesktopDeviceId()
    this.desktopDeviceName = `BrewPhase · ${hostname()}`
  }

  private loadOrCreateDesktopDeviceId(): string {
    const existing = this.sqlite
      .prepare("select value from local_state where key = 'sync.desktopDeviceId'")
      .get() as { value: string } | undefined
    if (existing) return existing.value
    const id = `bp_desk_${Math.random().toString(36).slice(2, 10)}`
    this.sqlite
      .prepare("insert or replace into local_state (key, value) values ('sync.desktopDeviceId', ?)")
      .run(id)
    return id
  }

  private get enabled(): boolean {
    const row = this.sqlite
      .prepare("select value from local_state where key = 'sync.enabled'")
      .get() as { value: string } | undefined
    return row?.value === '1'
  }

  private setEnabled(value: boolean): void {
    this.sqlite
      .prepare("insert or replace into local_state (key, value) values ('sync.enabled', ?)")
      .run(value ? '1' : '0')
  }

  /** 启动应用时调用：按持久化的开关恢复服务。 */
  async restore(): Promise<void> {
    if (this.enabled) await this.enable()
  }

  async enable(enabled = true): Promise<SyncStatus> {
    if (!enabled) return this.disable()
    this.setEnabled(true)
    if (!this.server) {
      this.server = new SyncServer(this.sqlite, this.desktopDeviceId, this.desktopDeviceName, () =>
        this.onEvent({ type: 'state-changed' })
      )
    }
    const addresses = lanAddresses()
    try {
      await this.server.start(addresses, SYNC_PORT)
    } catch {
      // 全地址绑定失败：仍保留启用状态（下次启动重试），状态里体现未运行。
    }
    return this.status()
  }

  async disable(): Promise<SyncStatus> {
    this.setEnabled(false)
    this.server?.stop()
    this.server = null
    this.pairing = null
    return this.status()
  }

  private requireServer(): SyncServer {
    if (!this.server || !this.server.stateFor().running) {
      throw new Error('同步服务未运行')
    }
    return this.server
  }

  /** 连接手机：生成配对码 + 二维码（brewphase://pair 深链 + PNG dataURL）。 */
  async startPairing(): Promise<SyncStatus> {
    const server = this.requireServer()
    const state = server.stateFor()
    const { code, expiresAt } = server.pairingPayload()
    const addresses = state.addresses.length > 0 ? state.addresses : ['127.0.0.1']
    const params = new URLSearchParams({
      host: addresses[0],
      hosts: addresses.join(','),
      port: String(state.port ?? SYNC_PORT),
      deviceId: this.desktopDeviceId,
      deviceName: this.desktopDeviceName,
      pairingCode: code,
      protocolVersion: String(SYNC_PROTOCOL_VERSION),
      expiresAt: String(expiresAt)
    })
    const qrText = `brewphase://pair?${params.toString()}`
    const qrDataUrl = await QRCode.toDataURL(qrText, {
      width: 320,
      margin: 1,
      color: { dark: '#2a211a', light: '#ffffff' }
    })
    this.pairing = { qrText, qrDataUrl, expiresAt }
    return this.status()
  }

  async revokeDevice(id: string): Promise<SyncStatus> {
    this.sqlite.prepare('update devices set revoked_at = ? where id = ?').run(Date.now(), id)
    this.onEvent({ type: 'state-changed' })
    return this.status()
  }

  /** 冲突列表（含摘要），供设置页展示。 */
  conflicts(): Array<{
    id: string
    entityType: string
    entityId: string
    localFingerprint: string
    remoteFingerprint: string
    createdAt: number
    remoteSummary: string
  }> {
    const rows = this.sqlite
      .prepare('select * from sync_conflicts order by created_at desc limit 100')
      .all() as Array<Row>
    return rows.map((row) => ({
      id: String(row.id),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      localFingerprint: String(row.local_fingerprint),
      remoteFingerprint: String(row.remote_fingerprint),
      createdAt: Number(row.created_at),
      remoteSummary: summarize(row.remote_payload as string)
    }))
  }

  /**
   * 冲突裁决：`local` 删除冲突记录并把本地版本记为新基线（手机下次同步会
   * 收到冲突）；`remote` 接受手机版本（payload 已在冲突表里）。
   */
  resolveConflict(id: string, resolution: 'local' | 'remote'): SyncStatus {
    const row = this.sqlite
      .prepare('select * from sync_conflicts where id = ?')
      .get(id) as Row | undefined
    if (!row) return this.status()

    if (resolution === 'remote') {
      const payload = JSON.parse(String(row.remote_payload)) as Record<string, unknown>
      this.applySingle(row.entity_type as EntityType, String(row.entity_id), payload)
    } else {
      const localFp = this.localFingerprintFor(row.entity_type as EntityType, String(row.entity_id))
      if (localFp) {
        this.sqlite
          .prepare(
            `insert into sync_baseline (entity_type, entity_id, fingerprint, synced_at)
             values (?, ?, ?, ?)
             on conflict (entity_type, entity_id) do update set fingerprint = excluded.fingerprint, synced_at = excluded.synced_at`
          )
          .run(String(row.entity_type), String(row.entity_id), localFp, Date.now())
      }
    }
    this.sqlite.prepare('delete from sync_conflicts where id = ?').run(id)
    this.onEvent({ type: 'state-changed' })
    return this.status()
  }

  private applySingle(entityType: EntityType, id: string, payload: Record<string, unknown>): void {
    const table: Record<string, string> = {
      bean: 'beans', brew: 'brews', tasting: 'tastings', phaseRule: 'phase_rules',
      phaseReminder: 'phase_reminders', record: 'records', recordTag: 'record_tags',
      canvas: 'canvases', canvasNode: 'canvas_nodes'
    }
    const name = table[entityType]
    if (!name) return
    const columns: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(payload)) {
      const column = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase()
      columns.push(`${column} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (columns.length === 0) return
    this.sqlite.prepare(`update ${name} set ${columns.join(', ')} where id = ?`).run(...values, id)
    // 接受远端后，本地行内容 === 远端指纹，写基线防再次冲突。
    const row = this.sqlite.prepare(`select * from ${name} where id = ?`).get(id) as Row | undefined
    if (row) {
      const fp = fingerprintOf(entityType, row)
      if (fp) {
        this.sqlite
          .prepare(
            `insert into sync_baseline (entity_type, entity_id, fingerprint, synced_at)
             values (?, ?, ?, ?)
             on conflict (entity_type, entity_id) do update set fingerprint = excluded.fingerprint, synced_at = excluded.synced_at`
          )
          .run(entityType, id, fp, Date.now())
      }
    }
  }

  private localFingerprintFor(entityType: EntityType, id: string): string | null {
    const table: Record<string, string> = {
      bean: 'beans', brew: 'brews', tasting: 'tastings', phaseRule: 'phase_rules',
      phaseReminder: 'phase_reminders', record: 'records', recordTag: 'record_tags',
      canvas: 'canvases', canvasNode: 'canvas_nodes'
    }
    const name = table[entityType]
    if (!name) return null
    const row = this.sqlite.prepare(`select * from ${name} where id = ?`).get(id) as Row | undefined
    if (!row) return null
    return fingerprintOf(entityType, row)
  }

  async backupDatabase(): Promise<string> {
    const source = String(
      (this.sqlite.prepare("select value from local_state where key = 'db.path'").get() as Row | undefined)?.value ??
        ''
    )
    if (!source) return ''
    const backupPath = `${source}.before-sync-${Date.now()}`
    await fs.copyFile(source, backupPath)
    return backupPath
  }

  status(): SyncStatus {
    const devices = (
      this.sqlite
        .prepare('select id, name, paired_at, last_sync_at from devices where revoked_at is null order by paired_at desc')
        .all() as Array<Row>
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      pairedAt: Number(row.paired_at),
      lastSyncAt: row.last_sync_at === null ? null : Number(row.last_sync_at)
    }))
    const conflicts = Number(
      (this.sqlite.prepare('select count(*) as n from sync_conflicts').get() as { n: number }).n
    )
    const state = this.server?.stateFor()
    return {
      enabled: this.enabled,
      running: state?.running ?? false,
      port: state?.port ?? null,
      addresses: state?.addresses ?? lanAddresses(),
      desktopDeviceId: this.desktopDeviceId,
      desktopDeviceName: this.desktopDeviceName,
      pairing: this.pairing?.expiresAt && this.pairing.expiresAt > Date.now() ? this.pairing : null,
      devices,
      conflicts
    }
  }
}

function summarize(remotePayload: string): string {
  try {
    const payload = JSON.parse(remotePayload) as Record<string, unknown>
    const parts: string[] = []
    for (const key of ['title', 'name', 'method', 'note']) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim().length > 0) {
        parts.push(value.trim().slice(0, 40))
      }
    }
    return parts.join(' · ') || '(无摘要字段)'
  } catch {
    return '(无法解析)'
  }
}

// fingerprintOf 在 snapshot-importer 内部——这里重新导出复用。
import { localFingerprint as fingerprintOf, type EntityType } from './snapshot-importer'
