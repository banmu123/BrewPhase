import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * App Shell：融合式标题栏。
 *
 * 验证的是 Renderer 侧能固化的部分——44px 高度、拖动区/交互区分隔、
 * 平台安全区留白、轻量菜单按钮 IPC。原生窗口按钮（WCO / 红绿灯）的
 * 视觉与点击行为由系统合成，E2E 只能验证窗口级 API 通道正常。
 */

async function launch(): Promise<{ app: Awaited<ReturnType<typeof electron.launch>>; page: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bp-app-shell-e2e-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: dataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.BREWPHASE_FORCE_ONBOARDING

  const app = await electron.launch({ args: ['.', '--no-sandbox'], env })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.topbar')).toBeVisible()
  return { app, page, dataDir }
}

test('顶栏是 44px 的融合标题栏：整条可拖动、控件不被拖动区覆盖', async () => {
  const { app, page, dataDir } = await launch()
  try {
    const metrics = await page.evaluate(() => {
      const region = (selector: string): string => {
        const el = document.querySelector(selector)
        return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region').trim() : 'missing'
      }
      const bar = document.querySelector('.topbar')
      return {
        height: bar ? bar.getBoundingClientRect().height : 0,
        barRegion: region('.topbar'),
        searchRegion: region('.topbar__search'),
        addRegion: region('.topbar__add'),
        brandRegion: region('.topbar__brand'),
        menuRegion: region('.topbar__menu')
      }
    })

    expect(metrics.height).toBeGreaterThanOrEqual(43)
    expect(metrics.height).toBeLessThanOrEqual(45)
    expect(metrics.barRegion).toBe('drag')
    // 所有可交互元素必须 no-drag，否则点不动 / 输入会拖动窗口。
    expect(metrics.searchRegion).toBe('no-drag')
    expect(metrics.addRegion).toBe('no-drag')
    expect(metrics.brandRegion).toBe('no-drag')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('Windows 平台：原生窗口按钮安全区由 env(titlebar-area) 预留，菜单入口可用', async () => {
  test.skip(process.platform !== 'win32', '仅 Windows 有 WCO 安全区')
  const { app, page, dataDir } = await launch()
  try {
    const metrics = await page.evaluate(() => {
      const bar = document.querySelector('.topbar')
      return {
        platform: bar?.getAttribute('data-platform'),
        paddingRight: Number.parseFloat(getComputedStyle(bar!).paddingRight)
      }
    })
    expect(metrics.platform).toBe('windows')
    // env(titlebar-area-width) 生效时，右侧至少让出三枚系统按钮的宽度。
    expect(metrics.paddingRight).toBeGreaterThan(60)

    // 搜索按钮可正常点击（不被拖动区吞掉）。
    await page.locator('.topbar__search').click()
    await expect(page.locator('.palette')).toBeVisible()
    await page.keyboard.press('Escape')

    // 轻量菜单入口：弹出的是主进程的 native menu，IPC 只需成功往返。
    await page.locator('.topbar__appmenu').click()
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('画布工作区：canvas-topbar 顶替全局顶栏时同样 44px 且带平台留白', async () => {
  const { app, page, dataDir } = await launch()
  try {
    // 用顶栏「快速添加 → 新建一块画布」进入工作区：顺带覆盖快速添加入口。
    await page.locator('.topbar__add').click()
    await page.getByRole('menuitem', { name: '新建一块画布' }).click()
    // CanvasPage 接到 pendingCreate 后弹出新建对话框（已带默认名）。
    await expect(page.locator('.dialog')).toBeVisible()
    await page.getByRole('button', { name: '确认', exact: true }).click()
    await expect(page.locator('.canvas-topbar')).toBeVisible()

    const metrics = await page.evaluate(() => {
      const bar = document.querySelector('.canvas-topbar')
      return {
        height: bar ? bar.getBoundingClientRect().height : 0,
        platform: bar?.getAttribute('data-platform'),
        region: bar ? getComputedStyle(bar).getPropertyValue('-webkit-app-region').trim() : 'missing'
      }
    })
    expect(metrics.height).toBeGreaterThanOrEqual(43)
    expect(metrics.height).toBeLessThanOrEqual(45)
    expect(metrics.platform).toBe(process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'other')
    expect(metrics.region).toBe('drag')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
