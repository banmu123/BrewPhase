import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpScope } from '@shared/contracts/mcp'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { WorkContextService } from '../../src/main/application/work-context/work-context-service'
import { mcpOperationLog, recordMetadata, records } from '../../src/main/database/schema'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { RecordService } from '../../src/main/application/records/record-service'
import { CoffeeService } from '../../src/main/application/coffee/coffee-service'
import { CanvasService } from '../../src/main/application/canvas/canvas-service'
import { McpClientService } from '../../src/main/application/authorization/permission-service'
import { routeBridgeRequest, type RouterContext } from '../../src/main/mcp-bridge/request-router'
import { BRIDGE_PROTOCOL_VERSION, type BridgeRequest } from '../../src/main/mcp-bridge/bridge-contract'
import * as coffeeRepo from '../../src/main/database/repositories/coffee'

/**
 * MCP V1 的真链测试：授权 → Router（scope/Zod/幂等/审计）→ Application Service
 * → Repository → 真实 SQLite 文件。
 *
 * 这里不 mock 任何一层：任何一环的契约破裂（比如 service 忘了校验 tag 存在、
 * 幂等表没写、审计没落）都必须在这个文件里红。
 */
let dir: string
let handle: DatabaseHandle
let ctx: RouterContext
let events: ApplicationEvents
let scheduled: string[]
let emitted: string[]

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
  dir = mkdtempSync(join(tmpdir(), 'brewphase-mcp-test-'))
  handle = openDatabase(join(dir, 'test.db'))
  events = new ApplicationEvents()
  emitted = []
  events.onChanged((domain) => emitted.push(domain))
  scheduled = []
  const recordsService = new RecordService(handle.db, handle.deviceId, events, (ids) => scheduled.push(...ids))
  ctx = {
    db: handle.db,
    clients: new McpClientService(handle.db),
    records: recordsService,
    coffee: new CoffeeService(handle.db),
    canvas: new CanvasService(handle.db, handle.deviceId, events),
    workContexts: new WorkContextService(handle.db, events)
  }
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeClient(scopes: McpScope[]): { id: string; token: string } {
  const created = ctx.clients.create({ name: 'Test Agent', scopes })
  return { id: created.id, token: created.token }
}

function call(
  tool: string,
  params: Record<string, unknown>,
  token: string,
  overrides: Partial<BridgeRequest> = {}
): ReturnType<typeof routeBridgeRequest> {
  return routeBridgeRequest(ctx, {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    method: 'tools.call',
    tool,
    token,
    params,
    ...overrides
  })
}

function dataOf(response: ReturnType<typeof routeBridgeRequest>): Record<string, unknown> {
  expect(response.success).toBe(true)
  return response.data as Record<string, unknown>
}

function errorOf(response: ReturnType<typeof routeBridgeRequest>): string {
  expect(response.success).toBe(false)
  return response.error!.code
}

describe('MCP 授权客户端', () => {
  it('创建返回一次性 token，库中只存哈希', () => {
    const created = ctx.clients.create({ name: 'Codex', scopes: ['records:read'] })
    expect(created.token.startsWith('bp_mcp_')).toBe(true)
    expect(created.token.length).toBeGreaterThan(40)

    const listed = ctx.clients.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].name).toBe('Codex')
    expect(JSON.stringify(listed)).not.toContain(created.token)

    const authed = ctx.clients.authenticate(created.token)
    expect(authed.scopes).toEqual(['records:read'])
  })

  it('未知 token 与撤销后的 token 都拒绝', () => {
    const client = makeClient(ALL_SCOPES)
    expect(() => ctx.clients.authenticate('bp_mcp_not_a_real_token')).toThrowError(/invalid/i)
    ctx.clients.revoke(client.id)
    expect(() => ctx.clients.authenticate(client.token)).toThrowError(/invalid/i)
  })

  it('未知 scope 被拒绝', () => {
    expect(() => ctx.clients.create({ name: 'x', scopes: ['admin:*' as McpScope] })).toThrowError(/unknown scope/i)
  })
})

describe('MCP 路由边界', () => {
  it('protocolVersion 不匹配 → BRIDGE_PROTOCOL_MISMATCH', () => {
    const client = makeClient(ALL_SCOPES)
    const response = call('search_records', {}, client.token, { protocolVersion: 99 })
    expect(errorOf(response)).toBe('BRIDGE_PROTOCOL_MISMATCH')
  })

  it('未知工具 → VALIDATION_ERROR', () => {
    const client = makeClient(ALL_SCOPES)
    expect(errorOf(call('execute_sql', {}, client.token))).toBe('VALIDATION_ERROR')
  })

  it('无 token / 错误 token → UNAUTHORIZED', () => {
    expect(errorOf(call('search_records', {}, ''))).toBe('UNAUTHORIZED')
    expect(errorOf(call('search_records', {}, 'bp_mcp_wrong'))).toBe('UNAUTHORIZED')
  })

  it('scope 不足 → PERMISSION_DENIED，且写调用也进审计', () => {
    const reader = makeClient(['records:read'])
    const response = call(
      'create_record',
      { carrier: 'text', title: 'x', idempotency_key: 'k1' },
      reader.token
    )
    expect(errorOf(response)).toBe('PERMISSION_DENIED')
    const logs = handle.db.select().from(mcpOperationLog).all()
    expect(logs.some((row) => row.errorCode === 'PERMISSION_DENIED')).toBe(true)
  })

  it('参数不合法 → VALIDATION_ERROR（link 无 url、limit 越界、空 patch）', () => {
    const client = makeClient(ALL_SCOPES)
    expect(
      errorOf(call('create_record', { carrier: 'link', idempotency_key: 'k' }, client.token))
    ).toBe('VALIDATION_ERROR')
    expect(errorOf(call('search_records', { limit: 999 }, client.token))).toBe('VALIDATION_ERROR')

    const record = dataOf(
      call('create_record', { carrier: 'text', title: 't', idempotency_key: 'k2' }, client.token)
    ) as { record_id: string }
    const fresh = (dataOf(call('get_record', { record_id: record.record_id }, client.token)) as {
      updated_at: number
    }).updated_at
    expect(
      errorOf(
        call(
          'update_record',
          { record_id: record.record_id, expected_updated_at: fresh, patch: {} },
          client.token
        )
      )
    ).toBe('VALIDATION_ERROR')
  })
})

describe('Records 工具', () => {
  it('create_record（text）写入真实库并广播 records 事件', () => {
    const client = makeClient(ALL_SCOPES)
    const data = dataOf(
      call(
        'create_record',
        { carrier: 'text', title: '我的想法', note: '正文内容', tag_ids: [], idempotency_key: 'idem-1' },
        client.token
      )
    ) as { record_id: string; carrier: string; sync_status: string }

    expect(data.carrier).toBe('text')
    expect(data.sync_status).toBe('desktop_local_only')
    const row = handle.db.select().from(records).where(eq(records.id, data.record_id)).get()
    expect(row?.title).toBe('我的想法')
    expect(row?.note).toBe('正文内容')
    expect(emitted).toContain('records')
  })

  it('create_record（link）识别平台、安排元数据补全', () => {
    const client = makeClient(ALL_SCOPES)
    const data = dataOf(
      call(
        'create_record',
        {
          carrier: 'link',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=test',
          idempotency_key: 'idem-link'
        },
        client.token
      )
    ) as { record_id: string }

    const row = handle.db.select().from(records).where(eq(records.id, data.record_id)).get()
    expect(row?.provider).toBe('youtube')
    expect(row?.platformContentId).toBe('dQw4w9WgXcQ')
    // URL 规范化去掉跟踪参数
    expect(row?.canonicalUrl).not.toContain('utm_source')
    // 进了与同步共用的补全队列
    expect(scheduled).toContain(data.record_id)
    // 补全行已播种（pending）
    const meta = handle.db.select().from(recordMetadata).where(eq(recordMetadata.recordId, data.record_id)).get()
    expect(meta?.status === 'pending' || meta?.status === 'idle').toBe(true)
  })

  it('text 记录不接受 url；标签必须存在', () => {
    const client = makeClient(ALL_SCOPES)
    expect(
      errorOf(
        call('create_record', { carrier: 'text', url: 'https://example.com', idempotency_key: 'k' }, client.token)
      )
    ).toBe('VALIDATION_ERROR')
    expect(
      errorOf(
        call(
          'create_record',
          {
            carrier: 'text',
            tag_ids: ['00000000-0000-4000-8000-000000000000'],
            idempotency_key: 'k-tag'
          },
          client.token
        )
      )
    ).toBe('NOT_FOUND')
  })

  it('标签：创建去重、list 返回、update 替换', () => {
    const client = makeClient(ALL_SCOPES)
    const first = dataOf(call('create_tag', { name: '咖啡笔记' }, client.token)) as {
      tag_id: string
      name: string
    }
    const second = dataOf(call('create_tag', { name: '咖啡笔记' }, client.token)) as { tag_id: string }
    expect(second.tag_id).toBe(first.tag_id)

    const tags = dataOf(call('list_record_tags', {}, client.token)) as { items: Array<{ id: string; name: string }> }
    expect(tags.items.some((tag) => tag.id === first.tag_id && tag.name === '咖啡笔记')).toBe(true)

    const record = dataOf(
      call('create_record', { carrier: 'text', title: 't', idempotency_key: 'r1' }, client.token)
    ) as { record_id: string; updated_at: number }
    const updated = dataOf(
      call(
        'update_record',
        { record_id: record.record_id, expected_updated_at: record.updated_at, patch: { tag_ids: [first.tag_id] } },
        client.token
      )
    ) as { tag_ids: string[] }
    expect(updated.tag_ids).toEqual([first.tag_id])
  })

  it('update_record 乐观并发：过期版本 → STALE_RECORD 且不写入', () => {
    const client = makeClient(ALL_SCOPES)
    const record = dataOf(
      call('create_record', { carrier: 'text', title: '原标题', idempotency_key: 'r2' }, client.token)
    ) as { record_id: string; updated_at: number }

    const fresh = dataOf(
      call(
        'update_record',
        { record_id: record.record_id, expected_updated_at: record.updated_at, patch: { title: '新标题' } },
        client.token
      )
    ) as { updated_at: number }
    expect(fresh.updated_at).toBeGreaterThanOrEqual(record.updated_at)

    const stale = call(
      'update_record',
      { record_id: record.record_id, expected_updated_at: record.updated_at, patch: { title: '覆盖' } },
      client.token
    )
    expect(errorOf(stale)).toBe('STALE_RECORD')
    const row = handle.db.select().from(records).where(eq(records.id, record.record_id)).get()
    expect(row?.title).toBe('新标题')
  })

  it('update_record URL 变更：旧派生元数据作废并重新入队', () => {
    const client = makeClient(ALL_SCOPES)
    const record = dataOf(
      call(
        'create_record',
        { carrier: 'link', url: 'https://github.com/banmu123/BrewPhase', idempotency_key: 'r3' },
        client.token
      )
    ) as { record_id: string; updated_at: number }

    // 手动播种一条旧 URL 的派生数据（link 创建时已有一行 pending，这里改写成旧数据）
    handle.db
      .insert(recordMetadata)
      .values({
        recordId: record.record_id,
        urlString: 'https://github.com/banmu123/BrewPhase',
        title: '旧标题'
      })
      .onConflictDoUpdate({
        target: recordMetadata.recordId,
        set: { urlString: 'https://github.com/banmu123/BrewPhase', title: '旧标题' }
      })
      .run()

    scheduled.length = 0
    dataOf(
      call(
        'update_record',
        {
          record_id: record.record_id,
          expected_updated_at: record.updated_at,
          patch: { url: 'https://github.com/banmu123/BrewPing' }
        },
        client.token
      )
    )
    expect(scheduled).toContain(record.record_id)
    const meta = handle.db.select().from(recordMetadata).where(eq(recordMetadata.recordId, record.record_id)).get()
    expect(meta?.urlString).toBe('https://github.com/banmu123/BrewPing')
    expect(meta?.title).toBeNull()
  })

  it('幂等：同 key 同参 replay 不重复创建；同 key 不同参 → IDEMPOTENCY_KEY_REUSE', () => {
    const client = makeClient(ALL_SCOPES)
    const params = { carrier: 'text' as const, title: '幂等', idempotency_key: 'same-key' }
    const first = dataOf(call('create_record', params, client.token)) as { record_id: string }
    const replay = dataOf(call('create_record', params, client.token)) as {
      record_id: string
      replayed: boolean
    }
    expect(replay.record_id).toBe(first.record_id)
    expect(replay.replayed).toBe(true)
    expect(handle.db.select().from(records).all()).toHaveLength(1)

    const reuse = call('create_record', { ...params, title: '不同标题' }, client.token)
    expect(errorOf(reuse)).toBe('IDEMPOTENCY_KEY_REUSE')
  })

  it('search_records：关键字、载体过滤、分页 has_more', () => {
    const client = makeClient(ALL_SCOPES)
    for (let index = 0; index < 3; index += 1) {
      call(
        'create_record',
        { carrier: 'text', title: `柠檬 ${index}`, note: '手冲参数', idempotency_key: `s-${index}` },
        client.token
      )
    }
    call('create_record', { carrier: 'link', url: 'https://example.com/a', idempotency_key: 's-link' }, client.token)

    const byKeyword = dataOf(call('search_records', { search: '柠檬' }, client.token)) as {
      items: unknown[]
      has_more: boolean
    }
    expect(byKeyword.items).toHaveLength(3)
    expect(byKeyword.has_more).toBe(false)

    const page = dataOf(call('search_records', { limit: 2 }, client.token)) as {
      items: unknown[]
      has_more: boolean
    }
    expect(page.items).toHaveLength(2)
    expect(page.has_more).toBe(true)

    const links = dataOf(call('search_records', { carrier: 'link' }, client.token)) as { items: unknown[] }
    expect(links.items).toHaveLength(1)
  })

  it('记录不存在 → NOT_FOUND；媒体只给布尔、不给路径', () => {
    const client = makeClient(ALL_SCOPES)
    expect(
      errorOf(call('get_record', { record_id: '00000000-0000-4000-8000-000000000000' }, client.token))
    ).toBe('NOT_FOUND')

    const created = dataOf(
      call('create_record', { carrier: 'text', title: '检查字段', idempotency_key: 'f1' }, client.token)
    ) as { record_id: string }
    // create 返回简版；完整字段（含 has_media）走 get_record
    const record = dataOf(call('get_record', { record_id: created.record_id }, client.token)) as Record<
      string,
      unknown
    >
    expect(record).toHaveProperty('has_media', false)
    expect(JSON.stringify(record)).not.toContain('mediaPath')
    expect(JSON.stringify(record)).not.toContain('previewPath')
  })
})

describe('Canvas 工具', () => {
  it('创建画布 → 添加记录（重复添加不产生第二个节点）→ 便签 → 备注', () => {
    const client = makeClient(ALL_SCOPES)
    const canvas = dataOf(
      call('create_canvas', { name: '整理空间', note: '主题：手冲', idempotency_key: 'c1' }, client.token)
    ) as { canvas_id: string; sync_status: string }
    expect(canvas.sync_status).toBe('desktop_local_only')
    const canvasId = canvas.canvas_id

    const record = dataOf(
      call('create_record', { carrier: 'text', title: '节点记录', idempotency_key: 'cn-r' }, client.token)
    ) as { record_id: string }

    const firstAdd = dataOf(
      call(
        'add_record_to_canvas',
        { canvas_id: canvasId, record_id: record.record_id, idempotency_key: 'n1' },
        client.token
      )
    ) as { node: { id: string; position_x: number }; created: boolean }
    expect(firstAdd.created).toBe(true)

    const secondAdd = dataOf(
      call(
        'add_record_to_canvas',
        { canvas_id: canvasId, record_id: record.record_id, annotation: '备注', idempotency_key: 'n2' },
        client.token
      )
    ) as { node: { id: string; annotation: string }; created: boolean }
    expect(secondAdd.created).toBe(false)
    expect(secondAdd.node.id).toBe(firstAdd.node.id)
    expect(secondAdd.node.annotation).toBe('备注')

    const note = dataOf(
      call(
        'create_canvas_note',
        { canvas_id: canvasId, title: '小节', body: '内容', idempotency_key: 'note-1' },
        client.token
      )
    ) as { note_id: string; title: string; updated_at: number }

    const patched = dataOf(
      call(
        'update_canvas_note',
        { note_id: note.note_id, expected_updated_at: note.updated_at, body: '新内容' },
        client.token
      )
    ) as { body: string; title: string; position_x: number }
    expect(patched.body).toBe('新内容')
    expect(patched.title).toBe('小节')
    // 位置由业务层计算（AI 没提供坐标）
    expect(patched.position_x).toBeGreaterThanOrEqual(0)

    expect(
      errorOf(
        call(
          'update_canvas_note',
          { note_id: note.note_id, expected_updated_at: note.updated_at, body: '过期写' },
          client.token
        )
      )
    ).toBe('STALE_RECORD')

    const annotated = dataOf(
      call('annotate_canvas_node', { node_id: firstAdd.node.id, annotation: '重点' }, client.token)
    ) as { annotation: string }
    expect(annotated.annotation).toBe('重点')

    const detail = dataOf(call('get_canvas', { canvas_id: canvasId }, client.token)) as {
      nodes: unknown[]
      notes: unknown[]
    }
    expect(detail.nodes).toHaveLength(1)
    expect(detail.notes).toHaveLength(1)
    expect(emitted).toContain('canvas')
  })

  it('不存在的画布/记录/节点 → NOT_FOUND', () => {
    const client = makeClient(ALL_SCOPES)
    expect(
      errorOf(call('get_canvas', { canvas_id: '00000000-0000-4000-8000-000000000000' }, client.token))
    ).toBe('NOT_FOUND')
    const canvas = dataOf(call('create_canvas', { name: 'c', idempotency_key: 'c9' }, client.token)) as {
      canvas_id: string
    }
    expect(
      errorOf(
        call(
          'add_record_to_canvas',
          { canvas_id: canvas.canvas_id, record_id: '00000000-0000-4000-8000-000000000000', idempotency_key: 'n9' },
          client.token
        )
      )
    ).toBe('NOT_FOUND')
    expect(
      errorOf(call('annotate_canvas_node', { node_id: '00000000-0000-4000-8000-000000000000', annotation: 'x' }, client.token))
    ).toBe('NOT_FOUND')
  })
})

describe('Coffee 工具（只读）', () => {
  it('summary / list_beans / list_brews 读取真实数据且不写入', () => {
    const client = makeClient(ALL_SCOPES)
    const coffee = coffeeRepo
    const bean = coffee.createBean(handle.db, handle.deviceId, {
      name: '测试豆',
      roastLevel: 'light',
      weightG: 200,
      remainingG: 200,
      roastDate: Date.now() - 5 * 86_400_000
    })
    coffee.createBrew(handle.db, handle.deviceId, {
      beanId: bean.id,
      date: Date.now(),
      method: 'V60',
      grinder: 'C40',
      grindSize: '22',
      waterTemp: 92,
      coffeeG: 15,
      waterG: 240,
      timeSeconds: 150,
      score: 88,
      acidity: 3,
      sweetness: 4,
      bitterness: 2,
      body: 3,
      aftertaste: 3,
      flavorTags: [],
      notes: ''
    })

    const before = coffee.listBeans(handle.db)
    const summary = dataOf(call('get_coffee_summary', {}, client.token)) as {
      beans: { total: number }
      brews: { total: number }
    }
    expect(summary.beans.total).toBe(1)
    expect(summary.brews.total).toBe(1)

    const beans = dataOf(call('list_beans', {}, client.token)) as { items: Array<Record<string, unknown>> }
    expect(beans.items[0].has_image).toBe(false)
    expect(beans.items[0].days_since_roast).toBeGreaterThanOrEqual(5)
    // 不泄漏文件名/路径字段
    expect(JSON.stringify(beans)).not.toContain('imagePath')

    const brews = dataOf(call('list_brews', {}, client.token)) as { items: Array<Record<string, unknown>> }
    expect(brews.items[0].method).toBe('V60')
    expect(brews.items[0].stock_deducted_g).toBe(15)

    // 只读：写入前后库存不变
    const after = coffee.listBeans(handle.db)
    expect(after[0].remainingG).toBe(before[0].remainingG)
  })

  it('没有咖啡写工具：update_bean / create_brew 不在工具清单里', () => {
    const client = makeClient(ALL_SCOPES)
    for (const tool of ['update_bean', 'create_brew', 'delete_brew', 'update_brew']) {
      expect(errorOf(call(tool, {}, client.token))).toBe('VALIDATION_ERROR')
    }
  })
})

describe('MCP 安全边界（错误与审计）', () => {
  it('非预期异常不外泄 SQL / 数据库路径 / 系统绝对路径', () => {
    const client = makeClient(ALL_SCOPES)
    const created = dataOf(
      call('create_record', { carrier: 'text', title: '泄漏探测', idempotency_key: 'leak-1' }, client.token)
    ) as { record_id: string }

    const original = ctx.records.getForMcp
    ctx.records.getForMcp = (() => {
      throw new Error(
        "SQLITE_ERROR: no such table: records — /Users/banmu/Library/Application Support/brewphase-desktop/brewphase.db — SELECT * FROM records"
      )
    }) as typeof ctx.records.getForMcp

    try {
      const response = call('get_record', { record_id: created.record_id }, client.token)
      expect(errorOf(response)).toBe('INTERNAL_ERROR')
      const message = response.error?.message ?? ''
      expect(message).not.toContain('SQLITE')
      expect(message).not.toContain('SELECT')
      expect(message).not.toContain('/Users')
      expect(message).not.toContain('brewphase.db')
      expect(message).toMatch(/unexpected error/i)
    } finally {
      ctx.records.getForMcp = original
    }
  })

  it('写工具参数校验失败：记一条失败审计，且不落任何数据', () => {
    const client = makeClient(ALL_SCOPES)
    const recordsBefore = handle.db.select().from(records).all().length
    const auditBefore = handle.db.select().from(mcpOperationLog).all().length

    // carrier=link 缺 url：Zod 通过（url 可选），Service 抛 VALIDATION_ERROR；
    // 这里改用真正会被 Zod 拦下的情况：limit 越界不在写工具上，因此用
    // create_record 传非法 carrier。
    const response = call(
      'create_record',
      { carrier: 'audio', idempotency_key: 'audit-invalid-1' },
      client.token
    )
    expect(errorOf(response)).toBe('VALIDATION_ERROR')

    const logs = handle.db.select().from(mcpOperationLog).all()
    expect(logs.length).toBe(auditBefore + 1)
    const last = logs[logs.length - 1]
    expect(last.toolName).toBe('create_record')
    expect(last.errorCode).toBe('VALIDATION_ERROR')
    expect(last.success).toBe(false)
    expect(handle.db.select().from(records).all()).toHaveLength(recordsBefore)
  })

  it('只读工具参数校验失败不写审计（审计只覆盖写调用）', () => {
    const client = makeClient(ALL_SCOPES)
    const auditBefore = handle.db.select().from(mcpOperationLog).all().length
    expect(errorOf(call('search_records', { limit: 999 }, client.token))).toBe('VALIDATION_ERROR')
    expect(handle.db.select().from(mcpOperationLog).all().length).toBe(auditBefore)
  })
})
