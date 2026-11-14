import { expect, test } from '@playwright/test'
import { pinLocale } from './locale'
import { seedEmptyDatabase } from './studio-seed'
import { _electron as electronLauncher } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const visual = Boolean(process.env.VISUAL_CHECK)

/**
 * AI Workspace 的入口回归（Roundtable Phase 1 之后）。
 *
 * 背景：顶栏的 AI Workspace 一级入口与 `module === 'ai'` 路由已按规格移除，
 * AI 讨论改由 Studio Home 底部的圆桌承载。**底层能力（ai-chat 服务、
 * MultiAI / Conversations / Accounts 组件、migration 10）全部保留**，
 * 只是暂时没有导航入口——后续阶段会以圆桌的形式重新接入。
 *
 * 这个 spec 验证移除本身没有留下残渣：
 * - 顶栏不再出现 AI Workspace；
 * - Studio Home 上不再有旧的独立页面壳（settings-shell 导航）；
 * - 新的承载方式（网页卡片架 + 圆桌）就位。
 *
 * Multi-AI 的执行行为由调度器单测覆盖；真实 GPT/Claude 的登录与回答只能
 * 用真实账号人工验收——CI 里假装连过真实网站是造假。
 */

test('AI Workspace 一级入口已移除，圆桌成为 AI 讨论的承载位', async () => {
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
    // 顶栏一级入口不存在（规格 §7.1–7.3）。
    await expect(page.getByRole('button', { name: 'AI Workspace' })).toHaveCount(0)

    // 旧页面的 settings-shell 导航不再出现在首页（规格 §7.2）。
    await expect(page.locator('.settings-nav')).toHaveCount(0)

    // 新承载：卡片架与圆桌都在 Studio Home 上。
    await expect(page.locator('.web-shelf')).toBeVisible()
    await expect(page.locator('.roundtable')).toBeVisible()
    await expect(page.locator('.roundtable__title')).toHaveText('圆桌')

    if (visual) {
      await page.addStyleTag({ content: '*{transition:none !important;animation:none !important}' })
      await page.waitForTimeout(200)
      await page.screenshot({ path: '/tmp/ai-roundtable-replacement.png' })
    }
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
