import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { BRIDGE_MAX_LINE_BYTES, BRIDGE_PROTOCOL_VERSION, type BridgeInfo, type BridgePaths, type BridgeRequest, type BridgeResponse } from './bridge-contract'
import { routeBridgeRequest, type RouterContext } from './request-router'

/**
 * Local Application Bridge：Unix domain socket + NDJSON。
 *
 * 生命周期（docs/MCP_ARCHITECTURE.md §3.1）：
 * - start：`mcp/` 目录 0700 → 探测既有 socket（活的不动、死的清掉）→ bind →
 *   socket 0600 → 原子发布 `bridge-info.json`；
 * - stop：断开所有连接、关闭 server、删除 socket 与 info；
 * - 崩溃残留：下次 start 的探测负责清理。
 *
 * 单行 1MB 上限；超限或 JSON 非法都回一个带错误码的响应再断开。
 */
export class BridgeServer {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private listening = false

  constructor(
    private readonly paths: BridgePaths,
    private readonly ctx: RouterContext,
    private readonly appVersion: string
  ) {}

  async start(): Promise<void> {
    if (this.listening) return

    await mkdir(this.paths.dir, { recursive: true, mode: 0o700 })
    await chmod(this.paths.dir, 0o700).catch(() => undefined)

    if (existsSync(this.paths.socketPath)) {
      const alive = await probeSocket(this.paths.socketPath)
      if (alive) {
        // 单实例锁下不应发生；真发生了也不能抢走别人的 socket。
        throw new Error('another BrewPhase bridge is already listening')
      }
      await unlink(this.paths.socketPath).catch(() => undefined)
    }

    const server = createServer((socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.paths.socketPath, () => resolve())
    })
    server.on('error', (error) => console.error('[mcp-bridge] server error', error))
    this.server = server
    this.listening = true

    await chmod(this.paths.socketPath, 0o600).catch(() => undefined)
    const info: BridgeInfo = {
      socketPath: this.paths.socketPath,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      pid: process.pid,
      appVersion: this.appVersion
    }
    await writeAtomic(this.paths.infoPath, `${JSON.stringify(info, null, 2)}\n`)
  }

  async stop(): Promise<void> {
    if (!this.server) return
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    this.listening = false
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await unlink(this.paths.socketPath).catch(() => undefined)
    await unlink(this.paths.infoPath).catch(() => undefined)
  }

  isRunning(): boolean {
    return this.listening
  }

  socketPath(): string {
    return this.paths.socketPath
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = ''
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
      if (buffer.length > BRIDGE_MAX_LINE_BYTES && !buffer.includes('\n')) {
        this.reply(socket, {
          requestId: '',
          success: false,
          error: { code: 'REQUEST_TOO_LARGE', message: `request exceeds ${BRIDGE_MAX_LINE_BYTES} bytes` }
        })
        close()
        return
      }
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) this.handleLine(socket, line)
      }
    })
  }

  private handleLine(socket: Socket, line: string): void {
    if (line.length > BRIDGE_MAX_LINE_BYTES) {
      this.reply(socket, {
        requestId: '',
        success: false,
        error: { code: 'REQUEST_TOO_LARGE', message: `request exceeds ${BRIDGE_MAX_LINE_BYTES} bytes` }
      })
      return
    }

    let request: BridgeRequest
    try {
      request = JSON.parse(line) as BridgeRequest
    } catch {
      this.reply(socket, {
        requestId: '',
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'request line is not valid JSON' }
      })
      return
    }

    let response: BridgeResponse
    try {
      response = routeBridgeRequest(this.ctx, request)
    } catch (error) {
      // 路由本身不应抛异常；真抛了也只回结构化错误。
      console.error('[mcp-bridge] route failed', error)
      response = {
        requestId: String(request.requestId ?? ''),
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'internal error' }
      }
    }
    this.reply(socket, response)
  }

  private reply(socket: Socket, response: BridgeResponse): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(response)}\n`)
  }
}

/** 探测 socket 上是否有活服务：能 connect 即活。 */
function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
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
