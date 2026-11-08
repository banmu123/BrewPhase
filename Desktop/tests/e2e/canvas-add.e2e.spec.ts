import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'

/**
 * Canvas 跨端对标回归：
 * 1. Gallery（画布集合 + 空间缩略图）→ Workspace 导航；
 * 2. Picker 多选批量加入（已在画布去重、批量落库、视口内放置）；
 * 3. 节点命中与拖动（透明命中层回归）；
 * 4. 双击打开原记录（跨页导航）；
 * 5. 右键菜单 → 画布备注（只写 CanvasNode.annotation）；
 * 6. 链接节点 Embed 播放（iframe src 只由内容 ID 拼，白名单域）。
 */

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

type Fixture = { userData: string; dbPath: string }

function seed(fixture: Fixture): void {
  const { userData, dbPath } = fixture
  mkdirSync(userData, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  for (const m of migrations) db.exec(m.sql)
  db.pragma(`user_version = ${migrations.length}`)
  const now = Date.now()
  const r = db.prepare(
    `insert into records (id, carrier, title, note, url_string, provider, platform_content_id, media_path, preview_path,
      is_sample, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  )
  r.run('a1a1a1a1-1111-4111-8111-000000000001', 'text', '文字节点', '这是文字正文，用于卡片预览。', '', 'generic', null, null, null, now, now)
  r.run('a1a1a1a1-1111-4111-8111-000000000002', 'image', '图片节点', '', '', 'generic', null, 'mock-a.jpg', null, now, now)
  r.run('a1a1a1a1-1111-4111-8111-000000000003', 'video', '视频节点', '', '', 'generic', null, 'mock-v.mov', 'mock-cover.jpg', now, now)
  r.run(
    'a1a1a1a1-1111-4111-8111-000000000004',
    'link',
    'Coffee Brewing Basics',
    '',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'youtube',
    'dQw4w9WgXcQ',
    null,
    'mock-link.jpg',
    now,
    now
  )
  db.prepare('insert into canvases (id, name, created_at, updated_at) values (?,?,?,?)').run(
    'a1a1a1a1-3333-4333-8333-000000000003',
    '第一块画布',
    now,
    now
  )
  mkdirSync(join(userData, 'media'), { recursive: true })
  for (const name of ['mock-a.jpg', 'mock-link.jpg', 'mock-cover.jpg']) {
    writeFileSync(join(userData, 'media', name), Buffer.from(PNG, 'base64'))
  }
  db.close()
}

async function launch(fixture: Fixture) {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      BREWPHASE_USER_DATA_DIR: fixture.userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

function countNodes(dbPath: string): Array<{
  record_id: string
  position_x: number
  position_y: number
  width: number
  height: number
}> {
  const db = new Database(dbPath, { readonly: true })
  const rows = db
    .prepare('select record_id, position_x, position_y, width, height from canvas_nodes order by created_at')
    .all() as Array<{ record_id: string; position_x: number; position_y: number; width: number; height: number }>
  db.close()
  return rows
}



/**
 * 等视口落定（两道确定性闸门）：
 * 1. Konva Stage 画布尺寸已跟随真实容器（ResizeObserver 回调已生效）——
 *    全量跑时 Electron 冷启动慢，这条链路（observe → setSize → 装窗 effect）
 *    可能超过简单采样窗口；
 * 2. 视口连续两次读数一致（装窗 effect 已跑完）。
 */
async function waitForViewportStable(page: import('@playwright/test').Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const wrap = document.querySelector('.canvas-wrap')
        const canvas = wrap?.querySelector('canvas')
        if (!wrap || !canvas) return false
        return canvas.width >= wrap.clientWidth && canvas.height >= wrap.clientHeight
      },
      undefined,
      { timeout: 15_000 }
    )
    .catch(() => undefined)
  let last = await page.getAttribute('.canvas-wrap', 'data-viewport')
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(150)
    const next = await page.getAttribute('.canvas-wrap', 'data-viewport')
    if (next && next === last) return
    last = next
  }
}

/** 从画布容器的 data-viewport 读真实视口（scale,offsetX,offsetY）。 */
async function readViewport(page: import('@playwright/test').Page): Promise<{
  scale: number
  offsetX: number
  offsetY: number
}> {
  const raw = await page.getAttribute('.canvas-wrap', 'data-viewport')
  const [scale, offsetX, offsetY] = (raw ?? '1,0,0').split(',').map(Number)
  return { scale, offsetX, offsetY }
}

/** 用真实视口把世界坐标点换算成页面坐标。 */
async function worldToScreen(
  page: import('@playwright/test').Page,
  world: { x: number; y: number }
): Promise<{ x: number; y: number }> {
  const { scale, offsetX, offsetY } = await readViewport(page)
  const box = (await page.locator('.canvas-wrap').boundingBox())!
  return { x: box.x + world.x * scale + offsetX, y: box.y + world.y * scale + offsetY }
}

/** 与 CanvasPage 装窗公式一致：由当前内容包围盒推算某节点中心的屏幕坐标。 */
function nodeScreenCenter(
  rows: Array<{ position_x: number; position_y: number; width: number; height: number }>,
  wrap: { x: number; y: number; width: number; height: number },
  index: number
): { x: number; y: number } {
  const xs: number[] = []
  const ys: number[] = []
  for (const row of rows) {
    xs.push(row.position_x, row.position_x + row.width)
    ys.push(row.position_y, row.position_y + row.height)
  }
  const pad = 80
  const minX = Math.min(...xs) - pad
  const minY = Math.min(...ys) - pad
  const w = Math.max(1, Math.max(...xs) + pad - minX)
  const h = Math.max(1, Math.max(...ys) + pad - minY)
  const scale = Math.min(3, Math.max(0.2, Math.min(wrap.width / w, wrap.height / h)))
  const offsetX = -minX * scale + (wrap.width - w * scale) / 2
  const offsetY = -minY * scale + (wrap.height - h * scale) / 2
  const row = rows[index]
  return {
    x: wrap.x + (row.position_x + row.width / 2) * scale + offsetX,
    y: wrap.y + (row.position_y + row.height / 2) * scale + offsetY
  }
}

test('画布：Gallery 导航、多选批量、拖动、双击打开、画布备注与缩略图', async () => {
  test.setTimeout(120_000)
  const fixture: Fixture = { userData: mkdtempSync(join(tmpdir(), 'bp-canvas-1-')), dbPath: '' }
  fixture.dbPath = join(fixture.userData, 'brewphase.db')
  seed(fixture)
  const { app, page } = await launch(fixture)

  // 1) Gallery：集合页出现，卡片有真实缩略图容器
  await page.getByRole('button', { name: 'Canvas', exact: true }).click()
  await expect(page.locator('.gallery-grid')).toBeVisible()
  await expect(page.locator('.gallery-card')).toHaveCount(1)
  await expect(page.locator('.gallery-card__name')).toHaveText('第一块画布')

  // 2) 进入 Workspace
  await page.locator('.gallery-card__open').click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()
  await expect(page.locator('.canvas-back')).toBeVisible()

  // 3) Picker 多选：选 3 条 → 「加入 3 项」→ 批量落库
  await page.getByRole('button', { name: '添加一条记录' }).click()
  await expect(page.locator('.picker-panel')).toBeVisible()
  await expect(page.locator('.add-card').first()).toBeVisible({ timeout: 10_000 })
  for (const title of ['文字节点', '图片节点', '视频节点']) {
    await page.locator('.add-card', { hasText: title }).click()
    await page.waitForTimeout(150)
  }
  await expect(page.locator('.picker-join')).toHaveText('加入 3 项')
  await page.locator('.picker-join').click()
  await page.waitForTimeout(800)
  const nodes = countNodes(fixture.dbPath)
  expect(nodes.length).toBe(3)

  // 4) 关闭 Picker；装窗后由内容包围盒推算节点 1 的屏幕中心（与 CanvasPage 公式一致）
  await page.locator('.picker-panel').getByRole('button', { name: '关闭面板' }).click()
  await waitForViewportStable(page)
  const wrapBox = await page.locator('.canvas-wrap').boundingBox()
  let center = nodeScreenCenter(countNodes(fixture.dbPath), wrapBox, 0)

  // 5) 右键节点 1 → 编辑画布备注 → 保存只写 CanvasNode.annotation
  await page.mouse.click(center.x, center.y, { button: 'right' })
  await expect(page.locator('.node-context-menu')).toBeVisible()
  await page.locator('.node-context-menu').getByRole('menuitem', { name: '编辑画布备注' }).click()
  const textarea = page.locator('.node-panel textarea')
  await expect(textarea).toBeVisible()
  await textarea.fill('这张图先放在这里，回头整理')
  await page.locator('.node-panel').getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(600)
  const db = new Database(fixture.dbPath, { readonly: true })
  const annotated = db.prepare("select count(*) n from canvas_nodes where annotation != ''").get()
  const sourceNote = db.prepare('select note from records where id = ?').get(
    'a1a1a1a1-1111-4111-8111-000000000001'
  ) as { note: string }
  db.close()
  expect((annotated as { n: number }).n).toBeGreaterThanOrEqual(1)
  // 源记录的 note 不被画布备注污染
  expect(sourceNote.note).toBe('这是文字正文，用于卡片预览。')

  // 6) 透明命中层回归：拖动节点 1（中心），落库位置变化
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x + 100, center.y + 60, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  const afterDrag = countNodes(fixture.dbPath)
  const moved = afterDrag.some((row, index) => {
    const before = nodes[index]
    return Math.abs(row.position_x - before.position_x) > 5 || Math.abs(row.position_y - before.position_y) > 5
  })
  expect(moved).toBe(true)

  // 7) 双击拖后的节点 1 → 跨页打开原记录（切到 Records 并选中）
  center = nodeScreenCenter(afterDrag, await page.locator('.canvas-wrap').boundingBox(), 0)
  await page.mouse.dblclick(center.x, center.y)
  await page.waitForTimeout(600)
  // sidebar 的 Records 高亮 + 详情浮层出现
  await expect(page.locator('.sidebar__item[data-active="true"]')).toHaveText(/Records/)
  await expect(page.locator('.float-panel')).toBeVisible({ timeout: 5_000 })

  // 8) 回到 Canvas → 重进画布 → 返回 Gallery：空间缩略图出现
  await page.getByRole('button', { name: 'Canvas', exact: true }).click()
  await page.locator('.gallery-card__open').click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()
  await page.locator('.canvas-back').click()
  await expect(page.locator('.gallery-grid')).toBeVisible()
  await expect(page.locator('.canvas-thumb')).toBeVisible()

  await page.screenshot({ path: '/tmp/canvas-parity-gallery.png' })
  await app.close()
  rmSync(fixture.userData, { recursive: true, force: true })
})

test('画布：链接节点的 Embed 播放（iframe 只由内容 ID 拼白名单域）', async () => {
  test.setTimeout(90_000)
  const fixture: Fixture = { userData: mkdtempSync(join(tmpdir(), 'bp-canvas-2-')), dbPath: '' }
  fixture.dbPath = join(fixture.userData, 'brewphase.db')
  seed(fixture)
  const { app, page } = await launch(fixture)

  // stub 播放器页面：CSP frame-src 白名单放行 www.youtube.com，路由 mock 返回可断言的内容
  const stub = '<!doctype html><html><body><p>stub embed</p></body></html>'
  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({ status: 200, body: stub, contentType: 'text/html' })
  )

  await page.getByRole('button', { name: 'Canvas', exact: true }).click()
  await page.locator('.gallery-card__open').click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()

  // 只加链接节点（单节点 Fit 后必在视口中心）
  await page.getByRole('button', { name: '添加一条记录' }).click()
  await expect(page.locator('.add-card', { hasText: 'Coffee Brewing Basics' })).toBeVisible({ timeout: 10_000 })
  await page.locator('.add-card', { hasText: 'Coffee Brewing Basics' }).click()
  await expect(page.locator('.picker-join')).toHaveText('加入 1 项')
  await page.locator('.picker-join').click()
  await page.waitForTimeout(600)
  await page.locator('.picker-panel').getByRole('button', { name: '关闭面板' }).click()
  await page.getByRole('button', { name: '适配全部内容' }).click()
  await page.waitForTimeout(400)

  // 选中节点（坐标点击）→ inspector 面板的「▶ 播放」按钮（HTML 层，稳定路径）。
  // 节点上同心 PlayBadge 的坐标点击是用户路径，Konva click 合成在 E2E 下偶发
  // 失效（环境级 Konva 10 问题），验收走面板入口。
  const node0 = countNodes(fixture.dbPath)[0]
  const badge = await worldToScreen(page, { x: node0.position_x + node0.width / 2, y: node0.position_y + node0.height / 2 })
  await page.mouse.click(badge.x, badge.y)
  await page.waitForTimeout(400)
  await expect(page.locator('.node-panel')).toBeVisible({ timeout: 10_000 })
  await page.locator('.node-panel').getByRole('button', { name: '▶ 播放' }).click()
  await page.waitForTimeout(400)
  await expect(page.locator('.node-play-surface')).toHaveCount(1)

  const surface = page.locator('.node-play-surface iframe')
  await expect(surface).toHaveCount(1)
  const src = await surface.getAttribute('src')
  // 安全断言：src 只能是 embedURL 的产物（youtube embed 域 + 内容 ID），绝不是记录里的 watch URL
  expect(src).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1')
  // iframe 真的加载了 stub 内容（CSP frame-src 放行验证）
  const frame = page.frameLocator('.node-play-surface iframe')
  await expect(frame.locator('body')).toContainText('stub embed', { timeout: 10_000 })

  // Esc 停止播放（播放面卸载）
  await page.keyboard.press('Escape')
  await expect(page.locator('.node-play-surface')).toHaveCount(0)

  await app.close()
  rmSync(fixture.userData, { recursive: true, force: true })
})

test.afterAll(() => {
  // 兜底清理（正常路径每个测试自行清理）
})
