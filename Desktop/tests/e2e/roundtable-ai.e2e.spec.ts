import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { pinLocale } from './locale'
import { startAIFixture, type AIFixture } from './web-fixture'

/**
 * 圆桌 Multi-AI 并行问答的端到端验收（Phase 4.1）。
 *
 * 真实链路：BREWPHASE_AI_TEST_HOST 接缝把 ChatGPT / Claude 的 Adapter
 * 指向本地夹具页，probe → submit → poll 跑的是**生产代码**——包括
 * 「基线在发送前统计」「写入校验」「停止按钮消失 + 文本稳定」这些判定。
 * 夹具页的助手消息回显真实输入，证明文本确实写进了编辑器。
 *
 * 双窗口同步是本阶段的另一条主线：主窗口与圆桌独立窗口订阅同一份
 * ai-chat 广播，两边的任务状态必须一致（§4.1.5）。
 *
 * 真实 ChatGPT / Claude 网页端的验收（登录、真实账号回答）见
 * docs/testing/DESKTOP_AI_ROUNDTABLE_PHASE41_MANUAL_CHECKLIST.md，
 * 自动化不冒充真实网页端的结论。
 */

let fixture: AIFixture

test.beforeAll(async () => {
  fixture = await startAIFixture()
})

test.afterAll(async () => {
  await fixture.close()
})

function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    BREWPHASE_AI_TEST_HOST: fixture.host,
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

test('并行问答：同一问题双平台同时作答，先完成者先显示', async () => {
  test.setTimeout(70_000)
  const { app, page, dataDir } = await launch()
  try {
    await scrollToRoundtable(page)

    // 平台卡：两个平台默认全选；没有网页资料参与者也能直接提问。
    await expect(page.locator('.roundtable__platform')).toHaveCount(2)
    await expect(page.locator('.roundtable__platform[data-selected="true"]')).toHaveCount(2)

    await page.locator('.roundtable__ask-input').fill('圆桌并行提问的验收问题')
    await page.locator('.roundtable__ask-submit').click()

    // 忙碌态：开始按钮换成停止。
    await expect(page.locator('.roundtable__ask-submit--stop')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.roundtable__ask-busy')).toBeVisible()

    const gpt = page.locator('.roundtable__answer').nth(0)
    const claude = page.locator('.roundtable__answer').nth(1)

    // GPT 先完成（夹具 0.3s 出答案 + 稳定判定）；回答是 Markdown 且回显真实输入。
    await expect(gpt).toHaveAttribute('data-state', 'completed', { timeout: 25_000 })
    await expect(gpt.locator('.roundtable__answer-body h4')).toContainText('GPT 观点')
    await expect(gpt.locator('.roundtable__answer-body .md-ul').filter({ hasText: '收到的问题' })).toContainText('圆桌并行提问的验收问题')

    // 先完成者先显示：此刻 Claude 还在生成，绝不能已经完成。
    await expect(claude).not.toHaveAttribute('data-state', 'completed')

    // Claude 完成后各是各的回答（不合并、不串台）。
    await expect(claude).toHaveAttribute('data-state', 'completed', { timeout: 25_000 })
    await expect(claude.locator('.roundtable__answer-body h4')).toContainText('Claude 观点')
    await expect(claude.locator('.roundtable__answer-body .md-ul').filter({ hasText: '收到的问题' })).toContainText('圆桌并行提问的验收问题')

    // 单卡动作：复制 + 查看原网页。
    await expect(gpt.getByRole('button', { name: '复制回答' })).toBeVisible()
    await expect(gpt.getByRole('button', { name: '查看原网页' })).toBeVisible()

    // 提交不清空草稿：下一轮问题留在输入框。
    await expect(page.locator('.roundtable__ask-input')).toHaveValue('圆桌并行提问的验收问题')

    // —— 拆出：独立窗口拿到同一份任务状态（广播 + hydration）——
    await page.getByRole('button', { name: '拆出为独立窗口' }).click()
    const shell = await roundtableShell(app)
    const shellGpt = shell.locator('.roundtable__answer').nth(0)
    await expect(shellGpt).toHaveAttribute('data-state', 'completed', { timeout: 25_000 })
    await expect(shellGpt).toContainText('GPT-FIXTURE')
    await expect(shell.locator('.roundtable__answer').nth(1)).toContainText('CLAUDE-FIXTURE')
    // 主窗口占位区显示完成摘要（独立窗口运行时主窗口也看得到本轮状态）。
    await expect(page.locator('.roundtable--slot')).toContainText('本轮讨论已完成', { timeout: 15_000 })

    // —— 归位：回答原样回到主窗口 ——
    await shell.getByRole('button', { name: '圆桌归位' }).click()
    await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 15_000 }).toBe(0)
    await scrollToRoundtable(page)
    await expect(page.locator('.roundtable__answer').nth(0)).toHaveAttribute('data-state', 'completed')
    await expect(page.locator('.roundtable__answer').nth(0)).toContainText('GPT-FIXTURE')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('独立窗口发起提问：主窗口占位区同步显示进度与完成', async () => {
  test.setTimeout(70_000)
  const { app, page, dataDir } = await launch()
  try {
    // 先拆出（此时还没有任何任务），从独立窗口发起。
    await scrollToRoundtable(page)
    await page.getByRole('button', { name: '拆出为独立窗口' }).click()
    const shell = await roundtableShell(app)

    await shell.locator('.roundtable__ask-input').fill('独立窗口发起的问题')
    await shell.locator('.roundtable__ask-submit').click()

    // 主窗口占位区：任务进行中的摘要（§4.1.5 的反向同步）。
    await expect(page.locator('.roundtable--slot')).toContainText('讨论进行中', { timeout: 20_000 })

    // 独立窗口等到全部完成。
    await expect(shell.locator('.roundtable__answer').nth(0)).toHaveAttribute('data-state', 'completed', { timeout: 30_000 })
    await expect(shell.locator('.roundtable__answer').nth(1)).toHaveAttribute('data-state', 'completed', { timeout: 30_000 })
    await expect(shell.locator('.roundtable__answer').nth(1)).toContainText('独立窗口发起的问题')

    // 主窗口占位区转为完成摘要；归位后完整回答在主窗口出现。
    await expect(page.locator('.roundtable--slot')).toContainText('本轮讨论已完成', { timeout: 15_000 })
    await shell.getByRole('button', { name: '圆桌归位' }).click()
    await expect.poll(() => shells(app, 'bpRoundtable=').length, { timeout: 15_000 }).toBe(0)
    await scrollToRoundtable(page)
    await expect(page.locator('.roundtable__answer').nth(1)).toContainText('独立窗口发起的问题')

    // 独立窗口里改下一轮草稿 → 归位后主窗口的输入框拿到同一份。
    await expect(page.locator('.roundtable__ask-input')).toHaveValue('独立窗口发起的问题')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('取消任务：两个窗口同步显示已取消，已完成的回答保留', async () => {
  test.setTimeout(70_000)
  const { app, page, dataDir } = await launch()
  try {
    await scrollToRoundtable(page)
    await page.locator('.roundtable__ask-input').fill('会被取消的问题')
    await page.locator('.roundtable__ask-submit').click()

    // GPT 完成（快平台）；Claude 还在生成（4s 夹具）。
    const gpt = page.locator('.roundtable__answer').nth(0)
    const claude = page.locator('.roundtable__answer').nth(1)
    await expect(gpt).toHaveAttribute('data-state', 'completed', { timeout: 25_000 })
    await expect(claude).not.toHaveAttribute('data-state', 'completed')

    // 取消：GPT 的完成结果不能丢，Claude 变为已取消。
    await page.locator('.roundtable__ask-submit--stop').click()
    await expect(claude).toHaveAttribute('data-state', 'cancelled', { timeout: 10_000 })
    await expect(gpt).toHaveAttribute('data-state', 'completed')
    await expect(gpt).toContainText('GPT-FIXTURE')

    // 拆出：独立窗口看到同一份状态（completed + cancelled 并存）。
    await page.getByRole('button', { name: '拆出为独立窗口' }).click()
    const shell = await roundtableShell(app)
    await expect(shell.locator('.roundtable__answer').nth(0)).toHaveAttribute('data-state', 'completed', { timeout: 25_000 })
    await expect(shell.locator('.roundtable__answer').nth(1)).toHaveAttribute('data-state', 'cancelled', { timeout: 25_000 })
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('平台选择规则：未选不能提交；没有网页资料也能只问一家', async () => {
  test.setTimeout(70_000)
  const { app, page, dataDir } = await launch()
  try {
    await scrollToRoundtable(page)

    // 初始状态：两个平台页面都没打开过 → 出现「去登录」引导。
    await expect(page.locator('.roundtable__login-link')).toHaveCount(2, { timeout: 15_000 })

    // 全部取消选择：开始按钮禁用 + 明确提示。
    await page.locator('.roundtable__platform').nth(0).click()
    await page.locator('.roundtable__platform').nth(1).click()
    await expect(page.locator('.roundtable__ask-submit')).toBeDisabled()
    await expect(page.locator('.roundtable__ask-warning')).toContainText('请至少选择一个 AI 平台')

    // 只选 GPT：草稿为空时仍然禁用；填写后可提交。
    await page.locator('.roundtable__platform').nth(0).click()
    await expect(page.locator('.roundtable__ask-submit')).toBeDisabled()
    await page.locator('.roundtable__ask-input').fill('只问 GPT 的问题')
    await expect(page.locator('.roundtable__ask-submit')).toBeEnabled()
    await page.locator('.roundtable__ask-submit').click()

    // 只有一张回答卡（另一家完全不参与）；完成后草稿原样保留。
    await expect(page.locator('.roundtable__answer')).toHaveCount(1)
    const only = page.locator('.roundtable__answer').nth(0)
    await expect(only).toHaveAttribute('data-state', 'completed', { timeout: 25_000 })
    await expect(only).toContainText('GPT-FIXTURE')
    await expect(only).toContainText('只问 GPT 的问题')
    await expect(page.locator('.roundtable__ask-input')).toHaveValue('只问 GPT 的问题')

    // 去登录入口用可见浏览器打开平台页（共享 session，不采集凭据）。
    await page.locator('.roundtable__login-link').first().click()
    await expect(page.locator('.browser-panel')).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
