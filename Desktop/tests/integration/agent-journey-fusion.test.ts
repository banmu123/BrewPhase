import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { migrate, migrations } from '../../src/main/database/migrations'
import {
  agentJourneyEdges,
  agentJourneyEvents,
  agentJourneyNotes,
  agentJourneys,
  canvasJourneyPlacements,
  canvases,
  changeLog,
  records
} from '../../src/main/database/schema'
import { eq } from 'drizzle-orm'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import {
  canvasJourneySchema,
  journeyDetailSchema
} from '../../src/shared/contracts/entities/agent-journey'
import { AgentJourneyService } from '../../src/main/application/agent-journey/agent-journey-service'
import { CanvasService } from '../../src/main/application/canvas/canvas-service'
import {
  createLink,
  listLinksForJourney,
  listNotesForJourney,
  removeLink
} from '../../src/main/database/repositories/agent-journey-supplements'
import {
  listEventPlacements,
  listPlacements,
  moveJourneyEvent,
  placeJourney,
  removeJourneyFromCanvas
} from '../../src/main/database/repositories/canvas-journey'

/**
 * Agent Journey × Records × Canvas 融合的真实 SQLite 集成测试（R6-4.1 §10）。
 *
 * **不 mock Repository**：外键级联、部分唯一索引、事务回滚、local-first 边界
 * 都只有在真库上才测得出来。每个用例独立临时目录，不碰真实用户数据。
 *
 * 覆盖：
 * - 场景 B/C：Journey 放进画布、重复放置幂等、从画布移除
 * - 场景 D：跨记录连接的建立与删除（删除不影响任一端）
 * - 场景 E：Journey 级 / Event 级笔记的增改删，原始事件不变
 * - 场景 F：不进 change_log、不进 iOS 同步、外键与级联
 */

let handle: DatabaseHandle
let dir: string
let events: ApplicationEvents
let journeys: AgentJourneyService
let canvas: CanvasService
let canvasId: string
let recordId: string

function newJourney(title = '测试 Journey'): string {
  const id = randomUUID()
  const now = Date.now()
  handle.db
    .insert(agentJourneys)
    .values({
      id,
      title,
      goal: '目标',
      status: 'created',
      sourceClientId: randomUUID(),
      sourceAgent: 'codex',
      model: 'test',
      workContextId: null,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      captureMode: 'workflow_summary',
      schemaVersion: 1
    })
    .run()
  return id
}

function newEvent(journeyId: string, sequence: number, eventType = 'plan', title = `事件${sequence}`) {
  const id = randomUUID()
  const now = Date.now()
  handle.db
    .insert(agentJourneyEvents)
    .values({
      id,
      journeyId,
      sequence,
      eventType,
      role: eventType === 'user_input' ? 'user' : 'agent',
      status: 'completed',
      evidenceLevel: 'agent_reported',
      title,
      summary: `摘要 ${sequence}`,
      content: '',
      reason: '',
      sourceClientId: randomUUID(),
      sourceAgent: 'codex',
      model: 'test',
      attemptId: null,
      parentEventId: null,
      idempotencyKey: randomUUID(),
      occurredAt: now,
      receivedAt: now,
      updatedAt: now,
      metadata: null
    })
    .run()
  return id
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'r641-'))
  handle = openDatabase(join(dir, 'app.db'))
  events = new ApplicationEvents()
  journeys = new AgentJourneyService(handle.db, events)
  canvas = new CanvasService(handle.db, handle.deviceId, events)

  const now = Date.now()
  canvasId = randomUUID()
  handle.db
    .insert(canvases)
    .values({
      id: canvasId,
      name: '融合画布',
      note: '',
      isSample: false,
      createdAt: now,
      updatedAt: now
    })
    .run()
  recordId = randomUUID()
  handle.db
    .insert(records)
    .values({
      id: recordId,
      carrier: 'text',
      title: 'MCP 接口设计笔记',
      note: '',
      urlString: '',
      provider: 'generic',
      sourceName: '',
      authorName: '',
      summary: '',
      contentKind: '',
      linkPage: 1,
      metadataStatus: 'idle',
      isSample: false,
      createdAt: now,
      updatedAt: now
    })
    .run()
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

// MARK: - 场景 B：Journey 进入 Canvas

describe('场景 B：Journey 进入 Canvas', () => {
  it('放置后有分组行 + 每个事件一行，坐标是画布绝对坐标', () => {
    const journeyId = newJourney()
    newEvent(journeyId, 1, 'plan')
    newEvent(journeyId, 2, 'execution')
    newEvent(journeyId, 3, 'outcome')

    const result = canvas.placeJourneyOnCanvas({ canvasId, journeyId })
    expect(result.created).toBe(true)

    const rows = listPlacements(handle.db, canvasId)
    // 1 分组 + 3 事件
    expect(rows).toHaveLength(4)
    expect(rows.filter((row) => row.eventId === null)).toHaveLength(1)
    expect(rows.filter((row) => row.eventId !== null)).toHaveLength(3)

    // 事件行的绝对坐标 = 分组原点 + 组内偏移（第一列相对 x=0）
    const group = rows.find((row) => row.eventId === null)!
    const firstEvent = rows.find((row) => row.eventId !== null)!
    expect(firstEvent.positionX).toBeGreaterThanOrEqual(group.positionX)
    expect(firstEvent.positionY).toBeGreaterThanOrEqual(group.positionY)
  })

  it('同一块画布重复放置是幂等的：不产生第二组行', () => {
    const journeyId = newJourney()
    newEvent(journeyId, 1, 'plan')

    canvas.placeJourneyOnCanvas({ canvasId, journeyId })
    const second = canvas.placeJourneyOnCanvas({ canvasId, journeyId })

    expect(second.created, '第二次放置不应算新建').toBe(false)
    expect(listPlacements(handle.db, canvasId)).toHaveLength(2)
  })

  it('同一条 Journey 可以放进第二块画布，且摆位各自独立', () => {
    const journeyId = newJourney()
    newEvent(journeyId, 1, 'plan')

    canvas.placeJourneyOnCanvas({ canvasId, journeyId })

    const canvas2 = randomUUID()
    const now = Date.now()
    handle.db
      .insert(canvases)
      .values({
        id: canvas2,
        name: '第二块',
        note: '',
        isSample: false,
        createdAt: now,
        updatedAt: now
      })
      .run()
    canvas.placeJourneyOnCanvas({ canvasId: canvas2, journeyId })

    // 两块画布各有一组
    expect(listPlacements(handle.db, canvasId)).toHaveLength(2)
    expect(listPlacements(handle.db, canvas2)).toHaveLength(2)

    // 在画布 A 上挪动，画布 B 不受影响（这是迁移 14 的表做不到的）
    const beforeB = listPlacements(handle.db, canvas2).map((row) => row.positionX)
    const groupA = listPlacements(handle.db, canvasId).find((row) => row.eventId === null)!
    canvas.moveJourneyGroupOnCanvas({
      canvasId,
      journeyId,
      positionX: groupA.positionX + 500,
      positionY: groupA.positionY + 300
    })
    const afterB = listPlacements(handle.db, canvas2).map((row) => row.positionX)
    expect(afterB, '画布 B 的摆位不能被画布 A 带走').toEqual(beforeB)
  })

  it('挪动分组时组内事件同步平移，相对关系不变', () => {
    const journeyId = newJourney()
    newEvent(journeyId, 1, 'plan')
    newEvent(journeyId, 2, 'execution')
    canvas.placeJourneyOnCanvas({ canvasId, journeyId })

    const before = listEventPlacements(handle.db, canvasId, journeyId)
    const groupBefore = listPlacements(handle.db, canvasId).find((row) => row.eventId === null)!
    const relativeBefore = before.map((row) => row.positionX - groupBefore.positionX)

    canvas.moveJourneyGroupOnCanvas({
      canvasId,
      journeyId,
      positionX: groupBefore.positionX + 120,
      positionY: groupBefore.positionY + 60
    })

    const groupAfter = listPlacements(handle.db, canvasId).find((row) => row.eventId === null)!
    const after = listEventPlacements(handle.db, canvasId, journeyId)
    expect(groupAfter.positionX).toBe(groupBefore.positionX + 120)
    const relativeAfter = after.map((row) => row.positionX - groupAfter.positionX)
    expect(relativeAfter, '组内相对关系必须保持').toEqual(relativeBefore)
  })

  it('挪动单个事件只改那一行，sequence 与业务 Edge 一个字节都不动', () => {
    const journeyId = newJourney()
    const first = newEvent(journeyId, 1, 'plan')
    const second = newEvent(journeyId, 2, 'execution')
    handle.db
      .insert(agentJourneyEdges)
      .values({
        id: randomUUID(),
        journeyId,
        fromEventId: second,
        toEventId: first,
        relationshipType: 'depends_on',
        createdAt: Date.now()
      })
      .run()
    canvas.placeJourneyOnCanvas({ canvasId, journeyId })

    const eventBefore = handle.db
      .select()
      .from(agentJourneyEvents)
      .where(eq(agentJourneyEvents.id, second))
      .get()!
    const edgesBefore = handle.db
      .select()
      .from(agentJourneyEdges)
      .all()

    const target = listEventPlacements(handle.db, canvasId, journeyId)[0]
    moveJourneyEvent(handle.db, {
      canvasId,
      eventId: target.eventId!,
      positionX: 9999,
      positionY: 8888,
      now: Date.now()
    })

    const eventAfter = handle.db
      .select()
      .from(agentJourneyEvents)
      .where(eq(agentJourneyEvents.id, second))
      .get()!
    const edgesAfter = handle.db
      .select()
      .from(agentJourneyEdges)
      .all()

    expect(eventAfter.sequence).toBe(eventBefore.sequence)
    expect(eventAfter.updatedAt).toBe(eventBefore.updatedAt)
    expect(edgesAfter).toEqual(edgesBefore)
  })

  it('折叠只改分组行；展开可逆', () => {
    const journeyId = newJourney()
    newEvent(journeyId, 1, 'plan')
    canvas.placeJourneyOnCanvas({ canvasId, journeyId })

    canvas.setJourneyCollapsedOnCanvas({ canvasId, journeyId, collapsed: true })
    const group = listPlacements(handle.db, canvasId).find((row) => row.eventId === null)!
    expect(group.collapsed).toBe(true)
    // 事件行不动
    expect(listEventPlacements(handle.db, canvasId, journeyId)).toHaveLength(1)

    canvas.setJourneyCollapsedOnCanvas({ canvasId, journeyId, collapsed: false })
    const reopened = listPlacements(handle.db, canvasId).find((row) => row.eventId === null)!
    expect(reopened.collapsed).toBe(false)
  })

  it('从画布移除只删摆位：Journey、事件、笔记、关系全部保留', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'plan')
    canvas.placeJourneyOnCanvas({ canvasId, journeyId })
    createLink(handle.db, {
      journeyId,
      eventId,
      recordId,
      relationshipType: 'references',
      now: Date.now()
    })
    handle.db
      .insert(agentJourneyNotes)
      .values({
        id: randomUUID(),
        journeyId,
        eventId: null,
        body: '我的经验',
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      .run()

    const result = canvas.removeJourneyFromCanvas({ canvasId, journeyId })
    expect(result.removed).toBe(true)

    expect(listPlacements(handle.db, canvasId)).toHaveLength(0)
    // 知识不随画布销毁
    expect(handle.db.select().from(agentJourneys).where(eq(agentJourneys.id, journeyId)).get()).toBeTruthy()
    expect(handle.db.select().from(agentJourneyEvents).all()).toHaveLength(1)
    expect(listLinksForJourney(handle.db, journeyId)).toHaveLength(1)
    expect(listNotesForJourney(handle.db, journeyId)).toHaveLength(1)
  })

  it('重复移除第二次返回 removed=false（不抛错）', () => {
    const journeyId = newJourney()
    newEvent(journeyId, 1, 'plan')
    canvas.placeJourneyOnCanvas({ canvasId, journeyId })
    expect(canvas.removeJourneyFromCanvas({ canvasId, journeyId }).removed).toBe(true)
    expect(canvas.removeJourneyFromCanvas({ canvasId, journeyId }).removed).toBe(false)
  })
})

// MARK: - 场景 D：跨记录连接

describe('场景 D：跨记录连接', () => {
  it('建立关系后两端都还在，关系可查', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'execution')

    const link = journeys.addRecordLink({
      journeyId,
      eventId,
      recordId,
      relationshipType: 'references'
    })

    expect(link.relationshipType).toBe('references')
    // 两端原样保留
    expect(handle.db.select().from(records).where(eq(records.id, recordId)).get()).toBeTruthy()
    expect(
      handle.db.select().from(agentJourneyEvents).where(eq(agentJourneyEvents.id, eventId)).get()
    ).toBeTruthy()
    expect(listLinksForJourney(handle.db, journeyId)).toHaveLength(1)
  })

  it('同一对允许不同关系类型；同类型重复建是幂等的', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'execution')

    journeys.addRecordLink({ journeyId, eventId, recordId, relationshipType: 'references' })
    journeys.addRecordLink({ journeyId, eventId, recordId, relationshipType: 'references' })
    journeys.addRecordLink({ journeyId, eventId, recordId, relationshipType: 'validates' })

    expect(listLinksForJourney(handle.db, journeyId)).toHaveLength(2)
  })

  it('删除关系只删关系行：Record 与 Event 都不许消失（场景 D.6）', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'execution')
    const link = journeys.addRecordLink({
      journeyId,
      eventId,
      recordId,
      relationshipType: 'produces'
    })

    const result = journeys.removeRecordLink(link.id)
    expect(result.removed).toBe(true)

    expect(handle.db.select().from(records).where(eq(records.id, recordId)).get()).toBeTruthy()
    expect(
      handle.db.select().from(agentJourneyEvents).where(eq(agentJourneyEvents.id, eventId)).get()
    ).toBeTruthy()
    expect(listLinksForJourney(handle.db, journeyId)).toHaveLength(0)
  })

  it('拒绝未知关系类型', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'execution')
    expect(() =>
      journeys.addRecordLink({
        journeyId,
        eventId,
        recordId,
        relationshipType: 'causes' // 不在白名单
      })
    ).toThrow(/unknown relationship_type/)
  })

  it('拒绝把别的 Journey 的事件接进来', () => {
    const journeyA = newJourney('A')
    const journeyB = newJourney('B')
    const eventInA = newEvent(journeyA, 1, 'execution')

    expect(() =>
      journeys.addRecordLink({
        journeyId: journeyB,
        eventId: eventInA,
        recordId,
        relationshipType: 'references'
      })
    ).toThrow(/does not belong to journey/)
    expect(listLinksForJourney(handle.db, journeyB)).toHaveLength(0)
  })

  it('拒绝不存在的 Record', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'execution')
    expect(() =>
      journeys.addRecordLink({
        journeyId,
        eventId,
        recordId: randomUUID(),
        relationshipType: 'references'
      })
    ).toThrow(/record .* does not exist/)
  })

  it('删记录 → 关系级联消失；删事件 → 关系级联消失', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'execution')
    createLink(handle.db, {
      journeyId,
      eventId,
      recordId,
      relationshipType: 'related_to',
      now: Date.now()
    })
    expect(listLinksForJourney(handle.db, journeyId)).toHaveLength(1)

    handle.db.delete(records).where(eq(records.id, recordId)).run()
    expect(listLinksForJourney(handle.db, journeyId)).toHaveLength(0)

    // 事件那条：重建再删事件
    const eventId2 = newEvent(journeyId, 2, 'plan')
    const record2 = randomUUID()
    const now = Date.now()
    handle.db
      .insert(records)
      .values({
        id: record2,
        carrier: 'text',
        title: '另一条',
        note: '',
        urlString: '',
        provider: 'generic',
        sourceName: '',
        authorName: '',
        summary: '',
        contentKind: '',
        linkPage: 1,
        metadataStatus: 'idle',
        isSample: false,
        createdAt: now,
        updatedAt: now
      })
      .run()
    createLink(handle.db, {
      journeyId,
      eventId: eventId2,
      recordId: record2,
      relationshipType: 'supports',
      now
    })
    expect(listLinksForJourney(handle.db, journeyId)).toHaveLength(1)
    handle.db
      .delete(agentJourneyEvents)
      .where(eq(agentJourneyEvents.id, eventId2))
      .run()
    expect(listLinksForJourney(handle.db, journeyId)).toHaveLength(0)
  })
})

// MARK: - 场景 E：用户笔记

describe('场景 E：用户补充（笔记）', () => {
  it('Journey 级与 Event 级笔记都能建、能查、能改、能删', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'plan')

    const journeyNote = journeys.addJourneyNote({ journeyId, body: '整体经验' })
    const eventNote = journeys.addEventNote({ journeyId, eventId, body: '节点提醒' })

    expect(journeyNote.eventId).toBeNull()
    expect(eventNote.eventId).toBe(eventId)

    const detail = journeys.getDetailForRenderer(journeyId)
    expect(detail.notes).toHaveLength(2)

    journeys.updateJourneyNote({ id: journeyNote.id, body: '改过的经验' })
    const after = journeys.getDetailForRenderer(journeyId)
    expect(after.notes.find((note) => note.id === journeyNote.id)?.body).toBe('改过的经验')

    journeys.removeJourneyNote(journeyNote.id)
    expect(journeys.getDetailForRenderer(journeyId).notes).toHaveLength(1)
  })

  it('改笔记绝不改 Agent 原始事件（数据隔离）', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'plan')

    const before = handle.db
      .select()
      .from(agentJourneyEvents)
      .where(eq(agentJourneyEvents.id, eventId))
      .get()!

    const note = journeys.addEventNote({ journeyId, eventId, body: '我的补充' })
    journeys.updateJourneyNote({ id: note.id, body: '改了三次的补充' })
    journeys.removeJourneyNote(note.id)

    const after = handle.db
      .select()
      .from(agentJourneyEvents)
      .where(eq(agentJourneyEvents.id, eventId))
      .get()!

    expect(after, 'Agent 原始事件必须逐字节不变').toEqual(before)
    // 事件表里也没有任何笔记痕迹
    expect(handle.db.select().from(agentJourneyNotes).where(eq(agentJourneyNotes.id, note.id)).get())
      .toBeUndefined()
  })

  it('空笔记被拒绝；不存在的笔记编辑返回 NOT_FOUND', () => {
    const journeyId = newJourney()
    expect(() => journeys.addJourneyNote({ journeyId, body: '   ' })).toThrow(/body is required/)
    expect(() => journeys.updateJourneyNote({ id: randomUUID(), body: 'x' })).toThrow(
      /does not exist/
    )
  })

  it('拒绝把笔记挂到别的 Journey 的事件上', () => {
    const journeyA = newJourney('A')
    const journeyB = newJourney('B')
    const eventInA = newEvent(journeyA, 1, 'plan')
    expect(() =>
      journeys.addEventNote({ journeyId: journeyB, eventId: eventInA, body: '越界' })
    ).toThrow(/does not belong to journey/)
  })

  it('删 Journey 级联删笔记', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'plan')
    journeys.addJourneyNote({ journeyId, body: '整体' })
    journeys.addEventNote({ journeyId, eventId, body: '节点' })
    expect(listNotesForJourney(handle.db, journeyId)).toHaveLength(2)

    handle.db.delete(agentJourneys).where(eq(agentJourneys.id, journeyId)).run()
    expect(listNotesForJourney(handle.db, journeyId)).toHaveLength(0)
  })

  it('笔记走脱敏：token 形态被改写', () => {
    const journeyId = newJourney()
    const note = journeys.addJourneyNote({
      journeyId,
      body: '日志里出现了 BREWPHASE_MCP_TOKEN=bp_mcp_supersecretvalue123456'
    })
    expect(note.body).not.toContain('bp_mcp_supersecretvalue123456')
    expect(note.body).toContain('[redacted]')
  })
})

// MARK: - 场景 F：数据边界

describe('场景 F：数据边界（local-first）', () => {
  it('融合写入不写 change_log（不进 iOS 同步）', () => {
    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'plan')

    const before = handle.db.select().from(changeLog).all().length

    canvas.placeJourneyOnCanvas({ canvasId, journeyId })
    journeys.addJourneyNote({ journeyId, body: '笔记' })
    journeys.addEventNote({ journeyId, eventId, body: '节点笔记' })
    journeys.addRecordLink({
      journeyId,
      eventId,
      recordId,
      relationshipType: 'references'
    })
    moveJourneyEvent(handle.db, {
      canvasId,
      eventId,
      positionX: 10,
      positionY: 20,
      now: Date.now()
    })

    const after = handle.db.select().from(changeLog).all().length
    expect(after, '融合数据不得进入 change_log / iOS 同步').toBe(before)
  })

  it('新表不在 SYNC_ENTITY_TYPES 白名单里（wipe 不会误删）', async () => {
    const wipeSource = await import('node:fs').then((fs) =>
      fs.readFileSync('src/main/sync/wipe.ts', 'utf8')
    )
    expect(wipeSource).not.toContain('canvas_journey_placements')
    expect(wipeSource).not.toContain('journey_record_links')
    expect(wipeSource).not.toContain('agent_journey_notes')
  })

  it('snapshot-importer 不认识这些实体（不会被 iOS 覆盖）', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/main/sync/snapshot-importer.ts', 'utf8')
    )
    expect(source).not.toContain('canvasJourneyPlacement')
    expect(source).not.toContain('journeyRecordLink')
    expect(source).not.toContain('agentJourneyNote')
  })

  it('迁移 15 的表用 CASCADE 外键，且带部分唯一索引', () => {
    const indexes = handle.sqlite
      .prepare(
        `select name, sql from sqlite_master where type='index'
         and name in ('canvas_journey_group_uidx','canvas_journey_event_uidx','journey_record_links_uidx')`
      )
      .all() as Array<{ name: string; sql: string }>
    const byName = new Map(indexes.map((row) => [row.name, row.sql]))
    expect(byName.get('canvas_journey_group_uidx')).toMatch(/where.*event_id is null/is)
    expect(byName.get('canvas_journey_event_uidx')).toMatch(/where.*event_id is not null/is)
    expect(byName.get('journey_record_links_uidx')).toBeTruthy()

    const ddl = handle.sqlite
      .prepare(`select sql from sqlite_master where name='canvas_journey_placements'`)
      .get() as { sql: string }
    expect(ddl.sql).toMatch(/REFERENCES canvases\(id\) ON DELETE CASCADE/i)
    expect(ddl.sql).toMatch(/REFERENCES agent_journeys\(id\) ON DELETE CASCADE/i)
  })

  // CI runner 高负载下会超默认 5s（迁移 + 全库校验的操作时长），不是平台差异。
  it('从版本 14 升级到最新：旧库数据原样保留', { timeout: 60_000 }, () => {
    // 上面 beforeEach 已经跑到最新版；这里再造一个只到 14 的库验证升级路径
    const oldDir = mkdtempSync(join(tmpdir(), 'r641-v14-'))
    try {
      const sqlite = new Database(join(oldDir, 'old.db'))
      sqlite.pragma('foreign_keys = ON')
      for (const migration of migrations) {
        if (migration.version >= 15) break
        sqlite.exec(migration.sql)
        sqlite.pragma(`user_version = ${migration.version}`)
      }
      const now = Date.now()
      sqlite
        .prepare(
          `insert into canvases (id,name,note,is_sample,created_at,updated_at) values (?,?,?,?,?,?)`
        )
        .run('c-old', '旧画布', '', 0, now, now)
      sqlite
        .prepare(
          `insert into agent_journeys (id,title,source_client_id,created_at,updated_at) values (?,?,?,?,?)`
        )
        .run('j-old', '旧 Journey', 'cli', now, now)
      expect(sqlite.pragma('user_version', { simple: true })).toBe(14)

      migrate(sqlite)
      // 最新版由 `migrations` 数组自己说了算：以后再追加迁移版本时，
      // 这条「旧数据在升级后原样保留」的断言不用跟着改（R6-4.3.1 起）。
      expect(sqlite.pragma('user_version', { simple: true })).toBe(
        migrations[migrations.length - 1].version
      )
      // 旧数据原样
      expect(sqlite.prepare(`select count(*) c from canvases`).get()).toEqual({ c: 1 })
      expect(sqlite.prepare(`select count(*) c from agent_journeys`).get()).toEqual({ c: 1 })
      // 新表已建
      expect(sqlite.prepare(`select count(*) c from canvas_journey_placements`).get()).toEqual({
        c: 0
      })
      sqlite.close()
    } finally {
      rmSync(oldDir, { recursive: true, force: true })
    }
  })

  it('外键开着：删画布级联删摆位（不留孤儿行）', () => {
    const journeyId = newJourney()
    newEvent(journeyId, 1, 'plan')
    canvas.placeJourneyOnCanvas({ canvasId, journeyId })
    expect(listPlacements(handle.db, canvasId)).toHaveLength(2)

    handle.db.delete(canvases).where(eq(canvases.id, canvasId)).run()
    expect(handle.db.select().from(canvasJourneyPlacements).all()).toHaveLength(0)
    // Journey 本身还在
    expect(handle.db.select().from(agentJourneys).where(eq(agentJourneys.id, journeyId)).get()).toBeTruthy()
  })
})

// MARK: - 契约：Service 输出必须能被共享 schema parse

describe('Renderer DTO 与共享契约一致（防 camelCase 静默消失）', () => {
  it('getDetailForRenderer 的输出能被 journeyDetailSchema parse', () => {
    const journeyId = newJourney()
    const plan = newEvent(journeyId, 1, 'plan')
    const exec = newEvent(journeyId, 2, 'execution')
    journeys.addJourneyNote({ journeyId, body: '整体笔记' })
    journeys.addEventNote({ journeyId, eventId: exec, body: '节点笔记' })
    journeys.addRecordLink({
      journeyId,
      eventId: exec,
      recordId,
      relationshipType: 'references'
    })

    const detail = journeys.getDetailForRenderer(journeyId)
    // parse 失败 = 字段名或类型与契约不符（曾经的 bug：note.event_id 恒 undefined）
    const parsed = journeyDetailSchema.safeParse(detail)
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)
    ).toBe(true)

    // 再直接钉死最容易出错的两个字段
    const value = journeyDetailSchema.parse(detail)
    expect(value.notes).toHaveLength(2)
    expect(value.notes.map((note) => note.event_id).sort()).toEqual([exec, null].sort())
    expect(value.links[0]).toMatchObject({
      event_id: exec,
      record_id: recordId,
      relationship_type: 'references'
    })
    expect(value.events.map((event) => event.sequence)).toEqual([1, 2])
    expect(value.events[0]).toHaveProperty('event_type', 'plan')
    expect(value.journey).toHaveProperty('event_count', 2)
    expect(plan).toBeTruthy()
  })

  it('canvas.journeysForCanvas 的输出能被 canvasJourneySchema parse', () => {
    const journeyId = newJourney()
    const exec = newEvent(journeyId, 1, 'execution')
    canvas.placeJourneyOnCanvas({ canvasId, journeyId })
    journeys.addRecordLink({
      journeyId,
      eventId: exec,
      recordId,
      relationshipType: 'validates'
    })

    const list = canvas.journeysForCanvas(canvasId)
    expect(list).toHaveLength(1)
    const parsed = canvasJourneySchema.safeParse(list[0])
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)
    ).toBe(true)

    const value = canvasJourneySchema.parse(list[0])
    expect(value.links).toHaveLength(1)
    expect(value.links[0]).toMatchObject({ event_id: exec, record_id: recordId })
    expect(value.nodes).toHaveLength(1)
    expect(value.nodes[0].event_id).toBe(exec)
    expect(value.placement.event_id).toBeNull()
    expect(value.journey?.title).toBe('测试 Journey')
  })
})

// MARK: - Repository 边界

describe('Repository 边界', () => {
  it('placeJourney 在事务里：中途失败不留下半截分组', () => {
    const journeyId = newJourney()
    // 事件 ID 指向不存在的行 → 外键拒绝 → 整个事务回滚
    expect(() =>
      placeJourney(handle.db, {
        canvasId,
        journeyId,
        group: { positionX: 0, positionY: 0, width: 300, height: 200 },
        nodes: [{ eventId: randomUUID(), positionX: 0, positionY: 0, width: 240, height: 140 }],
        now: Date.now()
      })
    ).toThrow()

    expect(listPlacements(handle.db, canvasId)).toHaveLength(0)
    expect(
      handle.db
        .select()
        .from(canvasJourneyPlacements)
        .where(eq(canvasJourneyPlacements.journeyId, journeyId))
        .all()
    ).toHaveLength(0)
  })

  it('removeLink 对不存在的 ID 返回 removed=false', () => {
    expect(removeLink(handle.db, randomUUID()).removed).toBe(false)
  })

  it('领域事件：摆位与笔记写入都会广播（Renderer 才刷新得动）', () => {
    const seen: string[] = []
    events.onChanged((domain) => seen.push(domain))

    const journeyId = newJourney()
    const eventId = newEvent(journeyId, 1, 'plan')
    canvas.placeJourneyOnCanvas({ canvasId, journeyId })
    journeys.addJourneyNote({ journeyId, body: '笔记' })
    journeys.addRecordLink({ journeyId, eventId, recordId, relationshipType: 'references' })

    expect(seen).toContain('canvas')
    expect(seen).toContain('agentJourneys')
  })
})
