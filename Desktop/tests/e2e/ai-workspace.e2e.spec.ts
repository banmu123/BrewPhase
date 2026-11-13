import { expect, test } from '@playwright/test'
import { pinLocale } from './locale'
import { seedEmptyDatabase } from './studio-seed'
import { _electron as electronLauncher } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const visual = Boolean(process.env.VISUAL_CHECK)

async function shoot(page: import('@playwright/test').Page, name: string): Promise<void> {
  if (!visual) return
  await page.addStyleTag({ content: '*{transition:none !important;animation:none !important}' })
  await page.waitForTimeout(200)
  await page.screenshot({ path: `/tmp/ai-${name}.png` })
}

/**
 * AI Workspace 的 UI 冒烟测试（不依赖外网）。
 *
 * Multi-AI 的执行行为（并行、失败、超时）由调度器单测覆盖；真实 GPT/Claude
 * 的登录与回答只能用真实账号人工验收——CI 里假装连过真实网站是造假。
 * 这里验证的是壳：导航、状态卡、账号页与记录页的空态。
 */

test('AI Workspace：一级入口、默认 Multi-AI、三个区块的空态', async () => {
  test.setTimeout(90_000)
  const dir = mkdtempSync(join(tmpdir(), 'bp-ai-workspace-'))
  seedEmptyDatabase(dir)

  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, BREWPHASE_USER_DATA_DIR: dir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  const page = await app.firstWindow()
  await pinLocale(page)
  await page.waitForLoadState('domcontentloaded')

  try {
    // 顶栏一级入口存在且能进入
    await page.getByRole('button', { name: 'AI Workspace' }).click()
    await expect(page.locator('.settings-nav__item')).toHaveCount(3)
    await expect(page.locator('.multi-ai')).toBeVisible()

    // 平台状态卡：两个平台都「页面未打开」，且默认都被选中
    const cards = page.locator('.multi-ai__provider')
    await expect(cards).toHaveCount(2)
    await expect(cards.first()).toContainText('GPT')
    await expect(cards.nth(1)).toContainText('Claude')
    await expect(page.locator('.multi-ai__provider[data-selected="true"]')).toHaveCount(2)
    await expect(page.locator('.multi-ai__provider-state').first()).toHaveText('页面未打开')
    await shoot(page, '1-multi')

    // 结果区有两张并排卡片（空态文案）
    await expect(page.locator('.multi-ai__card')).toHaveCount(2)

    // 平台可以取消选择（多选语义）
    await cards.first().click()
    await expect(page.locator('.multi-ai__provider[data-selected="true"]')).toHaveCount(1)
    await cards.first().click()

    // 讨论记录：空态
    await page.getByRole('button', { name: '讨论记录' }).click()
    await expect(page.locator('.ai-conversations')).toBeVisible()
    await expect(page.locator('.ai-conversations__empty')).toHaveText('还没有记录。第一次讨论从 Multi-AI 开始。')
    await shoot(page, '2-conversations')

    // 账号页：两张卡 + 打开登录页按钮
    await page.getByRole('button', { name: '账号' }).click()
    await expect(page.locator('.ai-accounts__card')).toHaveCount(2)
    await expect(page.getByRole('button', { name: '打开登录页' })).toHaveCount(2)
    await shoot(page, '3-accounts')

    // 回到 Multi-AI 仍是默认选中状态
    await page.getByRole('button', { name: 'Multi-AI' }).click()
    await expect(page.locator('.multi-ai')).toBeVisible()
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
