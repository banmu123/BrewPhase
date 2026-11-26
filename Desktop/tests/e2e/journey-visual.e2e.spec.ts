import { test, expect } from '@playwright/test'
import { _electron as electronLauncher } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrations } from '../../src/main/database/migrations'
import { pinLocale } from './locale'
import type { JourneyDetailV1 } from '../../src/shared/contracts/entities/agent-journey'
import { JOURNEY_DETAIL_KEY } from '../../src/shared/contracts/entities/agent-journey'
import { openSpace } from './nav'
import {
  JOURNEY_GROUP_INSET,
  journeyGroupRect,
  layoutJourneyEvents
} from '../../src/shared/domain/journey-layout'

/**
 * Agent Journey 视觉验收（R6-4.1.1 §11，仅 `VISUAL_CHECK=1` 时跑）。
 *
 * 夹具刻意覆盖 spec 要求的全部形态：
 * - **九类事件各一条**（user_input / plan / decision / execution / observation /
 *   revision / verification / outcome / user_annotation）
 * - **主流程**：sequence 1→9 的时间顺序线
 * - **真实业务分支**：`observation branch_from plan`（非相邻 → 视觉分叉换行带）
 * - **失败后修正**：`execution` 状态 failed，`revision revises decision` 回环
 * - **两条跨记录关联**：decision→参考资料、verification→验证结果（不同类型）
 * - **一条 Event 级笔记 + 一条 Journey 级笔记**
 *
 * 摆位用**真实的** `layoutJourneyEvents` 算，不是随手写的坐标——
 * 截图要反映生产布局，顺带验证换行后的构图。
 *
 * 截图输出到 /tmp，沿用仓库既有的 VISUAL_CHECK 模式；**不引入**新的截图回归依赖。
 */

const visual = Boolean(process.env.VISUAL_CHECK)
test.skip(!visual, '视觉验收用例，设 VISUAL_CHECK=1 才跑')

const NOW = Date.now()
const CANVAS_ID = 'e0e0e0e0-1111-4111-8111-000000000001'
const JOURNEY_ID = 'e0e0e0e0-1111-4111-8111-000000000002'
const RECORD_NOTES = 'e0e0e0e0-1111-4111-8111-000000000011'
const RECORD_PITFALL = 'e0e0e0e0-1111-4111-8111-000000000012'
const CLIENT_ID = 'e0e0e0e0-1111-4111-8111-000000000021'

type EventSeed = {
  id: string
  seq: number
  type: string
  status: string
  title: string
  summary: string
  reason?: string
  /** 结构化执行详情（R6-4.2）。不给 = 旧事件，用来验「尚无详细执行信息」。 */
  details?: JourneyDetailV1
}

/** 九类事件各一条，讲一个完整的故事：需求 → 计划 → 决策 → 执行失败 → 观察 → 修正 → 验证 → 结果 → 用户补充。 */
const EVENTS: EventSeed[] = [
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000101',
    seq: 1,
    type: 'user_input',
    status: 'completed',
    title: '把 MCP 配对的并发守卫补上',
    summary: '用户要求：register 的守卫必须在 await 之前生效，不要靠时序碰运气。'
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000102',
    seq: 2,
    type: 'plan',
    status: 'completed',
    title: '先在 Handler 边界补齐字段映射',
    summary: '三步：定位映射缺口 → 在边界显式转换 → 补两条边关系回归。'
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000103',
    seq: 3,
    type: 'decision',
    status: 'completed',
    title: '映射放在 Handler 边界，不改 Service 领域模型',
    summary: '只在一处转换，MCP 对外 snake_case 与 Service camelCase 都保持原样。',
    reason: '边界转换可测、可枚举；散落到 Service 里会让领域模型背上协议细节。',
    details: {
      version: 1,
      decision: {
        selected_approach: '在 Handler 边界做 snake_case → camelCase 显式映射',
        rationale: 'Handler 是外部协议与 Application Service 的适配边界，协议细节只应在这里消失。',
        alternatives: [
          {
            approach: '在 Service 内部兼容两种命名',
            reason_not_selected: '领域模型被迫知道外部协议，测试面扩大到每一处读取'
          },
          {
            approach: '只补类型断言',
            reason_not_selected: '断言骗过编译器，运行时字段仍是 undefined'
          },
          {
            approach: '改 MCP 对外用 camelCase',
            reason_not_selected: '破坏既有客户端契约，6 个 Journey 工具全部受影响'
          }
        ],
        tradeoffs: ['边界多一层显式转换', '需要补一条真实链路的回归']
      }
    }
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000104',
    seq: 4,
    type: 'execution',
    status: 'failed',
    title: '改 handlers.ts 的 edges 映射',
    summary: '第一次只改了断言没改字段名，回归仍然红：边一条都没写进去。',
    details: {
      version: 1,
      changes: [
        {
          file_path: 'Desktop/src/main/application/mcp-tools/handlers.ts',
          change_type: 'modified',
          symbols: ['append_agent_journey_event'],
          change_summary: '把 params.edges 的 to_event_id / relationship_type 显式 map 成 toEventId / relationshipType。',
          before_behavior: '直接 as 成 Service 类型：类型过了，运行时字段仍是 snake_case，Service 读到 undefined，整条 append 事务回滚。',
          after_behavior: 'Handler 在边界逐字段转换，边关系正常写入；未传 edges 时仍为 undefined，行为不变。',
          why_this_location: 'Handler 是 MCP 协议与 Application Service 之间唯一的适配层，协议命名只应在这里消失。',
          line_range: { start: 369, end: 410 }
        },
        {
          file_path: 'Desktop/tests/integration/mcp-journey-bridge.test.ts',
          change_type: 'modified',
          symbols: ['F2. edges 的 snake_case → camelCase 映射'],
          change_summary: '新增三条断言：snake_case 提交真的落库、未传 edges 返回空数组、非法目标整体回滚。',
          before_behavior: '没有任何测试覆盖 edges 的字段名映射，映射写错照样绿。',
          after_behavior: '映射写错时该套件立刻变红。',
          why_this_location: '这个文件已经有 BridgeClient → BridgeServer → Service → SQLite 的完整链路，回归放这里才测得到端到端。'
        }
      ],
      observations: [
        {
          finding: 'Service 收到的 edge 对象字段名仍是 to_event_id，读 toEventId 得到 undefined。',
          impact: '每条边都触发 NOT_FOUND，整条 append 回滚，库里 0 条关系。',
          source: '回归套件的断言输出与 agent_journey_edges 表计数'
        }
      ],
      limitations: ['本条为失败尝试，成功的修改见后续 execution']
    }
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000105',
    seq: 5,
    type: 'observation',
    status: 'completed',
    title: '计划外观察：字段仍是 undefined',
    summary: '日志里 edge.toEventId 是 undefined——断言骗过了编译器，没骗过运行时。',
    reason: undefined
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000106',
    seq: 6,
    type: 'revision',
    status: 'completed',
    title: '改成显式 map，逐字段转换',
    summary: 'incomingEdges?.map(e => ({ toEventId: e.to_event_id, … }))，断言只描述进来的形状。',
    reason: '原计划「补个断言就行」被证伪：断言不产生运行时转换。'
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000107',
    seq: 7,
    type: 'verification',
    status: 'completed',
    title: '变异验证：还原成裸断言必须变红',
    summary: '两个套件各抓到 2 处失败，还原后全绿——测试确实覆盖了这条路径。',
    details: {
      version: 1,
      verification: [
        {
          command: 'npx vitest run tests/integration/mcp-journey-bridge.test.ts',
          target: '边关系回归 3 例',
          result: 'passed',
          exit_code: 0,
          summary: '23 通过；变异还原后恢复全绿。',
          evidence_reference: 'tests/integration/mcp-journey-bridge.test.ts'
        },
        {
          command: 'npx vitest run tests/integration/mcp-protocol.integration.test.ts',
          target: '真实 STDIO A→F 闭环',
          result: 'passed',
          exit_code: 0,
          summary: '7 通过。'
        },
        {
          target: 'Playwright 全量 E2E',
          result: 'not_run',
          summary: '本阶段未运行，不声称通过。'
        }
      ],
      references: [
        { kind: 'commit', value: 'e8390e35f793769a1776d5f0e9907fdef3f13839', label: 'R6-2.1' },
        { kind: 'test', value: 'tests/unit/mcp-journey-tools.test.ts', label: '工具契约 13 例' }
      ]
    }
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000108',
    seq: 8,
    type: 'outcome',
    status: 'completed',
    title: '边关系回归通过，整套 1457 全绿',
    summary: 'typecheck 0、mcp:build 0、完整套件 0 失败；Cloud 回归未受影响。'
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000109',
    seq: 9,
    type: 'user_annotation',
    status: 'completed',
    title: '用户补充：下次先看字段名再看断言',
    summary: '这类「类型对了字段名没对」的坑，优先在边界写显式转换。'
  }
]

/** 业务关系：depends_on 走直连；branch_from / revises 非相邻 → 换行带 + 底部回环。 */
const EDGES: Array<{ id: string; from: string; to: string; type: string }> = [
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000201',
    from: 'e0e0e0e0-1111-4111-8111-000000000104',
    to: 'e0e0e0e0-1111-4111-8111-000000000103',
    type: 'depends_on'
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000202',
    from: 'e0e0e0e0-1111-4111-8111-000000000105',
    to: 'e0e0e0e0-1111-4111-8111-000000000102',
    type: 'branch_from'
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000203',
    from: 'e0e0e0e0-1111-4111-8111-000000000106',
    to: 'e0e0e0e0-1111-4111-8111-000000000103',
    type: 'revises'
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000204',
    from: 'e0e0e0e0-1111-4111-8111-000000000107',
    to: 'e0e0e0e0-1111-4111-8111-000000000106',
    type: 'depends_on'
  },
  {
    id: 'e0e0e0e0-1111-4111-8111-000000000205',
    from: 'e0e0e0e0-1111-4111-8111-000000000108',
    to: 'e0e0e0e0-1111-4111-8111-000000000107',
    type: 'depends_on'
  }
]

function seed(fixture: { userData: string; dbPath: string }): void {
  mkdirSync(fixture.userData, { recursive: true })
  const db = new Database(fixture.dbPath)
  db.pragma('busy_timeout = 5000')
  for (const m of migrations) db.exec(m.sql)
  db.pragma(`user_version = ${migrations.length}`)

  db.prepare(
    `insert into canvases (id, name, note, is_sample, created_at, updated_at) values (?,?,?,?,?,?)`
  ).run(CANVAS_ID, 'Journey 验收', '', 0, NOW, NOW)

  const record = db.prepare(
    `insert into records (id, carrier, title, note, summary, url_string, provider,
       source_name, author_name, content_kind, link_page, metadata_status, is_sample, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`
  )
  record.run(
    RECORD_NOTES,
    'text',
    'MCP 接口设计笔记',
    '接口边界先定死，协议细节只在边界转换。',
    '边界转换可测、可枚举。',
    '',
    'generic',
    '',
    '',
    '',
    1,
    'idle',
    NOW,
    NOW
  )
  record.run(
    RECORD_PITFALL,
    'link',
    '之前踩坑的错误记录',
    '',
    '类型对了字段名没对，断言骗过编译器。',
    'https://example.com/pitfall',
    'generic',
    'example',
    '踩坑集',
    'article',
    1,
    'idle',
    NOW,
    NOW
  )

  db.prepare(
    `insert into agent_journeys (id, title, goal, status, source_client_id, source_agent, model,
       work_context_id, created_at, started_at, updated_at, completed_at, capture_mode, schema_version)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
  ).run(
    JOURNEY_ID,
    '定位并修复 Agent Journey 边关系映射',
    '让 register 的并发守卫在 await 之前生效；映射缺陷必须被回归抓住。',
    'running',
    CLIENT_ID,
    'codex',
    'gpt-5',
    null,
    NOW - 3_600_000,
    NOW - 3_600_000,
    NOW,
    null,
    'workflow_summary'
  )

  const insertEvent = db.prepare(
    `insert into agent_journey_events (id, journey_id, sequence, event_type, role, status, evidence_level,
       title, summary, content, reason, source_client_id, source_agent, model, attempt_id, parent_event_id,
       idempotency_key, occurred_at, received_at, updated_at, metadata)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  /**
   * 结构化详情按**生产路径的形状**落库：`metadata.journey_detail_v1`。
   * 给了 `details` 才写，不给就写 null——后者正是「旧事件」的形态，
   * 用来验 §3 要求的「尚无详细执行信息」而不是伪造空详情。
   */
  const metadataOf = (event: EventSeed): string | null =>
    event.details ? JSON.stringify({ [JOURNEY_DETAIL_KEY]: event.details }) : null
  for (const event of EVENTS) {
    insertEvent.run(
      event.id,
      JOURNEY_ID,
      event.seq,
      event.type,
      event.type === 'user_input' || event.type === 'user_annotation' ? 'user' : 'agent',
      event.status,
      'agent_reported',
      event.title,
      event.summary,
      '',
      event.reason ?? '',
      CLIENT_ID,
      'codex',
      'gpt-5',
      null,
      null,
      `seed-${event.seq}`,
      NOW - 3_600_000 + event.seq * 60_000,
      NOW - 3_600_000 + event.seq * 60_000,
      NOW - 3_600_000 + event.seq * 60_000,
      metadataOf(event)
    )
  }

  const insertEdge = db.prepare(
    `insert into agent_journey_edges (id, journey_id, from_event_id, to_event_id, relationship_type, created_at)
     values (?,?,?,?,?,?)`
  )
  for (const edge of EDGES) {
    insertEdge.run(edge.id, JOURNEY_ID, edge.from, edge.to, edge.type, NOW)
  }

  // 摆位用**真实布局函数**算：截图反映生产构图，顺带覆盖换行后的排布。
  const relative = layoutJourneyEvents(
    EVENTS.map((event) => ({ id: event.id, sequence: event.seq, eventType: event.type })),
    EDGES.map((edge) => ({
      fromEventId: edge.from,
      toEventId: edge.to,
      relationshipType: edge.type
    }))
  )
  const rect = journeyGroupRect(relative)
  const originX = 60
  const originY = 140

  const placement = db.prepare(
    `insert into canvas_journey_placements (id, canvas_id, journey_id, event_id,
       position_x, position_y, width, height, z_index, collapsed, updated_at)
     values (?,?,?,?,?,?,?,?,0,0,?)`
  )
  placement.run(
    'e0e0e0e0-1111-4111-8111-000000000301',
    CANVAS_ID,
    JOURNEY_ID,
    null,
    originX,
    originY,
    rect.width,
    rect.height,
    NOW
  )
  relative.forEach((node, index) => {
    placement.run(
      `e0e0e0e0-1111-4111-8111-0000000004${String(index).padStart(2, '0')}`,
      CANVAS_ID,
      JOURNEY_ID,
      node.eventId,
      originX + node.x,
      originY + node.y,
      node.width,
      node.height,
      NOW
    )
  })

  // 两条跨记录关联：目标 Record 节点摆在分组右侧，连线才有落点。
  const node = db.prepare(
    `insert into canvas_nodes (id, canvas_id, record_id, position_x, position_y, width, height,
       z_index, annotation, created_at, updated_at)
     values (?,?,?,?,?,?,?,0,?,?,?)`
  )
  const groupRight = originX + rect.width
  node.run('e0e0e0e0-1111-4111-8111-000000000501', CANVAS_ID, RECORD_NOTES, groupRight + 150, originY + 40, 240, 200, '', NOW, NOW)
  node.run('e0e0e0e0-1111-4111-8111-000000000502', CANVAS_ID, RECORD_PITFALL, groupRight + 150, originY + 300, 240, 220, '', NOW, NOW)

  const link = db.prepare(
    `insert into journey_record_links (id, journey_id, event_id, record_id, relationship_type, created_at, updated_at)
     values (?,?,?,?,?,?,?)`
  )
  link.run(
    'e0e0e0e0-1111-4111-8111-000000000601',
    JOURNEY_ID,
    'e0e0e0e0-1111-4111-8111-000000000103',
    RECORD_NOTES,
    'references',
    NOW,
    NOW
  )
  link.run(
    'e0e0e0e0-1111-4111-8111-000000000602',
    JOURNEY_ID,
    'e0e0e0e0-1111-4111-8111-000000000107',
    RECORD_PITFALL,
    'validates',
    NOW,
    NOW
  )

  const note = db.prepare(
    `insert into agent_journey_notes (id, journey_id, event_id, body, created_at, updated_at)
     values (?,?,?,?,?,?)`
  )
  note.run(
    'e0e0e0e0-1111-4111-8111-000000000701',
    JOURNEY_ID,
    'e0e0e0e0-1111-4111-8111-000000000104',
    '下次遇到「类型对了字段名没对」，先在边界写显式转换，再补断言。',
    NOW,
    NOW
  )
  note.run(
    'e0e0e0e0-1111-4111-8111-000000000702',
    JOURNEY_ID,
    null,
    '整体经验：断言只能证明你写下的东西成立，不能证明运行时走的是那条路——变异验证才管用。',
    NOW,
    NOW
  )

  db.close()
}

async function launch(fixture: { userData: string; dbPath: string }) {
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

/** Electron 窗口尺寸要走 BrowserWindow，`page.setViewportSize` 对它无效。 */
async function setWindowSize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size: { width: number; height: number }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setSize(size.width, size.height)
    win.center()
  }, { width, height })
}

/**
 * 截图 + **页面状态指纹**。
 *
 * 指纹落成同名 `.txt`：截图本身无法自证截到的是哪一页，而图像查看工具
 * 在本环境对同一路径会返回不同内容（已实测 06 全图与 06 裁剪互相矛盾）。
 * 文本指纹是可靠的一一对应证据，事后能核对「这张图当时应该是什么页面」。
 */
async function shoot(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.addStyleTag({ content: '*{transition:none !important;animation:none !important}' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `/tmp/journey-${name}.png` })

  const state = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll('h1, h2'))
      .map((el) => el.textContent?.trim())
      .filter(Boolean)
      .slice(0, 3)
    const has = (sel: string) => document.querySelector(sel) !== null
    return {
      headings: heading,
      canvasTopbar: has('.canvas-topbar'),
      gallery: has('.gallery-grid'),
      recordTile: has('.record-tile--journey'),
      journeyDetail: has('.journey-detail'),
      nodePanel: has('.node-panel'),
      journeyInspector: has('.journey-inspector'),
      theme: document.documentElement.dataset.theme ?? 'light',
      viewport: document.querySelector('.canvas-wrap')?.getAttribute('data-viewport') ?? null
    }
  })
  const lines = [
    `file: journey-${name}.png`,
    `headings: ${JSON.stringify(state.headings)}`,
    `canvasTopbar: ${state.canvasTopbar}`,
    `gallery: ${state.gallery}`,
    `recordTile: ${state.recordTile}`,
    `journeyDetail: ${state.journeyDetail}`,
    `nodePanel: ${state.nodePanel}`,
    `journeyInspector: ${state.journeyInspector}`,
    `theme: ${state.theme}`,
    `viewport: ${state.viewport}`
  ]
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`/tmp/journey-${name}.txt`, lines.join('\n'))
}

/** 等装窗落定（视口连续两次读数一致）。 */
async function waitForFit(page: import('@playwright/test').Page): Promise<void> {
  let last = await page.getAttribute('.canvas-wrap', 'data-viewport')
  for (let i = 0; i < 24; i += 1) {
    await page.waitForTimeout(150)
    const next = await page.getAttribute('.canvas-wrap', 'data-viewport')
    if (next && next === last) return
    last = next
  }
}

/** 关掉浮层：Inspector 是浮在工具栏上的，开着时会挡住「适配」按钮。 */
async function closePanels(page: import('@playwright/test').Page): Promise<void> {
  for (const sel of ['.node-panel', '.picker-panel']) {
    const panel = page.locator(sel)
    if ((await panel.count()) > 0) {
      const close = panel.getByRole('button', { name: '关闭面板' })
      if ((await close.count()) > 0) await close.first().click()
      else await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
    }
  }
}

/**
 * 打开画布并适配全部内容。
 * 空间名随语言变（zh 画布 / en Canvas），所以显式传进来——
 * `openSpace` 是按可访问名精确匹配的，硬编码中文在 en-US 下必超时。
 */
async function openFittedCanvas(
  page: import('@playwright/test').Page,
  label = 'Journey 验收',
  locale: 'zh-CN' | 'en-US' = 'zh-CN'
) {
  const spaceName = locale === 'zh-CN' ? '画布' : 'Canvas'
  const fitName = locale === 'zh-CN' ? '适配全部内容' : 'Fit all content'
  await closePanels(page)
  await openSpace(page, spaceName)
  await expect(page.locator('.gallery-grid')).toBeVisible()
  await page.locator('.gallery-card', { hasText: label }).locator('.gallery-card__open').click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()
  await page.getByRole('button', { name: fitName }).click()
  await waitForFit(page)
}

/** 用真实视口把世界坐标换算成屏幕坐标。 */
async function worldToScreen(
  page: import('@playwright/test').Page,
  world: { x: number; y: number }
): Promise<{ x: number; y: number }> {
  const raw = await page.getAttribute('.canvas-wrap', 'data-viewport')
  const [scale, offsetX, offsetY] = (raw ?? '1,0,0').split(',').map(Number)
  const box = (await page.locator('.canvas-wrap').boundingBox())!
  return { x: box.x + world.x * scale + offsetX, y: box.y + world.y * scale + offsetY }
}

/**
 * 可编程视觉审计（R6-4.1.1 §11）。
 *
 * 截图之外，把「看得到的问题」翻译成可断言的几何与对比度检查：
 * - 横向溢出：文字把容器撑宽 = 截断或错位的直接信号；
 * - 面板越界：Inspector 超出视口 = 挤压或被裁；
 * - 文字对比度：§9 要求「文字对比度足够」，用 WCAG 相对亮度算实际比值。
 *
 * Konva 画布部分没有 DOM 可查，其不重叠由 `journey-layout` 单测保证
 * （列号唯一 + 任意两矩形不相交），连线不穿节点由路由规则保证
 * （竖直只走列间隙、横平只走底部通道）。
 */
async function auditDom(
  page: import('@playwright/test').Page,
  label: string
): Promise<string[]> {
  const issues = await page.evaluate(() => {
    const found: string[] = []

    // 1) 横向溢出
    for (const sel of ['.journey-detail', '.node-panel', '.record-tile--journey', '.journey-timeline']) {
      document.querySelectorAll(sel).forEach((el, index) => {
        const node = el as HTMLElement
        if (node.scrollWidth > node.clientWidth + 2) {
          found.push(`${sel}[${index}] 横向溢出 ${node.scrollWidth} > ${node.clientWidth}`)
        }
      })
    }

    // 2) 浮层越出视口
    for (const sel of ['.node-panel', '.float-panel']) {
      document.querySelectorAll(sel).forEach((el, index) => {
        const rect = el.getBoundingClientRect()
        if (rect.bottom > window.innerHeight + 2) {
          found.push(`${sel}[${index}] 底部越界 ${Math.round(rect.bottom)} > ${window.innerHeight}`)
        }
        if (rect.right > window.innerWidth + 2) {
          found.push(`${sel}[${index}] 右侧越界 ${Math.round(rect.right)} > ${window.innerWidth}`)
        }
        if (rect.top < -2) {
          found.push(`${sel}[${index}] 顶部越界 ${Math.round(rect.top)} < 0`)
        }
      })
    }

    // 3) 文字对比度（WCAG 2.1 相对亮度）
    const parse = (color: string): [number, number, number] | null => {
      const m = color.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const parts = m[1].split(',').map((value) => Number.parseFloat(value))
      return [parts[0], parts[1], parts[2]]
    }
    const channel = (value: number) => {
      const v = value / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    const luminance = (rgb: [number, number, number]) =>
      0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
    const contrast = (fg: string, bg: string) => {
      const a = parse(fg)
      const b = parse(bg)
      if (!a || !b) return null
      const la = luminance(a)
      const lb = luminance(b)
      const [hi, lo] = la > lb ? [la, lb] : [lb, la]
      return (hi + 0.05) / (lo + 0.05)
    }
    const effectiveBg = (el: HTMLElement): string => {
      let node: HTMLElement | null = el
      while (node) {
        const bg = getComputedStyle(node).backgroundColor
        const parsed = parse(bg)
        // 透明的继续往上找，直到不透明的祖先
        if (parsed && !bg.includes('rgba(0, 0, 0, 0)') && getComputedStyle(node).backgroundColor !== 'transparent') {
          return bg
        }
        node = node.parentElement
      }
      return getComputedStyle(document.body).backgroundColor
    }

    const targets = [
      // 时间线与卡片
      ['.journey-event__summary', 4.5],
      ['.journey-event__title', 4.5],
      ['.journey-event__nodetail', 4.5],
      ['.journey-event__counts', 4.5],
      ['.journey-chip', 4.5],
      ['.journey-note p', 4.5],
      ['.record-tile__journey-summary', 4.5],
      ['.journey-inspector__hint', 4.5],
      ['.journey-inspector__empty', 4.5],
      // R6-4.2 结构化详情
      ['.journey-detail__label', 4.5],
      ['.journey-file-card__path', 4.5],
      ['.journey-file-card__summary', 4.5],
      ['.journey-file-card__why', 4.5],
      ['.journey-symbol', 4.5],
      ['.journey-diff__side p', 4.5],
      ['.journey-decision', 4.5],
      ['.journey-decision__alts li', 4.5],
      ['.journey-observations__finding', 4.5],
      ['.journey-observations__impact', 4.5],
      ['.journey-verify__target', 4.5],
      ['.journey-verify__summary', 4.5],
      ['.journey-verify__command', 4.5],
      ['.journey-verify__ref', 4.5],
      ['.journey-evidence__hint', 4.5],
      ['.journey-refs li', 4.5],
      ['.journey-limitations li', 4.5],
      ['.journey-detail__section-title', 4.5]
    ] as const
    for (const [sel, min] of targets) {
      document.querySelectorAll(sel).forEach((el, index) => {
        const node = el as HTMLElement
        const fg = getComputedStyle(node).color
        const bg = effectiveBg(node)
        const ratio = contrast(fg, bg)
        if (ratio !== null && ratio < min) {
          found.push(`${sel}[${index}] 对比度 ${ratio.toFixed(2)} < ${min}（${fg} on ${bg}）`)
        }
      })
    }

    return found
  })
  if (issues.length > 0) {
    console.log(`[visual-audit ${label}]`, JSON.stringify(issues, null, 2))
  }
  return issues
}

/** 旧事件的提示文案（zh）：与 i18n 的 records.journey.detail.noDetail 对齐。 */
function t_noDetail(_page: import('@playwright/test').Page): string {
  return '尚无详细执行信息'
}

/** 摆位（画布绝对坐标）→ 用于点选事件节点。 */
function placementOf(dbPath: string, eventId: string): { x: number; y: number } {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db
      .prepare('select position_x, position_y from canvas_journey_placements where event_id = ?')
      .get(eventId) as { position_x: number; position_y: number }
    return { x: row.position_x, y: row.position_y }
  } finally {
    db.close()
  }
}

test('Journey 视觉验收：九类事件、三种连接、双视口双语言', async () => {
  test.setTimeout(300_000)
  const dir = mkdtempSync(join(tmpdir(), 'bp-journey-visual-'))
  const fixture = { userData: dir, dbPath: join(dir, 'brewphase.db') }
  seed(fixture)
  const { app, page } = await launch(fixture)

  try {
    // ══ 视口 1：1440 × 900，zh-CN ══════════════════════════
    await setWindowSize(app, 1440, 900)
    await page.waitForTimeout(500)

    await openFittedCanvas(page)
    await shoot(page, '01-canvas-expanded-1440-zh')

    // 折叠态：整组收成一条，仍要保留完整视觉表现
    await collapseViaHeader(page, fixture.dbPath)
    await page.waitForTimeout(400)
    await shoot(page, '02-canvas-collapsed-1440-zh')
    await collapseViaHeader(page, fixture.dbPath) // 还原展开
    await page.waitForTimeout(400)

    // 普通事件 Inspector（execution：failed 状态 + Event 级笔记）
    await selectEvent(page, fixture.dbPath, 'e0e0e0e0-1111-4111-8111-000000000104')
    await expect(page.locator('.node-panel')).toBeVisible()
    await expect(page.locator('.node-panel')).toContainText('改 handlers.ts 的 edges 映射')
    await shoot(page, '03-inspector-execution-1440-zh')
    expect(await auditDom(page, 'inspector-zh'), 'Inspector 不应有溢出/越界/对比度问题').toEqual([])

    // Decision Inspector（决策依据 reason + 到 Record 的 references 关联）
    await selectEvent(page, fixture.dbPath, 'e0e0e0e0-1111-4111-8111-000000000103')
    await expect(page.locator('.node-panel')).toContainText('映射放在 Handler 边界')
    await shoot(page, '04-inspector-decision-1440-zh')

    // 混合画布 + 关系标签：先关 Inspector（它压在工具栏上），再适配
    await closePanels(page)
    await page.getByRole('button', { name: '适配全部内容' }).click()
    await waitForFit(page)
    await shoot(page, '05-canvas-mixed-1440-zh')

    // Records：Masonry 中的 Journey Tile
    await openSpace(page, '记录')
    await expect(page.getByRole('heading', { name: '记录', exact: true })).toBeVisible()
    await page.locator('.chip--journey').click()
    await page.waitForTimeout(600)
    await expect(page.locator('.record-tile--journey').first()).toBeVisible()
    await shoot(page, '06-records-tile-1440-zh')

    // Records：Journey 详情（时间线 + 关联记录真实标题 + 笔记）
    await page.locator('.record-tile--journey').first().click()
    await expect(page.locator('.journey-detail')).toBeVisible({ timeout: 10_000 })
    // 确认真的停在 Records 页再截：曾经截到过画布（页面切换与合成的竞态）
    await expect(page.getByRole('heading', { name: '记录', exact: true })).toBeVisible()
    await page.waitForTimeout(700)
    await shoot(page, '07-records-detail-1440-zh')
    expect(await auditDom(page, 'records-detail-zh'), 'Records 详情不应有溢出/越界/对比度问题').toEqual([])
    // 关联记录必须显示真实标题，绝不能是 UUID 片段
    const detailText = await page.locator('.journey-detail').innerText()
    expect(detailText, '关联记录要显示真实标题').toContain('MCP 接口设计笔记')
    expect(detailText).not.toMatch(/\b[0-9a-f]{8}\b/)
    // 笔记编辑区必须有显式保存按钮，不是只能按 Enter
    await expect(page.locator('.journey-detail').getByRole('button', { name: '保存' }).first()).toBeVisible()

    /*
     * 场景 H：展开单个事件的详细信息（§9.3 按需展开）。
     * execution 是第 4 个事件（seq 4），它的 details 里有 **两个文件**。
     */
    const executionItem = page.locator('.journey-timeline > li').nth(3)
    await expect(executionItem).toContainText('改 handlers.ts 的 edges 映射')
    await executionItem.getByRole('button', { name: '展开详细信息' }).click()
    await page.waitForTimeout(400)
    await expect(executionItem).toContainText('handlers.ts')
    await expect(executionItem).toContainText('mcp-journey-bridge.test.ts')
    await expect(executionItem).toContainText('为什么改在这里')
    await expect(executionItem.getByRole('button', { name: '收起详细信息' })).toBeVisible()
    await shoot(page, '14-records-detail-expanded-1440-zh')
    expect(await auditDom(page, 'records-expanded-zh'), '展开后不应有溢出/越界/对比度问题').toEqual([])

    // 旧事件（plan 没有 details）：明确显示「尚无详细执行信息」，不伪造详情
    const planItem = page.locator('.journey-timeline > li').nth(1)
    await expect(planItem).toContainText('先在 Handler 边界补齐字段映射')
    await expect(planItem).toContainText(t_noDetail(page))
    await shoot(page, '15-records-old-event-1440-zh')

    // 笔记与关联关系（Inspector 内）
    await openFittedCanvas(page)
    await selectEvent(page, fixture.dbPath, 'e0e0e0e0-1111-4111-8111-000000000104')
    await expect(page.locator('.node-panel')).toBeVisible()
    await shoot(page, '08-notes-and-links-1440-zh')
    expect(await auditDom(page, 'notes-links-zh'), '笔记与关联不应有溢出/对比度问题').toEqual([])

    // 场景 H：Decision Inspector —— 选择方案 / 放弃的方案 / 代价
    await closePanels(page)
    await selectEvent(page, fixture.dbPath, 'e0e0e0e0-1111-4111-8111-000000000103')
    await expect(page.locator('.node-panel')).toContainText('决策依据')
    await expect(page.locator('.node-panel')).toContainText('放弃的方案')
    await expect(page.locator('.node-panel')).toContainText('只补类型断言')
    await expect(page.locator('.node-panel')).toContainText('证据来源')
    await expect(page.locator('.node-panel')).toContainText('Agent 自述')
    await shoot(page, '16-inspector-decision-detail-1440-zh')
    expect(await auditDom(page, 'decision-detail-zh'), '决策详情不应有溢出/对比度问题').toEqual([])

    // 场景 H：Verification Inspector —— 通过 / 未运行两种结果都看得见
    await closePanels(page)
    await selectEvent(page, fixture.dbPath, 'e0e0e0e0-1111-4111-8111-000000000107')
    await expect(page.locator('.node-panel')).toContainText('实际验证')
    await expect(page.locator('.node-panel')).toContainText('通过')
    await expect(page.locator('.node-panel')).toContainText('未运行')
    await expect(page.locator('.node-panel')).toContainText('mcp-journey-bridge.test.ts')
    await shoot(page, '17-inspector-verification-detail-1440-zh')
    expect(await auditDom(page, 'verify-detail-zh'), '验证详情不应有溢出/对比度问题').toEqual([])

    // 场景 H（旧事件）：plan 没有 details，Inspector 给一句说明而不是空卡片
    await closePanels(page)
    await selectEvent(page, fixture.dbPath, 'e0e0e0e0-1111-4111-8111-000000000102')
    await expect(page.locator('.node-panel')).toContainText('先在 Handler 边界补齐字段映射')
    await expect(page.locator('.node-panel')).toContainText('尚无详细执行信息')
    await shoot(page, '18-inspector-old-event-1440-zh')

    // ══ 视口 2：1280 × 800 ═══════════════════════════════
    await setWindowSize(app, 1280, 800)
    await page.waitForTimeout(600)
    await openFittedCanvas(page)
    await shoot(page, '09-canvas-expanded-1280-zh')

    // ══ 语言 2：en-US，同时把视口切回 1440×900 ═══════════════
    // （1280 那段之后没有还原，直接截会得到 1280 的图却挂着 1440 的名字——
    //   指纹里的 viewport 读数暴露过这个问题。）
    await setWindowSize(app, 1440, 900)
    await page.waitForTimeout(500)
    await pinLocale(page, 'en-US')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(700)
    await openFittedCanvas(page, 'Journey 验收', 'en-US')
    await shoot(page, '10-canvas-expanded-1440-en')
    await expect(page.locator('.canvas-topbar')).toBeVisible()

    await closePanels(page)
    await openSpace(page, 'Records')
    await page.locator('.chip--journey').click()
    await page.waitForTimeout(600)
    await expect(page.locator('.record-tile--journey').first()).toBeVisible()
    await page.locator('.record-tile--journey').first().click()
    await expect(page.locator('.journey-detail')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: 'Records', exact: true })).toBeVisible()
    await page.waitForTimeout(700)
    await shoot(page, '11-records-detail-1440-en')
    expect(await auditDom(page, 'records-detail-en'), 'en-US 详情不应有溢出/越界/对比度问题').toEqual([])

    // 深色主题：同一屏必须仍然成立
    await page.evaluate(() => localStorage.setItem('brewphase.desktop.theme', 'dark'))
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(900)
    await openFittedCanvas(page, 'Journey 验收', 'en-US')
    await shoot(page, '12-canvas-dark-1440-en')
    // 暗色也要过同一套对比度检查：深底上「看起来还行」不等于达标
    await selectEvent(page, fixture.dbPath, 'e0e0e0e0-1111-4111-8111-000000000104')
    await expect(page.locator('.node-panel')).toBeVisible()
    await shoot(page, '13-inspector-dark-1440-en')
    expect(await auditDom(page, 'inspector-dark-en'), '暗色 Inspector 不应有溢出/越界/对比度问题').toEqual([])
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 点分组标题条右侧的折叠开关（Konva 内的控件，按几何位置命中）。 */
async function collapseViaHeader(
  page: import('@playwright/test').Page,
  dbPath: string
): Promise<void> {
  // 分组内容原点 = 摆位行；标题条在它上方（HEADER+HEAD_GAP），开关在盒右上角。
  const db = new Database(dbPath, { readonly: true })
  let originX = 0
  let originY = 0
  let boxW = 0
  try {
    const row = db
      .prepare(
        `select position_x, position_y, width from canvas_journey_placements
         where event_id is null`
      )
      .get() as { position_x: number; position_y: number; width: number }
    originX = row.position_x
    originY = row.position_y
    boxW = row.width
  } finally {
    db.close()
  }
  // 盒左上角 = 内容原点 − inset；开关在盒右上角往内 12 + 26/2
  const btnX = originX - JOURNEY_GROUP_INSET.x + boxW - 12 - 13
  const btnY = originY - JOURNEY_GROUP_INSET.y + 16 + 13
  const screen = await worldToScreen(page, { x: btnX, y: btnY })
  await page.mouse.click(screen.x, screen.y)
}

/** 点选某个事件节点（用真实摆位换算屏幕坐标）。 */
async function selectEvent(
  page: import('@playwright/test').Page,
  dbPath: string,
  eventId: string
): Promise<void> {
  const pos = placementOf(dbPath, eventId)
  await expect(async () => {
    const screen = await worldToScreen(page, { x: pos.x + 40, y: pos.y + 20 })
    await page.mouse.click(screen.x, screen.y)
    await page.waitForTimeout(300)
    await expect(page.locator('.node-panel')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
}
