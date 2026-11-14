import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher, expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { pinLocale } from './locale'
import { startWebFixture, type WebFixture } from './web-fixture'

/**
 * 网页卡片 Phase 2 的端到端验收：真实缩略图、主窗口展开、拖出独立窗口、
 * 收回卡片架且页面不重载。
 *
 * 说明：Playwright 的鼠标坐标不能离开窗口，所以「拖出客户端边界」用
 * **屏幕坐标的 PointerEvent** 走同一条 UI 链路（pointerdown → 阈值 →
 * document pointerup → 主进程 dragProbe/resolve）。它仍然经过卡片自己的
 * 判定与主进程窗口几何，不是直接调 resolveDrop 造假。
 * OS 级真实拖动另有人工验收清单。
 */

let fixture: WebFixture

test.beforeAll(async () => {
  fixture = await startWebFixture()
})

test.afterAll(async () => {
  await fixture.close()
})

async function launch(): Promise<{ app: ElectronApplication; page: Page; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bp-web-cards-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: dataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.BREWPHASE_FORCE_ONBOARDING
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electronLauncher.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page, dataDir }
}

async function addCard(page: Page, path: string): Promise<Locator> {
  await page.getByRole('button', { name: '添加网页' }).click()
  const form = page.locator('.web-card--editing').last()
  await expect(form).toBeVisible()
  await form.locator('input').fill(fixture.url(path))
  await form.getByRole('button', { name: '打开' }).click()
  const card = page.locator('.web-card:not(.web-card--editing)').last()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card).toContainText(`fixture ${path.replace(/^\//, '')}`, { timeout: 20_000 })
  return card
}

async function waitForPreview(card: Locator): Promise<{ width: number; height: number }> {
  const image = card.locator('.web-card__image')
  await expect(image).toBeVisible({ timeout: 25_000 })
  const size = await image.evaluate((element) => {
    const img = element as HTMLImageElement
    return { width: img.naturalWidth, height: img.naturalHeight }
  })
  expect(size.width).toBeGreaterThan(200)
  expect(size.height).toBeGreaterThan(100)
  return size
}

/** 用屏幕坐标的 pointer 事件把卡片拖出窗口（真实 UI 链路，不直接调 IPC）。 */
async function dragCardOutOfWindow(page: Page, card: Locator): Promise<void> {
  await page.locator('.web-shelf').evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(160)
  const box = await card.boundingBox()
  expect(box).not.toBeNull()
  const start = { x: Math.round(box!.x + 30), y: Math.round(box!.y + 30) }

  await page.evaluate(
    ({ x, y }) => {
      const element = document.elementFromPoint(x, y) as HTMLElement | null
      const target = element?.closest<HTMLElement>('.web-card')
      if (!target) throw new Error('card not found at point')
      const base = {
        bubbles: true,
        cancelable: true,
        pointerId: 41,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1
      }
      target.dispatchEvent(
        new PointerEvent('pointerdown', {
          ...base,
          clientX: x,
          clientY: y,
          screenX: window.screenX + x,
          screenY: window.screenY + y
        })
      )
      target.dispatchEvent(
        new PointerEvent('pointermove', {
          ...base,
          clientX: x + 24,
          clientY: y + 24,
          screenX: window.screenX + x + 24,
          screenY: window.screenY + y + 24
        })
      )
    },
    start
  )

  // 等 React 进入 dragging、document 监听挂好。
  await expect(card).toHaveAttribute('data-dragging', 'true', { timeout: 5_000 })
  await page.waitForTimeout(120)

  await page.evaluate(() => {
    const base = {
      bubbles: true,
      cancelable: true,
      pointerId: 41,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
      // 窗口左上角再往左上：几何上不可能落在任何已知窗口内。
      clientX: 2,
      clientY: 2,
      screenX: window.screenX - 600,
      screenY: window.screenY - 600
    }
    document.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 1 }))
    document.dispatchEvent(new PointerEvent('pointerup', base))
  })
}

test('真实网页卡片：缩略图来自当前页面，点击在主窗口展开，收起不销毁', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const card = await addCard(page, '/a')
    const tabId = await card.getAttribute('data-tab-id')
    expect(tabId).toMatch(/^tab-/)

    // 缩略图是真实截图：640×400（16:10），不是 favicon 或占位图。
    const size = await waitForPreview(card)
    expect(size.width / size.height).toBeCloseTo(1.6, 1)
    const src = await card.locator('.web-card__image').getAttribute('src')
    expect(src?.startsWith('data:image/jpeg;base64,')).toBe(true)

    // 同一个 tabId 能读到真实 DOM：卡片背后确实是 Chromium 页面。
    const real = await page.evaluate(async (id) => {
      const title = await window.brewphase.browserTabs.executeOnTab(id, 'document.title')
      const path = await window.brewphase.browserTabs.executeOnTab(id, 'location.pathname')
      return { title, path }
    }, tabId!)
    expect(real.title).toBe('fixture a')
    expect(real.path).toBe('/a')

    // 点击卡片：主窗口浏览器面板展开同一条标签（不新开页面）。
    await card.click()
    await expect(page.locator('.browser-panel')).toBeVisible()
    await expect(page.locator('.browser-panel__name')).toContainText('fixture a')
    let state = await page.evaluate(() => window.brewphase.browser.state())
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe(tabId)
    expect(state.visible).toBe(true)

    // 收起面板 ≠ 关闭：卡片还在，标签还活着。
    await page.locator('.browser-panel__close').click()
    await expect(page.locator('.browser-panel')).toHaveCount(0)
    await expect(page.locator('.web-card')).toHaveCount(1)
    state = await page.evaluate(() => window.brewphase.browser.state())
    expect(state.tabs).toHaveLength(1)
    expect(state.visible).toBe(false)
    // 页面被收纳到采集宿主（parked），不是销毁、也不是重新加载。
    expect(state.tabs[0].parked).toBe(true)
    await expect(card.locator('.web-card__chip')).toHaveText('已收纳')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('拖出独立窗口再收回卡片架：同一个页面实例，不重新加载', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const card = await addCard(page, '/b')
    const tabId = await card.getAttribute('data-tab-id')
    expect(tabId).toMatch(/^tab-/)
    await waitForPreview(card)

    const bornBefore = await page.evaluate(
      async (id) => window.brewphase.browserTabs.executeOnTab(id, 'window.__born'),
      tabId!
    )

    await dragCardOutOfWindow(page, card)

    // 新窗口出现，标签被标记为 detached；卡片仍在架上。
    // 注意：Playwright 的 windows() 也包含 WebContentsView 里的真实网页，
    // 所以只按壳页 URL（#bpFloat=）判断独立窗口数量。
    const floatShells = (): number =>
      app.windows().filter((candidate) => candidate.url().includes('bpFloat=')).length
    await expect.poll(floatShells, { timeout: 20_000 }).toBe(1)
    await expect(page.locator('.web-card')).toHaveCount(1)
    await expect(card).toHaveAttribute('data-presentation', 'detached', { timeout: 20_000 })
    await expect(card.locator('.web-card__chip')).toHaveText('独立窗口')
    const detachedState = await page.evaluate(() => window.brewphase.browser.state())
    expect(detachedState.tabs[0].detached).toBe(true)
    expect(detachedState.tabs[0].id).toBe(tabId)

    // 独立窗口是完整 BrewPhase 浏览器壳：标题、标签条与「收回卡片架」。
    // 新窗口先加载 file:// 壳页，等它真正渲染出 .bp-float 再断言。
    await expect
      .poll(
        async () => {
          for (const candidate of app.windows()) {
            if (candidate === page) continue
            if ((await candidate.locator('.bp-float').count()) > 0) return true
          }
          return false
        },
        { timeout: 20_000 }
      )
      .toBe(true)
    const floatPage = app
      .windows()
      .find((candidate) => candidate !== page && candidate.url().includes('bpFloat'))
    expect(floatPage).toBeTruthy()
    await expect(floatPage!.locator('.bp-float')).toBeVisible()
    await expect(floatPage!.getByRole('button', { name: '收回卡片架' })).toBeVisible()

    await floatPage!.getByRole('button', { name: '收回卡片架' }).click()

    // 浮窗消失，卡片回到缩略形态；页面没有重载（born 不变、ticks 增长）。
    await expect.poll(floatShells, { timeout: 20_000 }).toBe(0)
    await expect(card).toHaveAttribute('data-presentation', 'shelved', { timeout: 20_000 })
    await expect(card.locator('.web-card__chip')).toHaveText('已收纳')
    await expect(card.locator('.web-card__image')).toBeVisible({ timeout: 25_000 })

    const bornAfter = await page.evaluate(
      async (id) => window.brewphase.browserTabs.executeOnTab(id, 'window.__born'),
      tabId!
    )
    const ticks = await page.evaluate(
      async (id) => window.brewphase.browserTabs.executeOnTab(id, 'window.__ticks'),
      tabId!
    )
    expect(bornAfter).toBe(bornBefore)
    expect(Number(ticks)).toBeGreaterThan(0)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('加载中与加载失败：状态如实显示，不伪造预览', async () => {
  const { app, page, dataDir } = await launch()
  try {
    await page.getByRole('button', { name: '添加网页' }).click()
    const form = page.locator('.web-card--editing').last()
    await form.locator('input').fill(fixture.url('/slow'))
    await form.getByRole('button', { name: '打开' }).click()

    const card = page.locator('.web-card:not(.web-card--editing)').last()
    await expect(card.locator('.web-card__chip')).toHaveText('加载中', { timeout: 10_000 })
    await expect(card.locator('.web-card__spinner')).toBeVisible()

    await expect(card.locator('.web-card__chip')).toHaveText('已收纳', { timeout: 25_000 })
    await expect(card.locator('.web-card__image')).toBeVisible({ timeout: 25_000 })

    // 失败页：卡片进入错误态，保留占位而不是假图。
    await page.getByRole('button', { name: '添加网页' }).click()
    const broken = page.locator('.web-card--editing').last()
    await broken.locator('input').fill('http://127.0.0.1:1/unreachable')
    await broken.getByRole('button', { name: '打开' }).click()
    const brokenCard = page.locator('.web-card:not(.web-card--editing)').last()
    await expect(brokenCard.locator('.web-card__chip')).toHaveText('加载失败', { timeout: 20_000 })
    await expect(brokenCard.locator('.web-card__image')).toHaveCount(0)
    await expect(brokenCard.locator('.web-card__preview-error')).toHaveText('加载失败')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
