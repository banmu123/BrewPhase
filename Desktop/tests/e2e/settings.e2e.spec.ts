import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { pinLocale } from './locale'

/**
 * Settings 二级导航与 AI 连接 E2E。
 *
 * 覆盖：
 * 1. 五个设置分类的导航与内容切换；
 * 2. 常规页的真实信息（版本、schema、数据目录、语言分段控件）；
 * 3. MCP：UI 创建客户端 → token 一次性展示 → 收起后不可再取 →
 *    配置模板含真实入口路径 → 撤销（两步确认）。
 *
 * 使用独立的 BREWPHASE_USER_DATA_DIR，不碰真实库。
 * 前置：`pnpm build && pnpm mcp:build`。
 */
function launchEnv(userData: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

test('Settings：二级导航、常规信息与 AI 连接全流程', async () => {
  test.setTimeout(90_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-settings-e2e-'))
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env: launchEnv(userData) })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await expect(page.locator('.topbar__brand')).toHaveText('BREWPHASE')

  await page.getByRole('button', { name: '设置', exact: true }).click()

  // —— 二级导航在，默认落在「常规」——
  const nav = (name: string) => page.getByRole('button', { name, exact: true })
  await expect(nav('常规')).toBeVisible()
  await expect(nav('设备同步')).toBeVisible()
  await expect(nav('浏览器')).toBeVisible()
  await expect(nav('AI 连接')).toBeVisible()
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
  await expect(page.getByText('管理应用、数据与连接')).toBeVisible()

  // 常规页：语言分段、应用信息、数据目录
  await expect(page.getByRole('heading', { name: '常规设置' })).toBeVisible()
  await expect(page.getByText('语言', { exact: true })).toBeVisible()
  await expect(nav('简体中文')).toHaveAttribute('data-active', 'true')
  await expect(page.getByText('数据库 Schema')).toBeVisible()
  await expect(page.getByText('同步协议')).toBeVisible()
  await expect(page.getByText(userData).first()).toBeVisible()

  // 语言切换后，分类名与页面标题立即变英文
  await nav('English').click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await expect(nav('General')).toBeVisible()
  await expect(nav('Device sync')).toBeVisible()
  await expect(nav('AI connections')).toBeVisible()
  // 切回中文，后面的流程用中文断言
  await nav('简体中文').click()
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()

  // —— 设备同步页：启用同步 → 出现「连接新设备」与二维码入口 ——
  await nav('设备同步').click()
  await expect(page.getByText('在移动设备上记录的内容，回到电脑就在这里。')).toBeVisible()
  await nav('启用局域网同步').click()
  await expect(nav('停用局域网同步')).toBeVisible({ timeout: 10_000 })
  await expect(nav('连接新设备')).toBeVisible()

  // —— AI 连接页：Bridge 状态、创建客户端、token 一次性 ——
  await nav('AI 连接').click()
  await expect(page.getByText(/Bridge：(运行中|未运行)/)).toBeVisible()
  await expect(page.getByText('新建客户端')).toBeVisible()

  await page.locator('#mcp-client-name').fill('E2E Settings Agent')
  await nav('创建并生成 Token').click()

  // token 只展示这一次
  await expect(page.getByText(/「E2E Settings Agent」已创建/)).toBeVisible()
  const tokenText = await page.locator('.settings-section .mono').filter({ hasText: 'bp_mcp_' }).first().innerText()
  expect(tokenText.startsWith('bp_mcp_')).toBe(true)
  expect(tokenText.length).toBeGreaterThan(20)

  // 配置模板里是真实入口路径（不是占位符）
  const configPreview = await page.locator('pre').innerText()
  expect(configPreview).toContain('mcp_servers.brewphase')
  expect(configPreview).toContain('out/mcp/stdio.mjs')
  expect(configPreview).toContain('BREWPHASE_MCP_USER_DATA_DIR')
  expect(configPreview).toContain(tokenText)

  // 收起后明文不可再取
  await nav('我已保存，收起').click()
  await expect(page.getByText(/「E2E Settings Agent」已创建/)).toHaveCount(0)
  const pageText = await page.locator('.settings-pane').innerText()
  expect(pageText).not.toContain(tokenText)

  // 已授权列表里有它，撤销是两步确认
  await expect(page.getByText('E2E Settings Agent').first()).toBeVisible()
  await nav('撤销').click()
  await expect(nav('确认撤销')).toBeVisible()
  await nav('确认撤销').click()
  await expect(page.getByText('（已撤销）')).toBeVisible()

  // 切走再切回：状态仍然正确（分类切换不重建错误状态）
  await nav('常规').click()
  await expect(page.getByRole('heading', { name: '常规设置' })).toBeVisible()
  await nav('AI 连接').click()
  await expect(page.getByText('（已撤销）')).toBeVisible()

  await page.screenshot({ path: '/tmp/settings-ai-connections.png' })
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})
