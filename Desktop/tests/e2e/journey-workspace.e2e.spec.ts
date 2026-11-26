import { test, expect, type Page } from '@playwright/test'
import { pinLocale } from './locale'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'

/**
 * Journey × Local Workspace 绑定的真实界面验收（R6-4.3.1.1 §四）。
 *
 * 走真实 Electron + 真实渲染 + 真实 SQLite，只在**测试进程**里操作 fixture
 * 数据库（种子、删文件夹、注入列表读取失败）——渲染层与主进程都不 mock：
 *
 *  1. 登记两个 Workspace（真实目录 + local_workspaces 行）
 *  2. 打开未绑定 Journey → 「未关联工作区」
 *  3. 绑定 → 显示正确名称
 *  4. 换绑 → 显示新名称
 *  5. 解绑 → 「未关联工作区」
 *  6. 刷新页面（reload）后状态仍正确
 *  7. 绑定目录从磁盘删除 → 显示「不可用」，**不是**「登记已删除」
 *  8. 列表请求失败（drop 表注入）→ 显示失败态，**绝不**显示 deleted
 *  9. 恢复后点「重试」→ 恢复正确显示
 * 10. Execution 已开始 → 界面不提供换绑 / 解绑
 *
 * 失败注入用「测试进程 drop/重建 `local_workspaces` 表」：渲染层的
 * contextBridge 对象不可改写（实测 `Cannot redefine property`），主进程的
 * `ipcMain` handler 也无法从外部捕获还原，而 fixture 数据库本来就是本测试
 * 自己种子的——改它不碰产品代码，也不引入任何新测试框架。
 */

const J_FREE = 'e2e00000-0000-4000-8000-000000000001'
const J_LOCKED = 'e2e00000-0000-4000-8000-000000000002'
const EVENT_PLAN_FREE = 'e2e00000-0000-4000-8000-000000000011'
const EVENT_PLAN_LOCKED = 'e2e00000-0000-4000-8000-000000000012'
const EVENT_EXEC_LOCKED = 'e2e00000-0000-4000-8000-000000000013'
const WS_A = 'e2e00000-0000-4000-8000-000000000021'
const WS_B = 'e2e00000-0000-4000-8000-000000000022'

const TITLE_FREE = '未绑定工作区的修复任务'
const TITLE_LOCKED = '执行中的任务与工作区锁定'
const NAME_A = 'BrewPhase 源码'
const NAME_B = 'Chrome 扩展'

type Fixture = { userData: string; dbPath: string; dirA: string; dirB: string }

/** 只读 / 写 fixture 库都走这里：busy_timeout 防与应用连接互等。 */
function withDb(fixture: Fixture, run: (db: Database.Database) => void): void {
  const db = new Database(fixture.dbPath)
  db.pragma('busy_timeout = 5000')
  try {
    run(db)
  } finally {
    db.close()
  }
}

function seed(fixture: Fixture): void {
  mkdirSync(fixture.userData, { recursive: true })
  mkdirSync(fixture.dirA, { recursive: true })
  mkdirSync(fixture.dirB, { recursive: true })
  const pathA = realpathSync(fixture.dirA)
  const pathB = realpathSync(fixture.dirB)

  withDb(fixture, (db) => {
    for (const m of migrations) db.exec(m.sql)
    db.pragma(`user_version = ${migrations.length}`)
    const now = Date.now()

    const insertWorkspace = db.prepare(
      `insert into local_workspaces (id, name, absolute_path, platform, created_at, updated_at)
       values (?,?,?,?,?,?)`
    )
    insertWorkspace.run(WS_A, NAME_A, pathA, 'darwin', now, now)
    insertWorkspace.run(WS_B, NAME_B, pathB, 'darwin', now, now)

    const insertJourney = db.prepare(
      `insert into agent_journeys (id, title, goal, status, source_client_id, source_agent, model,
         work_context_id, workspace_id, created_at, started_at, updated_at, completed_at,
         capture_mode, schema_version)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?, 'workflow_summary', 1)`
    )
    insertJourney.run(
      J_FREE,
      TITLE_FREE,
      '把绑定流程在真实界面走一遍',
      'created',
      'e2e-client',
      'codex',
      'gpt-5',
      null,
      null,
      now - 1_000,
      null,
      now - 1_000,
      null
    )
    insertJourney.run(
      J_LOCKED,
      TITLE_LOCKED,
      '执行已开始的 Journey 不许再换观察范围',
      'running',
      'e2e-client',
      'codex',
      'gpt-5',
      null,
      WS_A,
      now,
      now,
      now,
      null
    )

    const insertEvent = db.prepare(
      `insert into agent_journey_events (id, journey_id, sequence, event_type, role, status,
         evidence_level, title, summary, content, reason, source_client_id, source_agent, model,
         attempt_id, parent_event_id, idempotency_key, occurred_at, received_at, updated_at, metadata)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,null)`
    )
    insertEvent.run(
      EVENT_PLAN_FREE, J_FREE, 1, 'plan', 'agent', 'completed', 'agent_reported',
      '先打通绑定', '在真实界面把绑定 / 换绑 / 解绑走一遍', '', '',
      'e2e-client', 'codex', 'gpt-5', null, null, 'seed-k1', now, now, now
    )
    insertEvent.run(
      EVENT_PLAN_LOCKED, J_LOCKED, 1, 'plan', 'agent', 'completed', 'agent_reported',
      '开始执行', '计划先行', '', '',
      'e2e-client', 'codex', 'gpt-5', null, null, 'seed-k2', now, now, now
    )
    insertEvent.run(
      EVENT_EXEC_LOCKED, J_LOCKED, 2, 'execution', 'agent', 'running', 'agent_reported',
      '正在改 handlers.ts', '执行进行中，观察窗口已打开', '', '',
      'e2e-client', 'codex', 'gpt-5', null, null, 'seed-k3', now, now, now
    )
  })
}

/** 注入：让 `workspace:list` 真实失败（表不存在 → 主进程 handler 抛错）。 */
function injectListFailure(fixture: Fixture): void {
  withDb(fixture, (db) => {
    // 测试连接关掉 FK 再删表：J_LOCKED.workspace_id 引用着 WS_A，
    // 否则 DROP 的隐式 DELETE 会撞外键（应用连接不受影响，它没在写）。
    db.pragma('foreign_keys = OFF')
    db.exec('drop table local_workspaces')
  })
}

/** 恢复表结构与两行登记（与 seed 同一份数据），并把 A 目录建回来。 */
function restoreWorkspaceData(fixture: Fixture): void {
  mkdirSync(fixture.dirA, { recursive: true })
  const pathA = realpathSync(fixture.dirA)
  const pathB = realpathSync(fixture.dirB)
  withDb(fixture, (db) => {
    db.pragma('foreign_keys = OFF')
    db.exec(
      `create table if not exists local_workspaces (
         id text primary key,
         name text not null,
         absolute_path text not null,
         platform text not null default '',
         created_at integer not null,
         updated_at integer not null
       );
       create unique index if not exists local_workspaces_path_idx on local_workspaces (absolute_path);`
    )
    const now = Date.now()
    const insert = db.prepare(
      `insert into local_workspaces (id, name, absolute_path, platform, created_at, updated_at)
       values (?,?,?,?,?,?)`
    )
    insert.run(WS_A, NAME_A, pathA, 'darwin', now, now)
    insert.run(WS_B, NAME_B, pathB, 'darwin', now, now)
  })
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

/** 工作区分区：用标题精确定位，避免与「添加到画布」等分区串味。 */
function workspaceSection(page: Page) {
  return page
    .locator('.journey-section')
    .filter({ has: page.locator('h3.journey-section__title', { hasText: /^工作区$/ }) })
}

function statusLine(page: Page) {
  return workspaceSection(page).locator('p.note')
}

/** 进 Records 并打开指定 Journey 详情（reload 后可能停在首页，两头都兼容）。 */
async function openJourney(page: Page, title: string): Promise<void> {
  if ((await page.locator('.record-tile--journey').count()) === 0) {
    const entry = page.getByRole('button', { name: '记录', exact: true })
    if ((await entry.count()) === 0) {
      // 不在首页（例如 reload 后回到了别的空间）：先回品牌首页。
      await page.locator('.topbar__brand').first().click()
    }
    await page.getByRole('button', { name: '记录', exact: true }).click()
  }
  const tile = page.locator('.record-tile--journey', { hasText: title })
  await expect(tile).toBeVisible()
  await tile.click()
  await expect(page.locator('.journey-detail')).toBeVisible()
}

/** reload 后重新回到目标 Journey 详情（详情浮层不跨刷新保留）。 */
async function reopenAfterReload(page: Page, title: string): Promise<void> {
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await openJourney(page, title)
}

test('Journey 工作区：绑定 / 换绑 / 解绑 / 刷新 / 失效 / 列表失败与重试 / 执行锁定', async () => {
  test.setTimeout(180_000)

  const root = mkdtempSync(join(tmpdir(), 'bp-journey-ws-e2e-'))
  const fixture: Fixture = {
    userData: join(root, 'user'),
    dbPath: join(root, 'user', 'brewphase.db'),
    dirA: join(root, 'ws-a'),
    dirB: join(root, 'ws-b')
  }
  seed(fixture)

  const { app, page } = await launch(fixture)
  try {
    // ── 1–2：登记完成，打开未绑定 Journey ─────────────────────
    await openJourney(page, TITLE_FREE)
    await expect(statusLine(page)).toHaveText('未关联工作区')
    await expect(workspaceSection(page).locator('select')).toBeVisible()

    // ── 3：绑定 A → 显示名称 ─────────────────────────────────
    await workspaceSection(page).locator('select').selectOption({ label: NAME_A })
    await workspaceSection(page).getByRole('button', { name: '关联', exact: true }).click()
    await expect(statusLine(page)).toHaveText(`已关联：${NAME_A}`)

    // ── 4：换绑 B → 显示新名称 ───────────────────────────────
    await workspaceSection(page).locator('select').selectOption({ label: NAME_B })
    await workspaceSection(page).getByRole('button', { name: '换绑', exact: true }).click()
    await expect(statusLine(page)).toHaveText(`已关联：${NAME_B}`)

    // ── 5：解绑 → 未关联，且 Journey 还在 ─────────────────────
    await workspaceSection(page).getByRole('button', { name: '解除关联', exact: true }).click()
    await expect(statusLine(page)).toHaveText('未关联工作区')
    await expect(page.locator('.record-tile--journey', { hasText: TITLE_FREE })).toBeVisible()

    // 再绑回 A，为「刷新后仍正确」做准备
    await workspaceSection(page).locator('select').selectOption({ label: NAME_A })
    await workspaceSection(page).getByRole('button', { name: '关联', exact: true }).click()
    await expect(statusLine(page)).toHaveText(`已关联：${NAME_A}`)

    // ── 6：刷新页面 → 状态仍正确 ─────────────────────────────
    await reopenAfterReload(page, TITLE_FREE)
    await expect(statusLine(page)).toHaveText(`已关联：${NAME_A}`)

    // ── 7：目录从磁盘删除 → 「不可用」而非「登记已删除」──────
    rmSync(fixture.dirA, { recursive: true, force: true })
    await reopenAfterReload(page, TITLE_FREE)
    await expect(statusLine(page)).toHaveText(`工作区不可用：${NAME_A}（文件夹已失效）`)
    await expect(statusLine(page)).not.toContainText('原工作区已删除')

    // ── 8：列表请求失败 → 失败态，绝不显示 deleted ────────────
    injectListFailure(fixture)
    await reopenAfterReload(page, TITLE_FREE)
    await expect(statusLine(page)).toHaveText('暂时无法读取工作区信息，请重试。')
    await expect(statusLine(page)).not.toContainText('原工作区已删除')
    await expect(statusLine(page)).not.toContainText('未关联工作区')
    // 失败态不渲染绑定操作，也不给空下拉框
    await expect(workspaceSection(page).locator('select')).toHaveCount(0)
    await expect(
      workspaceSection(page).getByRole('button', { name: '重试', exact: true })
    ).toBeVisible()

    // ── 9：恢复数据后点重试 → 正确显示 ───────────────────────
    restoreWorkspaceData(fixture)
    await workspaceSection(page).getByRole('button', { name: '重试', exact: true }).click()
    await expect(statusLine(page)).toHaveText(`已关联：${NAME_A}`)
    await expect(workspaceSection(page).locator('select')).toBeVisible()

    // ── 10：Execution 已开始 → 不提供换绑 / 解绑 ──────────────
    await page.locator('.record-tile--journey', { hasText: TITLE_LOCKED }).click()
    await expect(page.locator('.journey-detail')).toContainText(TITLE_LOCKED)
    await expect(statusLine(page)).toHaveText(`已关联：${NAME_A}`)
    await expect(workspaceSection(page).locator('p.journey-inline__feedback')).toContainText(
      '执行已开始，不能再更改工作区关联。'
    )
    await expect(workspaceSection(page).locator('select')).toHaveCount(0)
    await expect(
      workspaceSection(page).getByRole('button', { name: '换绑', exact: true })
    ).toHaveCount(0)
    await expect(
      workspaceSection(page).getByRole('button', { name: '解除关联', exact: true })
    ).toHaveCount(0)

    // 断言以直接查库收尾：绑定状态真的是库里那两行
    withDb(fixture, (db) => {
      const free = db
        .prepare('select workspace_id from agent_journeys where id = ?')
        .get(J_FREE) as { workspace_id: string | null }
      const locked = db
        .prepare('select workspace_id from agent_journeys where id = ?')
        .get(J_LOCKED) as { workspace_id: string | null }
      expect(free.workspace_id).toBe(WS_A)
      expect(locked.workspace_id).toBe(WS_A)
    })
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
