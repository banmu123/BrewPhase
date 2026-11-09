import { test, expect } from '@playwright/test'
import { pinLocale } from './locale'
import Database from 'better-sqlite3'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  r.run('a1a1a1a1-1111-4111-8111-000000000003', 'video', '视频节点', '', '', 'generic', null, 'sample-video.mp4', 'mock-cover.jpg', now, now)
  r.run(
    'a1a1a1a1-1111-4111-8111-000000000005',
    'link',
    'Bilibili 演示',
    '',
    'https://www.bilibili.com/video/BV1GJ411x7h7',
    'bilibili',
    'BV1GJ411x7h7',
    null,
    null,
    now,
    now
  )
  r.run(
    'a1a1a1a1-1111-4111-8111-000000000006',
    'video',
    'YouTube 视频',
    '',
    'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    'youtube',
    'aaaaaaaaaaa',
    null,
    'mock-cover.jpg',
    now,
    now
  )
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
  // 真实可播放的视频 fixture（ffmpeg 生成，2 秒 320×180）
  copyFileSync(join(__dirname, '..', 'fixtures', 'sample-video.mp4'), join(userData, 'media', 'sample-video.mp4'))
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
  await pinLocale(page)
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

function countNodes(dbPath: string): Array<{
  record_id: string
  title: string
  position_x: number
  position_y: number
  width: number
  height: number
}> {
  const db = new Database(dbPath, { readonly: true })
  const rows = db
    .prepare(
      `select n.record_id, r.title, n.position_x, n.position_y, n.width, n.height
       from canvas_nodes n join records r on r.id = n.record_id
       order by n.created_at`
    )
    .all() as Array<{ record_id: string; title: string; position_x: number; position_y: number; width: number; height: number }>
  db.close()
  return rows
}

/** 按源记录标题定位节点序号（countNodes 按 created_at 排序）。 */
function nodeIndexByTitle(rows: Array<{ title: string }>, title: string): number {
  const index = rows.findIndex((row) => row.title === title)
  if (index < 0) throw new Error(`node with title "${title}" not found`)
  return index
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


/** 点击节点选中并等 inspector 出现；Konva click 合成在 E2E 下偶发失效，带重试。 */
async function selectNodeAt(
  page: import('@playwright/test').Page,
  dbPath: string,
  index: number
): Promise<void> {
  await expect(async () => {
    const rows = countNodes(dbPath)
    // 节点左上角内侧：可播放节点的中心是 PlayBadge（点击=播放而非选中），
    // 左上 18px 内是标题/封面区，任何载体都能安全命中选中。
    const corner = await worldToScreen(page, { x: rows[index].position_x + 18, y: rows[index].position_y + 18 })
    await page.mouse.click(corner.x, corner.y)
    await page.waitForTimeout(300)
    await expect(page.locator('.node-panel')).toBeVisible({ timeout: 400 })
  }).toPass({ timeout: 15_000 })
}

/** 按源记录标题选中节点（面板标题可断言，避免顺序歧义）。 */
async function selectNodeByTitle(
  page: import('@playwright/test').Page,
  dbPath: string,
  title: string
): Promise<void> {
  await selectNodeAt(page, dbPath, nodeIndexByTitle(countNodes(dbPath), title))
  await expect(page.locator('.node-panel')).toContainText(title)
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
  await page.getByRole('button', { name: '画布', exact: true }).click()
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
  await expect(page.locator('.sidebar__item[data-active="true"]')).toHaveText('记录')
  await expect(page.locator('.float-panel')).toBeVisible({ timeout: 5_000 })

  // 8) 回到 Canvas → 重进画布 → 返回 Gallery：空间缩略图出现
  await page.getByRole('button', { name: '画布', exact: true }).click()
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
  await page.route('https://player.bilibili.com/**', (route) =>
    route.fulfill({ status: 200, body: stub, contentType: 'text/html' })
  )

  await page.getByRole('button', { name: '画布', exact: true }).click()
  await page.locator('.gallery-card__open').click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()

  // 只加两条链接节点：YouTube（stub 验证 iframe 加载）+ Bilibili（URL 构造）
  await page.getByRole('button', { name: '添加一条记录' }).click()
  await expect(page.locator('.add-card').first()).toBeVisible({ timeout: 10_000 })
  for (const title of ['Coffee Brewing Basics', 'Bilibili 演示']) {
    await page.locator('.add-card', { hasText: title }).click()
    await page.waitForTimeout(200)
  }
  await page.locator('.picker-join').click()
  await page.waitForTimeout(700)
  await page.locator('.picker-panel').getByRole('button', { name: '关闭面板' }).click()
  await page.getByRole('button', { name: '适配全部内容' }).click()
  await waitForViewportStable(page)

  /**
   * Embed 配对验证（顺序无关）：面板显示哪个标题，iframe src 就必须是那条
   * 记录的 embedURL 产物。两条各验一次——src 只能由内容 ID 拼（安全边界），
   * 绝不是记录里的 watch URL。
   */
  const EXPECTED_SRC: Record<string, string> = {
    'Coffee Brewing Basics': 'https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1',
    'Bilibili 演示': 'https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7&page=1&high_quality=1&danmaku=0'
  }
  for (const title of ['Coffee Brewing Basics', 'Bilibili 演示']) {
    await selectNodeByTitle(page, fixture.dbPath, title)
    await page.locator('.node-panel').getByRole('button', { name: '▶ 播放' }).click()
    const surface = page.locator('.node-play-surface iframe')
    await expect(surface).toHaveCount(1)
    expect(await surface.getAttribute('src')).toBe(EXPECTED_SRC[title])
    await page.keyboard.press('Escape')
    await expect(page.locator('.node-play-surface')).toHaveCount(0)
  }
  // YouTube iframe 真的加载了 stub 内容（CSP frame-src 放行验证）
  await selectNodeByTitle(page, fixture.dbPath, 'Coffee Brewing Basics')
  await page.locator('.node-panel').getByRole('button', { name: '▶ 播放' }).click()
  await expect(page.frameLocator('.node-play-surface iframe').locator('body')).toContainText('stub embed', {
    timeout: 10_000
  })
  await page.keyboard.press('Escape')
  await expect(page.locator('.node-play-surface')).toHaveCount(0)

  await app.close()
  rmSync(fixture.userData, { recursive: true, force: true })
})

test('画布：本地视频真实播放、生命周期单实例与播放器定位', async () => {
  test.setTimeout(120_000)
  const fixture: Fixture = { userData: mkdtempSync(join(tmpdir(), 'bp-canvas-3-')), dbPath: '' }
  fixture.dbPath = join(fixture.userData, 'brewphase.db')
  seed(fixture)
  const { app, page } = await launch(fixture)

  await page.getByRole('button', { name: '画布', exact: true }).click()
  await page.locator('.gallery-card__open').click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()

  // 加入两个可播放节点：本地视频 + YouTube 在线视频（生命周期验证用）
  await page.getByRole('button', { name: '添加一条记录' }).click()
  await expect(page.locator('.add-card').first()).toBeVisible({ timeout: 10_000 })
  for (const title of ['视频节点', 'YouTube 视频']) {
    await page.locator('.add-card', { hasText: title }).click()
    await page.waitForTimeout(200)
  }
  await page.locator('.picker-join').click()
  await page.waitForTimeout(700)
  await page.locator('.picker-panel').getByRole('button', { name: '关闭面板' }).click()
  await waitForViewportStable(page)
  await page.getByRole('button', { name: '适配全部内容' }).click()
  await page.waitForTimeout(400)

  async function playNode(title: string): Promise<void> {
    await selectNodeByTitle(page, fixture.dbPath, title)
    await page.locator('.node-panel').getByRole('button', { name: '▶ 播放' }).click()
    await page.waitForTimeout(400)
  }

  // 1) 本地视频真实播放：<video> 加载 bpmedia 媒体并开始播放
  await playNode('视频节点')
  const video = page.locator('.node-play-surface video')
  await expect(video).toHaveCount(1)
  await expect
    .poll(async () => page.evaluate(() => {
      const element = document.querySelector('.node-play-surface video') as HTMLVideoElement | null
      return element ? { paused: element.paused, time: element.currentTime, ready: element.readyState } : null
    }), { timeout: 10_000 })
    .toEqual(expect.objectContaining({ paused: false, ready: expect.any(Number) } as never))

  // 2) 播放器与节点矩形重合（窗口坐标换算唯一入口验证）
  const rows = countNodes(fixture.dbPath)
  const localRow = rows.find((row) => row.title === '视频节点')!
  const nodeRect = await worldToScreen(page, { x: localRow.position_x, y: localRow.position_y })
  const surfaceBox = await page.locator('.node-play-surface').boundingBox()
  expect(surfaceBox).not.toBeNull()
  expect(Math.abs((surfaceBox?.x ?? 0) - nodeRect.x)).toBeLessThanOrEqual(2)
  expect(Math.abs((surfaceBox?.y ?? 0) - nodeRect.y)).toBeLessThanOrEqual(2)
  expect(Math.abs((surfaceBox?.width ?? 0) - localRow.width * (await readViewport(page)).scale)).toBeLessThanOrEqual(2)

  // 3) 单实例：切到第二个节点播放，第一个播放面被替换
  await playNode('YouTube 视频')
  await expect(page.locator('.node-play-surface iframe')).toHaveCount(1)
  await expect(page.locator('.node-play-surface video')).toHaveCount(0)
  const embedSrc = await page.locator('.node-play-surface iframe').getAttribute('src')
  expect(embedSrc).toBe('https://www.youtube.com/embed/aaaaaaaaaaa?rel=0&playsinline=1')

  // 4) Escape 停止播放
  await page.keyboard.press('Escape')
  await expect(page.locator('.node-play-surface')).toHaveCount(0)

  // 5) 重新播放本地视频 → 返回 Gallery 停止
  await playNode('视频节点')
  await expect(page.locator('.node-play-surface video')).toHaveCount(1)
  await page.locator('.canvas-back').click()
  await expect(page.locator('.gallery-grid')).toBeVisible()
  await expect(page.locator('.node-play-surface')).toHaveCount(0)

  // 6) 再进画布播放 → 切画布停止
  await page.locator('.gallery-card__open').click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()
  await waitForViewportStable(page)
  await playNode('视频节点')
  await expect(page.locator('.node-play-surface video')).toHaveCount(1)
  // 切到第二块画布（先建一块）
  await page.locator('.switcher-trigger').click()
  await page.locator('.switcher-pop').getByRole('button', { name: '新建' }).click()
  await page.locator('.dialog input').fill('第二块')
  await page.locator('.dialog').getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()
  await expect(page.locator('.node-play-surface')).toHaveCount(0)

  await app.close()
  rmSync(fixture.userData, { recursive: true, force: true })
})

test.afterAll(() => {
  // 兜底清理（正常路径每个测试自行清理）
})
