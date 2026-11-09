import { BridgeError, type BridgeClient } from '../bridge-client'

/**
 * 工具统一的返回形态：`content[0].text` 是可读 JSON，`structuredContent`
 * 是同一份对象。Bridge 的业务错误落成 `isError: true` + `{ error: { code, message } }`
 * ——AI 能读到错误码，但读不到堆栈与 SQL。
 */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export async function respond(
  bridge: BridgeClient,
  tool: string,
  args: unknown
): Promise<ToolResult> {
  try {
    const data = await bridge.call(tool, args ?? {})
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data
    }
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : 'INTERNAL_ERROR'
    const message = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
      isError: true
    }
  }
}
