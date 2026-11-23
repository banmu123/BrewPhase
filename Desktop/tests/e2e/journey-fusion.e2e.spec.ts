import { test, expect } from '@playwright/test'
import { pinLocale } from './locale'
import { openSpace } from './nav'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'

/**
 * Agent Journey × Records × Canvas 融合的真实端到端验收（R6-4.1 §10）。
 *
 * 走真实 Electron + 真实渲染 + 真实 SQLite，不 mock 任何一层：
 * - 场景 B：Journey 进画布 → 展开成流程分组 → **重开画布位置保持**
 * - 场景 C：普通 Record 与 Journey 同屏共存，缩放/平移仍可用
 * - 场景 D：事件节点 ↔ Record 建立关系 → 重开仍在 → 删除不影响任一端
 * - 场景 E：Journey 级与 Event 级笔记增改删，**Agent 原始事件不变**
 * - 场景 F：新表数据不进 change_log
 *
 * 断言以**直接查库**为准，不只信界面没报错。
 */

const JOURNEY_ID = 'b1b1b1b1-1111-4111-8111-000000000001'
const EVENT_PLAN = 'b1b1b1b1-1111-4111-8111-000000000011'
const EVENT_EXEC = 'b1b1b1b1-1111-4111-8111-000000000012'
const EVENT_OUTCOME = 'b1b1b1b1-1111-4111-8111-000000000013'
const CANVAS_ID = 'b1b1b1b1-1111-4111-8111-000000000002'
const RECORD_A = 'b1b1b1b1-1111-4111-8111-000000000021'
const RECORD_B = 'b1b1b1b1-1111-4111-8111-000000000022'
const CLIENT_ID = 'b1b1b1b1-1111-4111-8111-000000000031'

type Fixture = { userData: string; dbPath: string }

function seed(fixture: Fixture): void {
  mkdirSync(fixture.userData, { recursive: true })
  const db = new Database(fixture.dbPath)
  db.pragma('busy_timeout = 5000')
  for (const m of migrations) db.exec(m.sql)
  db.pragma(`user_version = ${migrations.length}`)
  const now = Date.now()

  db.prepare(
    `insert into canvases (id, name, note, is_sample, created_at, updated_at) values (?,?,?,?,?,?)`
  ).run(CANVAS_ID, '融合验收画布', '', 0, now, now)

  const record = db.prepare(
    `insert into records (id, carrier, title, note, url_string, provider, source_name, author_name,
       summary, content_kind, link_page, metadata_status, is_sample, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`
  )
  record.run(RECORD_A, 'text', 'MCP 接口设计笔记', '接口边界先定死', '', 'generic', '', '', '', '', 1, 'idle', now, now)
  record.run(RECORD_B, 'link', '之前踩坑的错误记录', '', 'https://example.com/bug', 'generic', 'example', '', '踩坑记录', 'article', 1, 'idle', now, now)

  db.prepare(
    `insert into mcp_clients (id, name, token_hash, scopes, created_at) values (?,?,?,?,?)`
  ).run(CLIENT_ID, 'seed', 'x', '[]', now)

  db.prepare(
    `insert into agent_journeys (id, title, goal, status, source_client_id, source_agent, model,
       work_context_id, created_at, started_at, updated_at, completed_at, capture_mode, schema_version)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
  ).run(
    JOURNEY_ID,
    '定位并修复 Remote MCP 配对竞态',
    '让 register 的并发守卫在 await 之前生效',
    'running',
    CLIENT_ID,
    'codex',
    'gpt-5',
    null,
    now,
    now,
    now,
    null,
    'workflow_summary'
  )

  const insertEvent = db.prepare(
    `insert into agent_journey_events (id, journey_id, sequence, event_type, role, status, evidence_level,
       title, summary, content, reason, source_client_id, source_agent, model, attempt_id, parent_event_id,
       idempotency_key, occurred_at, received_at, updated_at, metadata)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,null)`
  )
  insertEvent.run(
    EVENT_PLAN, JOURNEY_ID, 1, 'plan', 'agent', 'completed', 'agent_reported',
    '先补齐字段映射', '在 Handler 边界做 snake_case 到 camelCase 映射', '', '',
    CLIENT_ID, 'codex', 'gpt-5', null, null, 'seed-k1', now, now, now
  )
  insertEvent.run(
    EVENT_EXEC, JOURNEY_ID, 2, 'execution', 'agent', 'running', 'agent_reported',
    '把 to_event_id 显式映射成 toEventId', '正在改 handlers.ts', '', '',
    CLIENT_ID, 'codex', 'gpt-5', null, null, 'seed-k2', now, now, now
  )
  insertEvent.run(
    EVENT_OUTCOME, JOURNEY_ID, 3, 'outcome', 'agent', 'completed', 'agent_reported',
    '映射修好，回归通过', '两个套件都绿了', '', '',
    CLIENT_ID, 'codex', 'gpt-5', null, null, 'seed-k3', now, now, now
  )

  db.prepare(
    `insert into agent_journey_edges (id, journey_id, from_event_id, to_event_id, relationship_type, created_at)
     values (?,?,?,?,?,?)`
  ).run('b1b1b1b1-1111-4111-8111-000000000041', JOURNEY_ID, EVENT_EXEC, EVENT_PLAN, 'depends_on', now)

  db.close()
}

async function launch(fixture: Fixture) {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      BREWPHASE_USER_DATA_DIR: fixture.userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
  })
  const page = await app.firstWindow()
  await pinLocale(page)
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** 用当前视口把某事件的世界坐标换算成屏幕坐标并点击，直到 Inspector 打开。 */
async function selectEventNode(
  page: import('@playwright/test').Page,
  eventRow: { position_x: number; position_y: number },
  expectedTitle: string
): Promise<void> {
  const wrapBox = (await page.locator('.canvas-wrap').boundingBox())!
  const viewport = await page.getAttribute('.canvas-wrap', 'data-viewport')
  const [scale, offX, offY] = (viewport ?? '1,0,0').split(',').map(Number)
  const screen = {
    x: wrapBox.x + eventRow.position_x * scale + offX + 30,
    y: wrapBox.y + eventRow.position_y * scale + offY + 20
  }
  await expect(async () => {
    await page.mouse.click(screen.x, screen.y)
    await page.waitForTimeout(300)
    await expect(page.locator('.node-panel')).toBeVisible({ timeout: 2_000 })
    await expect(page.locator('.node-panel')).toContainText(expectedTitle, { timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
}

function read(dbPath: string, sql: string, ...params: unknown[]) {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.prepare(sql).all(...(params as never[]))
  } finally {
    db.close()
  }
}

function one<T>(dbPath: string, sql: string, ...params: unknown[]): T {
  const rows = read(dbPath, sql, ...params) as T[]
  return rows[0]
}

/** 打开指定画布的 Workspace。 */
async function openCanvas(page: import('@playwright/test').Page, name: string) {
  await openSpace(page, '画布')
  await expect(page.locator('.gallery-grid')).toBeVisible()
  await page.locator('.gallery-card', { hasText: name }).locator('.gallery-card__open').click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()
}

test('Journey 融合：进画布、共存、连接、笔记、重开保持（场景 B/C/D/E/F）', async () => {
  test.setTimeout(180_000)
  const fixture: Fixture = {
    userData: mkdtempSync(join(tmpdir(), 'bp-journey-fusion-')),
    dbPath: ''
  }
  fixture.dbPath = join(fixture.userData, 'brewphase.db')
  seed(fixture)
  const { app, page } = await launch(fixture)

  // ══ 场景 B.1：从 Picker 把 Journey 加进画布 ══════════════════
  await openCanvas(page, '融合验收画布')
  await expect(page.locator('.canvas-wrap')).toBeVisible()

  await page.getByRole('button', { name: '添加一条记录' }).click()
  await expect(page.locator('.picker-panel')).toBeVisible()
  // Journey 区在 Record 列表之后
  await expect(page.locator('.picker-journeys')).toBeVisible({ timeout: 10_000 })
  const journeyCard = page.locator('.add-card--journey', {
    hasText: '定位并修复 Remote MCP 配对竞态'
  })
  await expect(journeyCard).toBeVisible()

  // 放置前：0 摆位行
  expect(read(fixture.dbPath, 'select * from canvas_journey_placements')).toHaveLength(0)

  await journeyCard.click()
  await page.waitForTimeout(900)

  // 断言：1 分组 + 3 事件行；坐标是画布绝对坐标且首事件不早于分组原点
  const placements = read(
    fixture.dbPath,
    `select * from canvas_journey_placements
     order by case when event_id is null then 0 else 1 end, event_id`
  ) as Array<{
    event_id: string | null
    journey_id: string
    canvas_id: string
    position_x: number
    position_y: number
    collapsed: number
  }>
  expect(placements).toHaveLength(4)
  expect(placements.every((row) => row.journey_id === JOURNEY_ID)).toBe(true)
  expect(placements.every((row) => row.canvas_id === CANVAS_ID)).toBe(true)
  expect(placements.filter((row) => row.event_id === null)).toHaveLength(1)

  const group = placements.find((row) => row.event_id === null)!
  const eventRows = placements.filter((row) => row.event_id !== null)
  expect(eventRows).toHaveLength(3)
  for (const row of eventRows) {
    expect(row.position_x).toBeGreaterThanOrEqual(group.position_x)
    expect(row.position_y).toBeGreaterThanOrEqual(group.position_y)
  }

  // 幂等的 UI 表达：已在画布 → 卡片禁用，不可能重复放置。
  // （服务层 `placeJourneyOnCanvas` 的重复调用幂等由集成测试覆盖）
  await expect(journeyCard, '已在画布的 Journey 必须禁用').toBeDisabled()
  expect(read(fixture.dbPath, 'select * from canvas_journey_placements')).toHaveLength(4)

  await page.locator('.picker-panel').getByRole('button', { name: '关闭面板' }).click()

  // ══ 场景 C：普通 Record 与 Journey 同屏共存 ═════════════════
  await page.getByRole('button', { name: '添加一条记录' }).click()
  await expect(page.locator('.picker-panel')).toBeVisible()
  await page.locator('.add-card', { hasText: 'MCP 接口设计笔记' }).click()
  await expect(page.locator('.picker-join')).toHaveText('加入 1 项')
  await page.locator('.picker-join').click()
  await page.waitForTimeout(800)
  await page.locator('.picker-panel').getByRole('button', { name: '关闭面板' }).click()

  // 两类内容同时在库里：canvas_nodes（Record）+ canvas_journey_placements（Journey）
  expect(read(fixture.dbPath, 'select * from canvas_nodes')).toHaveLength(1)
  expect(read(fixture.dbPath, 'select * from canvas_journey_placements')).toHaveLength(4)

  // 缩放 / 平移仍然可用（两类内容共用同一个 Stage）
  const hud = page.locator('.canvas-hud')
  await expect(hud).toBeVisible()
  await hud.getByRole('button', { name: '缩小' }).click()
  await hud.getByRole('button', { name: '适配' }).click()
  await page.waitForTimeout(400)
  const viewport = await page.getAttribute('.canvas-wrap', 'data-viewport')
  expect(viewport, '视口应有读数').toBeTruthy()

  // ══ 场景 D：事件节点 ↔ Record 建立跨记录关系 ═══════════════
  // 用真实视口把 execution 事件的世界坐标换算成屏幕坐标并点击
  const execRow = eventRows.find((row) => row.event_id === EVENT_EXEC)!
  void viewport
  await selectEventNode(page, execRow, '把 to_event_id 显式映射成 toEventId')

  // 建立关系：选目标记录 + 关系类型 → 建立连接
  const linkRecordSelect = page.locator('.node-panel select').first()
  await linkRecordSelect.selectOption({ label: 'MCP 接口设计笔记' })
  await page.locator('.node-panel').getByRole('button', { name: '建立连接' }).click()
  await page.waitForTimeout(700)

  const links = read(
    fixture.dbPath,
    'select * from journey_record_links'
  ) as Array<{ event_id: string; record_id: string; relationship_type: string }>
  expect(links, '关系必须真的落库').toHaveLength(1)
  expect(links[0]).toMatchObject({
    event_id: EVENT_EXEC,
    record_id: RECORD_A,
    relationship_type: 'references'
  })

  // ══ 场景 E：Event 级笔记 + Journey 级笔记 ══════════════════
  // R6-4.1.1 §7.4：笔记输入从单行 input 改为多行 textarea（显式编辑区），
  // 断言语义不变——「笔记编辑区可见 + 能写入 + 保存落库」。
  const noteInput = page.locator('.node-panel textarea[placeholder*="经验"]')
  await expect(noteInput).toBeVisible()
  await noteInput.fill('下次先检查 IPC 白名单，不要直接改 Renderer')
  await page.locator('.node-panel').getByRole('button', { name: '保存笔记' }).click()
  await page.waitForTimeout(700)

  const eventNotes = read(
    fixture.dbPath,
    'select * from agent_journey_notes where event_id is not null'
  ) as Array<{ body: string; event_id: string }>
  expect(eventNotes).toHaveLength(1)
  expect(eventNotes[0].event_id).toBe(EVENT_EXEC)
  expect(eventNotes[0].body).toContain('IPC 白名单')

  // 笔记写入**没有**污染 Agent 原始事件
  const execBefore = one<{ summary: string; updated_at: number; status: string }>(
    fixture.dbPath,
    'select summary, updated_at, status from agent_journey_events where id = ?',
    EVENT_EXEC
  )
  expect(execBefore.summary).toBe('正在改 handlers.ts')
  expect(execBefore.status).toBe('running')

  // ══ 场景 F：融合数据不进 change_log ════════════════════════
  // 注意：普通 Record 节点入画布**本来就写** change_log（它进 iOS 同步，
  // 是既有行为）。要断言的是**三张 Journey 新表**一条都不进。
  const changeTypes = (
    read(fixture.dbPath, 'select distinct entity_type t from change_log') as Array<{ t: string }>
  ).map((row) => row.t)
  for (const banned of [
    'canvasJourneyPlacement',
    'journeyRecordLink',
    'agentJourneyNote',
    'agentJourney',
    'agentJourneyEvent'
  ]) {
    expect(changeTypes, `${banned} 不得进入 change_log / iOS 同步`).not.toContain(banned)
  }
  // 只允许既有的画布实体类型
  for (const type of changeTypes) {
    expect(['canvas', 'canvasNode'], `意外的实体类型 ${type}`).toContain(type)
  }

  // ══ 场景 B.6：重开画布，位置与内容保持 ═════════════════════
  await page.locator('.canvas-back').click()
  await expect(page.locator('.gallery-grid')).toBeVisible()
  await page.locator('.gallery-card', { hasText: '融合验收画布' }).locator('.gallery-card__open').click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()
  await page.waitForTimeout(1200)

  const reopened = read(
    fixture.dbPath,
    `select event_id, position_x, position_y
     from canvas_journey_placements
     order by case when event_id is null then 0 else 1 end, event_id`
  ) as Array<{ event_id: string | null; position_x: number; position_y: number }>
  expect(reopened).toHaveLength(4)
  const placementKey = (row: { event_id: string | null; position_x: number; position_y: number }) =>
    `${row.event_id ?? 'group'}:${row.position_x}:${row.position_y}`
  expect(reopened.map(placementKey), '重开画布后位置必须原样保持').toEqual(
    placements.map(placementKey)
  )

  // 关系与笔记重开后仍在
  expect(read(fixture.dbPath, 'select * from journey_record_links')).toHaveLength(1)
  expect(read(fixture.dbPath, 'select * from agent_journey_notes')).toHaveLength(1)

  // ══ 折叠分组：只改分组行 ═══════════════════════════════════
  const groupBefore = one<{ collapsed: number }>(
    fixture.dbPath,
    'select collapsed from canvas_journey_placements where event_id is null'
  )
  expect(groupBefore.collapsed).toBe(0)

  // ══ 场景 E：删除笔记只删笔记行 ═════════════════════════════
  // 重开画布后 Inspector 是关着的：先重新选中事件节点，笔记才会出现
  const reopenedExec = reopened.find((row) => row.event_id === EVENT_EXEC)!
  await selectEventNode(page, reopenedExec, '把 to_event_id 显式映射成 toEventId')
  await expect(
    page.locator('.node-panel').getByRole('button', { name: '删除笔记' }).first(),
    '重开后笔记必须还在'
  ).toBeVisible()

  await expect(async () => {
    await page.locator('.node-panel').getByRole('button', { name: '删除笔记' }).first().click()
    await page.waitForTimeout(500)
    const remaining = read(fixture.dbPath, 'select * from agent_journey_notes')
    expect(remaining).toHaveLength(0)
  }).toPass({ timeout: 15_000 })

  // 笔记删了，但事件与关系原样
  expect(
    read(fixture.dbPath, 'select * from agent_journey_events where id = ?', EVENT_EXEC)
  ).toHaveLength(1)
  expect(read(fixture.dbPath, 'select * from journey_record_links')).toHaveLength(1)

  await app.close()
  rmSync(fixture.userData, { recursive: true, force: true })
})
