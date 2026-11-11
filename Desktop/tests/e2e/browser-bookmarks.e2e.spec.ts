import { test, expect, _electron as electronLauncher } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { pinLocale } from './locale'
import { seedStudioDatabase } from './studio-seed'

/**
 * Chrome 书签导入（Browser Phase 2）的端到端验收。
 *
 * 两件事必须用真实 Electron 才能验证：
 * 1. 导入的书签能驱动真实的 WebContentsView 导航；
 * 2. 「回到起始页」只是把原生视图藏起来——网页容器还在、地址还在、Session
 *    没断，再点书签能继续在原容器里加载。
 *
 * Chrome 侧完全用临时目录里的模拟 Profile（Local State + Bookmarks），
 * 不读开发机的真实 Chrome。
 */

const BROWSER_PARTITION = 'persist:brewphase-browser'

const HOME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Bookmark Home</title>
<style>body{font-family:-apple-system,sans-serif;margin:0;padding:48px;background:#faf9f6;color:#30372f}</style></head>
<body><h1>Bookmark Home</h1><p>Served from 127.0.0.1.</p></body></html>`

const SECOND_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Second Page</title>
<style>body{font-family:-apple-system,sans-serif;margin:0;padding:48px;background:#faf9f6;color:#30372f}</style></head>
<body><h1>Second Page</h1></body></html>`

let server: Server
let baseURL = ''

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(path === '/second' ? SECOND_HTML : HOME_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseURL = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function chromeFixture(): unknown {
  return {
    roots: {
      bookmark_bar: {
        type: 'folder',
        name: '书签栏',
        children: [
          { type: 'url', name: '本地首页', url: `${baseURL}/`, id: '1', guid: 'bm-home' },
          {
            type: 'folder',
            name: '工具',
            id: '2',
            guid: 'bm-tools',
            children: [
              { type: 'url', name: '第二页', url: `${baseURL}/second`, id: '3', guid: 'bm-second' }
            ]
          },
          { type: 'folder', name: '空文件夹', id: '4', guid: 'bm-empty', children: [] }
        ]
      },
      other: {
        type: 'folder',
        name: '其他书签',
        children: [
          { type: 'url', name: '其他示例', url: 'https://example.org/', id: '5', guid: 'bm-other' },
          { type: 'url', name: '脚本', url: 'javascript:alert(1)', id: '6', guid: 'bm-js' }
        ]
      }
    },
    version: 1
  }
}

function seedChrome(dir: string): void {
  mkdirSync(join(dir, 'Default'), { recursive: true })
  writeFileSync(
    join(dir, 'Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: '个人' } } } })
  )
  writeFileSync(join(dir, 'Default', 'Bookmarks'), JSON.stringify(chromeFixture()))
}

/**
 * 预置「已经导入过」的本地书签库。
 *
 * 第一条用例验的是浏览器交互，不该再一次走完导入向导；直接写 `local_state`，
 * 与真实导入后的存储完全同形（同 key、同树结构）。
 */
function seedImportedBookmarks(dataDir: string): void {
  // seedStudioDatabase 已经跑过迁移，这里只补一行 local_state。
  const db = new Database(join(dataDir, 'brewphase.db'))
  db.pragma('busy_timeout = 5000')

  const bookmark = (guid: string, title: string, url: string) => ({
    kind: 'bookmark',
    id: `chrome:Default:g:${guid}`,
    title,
    url,
    sourceProfile: 'Default',
    sourceProfileName: '个人',
    guid
  })
  const folder = (guid: string, title: string, children: unknown[]) => ({
    kind: 'folder',
    id: `chrome:Default:g:${guid}`,
    title,
    children,
    sourceProfile: 'Default',
    sourceProfileName: '个人',
    guid
  })
  const tree = {
    version: 1,
    updatedAt: Date.now(),
    roots: [
      {
        kind: 'bookmark_bar',
        id: 'chrome:Default:root:bookmark_bar',
        title: '书签栏',
        sourceProfile: 'Default',
        sourceProfileName: '个人',
        children: [
          bookmark('bm-home', '本地首页', `${baseURL}/`),
          folder('bm-tools', '工具', [bookmark('bm-second', '第二页', `${baseURL}/second`)]),
          folder('bm-empty', '空文件夹', [])
        ]
      },
      {
        kind: 'other',
        id: 'chrome:Default:root:other',
        title: '其他书签',
        sourceProfile: 'Default',
        sourceProfileName: '个人',
        children: [bookmark('bm-other', '其他示例', 'https://example.org/')]
      }
    ]
  }

  db.prepare(
    'insert into local_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run('browser.bookmarks.v1', JSON.stringify(tree))
  db.close()
}

async function launch(chromeDir: string, options?: { imported?: boolean }): Promise<{
  app: ElectronApplication
  page: Page
  dataDir: string
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bp-browser-bookmarks-'))
  seedStudioDatabase(dataDir)
  if (options?.imported) seedImportedBookmarks(dataDir)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: dataDir,
    BREWPHASE_CHROME_USER_DATA_DIR: chromeDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.BREWPHASE_FORCE_ONBOARDING

  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.studio-home')).toBeVisible()
  await page.addStyleTag({ content: '.browser-panel{animation:none !important}' })
  return { app, page, dataDir }
}

/** 主进程里的原生网页容器：是否存在、当前地址、是否可见。 */
async function browserView(
  app: ElectronApplication
): Promise<{ count: number; url: string; visible: boolean; id: number | null }> {
  return app.evaluate(({ BrowserWindow, session, webContents }, partition) => {
    const target = session.fromPartition(partition)
    const window = BrowserWindow.getAllWindows()[0]
    const child = window?.contentView.children.find((item) => Boolean(item.webContents))
    return {
      count: webContents.getAllWebContents().filter((contents) => contents.session === target).length,
      url: child?.webContents.getURL() ?? '',
      visible: child ? (typeof child.getVisible === 'function' ? child.getVisible() : true) : false,
      // webContents id 是「同一个容器」的硬证据：销毁再建会换一个 id。
      id: child?.webContents.id ?? null
    }
  }, BROWSER_PARTITION)
}

async function waitForLoaded(page: Page): Promise<void> {
  await expect(page.locator('.browser-panel__spinner')).toHaveCount(0, { timeout: 15_000 })
}

test('起始页展示书签、文件夹可展开、点书签导航、返回起始页不销毁网页', async () => {
  const chromeDir = mkdtempSync(join(tmpdir(), 'bp-chrome-'))
  seedChrome(chromeDir)
  const { app, page, dataDir } = await launch(chromeDir, { imported: true })

  try {
    await page.getByRole('button', { name: '打开浏览器' }).click()
    await expect(page.locator('.browser-panel')).toBeVisible()

    // 两个根都有内容 → 两块货架；「空文件夹」保留在书签栏里。
    await expect(page.locator('.browser-shelf')).toHaveCount(2)
    await expect(page.locator('.browser-shelf').first()).toContainText('书签栏')
    await expect(page.locator('.browser-shelf').first()).toContainText('本地首页')
    await expect(page.locator('.browser-shelf').first()).toContainText('工具')
    await expect(page.locator('.browser-shelf').first()).toContainText('空文件夹')

    // 文件夹默认收起；点开才看到子书签。
    const tools = page.locator('.browser-node__row--folder', { hasText: '工具' })
    await expect(tools).toHaveAttribute('aria-expanded', 'false')
    await tools.click()
    await expect(tools).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.browser-node__children')).toContainText('第二页')

    // 点书签 → 真的在原生容器里加载。
    await page.locator('.browser-node__row', { hasText: '本地首页' }).click()
    await waitForLoaded(page)
    const loaded = await browserView(app)
    expect(loaded.count).toBe(1)
    expect(loaded.url).toBe(`${baseURL}/`)
    expect(loaded.visible).toBe(true)

    // 回到起始页：网页容器还在，只是不可见；地址仍是刚才那一页。
    await page.getByRole('button', { name: '起始页' }).click()
    await expect(page.locator('.browser-start')).toBeVisible()
    await expect(page.locator('.browser-start__title')).toHaveText('想去哪里？')
    const hidden = await browserView(app)
    expect(hidden.count).toBe(1)
    expect(hidden.url).toBe(`${baseURL}/`)
    expect(hidden.visible).toBe(false)
    // 同一个 webContents：回起始页没有销毁再重建。
    expect(hidden.id).toBe(loaded.id)

    // 再点另一个书签：复用同一个容器继续加载（Session 未断）。
    await page.locator('.browser-node__row--folder', { hasText: '工具' }).click()
    await page.locator('.browser-node__row', { hasText: '第二页' }).click()
    await waitForLoaded(page)
    const resumed = await browserView(app)
    expect(resumed.count).toBe(1)
    expect(resumed.id).toBe(loaded.id)
    expect(resumed.url).toBe(`${baseURL}/second`)
    expect(resumed.visible).toBe(true)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(chromeDir, { recursive: true, force: true })
  }
})

test('设置 → 浏览器：检测配置、预览、导入并显示统计；重复导入不重复生成', async () => {
  const chromeDir = mkdtempSync(join(tmpdir(), 'bp-chrome-'))
  seedChrome(chromeDir)
  const { app, page, dataDir } = await launch(chromeDir)

  try {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '浏览器', exact: true }).click()

    await expect(page.getByText('已检测到 Chrome · 1 个配置')).toBeVisible()
    await expect(page.locator('.browser-profile')).toHaveCount(1)
    await expect(page.locator('.browser-profile__name')).toHaveText('个人')
    await expect(page.locator('.browser-profile__state')).toHaveText('有书签文件')

    await page.getByRole('button', { name: '预览书签' }).click()
    await expect(page.getByText('将导入「个人」里的书签，文件夹层级会一起保留。')).toBeVisible()
    // 书签栏 2 条书签 + 2 个文件夹；其他书签 1 条有效 + 1 条 javascript: 被跳过。
    const previewList = page.locator('.info-list')
    await expect(previewList).toContainText('2 条书签 · 2 个文件夹')
    await expect(previewList).toContainText('1 条书签')
    await expect(previewList).toContainText('无法导入')

    await page.getByRole('button', { name: '导入这些书签' }).click()
    await expect(page.getByText('导入完成')).toBeVisible()
    await expect(page.locator('.browser-import__stats')).toContainText('新增 3 条')
    await expect(page.locator('.browser-import__stats')).toContainText('跳过 1 条')
    await expect(page.getByText('现在共有 3 条书签')).toBeVisible()

    // 再导入一次：幂等，新增 0 条。
    await page.getByRole('button', { name: '再导入一次' }).click()
    await page.getByRole('button', { name: '预览书签' }).click()
    await page.getByRole('button', { name: '导入这些书签' }).click()
    await expect(page.getByText('导入完成')).toBeVisible()
    await expect(page.locator('.browser-import__stats')).toContainText('新增 0 条')
    await expect(page.getByText('现在共有 3 条书签')).toBeVisible()
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(chromeDir, { recursive: true, force: true })
  }
})
