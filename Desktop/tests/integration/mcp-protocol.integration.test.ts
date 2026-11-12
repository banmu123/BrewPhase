import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { McpScope } from '@shared/contracts/mcp'
import { platformSupportsBridge } from '../../src/main/mcp-bridge/bridge-contract'
import { WorkContextService } from '../../src/main/application/work-context/work-context-service'
import { PersonalDirectionService } from '../../src/main/application/personal-direction/personal-direction-service'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { RecordService } from '../../src/main/application/records/record-service'
import { CoffeeService } from '../../src/main/application/coffee/coffee-service'
import { CanvasService } from '../../src/main/application/canvas/canvas-service'
import { McpClientService } from '../../src/main/application/authorization/permission-service'
import { BridgeServer } from '../../src/main/mcp-bridge/bridge-server'
import { bridgePaths } from '../../src/main/mcp-bridge/bridge-contract'
import type { RouterContext } from '../../src/main/mcp-bridge/request-router'

/**
 * MCP 协议测试：**真实 spawn** `out/mcp/stdio.mjs`，用官方 SDK Client 通过
 * STDIO 走 initialize → tools/list → tools/call。
 *
 * 这里验证的是协议层事实：工具发现、schema 广告、结构化结果、错误结果、
 * stdout 不被日志污染。业务真链已在 mcp.test.ts / mcp-bridge 测试里覆盖。
 *
 * 前置：先 `pnpm mcp:build`（CI/本地跑测试前构建一次）。
 */
const ENTRY = join(__dirname, '../../out/mcp/stdio.mjs')
const ALL_SCOPES: McpScope[] = [
  'records:read',
  'records:create',
  'records:update',
  'tags:read',
  'tags:create',
  'coffee:read',
  'canvas:read',
  'canvas:write'
]

// stdio 进程通过 Local Bridge 访问数据，Bridge 与上面的 socket 测试同一
// 个产品边界：V1 仅 darwin/linux，Windows 上整个跳过。
describe.skipIf(!platformSupportsBridge())('MCP 协议面 — 真实 stdio，仅 darwin/linux', () => {
  let dir: string
  let handle: DatabaseHandle
  let ctx: RouterContext
  let server: BridgeServer
  let token: string
  let client: Client

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'brewphase-mcp-protocol-'))
    handle = openDatabase(join(dir, 'test.db'))
    const events = new ApplicationEvents()
    ctx = {
      db: handle.db,
      clients: new McpClientService(handle.db),
      records: new RecordService(handle.db, handle.deviceId, events, () => undefined),
      coffee: new CoffeeService(handle.db),
      canvas: new CanvasService(handle.db, handle.deviceId, events),
      workContexts: new WorkContextService(handle.db, events),

      personalDirection: new PersonalDirectionService(handle.db, events),
    }
    server = new BridgeServer(bridgePaths(dir), ctx, '0.1.0-test')
    await server.start()

    token = ctx.clients.create({ name: 'Protocol Test', scopes: ALL_SCOPES }).token
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: {
        ...process.env,
        BREWPHASE_MCP_TOKEN: token,
        BREWPHASE_MCP_USER_DATA_DIR: dir
      },
      stderr: 'pipe'
    })
    client = new Client({ name: 'brewphase-test-client', version: '1.0.0' })
    await client.connect(transport)
  }, 30_000)

  afterAll(async () => {
    await client.close().catch(() => undefined)
    await server.stop()
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    // 每个用例开始前确保 token 仍然有效（个别用例会撤销）
    const existing = ctx.clients.list().find((item) => item.name === 'Protocol Test' && item.revokedAt === null)
    if (!existing) {
      token = ctx.clients.create({ name: 'Protocol Test', scopes: ALL_SCOPES }).token
    }
  })

  describe('MCP 协议面', () => {
    it('initialize 后能列出全部 23 个工具，且每个都有描述与 inputSchema', async () => {
      const tools = await client.listTools()
      expect(tools.tools).toHaveLength(23)
      for (const tool of tools.tools) {
        expect(tool.description ?? '').not.toBe('')
        expect(tool.inputSchema).toBeTruthy()
      }
      const names = tools.tools.map((tool) => tool.name)
      expect(names).toContain('create_record')
      expect(names).toContain('get_coffee_summary')
      expect(names).toContain('create_canvas_note')
      // 明确不存在的危险工具
      expect(names).not.toContain('execute_sql')
      expect(names).not.toContain('delete_record')
    })

    it('tools/call 走完整链路：create_record → get_record 读回同一实体', async () => {
      const created = await client.callTool({
        name: 'create_record',
        arguments: {
          carrier: 'text',
          title: '协议测试记录',
          note: 'stdio 真链',
          idempotency_key: `proto-${Date.now()}`
        }
      })
      expect(created.isError).toBeFalsy()
      const createdData = created.structuredContent as { record_id: string; sync_status: string }
      expect(createdData.sync_status).toBe('desktop_local_only')

      const fetched = await client.callTool({
        name: 'get_record',
        arguments: { record_id: createdData.record_id }
      })
      const fetchedData = fetched.structuredContent as { title: string; note: string }
      expect(fetchedData.title).toBe('协议测试记录')
      expect(fetchedData.note).toBe('stdio 真链')
    })

    it('schema 校验由 SDK 拦截：越界参数返回 isError（handler 不执行）', async () => {
      const result = await client.callTool({
        name: 'search_records',
        arguments: { limit: 999 }
      })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
      expect(text).toMatch(/validation/i)
    })

    it('业务错误以结构化错误码返回（NOT_FOUND / STALE_RECORD）', async () => {
      const missing = await client.callTool({
        name: 'get_record',
        arguments: { record_id: '00000000-0000-4000-8000-000000000000' }
      })
      expect(missing.isError).toBe(true)
      expect(JSON.stringify(missing.content)).toContain('NOT_FOUND')
    })

    it('撤销后同一进程的下一次调用 → UNAUTHORIZED（Main 每请求查库）', async () => {
      const victim = ctx.clients.create({ name: 'Revoked Agent', scopes: ALL_SCOPES })
      // 用第二个 stdio 进程 + 该 token 建立独立连接
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [ENTRY],
        env: {
          ...process.env,
          BREWPHASE_MCP_TOKEN: victim.token,
          BREWPHASE_MCP_USER_DATA_DIR: dir
        },
        stderr: 'pipe'
      })
      const other = new Client({ name: 'revoked-test', version: '1.0.0' })
      await other.connect(transport)
      const before = await other.callTool({ name: 'search_records', arguments: {} })
      expect(before.isError).toBeFalsy()

      ctx.clients.revoke(victim.id)
      const after = await other.callTool({ name: 'search_records', arguments: {} })
      expect(after.isError).toBe(true)
      expect(JSON.stringify(after.content)).toContain('UNAUTHORIZED')
      await other.close()
    }, 20_000)
  })
})
