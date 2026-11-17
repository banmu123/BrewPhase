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

/**
 * 首页问候区右上角的账户标识（头像 + 名称）。
 *
 * 三条状态都得钉住：
 * 1. 未登录**不渲染**——首页默认形态不因为「有云账户这回事」多出占位；
 * 2. 已登录显示头像与名称，且与问候语同一行、垂直居中（版面不跳）；
 * 3. 头像地址加载失败退回首字母，不留破图。
 *
 * 与上面第三条一样，密文由本机真实 safeStorage 现生成——这是在没有真实
 * Google/GitHub 授权的前提下，唯一能构造「已登录」的可靠方式。
 */
/** 连不上的回环端口：登录态要被验证，但不能真的打到开发机上正在跑的 Cloud。 */
const UNREACHABLE_CLOUD = 'http://127.0.0.1:1'

async function seedCredentials(userData: string, account: Record<string, unknown>): Promise<void> {
  const first = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(userData, UNREACHABLE_CLOUD)
  })
  await first.firstWindow()
  const payload = await first.evaluate(async ({ safeStorage }, value) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable on this host')
    return safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  }, account)
  await first.close()

  mkdirSync(join(userData, 'account'), { recursive: true })
  writeFileSync(
    join(userData, 'account', 'credentials.json'),
    JSON.stringify({ version: 1, alg: 'safeStorage-v1', payload }),
    { mode: 0o600 }
  )
}

async function heroMetrics(page: Page) {
  return await page.evaluate(() => {
    const title = document.querySelector('.studio-hero__title')
    const badge = document.querySelector('.studio-account')
    const name = document.querySelector('.studio-account__name')
    const hero = document.querySelector('.studio-hero')
    const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null)
    const tr = rect(title)
    const br = rect(badge)
    const nr = rect(name)
    return {
      hasBadge: Boolean(badge),
      heroHeight: hero ? Math.round(hero.getBoundingClientRect().height) : 0,
      // 与问候语同一行且不重叠
      sameRow: tr && br ? !(br.top >= tr.bottom || br.bottom <= tr.top) : null,
      gap: tr && br ? Math.round(br.left - tr.right) : null,
      centered: tr && br ? Math.abs((tr.top + tr.bottom) / 2 - (br.top + br.bottom) / 2) < 5 : null,
      nameText: name?.textContent?.trim() ?? null,
      nameTruncated: name ? name.scrollWidth > name.clientWidth + 1 : null,
      nameBox: nr ? Math.round(nr.width) : null
    }
  })
}

test('首页问候区：未登录不显示账户标识，已登录显示头像与名称', async () => {
  test.setTimeout(120_000)
  const base = {
    provider: 'google',
    userId: 'user_hero_1',
    displayName: 'Chenzk',
    avatarUrl: null,
    createdAt: '2026-01-02T03:04:05.000Z',
    refreshToken: 'refresh-token-from-a-previous-session'
  }

  // —— 未登录：首页只有问候语，没有账户标识 ——
  const signedOut = mkdtempSync(join(tmpdir(), 'brewphase-hero-out-'))
  try {
    // 必须显式指向**连不上**的端口：本机可能正跑着 Cloud，伪造的 refresh token
    // 会被服务端判 401，桌面端按设计清掉凭据，断言就会变成「未登录」。
    const { app, page } = await launch(signedOut, UNREACHABLE_CLOUD)
    try {
      const before = await heroMetrics(page)
      expect(before.hasBadge).toBe(false)
      const baselineHeight = before.heroHeight
      expect(baselineHeight).toBeGreaterThan(0)

      // —— 预置凭据后重启：同一版面高度下多出头像 + 名称 ——
      await app.close()
      await seedCredentials(signedOut, base)

      const second = await launch(signedOut, UNREACHABLE_CLOUD)
      try {
        await expect(second.page.locator('.studio-account')).toBeVisible({ timeout: 20_000 })
        const after = await heroMetrics(second.page)
        expect(after.hasBadge).toBe(true)
        expect(after.nameText).toBe('Chenzk')
        expect(after.sameRow).toBe(true)
        expect(after.centered).toBe(true)
        expect(after.gap).toBeGreaterThan(0)
        // 关键：加了一个头像，问候区高度不变——桌面不会因此下移。
        expect(after.heroHeight).toBe(baselineHeight)
        // 首字母兜底（没有头像时不出现 <img>）
        await expect(second.page.locator('.studio-account__avatar--initial')).toHaveText('C')

        // 点一下直达设置页的云账户分类
        await second.page.getByRole('button', { name: '云账户：Chenzk' }).click()
        await expect(second.page.getByRole('heading', { name: '已登录', exact: true })).toBeVisible()
      } finally {
        await second.app.close()
      }
    } finally {
      // app 可能已在上面的分支里关过：close() 幂等
      await app.close().catch(() => undefined)
    }
  } finally {
    rmSync(signedOut, { recursive: true, force: true })
  }
})

test('首页问候区：头像加载失败退回首字母，超长名称省略但不撑破版面', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-hero-broken-'))
  try {
    await seedCredentials(userData, {
      provider: 'github',
      userId: 'user_hero_2',
      displayName: 'Chenzk-Wang-Extremely-Long-Display-Name-For-Testing',
      // 不可达的主机：触发 <img> 的 onError
      avatarUrl: 'https://avatars.invalid.example/u/2.png',
      createdAt: '2026-01-02T03:04:05.000Z',
      refreshToken: 'refresh-token-from-a-previous-session'
    })

    const { app, page } = await launch(userData, UNREACHABLE_CLOUD)
    try {
      await expect(page.locator('.studio-account')).toBeVisible({ timeout: 20_000 })
      // 头像最终要退回字母，页面上不留破图。
      await expect(page.locator('.studio-account__avatar--initial')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('img.studio-account__avatar')).toHaveCount(0)

      const metrics = await heroMetrics(page)
      expect(metrics.nameTruncated).toBe(true)
      expect(metrics.nameBox).toBeLessThanOrEqual(200)
      // 名称被省略号收住，不产生横向滚动
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      ).toBe(0)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
