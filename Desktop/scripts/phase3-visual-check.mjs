/**
 * Phase 3 视觉验收脚本（手动运行，不参与 CI）。
 *
 *   env -u ELECTRON_RUN_AS_NODE node scripts/phase3-visual-check.mjs
 *
 * 产物写到 test-results/phase3-screenshots/（已 gitignore）：
 * - 卡片缩略 / 拆出的独立浏览器窗口 / 收回
 * - 圆桌停靠 / 圆桌独立窗口 / 主窗口占位 / 两类窗口共存
 * - 草稿跨窗口同步（独立窗口输入 → 归位后主窗口可见）
 *
 * 与 Phase 2 同一约束：page.screenshot() 拍不到 WebContentsView，
 * 网页内容单独用主进程 capturePage 落盘。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'

const OUT = join(process.cwd(), 'test-results', 'phase3-screenshots')
mkdirSync(OUT, { recursive: true })

const HTML = (label) => `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<style>
body{margin:0;font-family:-apple-system,'Segoe UI',sans-serif;background:linear-gradient(135deg,#f6f1e7,#e8ddc9);color:#3d2b1f}
main{padding:56px}
h1{font-size:58px;margin:0 0 12px;letter-spacing:-.02em}p{font-size:22px;color:#7a5c46}
.swatches{display:flex;gap:14px;margin-top:32px}.swatches i{width:92px;height:92px;border-radius:16px;display:block}
</style></head><body><main><h1>${label}</h1><p>real chromium page · BrewPhase Phase 3</p>
<div class="swatches"><i style="background:#6f7f5c"></i><i style="background:#b07a4a"></i><i style="background:#3d2b1f"></i><i style="background:#d9c9ae"></i></div>
</main></body></html>`

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(HTML((request.url ?? '/').replace(/^\//, '') || 'workspace'))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const localURL = `http://127.0.0.1:${port}/workspace`

const userData = mkdtempSync(join(tmpdir(), 'bp-phase3-shots-'))
const app = await electronLauncher.launch({
  args: ['.', '--no-sandbox', '--disable-gpu'],
  env: {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
})
const page = await app.firstWindow()
await page.addInitScript(() => window.localStorage.setItem('brewphase.desktop.locale', 'zh-CN'))
await page.reload()
await page.waitForLoadState('domcontentloaded')
await page.waitForSelector('.web-shelf')
await page.waitForTimeout(600)

const shot = async (name, target = page) => {
  await target.screenshot({ path: join(OUT, name) })
  console.log('[shot]', name)
}

const setFakeCursor = (point) =>
  app.evaluate((_, value) => {
    const hooks = (globalThis).__bpTestHooks
    hooks?.setDragCursor(value)
  }, point)

async function addCard(url, waitPreview = true) {
  await page.getByRole('button', { name: '添加网页' }).click()
  const form = page.locator('.web-card--editing').last()
  await form.locator('input').fill(url)
  await form.getByRole('button', { name: '打开' }).click()
  const card = page.locator('.web-card:not(.web-card--editing)').last()
  await card.waitFor({ timeout: 20_000 })
  if (waitPreview) {
    await card
      .locator('.web-card__image')
      .waitFor({ timeout: 60_000 })
      .catch(() => console.log('[warn] preview timeout for', url))
  }
  return card
}

async function capturePageByURL(fragment, name) {
  const base64 = await app
    .evaluate(async ({ webContents }, target) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => !item.isDestroyed() && item.getURL().includes(target))
      if (!contents) return null
      const image = await contents.capturePage()
      return image.isEmpty() ? null : image.toPNG().toString('base64')
    }, fragment)
    .catch(() => null)
  if (!base64) {
    console.log('[warn] page capture failed for', fragment)
    return
  }
  writeFileSync(join(OUT, name), Buffer.from(base64, 'base64'))
  console.log('[shot]', name)
}

/** 卡片拖出窗口外：合成 dragstart/dragend + 主进程假光标。 */
async function detachCard(card) {
  const tabId = await card.getAttribute('data-tab-id')
  const release = await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0]
    const bounds = main?.getBounds() ?? { x: 100, y: 100 }
    return { x: bounds.x - 220, y: bounds.y + 260 }
  })
  await setFakeCursor(release)
  await page.evaluate((id) => {
    const target = document.querySelector(`.web-card[data-tab-id="${id}"]`)
    target?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
  }, tabId)
  await card.waitFor({ state: 'attached' })
  await page.waitForTimeout(150)
  await page.evaluate((id) => {
    document
      .querySelector(`.web-card[data-tab-id="${id}"]`)
      ?.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
  }, tabId)
  await setFakeCursor(null)
}

const floatShell = () => app.windows().find((candidate) => candidate !== page && candidate.url().includes('bpFloat='))
const roundtableShell = () => app.windows().find((candidate) => candidate !== page && candidate.url().includes('bpRoundtable='))

try {
  // 1) 卡片缩略（真实截图）
  await addCard(localURL)
  await page.waitForTimeout(900)
  await shot('01-shelf-thumbnail.png')

  // 2) 拆出独立浏览器窗口
  const card = page.locator('.web-card', { hasText: 'workspace' }).first()
  await detachCard(card)
  await page.waitForTimeout(1_800)
  await shot('02-shelf-detached.png')
  const floatPage = floatShell()
  if (floatPage) {
    await floatPage.waitForSelector('.bp-float', { timeout: 15_000 }).catch(() => undefined)
    await floatPage.waitForTimeout(700)
    await shot('03-float-browser-window.png', floatPage)
    await capturePageByURL('/workspace', '04-page-in-float.png')

    // 3) 收回卡片架
    await floatPage.getByRole('button', { name: '收回卡片架' }).click()
    await page.waitForTimeout(1_800)
    await shot('05-shelf-recalled.png')
  } else {
    console.log('[warn] float window not found')
  }

  // 4) 圆桌：拖入参与者 → 停靠形态
  await card.hover().catch(() => undefined)
  await page.locator('.roundtable').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const tabId = await card.getAttribute('data-tab-id')
  await page.evaluate((id) => {
    const cardEl = document.querySelector(`.web-card[data-tab-id="${id}"]`)
    const stage = document.querySelector('.roundtable__stage')
    if (!cardEl || !stage) throw new Error('card/stage missing')
    const dataTransfer = new DataTransfer()
    cardEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    stage.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
    stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    cardEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
  }, tabId)
  await page.waitForTimeout(900)
  await page.locator('.roundtable').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  await shot('06-roundtable-docked.png')

  // 5) 圆桌拆出（按钮）：独立窗口 + 主窗口占位区 + 共存
  await page.getByRole('button', { name: '拆出为独立窗口' }).click()
  await page.waitForTimeout(1_600)
  const rtPage = roundtableShell()
  if (rtPage) {
    await rtPage.waitForSelector('.rt-window', { timeout: 15_000 }).catch(() => undefined)
    await rtPage.waitForTimeout(700)
    await shot('07-roundtable-window.png', rtPage)
    await page.locator('.roundtable--slot').evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => undefined)
    await shot('08-main-placeholder.png')
    await shot('09-coexistence-main.png')
    console.log('[info] alive shells:', app.windows().map((candidate) => candidate.url()))

    // 6) 草稿跨窗口同步：独立窗口输入 → 归位 → 主窗口可见
    await rtPage.locator('.roundtable__ask-input').fill('跨窗口同步的讨论草稿（Phase 3）')
    await rtPage.waitForTimeout(500)
    await rtPage.getByRole('button', { name: '圆桌归位' }).click()
    await page.waitForTimeout(1_600)
    await page.locator('.roundtable').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(300)
    await shot('10-roundtable-docked-with-draft.png')
  } else {
    console.log('[warn] roundtable window not found')
  }
} finally {
  await app.close().catch(() => undefined)
  server.close()
  rmSync(userData, { recursive: true, force: true })
}
console.log('[done]', OUT)
