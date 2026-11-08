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

/** 冲突裁决按实体名找表；record_tag_links 是复合主键关系表，删除走专用分支。 */
const TABLE_FOR_CONFLICT: Record<string, string | null> = {
  bean: 'beans', brew: 'brews', tasting: 'tastings', phaseRule: 'phase_rules',
  phaseReminder: 'phase_reminders', record: 'records', recordTag: 'record_tags',
  recordTagLink: null, canvas: 'canvases', canvasNode: 'canvas_nodes'
}

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
    private readonly onEvent: (event: { type: string }) => void,
    /** 同步落库之后的本地元数据调度（见 index.ts 的 ResolveQueue） */
    private readonly onApplied?: (outcome: import('./snapshot-importer').ApplyResult) => void
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
      this.server = new SyncServer(
        this.sqlite,
        this.desktopDeviceId,
        this.desktopDeviceName,
        () => this.onEvent({ type: 'state-changed' }),
        this.onApplied
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
    // 二维码 host 只放**实际可达**的地址（§3）：绑定列表是具体 IP 时按它过滤；
    // 绑定 0.0.0.0（启用时无 LAN）时用当前枚举的全部局域网地址。没有可达
    // 地址时宁可不出码，也绝不给手机一个连不上的 127.0.0.1。
    const bound = state.addresses
    const boundAll = bound.includes('0.0.0.0')
    const addresses = boundAll ? lanAddresses() : lanAddresses().filter((address) => bound.includes(address))
    if (addresses.length === 0) {
      throw new Error('未检测到局域网地址：请确认这台 Mac 已连接 Wi-Fi 或网线，然后重新点「连接新手机」。')
    }
    const { code, expiresAt } = server.pairingPayload()
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

  /** 冲突列表（含摘要与操作类型），供设置页展示。 */
  conflicts(): Array<{
    id: string
    entityType: string
    entityId: string
    localFingerprint: string
    remoteFingerprint: string
    remoteOperation: 'upsert' | 'delete'
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
      remoteOperation: String(row.remote_operation ?? 'upsert') === 'delete' ? 'delete' : 'upsert',
      createdAt: Number(row.created_at),
      remoteSummary:
        String(row.remote_operation ?? 'upsert') === 'delete'
          ? '(手机端删除了这条记录)'
          : summarize(row.remote_payload as string)
    }))
  }

  /**
   * 冲突裁决：`local` 删除冲突记录并把本地版本记为新基线（手机下次同步会
   * 收到冲突/重发）；`remote` 接受手机版本。删除冲突的 `remote` 意味着
   * **删除电脑端这条记录**并清基线（§6.3）。
   */
  resolveConflict(id: string, resolution: 'local' | 'remote'): SyncStatus {
    const row = this.sqlite
      .prepare('select * from sync_conflicts where id = ?')
      .get(id) as Row | undefined
    if (!row) return this.status()

    const entityType = String(row.entity_type) as EntityType
    const entityId = String(row.entity_id)
    const isDelete = String(row.remote_operation ?? 'upsert') === 'delete'

    if (resolution === 'remote') {
      if (isDelete) {
        const name = TABLE_FOR_CONFLICT[entityType]
        if (name) {
          this.sqlite.prepare(`delete from ${name} where id = ?`).run(entityId)
          this.sqlite
            .prepare('delete from sync_baseline where entity_type = ? and entity_id = ?')
            .run(entityType, entityId)
        }
      } else {
        const payload = JSON.parse(String(row.remote_payload)) as Record<string, unknown>
        this.applySingle(entityType, entityId, payload)
      }
      // 接受手机版本：撤销该实体旧的「保留电脑版本」拒绝记录。
      this.sqlite
        .prepare('delete from sync_rejected where entity_type = ? and entity_id = ?')
        .run(entityType, entityId)
    } else {
      // 持久化「保留电脑版本」：记下被拒的远端指纹（§7），**不改写基线**——
      // 基线保持原值，iOS 端相同内容再推被 rejected skipped（其基线自行收敛），
      // 远端真实变化（新指纹）时重新进入合并（可能产生新冲突，绝不静默覆盖）。
      this.sqlite
        .prepare(
          `insert into sync_rejected (entity_type, entity_id, fingerprint, decided_at)
           values (?, ?, ?, ?)
           on conflict (entity_type, entity_id, fingerprint) do update set decided_at = excluded.decided_at`
        )
        .run(String(row.entity_type), String(row.entity_id), String(row.remote_fingerprint), Date.now())
    }
    this.sqlite.prepare('delete from sync_conflicts where id = ?').run(id)
    this.onEvent({ type: 'state-changed' })
    return this.status()
  }

  private applySingle(entityType: EntityType, id: string, payload: Record<string, unknown>): void {
    const name = TABLE_FOR_CONFLICT[entityType]
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
    const name = TABLE_FOR_CONFLICT[entityType]
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
