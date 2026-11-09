import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { pinLocale } from './locale'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

/**
 * MCP E2E：真实 Electron + 真实 Unix socket + 真实 MCP 子进程。
 *
 * 覆盖验收清单里必须端到端证明的部分：
 * 1. Electron 启动后 Bridge 自动启动；
 * 2. 授权客户端能通过 STDIO 发现工具并调用；
 * 3. Agent 写入后 Records 页面自动刷新（app:changed）；
 * 4. 撤销授权后同一连接的下一次调用被拒绝；
 * 5. Electron 退出后 bridge-info 被清理，重启后 Bridge 重新启动。
 *
 * 用独立的 BREWPHASE_USER_DATA_DIR（临时目录），不碰真实库。
 * 前置：`pnpm build && pnpm mcp:build`（e2e 跑的是打包产物）。
 */
const ENTRY = join(__dirname, '../../out/mcp/stdio.mjs')

function launchEnv(userData: string): NodeJS.ProcessEnv {
  const env = { ...process.env, BREWPHASE_USER_DATA_DIR: userData }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

test('MCP：Bridge 随 App 启停、Agent 写入、UI 刷新、撤销即失效', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-mcp-e2e-'))
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env: launchEnv(userData) })
  const page = await app.firstWindow()
  await pinLocale(page)
  await expect(page.locator('.sidebar__brand')).toHaveText('BREWPHASE')

  // 1) Bridge 随主进程启动，而且 socket 文件真实存在
  const status = await page.evaluate(async () => window.brewphase.mcp.bridgeStatus())
  expect(status.running).toBe(true)
  expect(status.socketPath ?? '').toContain('bridge.sock')
  expect(status.mcpEntryPath).toContain(join('out', 'mcp', 'stdio.mjs'))

  // 2) 通过设置页同款 IPC 创建客户端，拿到一次性 token
  const created = await page.evaluate(async () =>
    window.brewphase.mcp.createClient({
      name: 'E2E Agent',
      scopes: ['records:read', 'records:create', 'canvas:read', 'canvas:write']
    })
  )
  expect(created.token.startsWith('bp_mcp_')).toBe(true)

  // 3) 真实 MCP 子进程：工具发现 + 创建记录
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      BREWPHASE_MCP_TOKEN: created.token,
      BREWPHASE_MCP_USER_DATA_DIR: userData
    },
    stderr: 'inherit'
  })
  const client = new Client({ name: 'brewphase-e2e', version: '1.0.0' })
  await client.connect(transport)

  const tools = await client.listTools()
  expect(tools.tools.length).toBe(18)

  const title = `E2E 记录 ${Date.now()}`
  const createdRecord = await client.callTool({
    name: 'create_record',
    arguments: { carrier: 'text', title, note: 'agent 写入', idempotency_key: `e2e-${Date.now()}` }
  })
  expect(createdRecord.isError).toBeFalsy()
  expect((createdRecord.structuredContent as { sync_status: string }).sync_status).toBe('desktop_local_only')

  // 4) 不切页也自动刷新：Records 页面订阅了 app:changed
  await page.getByRole('button', { name: '记录', exact: true }).click()
  await expect(page.getByText(title, { exact: false }).first()).toBeVisible({ timeout: 10_000 })

  // 5) 画布写入同样走真链（创建画布 + 便签）
  const canvas = await client.callTool({
    name: 'create_canvas',
    arguments: { name: 'E2E 画布', idempotency_key: `e2e-canvas-${Date.now()}` }
  })
  expect(canvas.isError).toBeFalsy()
  const canvasId = (canvas.structuredContent as { canvas_id: string }).canvas_id
  const note = await client.callTool({
    name: 'create_canvas_note',
    arguments: { canvas_id: canvasId, title: 'E2E 便签', body: '来自 Agent', idempotency_key: `e2e-note-${Date.now()}` }
  })
  expect(note.isError).toBeFalsy()

  await page.getByRole('button', { name: '画布', exact: true }).click()
  await expect(page.getByText('E2E 画布').first()).toBeVisible({ timeout: 10_000 })

  // 6) 撤销后下一次调用 → UNAUTHORIZED（Main 每请求查库）
  await page.evaluate(async (id) => window.brewphase.mcp.revokeClient(id), created.id)
  const denied = await client.callTool({
    name: 'create_record',
    arguments: { carrier: 'text', title: '撤销后写入', idempotency_key: 'revoked-1' }
  })
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain('UNAUTHORIZED')
  await client.close()

  // 7) 退出：Bridge 清理（socket + info）
  await app.close()
  expect(existsSync(join(userData, 'mcp', 'bridge-info.json'))).toBe(false)
  expect(existsSync(join(userData, 'mcp', 'bridge.sock'))).toBe(false)

  // 8) 重启：Bridge 能重新启动（失效 socket 不会挡路）
  const app2 = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env: launchEnv(userData) })
  const page2 = await app2.firstWindow()
  await pinLocale(page2)
  await expect(page2.locator('.sidebar__brand')).toHaveText('BREWPHASE')
  const status2 = await page2.evaluate(async () => window.brewphase.mcp.bridgeStatus())
  expect(status2.running).toBe(true)
  await app2.close()

  rmSync(userData, { recursive: true, force: true })
})
