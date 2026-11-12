import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { pinLocale } from './locale'
import { seedStudioDatabase } from './studio-seed'

/**
 * 外观落地的行为验收。
 *
 * 断言三件事，每一件都对应一个会「看起来没做」的失败：
 * 1. 选深色后 `<html data-theme="dark">` 当场生效——整份 CSS 都挂在这个属性上；
 * 2. 刷新后仍是深色——偏好确实进了 localStorage，不是只活在内存里；
 * 3. 切回浅色能撤销干净——不会在根元素上留下深色残影。
 *
 * 第二个用例走真实数据，专盯**画布**：Konva 画在 canvas 上、读不到 CSS，
 * 它是唯一需要显式重建配色缓存的地方，也是最容易停在「页面全黑、画布全白」的一处。
 *
 * 截图：`VISUAL_CHECK=1` 时输出 /tmp/theme-*.png，用来人工看配色
 * （正文、次要信息、卡片层级、主按钮），不做像素比对。
 */

const visual = Boolean(process.env.VISUAL_CHECK)

const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** 当前落在根元素上的外观（`ThemeProvider` 唯一写入口）。 */
function currentTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.dataset.theme ?? null)
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!visual) return
  // 无 GPU 的 Electron 被遮挡时帧会被节流：先关掉过渡，避免等动画稳定。
  await page.addStyleTag({ content: '*{transition:none !important;animation:none !important}' })
  await page.waitForTimeout(250)
  await page.screenshot({ path: `/tmp/theme-${name}.png` })
}

async function switchToDark(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '深色', exact: true }).click()
  await expect.poll(() => currentTheme(page)).toBe('dark')
  // 设置页没有空间入口，回 Studio 首页走顶栏品牌。
  await page.locator('.topbar__brand').click()
  await expect(page.locator('.studio-home')).toBeVisible()
}

test('外观：深色立即生效、刷新后保持、切回浅色可撤销', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-theme-'))
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env: launchEnv(userData) })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')

  const colorScheme = (): Promise<string> =>
    page.evaluate(() => document.documentElement.style.colorScheme)
  /** 页面主背景的真实计算值——`data-theme` 对不对，最终要看这里。 */
  const paperColor = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor)

  const settingsButton = page.getByRole('button', { name: '设置', exact: true })
  const darkButton = page.getByRole('button', { name: '深色', exact: true })
  const lightButton = page.getByRole('button', { name: '浅色', exact: true })
  const systemButton = page.getByRole('button', { name: '跟随系统', exact: true })

  await settingsButton.click()
  await expect(darkButton).toBeVisible()

  // —— 深色 ——
  await darkButton.click()
  await expect.poll(() => currentTheme(page)).toBe('dark')
  // 原生滚动条/输入框靠 color-scheme 跟随，漏了它深色界面会插进一条亮色条。
  expect(await colorScheme()).toBe('dark')
  const darkPaper = await paperColor()
  await shoot(page, 'zh-settings-dark')

  // 主进程那一层也要跟着变：窗口底色是页面还没画出来、或拖动缩放时露出的那条边，
  // 它不归 CSS 管，只走 IPC。这里读回窗口真实底色，确认链路通了而不是只改了属性。
  const windowBackground = (): Promise<string> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor() ?? '')
  expect((await windowBackground()).toLowerCase()).toContain('15120f')

  // 主按钮走 --espresso 翻转：深色下必须是亮底深字，不能还是白底。
  const primary = page.locator('.button--primary, .topbar__add').first()
  if ((await primary.count()) > 0) {
    const bg = await primary.evaluate((node) => getComputedStyle(node).backgroundColor)
    expect(bg).not.toBe('rgb(255, 255, 255)')
  }

  // —— 刷新后仍然深色 ——
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => currentTheme(page)).toBe('dark')

  // —— 切回浅色 ——
  await settingsButton.click()
  await lightButton.click()
  await expect.poll(() => currentTheme(page)).toBe('light')
  expect(await colorScheme()).toBe('light')
  const lightPaper = await paperColor()
  await shoot(page, 'zh-settings-light')

  // 两种外观的页面底色必须真的不同：只改属性不改色，说明令牌没接上。
  expect(lightPaper).not.toBe(darkPaper)
  expect((await windowBackground()).toLowerCase()).toContain('f7f8f6')

  // —— 跟随系统 ——
  await systemButton.click()
  expect(['light', 'dark']).toContain(await currentTheme(page))

  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

test('深色下的三个空间与画布绘图', async () => {
  test.setTimeout(180_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-theme-data-'))
  seedStudioDatabase(userData)

  const app: ElectronApplication = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(userData)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  // 种子里的远程缩略图走本地 mock，截图不依赖外网。
  await page.route('https://cdn.mock.test/**', (route) =>
    route.fulfill({ status: 200, body: MOCK_PNG, contentType: 'image/png' })
  )
  await expect(page.locator('.studio-home')).toBeVisible()

  try {
    await switchToDark(page)
    await expect(page.locator('.studio-home')).toBeVisible()
    await shoot(page, 'zh-studio-dark')

    // 三个空间：卡片、记录瀑布流、画布画廊都要在深色下成立
    for (const [name, selector, file] of [
      ['咖啡', '.shelf-card', 'zh-coffee-dark'],
      ['记录', '.record-masonry', 'zh-records-dark'],
      ['画布', '.gallery-grid', 'zh-gallery-dark']
    ] as const) {
      await page.getByRole('button', { name, exact: true }).click()
      await page.waitForSelector(selector, { timeout: 15_000 })
      await page.waitForTimeout(500)
      await shoot(page, file)
      const back = page.locator('.back-link')
      if ((await back.count()) > 0) {
        await back.first().click()
      } else {
        await page.locator('.canvas-back').first().click()
        await page.locator('.topbar__brand').click()
      }
      await expect(page.locator('.studio-home')).toBeVisible()
    }

    // 画布工作区：Konva 直接往 canvas 里画，取色走 shared/tokens.ts 的缓存。
    // 缓存不带外观标记的话，这里会是「页面全黑、画布全白」。
    await page.getByRole('button', { name: '画布', exact: true }).click()
    await page.locator('.gallery-card__open').first().click()
    await expect(page.locator('.canvas-back')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(900)
    await shoot(page, 'zh-canvas-dark')

    // 画布仍在深色：切到工作区不应把外观重置回去。
    await expect.poll(() => currentTheme(page)).toBe('dark')
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userData, { recursive: true, force: true })
  }
})
