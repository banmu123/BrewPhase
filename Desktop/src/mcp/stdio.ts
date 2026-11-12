#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { BridgeClient } from './bridge-client'
import { SERVER_INSTRUCTIONS } from './server-instructions'
import { registerRecordTools } from './tools/records'
import { registerCoffeeTools } from './tools/coffee'
import { registerCanvasTools } from './tools/canvas'
import { registerWorkContextTools } from './tools/work-context'

/**
 * brewphase-mcp —— BrewPhase AI Action Gateway 的 MCP STDIO 入口。
 *
 * 这个进程**没有数据库权限**：所有调用通过本地 Unix socket 转给 Electron Main，
 * 由 Main 做认证、scope 校验与业务写入。
 *
 * 规范：
 * - stdout 只承载 MCP 协议消息；所有日志走 stderr。
 * - Token 只从环境变量读（`BREWPHASE_MCP_TOKEN`）——命令行参数会被进程列表看到。
 * - 用户目录从 `--user-data-dir` 或 `BREWPHASE_MCP_USER_DATA_DIR` 读，不猜默认路径。
 */

const MCP_SERVER_VERSION = '1.0.0'

const USAGE = `brewphase-mcp — BrewPhase AI Action Gateway (MCP over stdio)

Usage:
  brewphase-mcp [--user-data-dir <path>] [--version] [--help]

Environment:
  BREWPHASE_MCP_USER_DATA_DIR   BrewPhase user-data directory (required unless --user-data-dir)
  BREWPHASE_MCP_TOKEN           Client access token from Settings → AI Connections (required)

Notes:
  - stdout carries MCP protocol messages only; logs go to stderr.
  - The BrewPhase desktop app must be running (V1 requires macOS/Linux).`

type ParsedArgs = { userDataDir: string | undefined; help: boolean; version: boolean }

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { userDataDir: undefined, help: false, version: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      result.help = true
    } else if (arg === '--version' || arg === '-v') {
      result.version = true
    } else if (arg === '--user-data-dir') {
      result.userDataDir = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--user-data-dir=')) {
      result.userDataDir = arg.slice('--user-data-dir='.length)
    } else {
      console.error(`[brewphase-mcp] unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return result
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  if (args.version) {
    process.stdout.write(`brewphase-mcp ${MCP_SERVER_VERSION}\n`)
    return
  }

  const userDataDir = args.userDataDir ?? process.env.BREWPHASE_MCP_USER_DATA_DIR
  const token = process.env.BREWPHASE_MCP_TOKEN
  if (!userDataDir) {
    console.error(
      '[brewphase-mcp] missing user data dir: pass --user-data-dir or set BREWPHASE_MCP_USER_DATA_DIR'
    )
    process.exit(1)
  }
  if (!token) {
    console.error('[brewphase-mcp] missing BREWPHASE_MCP_TOKEN (create a client in Settings → AI Connections)')
    process.exit(1)
  }

  const bridge = new BridgeClient(userDataDir, token)
  const server = new McpServer(
    { name: 'brewphase', version: MCP_SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS, maxToolInputElements: 5_000 }
  )
  registerRecordTools(server, bridge)
  registerCoffeeTools(server, bridge)
  registerCanvasTools(server, bridge)
  registerWorkContextTools(server, bridge)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[brewphase-mcp] ready (user-data: ${userDataDir})`)

  const shutdown = (): void => {
    void server
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  console.error('[brewphase-mcp] fatal', error)
  process.exit(1)
})
