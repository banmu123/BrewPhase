import { _electron as electron, expect, test } from '@playwright/test'
import { pinLocale } from './locale'
import { openSpace } from './nav'

/**
 * E2E 冒烟：真的把 Electron 拉起来，确认主进程能开库、preload 桥能通、
 * 三个模块的入口都在。跑之前需要 `pnpm build`——这里启动的是打包产物，
 * 不是 dev server，这样连 preload 的产物路径也一起验证了。
 *
 * 环境注意：
 * - 必须剥掉 ELECTRON_RUN_AS_NODE——有些宿主环境（CI、终端复用器）会设它，
 *   那会让 Electron 以普通 Node 运行，`require('electron')` 变成路径字符串，
 *   主进程第一行就崩。这不是应用代码的问题，是启动环境的问题。
 * - 无 GPU 的受限环境加 --no-sandbox / --disable-gpu，只影响测试进程，
 *   不写进应用默认配置。
 * - 本用例**故意用默认 userData**（跑真实库）。`electron-vite dev` 正在运行
 *   时会因单实例锁启动即退（Playwright 报 electron.launch: WebSocket error:
 *   read ECONNRESET）——跑 E2E 前先停掉 dev 实例，不是产品 bug。
 */
function launchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

test('应用启动、连上本地库、三个模块可切换', async () => {
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv()
  })
  const page = await app.firstWindow()
  await pinLocale(page)

  await expect(page.locator('.topbar__brand')).toHaveText('BREWPHASE')
  // `exact` 是必须的：这条用例跑在**真实库**上，豆名列里完全可能出现
  // 「启程咖啡」这种名字，模糊匹配会把豆子按钮一起选中（strict mode 直接失败）。
  const nav = (name: string) => page.getByRole('button', { name, exact: true })
  // 默认落在 Studio 首页：三个空间是内容入口，不再是全局 Tab。
  await expect(nav('咖啡')).toBeVisible()
  await expect(nav('记录')).toBeVisible()
  await expect(nav('画布')).toBeVisible()

  // 通过 preload 桥拿一次应用信息：能拿到就说明 IPC + 数据库都通了。
  const info = await page.evaluate(async () => window.brewphase.app.info())
  expect(info.dbSchemaVersion).toBe(1)
  expect(info.syncProtocolVersion).toBe(1)

  await nav('记录').click()
  await expect(page.getByRole('heading', { name: '记录' })).toBeVisible()
  // 空间页头留了回 Studio 的轻量入口（没有侧栏之后，这是唯一回去的路）。
  await expect(page.getByRole('button', { name: '返回 Studio' })).toBeVisible()

  await openSpace(page, '画布')
  // Canvas 现在先进集合页（Gallery）；断言页头按钮而不是 .gallery-grid——
  // 后者只在「已有画布」时渲染，会随真实库的数据变化而假红。
  await expect(page.getByRole('button', { name: '新建画布' })).toBeVisible()

  await app.close()
})
