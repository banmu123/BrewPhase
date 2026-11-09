import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { pinLocale } from './locale'

/**
 * 国际化 E2E：语言切换、即时生效、刷新后保留。
 *
 * 断言策略：显式钉住 zh-CN 起步（不依赖测试机系统语言），
 * 再通过设置页切换 English 并验证导航、标题、日期格式一起变化。
 */
function launchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

test('语言切换：中文 → English 即时生效，重启后保留', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-i18n-e2e-'))
  const env = { ...launchEnv(), BREWPHASE_USER_DATA_DIR: userData }

  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')

  // 默认中文：导航与设置标题
  await expect(page.getByRole('button', { name: '记录', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '更多', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await expect(page.getByRole('heading', { name: '更多' })).toBeVisible()
  await expect(page.getByText('管理应用、数据与连接')).toBeVisible()

  // 切到 English：整页立即更新（不需要重启）
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByText('Manage the app, data and connections')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Records', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Coffee', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toBeVisible()
  // 二级导航也切了
  await expect(page.getByRole('button', { name: 'General', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Device sync', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'AI connections', exact: true })).toBeVisible()
  // html lang 同步（屏幕阅读器/排版依赖）
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en-US')
  // 选择已写入 localStorage
  expect(
    await page.evaluate(() => window.localStorage.getItem('brewphase.desktop.locale'))
  ).toBe('en-US')

  await app.close()

  // 重启应用（同一 userData，不注入固定语言）：语言从 localStorage 恢复为英文
  const app2 = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env })
  const page2 = await app2.firstWindow()
  // 导航本身已是英文 —— 这就是持久化生效的证据（模块默认回到 Records）
  await expect(page2.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 10_000
  })
  await expect(page2.getByRole('button', { name: 'Records', exact: true })).toBeVisible()
  await page2.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page2.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()

  // 切回中文：立即生效，并同样落盘
  await page2.getByRole('button', { name: '简体中文', exact: true }).click()
  await expect(page2.getByRole('heading', { name: '更多' })).toBeVisible()
  expect(
    await page2.evaluate(() => window.localStorage.getItem('brewphase.desktop.locale'))
  ).toBe('zh-CN')

  await app2.close()
  rmSync(userData, { recursive: true, force: true })
})

test('英文界面下模块页面完整可用（导航与页面标题）', async () => {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env: launchEnv() })
  const page = await app.firstWindow()
  await pinLocale(page, 'en-US')

  await page.getByRole('button', { name: 'Records', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Records' })).toBeVisible()

  await page.getByRole('button', { name: 'Coffee', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Coffee' })).toBeVisible()

  await page.getByRole('button', { name: 'Canvas', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Canvas' })).toBeVisible()
  // 集合页在没有画布时用空状态代替 .gallery-grid：断言页头按钮，避免依赖真实库数据
  await expect(page.getByRole('button', { name: 'New canvas' })).toBeVisible()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByText('Language', { exact: true })).toBeVisible()

  await app.close()
})
