import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { createRecord } from '../../src/main/database/repositories/records'
import { canvases as canvasesTable, records as recordsTable } from '../../src/main/database/schema'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import {
  WorkContextService,
  WorkContextError
} from '../../src/main/application/work-context/work-context-service'
import type { RecordDraft } from '../../src/shared/contracts'

/**
 * Work Context V1 的服务层单元测试：独立临时数据库，不碰真实用户数据。
 * 覆盖：创建 / 列表 / 状态过滤 / 详情 / 乐观并发 / 资源关联校验与幂等 /
 * URL 协议 / prune-on-read / 计数 / Studio 列表过滤。
 */

let handle: DatabaseHandle
let service: WorkContextService
let dir: string

const LINK_DRAFT: RecordDraft = {
  carrier: 'link',
  title: 'LangGraph',
  note: '',
  urlString: 'https://github.com/langchain-ai/langgraph',
  canonicalURL: null,
  platformContentID: null,
  provider: 'generic',
  sourceName: 'GitHub',
  authorName: '',
  summary: '',
  mediaPath: null,
  previewPath: null,
  tagIds: []
}

function createCanvasRow(id: string): void {
  handle.db
    .insert(canvasesTable)
    .values({ id, name: `画布 ${id.slice(0, 4)}`, note: '', createdAt: Date.now(), updatedAt: Date.now() })
    .run()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-work-context-'))
  handle = openDatabase(join(dir, 'test.db'))
  service = new WorkContextService(handle.db, new ApplicationEvents())
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WorkContextService', () => {
  it('创建：标题必填字段落库，默认状态 active，时间由 Main 维护', () => {
    const before = Date.now()
    const context = service.create({ title: 'AI Agent 工作流研究' })
    expect(context.id).toBeTruthy()
    expect(context.title).toBe('AI Agent 工作流研究')
    expect(context.status).toBe('active')
    expect(context.createdAt).toBeGreaterThanOrEqual(before)
    expect(context.lastActivityAt).toBe(context.createdAt)
  })

  it('列表按最近活动排序，status 过滤生效', () => {
    const first = service.create({ title: '工作 A' })
    const second = service.create({ title: '工作 B' })
    service.update(second.id, second.updatedAt, { summary: '推进一点' })

    const all = service.list(null)
    expect(all.map((c) => c.title)).toEqual(['工作 B', '工作 A'])

    const refreshed = service.list(null).find((c) => c.id === first.id)!
    service.update(refreshed.id, refreshed.updatedAt, { status: 'completed' })
    expect(service.list('active').map((c) => c.title)).toEqual(['工作 B'])
    expect(service.list('completed').map((c) => c.title)).toEqual(['工作 A'])
  })

  it('update 只改传入字段，且刷新 updated_at / last_activity_at', () => {
    const context = service.create({ title: '研究', summary: '旧摘要' })
    const updated = service.update(context.id, context.updatedAt, { nextStep: '读 LangGraph 源码' })
    expect(updated.summary).toBe('旧摘要')
    expect(updated.nextStep).toBe('读 LangGraph 源码')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(context.updatedAt)
  })

  it('乐观并发：expected_updated_at 不匹配返回 STALE_RECORD', () => {
    const context = service.create({ title: '并发' })
    service.update(context.id, context.updatedAt, { summary: 'A 写入' })
    try {
      // 用确定不匹配的旧时间戳（同一毫秒内 Date.now() 可能相同，改用 -1）。
      service.update(context.id, context.updatedAt - 1, { summary: 'B 用旧时间戳写入' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as WorkContextError).code).toBe('STALE_RECORD')
    }
  })

  it('link：record / canvas 关联校验存在性，重复关联不产生副本', () => {
    const record = createRecord(handle.db, 'device-test', LINK_DRAFT)
    const canvasId = 'c1c1c1c1-1111-4111-8111-000000000001'
    createCanvasRow(canvasId)
    const context = service.create({ title: '关联测试' })

    const first = service.link({ contextId: context.id, resourceType: 'record', resourceId: record.id, role: 'source' })
    expect(first.created).toBe(true)
    const replay = service.link({ contextId: context.id, resourceType: 'record', resourceId: record.id, role: 'output' })
    expect(replay.created).toBe(false)
    expect(replay.resource.id).toBe(first.resource.id)

    service.link({ contextId: context.id, resourceType: 'canvas', resourceId: canvasId, role: 'output' })
    const detail = service.get(context.id)
    expect(detail.resources).toHaveLength(2)
    expect(detail.recordCount).toBe(1)
    expect(detail.canvasCount).toBe(1)
  })

  it('link：不存在的 record / canvas 返回 NOT_FOUND', () => {
    const context = service.create({ title: '校验' })
    const missing = '00000000-0000-4000-8000-000000000000'
    try {
      service.link({ contextId: context.id, resourceType: 'record', resourceId: missing })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as WorkContextError).code).toBe('NOT_FOUND')
    }
    try {
      service.link({ contextId: context.id, resourceType: 'canvas', resourceId: missing })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as WorkContextError).code).toBe('NOT_FOUND')
    }
  })

  it('link：URL 只接受 http / https，且规范化保存', () => {
    const context = service.create({ title: 'URL 校验' })
    for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'not a url']) {
      try {
        service.link({ contextId: context.id, resourceType: 'url', url: bad })
        expect.unreachable(`should have thrown for ${bad}`)
      } catch (error) {
        expect((error as WorkContextError).code).toBe('VALIDATION_ERROR')
      }
    }
    const ok = service.link({ contextId: context.id, resourceType: 'url', url: 'https://example.com/post' })
    expect(ok.created).toBe(true)
    expect(ok.resource.resourceId).toBe('https://example.com/post')
    expect(service.get(context.id).urlCount).toBe(1)
  })

  it('prune-on-read：Record 被删除后，get 清理失效关联', () => {
    const record = createRecord(handle.db, 'device-test', LINK_DRAFT)
    const context = service.create({ title: '孤儿清理' })
    service.link({ contextId: context.id, resourceType: 'record', resourceId: record.id })
    expect(service.get(context.id).recordCount).toBe(1)

    handle.db.delete(recordsTable).where(eq(recordsTable.id, record.id)).run()
    const detail = service.get(context.id)
    expect(detail.recordCount).toBe(0)
    expect(detail.resources).toHaveLength(0)
  })

  it('不存在的上下文：get / update / link 都返回 NOT_FOUND', () => {
    const missing = '00000000-0000-4000-8000-000000000001'
    expect(() => service.get(missing)).toThrowError(WorkContextError)
    expect(() => service.update(missing, 1, { summary: 'x' })).toThrowError(WorkContextError)
    expect(() => service.link({ contextId: missing, resourceType: 'url', url: 'https://a.com' })).toThrowError(
      WorkContextError
    )
  })

  it('listForStudio：只返回 active，按最近活动取前 N 条', () => {
    const a = service.create({ title: 'A' })
    service.create({ title: 'B' })
    const refreshed = service.list(null).find((c) => c.id === a.id)!
    service.update(refreshed.id, refreshed.updatedAt, { status: 'completed' })
    const studio = service.listForStudio(3)
    expect(studio.map((item) => item.title)).toEqual(['B'])
  })
})
