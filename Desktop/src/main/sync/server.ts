import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Database } from 'better-sqlite3'
import { NonceStore, sha256, verifyRequest } from './auth'
import { PairingService } from './pairing-service'
import { applyBatch, type SyncBatch } from './snapshot-importer'
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
    const targets = addresses.length > 0 ? addresses : ['127.0.0.1']
    return new Promise((resolve, reject) => {
      let settled = false
      let lastError: Error | null = null
      let bound = 0
      const servers: Server[] = []

      for (const address of targets) {
        const server = createServer((request, response) => {
          void this.handle(request, response)
        })
        server.on('error', (error) => {
          lastError = error as Error
        })
        server.listen(preferredPort, address, () => {
          bound += 1
          if (!settled && bound > 0) {
            settled = true
            this.servers = servers
            this.boundAddresses = targets
            this.activePort = preferredPort
            this.onChanged()
            resolve(this.stateFor())
          }
        })
        // 端口被占：换一个端口重试一次（每个地址独立尝试）。
        server.on('error', () => {
          if (server.listening) return
          server.listen(0, address, () => {
            const addressInfo = server.address()
            const actualPort = typeof addressInfo === 'object' ? addressInfo?.port ?? null : null
            bound += 1
            servers.push(server)
            if (this.activePort === null && actualPort) this.activePort = actualPort
            this.boundAddresses = targets
            this.servers = servers
            if (!settled) {
              settled = true
              this.onChanged()
              resolve(this.stateFor())
            }
          })
        })
        servers.push(server)
      }

      setTimeout(() => {
        if (!settled && lastError) {
          for (const server of servers) server.close()
          reject(lastError)
        }
      }, 1500)
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
        const payload = JSON.parse(bodyResult.body.toString('utf8') || '{}') as {
          code?: string
          deviceName?: string
        }
        const outcome = this.pairing.exchange(
          String(payload.code ?? ''),
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
