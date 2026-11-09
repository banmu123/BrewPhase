import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:net'

/**
 * MCP 进程 → Electron Main 的 Bridge 客户端。
 *
 * 一请求一连接：每次调用都新建 socket、发一行、读一行、关闭。
 * 这样「响应与请求混淆」在结构上不可能发生；本地 socket 的开销可忽略。
 *
 * 连接信息每次从 `<userData>/mcp/bridge-info.json` 现读（App 重启后 pid 变、
 * socket 路径不变）；文件不存在或连不上 → `APP_NOT_RUNNING`。
 */

export type BridgeInfo = {
  socketPath: string
  protocolVersion: number
  pid: number
  appVersion: string
}

type BridgeResponse = {
  requestId: string
  success: boolean
  data?: unknown
  error?: { code: string; message: string }
}

const REQUEST_TIMEOUT_MS = 30_000

/** 与 shared/contracts/mcp.ts 的错误码一致；这里只做传输层。 */
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

export class BridgeClient {
  private readonly infoPath: string

  constructor(
    userDataDir: string,
    private readonly token: string
  ) {
    this.infoPath = join(userDataDir, 'mcp', 'bridge-info.json')
  }

  async call(tool: string, params: unknown): Promise<Record<string, unknown>> {
    const info = this.readInfo()
    const requestId = randomUUID()
    const line = JSON.stringify({
      requestId,
      protocolVersion: info.protocolVersion,
      method: 'tools.call',
      tool,
      token: this.token,
      params: params ?? {}
    })

    const response = await this.exchange(info.socketPath, line)
    if (response.requestId !== requestId) {
      throw new BridgeError('BRIDGE_PROTOCOL_MISMATCH', 'bridge responded to a different request')
    }
    if (!response.success) {
      throw new BridgeError(response.error?.code ?? 'INTERNAL_ERROR', response.error?.message ?? 'bridge request failed')
    }
    return (response.data ?? {}) as Record<string, unknown>
  }

  private readInfo(): BridgeInfo {
    let raw: string
    try {
      raw = readFileSync(this.infoPath, 'utf8')
    } catch {
      throw new BridgeError(
        'APP_NOT_RUNNING',
        'BrewPhase Desktop is not running (bridge-info.json not found). Start the desktop app first.'
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new BridgeError('BRIDGE_PROTOCOL_MISMATCH', 'bridge-info.json is corrupt')
    }
    const info = parsed as Partial<BridgeInfo>
    if (typeof info.socketPath !== 'string' || typeof info.protocolVersion !== 'number') {
      throw new BridgeError('BRIDGE_PROTOCOL_MISMATCH', 'bridge-info.json is missing required fields')
    }
    return info as BridgeInfo
  }

  private exchange(socketPath: string, line: string): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath)
      let buffer = ''
      let settled = false
      let timer: NodeJS.Timeout | null = null

      const finish = (error: Error | null, value?: BridgeResponse): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolve(value as BridgeResponse)
      }

      timer = setTimeout(
        () => finish(new BridgeError('REQUEST_TIMEOUT', `bridge request timed out after ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS
      )

      socket.setEncoding('utf8')
      socket.on('connect', () => socket.write(`${line}\n`))
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        try {
          finish(null, JSON.parse(buffer.slice(0, newline)) as BridgeResponse)
        } catch {
          finish(new BridgeError('INTERNAL_ERROR', 'bridge response is not valid JSON'))
        }
      })
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
          finish(new BridgeError('APP_NOT_RUNNING', 'BrewPhase Desktop is not running. Start the desktop app first.'))
          return
        }
        finish(new BridgeError('BRIDGE_UNAVAILABLE', error.message))
      })
      socket.on('close', () => {
        if (!settled) finish(new BridgeError('BRIDGE_UNAVAILABLE', 'bridge closed the connection without a response'))
      })
    })
  }
}
