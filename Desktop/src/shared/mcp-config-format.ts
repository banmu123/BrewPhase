/**
 * 配置片段生成时共用的转义规则。
 *
 * 放在 shared 是因为两边都要用：Renderer 生成给用户复制/预览，
 * Main 在写文件时生成真正落盘的内容。两套规则迟早会分叉，
 * 而分叉的后果是「预览看着对、写进去解析失败」。
 */

/** TOML 基本字符串里的反斜杠与双引号必须转义。 */
export function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 生成 Codex 的 `[mcp_servers.brewphase]` 段落（不含前后空行）。 */
export function renderCodexBlock(params: {
  entryPath: string
  userDataDir: string
  token: string
}): string {
  return `[mcp_servers.brewphase]
command = "node"
args = ["${escapeTomlString(params.entryPath)}"]

[mcp_servers.brewphase.env]
BREWPHASE_MCP_TOKEN = "${escapeTomlString(params.token)}"
BREWPHASE_MCP_USER_DATA_DIR = "${escapeTomlString(params.userDataDir)}"`
}

/** 生成 WorkBuddy 的 brewphase 条目（对象形式，由调用方序列化）。 */
export function renderWorkBuddyEntry(params: {
  entryPath: string
  userDataDir: string
  token: string
}): Record<string, unknown> {
  return {
    type: 'stdio',
    command: 'node',
    args: [params.entryPath],
    env: {
      BREWPHASE_MCP_TOKEN: params.token,
      BREWPHASE_MCP_USER_DATA_DIR: params.userDataDir
    },
    timeout: 30000
  }
}
