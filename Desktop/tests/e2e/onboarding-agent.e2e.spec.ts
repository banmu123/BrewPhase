import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { pinLocale } from './locale'
import { seedEmptyDatabase } from './studio-seed'

const visual = Boolean(process.env.VISUAL_CHECK)

async function shoot(page: import('@playwright/test').Page, name: string): Promise<void> {
  if (!visual) return
  await page.addStyleTag({ content: '*{transition:none !important;animation:none !important}' })
  await page.waitForTimeout(200)
  await page.screenshot({ path: `/tmp/agent-${name}.png` })
}


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

/**
 * 把 HOME 指到临时目录。
 *
 * 自动配置会读写 `~/.codex/config.toml` 与 `~/.workbuddy/mcp.json`——
 * 测试绝不能碰开发者真实的 Agent 配置，所以整个 HOME 都要隔离。
 */
function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const fakeHome = join(userDataDir, 'home')
  mkdirSync(fakeHome, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    BREWPHASE_FORCE_ONBOARDING: 'yes',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    // 只隔离 Agent 配置的 home；不动 HOME/USERPROFILE，否则 Electron 找不到 appData。
    BREWPHASE_AGENT_HOME: fakeHome
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
    await expect(page.getByRole('button', { name: '配对移动设备' })).toBeVisible()
    await expect(page.getByRole('button', { name: '暂时跳过，先进入 BrewPhase' })).toBeVisible()
    await shoot(page, '1-welcome')

    await page.getByRole('button', { name: '连接 AI Agent' }).click()

    // Agent 三选：正式支持的两个 + 通用入口
    await expect(page.locator('.agent-picker__item')).toHaveCount(3)
    await page.locator('.agent-picker__item', { hasText: 'Codex' }).click()
    await shoot(page, '2-agent-pick')

    // 权限默认折叠成一行摘要：默认就是全给，不需要每个人先读五个选项
    await expect(page.locator('.scope-summary')).toContainText('全部 14 项')

    // 展开逐项看一遍：14 项必须全部预勾上，而不是只勾了读权限
    await page.getByRole('button', { name: '调整', exact: true }).click()
    await shoot(page, '1b-presets')
    const selectedPreset = page.locator('.preset-list__item[data-selected="true"]')
    await expect(selectedPreset).toContainText('全部权限')

    await page.getByRole('button', { name: /自定义权限/ }).click()
    const checkboxes = page.locator('.scope-checklist input[type="checkbox"]')
    await expect(checkboxes).toHaveCount(14)
    expect(
      await checkboxes.evaluateAll((nodes) =>
        nodes.every((node) => (node as HTMLInputElement).checked)
      )
    ).toBe(true)

    // 收紧到「只看记录」：摘要必须跟着变，不能还写着「全部」
    await page.getByRole('button', { name: /只看记录/ }).click()
    await expect(page.locator('.scope-summary')).toContainText('已选 1 / 14 项')

    await page.getByRole('button', { name: /全部权限/ }).click()
    await expect(page.locator('.scope-summary')).toContainText('全部 14 项')

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

test('Codex 一键配置：写入隔离的 home，保留用户其他配置', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'bp-agent-auto-'))
  seedEmptyDatabase(dir)

  // 预置一个"用户已有配置"的 Codex home
  const fakeHome = join(dir, 'home')
  const codexDir = join(fakeHome, '.codex')
  mkdirSync(codexDir, { recursive: true })
  const configPath = join(codexDir, 'config.toml')
  writeFileSync(
    configPath,
    '# 用户自己的注释\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "other-server"\n',
    'utf-8'
  )

  const { app, page } = await launch(dir)

  try {
    await page.getByRole('button', { name: '连接 AI Agent' }).click()
    await page.locator('.agent-picker__item', { hasText: 'Codex' }).click()

    // 检测到可一键配置
    await expect(page.getByRole('button', { name: '一键写入配置' })).toBeVisible()

    // 权限默认折叠，展开只截一张：这张图要能说清「默认给了什么」
    await page.getByRole('button', { name: '调整', exact: true }).click()
    await shoot(page, '1c-presets')
    await page.getByRole('button', { name: '收起', exact: true }).click()
    await shoot(page, '1-detect')
    await page.getByRole('button', { name: '一键写入配置' }).click()

    // 预览里能看到将写入的内容，且不含明文 Token
    const preview = page.locator('.onboarding-config')
    await expect(preview).toContainText('[mcp_servers.brewphase]')
    await expect(preview).toContainText('<BREWPHASE_MCP_TOKEN>')

    await shoot(page, '2-preview')
    await page.getByRole('button', { name: '确认写入' }).click()
    await expect(page.getByText('配置已写入')).toBeVisible()
    await shoot(page, '3-written')

    // 真实落盘：新增 brewphase，原有注释与其他 Server 原样保留
    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('[mcp_servers.brewphase]')
    expect(written).toContain('# 用户自己的注释')
    expect(written).toContain('model = "o3"')
    expect(written).toContain('[mcp_servers.other]')

    // 备份存在
    const backups = readdirSync(codexDir).filter((name) => name.includes('.brewphase.bak.'))
    expect(backups.length).toBeGreaterThan(0)

    // 验证区仍在等待真实调用——写入不等于连上
    await expect(page.getByText('正在等待第一次调用…')).toBeVisible()
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
