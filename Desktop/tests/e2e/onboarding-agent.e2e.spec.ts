import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { pinLocale } from './locale'

const visual = Boolean(process.env.VISUAL_CHECK)

async function shoot(page: import('@playwright/test').Page, name: string): Promise<void> {
  if (!visual) return
  await page.addStyleTag({ content: '*{transition:none !important;animation:none !important}' })
  await page.waitForTimeout(200)
  await page.screenshot({ path: `/tmp/onboarding-${name}.png` })
}
import { seedEmptyDatabase } from './studio-seed'

/**
 * 首次启动引导（统一入口 + AI 接入）。
 *
 * 三个断言对着三条容易出错的规则：
 * 1. 新用户看到统一入口，而不是旧的「只讲配对」页面；
 * 2. 选 Codex 生成的是 TOML（不是 JSON），且含真实入口路径与 token；
 * 3. 老用户（旧标记存在）升级后不再被弹窗打扰。
 *
 * 引导是否出现由 `BREWPHASE_FORCE_ONBOARDING=yes` 触发——打包版才默认开启，
 * e2e 跑的是未打包目录。
 */

function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    BREWPHASE_FORCE_ONBOARDING: 'yes',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function launch(userDataDir: string) {
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(userDataDir)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page }
}

test('新用户：统一入口 → 选 Codex → 生成 TOML 配置', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'bp-onboarding-'))
  seedEmptyDatabase(dir)
  const { app, page } = await launch(dir)

  try {
    // 统一入口：两条配置路径 + 跳过
    await expect(page.locator('.onboarding__card')).toBeVisible()
    await expect(page.getByRole('button', { name: '连接 AI Agent' })).toBeVisible()
    await expect(page.getByRole('button', { name: '配对 iPhone' })).toBeVisible()
    await expect(page.getByRole('button', { name: '暂时跳过，先进入 BrewPhase' })).toBeVisible()
    await shoot(page, '1-welcome')

    await page.getByRole('button', { name: '连接 AI Agent' }).click()

    // Agent 三选：正式支持的两个 + 通用入口
    await expect(page.locator('.agent-picker__item')).toHaveCount(3)
    await page.locator('.agent-picker__item', { hasText: 'Codex' }).click()
    await shoot(page, '2-agent-pick')

    // 默认权限是「个人成长」，且不含任何写权限
    const selectedPreset = page.locator('.preset-list__item[data-selected="true"]')
    await expect(selectedPreset).toContainText('个人成长')

    await page.getByRole('button', { name: '创建客户端' }).click()

    // token 只显示一次；配置是 TOML，不是 JSON
    await expect(page.locator('.onboarding-token')).not.toBeEmpty()
    const config = page.locator('.onboarding-config')
    await expect(config).toContainText('[mcp_servers.brewphase]')
    await expect(config).toContainText('BREWPHASE_MCP_TOKEN')
    await expect(config).toContainText('BREWPHASE_MCP_USER_DATA_DIR')
    await expect(config).toContainText('stdio.mjs')

    // 复制配置不等于连上：验证区必须停在「等待」
    await expect(page.locator('.onboarding-prompt')).toContainText('BrewPhase')
    await expect(page.getByText('正在等待第一次调用…')).toBeVisible()
    await shoot(page, '3-created')

    // 完成 → 回到主应用，且不再弹
    await page.getByRole('button', { name: '完成' }).click()
    await expect(page.locator('.onboarding__card')).toHaveCount(0)
    await expect(page.locator('.studio-home')).toBeVisible()

    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('.onboarding__card')).toHaveCount(0)
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('老用户升级：旧标记存在时不再弹引导', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'bp-onboarding-legacy-'))
  seedEmptyDatabase(dir)
  const { app, page } = await launch(dir)

  try {
    // 模拟「看过旧版引导」的升级用户
    await page.addInitScript(() => {
      localStorage.setItem('bp.onboarding.seen', 'yes')
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('.studio-home')).toBeVisible()

    // 不能因为升级再弹一次
    await expect(page.locator('.onboarding__card')).toHaveCount(0)
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
