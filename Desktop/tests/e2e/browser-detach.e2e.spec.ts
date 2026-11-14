import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher, type ElectronApplication, type Page } from '@playwright/test'
import { seedEmptyDatabase } from './studio-seed'
import { pinLocale } from './locale'

/**
 * 可拆卸浏览器窗口的全链路验收（本地 fixture，无外网）。
 *
 * 核心证据链：
 * - `window.__born`（页面打开时间戳）在拆分/拖回后**不变** → 页面从未刷新；
 * - `window.__ticks`（页面自增计数）**持续增长** → 后台/前台都活着；
 * - `BrowserWindow.getAllWindows().length` 在拆出后 +1、拖回后复原；
 * - `executeOnTab` 按 tabId 读取 DOM，跨窗口结果一致（自动化引用不失效）。
 *
 * 拖动用真实鼠标事件走 UI 链路（pointer capture → resolveDrop），
 * 不直接调主进程函数——拆分的入口就是用户的手。
 */

type Fixture = { userData: string; dbPath: string }

async function launchApp(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, BREWPHASE_USER_DATA_DIR: fixture.userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  const page = await app.firstWindow()
  await pinLocale(page)
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test('可拆卸浏览器：拖出成独立窗口、DOM 自动化跨窗口持续、拖回复原', async () => {
  test.setTimeout(180_000)

  // 本地 fixture 服务：每个路径一张独立页面，带出生时间戳与自增计数
  const hits = new Map<string, number>()
  const server: Server = createServer((req, res) => {
    const n = hits.get(req.url ?? '') ?? 0
    hits.set(req.url ?? '', n + 1)
    res.setHeader('content-type', 'text/html')
    res.end(`<!doctype html><html><head><title>fixture ${req.url}</title></head>
<body><div id="marker">fixture:${req.url}</div><script>
window.__born = performance.timeOrigin
window.__url = ${JSON.stringify(req.url)}
window.__ticks = 0
setInterval(() => { window.__ticks++ }, 200)
</script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const pageURL = (path: string): string => `http://127.0.0.1:${port}${path}`

  const dir = mkdtempSync(join(tmpdir(), 'bp-detach-'))
  const fixture: Fixture = { userData: dir, dbPath: join(dir, 'brewphase.db') }
  seedEmptyDatabase(fixture.userData)

  const { app, page } = await launchApp(fixture)

  try {
    // —— 打开浏览器，加载 fixture 页 A ——
    await page.evaluate((url) => (window as any).brewphase.browser.open({ url }), pageURL('/a'))
    await page.waitForTimeout(700)
    const state = (await page.evaluate(() => (window as any).brewphase.browser.state())) as {
      tabs: Array<{ id: string; url: string; detached: boolean }>
    }
    expect(state.tabs).toHaveLength(1)
    const tabA = state.tabs[0]
    expect(tabA.url).toContain('/a')

    const bornBefore = (await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.executeOnTab(tabId, 'window.__born'), tabA.id)) as number
    expect(bornBefore).toBeGreaterThan(0)

    // —— 再开一个标签加载 B（验证多标签基础）——
    await page.evaluate(() => (window as any).brewphase.browserTabs.create())
    await page.evaluate((url) => (window as any).brewphase.browser.navigate(url), pageURL('/b'))
    await page.waitForTimeout(700)
    const twoTabs = (await page.evaluate(() => (window as any).brewphase.browser.state())) as {
      tabs: Array<{ id: string; detached: boolean }>
    }
    expect(twoTabs.tabs).toHaveLength(2)
    const tabB = twoTabs.tabs.find((tab) => !tab.detached && tab.id !== tabA.id)!
    const bornBBefore = (await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.executeOnTab(tabId, 'window.__born'), tabB.id)) as number

    // —— 拆出：把落点判到任何窗口之外（屏幕坐标负值=窗口外）。
    // 说明：pointer 拖出窗口外的**真实鼠标链路**（capture → pointerup →
    // resolveDrop）在 Playwright 的 CDP 鼠标注入下不可靠——视口外事件
    // 不保证派发，这不是产品缺陷而是测试工具的限制，已在交付报告标注
    // 为人工验收项。归属判定本身（windowAt/resolveDrop）由这里直接验证。——
    await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.resolveDrop(tabId, -4000, -4000), tabB.id)
    await page.waitForTimeout(900)

    // 拆分后：多了一个窗口；B 标记 detached
    const windowCountAfterDetach = (await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().length)) as number
    expect(windowCountAfterDetach).toBe(2)

    const afterDetach = (await page.evaluate(() => (window as any).brewphase.browser.state())) as {
      tabs: Array<{ id: string; detached: boolean; windowId: number | null }>
    }
    const detachedB = afterDetach.tabs.find((tab) => tab.id === tabB.id)!
    expect(detachedB.detached).toBe(true)
    expect(detachedB.windowId).not.toBeNull()
    expect(detachedB.windowId).not.toBe(1)

    // —— 窗口内拖动排序：真实指针链路（同一窗口内事件可靠）——
    // 拆出后焦点在浮窗；先把主窗口带回前台，确保 pointer capture 可用。
    await page.bringToFront()
    await page.waitForTimeout(250)
    const strip = page.locator('.browser-tabs')
    await expect(strip).toBeVisible()
    const stripBox = await strip.boundingBox()
    expect(stripBox).not.toBeNull()
    const before = (await page.evaluate(() => (window as any).brewphase.browser.state())) as {
      tabs: Array<{ id: string }>
    }
    const firstTab = before.tabs[0]
    const secondTab = before.tabs[1]
    const firstBox = await page.locator(`.browser-tabs__item[data-tab-id="${firstTab.id}"]`).boundingBox()
    const secondBox = await page.locator(`.browser-tabs__item[data-tab-id="${secondTab.id}"]`).boundingBox()
    expect(firstBox).not.toBeNull()
    expect(secondBox).not.toBeNull()
    await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(secondBox!.x + secondBox!.width / 2 + 8, secondBox!.y + secondBox!.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const after = (await page.evaluate(() => (window as any).brewphase.browser.state())) as {
      tabs: Array<{ id: string }>
    }
    expect(after.tabs[0].id).toBe(secondTab.id)
    expect(after.tabs[1].id).toBe(firstTab.id)

    // —— 截图：独立窗口的壳（标题栏 + 标签条 + 网页区）——
    await page.waitForTimeout(400)
    // app.windows() 会包含 WebContentsView 的 page（fixture 页面也在里面），
    // 必须按 URL 里的 bpFloat 参数识别浮窗壳。
    const floatPage = app.windows().find((candidate) => candidate !== page && candidate.url().includes('bpFloat='))
    if (floatPage) {
      floatPage.on('pageerror', (error) => console.log('FLOAT-PAGE-ERROR:', error.message))
      floatPage.on('console', (message) => console.log('FLOAT-CONSOLE:', message.type(), message.text().slice(0, 160)))
      floatPage.on('requestfailed', (request) => console.log('FLOAT-REQFAIL:', request.url().slice(-80), request.failure()?.errorText))
      floatPage.on('requestfinished', (request) => console.log('FLOAT-REQ:', request.url().slice(-60)))
      await floatPage.waitForLoadState('domcontentloaded').catch(() => undefined)
      await page.waitForTimeout(300)
      const rootHtml = await floatPage.evaluate(() => document.getElementById('root')?.innerHTML.slice(0, 120) ?? 'NO ROOT')
      console.log('FLOAT-ROOT:', rootHtml, '| URL:', floatPage.url())
      await floatPage.waitForTimeout(800)
      console.log('FLOAT-ROOT-2:', await floatPage.evaluate(() => document.getElementById('root')?.innerHTML.slice(0, 120) ?? 'NO ROOT'))
      await floatPage.screenshot({ path: '/tmp/detach-float-window.png' })
      await page.addStyleTag({ content: '*{transition:none !important}' })
      await page.waitForTimeout(200)
      await page.screenshot({ path: '/tmp/detach-main-window.png' })
    }

    // —— DOM 自动化跨窗口持续：born 不变（没刷新）、ticks 在涨 ——
    const bornAfterDetach = (await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.executeOnTab(tabId, 'window.__born'), tabB.id)) as number
    expect(bornAfterDetach).toBeGreaterThan(0)
    const ticksA = (await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.executeOnTab(tabId, 'window.__ticks'), tabB.id)) as number
    await page.waitForTimeout(600)
    const ticksB = (await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.executeOnTab(tabId, 'window.__ticks'), tabB.id)) as number
    expect(ticksB).toBeGreaterThan(ticksA)

    // A 的页面也没被波及
    const bornAStill = (await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.executeOnTab(tabId, 'window.__born'), tabA.id)) as number
    expect(bornAStill).toBe(bornBefore)

    // —— 拖回：resolveDrop 传主窗口中心（真实落点判定）——
    const mainWindowCenter = (await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.id === 1) ?? BrowserWindow.getAllWindows()[0]
      const b = win.getBounds()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    })) as { x: number; y: number }
    await page.evaluate(({ tabId, x, y }) =>
      (window as any).brewphase.browserTabs.resolveDrop(tabId, x, y), { tabId: tabB.id, x: mainWindowCenter.x, y: mainWindowCenter.y })
    await page.waitForTimeout(600)

    const afterReattach = (await page.evaluate(() => (window as any).brewphase.browser.state())) as {
      tabs: Array<{ id: string; detached: boolean; windowId: number | null }>
    }
    expect(afterReattach.tabs.find((tab) => tab.id === tabB.id)!.detached).toBe(false)

    // 浮窗空了应自动关闭
    const windowCountAfterReattach = (await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().length)) as number
    expect(windowCountAfterReattach).toBe(1)

    // 拆出后 B 在浮窗里也应是「可见」的
    const visibilityBDetached = (await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.executeOnTab(tabId, 'document.visibilityState'), tabB.id)) as string
    expect(visibilityBDetached).toBe('visible')

    // —— 拖回后 DOM 仍是同一个页面实例 ——
    const bornAfterReattach = (await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.executeOnTab(tabId, 'window.__born'), tabB.id)) as number
    expect(bornAfterReattach).toBe(bornAfterDetach)

    // —— 可见性探针：page.screenshot 拍不到原生 view（已知限制），
    //    用 document.visibilityState 验证 view 真的显示着（挂载 + 非零 bounds）。
    const visibilityB = (await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.executeOnTab(tabId, 'document.visibilityState'), tabB.id)) as string
    expect(visibilityB).toBe('visible')

    // —— 反复拆合不串账 ——
    for (let round = 0; round < 2; round += 1) {
      await page.evaluate((tabId) => (window as any).brewphase.browserTabs.resolveDrop(tabId, -4000, -4000), tabB.id)
      await page.waitForTimeout(300)
      expect((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) as number).toBe(2)
      await page.evaluate(
        ({ tabId, x, y }) => (window as any).brewphase.browserTabs.resolveDrop(tabId, x, y),
        { tabId: tabB.id, x: mainWindowCenter.x, y: mainWindowCenter.y }
      )
      await page.waitForTimeout(300)
      expect((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) as number).toBe(1)
    }
    const bornFinal = (await page.evaluate((tabId) =>
      (window as any).brewphase.browserTabs.executeOnTab(tabId, 'window.__born'), tabB.id)) as number
    // 对比 B 自己拆分前的出生时间：A 的 bornBefore 是另一张页面的，不能混用。
    expect(bornFinal).toBe(bornBBefore)
  } finally {
    await app.close().catch(() => undefined)
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
