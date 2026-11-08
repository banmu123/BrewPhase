import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'

/**
 * 同步进来的链接 → 后台补全 → 卡片/详情/搜索全部更新（Phase 3.2），全程不重启。
 *
 * 外部请求用 `BREWPHASE_METADATA_FIXTURE=1` 的固定响应（主进程里的抓取器
 * 无法被 `page.route` 拦截），**不依赖真实公网**。
 *
 * 场景：种一条「已同步、派生元数据 pending」的链接（等价于同步落库后应用被关掉），
 * 启动后由启动恢复接管 → 抓取 → 卡片标题出现 → 详情展示预览信息 → 搜索能命中 →
 * 用户写标题后自动标题不再覆盖 → 手动刷新仍然可用。
 */

const userData = mkdtempSync(join(tmpdir(), 'bp-metadata-flow-'))
const dbPath = join(userData, 'brewphase.db')
const RECORD_ID = 'e1e1e1e1-1111-4111-8111-000000000001'
const URL = 'https://github.com/banmu123/BrewPhase'

function seed(): void {
  mkdirSync(userData, { recursive: true })
  const db = new Database(dbPath)
  for (const migration of migrations) db.exec(migration.sql)
  db.pragma(`user_version = ${migrations.length}`)
  const now = Date.now()
  db.prepare(
    `insert into records (id, carrier, title, note, url_string, canonical_url, provider,
      platform_content_id, source_name, author_name, summary, thumbnail_url_string,
      metadata_status, is_sample, created_at, updated_at)
     values (?, 'link', '', '', ?, ?, 'github', 'banmu123/BrewPhase', '', '', '', null,
      'resolved', 0, ?, ?)`
  ).run(RECORD_ID, URL, URL, now, now)
  // 等价于「同步时已入队，但应用在抓取前被关掉」
  db.prepare(
    `insert into record_metadata (record_id, url_string, provider, status, fetched_at)
     values (?, ?, 'github', 'pending', 0)`
  ).run(RECORD_ID, URL)
  db.close()
}

test.beforeAll(() => {
  seed()
})

test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

test('同步链接的元数据补全：卡片/详情/搜索/编辑优先级', async () => {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      BREWPHASE_USER_DATA_DIR: userData,
      BREWPHASE_METADATA_FIXTURE: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.sidebar__link', { hasText: '记' }).click().catch(async () => {
    await page.getByText('记录', { exact: true }).first().click()
  })

  // 1) 启动恢复 → 抓取 → 卡片标题从 pending 变成自动标题（不需要重启/切页）
  await expect(page.locator('.record-tile__title')).toHaveText('banmu123/BrewPhase', { timeout: 20_000 })
  await expect(page.locator('.record-tile .preview-chip')).toContainText('GitHub')

  // 2) 详情：组装后的标题 + 预览信息（仓库/语言/★/Fork/摘要）
  await page.locator('.record-tile').first().click()
  await expect(page.locator('.detail-title')).toHaveText('banmu123/BrewPhase')
  const info = page.locator('.preview-info')
  await expect(info).toBeVisible()
  await expect(info).toContainText('banmu123/BrewPhase')
  await expect(info).toContainText('Swift')
  await expect(info).toContainText('★ 42')
  await expect(info).toContainText('⑂ 7')
  await expect(info).toContainText('Fixture coffee studio')
  // 状态行显示「已更新」
  await expect(page.locator('.record-side')).toContainText('预览信息已更新')

  // 3) 搜索能命中本地派生元数据（标题/描述都不是 records 里的字段）
  await page.locator('.search input').fill('Fixture coffee studio')
  await expect(page.locator('.record-tile')).toHaveCount(1)
  await page.locator('.search input').fill('banmu123/BrewPhase')
  await expect(page.locator('.record-tile')).toHaveCount(1)
  await page.locator('.search input').fill('')

  // 4) 用户写标题：成为记录标题，自动标题不再覆盖它
  await page.locator('.record-tile').first().click()
  const titleInput = page.locator('.record-side .field', { hasText: '标题' }).locator('input')
  await titleInput.fill('我的标题')
  await page.getByRole('button', { name: '保存修改' }).click()
  await expect(page.locator('.record-tile__title')).toHaveText('我的标题')
  await expect(titleInput).toHaveValue('我的标题')
  await expect(page.locator('.detail-title')).toHaveText('我的标题')
  // 本地派生元数据没有被这次保存清掉
  await expect(page.locator('.preview-info')).toContainText('★ 42')

  // 5) 手动刷新：跳过缓存重抓，状态与数据保持
  await page.getByRole('button', { name: '刷新预览' }).click()
  await expect(page.locator('.record-side')).toContainText('预览信息已更新', { timeout: 20_000 })
  await expect(page.locator('.record-tile__title')).toHaveText('我的标题')

  await page.screenshot({ path: '/tmp/records-metadata-flow.png' })
  await app.close()
})
