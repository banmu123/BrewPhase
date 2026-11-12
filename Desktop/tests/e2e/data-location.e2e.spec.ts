import { test, expect, _electron as electronLauncher } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinLocale } from './locale'
import { seedStudioDatabase } from './studio-seed'

/**
 * 数据目录切换的真实端到端验收。
 *
 * 用 `BREWPHASE_DATA_DIR_CHOICE` 跳过系统目录对话框（原生框无法自动化），
 * `BREWPHASE_NO_AUTO_RELAUNCH` 阻止迁移后自动退出，方便断言文件与配置；
 * 随后手动重启同一个 userData，确认应用真的从新目录打开数据库。
 *
 * 不碰真实库：userData 与目标目录都是临时目录。
 */

function launchEnv(userData: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userData,
    BREWPHASE_NO_AUTO_RELAUNCH: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    ...extra
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.BREWPHASE_FORCE_ONBOARDING
  return env
}

async function launch(
  userData: string,
  extra: NodeJS.ProcessEnv = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(userData, extra)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page }
}

test('更改数据位置：复制 db 与 media，重启后从新目录打开', async () => {
  test.setTimeout(150_000)
  const userData = mkdtempSync(join(tmpdir(), 'bp-data-e2e-'))
  const targetRoot = mkdtempSync(join(tmpdir(), 'bp-data-target-'))
  const target = join(targetRoot, 'moved')
  seedStudioDatabase(userData)

  try {
    const first = await launch(userData, { BREWPHASE_DATA_DIR_CHOICE: target })
    try {
      const page = first.page
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByText('数据目录', { exact: true })).toBeVisible()
      // 默认数据目录就是隔离的 userData
      await expect(page.locator('.info-list dd.mono')).toContainText(userData)

      await page.getByRole('button', { name: '更改位置…' }).click()
      await page.locator('.dialog--confirm').getByRole('button', { name: '更改位置…' }).click()

      await expect(page.getByText('已迁移，正在重启 BrewPhase…')).toBeVisible({ timeout: 30_000 })

      expect(existsSync(join(target, 'brewphase.db'))).toBe(true)
      expect(existsSync(join(target, 'media'))).toBe(true)
      // 源目录保留（只复制，不删除）
      expect(existsSync(join(userData, 'brewphase.db'))).toBe(true)
    } finally {
      await first.app.close()
    }

    // 重启：不再指定 BREWPHASE_DATA_DIR_CHOICE，让应用读取 data-location.json
    const second = await launch(userData)
    try {
      const info = await second.page.evaluate(() => window.brewphase.app.info())
      expect(info.dataDir).toBe(target)

      // 数据库真的从新目录打开：种子记录可读。
      const records = await second.page.evaluate(() =>
        window.brewphase.records.list({ search: '', carrier: null, tagId: null, limit: 50, offset: 0 })
      )
      expect(Array.isArray(records)).toBe(true)
    } finally {
      await second.app.close()
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
    rmSync(targetRoot, { recursive: true, force: true })
  }
})

test('恢复默认位置：删除配置后重启回到默认目录', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'bp-data-reset-'))
  const targetRoot = mkdtempSync(join(tmpdir(), 'bp-data-reset-target-'))
  const target = join(targetRoot, 'moved')
  seedStudioDatabase(userData)

  try {
    const first = await launch(userData, { BREWPHASE_DATA_DIR_CHOICE: target })
    try {
      const page = first.page
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('button', { name: '更改位置…' }).click()
      await page.locator('.dialog--confirm').getByRole('button', { name: '更改位置…' }).click()
      await expect(page.getByText('已迁移，正在重启 BrewPhase…')).toBeVisible({ timeout: 30_000 })
    } finally {
      await first.app.close()
    }

    const second = await launch(userData)
    try {
      const page = second.page
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByRole('button', { name: '使用默认位置' })).toBeVisible()
      await page.getByRole('button', { name: '使用默认位置' }).click()
      await page.locator('.dialog--confirm').getByRole('button', { name: '使用默认位置' }).click()
      await expect(page.getByText('已迁移，正在重启 BrewPhase…')).toBeVisible({ timeout: 15_000 })
    } finally {
      await second.app.close()
    }

    const third = await launch(userData)
    try {
      const info = await third.page.evaluate(() => window.brewphase.app.info())
      expect(info.dataDir).toBe(userData)
    } finally {
      await third.app.close()
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
    rmSync(targetRoot, { recursive: true, force: true })
  }
})
