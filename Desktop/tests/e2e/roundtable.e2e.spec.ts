import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher, expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { pinLocale } from './locale'
import { startWebFixture, type WebFixture } from './web-fixture'

/**
 * 网页卡片架 + AI 圆桌的端到端验收（Phase 3：圆桌是主进程唯一状态的真实窗口）。
 *
 * 卡片仍是真实标签（Phase 2 铁律）；圆桌不再是应用内 fixed 浮层——
 * 拆出后是一个真正的 Electron BrowserWindow（`#bpRoundtable` 路由），
 * 与主窗口通过主进程 RoundtableService 同步。
 *
 * 拖拽链路说明：Playwright 无法产生真实 OS 拖拽会话，这里用合成 DragEvent
 * 走渲染层完整链路（dragstart → drop/dragend），「窗口外松手」用主进程
 * 测试钩子注入假光标（与 web-cards.e2e 同一套路径）。OS 级真实鼠标拖动
 * 见人工验收清单。
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

async function launch(): Promise<{ app: ElectronApplication; page: Page; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bp-roundtable-'))
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(dataDir)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page, dataDir }
}

/** 通过卡片架的「添加网页」建立一张真实网页卡片（本地 fixture）。 */
async function addCard(page: Page, path: string): Promise<Locator> {
  await page.getByRole('button', { name: '添加网页' }).click()
  const form = page.locator('.web-card--editing').last()
  await expect(form).toBeVisible()
  await form.locator('input').fill(fixture.url(path))
  await form.getByRole('button', { name: '打开' }).click()
  const card = page.locator('.web-card:not(.web-card--editing)').last()
  await expect(card).toBeVisible({ timeout: 20_000 })
  // 标题来自真实页面 <title>：证明卡片不是本地拼出来的。
  await expect(card).toContainText(`fixture ${path.replace(/^\//, '')}`, { timeout: 20_000 })
  const tabId = await card.getAttribute('data-tab-id')
  expect(tabId).toMatch(/^tab-/)
  return page.locator(`.web-card[data-tab-id="${tabId}"]`)
}

/** 注入 / 清除假光标（仅打包版之外的构建存在这个钩子）。 */
async function setFakeCursor(app: ElectronApplication, point: { x: number; y: number } | null): Promise<void> {
  await app.evaluate((_, value) => {
    const hooks = (globalThis as unknown as {
      __bpTestHooks?: { setDragCursor: (p: { x: number; y: number } | null) => void }
    }).__bpTestHooks
    if (!hooks) throw new Error('test hooks missing (packaged build?)')
    hooks.setDragCursor(value)
  }, point)
}

/** 合成 OS 拖拽：卡片 dragstart → 圆桌热区 dragover + drop → dragend。 */
async function dragCardToRoundtable(page: Page, card: Locator): Promise<void> {
  const tabId = await card.getAttribute('data-tab-id')
  await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.locator('.roundtable').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(140)
  await page.evaluate((id) => {
    const cardEl = document.querySelector<HTMLElement>(`.web-card[data-tab-id="${id}"]`)
    const stage = document.querySelector<HTMLElement>('.roundtable__stage')
    if (!cardEl || !stage) throw new Error('card or stage not found')
    const rect = cardEl.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    cardEl.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 20, dataTransfer })
    )
    const stageRect = stage.getBoundingClientRect()
    stage.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: stageRect.left + 80, clientY: stageRect.top + 40, dataTransfer })
    )
    stage.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, clientX: stageRect.left + 80, clientY: stageRect.top + 40, dataTransfer })
    )
    cardEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
  }, tabId)
}

/** 合成 OS 拖拽：卡片 dragstart → 另一张卡 dragover + drop（排序）。 */
async function reorderCardsByDnD(page: Page, fromTabId: string, toTabId: string): Promise<void> {
  await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(140)
  await page.evaluate(
    ({ from, to }) => {
      const source = document.querySelector<HTMLElement>(`.web-card[data-tab-id="${from}"]`)
      const target = document.querySelector<HTMLElement>(`.web-card[data-tab-id="${to}"]`)
      if (!source || !target) throw new Error('card not found')
      const rect = source.getBoundingClientRect()
      const dataTransfer = new DataTransfer()
      source.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 20, dataTransfer })
      )
      const targetRect = target.getBoundingClientRect()
      target.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: targetRect.left + 10, clientY: targetRect.top + 40, dataTransfer })
      )
      target.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, clientX: targetRect.left + 10, clientY: targetRect.top + 40, dataTransfer })
      )
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
    },
    { from: fromTabId, to: toTabId }
  )
}

/** 找独立窗口壳页（bpFloat / bpRoundtable 路由）；数量与身份只按壳页算。 */
function shells(app: ElectronApplication, marker: 'bpFloat=' | 'bpRoundtable='): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes(marker))
}

async function roundtableShell(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 20_000 }).toBe(1)
  const shell = shells(app, 'bpRoundtable=')[0]
  await shell.waitForLoadState('domcontentloaded')
  await expect(shell.locator('.rt-window')).toBeVisible({ timeout: 20_000 })
  return shell
}

test('布局与卡片基础：空架引导、真实卡片、圆桌空态', async () => {
  const { app, page, dataDir } = await launch()
  try {
    // 布局：卡片架在三栏下方，圆桌在卡片架下方。
    const desk = await page.locator('.studio-desk').boundingBox()
    const shelf = await page.locator('.web-shelf').boundingBox()
    const table = await page.locator('.roundtable').boundingBox()
    expect(desk).not.toBeNull()
    expect(shelf).not.toBeNull()
    expect(table).not.toBeNull()
    expect(shelf!.y).toBeGreaterThan(desk!.y + desk!.height - 40)
    expect(table!.y).toBeGreaterThan(shelf!.y)

    // 首次进入：没有网页标签 → 引导卡，而不是一张假数据卡。
    await expect(page.locator('.web-shelf__guide')).toBeVisible()
    await expect(page.locator('.web-card')).toHaveCount(0)

    // 圆桌空态 + 关键入口（独立窗口按钮，键盘可达）。
    await page.locator('.roundtable').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await expect(page.locator('.roundtable__empty')).toBeVisible()
    await expect(page.getByRole('button', { name: '拆出为独立窗口' })).toBeVisible()
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('拖入圆桌：参与者是真实 tabId；关闭卡片自动摘除', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const card = await addCard(page, '/a')
    const tabId = (await card.getAttribute('data-tab-id'))!

    // OS 拖拽会话：卡片拖进圆桌热区松手 = 加入。
    await dragCardToRoundtable(page, card)
    await page.locator('.roundtable').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await expect(page.locator('.roundtable__participant')).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('.roundtable__participant-name')).toContainText('fixture a')
    await expect(card).toHaveAttribute('data-in-roundtable', 'true')

    // 主进程状态是唯一事实来源：快照里就是这一个 tabId。
    const snapshot = await page.evaluate(() => window.brewphase.roundtable.state())
    expect(snapshot.participantTabIds).toEqual([tabId])
    expect(snapshot.detached).toBe(false)

    // 排序与内部投放：卡片间 DnD 只改顺序，绝不能拆出窗口。
    const second = await addCard(page, '/b')
    const secondTabId = (await second.getAttribute('data-tab-id'))!
    await reorderCardsByDnD(page, tabId, secondTabId)
    const order = await page.evaluate(() => {
      return [...document.querySelectorAll<HTMLElement>('.web-card[data-tab-id]')]
        .map((el) => el.dataset.tabId)
    })
    expect(order).toEqual([tabId, secondTabId])
    await expect.poll(() => shells(app, 'bpFloat=').length, { timeout: 5_000 }).toBe(0)

    // 关闭卡片（真正的关闭）：参与者随之摘除，另一个标签不受影响。
    await card.hover()
    await card.locator('.web-card__close').click()
    await expect(page.locator(`.web-card[data-tab-id="${tabId}"]`)).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator('.roundtable__participant')).toHaveCount(0, { timeout: 15_000 })
    const after = await page.evaluate(() => window.brewphase.roundtable.state())
    expect(after.participantTabIds).toEqual([])
    await expect(second).toBeVisible()
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('圆桌拆出独立窗口：占位区、窗口壳、重复拆出只聚焦', async () => {
  const { app, page, dataDir } = await launch()
  try {
    await addCard(page, '/a')
    const card = await addCard(page, '/b')
    await dragCardToRoundtable(page, card)
    await expect(page.locator('.roundtable__participant')).toHaveCount(1, { timeout: 15_000 })

    // 按钮 = 键盘可达的拆出入口（同一主进程 detach 语义）。
    await page.getByRole('button', { name: '拆出为独立窗口' }).click()

    // 主窗口留下轻量占位区；不再是 fixed 浮层。
    await expect(page.locator('.roundtable--slot')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.roundtable--slot')).toContainText('圆桌正在独立窗口运行')
    await expect(page.locator('.roundtable--slot')).toContainText('1 位参与者')
    await expect(page.locator('.roundtable--floating')).toHaveCount(0)

    // 独立窗口：圆桌壳渲染完整正文（参与者 + 提问输入），没有 Studio Home。
    const shell = await roundtableShell(app)
    await expect(shell.locator('.roundtable__participant-name')).toContainText('fixture b')
    await expect(shell.locator('.roundtable__ask-input')).toBeVisible()
    await expect(shell.getByRole('button', { name: '圆桌归位' })).toBeVisible()
    expect(shell.url()).toContain('bpRoundtable=')

    // 主窗口的三空间不受影响。
    await expect(page.locator('.studio-home')).toBeVisible()

    // 重复拆出：只聚焦现有窗口，绝不创建第二个实例。
    await page.getByRole('button', { name: '重新打开' }).click()
    await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 10_000 }).toBe(1)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('跨窗口状态同步：参与者与草稿在两个窗口一致，归位后数据不丢', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const first = await addCard(page, '/a')
    const second = await addCard(page, '/b')
    await dragCardToRoundtable(page, first)
    await dragCardToRoundtable(page, second)
    await expect(page.locator('.roundtable__participant')).toHaveCount(2, { timeout: 15_000 })

    // 拆出前在主窗口写下草稿：主窗口 → 独立窗口的同步。
    await page.locator('.roundtable__ask-input').fill('两个窗口看同一份草稿')
    await page.getByRole('button', { name: '拆出为独立窗口' }).click()
    const shell = await roundtableShell(app)
    await expect(shell.locator('.roundtable__ask-input')).toHaveValue('两个窗口看同一份草稿', { timeout: 15_000 })
    await expect(shell.locator('.roundtable__participant')).toHaveCount(2, { timeout: 15_000 })

    // 独立窗口里移除参与者：主窗口占位区的人数同步减少。
    await shell.locator('.roundtable__participant').first().getByRole('button', { name: /移除/ }).click()
    await expect(page.locator('.roundtable--slot')).toContainText('1 位参与者', { timeout: 15_000 })

    // 独立窗口里改草稿：归位后在主窗口原样出现（独立窗口 → 主窗口同步）。
    await shell.locator('.roundtable__ask-input').fill('在独立窗口改的草稿')
    await shell.getByRole('button', { name: '圆桌归位' }).click()
    await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 15_000 }).toBe(0)
    await expect(page.locator('.roundtable:not(.roundtable--slot)')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.roundtable__ask-input')).toHaveValue('在独立窗口改的草稿', { timeout: 15_000 })
    await expect(page.locator('.roundtable__participant')).toHaveCount(1, { timeout: 15_000 })

    // 系统 ✕ = 归位（不是删状态）：再拆出、点系统关闭，数据仍在。
    // 走主进程 window.close()（与系统 ✕ 同路径，经由 'close' 事件归位）。
    await page.getByRole('button', { name: '拆出为独立窗口' }).click()
    const shell2 = await roundtableShell(app)
    const shell2Id = await app.evaluate(({ BrowserWindow }) => {
      const found = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes('bpRoundtable='))
      if (!found) throw new Error('roundtable window not found')
      return found.id
    })
    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.fromId(id)?.close()
    }, shell2Id)
    await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 15_000 }).toBe(0)
    await expect(page.locator('.roundtable:not(.roundtable--slot)')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.roundtable__ask-input')).toHaveValue('在独立窗口改的草稿', { timeout: 15_000 })
    await expect(page.locator('.roundtable__participant')).toHaveCount(1, { timeout: 15_000 })
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('圆桌标题栏拖出（OS 拖拽会话）：窗口外松手拆窗；手柄拖回占位区归位', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const card = await addCard(page, '/a')
    await dragCardToRoundtable(page, card)
    await expect(page.locator('.roundtable__participant')).toHaveCount(1, { timeout: 15_000 })

    // —— 拖出：标题栏 dragstart → 假光标在窗口外 → dragend ——
    const release = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0]
      const bounds = main?.getBounds() ?? { x: 100, y: 100 }
      return { x: bounds.x - 240, y: bounds.y + 300 }
    })
    await setFakeCursor(app, release)
    await page.locator('.roundtable').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.evaluate(() => {
      const head = document.querySelector<HTMLElement>('.roundtable__head')
      if (!head) throw new Error('roundtable head not found')
      head.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    })
    // 拆出提示出现在标题栏（光标已在窗口外）。
    await expect(page.locator('.roundtable__detach-hint')).toBeVisible({ timeout: 5_000 })
    await page.evaluate(() => {
      const head = document.querySelector<HTMLElement>('.roundtable__head')
      head?.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    })
    await setFakeCursor(app, null)

    const shell = await roundtableShell(app)
    await expect(page.locator('.roundtable--slot')).toBeVisible({ timeout: 15_000 })

    // —— 拖回：圆桌窗口手柄 dragstart → 主窗口占位区 drop → dragend ——
    await shell.evaluate(() => {
      const grip = document.querySelector<HTMLElement>('.rt-window__grip')
      if (!grip) throw new Error('grip not found')
      grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    })
    await page.evaluate(() => {
      const slot = document.querySelector<HTMLElement>('.roundtable--slot')
      if (!slot) throw new Error('slot not found')
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('application/x-brewphase-roundtable', '1')
      const rect = slot.getBoundingClientRect()
      slot.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 30, dataTransfer })
      )
      slot.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 30, dataTransfer })
      )
    })
    // 注意：drop 触发归位 → 圆桌窗口随即关闭，源窗口的 dragend 永远到不了。
    // 主进程在窗口关闭时强制收尾拖拽会话（否则会话单例会挡住下一次拖动）。

    // 归位：窗口消失、停靠态回来、参与者还在。
    await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 15_000 }).toBe(0)
    await expect(page.locator('.roundtable:not(.roundtable--slot)')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.roundtable__participant')).toHaveCount(1, { timeout: 15_000 })
    await expect(card).toHaveAttribute('data-in-roundtable', 'true')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('三类窗口共存：主窗口 + 独立浏览器 + 独立圆桌互不干扰', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const card = await addCard(page, '/a')
    const tabId = (await card.getAttribute('data-tab-id'))!
    await dragCardToRoundtable(page, card)
    await expect(page.locator('.roundtable__participant')).toHaveCount(1, { timeout: 15_000 })

    // 卡片拖出独立浏览器窗口。
    const release = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0]
      const bounds = main?.getBounds() ?? { x: 100, y: 100 }
      return { x: bounds.x - 200, y: bounds.y + 240 }
    })
    await setFakeCursor(app, release)
    await page.evaluate((id) => {
      const target = document.querySelector<HTMLElement>(`.web-card[data-tab-id="${id}"]`)
      if (!target) throw new Error('card not found')
      target.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    }, tabId)
    await expect(card).toHaveAttribute('data-dragging', 'true', { timeout: 5_000 })
    await page.evaluate((id) => {
      document
        .querySelector<HTMLElement>(`.web-card[data-tab-id="${id}"]`)
        ?.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    }, tabId)
    await setFakeCursor(app, null)
    await expect.poll(() => shells(app, 'bpFloat=').length, { timeout: 20_000 }).toBe(1)

    // 圆桌也拆出：两个独立窗口同时活着。
    await page.getByRole('button', { name: '拆出为独立窗口' }).click()
    await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 20_000 }).toBe(1)
    await expect.poll(() => shells(app, 'bpFloat=').length, { timeout: 10_000 }).toBe(1)

    // 主窗口仍可用：卡片架显示「独立窗口」状态，占位区在。
    await expect(page.locator('.studio-home')).toBeVisible()
    await expect(card).toHaveAttribute('data-presentation', 'detached')
    await expect(page.locator('.roundtable--slot')).toBeVisible()

    // 页面实例没有被复制：同一个 tabId 只有一个 WebContents。
    const tabCount = await page.evaluate(async () => (await window.brewphase.browser.state()).tabs.length)
    expect(tabCount).toBe(1)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
