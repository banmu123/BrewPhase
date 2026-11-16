import { test, expect, _electron as electronLauncher } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSpace } from './nav'
import { pinLocale } from './locale'
import { seedStudioDatabase } from './studio-seed'

/**
 * README 里的桌面端截图（手动运行，不进 CI）。
 *
 * 跑法：
 *   README_SHOTS=1 npx playwright test readme-shots
 *
 * 产出：`README_SHOTS_DIR`（默认 `$TMPDIR/brewphase-readme-shots`），
 * 每个语言一套 PNG（2400×1500，视网膜 2x 抓取后按窗口 CSS 尺寸落盘）。
 * 只有挑中的那几张才会被复制进 `docs/screenshots/` —— 这个 spec 本身
 * 不写产品资源目录，和 `studio-home.visual.spec.ts` 的约定一致。
 *
 * 数据用的是 `studio-seed.ts` 里的真实字段种子（3 包豆、7 条记录、
 * 2 块带节点的画布），不是贴上去的假图：卡片都是按记录渲染出来的。
 */

test.skip(!process.env.README_SHOTS, 'README 截图需要 README_SHOTS=1')

const OUTPUT_DIR = process.env.README_SHOTS_DIR || join(tmpdir(), 'brewphase-readme-shots')

const LOCALES = [
  {
    locale: 'en-US' as const,
    seed: 'en' as const,
    spaces: { coffee: 'Coffee', records: 'Records', canvas: 'Canvas' },
    bean: 'Yirgacheffe Natural',
    canvas: 'Flavour wheel draft'
  },
  {
    locale: 'zh-CN' as const,
    seed: 'zh' as const,
    spaces: { coffee: '咖啡', records: '记录', canvas: '画布' },
    bean: '耶加雪菲 日晒',
    canvas: '风味轮草稿'
  }
]

const VIEWPORT = { width: 1440, height: 900 }

async function resize(app: ElectronApplication, size: typeof VIEWPORT): Promise<void> {
  await app.evaluate(({ BrowserWindow }, next) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(next.width, next.height)
  }, size)
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(OUTPUT_DIR, `${name}.png`), animations: 'disabled' })
  // 同时留一份可见文案，方便在没有图形界面时复核「截到的到底是什么」：
  // 空态、错误提示、加载中都在这份文本里原形毕露。
  writeFileSync(join(OUTPUT_DIR, `${name}.txt`), await page.locator('body').innerText())
  const { pageHeight, viewportHeight } = await page.evaluate(() => ({
    pageHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight
  }))
  console.log(`[readme-shots] ${name}  page=${pageHeight}  viewport=${viewportHeight}`)
}

for (const { locale, seed, spaces, bean, canvas } of LOCALES) {
  test(`README 截图 · ${locale}`, async () => {
    mkdirSync(OUTPUT_DIR, { recursive: true })
    const userData = mkdtempSync(join(tmpdir(), 'bp-readme-shots-'))
    seedStudioDatabase(userData, seed, { freshRoast: true })

    const app = await electronLauncher.launch({
      args: ['.', '--no-sandbox', '--disable-gpu'],
      env: {
        ...process.env,
        BREWPHASE_USER_DATA_DIR: userData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
      }
    })

    try {
      const page = await app.firstWindow()
      await pinLocale(page, locale)
      await resize(app, VIEWPORT)
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.studio-home')).toBeVisible()

      // 1. Studio 首页：三个空间都有数据的那张桌子。
      await shoot(page, `desktop-studio-${locale}`)

      // 2. Coffee：豆架 + 打开一包的详情面板（风味窗口、冲煮记录）。
      await openSpace(page, spaces.coffee)
      await page.waitForTimeout(600)
      await page.locator('.shelf-card', { hasText: bean }).click()
      await expect(page.locator('.float-panel')).toBeVisible()
      await page.waitForTimeout(600)
      await shoot(page, `desktop-coffee-${locale}`)

      // 3. Records：收藏库，四种载体混排。
      await openSpace(page, spaces.records)
      await page.waitForTimeout(800)
      await shoot(page, `desktop-records-${locale}`)

      // 4. Canvas：先进画布列表，再打开种子里那张带 3 个节点的。
      await openSpace(page, spaces.canvas)
      await page.waitForTimeout(600)
      const target = page.locator('.gallery-card__open', { hasText: canvas })
      await expect(target).toHaveCount(1)
      await target.click()
      await page.waitForTimeout(1500)
      // 空态出现就说明节点没渲染出来，这张截图不能进 README。
      await expect(page.locator('.canvas-empty')).toHaveCount(0)
      await shoot(page, `desktop-canvas-${locale}`)
    } finally {
      await app.close()
      rmSync(userData, { recursive: true, force: true })
    }
  })
}
