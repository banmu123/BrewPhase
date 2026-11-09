import type { McpErrorCode } from '../../shared/contracts/mcp'

/**
 * 业务错误：Main 的 IPC 与 Bridge 共用同一种错误类型。
 * `code` 是 MCP 错误码；IPC 只把 message 传给 renderer（既有约定）。
 */
export class ApplicationError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ApplicationError'
  }
}

export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError
}
