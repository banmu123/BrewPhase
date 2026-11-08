import { test, expect } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'

/**
 * 新建链接的端到端：
 * 1. 输入 URL 时**本地**识别平台（不发网络请求）并显示状态；
 * 2. 非法协议直接提示错误；
 * 3. 保存不被元数据抓取阻塞——记录立刻出现在列表里。
 *
 * 元数据抓取会真的发起网络请求（fire-and-forget），但断言不依赖它成功：
 * 只验证「识别状态」与「记录已保存」两条主链路。
 */

const userData = mkdtempSync(join(tmpdir(), 'bp-link-e2e-'))

test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

test('新建链接：本地识别 + 保存不被阻塞', async () => {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      BREWPHASE_USER_DATA_DIR: userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'Records', exact: true }).click()

  // 打开「新链接」表单
  await page.getByRole('button', { name: '新链接' }).click()

  // 无效协议：本地立即报错，不发任何请求
  const urlInput = page.locator('.panel .field', { hasText: '网址' }).locator('input')
  await urlInput.fill('javascript:alert(1)')
  await expect(page.locator('.field-hint--error')).toHaveText(/不是有效的网页地址/)

  // 有效 GitHub 链接：识别状态出现
  await urlInput.fill('https://github.com/banmu123/BrewPhase')
  await expect(page.locator('.field-hint')).toContainText('已识别 GitHub')

  // 保存：记录立刻落库并出现在列表（元数据抓取在后台，不阻塞）
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.record-tile')).toHaveCount(1, { timeout: 5_000 })
  await expect(page.locator('.record-tile .preview-chip')).toContainText('GitHub')

  await page.screenshot({ path: '/tmp/records-link-new.png' })
  await app.close()
})
