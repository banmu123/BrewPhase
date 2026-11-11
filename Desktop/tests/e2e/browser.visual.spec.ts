import { test, expect, _electron as electronLauncher } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinLocale } from './locale'
import { seedStudioDatabase } from './studio-seed'

/**
 * Phase 1 的视觉验收：六张浏览器状态 + 三列布局的修复前后对比。
 *
 * 跑法：STUDIO_VISUAL=1 npx playwright test browser.visual
 * 产出：`$STUDIO_VISUAL_DIR`（默认 `$TMPDIR/brewphase-browser-visual`）。
 *
 * 网页截图有一个前提：WebContentsView 是原生层，`page.screenshot()` 只截
 * renderer。要让网页出现在图里，必须用 Electron 的 `capturePage()`（整窗合成）。
 * 所以这里统一走主进程截图，而不是 Playwright 的页面截图。
 */

test.skip(!process.env.STUDIO_VISUAL, '视觉验收需要 STUDIO_VISUAL=1')

const OUTPUT_DIR = process.env.STUDIO_VISUAL_DIR || join(tmpdir(), 'brewphase-browser-visual')

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Slow Coffee — Field Notes</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fbfaf7;color:#2f352e}
  .wrap{max-width:680px;margin:0 auto;padding:64px 40px}
  .eyebrow{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#8b9187}
  h1{font-family:Georgia,serif;font-size:40px;line-height:1.15;margin:12px 0 16px;letter-spacing:-.02em}
  p{font-size:15px;line-height:1.75;color:#4d554b}
  .rule{height:1px;background:#e6e8e2;margin:28px 0}
  .meta{font-size:12px;color:#8b9187}
  blockquote{margin:24px 0;padding-left:18px;border-left:2px solid #c8d2c1;font-family:Georgia,serif;font-style:italic;color:#5a6357}
</style></head>
<body><div class="wrap">
<div class="eyebrow">Brewing notes</div>
<h1>Slow coffee, and the case for doing one thing at a time.</h1>
<div class="meta">Field Notes · 6 min read</div>
<div class="rule"></div>
<p>A pour-over is a small argument against multitasking. Water goes in, you wait, you pour again. Nothing about it rewards speed.</p>
<blockquote>The grind settles, the bed rises, and for four minutes the only thing left to do is pay attention.</blockquote>
<p>This page is served from a local HTTP server during the visual test. It exists so the screenshot shows a real rendered document rather than a white rectangle.</p>
</div></body></html>`

let server: Server
let baseURL = ''

test.beforeAll(async () => {
  mkdirSync(OUTPUT_DIR, { recursive: true })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(PAGE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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

async function launch(seed: boolean): Promise<{ app: ElectronApplication; page: Page; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'brewphase-browser-visual-'))
  if (seed) seedStudioDatabase(dataDir)
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(dataDir)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.studio-home')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860)
  })
  await page.waitForTimeout(500)
  // 入场/悬停动效会让截图停在中间帧，拍之前先关掉。
  await page.addStyleTag({
    content: `
      .browser-panel{animation:none !important}
      .browser-panel *{transition:none !important}
    `
  })
  return { app, page, dataDir }
}

/** 整窗合成截图：只有它能拍到 WebContentsView 里的网页。 */
async function captureWindow(app: ElectronApplication, name: string): Promise<void> {
  const dataUrl = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return ''
    const image = await window.webContents.capturePage()
    return image.toDataURL()
  })
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(OUTPUT_DIR, name), Buffer.from(base64, 'base64'))
}

/**
 * 网页本身的像素统计与截图。
 *
 * 注意一个 Electron 的结构性事实：`page.screenshot()` 与
 * `window.webContents.capturePage()` 都只画 **renderer 这一层**，
 * WebContentsView 是独立的原生 webContents，不会出现在里面（拍到的就是
 * 一块白色占位）。所以「网页真的渲染了」只能直接对那个 webContents 取证。
 */
async function captureWebContent(
  app: ElectronApplication,
  name: string
): Promise<{ nonWhiteRatio: number; distinctColors: number; width: number; height: number }> {
  const dataUrl = await app.evaluate(async ({ webContents, session }, partition) => {
    const target = session.fromPartition(partition)
    const contents = webContents.getAllWebContents().find((item) => item.session === target)
    if (!contents) return ''
    const image = await contents.capturePage()
    return image.toDataURL()
  }, BROWSER_PARTITION)

  if (dataUrl) {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(OUTPUT_DIR, name), Buffer.from(base64, 'base64'))
  }

  return app.evaluate(
    async ({ webContents, session }, partition) => {
      const target = session.fromPartition(partition)
      const contents = webContents.getAllWebContents().find((item) => item.session === target)
      if (!contents) return { nonWhiteRatio: 0, distinctColors: 0, width: 0, height: 0 }
      const image = await contents.capturePage()
      const bitmap = image.getBitmap()
      const size = image.getSize()
      const palette = new Set<number>()
      let nonWhite = 0
      let total = 0
      // BGRA，四字节一像素。
      for (let index = 0; index + 3 < bitmap.length; index += 4) {
        const blue = bitmap[index]!
        const green = bitmap[index + 1]!
        const red = bitmap[index + 2]!
        total += 1
        if (!(red > 248 && green > 246 && blue > 242)) nonWhite += 1
        if (palette.size < 4096) palette.add((red << 16) | (green << 8) | blue)
      }
      return {
        nonWhiteRatio: total > 0 ? nonWhite / total : 0,
        distinctColors: palette.size,
        width: size.width,
        height: size.height
      }
    },
    BROWSER_PARTITION
  )
}

const BROWSER_PARTITION = 'persist:brewphase-browser'

async function openBrowser(page: Page): Promise<void> {
  await page.getByRole('button', { name: '打开浏览器' }).click()
  await expect(page.locator('.browser-panel')).toBeVisible()
  await page.waitForTimeout(250)
}

async function navigate(page: Page, url: string): Promise<void> {
  const input = page.locator('.browser-panel__address input')
  await input.fill(url)
  await input.press('Enter')
  await expect(page.locator('.browser-panel__spinner')).toHaveCount(0, { timeout: 20_000 })
  await page.waitForTimeout(700)
}

test('六张浏览器状态 + 三列布局修复前后', async () => {
  const { app, page, dataDir } = await launch(true)
  try {
    // 1. Studio Home 上点击顶栏 Browser 后的状态（起始页）。
    await openBrowser(page)
    await page.screenshot({ path: join(OUTPUT_DIR, '01-studio-home-browser-open.png') })

    // 2. 完整浮窗：加载真实网页后的整窗合成（含网页内容）。
    await navigate(page, baseURL)
    await captureWindow(app, '02-browser-panel-loaded.png')

    // 机器证据：网页确实渲染了（不是白屏 / 黑屏）。
    const stats = await captureWebContent(app, '02b-web-content.png')
    expect(stats.width).toBeGreaterThan(300)
    expect(stats.height).toBeGreaterThan(200)
    expect(stats.nonWhiteRatio).toBeGreaterThan(0.02)
    expect(stats.distinctColors).toBeGreaterThan(8)
    console.log(
      `[visual] 网页内容 ${stats.width}×${stats.height}，非白像素 ${(stats.nonWhiteRatio * 100).toFixed(1)}%，颜色 ${stats.distinctColors}`
    )

    // 3. 拖动后的状态。
    const bar = (await page.locator('.browser-panel__titlebar').boundingBox())!
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
    await page.mouse.down()
    await page.mouse.move(bar.x + bar.width / 2 - 140, bar.y + bar.height / 2 + 60, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    await captureWindow(app, '03-browser-dragged.png')

    // 4. 缩放后的状态（右下角向外拉大）。
    const corner = (await page.locator('.browser-panel__handle[data-dir="se"]').boundingBox())!
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2)
    await page.mouse.down()
    await page.mouse.move(corner.x + 90, corner.y + 40, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    await captureWindow(app, '04-browser-resized.png')

    // 5. 加载中的状态：慢响应页面。
    await page.locator('.browser-panel__address input').fill(`${baseURL}/?slow`)
    await page.locator('.browser-panel__address input').press('Enter')
    await page.waitForTimeout(120)
    await captureWindow(app, '05-browser-loading.png')
    await page.waitForTimeout(1500)

    // 6. 关闭后回到 Studio Home。
    await page.getByRole('button', { name: '关闭浏览器' }).click()
    await expect(page.locator('.browser-panel')).toHaveCount(0)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(OUTPUT_DIR, '06-back-to-studio-home.png') })

    // 7. 三列布局「修复前」：把旧的两列两行规则盖回去，与改动前的 CSS 一致。
    await page.addStyleTag({
      content: `
        .studio-desk{
          grid-template-columns:minmax(0,1.04fr) minmax(0,1fr) !important;
          grid-template-rows:auto 1fr !important;
          grid-template-areas:'coffee records' 'canvas records' !important;
          row-gap:26px !important;
        }
        .studio-space--canvas{margin-left:44px !important}
      `
    })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(OUTPUT_DIR, '07-layout-before-two-rows.png') })

    // 8. 三列布局「修复后」：重新加载拿回当前 CSS。
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('.studio-home')).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(OUTPUT_DIR, '08-layout-after-three-columns.png') })
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
