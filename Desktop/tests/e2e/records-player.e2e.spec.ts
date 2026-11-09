import { test, expect } from '@playwright/test'
import { pinLocale } from './locale'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'

/**
 * 详情里的平台播放器（YouTube / B 站）。
 *
 * 播放器是唯一会把第三方页面放进应用窗口的地方，所以这一条从头到尾都在
 * 验证「只放行该放行的」：
 * - 默认不挂 iframe（切记录不发跨域请求）；
 * - 点封面才创建，src 由内容 ID 拼出；
 * - iframe 真的加载成功（CSP 的 frame-src 与主进程的导航拦截不能把它拦死）；
 * - 放大用同一个节点，Esc 能退出；
 * - 内容 ID 不合法的记录没有播放器，只剩「浏览器打开」。
 *
 * 第三方请求全部用 `page.route` mock 掉，不依赖 YouTube / B 站是否可达。
 */

const userData = mkdtempSync(join(tmpdir(), 'bp-player-'))
const dbPath = join(userData, 'brewphase.db')

const YOUTUBE_ID = '11111111-1111-4111-8111-000000000001'
const BILIBILI_ID = '11111111-1111-4111-8111-000000000002'
const BROKEN_ID = '11111111-1111-4111-8111-000000000003'

const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function seed(): void {
  mkdirSync(userData, { recursive: true })
  const db = new Database(dbPath)
  for (const migration of migrations) db.exec(migration.sql)
  db.pragma(`user_version = ${migrations.length}`)

  const base = Date.now()
  const insert = db.prepare(
    `insert into records (id, carrier, title, note, url_string, canonical_url, provider,
      platform_content_id, source_name, author_name, summary, thumbnail_url_string,
      metadata_status, is_sample, created_at, updated_at)
     values (?, 'link', ?, '', ?, ?, ?, ?, ?, ?, '', null, 'resolved', 0, ?, ?)`
  )
  // createdAt 决定列表顺序（desc），YouTube 放最前，页面一打开就是它被选中。
  insert.run(
    YOUTUBE_ID, 'Coffee Brewing Basics', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ', 'YouTube', 'James Hoffmann',
    base + 2000, base + 2000
  )
  insert.run(
    BILIBILI_ID, '手冲咖啡入门到进阶', 'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili', 'BV1xx411c7mD', '哔哩哔哩', '咖啡师小张',
    base + 1000, base + 1000
  )
  // 内容 ID 不是合法视频 ID：能保存、能外部打开，但不该出现播放器。
  insert.run(
    BROKEN_ID, 'Broken video id', 'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/watch?v=abc', 'youtube', 'abc', 'YouTube', '',
    base, base
  )
  db.close()
}

test.beforeAll(() => {
  seed()
})

test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

test('详情里的播放器：按内容 ID 播放、放大、非法 ID 不出现', async () => {
  // 拉起 Electron + 走完四次记录切换，比其它用例多一步 iframe 加载；
  // 全量跑时机器负载更高，给足余量而不是靠 40s 的默认超时赌。
  test.setTimeout(60_000)
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      BREWPHASE_USER_DATA_DIR: userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
  })
  const page = await app.firstWindow()
  await pinLocale(page)

  const stub = '<!doctype html><html><body><p>stub player</p></body></html>'
  await page.route('https://i.ytimg.com/**', (route) =>
    route.fulfill({ status: 200, body: MOCK_PNG, contentType: 'image/png' })
  )
  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({ status: 200, body: stub, contentType: 'text/html' })
  )
  await page.route('https://player.bilibili.com/**', (route) =>
    route.fulfill({ status: 200, body: stub, contentType: 'text/html' })
  )

  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: '记录', exact: true }).click()
  await expect(page.locator('.record-tile')).toHaveCount(3)

  // 1) 点卡片打开详情浮层；默认只显示封面：没有 iframe，点一下才创建
  await page.locator('.record-tile', { hasText: 'Coffee Brewing Basics' }).click()
  await expect(page.locator('.detail-title')).toHaveText('Coffee Brewing Basics')
  await expect(page.locator('.link-player')).toBeVisible()
  await expect(page.locator('.link-player__frame')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/records-player-cover.png' })
  await page.locator('.link-player__cover').click()

  const youtubeFrame = page.locator('.link-player__frame')
  await expect(youtubeFrame).toHaveCount(1)
  await expect(youtubeFrame).toHaveAttribute(
    'src',
    'https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1'
  )
  // 真的加载进来了：CSP 的 frame-src 与主进程的导航拦截都没把它拦死
  await expect(page.frameLocator('.link-player__frame').locator('body')).toContainText('stub player')
  await page.screenshot({ path: '/tmp/records-player-inline.png' })

  // 2) 放大：同一个节点铺满窗口，iframe 不重挂
  await page.getByRole('button', { name: '放大' }).click()
  await expect(page.locator('.link-player--zoomed')).toHaveCount(1)
  await expect(youtubeFrame).toHaveCount(1)
  await page.screenshot({ path: '/tmp/records-player-zoomed.png' })
  await page.keyboard.press('Escape')
  await expect(page.locator('.link-player--zoomed')).toHaveCount(0)
  await expect(youtubeFrame).toHaveCount(1)

  // 3) 切到 B 站：组件按记录重建，不继承上一条的播放态
  await page.locator('.record-tile', { hasText: '手冲咖啡入门到进阶' }).click()
  await expect(page.locator('.detail-title')).toHaveText('手冲咖啡入门到进阶')
  await expect(page.locator('.link-player__frame')).toHaveCount(0)
  await page.locator('.link-player__cover').click()
  await expect(page.locator('.link-player__frame')).toHaveAttribute(
    'src',
    /player\.bilibili\.com\/player\.html\?bvid=BV1xx411c7mD/
  )

  // 4) 非法内容 ID：没有播放器，但记录本身照常可看
  await page.locator('.record-tile', { hasText: 'Broken video id' }).click()
  await expect(page.locator('.detail-title')).toHaveText('Broken video id')
  await expect(page.locator('.link-player')).toHaveCount(0)

  await page.screenshot({ path: '/tmp/records-player.png' })
  await app.close()
})
