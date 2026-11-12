import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { pinLocale } from './locale'
import { seedEmptyDatabase } from './studio-seed'

/**
 * Personal Direction 的端到端验收。
 *
 * 两个场景对着规格里两条最容易做错的规则：
 *
 * 1. **首次引导不要求填满**：四步都能跳过，填了什么就存什么。
 * 2. **AI 写的东西必须经用户确认**：直接往库里插一条 Agent 的 `proposed`，
 *    界面只能把它显示成「待确认」；点确认之后它才成为正式方向。
 *    这条如果失效，整个「AI 不替用户决定人生目标」的承诺就没了。
 */

const visual = Boolean(process.env.VISUAL_CHECK)

/** 视觉验收用：`VISUAL_CHECK=1` 时把面板截到 /tmp，供人工看配色与密度。 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!visual) return
  await page.addStyleTag({ content: '*{transition:none !important;animation:none !important}' })
  // 面板在 desk 之下，先滚进视口再截，否则截到的是三栏。
  await page.locator('.direction').scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  await page.screenshot({ path: `/tmp/direction-${name}.png` })
}

function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  // 首次引导会挡住首页；这两个变量在 CI 上可能被外部设置，必须清掉。
  delete env.BREWPHASE_FORCE_ONBOARDING
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function launch(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(userDataDir)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page }
}

/** 直接往临时库里塞一条 Agent 提议，模拟 WorkBuddy 经 MCP 写入的结果。 */
function insertProposedDirection(appData: string, title: string): void {
  const db = new Database(join(appData, 'brewphase.db'))
  const now = Date.now()
  db.prepare(
    `insert into directions
       (id, title, description, motivation, time_horizon, outcomes, constraints, status, source, created_at, updated_at)
     values (?, ?, '', '', '', '[]', '', 'proposed', 'agent', ?, ?)`
  ).run('11111111-2222-4333-8444-555555555555', title, now, now)
  db.close()
}

test('首次引导：写下现状、方向与阶段，并能在面板上继续操作', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'bp-direction-e2e-'))
  seedEmptyDatabase(dir)
  const { app, page } = await launch(dir)

  try {
    // 空态：还没有任何方向
    await expect(page.locator('.direction__empty')).toBeVisible()

    await page.getByRole('button', { name: '开始梳理' }).click()

    // 第一步：现状（只填一句话，验证「不要求填满」）
    await page
      .getByPlaceholder('例如：有一份稳定的工作，业余时间想把自己的产品做出来。')
      .fill('有一份稳定的工作，业余时间在做自己的产品。')
    await page.getByRole('button', { name: '下一步', exact: true }).click()

    // 第二步：方向
    await page.getByPlaceholder('例如：成为一名独立开发者').fill('成为独立开发者')
    await page.getByRole('button', { name: '下一步', exact: true }).click()

    // 第三步：阶段
    await page.getByPlaceholder('例如：发布第一个可以收费的版本').fill('发布第一个版本')
    await page.getByPlaceholder('怎么才算完成？写能被观察到的事。').fill('有 10 个人愿意付费')
    await page.getByRole('button', { name: '下一步', exact: true }).click()

    // 第四步：确认并保存
    await page.getByRole('button', { name: '保存', exact: true }).click()

    // 面板上出现方向卡，且带着当前阶段
    const card = page.locator('.direction__card')
    await expect(card).toHaveCount(1)
    await expect(card.locator('.direction__card-title')).toHaveText('成为独立开发者')
    await expect(card.locator('.direction__stage-name')).toHaveText('发布第一个版本')
    await expect(card.locator('.direction__badge')).toHaveText('进行中')

    // 现状也落下来了
    await expect(page.locator('.direction__state-body')).toContainText('有一份稳定的工作')

    // 暂停：状态就地变化，不跳页、不新开浮层
    await card.getByRole('button', { name: '暂停', exact: true }).click()
    await expect(card.locator('.direction__badge')).toHaveText('已暂停')

    await shoot(page, 'panel-light')

    // 深色下同一块面板必须仍然成立（卡片、徽章、虚线提案条都不许残留白底）
    await page.evaluate(() => localStorage.setItem('brewphase.desktop.theme', 'dark'))
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await shoot(page, 'panel-dark')

    // 刷新后仍在：说明是真的落库，不是内存状态
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('.direction__card-title')).toHaveText('成为独立开发者')
    await expect(page.locator('.direction__badge')).toHaveText('已暂停')
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Agent 的提议先停在待确认，用户点确认后才成为正式方向', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'bp-direction-proposal-'))
  seedEmptyDatabase(dir)
  insertProposedDirection(dir, '成为一个写东西的人')
  const { app, page } = await launch(dir)

  try {
    const proposal = page.locator('.direction__proposal')
    await expect(proposal).toBeVisible()
    await shoot(page, 'proposal')
    await expect(proposal).toContainText('成为一个写东西的人')
    // 提议阶段它还不是方向卡——面板上不能出现「已生效」的假象。
    await expect(page.locator('.direction__card')).toHaveCount(0)

    await proposal.getByRole('button', { name: '确认', exact: true }).click()

    await expect(page.locator('.direction__proposal')).toHaveCount(0)
    await expect(page.locator('.direction__card-title')).toHaveText('成为一个写东西的人')
    await expect(page.locator('.direction__badge')).toHaveText('进行中')
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
