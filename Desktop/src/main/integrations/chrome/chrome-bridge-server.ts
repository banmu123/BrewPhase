import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  CHROME_BRIDGE_MAX_LINE_BYTES,
  CHROME_BRIDGE_PROTOCOL_VERSION,
  chromeBridgeHelloAckSchema,
  chromeBridgeHelloSchema,
  chromeCompanionRequestSchema,
  type ChromeBridgeHelloAck,
  type ChromeCompanionRequest,
  type ChromeCompanionResponse
} from '../../../shared/contracts/chrome-bridge'

/**
 * Chrome Companion 的本地接入点（Main Process）。
 *
 * 传输与 MCP Bridge 保持同一套纪律，但**不复用同一个 socket**：MCP 走 JSON-RPC，
 * Chrome 走自己的 save 协议，混在一起只会让两边都被迫理解对方的错误模型。
 *
 * - Windows：Named Pipe（`\\.\pipe\brewphase-chrome-v1-<userData 哈希>`）。
 *   Node 创建的 pipe 默认只允许当前用户、SYSTEM 与 Administrators，不监听 TCP。
 * - macOS / Linux：`<userData>/chrome/bridge.sock`，目录 0700、socket 0600。
 *
 * 首行必须是 `hello`（带 Desktop 本次启动随机生成的 token）；握手失败立即断开。
 * 之后一行一条请求、一行一条响应（NDJSON），单行上限 256KB。
 */

export type ChromeBridgePaths = {
  dir: string
  /** Windows 是 pipe 名，macOS/Linux 是 socket 绝对路径。 */
  endpoint: string
  infoPath: string
}

export function chromeBridgePaths(userDataDir: string): ChromeBridgePaths {
  const dir = join(userDataDir, 'chrome')
  if (process.platform === 'win32') {
    // 多用户 / 多便携实例各自一个 pipe，避免不同 userData 抢同一个名字。
    const suffix = createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)
    return {
      dir,
      endpoint: `\\\\.\\pipe\\brewphase-chrome-v1-${suffix}`,
      infoPath: join(dir, 'bridge-info.json')
    }
  }
  return {
    dir,
    endpoint: join(dir, 'bridge.sock'),
    infoPath: join(dir, 'bridge-info.json')
  }
}

export type ChromeBridgeHandler = (
  request: ChromeCompanionRequest
) => ChromeCompanionResponse | Promise<ChromeCompanionResponse>

export class ChromeBridgeServer {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly token = randomBytes(32).toString('hex')
  private listening = false
  private lastError: string | null = null

  constructor(
    private readonly paths: ChromeBridgePaths,
    private readonly handler: ChromeBridgeHandler,
    private readonly appVersion: string
  ) {}

  isRunning(): boolean {
    return this.listening
  }

  endpoint(): string {
    return this.paths.endpoint
  }

  /** 仅供 Host 安装器写 `host-config.json`；不通过 IPC 暴露给 Renderer。 */
  authToken(): string {
    return this.token
  }

  error(): string | null {
    return this.lastError
  }

  async start(): Promise<void> {
    if (this.listening) return

    await mkdir(this.paths.dir, { recursive: true, mode: 0o700 })
    await chmod(this.paths.dir, 0o700).catch(() => undefined)

    if (process.platform !== 'win32') {
      if (await probeSocket(this.paths.endpoint)) {
        throw new Error('another BrewPhase Chrome bridge is already listening')
      }
      await unlink(this.paths.endpoint).catch(() => undefined)
    }

    const server = createServer((socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.paths.endpoint, () => resolve())
    })
    server.on('error', (error) => {
      this.lastError = error.message
      console.error('[chrome-bridge] server error', error)
    })
    this.server = server
    this.listening = true
    this.lastError = null

    if (process.platform !== 'win32') {
      await chmod(this.paths.endpoint, 0o600).catch(() => undefined)
    }

    // 不含 token：这个文件只用于「Desktop 的本地服务是否在跑」的状态展示。
    await writeAtomic(
      this.paths.infoPath,
      `${JSON.stringify(
        {
          endpoint: this.paths.endpoint,
          protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
          pid: process.pid,
          appVersion: this.appVersion
        },
        null,
        2
      )}\n`
    )
  }

  async stop(): Promise<void> {
    if (!this.server) return
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    this.listening = false
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') {
      await unlink(this.paths.endpoint).catch(() => undefined)
    }
    await unlink(this.paths.infoPath).catch(() => undefined)
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = ''
    let authed = false
    let closed = false

    const close = (): void => {
      if (closed) return
      closed = true
      this.sockets.delete(socket)
      socket.destroy()
    }

    socket.setEncoding('utf8')
    socket.on('close', () => {
      closed = true
      this.sockets.delete(socket)
    })
    socket.on('error', () => close())

    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > CHROME_BRIDGE_MAX_LINE_BYTES && !buffer.includes('\n')) {
        close()
        return
      }

      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue

        if (!authed) {
          if (!this.handleHello(socket, line)) {
            close()
            return
          }
          authed = true
          continue
        }

        void this.handleLine(socket, line)
      }
    })
  }

  private handleHello(socket: Socket, line: string): boolean {
    let ack: ChromeBridgeHelloAck
    try {
      const parsed = chromeBridgeHelloSchema.safeParse(JSON.parse(line))
      if (!parsed.success || parsed.data.token !== this.token) {
        ack = { type: 'hello', ok: false, message: 'invalid handshake' }
      } else {
        ack = { type: 'hello', ok: true, appVersion: this.appVersion }
      }
    } catch {
      ack = { type: 'hello', ok: false, message: 'invalid handshake' }
    }
    this.reply(socket, chromeBridgeHelloAckSchema.parse(ack))
    return ack.ok
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let request: ChromeCompanionRequest
    try {
      const parsed = chromeCompanionRequestSchema.safeParse(JSON.parse(line))
      if (!parsed.success) {
        this.reply(socket, {
          version: CHROME_BRIDGE_PROTOCOL_VERSION,
          requestId: '',
          success: false,
          code: 'INVALID_REQUEST',
          message: parsed.error.issues[0]?.message ?? 'invalid request'
        })
        return
      }
      request = parsed.data
    } catch {
      this.reply(socket, {
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        requestId: '',
        success: false,
        code: 'INVALID_REQUEST',
        message: 'request is not valid JSON'
      })
      return
    }

    try {
      this.reply(socket, await this.handler(request))
    } catch (error) {
      console.error('[chrome-bridge] handler failed', error instanceof Error ? error.name : 'unknown')
      this.reply(socket, {
        version: CHROME_BRIDGE_PROTOCOL_VERSION,
        requestId: request.requestId,
        success: false,
        code: 'INTERNAL_ERROR',
        message: 'internal error'
      })
    }
  }

  private reply(socket: Socket, payload: unknown): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(payload)}\n`)
  }
}

function probeSocket(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(endpoint)
    const done = (alive: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(alive)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, path)
}
