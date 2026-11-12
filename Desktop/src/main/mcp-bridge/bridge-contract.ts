import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * MCP Bridge 的线协议与路径约定。
 *
 * 传输：本地 IPC + NDJSON（一行一个请求/一行一个响应）。
 * 单行 ≤ 1MB；requestId 由客户端生成、响应原样带回，连接内严格串行。
 *
 * - macOS / Linux：Unix domain socket（`mcp/bridge.sock`，目录 0700、socket 0600）。
 * - Windows：Named Pipe（`\\.\pipe\brewphase-mcp-v1-<userData 哈希>`）。
 *   Node 建 pipe 的默认 ACL 只允许当前用户 / SYSTEM / Administrators，
 *   等价于 Unix socket 的 0600；按 userData 哈希派生名字，多实例互不抢占。
 *   （Chrome Companion 的本地 IPC 在 Windows 上用同一机制，已实测。）
 *
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
  if (process.platform === 'win32') {
    // Named Pipe：路径不是文件系统路径，`socketPath` 只用于 net listen/connect。
    // 哈希取 userData 绝对路径，避免多用户/便携实例互相抢占。
    const hash = createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)
    return {
      dir,
      socketPath: `\\\\.\\pipe\\brewphase-mcp-v1-${hash}`,
      infoPath: join(dir, 'bridge-info.json')
    }
  }
  return {
    dir,
    socketPath: join(dir, 'bridge.sock'),
    infoPath: join(dir, 'bridge-info.json')
  }
}

export function platformSupportsBridge(): boolean {
  // Windows 走 Named Pipe（默认 ACL 限当前用户），与 macOS/Linux 的 socket 同级安全。
  return process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
}
