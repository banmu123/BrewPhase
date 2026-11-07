import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Database } from 'better-sqlite3'
import { NonceStore, sha256, verifyRequest } from './auth'
import { PairingService } from './pairing-service'
import { applyBatch, type SyncBatch } from './snapshot-importer'
import { isSafeMediaName } from '../media/store'
import {
  checkManifest,
  finalizeMedia,
  receivedBytes,
  writeChunk,
  CHUNK_SIZE,
  type MediaManifestEntry
} from './media-transfer'

/**
 * 局域网同步服务（HTTP，沿用 BrewPing 已验证的安全模型）。
 *
 * - 只在用户启用同步时启动；stop 后句柄全部释放。
 * - 请求体限幅：JSON 批 8MB、媒体块 256KB，超限直接 413。
 * - 路由面固定六条：status / pair / sync manifest / sync apply / media 三件套。
 *   不存在任何「远程下发 SQL」或命令执行面。
 * - TLS 是下一跳（协议已留 certificateFingerprint 字段）；本版以一次性码 +
 *   每设备独立 token + 时间戳/nonce/HMAC 防护，威胁模型与 BrewPing 相同。
 */

const PROTOCOL_VERSION = 1
const MAX_JSON_BODY = 8 * 1024 * 1024
const MAX_CHUNK_BODY = CHUNK_SIZE + 64 * 1024

/** 探测一个当前空闲的端口（绑定 0 由 OS 分配后释放）。 */
function probeFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
    server.on('error', reject)
  })
}

export type SyncServerState = {
  running: boolean
  port: number | null
  addresses: string[]
}

export class SyncServer {
  private servers: Server[] = []
  private readonly pairing = new PairingService()
  private readonly nonces = new NonceStore()
  private activePort: number | null = null
  private boundAddresses: string[] = []

  constructor(
    private readonly sqlite: Database,
    private readonly desktopDeviceId: string,
    private readonly desktopDeviceName: string,
    private readonly onChanged: () => void
  ) {}

  pairingPayload(): { code: string; expiresAt: number } {
    return this.pairing.issue()
  }

  start(addresses: string[], preferredPort: number): Promise<SyncServerState> {
    if (this.servers.length > 0) return Promise.resolve(this.stateFor())
    // 所有发布地址必须共用**同一个端口**（§10）：多网卡各自回落 listen(0)
    // 会让二维码里的 host/port 组合对不上一部分地址。
    const targets = addresses.filter((address) => address.length > 0)
    if (targets.length === 0) {
      return Promise.reject(new Error('没有可绑定的局域网地址'))
    }
    type Attempt = { kind: 'fixed'; port: number } | { kind: 'probe' }
    const attempts: Attempt[] = [{ kind: 'fixed', port: preferredPort }]
    for (let index = 0; index < 5; index += 1) attempts.push({ kind: 'probe' })

    const attemptStart = async (): Promise<SyncServerState> => {
      let lastError: Error | null = null
      for (const attempt of attempts) {
        const port = attempt.kind === 'fixed' ? attempt.port : await probeFreePort()
        try {
          const servers = await this.bindAll(port, targets)
          this.servers = servers
          this.activePort = port
          this.boundAddresses = targets
          this.onChanged()
          return this.stateFor()
        } catch (error) {
          lastError = error as Error
        }
      }
      throw lastError ?? new Error('无法绑定同步服务端口')
    }
    return attemptStart()
  }

  /** 把全部地址绑到同一个端口；任何一个失败就整体回滚（不留半启动状态）。 */
  private bindAll(port: number, targets: string[]): Promise<Server[]> {
    return new Promise((resolve, reject) => {
      const opened: Server[] = []
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        for (const server of opened) server.close()
        reject(error)
      }
      targets.forEach((address, index) => {
        const server = createServer((request, response) => {
          void this.handle(request, response)
        })
        opened.push(server)
        server.on('error', fail)
        server.listen(port, address, () => {
          if (settled) return
          if (opened.every((item) => item.listening)) {
            settled = true
            resolve(opened)
          }
        })
        if (index === targets.length - 1) {
          // 兜底： listen 回调都可能不来（极端系统状态），超时判负。
          setTimeout(() => {
            if (settled) return
            if (opened.every((item) => item.listening)) {
              settled = true
              resolve(opened)
            } else {
              fail(new Error(`部分地址绑定 ${port} 超时`))
            }
          }, 1500)
        }
      })
    })
  }

  stop(): void {
    for (const server of this.servers) server.close()
    this.servers = []
    this.activePort = null
    this.onChanged()
  }

  stateFor(): SyncServerState {
    return {
      running: this.servers.length > 0,
      port: this.activePort,
      addresses: this.boundAddresses
    }
  }

  // MARK: - 路由

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://local')
      const route = `${request.method} ${url.pathname}`
      const source = request.socket.remoteAddress ?? null

      if (route === 'GET /api/status') {
        return this.json(response, 200, { service: 'brewphase-sync', protocolVersion: PROTOCOL_VERSION })
      }

      if (route === 'POST /api/pair') {
        const bodyResult = await this.readBody(request, MAX_JSON_BODY)
        if (!bodyResult.ok) return this.json(response, bodyResult.status, { error: bodyResult.error })
        // 字段名与 iOS 客户端、QR 深链、contracts 的 pairRequestSchema 对齐：
        // `pairingCode` 是主字段；`code` 仅作为旧客户端兜底。
        const payload = JSON.parse(bodyResult.body.toString('utf8') || '{}') as {
          pairingCode?: string
          code?: string
          deviceName?: string
        }
        const outcome = this.pairing.exchange(
          String(payload.pairingCode ?? payload.code ?? ''),
          source,
          String(payload.deviceName ?? ''),
          this.sqlite
        )
        if (!outcome.ok) return this.json(response, outcome.status, { error: outcome.error })
        this.onChanged()
        return this.json(response, 200, {
          token: outcome.token,
          deviceId: outcome.deviceId,
          desktopDeviceId: this.desktopDeviceId,
          desktopDeviceName: this.desktopDeviceName,
          protocolVersion: PROTOCOL_VERSION
        })
      }

      // 以下全部要求已配对设备。
      const device = this.authorize(request)
      if (!device) {
        return this.json(response, 401, { error: 'unauthorized' })
      }

      if (route === 'GET /api/sync/manifest') {
        const counts: Record<string, number> = {}
        for (const [type, table] of Object.entries({
          bean: 'beans', brew: 'brews', tasting: 'tastings', phaseRule: 'phase_rules',
          phaseReminder: 'phase_reminders', record: 'records', recordTag: 'record_tags',
          canvas: 'canvases', canvasNode: 'canvas_nodes'
        })) {
          counts[type] = Number(
            (this.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number } | undefined)?.n ?? 0
          )
        }
        this.touchDevice(device.id)
        return this.json(response, 200, {
          protocolVersion: PROTOCOL_VERSION,
          desktopDeviceId: this.desktopDeviceId,
          entityCounts: counts
        })
      }

      if (route === 'POST /api/sync/apply') {
        const bodyResult = await this.readBody(request, MAX_JSON_BODY)
        if (!bodyResult.ok) return this.json(response, bodyResult.status, { error: bodyResult.error })
        const auth = this.verifyWrite(request, device.token ?? '', bodyResult.body)
        if (!auth.ok) return this.json(response, auth.status, { error: auth.error })
        const batch = JSON.parse(bodyResult.body.toString('utf8')) as SyncBatch
        const outcome = applyBatch(this.sqlite, batch, device.id)
        if (outcome.failedItems.length > 0) {
          // 排障取证：真机同步失败时把请求体前段与失败原因打进主进程日志。
          console.error(
            `[sync] apply ${outcome.failedItems.length} failed; body head: ${bodyResult.body.toString('utf8').slice(0, 600)}`
          )
        }
        this.touchDevice(device.id, true)
        this.onChanged()
        return this.json(response, 200, outcome)
      }

      if (route === 'POST /api/sync/media/manifest') {
        const bodyResult = await this.readBody(request, MAX_JSON_BODY)
        if (!bodyResult.ok) return this.json(response, bodyResult.status, { error: bodyResult.error })
        const auth = this.verifyWrite(request, device.token ?? '', bodyResult.body)
        if (!auth.ok) return this.json(response, auth.status, { error: auth.error })
        const entries = JSON.parse(bodyResult.body.toString('utf8')).media as MediaManifestEntry[]
        const outcome = await checkManifest(Array.isArray(entries) ? entries : [])
        return this.json(response, 200, outcome)
      }

      if (route === 'POST /api/sync/media/chunk') {
        const name = String(url.searchParams.get('name') ?? '')
        const offset = Number(url.searchParams.get('offset') ?? '-1')
        const bodyResult = await this.readBody(request, MAX_CHUNK_BODY)
        if (!bodyResult.ok) return this.json(response, bodyResult.status, { error: bodyResult.error })
        const auth = this.verifyWrite(request, device.token ?? '', bodyResult.body)
        if (!auth.ok) return this.json(response, auth.status, { error: auth.error })
        const outcome = await writeChunk(name, offset, bodyResult.body)
        if (!outcome.ok) return this.json(response, 400, { error: outcome.reason })
        return this.json(response, 200, { received: outcome.received, chunkSize: CHUNK_SIZE })
      }

      if (route === 'POST /api/sync/media/finalize') {
        const bodyResult = await this.readBody(request, 64 * 1024)
        if (!bodyResult.ok) return this.json(response, bodyResult.status, { error: bodyResult.error })
        const auth = this.verifyWrite(request, device.token ?? '', bodyResult.body)
        if (!auth.ok) return this.json(response, auth.status, { error: auth.error })
        const payload = JSON.parse(bodyResult.body.toString('utf8')) as {
          name?: string
          sha256?: string
          byteSize?: number
        }
        const outcome = await finalizeMedia(
          String(payload.name ?? ''),
          String(payload.sha256 ?? ''),
          Number(payload.byteSize ?? 0)
        )
        if (!outcome.ok) return this.json(response, 400, { error: outcome.reason })
        this.onChanged()
        return this.json(response, 200, { stored: payload.name })
      }

      if (route === 'GET /api/sync/media/offset') {
        const name = String(url.searchParams.get('name') ?? '')
        // 文件名先过白名单再进路径计算（防 query 参数路径穿越）。
        if (!isSafeMediaName(name)) return this.json(response, 400, { error: 'unsafe media name' })
        return this.json(response, 200, { received: await receivedBytes(name) })
      }

      return this.json(response, 404, { error: 'not found' })
    } catch (error) {
      return this.json(response, 500, { error: (error as Error).message })
    }
  }

  // MARK: - 鉴权与工具

  private authorize(request: IncomingMessage): { id: string; token: string | null } | null {
    const header = (request.headers.authorization ?? '').trim()
    if (!header.toLowerCase().startsWith('bearer ')) return null
    const token = header.slice(7).trim()
    if (!token) return null
    const row = this.sqlite
      .prepare('select id, token_hash, revoked_at from devices where token_hash = ?')
      .get(sha256(token)) as { id: string; token_hash: string; revoked_at: number | null } | undefined
    if (!row || row.revoked_at !== null) return null
    // verifyRequest 需要明文 token 做恒定时间比较；这里从请求头取回。
    return { id: row.id, token }
  }

  /** 写请求验签：必须拿**真实 body** 计算 HMAC（签名覆盖 body 哈希）。 */
  private verifyWrite(
    request: IncomingMessage,
    token: string,
    body: Buffer
  ): { ok: true } | { ok: false; status: number; error: string } {
    const result = verifyRequest(
      {
        method: request.method ?? 'GET',
        token: request.headers.authorization?.slice(7).trim() ?? null,
        timestamp: (request.headers['x-bp-timestamp'] as string | undefined) ?? null,
        nonce: (request.headers['x-bp-nonce'] as string | undefined) ?? null,
        signature: (request.headers['x-bp-signature'] as string | undefined) ?? null,
        body,
        nonceStore: this.nonces
      },
      token
    )
    return result.ok ? { ok: true } : { ok: false, status: result.status, error: result.error }
  }

  private readBody(
    request: IncomingMessage,
    limit: number
  ): Promise<{ ok: true; body: Buffer } | { ok: false; status: number; error: string }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          resolve({ ok: false, status: 413, error: 'payload too large' })
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks) }))
      request.on('error', () => resolve({ ok: false, status: 400, error: 'read error' }))
    })
  }

  private touchDevice(id: string, synced = false): void {
    if (synced) {
      this.sqlite.prepare('update devices set last_seen_at = ?, last_sync_at = ? where id = ?').run(
        Date.now(), Date.now(), id
      )
      return
    }
    this.sqlite.prepare('update devices set last_seen_at = ? where id = ?').run(Date.now(), id)
  }

  private json(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  }
}
