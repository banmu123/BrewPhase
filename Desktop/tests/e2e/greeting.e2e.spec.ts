import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { pinLocale } from './locale'
import { openSpace } from './nav'

/**
 * 动态问候的端到端验收（真实 Electron 渲染）。
 *
 * - 用 `page.clock.setFixedTime` 固定**本地时间**，不碰系统时钟、不 mock 网络；
 *   `setFixedTime` 只固定 Date，timer 仍按真实时间跑，所以调度器不会被
 *   fake timer 意外推进。
 * - 每个用例独立 `BREWPHASE_USER_DATA_DIR`，不碰开发机的真实库。
 * - 跨时段用真实的 `focus` 事件驱动（正是产品里的唤醒路径），而不是直接
 *   调内部函数——这样连 hook 的事件订阅一起验了。
 */

function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.BREWPHASE_FORCE_ONBOARDING
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function launch(userDataDir: string, locale: 'zh-CN' | 'en-US'): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(userDataDir)
  })
  const page = await app.firstWindow()
  await page.clock.setFixedTime(localTime(9, 30))
  await pinLocale(page, locale)
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page }
}

/** 本地时间构造器：与被测代码用的是同一套 `getHours()` 语义。 */
function localTime(hour: number, minute = 0, day = 13, month = 10, year = 2026): Date {
  return new Date(year, month, day, hour, minute, 0, 0)
}

async function setTimeAndWake(page: Page, time: Date): Promise<void> {
  await page.clock.setFixedTime(time)
  // 窗口重新获得焦点 —— 系统休眠唤醒 / 最小化恢复 / 切回前台走的就是这条。
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

async function titleText(page: Page): Promise<string> {
  return (await page.locator('.studio-hero__title').textContent())?.trim() ?? ''
}

test('中文：首帧问候、跨时段更新、切页返回、文案长度不推挤布局', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-greeting-zh-'))
  const { app, page } = await launch(userData, 'zh-CN')
  try {
    const title = page.locator('.studio-hero__title')

    // 1. 第一次启动：09:30 → 上午好；辅助文案走语言包。
    await expect(title).toHaveText('上午好')
    await expect(page.locator('.studio-hero__sub')).toHaveText('今天，也按自己的节奏来。')
    // 旧的固定品牌主标题不再出现在首页。
    await expect(title).not.toHaveText('为在意的事，留出位置。')

    const deskTopAtMorning = (await page.locator('.studio-desk').boundingBox())?.y ?? -1
    const titleHeightAtMorning = (await title.boundingBox())?.height ?? -1

    // 2. 跨时间区间（15:00）并重新获得焦点 → 下午好。
    await setTimeAndWake(page, localTime(15, 0))
    await expect(title).toHaveText('下午好')

    // 3. 深夜区间（02:10）→ 夜深了。
    await setTimeAndWake(page, localTime(2, 10, 14))
    await expect(title).toHaveText('夜深了')

    // 4. 文字长度不同不造成下方桌面位移（min-height 锁住一行）。
    const deskTopAtLateNight = (await page.locator('.studio-desk').boundingBox())?.y ?? -2
    const titleHeightAtLateNight = (await title.boundingBox())?.height ?? -2
    expect(titleHeightAtLateNight).toBe(titleHeightAtMorning)
    expect(deskTopAtLateNight).toBe(deskTopAtMorning)

    // 5. 离开首页再回来：组件重新挂载，按「当前」时段重算，不沿用旧值。
    await page.clock.setFixedTime(localTime(19, 20, 14))
    await openSpace(page, '记录')
    await expect(page.locator('.studio-home')).toHaveCount(0)
    await page.locator('.topbar__brand').click({ force: true })
    await expect(page.locator('.studio-home')).toBeVisible()
    await expect(title).toHaveText('晚上好')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('切换语言后问候立即更新，且不改变时段标识', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-greeting-en-'))
  const { app, page } = await launch(userData, 'zh-CN')
  try {
    const title = page.locator('.studio-hero__title')
    await expect(title).toHaveText('上午好')

    // 通过设置页切到 English：问候文案立刻换，时段仍是 09:30。
    await page.getByRole('button', { name: '设置', exact: true }).click({ force: true })
    await page.getByRole('button', { name: 'English', exact: true }).click({ force: true })
    await page.locator('.topbar__brand').click({ force: true })
    await expect(page.locator('.studio-home')).toBeVisible()
    await expect(title).toHaveText('Good morning')
    await expect(page.locator('.studio-hero__sub')).toHaveText('Take today at your own pace.')

    const shortHeight = (await title.boundingBox())?.height ?? -1
    const shortDeskTop = (await page.locator('.studio-desk').boundingBox())?.y ?? -1

    // 英文最长问候（Good afternoon）也不换行、不推挤下方三栏。
    await setTimeAndWake(page, localTime(12, 0))
    await expect(title).toHaveText('Good afternoon')
    const longHeight = (await title.boundingBox())?.height ?? -2
    const longDeskTop = (await page.locator('.studio-desk').boundingBox())?.y ?? -2
    expect(longHeight).toBe(shortHeight)
    expect(longDeskTop).toBe(shortDeskTop)

    // 英文下跨到 18:00 → Good evening。
    await setTimeAndWake(page, localTime(18, 0))
    await expect(title).toHaveText('Good evening')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
