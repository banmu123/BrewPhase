import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { createRecord } from '../../src/main/database/repositories/records'
import { mcpOperationLog, mcpClients } from '../../src/main/database/schema'
import { McpClientService } from '../../src/main/application/authorization/permission-service'
import type { McpScope } from '../../src/shared/contracts/mcp'
import { RecordService } from '../../src/main/application/records/record-service'
import { CoffeeService } from '../../src/main/application/coffee/coffee-service'
import { CanvasService } from '../../src/main/application/canvas/canvas-service'
import { WorkContextService } from '../../src/main/application/work-context/work-context-service'
import { PersonalDirectionService } from '../../src/main/application/personal-direction/personal-direction-service'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { BridgeServer } from '../../src/main/mcp-bridge/bridge-server'
import { bridgePaths } from '../../src/main/mcp-bridge/bridge-contract'
import { BridgeClient } from '../../src/mcp/bridge-client'

/**
 * Work Context 的 Bridge 级集成测试：真实 BridgeServer + 真实认证/审计/幂等，
 * 覆盖任务清单里的权限、乐观并发、协议校验与审计要求。
 * 独立临时数据库，不碰真实用户数据。
 */

let dir: string
let handle: DatabaseHandle
let server: BridgeServer
let ctx: ConstructorParameters<typeof BridgeServer>[1]
const cleanups: Array<() => void> = []

const ALL_WORK_SCOPES: McpScope[] = [
  'records:read',
  'records:create',
  'records:update',
  'tags:read',
  'tags:create',
  'work_context:read',
  'work_context:create',
  'work_context:update',
  'work_context:link'
]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-work-context-bridge-'))
  handle = openDatabase(join(dir, 'test.db'))
  const events = new ApplicationEvents()
  ctx = {
    db: handle.db,
    clients: new McpClientService(handle.db),
    records: new RecordService(handle.db, handle.deviceId, events, () => undefined),
    coffee: new CoffeeService(handle.db),
    canvas: new CanvasService(handle.db, handle.deviceId, events),
    workContexts: new WorkContextService(handle.db, events),

    personalDirection: new PersonalDirectionService(handle.db, events)
  }
  server = new BridgeServer(bridgePaths(dir), ctx, '0.1.0-test')
  return server.start()
})

afterEach(async () => {
  await server.stop()
  handle.close()
  rmSync(dir, { recursive: true, force: true })
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function makeClient(scopes: McpScope[]): BridgeClient {
  const created = ctx.clients.create({ name: 'Work Context Test', scopes })
  return new BridgeClient(dir, created.token)
}

describe('Work Context MCP 工具', () => {
  it('create → list → get：全链路真实写入与读取', async () => {
    const client = makeClient(ALL_WORK_SCOPES)
    const created = (await client.call('create_work_context', {
      title: 'AI Agent 工作流研究',
      goal: '为 LoomFlow 提炼可借鉴架构',
      summary: '已完成 LangGraph / n8n / Dify 初步研究',
      next_step: '精读 LangGraph checkpoint API',
      idempotency_key: 'wc-create-1'
    })) as { context_id: string; status: string }

    expect(created.context_id).toBeTruthy()
    expect(created.status).toBe('active')

    const listed = (await client.call('list_work_contexts', {})) as {
      items: Array<{ context_id: string; record_count: number }>
    }
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0].context_id).toBe(created.context_id)

    const detail = (await client.call('get_work_context', {
      context_id: created.context_id
    })) as { context_id: string; resources: unknown[]; record_count: number }
    expect(detail.context_id).toBe(created.context_id)
    expect(detail.resources).toEqual([])
    expect(detail.record_count).toBe(0)
  })

  it('create 幂等：同 key 同参数返回同一 context（replayed 标记）', async () => {
    const client = makeClient(ALL_WORK_SCOPES)
    const args = { title: '幂等研究', idempotency_key: 'wc-idem-1' }
    const first = (await client.call('create_work_context', args)) as { context_id: string; replayed?: boolean }
    const second = (await client.call('create_work_context', args)) as {
      context_id: string
      replayed?: boolean
    }
    expect(second.context_id).toBe(first.context_id)
    expect(second.replayed).toBe(true)
  })

  it('list_work_contexts 支持 status 过滤', async () => {
    const client = makeClient(ALL_WORK_SCOPES)
    const a = (await client.call('create_work_context', {
      title: 'A',
      idempotency_key: 'wc-filter-a'
    })) as { context_id: string }
    await client.call('create_work_context', { title: 'B', idempotency_key: 'wc-filter-b' })

    const detail = (await client.call('get_work_context', { context_id: a.context_id })) as {
      updated_at: number
    }
    await client.call('update_work_context', {
      context_id: a.context_id,
      expected_updated_at: detail.updated_at,
      patch: { status: 'paused' }
    })

    const active = (await client.call('list_work_contexts', { status: 'active' })) as {
      items: Array<{ title: string }>
    }
    const paused = (await client.call('list_work_contexts', { status: 'paused' })) as {
      items: Array<{ title: string }>
    }
    expect(active.items.map((item) => item.title)).toEqual(['B'])
    expect(paused.items.map((item) => item.title)).toEqual(['A'])
  })

  it('update 乐观并发：旧 expected_updated_at 返回 STALE_RECORD', async () => {
    const client = makeClient(ALL_WORK_SCOPES)
    const created = (await client.call('create_work_context', {
      title: '并发',
      idempotency_key: 'wc-stale-1'
    })) as { context_id: string }
    const detail = (await client.call('get_work_context', { context_id: created.context_id })) as {
      updated_at: number
    }

    await expect(
      client.call('update_work_context', {
        context_id: created.context_id,
        expected_updated_at: detail.updated_at - 1,
        patch: { summary: '过期写入' }
      })
    ).rejects.toMatchObject({ code: 'STALE_RECORD' })

    const ok = (await client.call('update_work_context', {
      context_id: created.context_id,
      expected_updated_at: detail.updated_at,
      patch: { summary: '新摘要', next_step: '下一步动作' }
    })) as { summary: string; next_step: string }
    expect(ok.summary).toBe('新摘要')
    expect(ok.next_step).toBe('下一步动作')
  })

  it('link：关联真实 record / canvas / url，重复关联不产生副本', async () => {
    const client = makeClient(ALL_WORK_SCOPES)
    const record = createRecord(handle.db, 'device-test', {
      carrier: 'link',
      title: 'Dify',
      note: '',
      urlString: 'https://github.com/langgenius/dify',
      canonicalURL: null,
      platformContentID: null,
      provider: 'generic',
      sourceName: '',
      authorName: '',
      summary: '',
      mediaPath: null,
      previewPath: null,
      tagIds: []
    })
    const canvas = ctx.canvas.createForMcp({ name: '研究画布' })

    const context = (await client.call('create_work_context', {
      title: '关联',
      idempotency_key: 'wc-link-1'
    })) as { context_id: string }

    await client.call('link_work_context_resource', {
      context_id: context.context_id,
      resource_type: 'record',
      resource_id: record.id,
      idempotency_key: 'wc-link-1-record'
    })
    const replay = (await client.call('link_work_context_resource', {
      context_id: context.context_id,
      resource_type: 'record',
      resource_id: record.id,
      idempotency_key: 'wc-link-1-record'
    })) as { resource: { label: string }; replayed?: boolean; created?: boolean }
    expect(replay.resource.label).toBe('Dify')

    await client.call('link_work_context_resource', {
      context_id: context.context_id,
      resource_type: 'canvas',
      resource_id: canvas.id,
      role: 'output',
      idempotency_key: 'wc-link-1-canvas'
    })
    await client.call('link_work_context_resource', {
      context_id: context.context_id,
      resource_type: 'url',
      url: 'https://example.com/reference',
      idempotency_key: 'wc-link-1-url'
    })

    const detail = (await client.call('get_work_context', { context_id: context.context_id })) as {
      record_count: number
      canvas_count: number
      url_count: number
      resources: Array<{ resource_type: string; label: string }>
    }
    expect(detail.record_count).toBe(1)
    expect(detail.canvas_count).toBe(1)
    expect(detail.url_count).toBe(1)
    expect(detail.resources).toHaveLength(3)
  })

  it('link 协议与存在性校验：非法 URL / 不存在的 record / 坏 UUID 被拒', async () => {
    const client = makeClient(ALL_WORK_SCOPES)
    const context = (await client.call('create_work_context', {
      title: '校验',
      idempotency_key: 'wc-valid-1'
    })) as { context_id: string }

    await expect(
      client.call('link_work_context_resource', {
        context_id: context.context_id,
        resource_type: 'url',
        url: 'javascript:alert(1)',
        idempotency_key: 'wc-valid-js'
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })

    await expect(
      client.call('link_work_context_resource', {
        context_id: context.context_id,
        resource_type: 'record',
        resource_id: '00000000-0000-4000-8000-000000000000',
        idempotency_key: 'wc-valid-missing'
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      client.call('get_work_context', { context_id: 'not-a-uuid' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('权限不足：缺 work_context scope 的客户端被拒，写尝试进审计', async () => {
    const client = makeClient(['records:read'])
    await expect(
      client.call('create_work_context', { title: 'X', idempotency_key: 'wc-perm-1' })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

    const audits = handle.db.select().from(mcpOperationLog).all()
    const denied = audits.filter((row) => !row.success)
    expect(denied.length).toBeGreaterThan(0)
  })

  it('撤销客户端后立即拒绝（token 失效）', async () => {
    const created = ctx.clients.create({ name: 'Revoked Soon', scopes: ALL_WORK_SCOPES })
    const client = new BridgeClient(dir, created.token)
    await client.call('create_work_context', { title: '将撤销', idempotency_key: 'wc-revoke-1' })

    ctx.clients.revoke(created.id)
    await expect(
      client.call('list_work_contexts', {})
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('写操作审计：成功的 create 与 link 都留痕', async () => {
    const client = makeClient(ALL_WORK_SCOPES)
    await client.call('create_work_context', { title: '审计', idempotency_key: 'wc-audit-1' })
    await client.call('link_work_context_resource', {
      context_id: ((await client.call('list_work_contexts', {})) as { items: Array<{ context_id: string }> })
        .items[0].context_id,
      resource_type: 'url',
      url: 'https://example.com/a',
      idempotency_key: 'wc-audit-2'
    })

    const logs = handle.db.select().from(mcpOperationLog).all()
    const workTools = logs.filter((row) => row.toolName.includes('work_context'))
    expect(workTools.length).toBeGreaterThanOrEqual(2)
  })

  it('迁移持久化：重开数据库后 Work Context 仍在', async () => {
    const client = makeClient(ALL_WORK_SCOPES)
    const created = (await client.call('create_work_context', {
      title: '重启仍在',
      idempotency_key: 'wc-persist-1'
    })) as { context_id: string }

    const reopened = openDatabase(join(dir, 'test.db'))
    try {
      const service = new WorkContextService(reopened.db, new ApplicationEvents())
      expect(service.list(null).map((c) => c.id)).toContain(created.context_id)
    } finally {
      reopened.close()
    }
  })

  it('link 幂等键复用且参数不同 → IDEMPOTENCY_KEY_REUSE', async () => {
    const client = makeClient(ALL_WORK_SCOPES)
    const context = (await client.call('create_work_context', {
      title: '键冲突',
      idempotency_key: 'wc-conflict-ctx'
    })) as { context_id: string }
    await client.call('link_work_context_resource', {
      context_id: context.context_id,
      resource_type: 'url',
      url: 'https://example.com/1',
      idempotency_key: 'wc-conflict-key'
    })
    await expect(
      client.call('link_work_context_resource', {
        context_id: context.context_id,
        resource_type: 'url',
        url: 'https://example.com/2',
        idempotency_key: 'wc-conflict-key'
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE' })
  })

  it('既有 18 工具未回归：records 链路在带 work scope 的客户端下仍可用', async () => {
    const client = makeClient(ALL_WORK_SCOPES)
    const record = (await client.call('create_record', {
      carrier: 'text',
      title: '回归检查',
      note: '',
      idempotency_key: 'wc-regress-1'
    })) as { record_id: string }
    expect(record.record_id).toBeTruthy()
    const search = (await client.call('search_records', { search: '回归检查' })) as {
      items: Array<{ id: string }>
    }
    expect(search.items).toHaveLength(1)
  })
})
