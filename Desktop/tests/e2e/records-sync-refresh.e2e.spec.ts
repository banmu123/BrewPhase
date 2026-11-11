import { test, expect, type ElectronApplication } from '@playwright/test'
import { pinLocale } from './locale'
import { openSpace } from './nav'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'

/**
 * 手机同步后 Records 页面自动刷新（不切页、不手动点、不重启）。
 *
 * 分层：服务端的「什么时候广播」由 `tests/unit/sync.test.ts` 的真实 HTTP
 * 用例锁死；这里验证 renderer 收到 `sync:changed` 之后的行为——
 * 重查列表、保留筛选与选中、媒体落盘后重新请求图片、连续事件不重复渲染。
 *
 * 写库走 renderer 自己的 `records.create/remove`（就是主进程那条写入路径），
 * 广播由主进程发，和 SyncServer 在生产里的动作一致；媒体文件直接写进
 * `userData/media`，等价于 `finalize` 把文件从 .part 挪到位。
 */

const userData = mkdtempSync(join(tmpdir(), 'bp-sync-refresh-'))
const dbPath = join(userData, 'brewphase.db')
const mediaDir = join(userData, 'media')

const TEXT_ID = 'bbbbbbbb-1111-4111-8111-000000000001'
const IMAGE_ID = 'bbbbbbbb-1111-4111-8111-000000000002'
const LINK_ID = 'bbbbbbbb-1111-4111-8111-000000000003'
const IMAGE_FILE = 'syncphoto-1111-4111-8111-000000000002.jpg'

/** 1×1 红色 PNG：媒体落盘后能真的解码出尺寸。 */
const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function seed(): void {
  mkdirSync(userData, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  for (const migration of migrations) db.exec(migration.sql)
  db.pragma(`user_version = ${migrations.length}`)

  const base = Date.now()
  const insert = db.prepare(
    `insert into records (id, carrier, title, note, url_string, canonical_url, provider,
      platform_content_id, source_name, author_name, summary, media_path, preview_path,
      thumbnail_url_string, metadata_status, is_sample, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 'idle', 0, ?, ?)`
  )
  // createdAt 决定列表顺序（desc）
  insert.run(TEXT_ID, 'text', '早上的手冲', '15g / 240ml / 92℃', '', null, 'generic', null, '', '', '', null, null, base + 2000, base + 2000)
  // 记录先到、文件后到：这就是同步时图片记录的真实中间态
  insert.run(IMAGE_ID, 'image', '手机拍的图', '', '', null, 'generic', null, '', '', '', IMAGE_FILE, null, base + 1000, base + 1000)
  insert.run(LINK_ID, 'link', 'banmu123/BrewPhase', '', 'https://github.com/banmu123/BrewPhase',
    'https://github.com/banmu123/BrewPhase', 'github', 'banmu123/BrewPhase', 'GitHub', '', '', null, null, base, base)
  db.close()
}

/** 主进程广播一次 `sync:changed`——生产里由 SyncServer 的 onChanged 触发。 */
async function broadcast(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('sync:changed')
    }
  })
}

test.beforeAll(() => {
  seed()
})

test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

test('手机同步写库后，Records 一直开着也能自动更新', async () => {
  test.setTimeout(90_000)
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
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: '记录', exact: true }).click()
  await expect(page.locator('.record-tile')).toHaveCount(3)

  // 先选中第一条：后面的写入不能把用户正在看的详情顶掉
  await page.locator('.record-tile', { hasText: '早上的手冲' }).click()
  await expect(page.locator('.detail-title')).toHaveText('早上的手冲')

  // ── 场景 A：新增记录自动出现，选中不被抢 ─────────────────────────
  await page.evaluate(async () => {
    await (window as any).brewphase.records.create({
        carrier: 'text', title: '同步来的文字', note: '来自 iPhone', urlString: '',
        canonicalURL: null, platformContentID: null, provider: 'generic',
        sourceName: '', authorName: '', summary: '', mediaPath: null, previewPath: null, tagIds: []
      })
  })
  await broadcast(app)
  await expect(page.locator('.record-tile')).toHaveCount(4)
  await expect(page.locator('.record-tile', { hasText: '同步来的文字' })).toHaveCount(1)
  // 用户选中的还是原来那条
  await expect(page.locator('.detail-title')).toHaveText('早上的手冲')

  // ── 场景 D：搜索条件在刷新后保留，新命中项按当前筛选出现 ──────────
  await page.locator('.search input').fill('手冲')
  await expect(page.locator('.record-tile')).toHaveCount(1)
  await page.evaluate(async () => {
    await (window as any).brewphase.records.create({
        carrier: 'text', title: '第二杯手冲', note: '同步来的', urlString: '',
        canonicalURL: null, platformContentID: null, provider: 'generic',
        sourceName: '', authorName: '', summary: '', mediaPath: null, previewPath: null, tagIds: []
      })
  })
  await broadcast(app)
  await expect(page.locator('.record-tile')).toHaveCount(2)
  await expect(page.locator('.search input')).toHaveValue('手冲')
  await page.locator('.search input').fill('')
  await expect(page.locator('.record-tile')).toHaveCount(5)

  // ── 场景 C：媒体文件后到，图片不用切页就会自己显示出来 ────────────
  await page.locator('.record-tile', { hasText: '手机拍的图' }).click()
  await expect(page.locator('.detail-title')).toHaveText('手机拍的图')
  const tileImage = page.locator('.record-tile', { hasText: '手机拍的图' }).locator('img')
  await expect(tileImage).toHaveCount(1)
  // 文件还没到：破图（naturalWidth 为 0）
  await expect
    .poll(async () => tileImage.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBe(0)

  mkdirSync(mediaDir, { recursive: true })
  writeFileSync(join(mediaDir, IMAGE_FILE), MOCK_PNG)
  await broadcast(app)
  // 只有 URL 跟着媒体版本变，浏览器才会重新请求这张图
  await expect
    .poll(async () => tileImage.evaluate((img) => (img as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0)

  // ── 场景 E：选中的记录被手机删掉，详情不留在已删除的记录上 ────────
  await page.evaluate(async (id) => {
    await (window as any).brewphase.records.remove(id)
  }, IMAGE_ID)
  await broadcast(app)
  await expect(page.locator('.record-tile')).toHaveCount(4)
  await expect(page.locator('.record-tile', { hasText: '手机拍的图' })).toHaveCount(0)
  // 选中的记录没了：详情浮层随之关闭，不再显示已删除的记录
  await expect(page.locator('.float-panel')).toHaveCount(0)

  // ── 连续事件：一次同步的多条广播不造成重复内容 ────────────────────
  for (let index = 0; index < 5; index += 1) await broadcast(app)
  await expect(page.locator('.record-tile')).toHaveCount(4)
  const titles = await page.locator('.record-tile__title').allTextContents()
  expect(new Set(titles).size).toBe(titles.length)

  // ── 离开页面后广播不再触发查询：切回来数据仍然正确 ────────────────
  await openSpace(page, '咖啡')
  await broadcast(app)
  await openSpace(page, '记录')
  await expect(page.locator('.record-tile')).toHaveCount(4)

  await page.screenshot({ path: '/tmp/records-sync-refresh.png' })
  await app.close()
})
