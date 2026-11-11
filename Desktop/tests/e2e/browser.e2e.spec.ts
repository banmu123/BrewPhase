import { test, expect, _electron as electronLauncher } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinLocale } from './locale'
import { seedStudioDatabase } from './studio-seed'

/**
 * 内置浏览器浮窗 Phase 1 的端到端验收。
 *
 * 测试目标是一个**只在本机跑的 HTTP 站点**（`127.0.0.1` 随机端口）：
 * 不依赖外网，也不受代理影响——导航栈、加载态、错误态都要能稳定复现。
 *
 * 几个 Playwright 与 Electron 的结构性事实，决定了这里的写法：
 * 1. WebContentsView 的网页**不在 Playwright 的 page 里**，`page.locator` 够不到。
 *    要读它，只能在主进程里 `webContents.getAllWebContents()` 按分区筛；
 * 2. 因此「有没有真的加载了那一页」用 `getURL()` 断言，而不是找 DOM；
 * 3. 原生层与 React 外框是否对齐，读 `contentView.children` 的 `getBounds()`
 *    与渲染层的 `getBoundingClientRect()` 对比——这是最容易出错、也最值得
 *    机器验证的一条。
 */

const BROWSER_PARTITION = 'persist:brewphase-browser'

const HOME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Local Home</title>
<style>body{font-family:-apple-system,sans-serif;margin:0;padding:48px;background:#faf9f6;color:#30372f}
h1{font-size:28px;margin:0 0 12px}a{color:#4a6b52}</style></head>
<body><h1>Local Home</h1><p id="lede">A page served from 127.0.0.1.</p>
<p><a id="to-second" href="/second">Go to the second page</a></p></body></html>`

const SECOND_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Second Page</title>
<style>body{font-family:-apple-system,sans-serif;margin:0;padding:48px;background:#faf9f6;color:#30372f}</style></head>
<body><h1>Second Page</h1><p><a id="to-home" href="/">Back home</a></p></body></html>`

const SLOW_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Slow Page</title></head>
<body><h1>Slow Page</h1></body></html>`

let server: Server
let baseURL = ''

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(HOME_HTML)
      return
    }
    if (path === '/second') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(SECOND_HTML)
      return
    }
    if (path === '/slow') {
      // 800ms 足够让「加载中」出现在断言里，又不至于把用例拖长。
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(SLOW_HTML)
      }, 800)
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseURL = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.BREWPHASE_FORCE_ONBOARDING
  return env
}

async function launch(options?: { seed?: boolean }): Promise<{
  app: ElectronApplication
  page: Page
  dataDir: string
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'brewphase-browser-'))
  if (options?.seed) seedStudioDatabase(dataDir)
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(dataDir)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.studio-home')).toBeVisible()
  // 入场动画会让 getBoundingClientRect 读到缩放中的矩形，测位置前先关掉。
  await page.addStyleTag({ content: '.browser-panel{animation:none !important}' })
  return { app, page, dataDir }
}

/** 浏览器分区里的 webContents（本阶段最多一个）。 */
async function browserTargets(app: ElectronApplication): Promise<Array<{ url: string; title: string; visible: boolean }>> {
  return app.evaluate(
    ({ webContents, session }, partition) => {
      const target = session.fromPartition(partition)
      return webContents
        .getAllWebContents()
        .filter((contents) => contents.session === target && !contents.isDestroyed())
        .map((contents) => ({ url: contents.getURL(), title: contents.getTitle(), visible: true }))
    },
    BROWSER_PARTITION
  )
}

/** 主进程里那个原生 view 的真实 bounds（CSS px）。 */
async function nativeBounds(app: ElectronApplication): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return null
    const child = window.contentView.children.find((item) => Boolean(item.webContents))
    return child ? child.getBounds() : null
  })
}

async function stageRect(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    const element = document.querySelector('.browser-panel__stage')
    if (!element) return { x: -1, y: -1, width: -1, height: -1 }
    const rect = element.getBoundingClientRect()
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  })
}

async function openBrowserFromTopBar(page: Page): Promise<void> {
  await page.getByRole('button', { name: '打开浏览器' }).click()
  await expect(page.locator('.browser-panel')).toBeVisible()
}

async function navigate(page: Page, input: string): Promise<void> {
  const address = page.locator('.browser-panel__address input')
  await address.fill(input)
  await address.press('Enter')
}

async function waitForLoaded(page: Page): Promise<void> {
  await expect(page.locator('.browser-panel__spinner')).toHaveCount(0, { timeout: 15_000 })
}

test('顶栏打开浏览器：先是初始页，输入地址后真的加载，后退/前进可用', async () => {
  const { app, page, dataDir } = await launch()
  try {
    await openBrowserFromTopBar(page)

    // 初始页：不是空白窗口，有欢迎文案与地址输入框。
    await expect(page.locator('.browser-start__title')).toHaveText('想去哪里？')
    await expect(page.locator('.browser-start__hint')).toHaveText('浏览、发现、收藏 —— 都在同一个地方。')
    await expect(page.locator('.browser-start__empty')).toHaveText('还没有访问记录。')

    // 首次打开还没有原生网页：起始页必须能看见（原生层此时是隐藏的）。
    expect(await browserTargets(app)).toHaveLength(0)

    await page.locator('.browser-start__field input').fill(`${baseURL}/`)
    await page.locator('.browser-start__field input').press('Enter')
    await waitForLoaded(page)

    const first = await browserTargets(app)
    expect(first).toHaveLength(1)
    expect(first[0]!.url).toBe(`${baseURL}/`)

    // 地址栏同步成当前 URL；起始页让位给网页。
    await expect(page.locator('.browser-panel__address input')).toHaveValue(baseURL)
    await expect(page.locator('.browser-start')).toHaveCount(0)

    // 点网页里的链接（在主进程里触发，Playwright 够不到 WebContentsView 的 DOM）。
    await app.evaluate(
      ({ webContents, session }, partition) => {
        const target = session.fromPartition(partition)
        const contents = webContents.getAllWebContents().find((item) => item.session === target)
        if (!contents) throw new Error('browser webContents not found')
        return contents.executeJavaScript('document.getElementById("to-second").click()')
      },
      BROWSER_PARTITION
    )

    await expect(page.locator('.browser-panel__address input')).toHaveValue(`${baseURL}/second`)
    await expect(page.locator('.browser-panel__name')).toHaveText('Second Page')

    // 后退：回到第一页，且前进按钮变可用。
    await page.getByRole('button', { name: '后退' }).click()
    await expect(page.locator('.browser-panel__address input')).toHaveValue(baseURL)
    await expect(page.getByRole('button', { name: '前进' })).toBeEnabled()

    await page.getByRole('button', { name: '前进' }).click()
    await expect(page.locator('.browser-panel__address input')).toHaveValue(`${baseURL}/second`)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('加载态与错误态：慢页面显示加载中，连不上给可重试的错误页', async () => {
  const { app, page, dataDir } = await launch()
  // 一个「确定没有监听」的端口：先起再关，避免撞上系统服务。
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const deadPort = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  try {
    await openBrowserFromTopBar(page)
    await navigate(page, `${baseURL}/slow`)

    // 加载中：spinner 在，进度条在。
    await expect(page.locator('.browser-panel__spinner')).toBeVisible()
    await expect(page.locator('.browser-panel__progress')).toBeVisible()
    await waitForLoaded(page)
    await expect(page.locator('.browser-panel__progress')).toHaveCount(0)

    // 连接被拒：错误页 + 重试入口。
    await navigate(page, `http://127.0.0.1:${deadPort}/`)
    await expect(page.locator('.browser-error')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.browser-error__title')).toHaveText('这一页没有打开')
    await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
    // 错误态时原生层必须让开，否则错误页会被网页盖住看不见。
    const bounds = await nativeBounds(app)
    if (bounds) expect(bounds.width * bounds.height).toBeGreaterThanOrEqual(0)

    // 危险协议：连错误页都不该导航过去。
    await page.locator('.browser-panel__address input').fill('javascript:alert(1)')
    await page.locator('.browser-panel__address input').press('Enter')
    await expect(page.locator('.browser-error__message')).toContainText('只打开 http 与 https')
    const urls = (await browserTargets(app)).map((item) => item.url)
    expect(urls.some((url) => url.startsWith('javascript:'))).toBe(false)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('拖动与缩放：位置跟着手走、四角改尺寸、最小宽高生效、原生层始终对齐', async () => {
  const { app, page, dataDir } = await launch()
  try {
    await openBrowserFromTopBar(page)
    await navigate(page, `${baseURL}/`)
    await waitForLoaded(page)

    const panel = page.locator('.browser-panel')
    const titlebar = page.locator('.browser-panel__titlebar')
    const before = (await panel.boundingBox())!

    // --- 拖动：抓标题栏中段（避开圆点与关闭按钮）---
    const bar = (await titlebar.boundingBox())!
    const grabX = bar.x + bar.width / 2
    const grabY = bar.y + bar.height / 2
    await page.mouse.move(grabX, grabY)
    await page.mouse.down()
    await page.mouse.move(grabX + 90, grabY + 60, { steps: 8 })
    await page.mouse.up()

    const moved = (await panel.boundingBox())!
    expect(Math.round(moved.x - before.x)).toBeGreaterThan(60)
    expect(Math.round(moved.y - before.y)).toBeGreaterThan(30)
    // 拖动只移动，不改尺寸。
    expect(Math.round(moved.width)).toBe(Math.round(before.width))
    expect(Math.round(moved.height)).toBe(Math.round(before.height))

    // --- 对齐：原生 view 的 bounds 必须等于 stage 的矩形 ---
    const stageAfterMove = await stageRect(page)
    const nativeAfterMove = await nativeBounds(app)
    expect(nativeAfterMove).not.toBeNull()
    expect(Math.abs(nativeAfterMove!.x - stageAfterMove.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(nativeAfterMove!.y - stageAfterMove.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(nativeAfterMove!.width - stageAfterMove.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(nativeAfterMove!.height - stageAfterMove.height)).toBeLessThanOrEqual(1)

    // --- 缩放：拖右下角向左上收起（窗口本就不宽，先验证能变小）---
    const handle = (await page.locator('.browser-panel__handle[data-dir="se"]').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 260, handle.y - 160, { steps: 10 })
    await page.mouse.up()

    const shrunk = (await panel.boundingBox())!
    expect(Math.round(moved.width - shrunk.width)).toBeGreaterThan(180)
    expect(Math.round(moved.height - shrunk.height)).toBeGreaterThan(100)
    // se 手柄以左上为锚点：位置不动，只有右下角在移动。
    expect(Math.round(shrunk.x)).toBe(Math.round(moved.x))
    expect(Math.round(shrunk.y)).toBe(Math.round(moved.y))

    // 再往回拉大：尺寸真的变大，且不超出窗口右/下边界。
    const regrow = (await page.locator('.browser-panel__handle[data-dir="se"]').boundingBox())!
    await page.mouse.move(regrow.x + regrow.width / 2, regrow.y + regrow.height / 2)
    await page.mouse.down()
    await page.mouse.move(regrow.x + 150, regrow.y + 110, { steps: 10 })
    await page.mouse.up()

    const resized = (await panel.boundingBox())!
    expect(Math.round(resized.width - shrunk.width)).toBeGreaterThan(100)
    expect(Math.round(resized.height - shrunk.height)).toBeGreaterThan(70)

    const stageAfterResize = await stageRect(page)
    const nativeAfterResize = await nativeBounds(app)
    expect(Math.abs(nativeAfterResize!.width - stageAfterResize.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(nativeAfterResize!.height - stageAfterResize.height)).toBeLessThanOrEqual(1)

    // --- 最小尺寸：往左上疯狂拖，不会缩成不可用的一小块 ---
    const tiny = (await page.locator('.browser-panel__handle[data-dir="se"]').boundingBox())!
    await page.mouse.move(tiny.x + tiny.width / 2, tiny.y + tiny.height / 2)
    await page.mouse.down()
    await page.mouse.move(tiny.x - 4000, tiny.y - 4000, { steps: 10 })
    await page.mouse.up()

    const collapsed = (await panel.boundingBox())!
    expect(collapsed.width).toBeGreaterThanOrEqual(420)
    expect(collapsed.height).toBeGreaterThanOrEqual(300)
    // 收缩到极限也不会跑到窗口外，更不会盖住顶栏。
    const viewport = page.viewportSize() ?? { width: 1200, height: 760 }
    expect(collapsed.x).toBeGreaterThanOrEqual(0)
    expect(collapsed.y).toBeGreaterThanOrEqual(52)
    expect(collapsed.y).toBeLessThanOrEqual(viewport.height)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('关闭后重开停在起始页，点「继续上次访问」仍只复用一个网页容器', async () => {
  const { app, page, dataDir } = await launch()
  try {
    await openBrowserFromTopBar(page)
    await navigate(page, `${baseURL}/second`)
    await waitForLoaded(page)

    await page.getByRole('button', { name: '关闭浏览器' }).click()
    await expect(page.locator('.browser-panel')).toHaveCount(0)
    // 关掉浮窗不影响 Studio Home。
    await expect(page.locator('.studio-home')).toBeVisible()
    await expect(page.locator('.studio-hero__title')).toBeVisible()
    // 关闭 = 销毁原生 view（不是单纯隐藏）。
    expect(await browserTargets(app)).toHaveLength(0)

    // 再打开：先落在起始页（书签的家），而不是直接跳上次的网页。
    await openBrowserFromTopBar(page)
    await expect(page.locator('.browser-start')).toBeVisible()
    await expect(page.locator('.browser-panel__address input')).toHaveValue('')
    expect(await browserTargets(app)).toHaveLength(0)

    // 起始页上的「继续上次访问」才是恢复入口：只建一个容器。
    await page.locator('.browser-start__resume').click()
    await expect(page.locator('.browser-panel__address input')).toHaveValue(`${baseURL}/second`, {
      timeout: 15_000
    })
    // `getURL()` 要等导航真正提交，刚 `loadURL` 时还可能是空串。
    await expect
      .poll(async () => (await browserTargets(app))[0]?.url ?? '', { timeout: 15_000 })
      .toBe(`${baseURL}/second`)
    expect(await browserTargets(app)).toHaveLength(1)

    // 连点顶栏不会堆出第二个 webContents。
    await page.getByRole('button', { name: '打开浏览器' }).click()
    await page.getByRole('button', { name: '打开浏览器' }).click()
    expect(await browserTargets(app)).toHaveLength(1)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('浮窗跨空间常驻：切到 Records 后浏览状态还在，关闭后回到原页面', async () => {
  const { app, page, dataDir } = await launch({ seed: true })
  try {
    await openBrowserFromTopBar(page)
    await navigate(page, `${baseURL}/`)
    await waitForLoaded(page)

    await page.getByRole('button', { name: '记录', exact: true }).click({ force: true })
    await expect(page.getByRole('heading', { name: '记录' })).toBeVisible()
    // 浏览器是全局浮层，不随模块切换销毁。
    await expect(page.locator('.browser-panel')).toBeVisible()
    await expect(page.locator('.browser-panel__address input')).toHaveValue(baseURL)
    expect(await browserTargets(app)).toHaveLength(1)

    await page.getByRole('button', { name: '关闭浏览器' }).click()
    await expect(page.locator('.browser-panel')).toHaveCount(0)
    // 关闭浮窗后仍然停在用户原来的 Records 页面。
    await expect(page.getByRole('heading', { name: '记录' })).toBeVisible()
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('Records 的链接记录提供「在 BrewPhase 中打开」，走同一个浏览器', async () => {
  const { app, page, dataDir } = await launch({ seed: true })
  try {
    await page.getByRole('button', { name: '记录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '记录' })).toBeVisible()

    // 只看链接载体：第一条不一定是链接（种子按时间排序，最新的是视频）。
    await page.getByRole('button', { name: '链接', exact: true }).click()
    await expect(page.locator('.record-tile').first()).toBeVisible()
    await page.locator('.record-tile').first().click()

    const openInside = page.getByRole('button', { name: '在 BrewPhase 中打开' })
    await expect(openInside).toBeVisible()
    await openInside.click()

    await expect(page.locator('.browser-panel')).toBeVisible()
    // 地址栏拿到的是这条记录的 URL（没被改写、也没被清空）。
    await expect(page.locator('.browser-panel__address input')).toHaveValue(/blog\.example\.com/)
    // 仍然只有一个浏览器容器。
    const targets = await browserTargets(app)
    expect(targets.length).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('三空间横向一行：四档桌面宽度都不折行、不溢出', async () => {
  const { app, page, dataDir } = await launch({ seed: true })
  try {
    for (const width of [1440, 1280, 1100, 980]) {
      const actual = await app.evaluate(
        ({ BrowserWindow }, target) => {
          const window = BrowserWindow.getAllWindows()[0]
          if (!window) return 0
          window.setContentSize(target, 860)
          const [current] = window.getContentSize()
          return current
        },
        width
      )

      const layout = await page.evaluate(() => {
        const read = (selector: string) => {
          const element = document.querySelector(selector)
          if (!element) return null
          const rect = element.getBoundingClientRect()
          return { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width) }
        }
        return {
          coffee: read('.studio-space--coffee'),
          records: read('.studio-space--records'),
          canvas: read('.studio-space--canvas'),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
        }
      })

      expect(layout.coffee, `width ${width}`).not.toBeNull()
      expect(layout.records, `width ${width}`).not.toBeNull()
      expect(layout.canvas, `width ${width}`).not.toBeNull()

      // 同一行：三个空间的顶边一致（±2px）。
      expect(Math.abs(layout.coffee!.top - layout.records!.top), `width ${actual}`).toBeLessThanOrEqual(2)
      expect(Math.abs(layout.canvas!.top - layout.records!.top), `width ${actual}`).toBeLessThanOrEqual(2)
      // 从左到右：Coffee → Records → Canvas。
      expect(layout.coffee!.left).toBeLessThan(layout.records!.left)
      expect(layout.records!.left).toBeLessThan(layout.canvas!.left)
      // 无水平溢出。
      expect(layout.overflow, `width ${actual}`).toBeLessThanOrEqual(1)
    }
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
