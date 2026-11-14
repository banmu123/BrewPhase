/** Phase 3.4 编辑卡视觉快照（手动运行）：浅色 / 深色 / 悬浮操作层。 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { createServer } from 'node:http'

const OUT = join(process.cwd(), 'test-results', 'phase3-screenshots')
mkdirSync(OUT, { recursive: true })

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>workspace</title></head>
<body style="margin:0;font-family:-apple-system,sans-serif;background:#f6f1e7;padding:56px"><h1>workspace</h1></body></html>`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const userData = mkdtempSync(join(tmpdir(), 'bp-34-shots-'))
const app = await electronLauncher.launch({
  args: ['.', '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, BREWPHASE_USER_DATA_DIR: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
})
const page = await app.firstWindow()
await page.addInitScript(() => window.localStorage.setItem('brewphase.desktop.locale', 'zh-CN'))
await page.reload()
await page.waitForSelector('.web-shelf')
await page.waitForTimeout(500)

try {
  // 先放一张正常卡片（带真实缩略图），再打开编辑卡对比视觉。
  await page.getByRole('button', { name: '添加网页' }).click()
  await page.locator('.web-card--editing input').fill(`http://127.0.0.1:${port}/workspace`)
  await page.locator('.web-card--editing').getByRole('button', { name: '打开' }).click()
  await page.locator('.web-card__image').waitFor({ timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(700)

  // 编辑卡（浅色）：输入错误协议触发表单内错误态。
  await page.getByRole('button', { name: '添加网页' }).click()
  await page.locator('.web-card--editing input').fill('ftp://example.com/file')
  await page.locator('.web-card--editing').getByRole('button', { name: '打开' }).click()
  await page.locator('.web-card__form-error').waitFor({ timeout: 10_000 }).catch(() => undefined)
  await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(OUT, '11-editing-card-light.png') })
  console.log('[shot] 11-editing-card-light.png')

  // 深色主题。
  await page.evaluate(() => window.localStorage.setItem('brewphase.desktop.theme', 'dark'))
  await page.reload()
  await page.waitForSelector('.web-card--editing', { timeout: 15_000 })
  await page.waitForTimeout(700)
  await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(OUT, '12-editing-card-dark.png') })
  console.log('[shot] 12-editing-card-dark.png')

  // 悬浮态：握把 + 操作按钮（切回浅色先）。
  await page.evaluate(() => window.localStorage.setItem('brewphase.desktop.theme', 'light'))
  await page.reload()
  await page.waitForSelector('.web-card:not(.web-card--editing)', { timeout: 15_000 })
  await page.waitForTimeout(600)
  await page.locator('.web-card:not(.web-card--editing)').hover()
  await page.waitForTimeout(300)
  await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(OUT, '13-card-hover-actions.png') })
  console.log('[shot] 13-card-hover-actions.png')
} finally {
  await app.close().catch(() => undefined)
  server.close()
  rmSync(userData, { recursive: true, force: true })
}
console.log('[done]', OUT)
