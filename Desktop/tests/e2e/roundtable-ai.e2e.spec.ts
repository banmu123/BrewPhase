import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher, expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { pinLocale } from './locale'
import { startAIFixture, startWebFixture, type AIFixture, type WebFixture } from './web-fixture'

/**
 * 真实 WebCard 驱动的圆桌问答端到端验收（Phase 4.2）。
 *
 * 与 Phase 4.1 的根本区别：**没有平台选择器**。成员 = 用户拖进圆桌的
 * 真实 WebCard（tabId 身份）；平台由主进程 Registry 按实时 URL 识别；
 * 自动化跑在原始 WebContents 上。
 *
 * 链路真实性：BREWPHASE_AI_TEST_HOST 接缝把 ChatGPT / Claude 的 Adapter
 * 指向本地夹具页，probe → submit → poll 全部是生产代码。夹具助手消息
 * 回显真实输入，证明文本确实写进了那张卡片的编辑器。
 * 真实平台网页端验收见人工清单（自动化不冒充真实平台结论）。
 */

let ai: AIFixture
let generic: WebFixture

test.beforeAll(async () => {
  ai = await startAIFixture()
  generic = await startWebFixture()
})

test.afterAll(async () => {
  await ai.close()
  await generic.close()
})

function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    BREWPHASE_AI_TEST_HOST: ai.host,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.BREWPHASE_FORCE_ONBOARDING
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bp-roundtable-ai-'))
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(dataDir)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page, dataDir }
}

function shells(app: ElectronApplication, marker: 'bpRoundtable=' | 'bpFloat='): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes(marker))
}

async function roundtableShell(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 20_000 }).toBe(1)
  const shell = shells(app, 'bpRoundtable=')[0]
  await shell.waitForLoadState('domcontentloaded')
  await expect(shell.locator('.rt-window')).toBeVisible({ timeout: 20_000 })
  return shell
}

async function scrollToRoundtable(page: Page): Promise<void> {
  await page.locator('.roundtable').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(120)
}

/** 「添加网页」建立真实卡片：AI 夹具或普通页面。 */
async function addCard(page: Page, url: string): Promise<{ card: Locator; tabId: string }> {
  await page.locator('.web-shelf').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.getByRole('button', { name: '添加网页' }).click()
  const form = page.locator('.web-card--editing').last()
  await expect(form).toBeVisible()
  await form.locator('input').fill(url)
  await form.getByRole('button', { name: '打开' }).click()
  const card = page.locator('.web-card:not(.web-card--editing)').last()
  await expect(card).toBeVisible({ timeout: 20_000 })
  // 立刻取 tabId：`.last()` 是惰性 locator，等下一张卡建好再取会拿到别人的 id。
  const tabId = (await card.getAttribute('data-tab-id'))!
  return { card, tabId }
}

/** 合成 OS 拖拽：卡片 dragstart → 圆桌热区 dragover + drop → dragend。 */
async function dragCardToRoundtable(page: Page, tabId: string): Promise<void> {
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

test('成员识别：AI 卡可参与、普通卡是资料、登录页需要登录；只有 AI 卡出回答', async () => {
  test.setTimeout(70_000)
  const { app, page, dataDir } = await launch()
  try {
    const { tabId: gptTabId } = await addCard(page, `http://${ai.host}/chatgpt`)
    const { tabId: refTabId } = await addCard(page, `${generic.url('/reference')}`)
    const { tabId: loginTabId } = await addCard(page, `http://${ai.host}/chatgpt?mode=login`)

    await scrollToRoundtable(page)
    await dragCardToRoundtable(page, gptTabId)
    await dragCardToRoundtable(page, refTabId)
    await dragCardToRoundtable(page, loginTabId)
    await expect(page.locator('.roundtable__participant')).toHaveCount(3, { timeout: 15_000 })

    // —— 主进程 Registry 识别的三种结果 ——
    await expect(
      page.locator(`.roundtable__participant[data-tab-id="${gptTabId}"] .roundtable__member-state`)
    ).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
    await expect(
      page.locator(`.roundtable__participant[data-tab-id="${gptTabId}"] .roundtable__member-state`)
    ).toContainText('ChatGPT')
    await expect(
      page.locator(`.roundtable__participant[data-tab-id="${refTabId}"] .roundtable__member-state`)
    ).toHaveAttribute('data-state', 'reference', { timeout: 15_000 })
    await expect(
      page.locator(`.roundtable__participant[data-tab-id="${loginTabId}"] .roundtable__member-state`)
    ).toHaveAttribute('data-state', 'login-required', { timeout: 15_000 })
    await expect(
      page.locator(`.roundtable__participant[data-tab-id="${loginTabId}"] .roundtable__member-login`)
    ).toBeVisible()

    // 提问：AI 成员执行、登录成员如实显示需要登录、普通资料不参与。
    await page.locator('.roundtable__ask-input').fill('圆桌成员识别的验收问题')
    await expect(page.locator('.roundtable__ask-submit')).toBeEnabled()
    await page.locator('.roundtable__ask-submit').click()

    const answers = page.locator('.roundtable__answer')
    await expect(answers).toHaveCount(2, { timeout: 10_000 })
    await expect(page.locator('.roundtable__answer[data-state="completed"]')).toHaveCount(1, { timeout: 25_000 })
    const gptAnswer = page.locator('.roundtable__answer[data-state="completed"]')
    await expect(gptAnswer).toContainText('GPT-FIXTURE')
    await expect(gptAnswer).toContainText('圆桌成员识别的验收问题')
    // 登录页的卡如实显示需要登录，不伪造回答。
    await expect(page.locator('.roundtable__answer[data-state="login_required"]')).toHaveCount(1)
    // 普通资料卡没有回答卡。
    await expect(page.locator(`.roundtable__answer:has-text("${refTabId}")`)).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('同平台两张卡：两个独立成员、两份独立回答（tabId 区分，不串台）', async () => {
  test.setTimeout(70_000)
  const { app, page, dataDir } = await launch()
  try {
    const { tabId: firstTabId } = await addCard(page, `http://${ai.host}/chatgpt`)
    const { tabId: secondTabId } = await addCard(page, `http://${ai.host}/chatgpt`)
    await scrollToRoundtable(page)
    await dragCardToRoundtable(page, firstTabId)
    await dragCardToRoundtable(page, secondTabId)
    await expect(page.locator('.roundtable__participant')).toHaveCount(2, { timeout: 15_000 })

    // 两张同平台卡都是独立成员，且都识别为 ChatGPT。
    await expect(page.locator('.roundtable__participant .roundtable__member-state[data-state="ready"]')).toHaveCount(2, { timeout: 15_000 })

    await page.locator('.roundtable__ask-input').fill('同平台双卡并行的问题')
    await page.locator('.roundtable__ask-submit').click()

    // 两份回答卡、两个 tabId，内容都回显真实输入（两次真实写入）。
    await expect(page.locator('.roundtable__answer[data-state="completed"]')).toHaveCount(2, { timeout: 25_000 })
    const tabIds = await page.locator('.roundtable__answer .roundtable__answer-tabid').allTextContents()
    expect(new Set(tabIds).size).toBe(2)
    expect(tabIds.every((id) => id.startsWith('tab-'))).toBe(true)
    await expect(page.locator('.roundtable__answer').first()).toContainText('同平台双卡并行的问题')
    await expect(page.locator('.roundtable__answer').last()).toContainText('同平台双卡并行的问题')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('多平台并行：先完成者先显示；拆出独立窗口同步，归位不丢', async () => {
  test.setTimeout(80_000)
  const { app, page, dataDir } = await launch()
  try {
    const { tabId: gptTabId } = await addCard(page, `http://${ai.host}/chatgpt`)
    const { tabId: claudeTabId } = await addCard(page, `http://${ai.host}/claude`)
    await scrollToRoundtable(page)
    await dragCardToRoundtable(page, gptTabId)
    await dragCardToRoundtable(page, claudeTabId)
    await expect(page.locator('.roundtable__participant')).toHaveCount(2, { timeout: 15_000 })
    await expect(page.locator('.roundtable__participant .roundtable__member-state[data-state="ready"]')).toHaveCount(2, { timeout: 15_000 })

    await page.locator('.roundtable__ask-input').fill('多平台并行的问题')
    await page.locator('.roundtable__ask-submit').click()

    // ChatGPT 夹具 0.3s 出答案、Claude 4s：先完成者先显示。
    const gptAnswer = page.locator('.roundtable__answer', { hasText: 'ChatGPT' })
    const claudeAnswer = page.locator('.roundtable__answer', { hasText: 'Claude' })
    await expect(gptAnswer).toHaveAttribute('data-state', 'completed', { timeout: 25_000 })
    await expect(claudeAnswer).not.toHaveAttribute('data-state', 'completed')
    await expect(claudeAnswer).toHaveAttribute('data-state', 'completed', { timeout: 25_000 })
    await expect(claudeAnswer).toContainText('CLAUDE-FIXTURE')

    // —— 拆出：独立窗口拿到同一份成员与回答（广播 + hydration）——
    await page.getByRole('button', { name: '拆出为独立窗口' }).click()
    const shell = await roundtableShell(app)
    await expect(shell.locator('.roundtable__participant')).toHaveCount(2, { timeout: 15_000 })
    await expect(shell.locator('.roundtable__answer')).toHaveCount(2, { timeout: 25_000 })
    await expect(shell.locator('.roundtable__answer[data-state="completed"]')).toHaveCount(2)
    await expect(page.locator('.roundtable--slot')).toContainText('本轮讨论已完成', { timeout: 15_000 })

    // —— 归位：回答原样回到主窗口 ——
    await shell.getByRole('button', { name: '圆桌归位' }).click()
    await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 15_000 }).toBe(0)
    await scrollToRoundtable(page)
    await expect(page.locator('.roundtable__answer')).toHaveCount(2)
    await expect(page.locator('.roundtable__answer').first()).toContainText('GPT-FIXTURE')
    await expect(page.locator('.roundtable__answer').last()).toContainText('CLAUDE-FIXTURE')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('独立窗口发起提问：主窗口占位区同步进度；成员状态两窗口一致', async () => {
  test.setTimeout(80_000)
  const { app, page, dataDir } = await launch()
  try {
    const { tabId: gptTabId } = await addCard(page, `http://${ai.host}/chatgpt`)
    await scrollToRoundtable(page)
    await dragCardToRoundtable(page, gptTabId)
    await expect(page.locator('.roundtable__participant .roundtable__member-state[data-state="ready"]')).toHaveCount(1, { timeout: 15_000 })

    // 拆出前先写好草稿；拆出后成员状态与草稿在独立窗口原样出现。
    await page.locator('.roundtable__ask-input').fill('独立窗口发起的问题')
    await page.getByRole('button', { name: '拆出为独立窗口' }).click()
    const shell = await roundtableShell(app)
    await expect(shell.locator('.roundtable__participant .roundtable__member-state[data-state="ready"]')).toHaveCount(1, { timeout: 15_000 })
    await expect(shell.locator('.roundtable__ask-input')).toHaveValue('独立窗口发起的问题', { timeout: 15_000 })

    // 独立窗口发起：主窗口占位区同步进度与完成。
    await shell.locator('.roundtable__ask-submit').click()
    await expect(page.locator('.roundtable--slot')).toContainText('讨论进行中', { timeout: 20_000 })
    await expect(shell.locator('.roundtable__answer[data-state="completed"]')).toHaveCount(1, { timeout: 30_000 })
    await expect(shell.locator('.roundtable__answer')).toContainText('独立窗口发起的问题')
    await expect(page.locator('.roundtable--slot')).toContainText('本轮讨论已完成', { timeout: 15_000 })

    // 归位后主窗口拿到同一份回答；草稿未被提交清空。
    await shell.getByRole('button', { name: '圆桌归位' }).click()
    await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 15_000 }).toBe(0)
    await scrollToRoundtable(page)
    await expect(page.locator('.roundtable__answer')).toContainText('独立窗口发起的问题')
    await expect(page.locator('.roundtable__ask-input')).toHaveValue('独立窗口发起的问题')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
