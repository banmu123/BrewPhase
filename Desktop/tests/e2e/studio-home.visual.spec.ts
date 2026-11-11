import { test, expect, _electron as electronLauncher } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinLocale } from './locale'
import { seedEmptyDatabase, seedStudioDatabase } from './studio-seed'

/**
 * Studio Home Phase 1.2 的视觉验收：截图落在临时目录，不进产品资源目录。
 *
 * 跑法：STUDIO_VISUAL=1 npx playwright test studio-home.visual
 * 产出：`$TMPDIR`（macOS 下 /var/folders/…）而不是 /tmp 以外的路径——
 * 报告里直接引用这些文件即可。
 *
 * 五个必拍状态：
 * 1/2. 三个空间全空（1440 与 980 两种宽度）
 * 3.   Records 有真实数据的叠放
 * 4.   Records hover 展开
 * 5.   三个空间都有数据 + 1280/1100 窄窗
 */

test.skip(!process.env.STUDIO_VISUAL, '视觉验收需要 STUDIO_VISUAL=1')

const OUTPUT_DIR = process.env.STUDIO_VISUAL_DIR || join(tmpdir(), 'brewphase-studio-visual')

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
  delete env.BREWPHASE_FORCE_ONBOARDING
  return env
}

async function launch(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(userDataDir)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page }
}

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(size.width, size.height)
  }, { width, height })
  await page.waitForTimeout(400)
}

test('空 Studio Home：1440 与 980', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-visual-empty-'))
  seedEmptyDatabase(dir)
  const { app, page } = await launch(dir)
  try {
    await resize(app, page, 1440, 940)
    await page.screenshot({ path: join(OUTPUT_DIR, '01-studio-empty-1440.png') })

    await resize(app, page, 1280, 900)
    await page.screenshot({ path: join(OUTPUT_DIR, '02-studio-empty-1280.png') })

    await resize(app, page, 1100, 880)
    await page.screenshot({ path: join(OUTPUT_DIR, '03-studio-empty-1100.png') })

    await resize(app, page, 980, 860)
    await page.screenshot({ path: join(OUTPUT_DIR, '04-studio-empty-980.png') })
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('有数据：Deck 叠放、hover 展开、窄窗', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-visual-deck-'))
  seedStudioDatabase(dir)
  const { app, page } = await launch(dir)
  // 远程缩略图用本地 mock，截图不依赖外网。
  await page.route('https://cdn.mock.test/**', (route) =>
    route.fulfill({ status: 200, body: MOCK_PNG, contentType: 'image/png' })
  )
  try {
    await resize(app, page, 1440, 940)
    // 等真实媒体解码完成：截图里不能出现破图。
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.records-deck__card--image img')).every(
        (img) => (img as HTMLImageElement).complete
      )
    )
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(OUTPUT_DIR, '05-studio-filled-1440.png') })

    // 展开态截图：把展开姿态显式钉住（用的是与 :hover 同一组 `--deck-*-spread`
    // 变量），避免无 GPU 窗口下悬停事件/动画帧被节流导致截到半路。
    // 展开行为本身由 studio-home.e2e 的「Hover 展开」用例断言，这里只负责出图。
    await page.mouse.move(
      (await page.locator('.records-deck').boundingBox())!.x + 200,
      (await page.locator('.records-deck').boundingBox())!.y + 200
    )
    const hoverStyle = await page.addStyleTag({
      content: `
        .records-deck__card { transition: none !important; }
        .records-deck .records-deck__card {
          transform: translate(var(--deck-x-spread), var(--deck-y-spread)) rotate(var(--deck-r-spread)) !important;
        }
      `
    })
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(OUTPUT_DIR, '06-studio-deck-hover-1440.png') })
    await hoverStyle.evaluate((element) => element.remove())
    await page.mouse.move(6, 6)
    await page.waitForTimeout(400)

    await resize(app, page, 1280, 900)
    await page.screenshot({ path: join(OUTPUT_DIR, '07-studio-filled-1280.png') })

    await resize(app, page, 1100, 880)
    await page.screenshot({ path: join(OUTPUT_DIR, '08-studio-filled-1100.png') })

    await resize(app, page, 980, 860)
    await page.screenshot({ path: join(OUTPUT_DIR, '09-studio-filled-980.png') })
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('三个空间的完整视图（有数据）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-visual-spaces-'))
  seedStudioDatabase(dir)
  const { app, page } = await launch(dir)
  await page.route('https://cdn.mock.test/**', (route) =>
    route.fulfill({ status: 200, body: MOCK_PNG, contentType: 'image/png' })
  )
  try {
    await resize(app, page, 1440, 940)
    for (const [name, selector, file] of [
      ['咖啡', '.shelf-card', '10-space-coffee.png'],
      ['记录', '.record-masonry', '11-space-records.png'],
      ['画布', '.gallery-grid', '12-space-canvas.png']
    ] as const) {
      await page.getByRole('button', { name, exact: true }).click()
      await page.waitForSelector(selector, { timeout: 10_000 })
      await page.waitForTimeout(700)
      await page.screenshot({ path: join(OUTPUT_DIR, file) })
      const back = page.locator('.back-link')
      if ((await back.count()) > 0) {
        await back.first().click()
      } else {
        await page.locator('.canvas-back').first().click()
        await page.locator('.topbar__brand').click()
      }
      await expect(page.locator('.studio-home')).toBeVisible()
    }
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
