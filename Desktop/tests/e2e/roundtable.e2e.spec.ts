import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { pinLocale } from './locale'

/**
 * 网页卡片架 + AI 圆桌（Roundtable Phase 1）的端到端验收。
 *
 * 全部用独立 userData（不碰真实库），指针走真实 mouse 链路（与
 * browser-detach 同一手法：无 GPU 环境里 CDP 派发的 pointer 事件可靠）。
 *
 * 本阶段刻意不断言任何「AI 回答」——那是后续阶段的能力，现在假装有
 * 就是造假（参考 ai-workspace.e2e 的同一立场）。
 */

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

/** 把一张空白卡填成站点卡（内联表单）。 */
async function fillCard(page: Page, name: string, url: string): Promise<void> {
  const form = page.locator('.web-card--editing').last()
  await expect(form).toBeVisible()
  await form.locator('input').nth(0).fill(name)
  await form.locator('input').nth(1).fill(url)
  await form.getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.web-card--editing')).toHaveCount(0)
}

/** 真实指针拖拽：先把卡片架与目标都滚进视口（760px 视口下页面很长），
 * 再走 mouse 链路。与 browser-detach 的拖拽手法一致。 */
async function dragCardTo(page: Page, from: import('@playwright/test').Locator, to: import('@playwright/test').Locator): Promise<void> {
  await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await to.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(120)
  const fromBox = await from.boundingBox()
  const toBox = await to.boundingBox()
  expect(fromBox).not.toBeNull()
  expect(toBox).not.toBeNull()
  await page.mouse.move(fromBox!.x + fromBox!.width / 2, fromBox!.y + fromBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(toBox!.x + toBox!.width / 2, toBox!.y + toBox!.height / 2, { steps: 8 })
  await page.mouse.up()
}

test('布局与卡片基础：默认一张空白卡、圆桌空态、添加与关闭', async () => {
  const { app, page, dataDir } = await launch()
  try {
    // 布局：卡片架在三栏下方，圆桌在卡片架下方（规格 §10）。
    const desk = await page.locator('.studio-desk').boundingBox()
    const shelf = await page.locator('.web-shelf').boundingBox()
    const table = await page.locator('.roundtable').boundingBox()
    expect(desk).not.toBeNull()
    expect(shelf).not.toBeNull()
    expect(table).not.toBeNull()
    expect(shelf!.y).toBeGreaterThan(desk!.y + desk!.height - 40)
    expect(table!.y).toBeGreaterThan(shelf!.y)

    // 默认只有一张空白卡：直接以内联表单呈现（引导填写）。
    await expect(page.locator('.web-card')).toHaveCount(1)
    await expect(page.locator('.web-card--editing')).toHaveCount(1)

    // 圆桌空态：说明 + 两个座位暗示；输入未就绪。
    await expect(page.locator('.roundtable__empty-title')).toHaveText('把网页卡片放到这里')
    await expect(page.locator('.roundtable__seat')).toHaveCount(2)
    await expect(page.locator('.roundtable__ask-input')).toBeDisabled()
    await expect(page.locator('.roundtable__ask-submit')).toBeDisabled()

    // 填第一张卡 + 添加第二张再填：两张就绪卡。
    await fillCard(page, 'ChatGPT', 'https://chatgpt.com')
    await page.getByRole('button', { name: '添加网页' }).click()
    await expect(page.locator('.web-card')).toHaveCount(2)
    await fillCard(page, 'Claude', 'https://claude.ai')
    await expect(page.locator('.web-card__chip[data-tone="empty"]')).toHaveCount(0)

    // 关闭一张：架上少一张，圆桌不动（无参与者）。
    await page.locator('.web-card', { hasText: 'Claude' }).hover()
    await page.locator('.web-card', { hasText: 'Claude' }).locator('.web-card__close').click()
    await expect(page.locator('.web-card')).toHaveCount(1)
    await expect(page.locator('.roundtable__participant')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('拖入圆桌与移除：加入 ≠ 关闭，关闭同时摘座位', async () => {
  const { app, page, dataDir } = await launch()
  try {
    await fillCard(page, 'ChatGPT', 'https://chatgpt.com')
    await page.getByRole('button', { name: '添加网页' }).click()
    await fillCard(page, 'Claude', 'https://claude.ai')

    // 拖第一张卡到圆桌舞台：真实指针链路。
    await dragCardTo(page, page.locator('.web-card', { hasText: 'ChatGPT' }), page.locator('.roundtable__stage'))

    await expect(page.locator('.roundtable__participant')).toHaveCount(1)
    await expect(page.locator('.roundtable__participant', { hasText: 'ChatGPT' })).toBeVisible()
    await expect(page.locator('.roundtable__count')).toHaveText('1 位参与者')
    // 卡片仍在架上（加入 ≠ 关闭）。
    await expect(page.locator('.web-card')).toHaveCount(2)
    await expect(page.locator('.web-card', { hasText: 'ChatGPT' }).locator('.web-card__chip')).toHaveText('在圆桌上')

    // 拖入第二张 → 有参与者后输入就绪。
    await dragCardTo(page, page.locator('.web-card', { hasText: 'Claude' }), page.locator('.roundtable__stage'))
    await expect(page.locator('.roundtable__participant')).toHaveCount(2)
    await expect(page.locator('.roundtable__ask-input')).toBeEnabled()

    // 输入草稿（归位不丢的验证素材）。
    await page.locator('.roundtable__ask-input').fill('想问的问题')

    // 移除一名参与者：卡片仍在架上。
    await page.locator('.roundtable__participant', { hasText: 'ChatGPT' }).getByRole('button', { name: '移除' }).click()
    await expect(page.locator('.roundtable__participant')).toHaveCount(1)
    await expect(page.locator('.web-card')).toHaveCount(2)

    // 关闭参与中的卡片：架与圆桌一起摘掉（规格 §5）。
    await page.locator('.web-card', { hasText: 'Claude' }).hover()
    await page.locator('.web-card', { hasText: 'Claude' }).locator('.web-card__close').click()
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
    await fillCard(page, 'ChatGPT', 'https://chatgpt.com')
    await page.getByRole('button', { name: '添加网页' }).click()
    await fillCard(page, 'Claude', 'https://claude.ai')

    const stage = page.locator('.roundtable__stage')
    for (const name of ['ChatGPT', 'Claude']) {
      await dragCardTo(page, page.locator('.web-card', { hasText: name }), stage)
    }
    await expect(page.locator('.roundtable__participant')).toHaveCount(2)

    // 输入草稿：归位后不能丢（规格 §4.4）。
    await page.locator('.roundtable__ask-input').fill('圆桌的问题')

    // 「独立展开」按钮拖出浮动面板。
    await page.getByRole('button', { name: '独立展开' }).click()
    const floating = page.locator('.roundtable--floating')
    await expect(floating).toBeVisible()
    // 停靠位留下占位提示。
    await expect(page.locator('.roundtable--slot')).toBeVisible()
    await expect(page.locator('.roundtable__slot-hint')).toHaveText('圆桌正在独立工作')
    // 参与者与草稿都在。
    await expect(floating.locator('.roundtable__participant')).toHaveCount(2)
    await expect(floating.locator('.roundtable__ask-input')).toHaveValue('圆桌的问题')

    // 标题栏拖动整块移动：先读位置，拖一段，位置应改变。
    const before = await floating.boundingBox()
    expect(before).not.toBeNull()
    await page.mouse.move(before!.x + 60, before!.y + 16)
    await page.mouse.down()
    await page.mouse.move(before!.x + 200, before!.y + 160, { steps: 8 })
    await page.mouse.up()
    const moved = await floating.boundingBox()
    expect(moved).not.toBeNull()
    expect(Math.abs(moved!.x - before!.x)).toBeGreaterThan(40)

    // 右下角缩放：面板变大。
    const sizeBefore = { w: moved!.width, h: moved!.height }
    await page.mouse.move(moved!.x + moved!.width - 6, moved!.y + moved!.height - 6)
    await page.mouse.down()
    await page.mouse.move(moved!.x + moved!.width + 120, moved!.y + moved!.height + 90, { steps: 6 })
    await page.mouse.up()
    const resized = await floating.boundingBox()
    expect(resized!.width).toBeGreaterThan(sizeBefore.w + 60)
    expect(resized!.height).toBeGreaterThan(sizeBefore.h + 40)

    // 归位：参与者、草稿全保留。（exact：✕ 按钮的 aria-label 也含「归位」。）
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
    await fillCard(page, 'ChatGPT', 'https://chatgpt.com')

    // 按住停靠圆桌标题栏拖过阈值 → 浮出。
    const head = page.locator('.roundtable__head')
    const headBox = await head.boundingBox()
    expect(headBox).not.toBeNull()
    await page.mouse.move(headBox!.x + 90, headBox!.y + headBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(headBox!.x + 250, headBox!.y + 180, { steps: 6 })
    await page.mouse.up()
    await expect(page.locator('.roundtable--floating')).toBeVisible()

    // Esc 在浮动态 = 归位。
    await page.keyboard.press('Escape')
    await expect(page.locator('.roundtable--floating')).toHaveCount(0)

    // Esc 取消未完成的卡片拖动：按下、移动、Esc → 不加入圆桌。
    await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.locator('.roundtable__stage').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(120)
    const card = page.locator('.web-card', { hasText: 'ChatGPT' })
    const cardBox = await card.boundingBox()
    const stageBox = await page.locator('.roundtable__stage').boundingBox()
    await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(stageBox!.x + stageBox!.width / 2, stageBox!.y + stageBox!.height / 2, { steps: 6 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(page.locator('.roundtable__participant')).toHaveCount(0)
    // 拖动状态被清理：卡片恢复普通外观。
    await expect(page.locator('.web-card[data-dragging="true"]')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('卡片架内拖动排序（真实指针）', async () => {
  const { app, page, dataDir } = await launch()
  try {
    await fillCard(page, 'Alpha', 'https://alpha.com')
    await page.getByRole('button', { name: '添加网页' }).click()
    await fillCard(page, 'Beta', 'https://beta.com')
    await page.getByRole('button', { name: '添加网页' }).click()
    await fillCard(page, 'Gamma', 'https://gamma.com')

    // 把第一张（Alpha）拖到第二张（Beta）右半边：插到 Beta 之后，顺序互换。
    // （拖到中心会判定为「插到前面」——Alpha 本就在前，是 no-op，语义如此。）
    const first = page.locator('.web-card').nth(0)
    const second = page.locator('.web-card').nth(1)
    await expect(first).toContainText('Alpha')
    await expect(second).toContainText('Beta')
    await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(120)
    const a = await first.boundingBox()
    const b = await second.boundingBox()
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2)
    await page.mouse.down()
    await page.mouse.move(b!.x + b!.width * 0.75, b!.y + b!.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(150)
    await expect(page.locator('.web-card').nth(0)).toContainText('Beta')
    await expect(page.locator('.web-card').nth(1)).toContainText('Alpha')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('顶栏不再有 AI Workspace 一级入口（Roundtable Phase 1）', async () => {
  const { app, page, dataDir } = await launch()
  try {
    await expect(page.getByRole('button', { name: 'AI Workspace' })).toHaveCount(0)
    // 品牌与搜索仍在，导航没有因此塌掉。
    await expect(page.locator('.topbar__brand')).toBeVisible()
    await expect(page.locator('.topbar__search')).toBeVisible()
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
