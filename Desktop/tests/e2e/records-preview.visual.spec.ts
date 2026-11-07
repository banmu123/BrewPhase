import { test, expect, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'

/**
 * Records 平台差异化卡片的视觉验收（§八验收标准）。
 * 默认跳过（依赖外网缩略图），跑法：RECORDS_VISUAL=1 npx playwright test records-preview
 */

test.skip(!process.env.RECORDS_VISUAL, '视觉验收需要 RECORDS_VISUAL=1')

/**
 * 完全隔离：主进程支持 BREWPHASE_USER_DATA_DIR 整体重定向（userData + 媒体），
 * 种子库与真实库（~/Library/...）互不影响，实例锁也各自独立。
 */
const fakeHome = mkdtempSync(join(tmpdir(), 'bp-visual-home-'))
const appData = join(fakeHome, 'BrewPhaseData')
const dbPath = join(appData, 'brewphase.db')

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
  insert.run(
    '11111111-1111-4111-8111-000000000001', 'link', 'banmu123/BrewPhase: Personal coffee studio',
    '', 'https://github.com/banmu123/BrewPhase', 'https://github.com/banmu123/BrewPhase', 'github',
    'banmu123/BrewPhase', 'GitHub', '', 'Local-first coffee studio built with SwiftUI and Electron.',
    null, null, null, 12, 3, 1, 'Swift', 'MIT', now, now
  )
  insert.run(
    '11111111-1111-4111-8111-000000000002', 'link', 'Coffee Brewing Basics - YouTube',
    '', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube',
    'dQw4w9WgXcQ', 'YouTube', 'James Hoffmann', '', null, null, null, null, null, null, null, null, now, now
  )
  insert.run(
    '11111111-1111-4111-8111-000000000003', 'link', '手冲咖啡入门到进阶',
    '', 'https://www.bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili',
    'BV1xx411c7mD', '哔哩哔哩', '咖啡师小张', '从研磨度到水温，一次讲清楚手冲的变量。', null, null, null, null, null, null, null, null, now, now
  )
  insert.run(
    '11111111-1111-4111-8111-000000000004', 'link', '',
    '', 'https://x.com/banmu/status/123', 'https://x.com/banmu/status/123', 'x',
    '123', 'X', '@banmu', '刚烘完一壶耶加雪菲，茉莉花香非常明显，日晒处理法的甜感比水洗高不少。分两次注水，闷蒸 30 秒。',
    null, null, 'https://picsum.photos/seed/brewphase/640/360', null, null, null, null, null, now, now
  )
  insert.run(
    '11111111-1111-4111-8111-000000000005', 'link', 'How to Taste Coffee',
    '', 'https://blog.example.com/how-to-taste-coffee', 'https://blog.example.com/how-to-taste-coffee', 'generic',
    null, 'blog.example.com', '', 'A practical guide to coffee tasting and brewing.', null, null,
    'https://picsum.photos/seed/coffee-blog/640/360', null, null, null, null, null, now, now
  )
  insert.run(
    '11111111-1111-4111-8111-000000000006', 'text', '',
    '这一段是纯文字记录：今天试了 92 度水、15 克粉、1:16 比例，酸质明亮但尾段有点薄，下次试 1:15。',
    '', null, 'generic', null, '', '', '', null, null, null, null, null, null, null, null, now, now
  )
  // 5 个标签 + 关系，让卡片带标签
  for (let index = 0; index < 2; index += 1) {
    db.prepare('insert into record_tags (id, name, created_at) values (?, ?, ?)').run(
      `22222222-2222-4222-8222-00000000000${index + 1}`, index === 0 ? '咖啡' : '开发', now
    )
  }
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
  await page.waitForLoadState('domcontentloaded')

  // 进入记录页
  await page.locator('.sidebar__link', { hasText: '记' }).click().catch(async () => {
    await page.getByText('记录', { exact: true }).first().click()
  })
  await page.waitForSelector('.record-grid', { timeout: 10_000 })
  await page.waitForTimeout(3500) // 等远程缩略图加载
  await page.screenshot({ path: '/tmp/records-preview.png', fullPage: false })
  expect((await page.locator('.record-tile').count())).toBe(6)
  await app.close()
})

test.afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})
