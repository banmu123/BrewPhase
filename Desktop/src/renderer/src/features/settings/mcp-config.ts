import type { McpBridgeStatus } from '@shared/contracts'

/**
 * MCP 配置片段生成。
 *
 * 设置页与首次引导共用同一份模板。两处各写一套的后果很具体：引导里给的
 * 配置能连、设置里给的不行，而两边看起来都是对的——这类问题最难查。
 *
 * 只做字符串组装，不读全局状态：入口路径与数据目录由调用方传入，
 * 因此可以在单测里直接断言输出。
 */

export type McpConfigTarget = {
  /** MCP 入口的绝对路径（打包后是 <resources>/mcp/stdio.mjs）。 */
  entryPath: string
  /** BrewPhase 的用户数据目录，MCP 进程据此找到 Bridge。 */
  userDataDir: string
}

/** 从 Bridge 状态里取出配置所需的两项；缺一不可，因此单独抛错。 */
export function configTargetFrom(status: McpBridgeStatus | null): McpConfigTarget | null {
  if (!status?.mcpEntryPath || !status.userDataDir) return null
  return { entryPath: status.mcpEntryPath, userDataDir: status.userDataDir }
}

/**
 * Codex 的 `~/.codex/config.toml` 片段。
 *
 * TOML 里反斜杠是转义符，Windows 路径必须成对转义，否则 `\U` 之类会直接把
 * 配置解析坏掉。
 */
export function codexConfig(target: McpConfigTarget, token: string): string {
  return `[mcp_servers.brewphase]
command = "node"
args = ["${escapeToml(target.entryPath)}"]

[mcp_servers.brewphase.env]
BREWPHASE_MCP_TOKEN = "${escapeToml(token)}"
BREWPHASE_MCP_USER_DATA_DIR = "${escapeToml(target.userDataDir)}"`
}

/** WorkBuddy 的 `~/.workbuddy/mcp.json` 片段。 */
export function workbuddyConfig(target: McpConfigTarget, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        brewphase: {
          type: 'stdio',
          command: 'node',
          args: [target.entryPath],
          env: {
            BREWPHASE_MCP_TOKEN: token,
            BREWPHASE_MCP_USER_DATA_DIR: target.userDataDir
          },
          timeout: 30000
        }
      }
    },
    null,
    2
  )
}

/**
 * 通用 MCP 配置（其它客户端）。字段与 WorkBuddy 相同，但刻意不带
 * `type` / `timeout`：不同客户端对这些可选字段的容忍度不一样。
 */
export function genericConfig(target: McpConfigTarget, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        brewphase: {
          command: 'node',
          args: [target.entryPath],
          env: {
            BREWPHASE_MCP_TOKEN: token,
            BREWPHASE_MCP_USER_DATA_DIR: target.userDataDir
          }
        }
      }
    },
    null,
    2
  )
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
