import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { pinLocale } from './locale'

/**
 * 更新提醒 E2E。
 *
 * 分两段：
 * 1. **确定性**用例：用「死代理」把网络检查固定成失败，验证设置页更新区块
 *    的按钮形态、检查中的禁用态、以及失败时不弹提醒（不依赖外网）。
 * 2. **live** 用例（`UPDATE_LIVE_SMOKE=1` 才跑）：把 out/ 复制到临时目录并
 *    把 package.json 的 version 改成 0.1.4，让真实的 v0.2.0 Release 成为
 *    「新版本」，验证横幅出现、查看更新走主进程白名单、稍后提醒跨重启生效。
 *    默认跳过——它依赖 GitHub 可达，不能拖进常规 e2e。
 */

const DESKTOP = process.cwd()

function launchEnv(userData: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('heading', { name: '常规设置' }).waitFor()
}

async function updateState(page: Page): Promise<string | null> {
  return page.locator('[data-update-status]').first().getAttribute('data-update-status')
}

async function launchOffline(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  // 127.0.0.1:9 没有监听者：检查必然失败且立刻返回，状态稳定为 unavailable。
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', '--proxy-server=127.0.0.1:9'],
    env: launchEnv(userData)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await page.locator('.topbar__brand').waitFor()
  return { app, page }
}

test('设置 → 常规：更新区块是主按钮，检查中禁用，失败不弹提醒', async () => {
  test.setTimeout(90_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-update-e2e-'))
  const { app, page } = await launchOffline(userData)
  try {
    await openSettings(page)

    const checkButton = page.getByTestId('update-check')
    await expect(checkButton).toBeVisible()
    // 不再是 ghost 文本按钮：用设计系统的主按钮样式，并带一个刷新图标。
    await expect(checkButton).toHaveClass(/button--primary/)
    await expect(checkButton.locator('svg')).toHaveCount(1)

    // 开发态（未打包）不能自动更新，走 GitHub API 兜底；死代理让检查落定成 error。
    await expect
      .poll(() => updateState(page), { timeout: 25_000 })
      .toBe('error')
    await expect(page.locator('.settings-update__state')).toContainText('检查更新失败')
    // 失败后同一个按钮变成「重试」，主按钮样式不变。
    await expect(checkButton).toContainText('重试')
    // 没有可更新版本 → 不出现任何下载/更新按钮。
    await expect(page.getByRole('button', { name: '前往下载', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '立即更新', exact: true })).toHaveCount(0)
    // 检查失败绝不弹提醒，也不影响页面继续使用。
    await expect(page.locator('[data-testid="update-banner"]')).toHaveCount(0)

    // 检查中的禁用态：在点击前挂 MutationObserver，避免与人眼竞速。
    await checkButton.evaluate((button) => {
      const scope = window as unknown as { __updateDisabledSeen?: boolean }
      scope.__updateDisabledSeen = false
      const observer = new MutationObserver(() => {
        if ((button as HTMLButtonElement).disabled) scope.__updateDisabledSeen = true
      })
      observer.observe(button, { attributes: true, attributeFilter: ['disabled'] })
    })
    await checkButton.click()
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Boolean((window as unknown as { __updateDisabledSeen?: boolean }).__updateDisabledSeen)
          ),
        { timeout: 10_000 }
      )
      .toBe(true)
    await expect(checkButton).toBeEnabled({ timeout: 20_000 })
    await expect.poll(() => updateState(page)).toBe('error')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('独立圆桌窗口不渲染更新提醒', async () => {
  test.setTimeout(90_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-update-e2e-'))
  const { app, page } = await launchOffline(userData)
  try {
    // 同一个渲染进程切到圆桌窗口的 hash 路由：App 在更早的分支就 return 了，
    // 提醒连挂载的机会都没有。
    await page.evaluate(() => {
      window.location.hash = '#bpRoundtable=e2e'
    })
    await page.reload()
    await page.locator('.rt-window').waitFor({ timeout: 20_000 })
    await expect(page.locator('[data-testid="update-banner"]')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

test.describe('live（UPDATE_LIVE_SMOKE=1）', () => {
  test.skip(
    process.env.UPDATE_LIVE_SMOKE !== '1',
    '需要访问 GitHub Releases；设置 UPDATE_LIVE_SMOKE=1 才执行'
  )

  test('发现新版本：提醒 → 查看更新走白名单 → 稍后提醒跨重启生效', async () => {
    test.setTimeout(120_000)

    // 用 0.1.4 的临时副本启动：真实 v0.2.0 就是「新版本」，仓库里的版本号不动。
    const appDir = mkdtempSync(join(tmpdir(), 'brewphase-old-app-'))
    const userData = mkdtempSync(join(tmpdir(), 'brewphase-old-data-'))
    cpSync(join(DESKTOP, 'out'), join(appDir, 'out'), { recursive: true })
    // 主进程把 better-sqlite3 外部化，必须能解析到真实依赖（软链，不复制）。
    symlinkSync(join(DESKTOP, 'node_modules'), join(appDir, 'node_modules'), 'dir')
    const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'))
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ ...pkg, version: '0.1.4' }, null, 2)
    )

    const app = await electron.launch({
      args: [appDir, '--no-sandbox', '--disable-gpu'],
      env: launchEnv(userData),
      cwd: appDir
    })
    try {
      // 主进程取代 shell.openExternal，记录它真正要打开的地址。
      await app.evaluate(({ shell }) => {
        const scope = globalThis as unknown as { __openedUrl?: string }
        shell.openExternal = async (url: string) => {
          scope.__openedUrl = url
        }
      })

      const page = await app.firstWindow()
      await pinLocale(page, 'zh-CN')
      await page.locator('.topbar__brand').waitFor()

      /*
       * GitHub 未认证配额是 60 次/小时/IP。配额耗尽时接口返回 403，此时
       * 「没有提醒」是环境结果而不是回归——显式跳过并说明原因，不把没验证
       * 过的东西写成通过。读的是刚才那次检查的缓存结果（非 force），
       * 不再额外消耗一次配额。
       */
      const checked = await page.evaluate(() => window.brewphase.update.check(false))
      test.skip(
        checked.phase === 'error' && (checked.error ?? '').startsWith('HTTP 403'),
        `GitHub API 配额耗尽（${checked.error ?? 'HTTP 403'}），本次无法验证 live 提醒`
      )

      const banner = page.locator('[data-testid="update-banner"]')
      await expect(banner).toBeVisible({ timeout: 30_000 })
      await expect(banner).toContainText('BrewPhase 发现新版本')
      await expect(banner).toContainText('0.2.0')
      // 两个操作都有文字，不是纯图标。
      await expect(banner.getByRole('button', { name: '稍后提醒', exact: true })).toBeVisible()
      /*
       * 这是未打包的临时副本：`app.isPackaged === false`，自动更新按设计关闭，
       * 所以它只能给「前往下载」——不能给「立即更新」，否则就是骗用户。
       * 真正的下载/安装闭环由 update-service 的单测（假 adapter）覆盖。
       */
      await expect(banner.getByRole('button', { name: '立即更新', exact: true })).toHaveCount(0)
      const openButton = banner.getByRole('button', { name: '前往下载', exact: true })
      await expect(openButton).toBeVisible()

      // 前往下载：Renderer 不传 URL，主进程用缓存的白名单地址。
      await openButton.click()
      await expect
        .poll(() => app.evaluate(() => (globalThis as unknown as { __openedUrl?: string }).__openedUrl ?? null))
        .toContain('https://github.com/banmu123/BrewPhase/')

      // 提醒不阻塞页面操作：还能正常进设置。
      await openSettings(page)
      await expect(page.locator('.settings-update__state')).toContainText('发现新版本 0.2.0')
      await expect(page.getByRole('button', { name: '前往下载', exact: true })).toBeVisible()

      // 稍后提醒：收起，并记住版本号。
      const bannerAgain = page.locator('[data-testid="update-banner"]')
      await bannerAgain.getByRole('button', { name: '稍后提醒', exact: true }).click()
      await expect(bannerAgain).toHaveCount(0)

      // 重载（等价于下次启动）：同一版本不再打扰，设置页仍可查看。
      await page.reload()
      await page.locator('.topbar__brand').waitFor()
      await expect(page.locator('[data-testid="update-banner"]')).toHaveCount(0)
      await openSettings(page)
      await expect(page.locator('.settings-update__state')).toContainText('发现新版本 0.2.0')
    } finally {
      await app.close()
      rmSync(appDir, { recursive: true, force: true })
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
