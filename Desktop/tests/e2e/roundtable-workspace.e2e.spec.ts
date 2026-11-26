import { mkdtempSync, rmSync } from 'node:fs'

/** Windows：Electron 关闭后 db 句柄可能延迟释放；清理 userData 带重试。 */
function rmWithRetry(path: string, options: { recursive: boolean; force: boolean }): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(path, options)
      return
    } catch {
      if (attempt >= 5) {
        // Temp 下的 userData 清不掉只是磁盘残留（Windows 句柄延迟），
        // 与被测行为无关——警告即可，不能让清理掩盖测试结论。
        console.warn(`[cleanup] rmSync failed after retries: ${path}`)
        return
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    }
  }
}
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { pinLocale } from './locale'
import { startWebFixture, type WebFixture } from './web-fixture'

/**
 * 圆桌自由布局工作空间的端到端验收（Phase 4.2 workspace）。
 *
 * 核心断言原则（规格 §12.E）：**原生视图不靠截图或 DOM 快照判断**——
 * expectRoundtableViewsAlive 通过主进程测试钩子读取 RoundtableViewManager
 * 的托管账本：view 存活、visible、bounds 与布局一致、宿主窗口正确、
 * z-order 与面板顺序一致。
 */

let fixture: WebFixture

test.beforeAll(async () => {
  fixture = await startWebFixture()
})

test.afterAll(async () => {
  await fixture.close()
})

function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.BREWPHASE_FORCE_ONBOARDING
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function launchInto(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(dataDir)
  })
  // 卡片会话恢复后，恢复的网页（WebContentsView）可能先于主窗口出现在
  // windows() 列表里——firstWindow() 拿到的未必是壳窗口。遍历找真正渲染
  // .studio-home 的那一个。
  let page: Page | null = null
  await expect
    .poll(async () => {
      for (const candidate of app.windows()) {
        if ((await candidate.locator('.studio-home').count()) > 0) {
          page = candidate
          return true
        }
      }
      return false
    })
    .toBe(true)
  await pinLocale(page!, 'zh-CN')
  await expect(page!.locator('.studio-home')).toBeVisible()
  return { app, page: page! }
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bp-rt-workspace-'))
  const { app, page } = await launchInto(dataDir)
  return { app, page, dataDir }
}

/** 主进程测试钩子：原生视图托管账本 + 布局快照。 */
type ViewInfo = {
  tabId: string
  hostWindowId: number | null
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  destroyed: boolean
  order: number
}

async function readViews(app: ElectronApplication): Promise<ViewInfo[]> {
  return app.evaluate(() => {
    const hooks = (globalThis as unknown as {
      __bpTestHooks?: { roundtableViews?: () => ViewInfo[] }
    }).__bpTestHooks
    if (!hooks?.roundtableViews) throw new Error('test hooks missing (packaged build?)')
    return hooks.roundtableViews()
  })
}

/** 原生视图验收：存活、可见、有面积、宿主正确、z-order 升序无重复。 */
async function expectRoundtableViewsAlive(
  app: ElectronApplication,
  expected: { tabIds: string[]; hostWindowId: number | null; visible?: boolean }
): Promise<void> {
  await expect
    .poll(
      async () => {
        const views = await readViews(app)
        const byId = new Map(views.map((view) => [view.tabId, view]))
        let ok = true
        for (const tabId of expected.tabIds) {
          const view = byId.get(tabId)
          if (!view) ok = false
          else if (view.destroyed) ok = false
          else if (view.hostWindowId !== expected.hostWindowId) ok = false
          else if (expected.visible !== false && (!view.visible || view.bounds.width < 100 || view.bounds.height < 100)) ok = false
        }
        const hostedOrders = views.filter((view) => expected.tabIds.includes(view.tabId)).map((view) => view.order)
        if (hostedOrders.length !== expected.tabIds.length) ok = false
        if (new Set(hostedOrders).size !== hostedOrders.length) ok = false
        return ok
      },
      { timeout: 15_000 }
    )
    .toBe(true)
}

/** 原生 view bounds 与 DOM 内容区矩形对齐（±2px）。 */
async function expectBoundsFollowDom(app: ElectronApplication, page: Page, tabId: string): Promise<void> {
  const domRect = await page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(`.rt-panel[data-tab-id="${id}"] .rt-panel__content`)
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }, tabId)
  expect(domRect).not.toBeNull()
  await expect
    .poll(async () => {
      const views = await readViews(app)
      const view = views.find((item) => item.tabId === tabId)
      if (!view) return false
      return (
        Math.abs(view.bounds.x - domRect!.x) <= 2 &&
        Math.abs(view.bounds.y - domRect!.y) <= 2 &&
        Math.abs(view.bounds.width - domRect!.width) <= 2 &&
        Math.abs(view.bounds.height - domRect!.height) <= 2
      )
    })
    .toBe(true)
}

async function enterWorkspace(page: Page): Promise<void> {
  await page.locator('.roundtable').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.getByRole('button', { name: '进入工作空间' }).click()
  await expect(page.locator('.rt-workspace[data-host="docked"]')).toBeVisible({ timeout: 15_000 })
}

/** 工作空间内直接新建网页（真实 WebCard + join + 默认布局）。 */
async function addWebViaWorkspace(page: Page, url: string): Promise<string> {
  await page.locator('.rt-workspace__add > button').first().click()
  const input = page.locator('.rt-workspace__add-input')
  await input.fill(url)
  await page.locator('.rt-workspace__add-pop form button[type="submit"]').click()
  await expect(page.locator('.rt-panel').last()).toBeVisible({ timeout: 20_000 })
  const tabId = await page.locator('.rt-panel').last().getAttribute('data-tab-id')
  expect(tabId).toMatch(/^tab-/)
  return tabId!
}

/**
 * 窗口枚举（销毁竞态安全）：窗口关闭过程中 webContents 会先于窗口本身
 * 销毁——`isDestroyed()` 为 false 时 `getURL()` 仍可能抛「Object has been
 * destroyed」。全量回归时上一条用例的 teardown 与本条的轮询竞速，这里
 * 一律逐窗口 try/catch 跳过。
 */
async function windowIdByMarker(app: ElectronApplication, marker: 'main' | 'roundtable'): Promise<number | null> {
  return app.evaluate(({ BrowserWindow }, marker) => {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        const has = window.webContents.getURL().includes('bpRoundtable=')
        if ((marker === 'roundtable') === has) return window.id
      } catch {
        // 窗口正在销毁：跳过。
      }
    }
    return null
  }, marker)
}

async function mainWindowId(app: ElectronApplication): Promise<number> {
  const id = await windowIdByMarker(app, 'main')
  if (id === null) throw new Error('main window not found')
  return id
}

async function roundtableWindowId(app: ElectronApplication): Promise<number> {
  await expect.poll(() => windowIdByMarker(app, 'roundtable'), { timeout: 20_000 }).not.toBeNull()
  const id = await windowIdByMarker(app, 'roundtable')
  if (id === null) throw new Error('roundtable window not found')
  return id
}

/** 面板的屏幕矩形（getBoundingClientRect，同一窗口内可直接比较）。 */
async function screenRectOf(page: Page, tabId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.locator(`.rt-panel[data-tab-id="${tabId}"]`).evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
}

/** 防重叠契约：两块屏幕矩形不相交。getBoundingClientRect 带 subpixel
 * 误差（zoom/布局累积），边界相接（间隙 < 0.5px）不算重叠。 */
function assertNoOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): void {
  const EPS = 0.5
  const intersects =
    a.x < b.x + b.width - EPS &&
    b.x < a.x + a.width - EPS &&
    a.y < b.y + b.height - EPS &&
    b.y < a.y + a.height - EPS
  expect(intersects, `panels overlap! first=${JSON.stringify(a)} second=${JSON.stringify(b)}`).toBe(false)
}

test('工作空间：直接新建网页、原生视图跟随布局、拖动/缩放/置顶', async () => {
  test.setTimeout(80_000)
  const { app, page, dataDir } = await launch()
  try {
    const mainId = await mainWindowId(app)
    await enterWorkspace(page)

    const firstTab = await addWebViaWorkspace(page, `${fixture.url('/one')}`)
    const secondTab = await addWebViaWorkspace(page, `${fixture.url('/two')}`)
    await expect(page.locator('.rt-panel')).toHaveCount(2)

    // —— 原生视图验收：存活、可见、宿主 = 主窗口 ——
    await expectRoundtableViewsAlive(app, { tabIds: [firstTab, secondTab], hostWindowId: mainId })
    await expectBoundsFollowDom(app, page, firstTab)

    // —— 点击置顶：第二个面板在前；hook 的 order 反映 z ——
    await page.locator(`.rt-panel[data-tab-id="${secondTab}"]`).click()
    let views = await readViews(app)
    const firstView = views.find((view) => view.tabId === firstTab)!
    const secondView = views.find((view) => view.tabId === secondTab)!
    expect(secondView.order).toBeGreaterThan(firstView.order)

    // —— 真实鼠标拖动标题栏：位置更新、原生 bounds 跟随；拖到占用区域
    // 时防重叠解析把面板推到最近空位（绝不与另一面板叠上）——
    const titlebar = page.locator(`.rt-panel[data-tab-id="${firstTab}"] .rt-panel__titlebar`)
    const box = (await titlebar.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2 + 140, { steps: 8 })
    await page.mouse.up()
    await expectBoundsFollowDom(app, page, firstTab)
    assertNoOverlap(await screenRectOf(page, firstTab), await screenRectOf(page, secondTab))

    // —— 真实鼠标拖 se 手柄缩放 ——
    const handle = (await page.locator(`.rt-panel[data-tab-id="${firstTab}"] .rt-panel__handle--se`).boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 - 120, handle.y + handle.height / 2 - 80, { steps: 8 })
    await page.mouse.up()
    await expectBoundsFollowDom(app, page, firstTab)
    const width = await page.locator(`.rt-panel[data-tab-id="${firstTab}"]`).evaluate((el) => Number.parseInt(el.style.width, 10))
    expect(width).toBeLessThan(560)

    // —— 移除成员：面板消失、view 归还卡片架（park）、卡片仍在架上 ——
    await page.locator(`.rt-panel[data-tab-id="${secondTab}"] .rt-panel__action--remove`).click()
    await expect(page.locator(`.rt-panel[data-tab-id="${secondTab}"]`)).toHaveCount(0, { timeout: 15_000 })
    views = await readViews(app)
    expect(views.find((view) => view.tabId === secondTab)).toBeUndefined()
  } finally {
    await app.close()
    rmWithRetry(dataDir, { recursive: true, force: true })
  }
})

test('拆出与归位：同一批原生视图迁移宿主，布局不丢', async () => {
  test.setTimeout(80_000)
  const { app, page, dataDir } = await launch()
  try {
    await enterWorkspace(page)
    const firstTab = await addWebViaWorkspace(page, `${fixture.url('/a')}`)
    const secondTab = await addWebViaWorkspace(page, `${fixture.url('/b')}`)
    const mainId = await mainWindowId(app)
    await expectRoundtableViewsAlive(app, { tabIds: [firstTab, secondTab], hostWindowId: mainId })

    // 拖动第一个面板到一个可辨识的位置（落到占用区域会被推开，同样成立）。
    const titlebar = page.locator(`.rt-panel[data-tab-id="${firstTab}"] .rt-panel__titlebar`)
    const box = (await titlebar.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 90, { steps: 6 })
    await page.mouse.up()
    // 防抖落库：固定 400ms 在无 GPU 慢环境下不可靠（读到拖动前的旧位置，
    // 归位后却恢复了已落库的新位置，「一字不差」断言必炸）。改成等位置
    // 稳定——连续两次采样一致才算落库完成。
    const readLeft = (): Promise<number> =>
      page
        .locator(`.rt-panel[data-tab-id="${firstTab}"]`)
        .evaluate((el) => Number.parseInt(el.style.left, 10))
    await expect
      .poll(async () => {
        const a = await readLeft()
        await page.waitForTimeout(150)
        return a === (await readLeft()) ? a : Number.NaN
      }, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(0)
    const leftBeforeDetach = await readLeft()
    assertNoOverlap(await screenRectOf(page, firstTab), await screenRectOf(page, secondTab))

    // —— 拆出：视图宿主迁移到独立圆桌窗口（不创建、不销毁）——
    // 拆出入口就在工作空间头部（overlay 盖住了底下的圆桌区块）。
    await page.locator('.rt-workspace__head').getByRole('button', { name: '独立窗口' }).click()
    const rtId = await roundtableWindowId(app)
    await expectRoundtableViewsAlive(app, { tabIds: [firstTab, secondTab], hostWindowId: rtId })
    const shell = app.windows().find((window) => window.url().includes('bpRoundtable='))!
    await expect(shell.locator('.rt-panel')).toHaveCount(2, { timeout: 15_000 })
    await expectBoundsFollowDom(app, shell, firstTab)

    // —— 归位：视图迁回主窗口（工作空间随归位关闭），布局保留 ——
    await shell.getByRole('button', { name: '圆桌归位' }).click()
    await expect.poll(() => windowIdByMarker(app, 'roundtable'), { timeout: 15_000 }).toBeNull()
    await expectRoundtableViewsAlive(app, { tabIds: [firstTab, secondTab], hostWindowId: mainId, visible: false })

    // 重新进入工作空间：同一布局、同一批 view 再次可见（位置一字不差）。
    await enterWorkspace(page)
    await expect(page.locator('.rt-panel')).toHaveCount(2)
    const leftAfterDock = await page
      .locator(`.rt-panel[data-tab-id="${firstTab}"]`)
      .evaluate((el) => Number.parseInt(el.style.left, 10))
    expect(leftAfterDock).toBe(leftBeforeDetach)
    await expectRoundtableViewsAlive(app, { tabIds: [firstTab, secondTab], hostWindowId: mainId })
  } finally {
    await app.close()
    rmWithRetry(dataDir, { recursive: true, force: true })
  }
})

test('布局持久化：重启后布局与页面实例一起恢复（会话恢复），几何分毫不差', async () => {
  test.setTimeout(90_000)
  const dataDir = mkdtempSync(join(tmpdir(), 'bp-rt-persist-'))
  try {
    const first = await launchInto(dataDir)
    await enterWorkspace(first.page)
    const firstTab = await addWebViaWorkspace(first.page, `${fixture.url('/p1')}`)
    const secondTab = await addWebViaWorkspace(first.page, `${fixture.url('/p2')}`)
    // 拖到可辨识位置。
    const titlebar = first.page.locator(`.rt-panel[data-tab-id="${firstTab}"] .rt-panel__titlebar`)
    const box = (await titlebar.boundingBox())!
    await first.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await first.page.mouse.down()
    await first.page.mouse.move(box.x + box.width / 2 + 130, box.y + box.height / 2 + 60, { steps: 6 })
    await first.page.mouse.up()
    await first.page.waitForTimeout(500) // 防抖落库
    const savedLeft = await first.page.locator(`.rt-panel[data-tab-id="${firstTab}"]`).evaluate((el) => Number.parseInt(el.style.left, 10))
    const savedTabIds = [firstTab, secondTab]
    await first.app.close()

    // —— 重启（同一 userData）：卡片架会话恢复把 tabId 原样带回来，
    // 圆桌面板随之**直接复活**（不再是幽灵面板）——这是 Phase「会话恢复」
    // 的预期效果：布局与页面实例一步到位。布局几何保持用户拖后的位置。 ——
    const second = await launchInto(dataDir)
    try {
      await enterWorkspace(second.page)
      await expect(second.page.locator('.rt-panel')).toHaveCount(2, { timeout: 15_000 })
      await expect(second.page.locator('.rt-panel[data-ghost="true"]')).toHaveCount(0)
      const restoredLeft = await second.page.locator(`.rt-panel[data-tab-id="${firstTab}"]`).evaluate((el) => Number.parseInt(el.style.left, 10))
      expect(restoredLeft).toBe(savedLeft)

      // —— 原生视图跟着复活：真实 WebContents 回到原位跟随 DOM rects。 ——
      const mainId = await mainWindowId(second.app)
      await expectRoundtableViewsAlive(second.app, { tabIds: savedTabIds, hostWindowId: mainId })
      await expectBoundsFollowDom(second.app, second.page, firstTab)
      await expectBoundsFollowDom(second.app, second.page, secondTab)
    } finally {
      await second.app.close()
    }
  } finally {
    rmWithRetry(dataDir, { recursive: true, force: true })
  }
})

test('防重叠：把面板拖到另一个面板正中，落点被推到最近空位，绝不叠上', async () => {
  test.setTimeout(80_000)
  const { app, page, dataDir } = await launch()
  try {
    await enterWorkspace(page)
    const firstTab = await addWebViaWorkspace(page, `${fixture.url('/n1')}`)
    const secondTab = await addWebViaWorkspace(page, `${fixture.url('/n2')}`)
    await expectRoundtableViewsAlive(app, { tabIds: [firstTab, secondTab], hostWindowId: await mainWindowId(app) })

    const target = await screenRectOf(page, firstTab)
    const titlebar = page.locator(`.rt-panel[data-tab-id="${secondTab}"] .rt-panel__titlebar`)
    const box = (await titlebar.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    // 指针目标 = 第一个面板的几何中心：无防重叠时必然完全压住对方。
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(400) // 广播回放

    const first = await screenRectOf(page, firstTab)
    const second = await screenRectOf(page, secondTab)
    // 核心契约：无论怎么拖，两块面板不相交。
    assertNoOverlap(first, second)
    // 推开后的位置仍然对齐原生视图（bounds = DOM rects）。
    await expectBoundsFollowDom(app, page, secondTab)
    await expectBoundsFollowDom(app, page, firstTab)
  } finally {
    await app.close()
    rmWithRetry(dataDir, { recursive: true, force: true })
  }
})
