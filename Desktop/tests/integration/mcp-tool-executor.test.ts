import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpScope } from '@shared/contracts/mcp'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { WorkContextService } from '../../src/main/application/work-context/work-context-service'
import { PersonalDirectionService } from '../../src/main/application/personal-direction/personal-direction-service'
import { mcpOperationLog, records } from '../../src/main/database/schema'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { RecordService } from '../../src/main/application/records/record-service'
import { CoffeeService } from '../../src/main/application/coffee/coffee-service'
import { CanvasService } from '../../src/main/application/canvas/canvas-service'
import { McpClientService } from '../../src/main/application/authorization/permission-service'
import { routeBridgeRequest, type RouterContext } from '../../src/main/mcp-bridge/request-router'
import { BRIDGE_PROTOCOL_VERSION, type BridgeRequest } from '../../src/main/mcp-bridge/bridge-contract'
import { executeTool } from '../../src/main/application/mcp-tools/tool-executor'
import { TOOL_NAMES } from '../../src/shared/mcp/tool-schemas'

/**
 * Phase 1.1A 验收：CB-1 ~ CB-15（CB-16 是构建产物大小，见验收报告）。
 *
 * 这张表的意义在于「抽取执行层之后，Local 的可观察行为逐项没变」。
 * 它不替代 `mcp.test.ts`（那里测业务语义），而是专门钉住**边界行为**：
 * 错误码、错误文案、审计写不写、返回形状里有没有 `sync_status`。
 *
 * 用例编号与 `docs/REMOTE_MCP_PHASES.md` §1A.4 的 CB-1~CB-16 一一对应。
 */
let dir: string
let handle: DatabaseHandle
let ctx: RouterContext

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-1a1a-'))
  handle = openDatabase(join(dir, 'test.db'))
  const events = new ApplicationEvents()
  const recordsService = new RecordService(handle.db, handle.deviceId, events, () => undefined)
  ctx = {
    db: handle.db,
    clients: new McpClientService(handle.db),
    records: recordsService,
    coffee: new CoffeeService(handle.db),
    canvas: new CanvasService(handle.db, handle.deviceId, events),
    workContexts: new WorkContextService(handle.db, events),
    personalDirection: new PersonalDirectionService(handle.db, events)
  }
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeClient(scopes: McpScope[]): { id: string; token: string } {
  const created = ctx.clients.create({ name: 'CB Agent', scopes })
  return { id: created.id, token: created.token }
}

function call(
  tool: string,
  params: Record<string, unknown>,
  token: string,
  overrides: Partial<BridgeRequest> = {}
): ReturnType<typeof routeBridgeRequest> {
  return routeBridgeRequest(ctx, {
    requestId: `cb-${Math.random().toString(36).slice(2)}`,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    method: 'tools.call',
    tool,
    token,
    params,
    ...overrides
  })
}

function auditRows() {
  return handle.db.select().from(mcpOperationLog).all()
}

describe('CB-1 ~ CB-4 协议与身份边界', () => {
  it('CB-1 未知 tool 名 → VALIDATION_ERROR + unknown tool: X', () => {
    const client = makeClient(ALL_SCOPES)
    const response = call('no_such_tool', {}, client.token)
    expect(response.success).toBe(false)
    expect(response.error?.code).toBe('VALIDATION_ERROR')
    expect(response.error?.message).toBe('unknown tool: no_such_tool')
    // 未知工具在认证之前就判掉：即便 token 无效，也仍然是 VALIDATION_ERROR。
    expect(call('no_such_tool', {}, 'bp_mcp_bogus').error?.code).toBe('VALIDATION_ERROR')
  })

  it('CB-2 协议版本不匹配 → BRIDGE_PROTOCOL_MISMATCH', () => {
    const client = makeClient(ALL_SCOPES)
    const response = call('list_record_tags', {}, client.token, { protocolVersion: 999 })
    expect(response.error?.code).toBe('BRIDGE_PROTOCOL_MISMATCH')
    expect(response.error?.message).toBe(`bridge protocol ${BRIDGE_PROTOCOL_VERSION} required`)
  })

  it('CB-3 非 tools.call 方法 → VALIDATION_ERROR + unsupported method', () => {
    const client = makeClient(ALL_SCOPES)
    const response = call('list_record_tags', {}, client.token, {
      method: 'tools.list' as unknown as BridgeRequest['method']
    })
    expect(response.error?.code).toBe('VALIDATION_ERROR')
    expect(response.error?.message).toBe('unsupported method: tools.list')
  })

  it('CB-4 无效 token（缺失 / 伪造 / 已撤销）→ UNAUTHORIZED，且不区分原因', () => {
    const client = makeClient(ALL_SCOPES)
    ctx.clients.revoke(client.id)

    const missing = call('list_record_tags', {}, '')
    const forged = call('list_record_tags', {}, 'bp_mcp_ffffffffffffffffffffffffffffffff')
    const revoked = call('list_record_tags', {}, client.token)

    for (const response of [missing, forged, revoked]) {
      expect(response.success).toBe(false)
      expect(response.error?.code).toBe('UNAUTHORIZED')
    }
    // 三种原因同一句文案：不让调用方区分「不存在」与「已撤销」。
    expect(new Set([missing, forged, revoked].map((r) => r.error?.message)).size).toBe(1)
  })
})

describe('CB-5 ~ CB-8 scope 与参数的审计边界', () => {
  it('CB-5 scope 不足（写工具）→ PERMISSION_DENIED + 写一条审计', () => {
    const reader = makeClient(['records:read'])
    const before = auditRows().length

    const response = call(
      'create_record',
      { carrier: 'text', title: 'x', idempotency_key: 'cb5' },
      reader.token
    )
    expect(response.error?.code).toBe('PERMISSION_DENIED')
    expect(response.error?.message).toBe('client is not granted records:create')

    const after = auditRows()
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1].errorCode).toBe('PERMISSION_DENIED')
    expect(after[after.length - 1].success).toBe(false)
    // 失败审计不带幂等键（抽取前就是在解析参数之前写的这一行）。
    expect(after[after.length - 1].idempotencyKey).toBeNull()
  })

  it('CB-6 scope 不足（读工具）→ PERMISSION_DENIED + 不写审计', () => {
    const tagReader = makeClient(['tags:read'])
    const before = auditRows().length
    expect(call('search_records', {}, tagReader.token).error?.code).toBe('PERMISSION_DENIED')
    expect(auditRows().length).toBe(before)
  })

  it('CB-7 参数非法（写工具）→ VALIDATION_ERROR + 写一条审计', () => {
    const client = makeClient(ALL_SCOPES)
    const before = auditRows().length
    const response = call(
      'create_record',
      { carrier: 'audio', idempotency_key: 'cb7' },
      client.token
    )
    expect(response.error?.code).toBe('VALIDATION_ERROR')
    expect(auditRows().length).toBe(before + 1)
    const last = auditRows().at(-1)!
    expect(last.toolName).toBe('create_record')
    expect(last.errorCode).toBe('VALIDATION_ERROR')
  })

  it('CB-8 参数非法（读工具）→ VALIDATION_ERROR + 不写审计', () => {
    const client = makeClient(ALL_SCOPES)
    const before = auditRows().length
    expect(call('search_records', { limit: 999 }, client.token).error?.code).toBe('VALIDATION_ERROR')
    expect(auditRows().length).toBe(before)
  })
})

describe('CB-9 / CB-10 错误映射', () => {
  it('CB-9 业务 ApplicationError → 原文透传 message', () => {
    const client = makeClient(ALL_SCOPES)
    const missing = '00000000-0000-4000-8000-000000000000'
    const response = call('get_record', { record_id: missing }, client.token)
    expect(response.error?.code).toBe('NOT_FOUND')
    expect(response.error?.message).toBe(`record ${missing} not found`)
  })

  it('CB-10 非 ApplicationError → INTERNAL_ERROR + 通用文案（无 SQL / 路径 / 堆栈）', () => {
    const client = makeClient(ALL_SCOPES)
    const original = ctx.coffee.summaryForMcp
    ctx.coffee.summaryForMcp = (() => {
      throw new Error(
        "SQLITE_ERROR: no such table: beans — /Users/banmu/Library/Application Support/brewphase-desktop/brewphase.db"
      )
    }) as typeof ctx.coffee.summaryForMcp

    try {
      const response = call('get_coffee_summary', {}, client.token)
      expect(response.error?.code).toBe('INTERNAL_ERROR')
      const message = response.error?.message ?? ''
      expect(message).toMatch(/unexpected error/i)
      expect(message).not.toContain('SQLITE')
      expect(message).not.toContain('/Users')
      expect(message).not.toContain('brewphase.db')
    } finally {
      ctx.coffee.summaryForMcp = original
    }
  })
})

describe('CB-11 ~ CB-14 幂等与返回形状', () => {
  it('CB-11 幂等命中（同 key 同参）→ 回放 + replayed:true + sync_status', () => {
    const client = makeClient(ALL_SCOPES)
    const params = { carrier: 'text' as const, title: '幂等形状', idempotency_key: 'cb11' }

    const first = call('create_record', params, client.token)
    const replay = call('create_record', params, client.token)
    expect(first.success).toBe(true)
    expect(replay.success).toBe(true)

    const firstData = first.data as Record<string, unknown>
    const replayData = replay.data as Record<string, unknown>

    // 形状逐字段等价：replay 只多 replayed 一个键，其余键名与值完全相同。
    expect(new Set(Object.keys(replayData))).toEqual(new Set([...Object.keys(firstData), 'replayed']))
    for (const key of Object.keys(firstData)) expect(replayData[key]).toEqual(firstData[key])
    expect(replayData.replayed).toBe(true)
    expect(replayData.sync_status).toBe('desktop_local_only')
    expect(handle.db.select().from(records).all()).toHaveLength(1)
  })

  it('CB-11b 幂等重放时实体已不存在 → NOT_FOUND，且不写审计（与抽取前一致）', () => {
    const client = makeClient(ALL_SCOPES)
    const params = { carrier: 'text' as const, title: '待删除', idempotency_key: 'cb11b' }
    const created = call('create_record', params, client.token).data as { record_id: string }

    // 幂等记录还在，但实体没了：重放要按业务错误返回，且这条路径历史上不记账。
    handle.db.delete(records).where(eq(records.id, created.record_id)).run()

    const before = auditRows().length
    const response = call('create_record', params, client.token)
    expect(response.error?.code).toBe('NOT_FOUND')
    expect(auditRows().length).toBe(before)
  })

  it('CB-12 幂等冲突（同 key 不同摘要）→ IDEMPOTENCY_KEY_REUSE + 写审计', () => {
    const client = makeClient(ALL_SCOPES)
    const params = { carrier: 'text' as const, title: '原始', idempotency_key: 'cb12' }
    call('create_record', params, client.token)

    const before = auditRows().length
    const conflict = call('create_record', { ...params, title: '换了标题' }, client.token)
    expect(conflict.error?.code).toBe('IDEMPOTENCY_KEY_REUSE')
    expect(conflict.error?.message).toBe('this idempotency_key was already used with different params')

    const after = auditRows()
    expect(after.length).toBe(before + 1)
    const last = after[after.length - 1]
    expect(last.errorCode).toBe('IDEMPOTENCY_KEY_REUSE')
    expect(last.idempotencyKey).toBe('cb12')
    // 冲突不产生第二条记录
    expect(handle.db.select().from(records).all()).toHaveLength(1)
  })

  it('CB-13 写工具成功 → 含 sync_status', () => {
    const client = makeClient(ALL_SCOPES)
    const data = call('create_canvas', { name: 'CB13', idempotency_key: 'cb13' }, client.token)
      .data as Record<string, unknown>
    expect(data.sync_status).toBe('desktop_local_only')
    expect(data).toHaveProperty('canvas_id')
  })

  it('CB-14 读工具成功 → 不含 sync_status', () => {
    const client = makeClient(ALL_SCOPES)
    const response = call('list_beans', {}, client.token)
    expect(response.success).toBe(true)
    expect(response.data as Record<string, unknown>).not.toHaveProperty('sync_status')
  })
})

describe('CB-15 工具清单', () => {
  it('27 个工具，名称与顺序逐项相等', () => {    expect(TOOL_NAMES).toEqual([
      'search_records',
      'get_record',
      'list_record_tags',
      'create_record',
      'update_record',
      'create_tag',
      'list_work_contexts',
      'get_work_context',
      'create_work_context',
      'update_work_context',
      'link_work_context_resource',
      'list_beans',
      'get_bean',
      'list_brews',
      'list_tastings',
      'get_coffee_summary',
      'list_canvases',
      'get_canvas',
      'create_canvas',
      'add_record_to_canvas',
      'create_canvas_note',
      'update_canvas_note',
      'annotate_canvas_node',
      'get_direction_overview',
      'propose_current_state',
      'propose_direction',
      'propose_stage_goal'
    ])
    expect(TOOL_NAMES).toHaveLength(27)
  })
})

describe('共享执行层可脱离 Bridge 直接调用', () => {
  it('只给 services + scopes 就能执行，授权不足在执行层内部被拦下', () => {
    // 这条用例证明 Phase 1.1A 的目标达成：Remote 将来不需要 socket，
    // 也不需要 MCP Client Token，只要能算出自己的 scopes。
    const allowed = executeTool('list_record_tags', {}, { services: ctx, scopes: ['tags:read'] })
    expect(allowed.ok).toBe(true)

    const denied = executeTool('list_record_tags', {}, { services: ctx, scopes: ['records:read'] })
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.stage).toBe('scope')
      expect(denied.code).toBe('PERMISSION_DENIED')
      expect(denied.message).toBe('client is not granted tags:read')
      // 参数阶段未执行：调用方据此决定「这一次不记账」。
      expect(denied.params).toBeNull()
    }
  })

  it('未知工具在执行层同样被拦下（白名单的唯一入口）', () => {
    const unknown = executeTool('drop_database', {}, { services: ctx, scopes: ALL_SCOPES })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.stage).toBe('tool')
      expect(unknown.code).toBe('VALIDATION_ERROR')
      expect(unknown.toolName).toBeNull()
    }
  })
})
