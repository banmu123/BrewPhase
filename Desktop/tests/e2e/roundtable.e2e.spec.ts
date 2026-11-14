import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher, expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { pinLocale } from './locale'
import { startWebFixture, type WebFixture } from './web-fixture'

/**
 * 网页卡片架 + AI 圆桌的端到端验收（Phase 2：卡片 = 真实标签）。
 *
 * 卡片不再是本地模拟数据：每张卡必须对应一个真实 WebContents。这里的断言
 * 用本地 fixture 页面（真实导航、真实绘制、真实截图），不依赖外网与登录。
 *
 * 指针仍然走真实鼠标链路；拖出窗口的部分在 web-cards.e2e 里用屏幕坐标事件
 * 覆盖（Playwright 的鼠标无法离开窗口，这一点在人工验收清单里注明）。
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
  // 用 tabId 固定 locator：`.last()` 会随新卡片变化，不能跨步骤复用。
  const tabId = await card.getAttribute('data-tab-id')
  expect(tabId).toMatch(/^tab-/)
  return page.locator(`.web-card[data-tab-id="${tabId}"]`)
}

/** 真实指针拖拽：先把卡片架与目标都滚进视口（760px 视口下页面很长）。 */
async function dragCardTo(page: Page, from: Locator, to: Locator): Promise<void> {
  await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await to.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(140)
  const fromBox = await from.boundingBox()
  const toBox = await to.boundingBox()
  expect(fromBox).not.toBeNull()
  expect(toBox).not.toBeNull()
  await page.mouse.move(fromBox!.x + fromBox!.width / 2, fromBox!.y + fromBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(toBox!.x + toBox!.width / 2, toBox!.y + toBox!.height / 2, { steps: 10 })
  await page.mouse.up()
}

test('布局与卡片基础：空架引导、真实卡片、圆桌空态、关闭', async () => {
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

    // 圆桌空态：说明 + 两个座位暗示；输入未就绪。
    await expect(page.locator('.roundtable__empty-title')).toHaveText('把网页卡片放到这里')
    await expect(page.locator('.roundtable__seat')).toHaveCount(2)
    await expect(page.locator('.roundtable__ask-input')).toBeDisabled()
    await expect(page.locator('.roundtable__ask-submit')).toBeDisabled()

    const first = await addCard(page, '/a')
    await expect(page.locator('.web-card')).toHaveCount(1)
    await expect(page.locator('.web-shelf__guide')).toHaveCount(0)
    await expect(first.locator('.web-card__chip')).toHaveText('已收纳')

    // 再添加一张：两张都是真实标签，各自有 tabId。
    const second = await addCard(page, '/b')
    await expect(page.locator('.web-card')).toHaveCount(2)
    const firstId = await first.getAttribute('data-tab-id')
    const secondId = await second.getAttribute('data-tab-id')
    expect(firstId).not.toBeNull()
    expect(secondId).not.toBeNull()
    expect(firstId).not.toBe(secondId)

    // 关闭一张：真实标签被销毁，圆桌不受影响。
    await second.hover()
    await second.locator('.web-card__close').click()
    await expect(page.locator('.web-card')).toHaveCount(1)
    await expect(page.locator('.roundtable__participant')).toHaveCount(0)
    const tabs = await page.evaluate(() => window.brewphase.browser.state())
    expect(tabs.tabs).toHaveLength(1)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('拖入圆桌与移除：加入 ≠ 关闭，关闭同时摘座位', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const a = await addCard(page, '/a')
    const b = await addCard(page, '/b')

    await dragCardTo(page, a, page.locator('.roundtable__stage'))

    await expect(page.locator('.roundtable__participant')).toHaveCount(1)
    await expect(page.locator('.roundtable__participant', { hasText: 'fixture a' })).toBeVisible()
    await expect(page.locator('.roundtable__count')).toHaveText('1 位参与者')
    // 卡片仍在架上（加入 ≠ 关闭），并显示圆桌标记。
    await expect(page.locator('.web-card')).toHaveCount(2)
    await expect(page.locator('.web-card', { hasText: 'fixture a' }).locator('.web-card__roundtable-dot')).toHaveCount(1)

    await dragCardTo(page, b, page.locator('.roundtable__stage'))
    await expect(page.locator('.roundtable__participant')).toHaveCount(2)
    await expect(page.locator('.roundtable__ask-input')).toBeEnabled()

    await page.locator('.roundtable__ask-input').fill('想问的问题')

    // 移除一名参与者：网页不关闭。
    await page.locator('.roundtable__participant', { hasText: 'fixture a' }).getByRole('button', { name: '移除' }).click()
    await expect(page.locator('.roundtable__participant')).toHaveCount(1)
    await expect(page.locator('.web-card')).toHaveCount(2)

    // 关闭参与中的卡片：架与圆桌一起摘掉。
    const cardB = page.locator('.web-card', { hasText: 'fixture b' })
    await cardB.hover()
    await cardB.locator('.web-card__close').click()
    await expect(page.locator('.web-card')).toHaveCount(1)
    await expect(page.locator('.roundtable__participant')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('圆桌拖出浮动、移动、缩放与归位：状态全程保留', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const a = await addCard(page, '/a')
    const b = await addCard(page, '/b')

    const stage = page.locator('.roundtable__stage')
    for (const card of [a, b]) {
      await dragCardTo(page, card, stage)
    }
    await expect(page.locator('.roundtable__participant')).toHaveCount(2)

    await page.locator('.roundtable__ask-input').fill('圆桌的问题')

    await page.getByRole('button', { name: '独立展开' }).click()
    const floating = page.locator('.roundtable--floating')
    await expect(floating).toBeVisible()
    await expect(page.locator('.roundtable--slot')).toBeVisible()
    await expect(page.locator('.roundtable__slot-hint')).toHaveText('圆桌正在独立工作')
    await expect(floating.locator('.roundtable__participant')).toHaveCount(2)
    await expect(floating.locator('.roundtable__ask-input')).toHaveValue('圆桌的问题')

    const before = await floating.boundingBox()
    expect(before).not.toBeNull()
    await page.mouse.move(before!.x + 60, before!.y + 16)
    await page.mouse.down()
    await page.mouse.move(before!.x + 200, before!.y + 160, { steps: 8 })
    await page.mouse.up()
    const moved = await floating.boundingBox()
    expect(moved).not.toBeNull()
    expect(Math.abs(moved!.x - before!.x)).toBeGreaterThan(40)

    const sizeBefore = { w: moved!.width, h: moved!.height }
    await page.mouse.move(moved!.x + moved!.width - 6, moved!.y + moved!.height - 6)
    await page.mouse.down()
    await page.mouse.move(moved!.x + moved!.width + 120, moved!.y + moved!.height + 90, { steps: 6 })
    await page.mouse.up()
    const resized = await floating.boundingBox()
    expect(resized!.width).toBeGreaterThan(sizeBefore.w + 60)
    expect(resized!.height).toBeGreaterThan(sizeBefore.h + 40)

    await page.getByRole('button', { name: '圆桌归位', exact: true }).click()
    await expect(page.locator('.roundtable--floating')).toHaveCount(0)
    const docked = page.locator('.roundtable:not(.roundtable--slot):not(.roundtable--floating)')
    await expect(docked.locator('.roundtable__participant')).toHaveCount(2)
    await expect(docked.locator('.roundtable__ask-input')).toHaveValue('圆桌的问题')
    await expect(page.locator('.roundtable--slot')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('标题栏拖出（真实指针）与 Esc 取消拖入', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const a = await addCard(page, '/a')

    const head = page.locator('.roundtable__head')
    await head.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(160)
    const headBox = await head.boundingBox()
    expect(headBox).not.toBeNull()
    await page.mouse.move(headBox!.x + 90, headBox!.y + headBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(headBox!.x + 250, headBox!.y + 180, { steps: 6 })
    await page.mouse.up()
    await expect(page.locator('.roundtable--floating')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('.roundtable--floating')).toHaveCount(0)

    // Esc 取消未完成的卡片拖动：按下、移动、Esc → 不加入圆桌。
    await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.locator('.roundtable__stage').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(140)
    const cardBox = await a.boundingBox()
    const stageBox = await page.locator('.roundtable__stage').boundingBox()
    await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(stageBox!.x + stageBox!.width / 2, stageBox!.y + stageBox!.height / 2, { steps: 6 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(page.locator('.roundtable__participant')).toHaveCount(0)
    await expect(page.locator('.web-card[data-dragging="true"]')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('卡片架内拖动排序（真实指针）', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const alpha = await addCard(page, '/alpha')
    await addCard(page, '/beta')
    await addCard(page, '/gamma')

    const first = page.locator('.web-card').nth(0)
    const second = page.locator('.web-card').nth(1)
    await expect(first).toContainText('fixture alpha')
    await expect(second).toContainText('fixture beta')

    await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(140)
    const a = await first.boundingBox()
    const b = await second.boundingBox()
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2)
    await page.mouse.down()
    await page.mouse.move(b!.x + b!.width * 0.75, b!.y + b!.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(200)
    await expect(page.locator('.web-card').nth(0)).toContainText('fixture beta')
    await expect(page.locator('.web-card').nth(1)).toContainText('fixture alpha')
    // tabId 没有被顺序改写。
    expect(await alpha.getAttribute('data-tab-id')).toMatch(/^tab-/)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('顶栏不再有 AI Workspace 一级入口', async () => {
  const { app, page, dataDir } = await launch()
  try {
    await expect(page.getByRole('button', { name: 'AI Workspace' })).toHaveCount(0)
    await expect(page.locator('.topbar__brand')).toBeVisible()
    await expect(page.locator('.topbar__search')).toBeVisible()
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
