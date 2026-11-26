import { test, expect, type Page } from '@playwright/test'
import { pinLocale } from './locale'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'
import { encodeArtifactRef } from '../../src/main/application/agent-journey/evidence-artifact-codec'

/**
 * P5.2：单文件 Diff Artifact 的**按需读取**真实界面验收。
 *
 * 真实 Electron + 真实渲染 + 真实 SQLite（fixture 库在测试进程里种子），
 * 主进程的 `agent-journey:evidence:artifact` 通道与 codec 都走生产代码：
 *
 *  1. 打开 Journey → 证据摘要出现，**但 Diff 正文一个字都没加载**
 *  2. 展开执行事件 → 文件行出现，仍然没有正文
 *  3. reported_only 行**没有**读取入口（没有 Workspace Observation）
 *  4. 点击「查看证据」→ 才读取，弹层渲染 unified diff（增/删行着色）
 *  5. 关闭弹层 → 正文离开 DOM；重开走已读缓存
 *  6. 超预算 → 结构化省略原因（绝不渲染成「没有变化」）
 *  7. 不可生成正文 → 明确「不等于没有发生变化」
 *  8. absent 记录 → 「没有可读取的 Artifact」说明、无按钮
 *  9. 切换 Journey → 旧 Diff 不残留（§六.8）
 * 10. 刷新页面重新打开 → 默认仍不自动加载正文
 */

const J_VIEW = 'e2e00000-0000-4000-8000-000000000101'
const J_EMPTY = 'e2e00000-0000-4000-8000-000000000102'
const EVENT_VIEW = 'e2e00000-0000-4000-8000-000000000111'
const EVENT_PLAN_EMPTY = 'e2e00000-0000-4000-8000-000000000112'
const SNAP_START = 'e2e00000-0000-4000-8000-000000000121'
const SNAP_END = 'e2e00000-0000-4000-8000-000000000122'
const FILE_VIEWER = 'e2e00000-0000-4000-8000-000000000131'
const FILE_BIG = 'e2e00000-0000-4000-8000-000000000132'
const FILE_LOCKED = 'e2e00000-0000-4000-8000-000000000133'
const FILE_LEGACY = 'e2e00000-0000-4000-8000-000000000134'

const TITLE_VIEW = '按需 Diff 查看的证据任务'
const TITLE_EMPTY = '切换后的空证据任务'

/** 带有辨识字符串的 unified diff（点击前绝不能出现在 DOM 里）。 */
const DIFF_TEXT = [
  'diff --git a/src/viewer.ts b/src/viewer.ts',
  '--- a/src/viewer.ts',
  '+++ b/src/viewer.ts',
  '@@ -1,2 +1,2 @@',
  '-const old = 1',
  '+const answer = 42'
].join('\n')

type Fixture = { userData: string; dbPath: string }

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
  withDb(fixture, (db) => {
    for (const m of migrations) db.exec(m.sql)
    db.pragma(`user_version = ${migrations.length}`)
    const now = Date.now()

    const insertJourney = db.prepare(
      `insert into agent_journeys (id, title, goal, status, source_client_id, source_agent, model,
         work_context_id, workspace_id, created_at, started_at, updated_at, completed_at,
         capture_mode, schema_version)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?, 'workflow_summary', 1)`
    )
    insertJourney.run(
      J_VIEW,
      TITLE_VIEW,
      '点开才读取 Diff 正文',
      'completed',
      'e2e-client',
      'codex',
      'gpt-5',
      null,
      null,
      now - 2_000,
      now - 1_500,
      now - 500,
      now - 500
    )
    insertJourney.run(
      J_EMPTY,
      TITLE_EMPTY,
      '没有证据的 Journey',
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

    const insertEvent = db.prepare(
      `insert into agent_journey_events (id, journey_id, sequence, event_type, role, status,
         evidence_level, title, summary, content, reason, source_client_id, source_agent, model,
         attempt_id, parent_event_id, idempotency_key, occurred_at, received_at, updated_at, metadata)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    // Agent Reported：只报了 src/reported.ts（工作区没有对应观察行 → reported_only）
    const metadata = JSON.stringify({
      journey_detail_v1: {
        version: 1,
        changes: [
          {
            file_path: 'src/reported.ts',
            change_type: 'modified',
            change_summary: '调整了路由分发逻辑',
            before_behavior: '原先直接返回匹配结果',
            after_behavior: '现在经过缓存层再返回',
            why_this_location: '路由模块拥有所有请求分发的唯一决策权'
          }
        ]
      }
    })
    insertEvent.run(
      EVENT_VIEW,
      J_VIEW,
      1,
      'execution',
      'agent',
      'completed',
      'agent_reported',
      '执行并生成证据',
      '窗口内产生了四个文件的观察结果',
      '',
      '',
      'e2e-client',
      'codex',
      'gpt-5',
      null,
      null,
      'seed-artifact-1',
      now - 1_500,
      now - 1_500,
      now - 500,
      metadata
    )
    insertEvent.run(
      EVENT_PLAN_EMPTY,
      J_EMPTY,
      1,
      'plan',
      'agent',
      'completed',
      'agent_reported',
      '空证据计划',
      '没有工作区观察',
      '',
      '',
      'e2e-client',
      'codex',
      'gpt-5',
      null,
      null,
      'seed-artifact-2',
      now - 900,
      now - 900,
      now - 900,
      null
    )

    const insertSnapshot = db.prepare(
      `insert into journey_workspace_snapshots (id, journey_id, workspace_id, execution_event_id,
         snapshot_type, trigger_key, capture_status, comparison_status, captured_at, head_sha)
       values (?,?,?,?,?,?,?,?,?,?)`
    )
    insertSnapshot.run(SNAP_START, J_VIEW, null, EVENT_VIEW, 'execution_start', 'start:seed', 'ok', 'not_applicable', now - 1_400, 'sha-same')
    insertSnapshot.run(SNAP_END, J_VIEW, null, EVENT_VIEW, 'execution_end', 'end:seed', 'ok', 'complete', now - 600, 'sha-same')

    const insertFile = db.prepare(
      `insert into journey_snapshot_files (id, snapshot_id, repo_relative_path, change_kind,
         status_origin, content_hash_before, content_hash_after, insertions, deletions,
         artifact_ref, observation_status)
       values (?,?,?,?,?,?,?,?,?,?,?)`
    )
    // 1) 真实 diff 正文（点开才读取）
    insertFile.run(
      FILE_VIEWER,
      SNAP_END,
      'src/viewer.ts',
      'modified',
      'worktree',
      'hash-1',
      'hash-2',
      1,
      1,
      encodeArtifactRef({
        kind: 'diff',
        text: DIFF_TEXT,
        insertions: 1,
        deletions: 1,
        byte_size: 0
      }),
      'changed'
    )
    // 2) 超预算（有统计与原因，没有正文）
    insertFile.run(
      FILE_BIG,
      SNAP_END,
      'src/big.ts',
      'modified',
      'worktree',
      'hash-3',
      'hash-4',
      7,
      0,
      encodeArtifactRef({
        kind: 'over_budget',
        reason: 'file_budget',
        insertions: 7,
        deletions: 0
      }),
      'changed'
    )
    // 3) 不可生成正文（≠ 没有变化）
    insertFile.run(
      FILE_LOCKED,
      SNAP_END,
      'src/locked.ts',
      'modified',
      'worktree',
      'hash-5',
      'hash-6',
      2,
      2,
      encodeArtifactRef({
        kind: 'unavailable',
        reason: 'baseline_not_stored',
        insertions: 2,
        deletions: 2
      }),
      'changed'
    )
    // 4) 历史记录：artifact_ref 为 NULL → absent（observation_status 也是历史 NULL）
    insertFile.run(
      FILE_LEGACY,
      SNAP_END,
      'src/legacy.ts',
      'modified',
      'worktree',
      'hash-7',
      'hash-8',
      1,
      0,
      null,
      null
    )
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

/** 进 Records 并打开指定 Journey 详情（与 journey-workspace e2e 同一模式）。 */
async function openJourney(page: Page, title: string): Promise<void> {
  if ((await page.locator('.record-tile--journey').count()) === 0) {
    const entry = page.getByRole('button', { name: '记录', exact: true })
    if ((await entry.count()) === 0) {
      await page.locator('.topbar__brand').first().click()
    }
    await page.getByRole('button', { name: '记录', exact: true }).click()
  }
  const tile = page.locator('.record-tile--journey', { hasText: title })
  await expect(tile).toBeVisible()
  await tile.click()
  await expect(page.locator('.journey-detail')).toBeVisible()
}

function fileRow(page: Page, path: string) {
  return page.locator('.journey-evidence-file', { hasText: path })
}

async function expectNoDiffBody(page: Page): Promise<void> {
  // 默认 / 关闭 / 切换后：正文一个字都不在 DOM 里，也没有弹层
  await expect(page.locator('.journey-diff-modal')).toHaveCount(0)
  await expect(page.locator('.journey-diff-viewer')).toHaveCount(0)
  expect(await page.locator('body').innerText()).not.toContain('+const answer = 42')
}

test('P5.2 Diff Viewer：按需读取、状态区分、切换隔离与刷新不自动加载', async () => {
  test.setTimeout(240_000)

  const root = mkdtempSync(join(tmpdir(), 'bp-journey-artifact-e2e-'))
  const fixture: Fixture = {
    userData: join(root, 'user'),
    dbPath: join(root, 'user', 'brewphase.db')
  }
  seed(fixture)

  const { app, page } = await launch(fixture)
  try {
    // ── 1：打开 Journey → 摘要可见，正文零加载 ───────────────
    await openJourney(page, TITLE_VIEW)
    await expect(page.locator('.journey-event__evidence')).toBeVisible()
    await expect(page.locator('.journey-event__evidence')).toContainText(
      '观察窗口完整，结论可靠'
    )
    await expect(page.locator('.journey-evidence-file')).toHaveCount(0) // 未展开
    await expectNoDiffBody(page)

    // ── 2：展开执行事件 → 文件行出现，仍然没有正文 ────────────
    await page.locator('.journey-event__toggle').first().click()
    await expect(fileRow(page, 'src/viewer.ts')).toBeVisible()
    await expect(fileRow(page, 'src/big.ts')).toBeVisible()
    await expect(fileRow(page, 'src/legacy.ts')).toBeVisible()
    await expectNoDiffBody(page)

    // ── 3：reported_only 没有读取入口（没有 Workspace Observation）──
    const reportedRow = fileRow(page, 'src/reported.ts')
    await expect(reportedRow).toBeVisible()
    await expect(reportedRow.locator('.journey-evidence-file__view')).toHaveCount(0)

    // ── 4：点击才读取 → unified diff 渲染 ─────────────────────
    await fileRow(page, 'src/viewer.ts')
      .locator('.journey-evidence-file__view')
      .click()
    const modal = page.locator('.journey-diff-modal')
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('src/viewer.ts')
    await expect(page.locator('.journey-diff-viewer__line--add')).toContainText(
      '+const answer = 42'
    )
    await expect(page.locator('.journey-diff-viewer__line--del')).toContainText('-const old = 1')

    // ── 5：关闭 → 正文离开 DOM；重开走已读缓存 ────────────────
    await modal.locator('.journey-diff-modal__close').click()
    await expectNoDiffBody(page)
    await fileRow(page, 'src/viewer.ts')
      .locator('.journey-evidence-file__view')
      .click()
    await expect(modal).toBeVisible()
    await expect(page.locator('.journey-diff-viewer')).toContainText('+const answer = 42')
    await modal.locator('.journey-diff-modal__close').click()
    await expect(modal).toHaveCount(0)

    // ── 6：超预算 → 结构化省略原因（绝不渲染成「没有变化」）────
    await fileRow(page, 'src/big.ts').locator('.journey-evidence-file__view').click()
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('单文件超限')
    await expect(modal).toContainText('正文按策略省略，变化统计仍然有效。')
    await expect(modal).toContainText('+7 / −0')
    await expect(modal.locator('.journey-diff-viewer')).toHaveCount(0) // 没有伪造的正文
    await modal.locator('.journey-diff-modal__close').click()

    // ── 7：不可生成正文 → 明确「不等于没有发生变化」────────────
    await fileRow(page, 'src/locked.ts').locator('.journey-evidence-file__view').click()
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('基线内容未留存')
    await expect(modal).toContainText('无法生成 Diff 正文——这不等于没有发生变化。')
    await expect(modal.locator('.journey-diff-viewer')).toHaveCount(0)
    await modal.locator('.journey-diff-modal__close').click()

    // ── 8：absent 记录 → 明确说明、无按钮 ──────────────────────
    const legacyRow = fileRow(page, 'src/legacy.ts')
    await expect(legacyRow.locator('.journey-evidence-file__absent')).toContainText(
      '该记录没有可读取的 Artifact'
    )
    await expect(legacyRow.locator('.journey-evidence-file__view')).toHaveCount(0)

    // ── 9：切换 Journey → 旧 Diff 不残留 ───────────────────────
    await page.locator('.record-tile--journey', { hasText: TITLE_EMPTY }).click()
    await expect(page.locator('.journey-detail')).toContainText(TITLE_EMPTY)
    await expectNoDiffBody(page)

    // ── 10：刷新后重新打开 → 默认仍不自动加载正文 ──────────────
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await openJourney(page, TITLE_VIEW)
    await expect(page.locator('.journey-event__evidence')).toBeVisible()
    await expectNoDiffBody(page)
    // 点开依旧可用（真实通道 + codec 全链路）
    await page.locator('.journey-event__toggle').first().click()
    await fileRow(page, 'src/viewer.ts')
      .locator('.journey-evidence-file__view')
      .click()
    await expect(page.locator('.journey-diff-viewer')).toContainText('+const answer = 42')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
