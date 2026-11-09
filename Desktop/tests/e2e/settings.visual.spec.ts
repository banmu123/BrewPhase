import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, test } from '@playwright/test'
import { pinLocale } from './locale'

/**
 * Settings 视觉验收（默认 skip，只在显式要求时跑）：
 *
 *   VISUAL_CHECK=1 npx playwright test tests/e2e/settings.visual.spec.ts
 *
 * 输出 /tmp/settings-<lang>-<page>-<size>.png：中英文 × 三页 × 宽/窄窗口。
 * 检查项（人工）：二级导航激活态、内容滚动、按钮不溢出、Token 换行、
 * 英文长文案不撑坏布局、窄窗口下导航切顶部 Tabs。
 */
test.skip(!process.env.VISUAL_CHECK, '设置 VISUAL_CHECK=1 才跑视觉验收')

const PAGES = [
  { key: 'general', zh: '常规', en: 'General' },
  { key: 'sync', zh: '设备同步', en: 'Device sync' },
  { key: 'mcp', zh: 'AI 连接', en: 'AI connections' }
] as const

test('Settings 视觉验收：中英文 × 三页 × 宽窄窗口', async () => {
  test.setTimeout(180_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-visual-'))
  const env = { ...process.env, BREWPHASE_USER_DATA_DIR: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')

  const resize = async (width: number, height: number): Promise<void> => {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
      },
      { width, height }
    )
    await page.waitForTimeout(250)
  }

  const ensureLocale = async (target: 'zh' | 'en'): Promise<void> => {
    const current = await page.evaluate(() => document.documentElement.lang)
    const isZh = current.startsWith('zh')
    if ((target === 'zh') === isZh) return
    // 语言控件在常规页
    await page.getByRole('button', { name: isZh ? '常规' : 'General', exact: true }).click()
    await page.getByRole('button', { name: target === 'zh' ? '简体中文' : 'English', exact: true }).click()
    await page.waitForTimeout(150)
  }

  await page.getByRole('button', { name: '设置', exact: true }).click()

  for (const size of [
    { key: 'wide', width: 1200, height: 820 },
    // 980 是主窗口的 minWidth：这是「较小窗口」的真实下限
    { key: 'narrow', width: 980, height: 700 }
  ]) {
    await resize(size.width, size.height)
    for (const lang of ['zh', 'en'] as const) {
      await ensureLocale(lang)
      for (const item of PAGES) {
        await page.getByRole('button', { name: lang === 'zh' ? item.zh : item.en, exact: true }).click()
        await page.waitForTimeout(250)
        await page.screenshot({ path: `/tmp/settings-${lang}-${item.key}-${size.key}.png` })
      }
    }
  }

  await app.close()
  rmSync(userData, { recursive: true, force: true })
})
