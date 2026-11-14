/**
 * Phase 2 视觉验收脚本（手动运行，不参与 CI）。
 *
 *   env -u ELECTRON_RUN_AS_NODE node scripts/phase2-visual-check.mjs
 *
 * 产物写到 test-results/phase2-screenshots/（已 gitignore）：
 * - 卡片架缩略图（本地页面 + Claude + ChatGPT，能连上才成功）
 * - 主窗口展开、拖出后的独立窗口、收回后的架子
 * - 真实网页本身的截图（主进程 capturePage，避开 DOM 截不到原生层的限制）
 *
 * 说明：`page.screenshot()` 拍不到 WebContentsView；所以「网页内容」单独用
 * 主进程 capturePage 落盘，窗口壳与卡片用 Playwright 截图。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'

const OUT = join(process.cwd(), 'test-results', 'phase2-screenshots')
mkdirSync(OUT, { recursive: true })

const HTML = (label) => `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<style>
body{margin:0;font-family:-apple-system,'Segoe UI',sans-serif;background:linear-gradient(135deg,#f6f1e7,#e8ddc9);color:#3d2b1f}
main{padding:56px}
h1{font-size:58px;margin:0 0 12px;letter-spacing:-.02em}p{font-size:22px;color:#7a5c46}
.swatches{display:flex;gap:14px;margin-top:32px}.swatches i{width:92px;height:92px;border-radius:16px;display:block}
</style></head><body><main><h1>${label}</h1><p>real chromium page · BrewPhase Phase 2</p>
<div class="swatches"><i style="background:#6f7f5c"></i><i style="background:#b07a4a"></i><i style="background:#3d2b1f"></i><i style="background:#d9c9ae"></i></div>
</main></body></html>`

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(HTML((request.url ?? '/').replace(/^\//, '') || 'workspace'))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const localURL = `http://127.0.0.1:${port}/workspace`

const userData = mkdtempSync(join(tmpdir(), 'bp-phase2-shots-'))
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

try {
  // 1) 本地页面：确定能拿到真实缩略图
  await addCard(localURL)
  await page.waitForTimeout(900)
  await shot('01-shelf-local-thumbnail.png')
  await page.locator('.web-shelf').screenshot({ path: join(OUT, '02-shelf-only.png') })
  console.log('[shot] 02-shelf-only.png')

  // 2) 真实站点：能访问就截，访问不了保留错误态并如实记录
  await addCard('https://claude.ai/')
  await page.waitForTimeout(1_500)
  await shot('03-shelf-claude.png')
  await capturePageByURL('claude.ai', '04-page-claude.png')

  await addCard('https://chatgpt.com/')
  await page.waitForTimeout(2_500)
  await shot('05-shelf-chatgpt.png')
  await capturePageByURL('chatgpt.com', '06-page-chatgpt.png')

  // 3) 主窗口展开（面板）
  const localCard = page.locator('.web-card', { hasText: 'workspace' }).first()
  await localCard.click()
  await page.waitForSelector('.browser-panel')
  await page.waitForTimeout(700)
  await shot('07-panel-expanded.png')

  // 4) 拖出独立窗口：屏幕坐标事件走真实 UI 链路
  await page.locator('.browser-panel__close').click()
  await page.waitForTimeout(400)
  const card = page.locator('.web-card', { hasText: 'workspace' }).first()
  await page.locator('.web-shelf').evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  const box = await card.boundingBox()
  const x = Math.round(box.x + 30)
  const y = Math.round(box.y + 30)
  await page.evaluate(
    ({ x, y }) => {
      const target = document.elementFromPoint(x, y)?.closest('.web-card')
      if (!target) return
      const base = { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }
      target.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y }))
      target.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x + 24, clientY: y + 24, screenX: window.screenX + x + 24, screenY: window.screenY + y + 24 }))
    },
    { x, y }
  )
  await page.waitForTimeout(200)
  await page.evaluate(() => {
    const base = { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: 2, clientY: 2, screenX: window.screenX - 700, screenY: window.screenY - 700 }
    document.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 1 }))
    document.dispatchEvent(new PointerEvent('pointerup', base))
  })
  await page.waitForTimeout(1_500)
  await shot('08-shelf-detached.png')

  const floatPage = app.windows().find((candidate) => candidate !== page && candidate.url().includes('bpFloat='))
  if (floatPage) {
    await floatPage.waitForSelector('.bp-float', { timeout: 15_000 }).catch(() => undefined)
    await floatPage.waitForTimeout(600)
    await shot('09-float-window.png', floatPage)
    await capturePageByURL('/workspace', '10-page-in-float.png')

    // 5) 收回卡片架
    await floatPage.getByRole('button', { name: '收回卡片架' }).click()
    await page.waitForTimeout(1_800)
    await shot('11-shelf-recalled.png')
  } else {
    console.log('[warn] float window not found')
  }

  // 6) 深色主题下的架子（外观令牌检查）
  await page.evaluate(() => window.localStorage.setItem('brewphase.desktop.theme', 'dark'))
  await page.reload()
  await page.waitForSelector('.web-shelf')
  await page.waitForTimeout(900)
  await shot('12-shelf-dark.png')
} finally {
  await app.close().catch(() => undefined)
  server.close()
  rmSync(userData, { recursive: true, force: true })
}
console.log('[done]', OUT)
