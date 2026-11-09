import { join } from 'node:path'

/**
 * MCP Bridge 的线协议与路径约定。
 *
 * 传输：Unix domain socket + NDJSON（一行一个请求/一行一个响应）。
 * 单行 ≤ 1MB；requestId 由客户端生成、响应原样带回，连接内严格串行。
 *
 * Windows 的 Named Pipe ACL 未验证 → V1 只在 darwin/linux 启动 Bridge；
 * 绝不退化为监听 TCP。
 */

export const BRIDGE_PROTOCOL_VERSION = 1
export const BRIDGE_MAX_LINE_BYTES = 1024 * 1024

export type BridgeMethod = 'tools.call'

export type BridgeRequest = {
  requestId: string
  protocolVersion: number
  method: BridgeMethod
  tool: string
  token: string
  params: unknown
}

export type BridgeError = {
  code: string
  message: string
}

export type BridgeResponse = {
  requestId: string
  success: boolean
  data?: unknown
  error?: BridgeError
}

/** `<userData>/mcp/bridge-info.json` 的内容——**不含 token**。 */
export type BridgeInfo = {
  socketPath: string
  protocolVersion: number
  pid: number
  appVersion: string
}

export type BridgePaths = {
  dir: string
  socketPath: string
  infoPath: string
}

export function bridgePaths(userDataDir: string): BridgePaths {
  const dir = join(userDataDir, 'mcp')
  return {
    dir,
    socketPath: join(dir, 'bridge.sock'),
    infoPath: join(dir, 'bridge-info.json')
  }
}

export function platformSupportsBridge(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux'
}
