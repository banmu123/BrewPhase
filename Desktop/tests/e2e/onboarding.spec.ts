import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { pinLocale } from './locale'

/**
 * 首次启动引导（配对）与「全新安装不该有数据」的回归。
 *
 * 每个用例都用自己的 `BREWPHASE_USER_DATA_DIR`：既拿到真正空库，也不会
 * 碰到开发机的真实 userData。`BREWPHASE_FORCE_ONBOARDING` 让未打包的测试
 * 构建走打包版判定分支（正式安装包由 `app.isPackaged` 自动生效）。
 */
function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    BREWPHASE_FORCE_ONBOARDING: 'yes'
  }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'bp-onboarding-'))
}

test.describe('首次启动：干净数据 + 配对引导', () => {
  test('Coffee 为空、引导出现、直达设备同步、重启后不再弹', async () => {
    const dir = tempDataDir()
    const env = launchEnv(dir)
    let app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env })
    try {
      const page = await app.firstWindow()
      await pinLocale(page)

      // 全新库：默认落在 Studio 首页，咖啡架必须是空的（引导遮罩盖着，先进不去空间页）。
      await expect(page.locator('.studio-space--coffee .studio-empty')).toContainText('咖啡架还在等')
      await expect(page.locator('.shelf-card')).toHaveCount(0)

      // 引导首屏是统一入口：连接 AI / 配对移动设备 / 先进入，三条路都可选。
      await expect(page.locator('.onboarding__card')).toBeVisible()
      await expect(page.locator('.onboarding__title')).toHaveText(
        '你的个人空间，也可以连接你信任的 AI 工具。'
      )
      await expect(page.getByRole('button', { name: '连接 AI Agent' })).toBeVisible()

      // 进入配对分支才是三步说明——「引导只讲配对」的断言放在这里。
      await page.getByRole('button', { name: '配对移动设备' }).click()
      await expect(page.locator('.onboarding__title')).toHaveText('把你的个人空间，延伸到桌面')
      await expect(page.locator('.onboarding__step')).toHaveCount(3)

      // 「打开设备同步设置」必须直达 sync 子页，而不是落在常规设置。
      await page.getByRole('button', { name: '打开设备同步设置' }).click()
      await expect(page.locator('.onboarding__card')).toHaveCount(0)
      await expect(page.locator('.settings-nav__item[data-active="true"]')).toHaveText('设备同步')
      await expect(page.getByRole('button', { name: '启用局域网同步' })).toBeVisible()

      await app.close()
      app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env })
      const second = await app.firstWindow()
      await pinLocale(second)
      await expect(second.locator('.onboarding__card')).toHaveCount(0)
    } finally {
      await app.close().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('英文界面：引导文案完整且无中文残留', async () => {
    const dir = tempDataDir()
    const env = launchEnv(dir)
    const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env })
    try {
      const page = await app.firstWindow()
      await pinLocale(page, 'en-US')
      // 首屏统一入口；英文文案必须是自然表达，不能漏中文。
      await expect(page.locator('.onboarding__title')).toHaveText(
        'Your personal space, connected to the tools you trust.'
      )
      await page.getByRole('button', { name: 'Pair a mobile device' }).click()
      await expect(page.locator('.onboarding__title')).toHaveText(
        'Extend your personal space to the desktop'
      )
      await expect(page.getByRole('button', { name: 'Open device sync settings' })).toBeVisible()
      await expect(page.locator('.onboarding__step')).toHaveCount(3)
      const cardText = (await page.locator('.onboarding__card').textContent()) ?? ''
      expect(cardText).not.toMatch(/[\u4e00-\u9fff]/)
    } finally {
      await app.close().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
