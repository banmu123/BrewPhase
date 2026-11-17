import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { pinLocale } from './locale'

/**
 * Cloud Account E2E（Phase 1.2）。
 *
 * 只覆盖「不需要真实 Google/GitHub 凭据」的部分——点击登录会打开系统浏览器，
 * 自动化里不能真去开：
 * 1. 未登录状态启动：设置里出现云账户分区、两个登录入口、本地优先说明，
 *    且**所有本地页面照常可用**（不登录不扣功能）；
 * 2. 凭据密文损坏：应用正常启动，按未登录处理并给出诚实提示——
 *    这是 safeStorage 解密失败的真实端到端路径；
 * 3. 已登录状态重启 + Cloud 不可达 + 用户主动退出：密文由本机 safeStorage
 *    真实加密（测试里现生成），重启后仍是已登录；服务地址指向一个连不上的
 *    回环端口时**不被踢下线**；退出登录后重启确认已回到未登录。
 *
 * 前置：`pnpm build && pnpm mcp:build`。
 */

function launchEnv(userData: string, cloudBaseUrl = ''): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userData,
    // 固定打到本地默认地址，避免开发机的环境变量影响断言。
    BREWPHASE_CLOUD_BASE_URL: cloudBaseUrl,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function launch(userData: string, cloudBaseUrl = '') {
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(userData, cloudBaseUrl)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  return { app, page }
}

async function openAccountSection(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '云账户', exact: true }).click()
}

test('云账户：未登录启动，本地功能不受影响', async () => {
  test.setTimeout(60_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-account-e2e-'))
  const { app, page } = await launch(userData)
  try {
    await openAccountSection(page)

    await expect(page.getByRole('heading', { name: '云账户', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '未登录', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '使用 Google 登录' })).toBeVisible()
    await expect(page.getByRole('button', { name: '使用 GitHub 登录' })).toBeVisible()

    // 本地优先声明与真实服务地址都要露出来（不含任何凭据）。
    await expect(page.getByText('不登录也能完整使用所有本地功能', { exact: false })).toBeVisible()
    await expect(page.getByText('http://127.0.0.1:3000')).toBeVisible()
    await expect(page.getByText('云账户与设备同步是两套独立认证', { exact: false })).toBeVisible()

    // 未登录不影响本地页面：回 Studio 首页，三个空间入口都在。
    await page.locator('.topbar__brand').click()
    await expect(page.locator('.studio-home')).toBeVisible()
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('云账户：凭据密文损坏时安全降级为未登录', async () => {
  test.setTimeout(60_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-account-broken-e2e-'))
  // 合法信封 + 无法解密的载荷：模拟「系统密钥变了 / 密文被篡改」。
  const accountDir = join(userData, 'account')
  mkdirSync(accountDir, { recursive: true })
  writeFileSync(
    join(accountDir, 'credentials.json'),
    JSON.stringify({
      version: 1,
      alg: 'safeStorage-v1',
      payload: Buffer.from('this-is-not-ciphertext').toString('base64')
    }),
    { mode: 0o600 }
  )

  const { app, page } = await launch(userData)
  try {
    await openAccountSection(page)

    // 应用照常启动：不是崩溃，也不是「已登录」。
    await expect(page.getByRole('heading', { name: '未登录', exact: true })).toBeVisible()
    await expect(page.getByText('本机登录凭据读取失败', { exact: false })).toBeVisible()
    // 不会静默降级成明文登录态：登录入口仍在，需要重新登录。
    await expect(page.getByRole('button', { name: '使用 Google 登录' })).toBeVisible()
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('云账户：已登录重启、Cloud 不可达仍保持登录、主动退出后不再登录', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-account-restart-e2e-'))
  const credentialsPath = join(userData, 'account', 'credentials.json')
  // 连不上的回环端口：协议校验通过，但连接必然被拒，用来模拟 Cloud 不可用。
  const unreachable = 'http://127.0.0.1:1'

  try {
    // —— 用本机真实 safeStorage 生成密文（模拟上一次登录留下的凭据）——
    const first = await launch(userData)
    const payload = await first.app.evaluate(({ safeStorage }) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable on this host')
      const account = {
        provider: 'github',
        userId: 'user_e2e_1',
        displayName: 'E2E Tester',
        avatarUrl: null,
        createdAt: '2026-01-02T03:04:05.000Z',
        refreshToken: 'refresh-token-from-a-previous-session'
      }
      return safeStorage.encryptString(JSON.stringify(account)).toString('base64')
    })
    await first.app.close()

    mkdirSync(join(userData, 'account'), { recursive: true })
    writeFileSync(
      credentialsPath,
      JSON.stringify({ version: 1, alg: 'safeStorage-v1', payload }),
      { mode: 0o600 }
    )

    // —— 重启：已登录状态恢复（Cloud 连不上也算登录，本地优先）——
    const second = await launch(userData, unreachable)
    try {
      await openAccountSection(second.page)
      await expect(second.page.getByRole('heading', { name: '已登录', exact: true })).toBeVisible()
      await expect(second.page.getByText('E2E Tester')).toBeVisible()
      await expect(second.page.getByText('user_e2e_1')).toBeVisible()
      await expect(second.page.getByText(unreachable)).toBeVisible()
      // 服务不可达时如实提示，但仍保持登录态（离线不等于被踢下线）。
      await expect(second.page.getByText('无法连接云服务', { exact: false })).toBeVisible({ timeout: 20_000 })
      await expect(second.page.getByRole('heading', { name: '已登录', exact: true })).toBeVisible()

      // 退出登录需要二次确认：对话框里点确认。
      await second.page.getByRole('button', { name: '退出登录', exact: true }).click()
      const dialog = second.page.locator('.dialog--confirm')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('只清除这台电脑上的登录凭据')
      await dialog.getByRole('button', { name: '退出登录', exact: true }).click()

      await expect(second.page.getByRole('heading', { name: '未登录', exact: true })).toBeVisible()
      // 凭据文件被删掉；本地数据库文件仍在（退出不删本地数据）。
      expect(existsSync(credentialsPath)).toBe(false)
      expect(existsSync(join(userData, 'brewphase.db'))).toBe(true)
    } finally {
      await second.app.close()
    }

    // —— 再重启：确认凭据没有「复活」——
    const third = await launch(userData, unreachable)
    try {
      await openAccountSection(third.page)
      await expect(third.page.getByRole('heading', { name: '未登录', exact: true })).toBeVisible()
      await expect(third.page.getByRole('button', { name: '使用 GitHub 登录' })).toBeVisible()
    } finally {
      await third.app.close()
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
