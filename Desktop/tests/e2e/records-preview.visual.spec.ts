import { test, expect } from '@playwright/test'
import { pinLocale } from './locale'
import { openSpace } from './nav'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'

/**
 * Records 平台差异化卡片的视觉验收（§八验收标准 + 第二轮加强）。
 *
 * - 全程用 `BREWPHASE_USER_DATA_DIR` 重定向库与媒体目录，**绝不触碰真实库**；
 * - 缩略图走 `https://mock.test/**` 与 `https://i.ytimg.com/**` 的本地 mock，
 *   不依赖第三方网站是否在线；
 * - 断言图片真实加载（naturalWidth）、平台标识、fallback 与元信息行，
 *   而不是只数卡片数量。
 *
 * 跑法：RECORDS_VISUAL=1 npx playwright test records-preview
 */

test.skip(!process.env.RECORDS_VISUAL, '视觉验收需要 RECORDS_VISUAL=1')

const fakeHome = mkdtempSync(join(tmpdir(), 'bp-visual-home-'))
const appData = join(fakeHome, 'BrewPhaseData')
const dbPath = join(appData, 'brewphase.db')

/** 1×1 红色 PNG（mock 缩略图响应体）。 */
const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function seed(): void {
  mkdirSync(appData, { recursive: true })
  const db = new Database(dbPath)
  for (const migration of migrations) db.exec(migration.sql)
  db.pragma('user_version = 4')
  const now = Date.now()
  const insert = db.prepare(
    `insert into records (id, carrier, title, note, url_string, canonical_url, provider,
      platform_content_id, source_name, author_name, summary, media_path, preview_path,
      thumbnail_url_string, metadata_status, repository_stars, repository_forks,
      repository_issues, repository_language, repository_license, is_sample, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, 0, ?, ?)`
  )
  // 1. GitHub + og 图 → remote-image + 仓库信息条
  insert.run(
    '11111111-1111-4111-8111-000000000001', 'link', 'banmu123/BrewPhase: Personal coffee studio',
    '', 'https://github.com/banmu123/BrewPhase', 'https://github.com/banmu123/BrewPhase', 'github',
    'banmu123/BrewPhase', 'GitHub', '', 'Local-first coffee studio built with SwiftUI and Electron.',
    null, null, 'https://mock.test/github.png', 12, 3, 1, 'Swift', 'MIT', now, now
  )
  // 2. GitHub 无 og 图 → repo-card fallback
  insert.run(
    '11111111-1111-4111-8111-000000000007', 'link', 'banmu123/notes: reading log',
    '', 'https://github.com/banmu123/notes', 'https://github.com/banmu123/notes', 'github',
    'banmu123/notes', 'GitHub', '', 'Reading notes and clippings.', null, null, null,
    null, null, null, null, null, now, now
  )
  // 3. YouTube 无 og → 官方 i.ytimg.com 构造（测试里 mock 掉）
  insert.run(
    '11111111-1111-4111-8111-000000000002', 'link', 'Coffee Brewing Basics - YouTube',
    '', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube',
    'dQw4w9WgXcQ', 'YouTube', 'James Hoffmann', '', null, null, null, null, null, null, null, null, now, now
  )
  // 4. Bilibili + og 图 → remote-image + UP 主进元信息行
  insert.run(
    '11111111-1111-4111-8111-000000000003', 'link', '手冲咖啡入门到进阶',
    '', 'https://www.bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili',
    'BV1xx411c7mD', '哔哩哔哩', '咖啡师小张', '从研磨度到水温，一次讲清楚手冲的变量。', null, null,
    'https://mock.test/bilibili.png', null, null, null, null, null, now, now
  )
  // 5. X 动态：作者 + 正文 + mock 媒体
  insert.run(
    '11111111-1111-4111-8111-000000000004', 'link', '',
    '', 'https://x.com/banmu/status/123', 'https://x.com/banmu/status/123', 'x',
    '123', 'X', '@banmu', '刚烘完一壶耶加雪菲，茉莉花香非常明显，日晒处理法的甜感比水洗高不少。',
    null, null, 'https://mock.test/x.png', null, null, null, null, null, now, now
  )
  // 6. 网页无图 → 平台 fallback（域名 + fallback 卡）
  insert.run(
    '11111111-1111-4111-8111-000000000005', 'link', 'How to Taste Coffee',
    '', 'https://blog.example.com/how-to-taste-coffee', 'https://blog.example.com/how-to-taste-coffee', 'generic',
    null, 'blog.example.com', '', 'A practical guide to coffee tasting and brewing.', null, null,
    null, null, null, null, null, null, now, now
  )
  // 7. 文字记录
  insert.run(
    '11111111-1111-4111-8111-000000000006', 'text', '',
    '这一段是纯文字记录：今天试了 92 度水、15 克粉、1:16 比例，酸质明亮但尾段有点薄。',
    '', null, 'generic', null, '', '', '', null, null, null, null, null, null, null, null, now, now
  )
  db.close()
}

test('Records 平台差异化卡片视觉验收', async () => {
  seed()
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      BREWPHASE_USER_DATA_DIR: appData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
  })
  const page = await app.firstWindow()
  await pinLocale(page)

  // mock 远程缩略图：og 图与 YouTube 官方缩略图都不依赖真实网络
  await page.route('https://mock.test/**', (route) => route.fulfill({ status: 200, body: MOCK_PNG, contentType: 'image/png' }))
  await page.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, body: MOCK_PNG, contentType: 'image/png' }))

  await page.waitForLoadState('domcontentloaded')
  await openSpace(page, '记录')
  await page.waitForSelector('.record-grid', { timeout: 10_000 })
  await page.waitForTimeout(2500)

  // 卡片齐全（7 条种子全部渲染）
  expect(await page.locator('.record-tile').count()).toBe(7)

  // 平台标识：GitHub / YouTube / 哔哩哔哩 / X / 网页域名
  const chips = await page.locator('.preview-chip').allTextContents()
  expect(chips.join('|')).toContain('GitHub')
  expect(chips.join('|')).toContain('YouTube')
  expect(chips.join('|')).toContain('哔哩哔哩')
  expect(chips.join('|')).toContain('X')
  expect(chips.join('|')).toContain('blog.example.com')

  // 所有远程缩略图真实加载成功（naturalWidth > 0）
  const loaded = await page.$$eval('img.preview-thumb', (imgs) =>
    imgs.map((img) => (img as HTMLImageElement).naturalWidth > 0)
  )
  expect(loaded.length).toBeGreaterThanOrEqual(4)
  expect(loaded.every(Boolean)).toBe(true)

  // GitHub og 卡：仓库信息条保留仓库名与统计
  const repoBar = page.locator('.preview-repo__bar', { hasText: 'banmu123/BrewPhase' })
  await expect(repoBar).toHaveCount(1)
  await expect(repoBar).toContainText('Swift')
  await expect(repoBar).toContainText('12')

  // GitHub 无 og 卡：仓库信息卡 fallback
  await expect(page.locator('.preview-repo__id', { hasText: 'banmu123/notes' })).toHaveCount(1)

  // Bilibili og 卡加载 mock 图，且 UP 主进元信息行
  await expect(page.locator('.record-tile__meta', { hasText: '咖啡师小张' })).toHaveCount(1)

  // YouTube 卡元信息行带频道名
  await expect(page.locator('.record-tile__meta', { hasText: 'James Hoffmann' })).toHaveCount(1)

  // X 卡：作者行与正文
  await expect(page.locator('.preview-x__name', { hasText: '@banmu' })).toHaveCount(1)
  await expect(page.locator('.preview-x__body', { hasText: '耶加雪菲' })).toHaveCount(1)

  // 网页无图：平台 fallback 而不是空白/破图
  await expect(page.locator('.preview-fallback__label', { hasText: 'blog.example.com' })).toHaveCount(1)

  // 视频卡播放钮存在（YouTube + Bilibili）
  await expect(page.locator('.preview-play')).toHaveCount(2)

  await page.screenshot({ path: '/tmp/records-preview.png', fullPage: false })
  await app.close()
})

test.afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})
