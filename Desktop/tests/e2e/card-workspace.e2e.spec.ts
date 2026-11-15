import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher, expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { pinLocale } from './locale'
import { startWebFixture, type WebFixture } from './web-fixture'

/**
 * AI Card Workspace Bridge（Phase 1）端到端冒烟：
 * - 独立网页窗口：BrewPhase 按钮 → 工具栏 → 添加工作区（env 预置目录，不弹窗）
 *   → 浏览文件 → 选择 → 生成上下文 → 复制按钮态；展开/收起时 stage 高度变化
 *   （DOM → 主进程 bounds 的证据），页面实例不刷新。
 * - 圆桌面板：复制 URL 按钮已被工作区按钮替换；compact 工具栏展开后
 *   原生 view bounds 跟随内容区（__bpTestHooks.roundtableViews）。
 * - 绑定按 tabId 生效：同一 app 里独立窗口与圆桌看到同一绑定；
 *   标签关闭后绑定被清理。
 */

let fixture: WebFixture
let workspaceRoot = ''

test.beforeAll(async () => {
  fixture = await startWebFixture()
  // 真实的工作区 fixture：普通文件 + 敏感文件 + 依赖目录。
  workspaceRoot = mkdtempSync(join(tmpdir(), 'bp-ws-e2e-'))
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'node_modules', 'lib'), { recursive: true })
  writeFileSync(join(workspaceRoot, 'README.md'), '# BrewPhase E2E\nhello workspace')
  writeFileSync(join(workspaceRoot, 'src', 'index.ts'), 'export const bridge = true\n')
  writeFileSync(join(workspaceRoot, 'node_modules', 'lib', 'dep.ts'), 'export {}\n')
  writeFileSync(join(workspaceRoot, '.env'), 'SECRET=1\n')
})

test.afterAll(async () => {
  await fixture.close()
  rmSync(workspaceRoot, { recursive: true, force: true })
})

async function launch(): Promise<{ app: ElectronApplication; page: Page; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bp-card-ws-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: dataDir,
    BREWPHASE_WORKSPACE_DIR_CHOICE: workspaceRoot,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.BREWPHASE_FORCE_ONBOARDING
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electronLauncher.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page, dataDir }
}

async function addCard(page: Page, path: string): Promise<Locator> {
  await page.getByRole('button', { name: '添加网页' }).click()
  const form = page.locator('.web-card--editing').last()
  await expect(form).toBeVisible()
  await form.locator('input').fill(fixture.url(path))
  await form.getByRole('button', { name: '打开' }).click()
  const card = page.locator('.web-card:not(.web-card--editing)').last()
  await expect(card).toBeVisible({ timeout: 20_000 })
  return card
}

async function setFakeCursor(app: ElectronApplication, point: { x: number; y: number } | null): Promise<void> {
  await app.evaluate((_, value) => {
    const hooks = (globalThis as unknown as {
      __bpTestHooks?: { setDragCursor: (p: { x: number; y: number } | null) => void }
    }).__bpTestHooks
    if (!hooks) throw new Error('test hooks missing (packaged build?)')
    hooks.setDragCursor(value)
  }, point)
}

test('独立窗口：BrewPhase 按钮 → 工具栏全流程 → stage 跟随 → 收回卡片架正常', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launch()
  const card = await addCard(page, '/a')
  await expect(card).toContainText('fixture a', { timeout: 20_000 })
  const tabId = await card.getAttribute('data-tab-id')

  // 拆出独立窗口（真实 UI 链路见 web-cards.spec；这里直接走 IPC detach，
  // 聚焦被测能力而不是重复拖拽链路）。
  await page.evaluate((id) => window.brewphase.browserTabs.detach(id as string, 100, 100), tabId)
  const floatShells = (): number =>
    app.windows().filter((candidate) => candidate.url().includes('bpFloat=')).length
  await expect.poll(floatShells, { timeout: 20_000 }).toBe(1)
  await setFakeCursor(app, null)

  const floatPage = app
    .windows()
    .find((candidate) => candidate !== page && candidate.url().includes('bpFloat'))
  expect(floatPage).toBeTruthy()
  await expect(floatPage!.locator('.bp-float')).toBeVisible()

  // 新按钮在「收回卡片架」旁边；收起状态工具栏不渲染（默认收起）。
  const wsButton = floatPage!.locator('.bp-float__ws-btn')
  await expect(wsButton).toBeVisible()
  await expect(floatPage!.getByRole('button', { name: '收回卡片架' })).toBeVisible()
  expect(await floatPage!.locator('.cwt').count()).toBe(0)

  const stageBefore = await floatPage!.locator('.bp-float__stage').boundingBox()
  expect(stageBefore).not.toBeNull()

  // 展开 → 直接呈现项目选择列表（无大标题/说明文，添加是列表末尾的虚线行）。
  await wsButton.click()
  const toolbar = floatPage!.locator('.cwt')
  await expect(toolbar).toBeVisible()
  await expect(toolbar).toContainText('选择项目')
  await expect(toolbar.locator('.cwt__pickrow--add')).toContainText('添加本地项目文件夹')

  // stage 宽度被右侧竖栏挤压（DOM 变了 → ResizeObserver 会把新 bounds 报给主进程）。
  const stageAfter = await floatPage!.locator('.bp-float__stage').boundingBox()
  expect(stageAfter!.height).toBe(stageBefore!.height)
  expect(stageAfter!.width).toBeLessThan(stageBefore!.width)
  // 原生网页实例没动（没有 reload）。
  const born = await page.evaluate(
    (id) => window.brewphase.browserTabs.executeOnTab(id as string, 'window.__born'),
    tabId
  )
  expect(typeof born).toBe('number')

  // 点添加行（env 预置目录，不弹系统对话框）→ 自动绑定 → 紧凑项目条。
  await toolbar.locator('.cwt__pickrow--add').click()
  await expect(toolbar.locator('.cwt__project-link')).toBeVisible({ timeout: 10_000 })
  await expect(toolbar.locator('.cwt__pathline')).toContainText('bp-ws-e2e')
  const binding = await page.evaluate((id) => window.brewphase.localWorkspace.binding(id as string), tabId)
  expect(binding.workspace).not.toBeNull()
  expect(binding.workspace?.availability).toBe('available')

  // 浏览文件：README 在列、node_modules 与 .env 不出现。
  await toolbar.getByRole('button', { name: '浏览文件' }).click()
  const fileList = toolbar.locator('.cwt__file-list')
  await expect(fileList).toContainText('README.md', { timeout: 10_000 })
  await expect(fileList).toContainText('src')
  await expect(fileList).not.toContainText('node_modules')
  await expect(fileList).not.toContainText('.env')

  // 选 README → 生成上下文 → 预览 → 复制按钮态变化。
  await fileList.getByRole('button', { name: /README\.md/ }).click()
  await toolbar.getByRole('button', { name: '生成上下文' }).click()
  const preview = toolbar.locator('.cwt__preview')
  await expect(preview).toContainText('hello workspace', { timeout: 10_000 })
  const copyButton = toolbar.getByRole('button', { name: '复制到 AI 对话' })
  await copyButton.click()
  // 复制成功后按钮文案变为「✓ 已复制…」——按新文案断言状态。
  await expect(toolbar.locator('.cwt__mini--primary')).toContainText('已复制', { timeout: 5_000 })

  // 收起：工具栏消失、stage 恢复。
  await toolbar.getByRole('button', { name: '收起' }).click()
  await expect(floatPage!.locator('.cwt')).toHaveCount(0)
  const stageRestored = await floatPage!.locator('.bp-float__stage').boundingBox()
  expect(Math.abs(stageRestored!.width - stageBefore!.width)).toBeLessThanOrEqual(2)
  expect(Math.abs(stageRestored!.height - stageBefore!.height)).toBeLessThanOrEqual(2)

  // 收回卡片架仍然正常（原生功能无回归）。
  await floatPage!.getByRole('button', { name: '收回卡片架' }).click()
  await expect.poll(floatShells, { timeout: 20_000 }).toBe(0)
  await expect(card).not.toHaveAttribute('data-presentation', 'detached')
  // 绑定不因收回而丢失。
  const bindingAfter = await page.evaluate((id) => window.brewphase.localWorkspace.binding(id as string), tabId)
  expect(bindingAfter.workspace).not.toBeNull()

  await app.close()
})

test('圆桌面板：工作区按钮替换复制 URL、右侧竖栏、view bounds 跟随', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launch()

  // 进入圆桌工作空间并直接新建网页面板（真实 WebCard + join）。
  await page.getByRole('button', { name: '进入工作空间' }).click()
  await expect(page.locator('.rt-workspace[data-host="docked"]')).toBeVisible({ timeout: 15_000 })
  await page.locator('.rt-workspace__add > button').first().click()
  await page.locator('.rt-workspace__add-input').fill(fixture.url('/round'))
  await page.locator('.rt-workspace__add-pop form button[type="submit"]').click()
  await expect(page.locator('.rt-panel').last()).toBeVisible({ timeout: 20_000 })
  const tabId = await page.locator('.rt-panel').last().getAttribute('data-tab-id')
  expect(tabId).toMatch(/^tab-/)

  const panel = page.locator(`.rt-panel[data-tab-id="${tabId}"]`)
  // 旧「复制 URL」（⧉）已替换为工作区按钮（📁，aria-label）。
  const wsButton = panel.locator('.rt-panel__action[aria-label="BrewPhase 工作区"]')
  await expect(wsButton).toBeVisible()
  expect(await panel.locator('.rt-panel__action[title="复制"]').count()).toBe(0)
  await expect(panel.locator('.rt-panel__action--remove')).toBeVisible()

  // 读原生 view bounds 的钩子。
  const readViewBounds = async (): Promise<{ height: number; width: number } | null> => {
    return app.evaluate((_, id) => {
      const hooks = (globalThis as unknown as {
        __bpTestHooks?: { roundtableViews?: () => Array<{ tabId: string; bounds: { width: number; height: number } }> }
      }).__bpTestHooks
      const view = hooks?.roundtableViews?.().find((item) => item.tabId === id)
      return view ? { height: view.bounds.height, width: view.bounds.width } : null
    }, tabId)
  }

  await expect
    .poll(async () => (await readViewBounds())?.height ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(100)
  const boundsBefore = (await readViewBounds())!

  // 展开 compact 工具栏 → 绑定 → 内容区缩小 → 原生 view bounds 跟随。
  await wsButton.click()
  const toolbar = panel.locator('.cwt')
  await expect(toolbar).toBeVisible()
  await expect(toolbar).toHaveAttribute('data-variant', 'side')
  await expect(toolbar).toContainText('选择项目')

  await toolbar.locator('.cwt__pickrow--add').click()
  await expect(toolbar.locator('.cwt__project-link')).toBeVisible({ timeout: 10_000 })
  const binding = await page.evaluate((id) => window.brewphase.localWorkspace.binding(id as string), tabId)
  expect(binding.workspace).not.toBeNull()

  const contentBefore = await panel.locator('.rt-panel__content').evaluate((el) => el.getBoundingClientRect().width)
  await expect
    .poll(async () => (await readViewBounds())?.width ?? 0)
    .toBeLessThan(boundsBefore.width)

  // 收起 → view bounds 恢复（±3px 容差）。
  await toolbar.getByRole('button', { name: '收起' }).click()
  await expect(panel.locator('.cwt')).toHaveCount(0)
  const contentAfter = await panel.locator('.rt-panel__content').evaluate((el) => el.getBoundingClientRect().width)
  await expect
    .poll(async () => (await readViewBounds())?.width ?? 0)
    .toBeGreaterThan(contentBefore - 3)
  expect(Math.abs((await readViewBounds())!.width - contentAfter)).toBeLessThanOrEqual(3)

  // 移除圆桌成员不删绑定（tab 回卡片架，绑定仍在）。
  await panel.locator('.rt-panel__action--remove').click()
  await expect(panel).toHaveCount(0, { timeout: 15_000 })
  const bindingAfterLeave = await page.evaluate((id) => window.brewphase.localWorkspace.binding(id as string), tabId)
  expect(bindingAfterLeave.workspace).not.toBeNull()

  await app.close()
})

test('整理回复：粘贴导入 → 本地分类 → 保存操作草稿', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launch()
  const card = await addCard(page, '/reply')
  await expect(card).toContainText('fixture reply', { timeout: 20_000 })
  const tabId = await card.getAttribute('data-tab-id')

  await page.evaluate((id) => window.brewphase.browserTabs.detach(id as string, 100, 100), tabId)
  const floatShells = (): number =>
    app.windows().filter((candidate) => candidate.url().includes('bpFloat=')).length
  await expect.poll(floatShells, { timeout: 20_000 }).toBe(1)
  await setFakeCursor(app, null)

  const floatPage = app
    .windows()
    .find((candidate) => candidate !== page && candidate.url().includes('bpFloat'))
  expect(floatPage).toBeTruthy()
  await expect(floatPage!.locator('.bp-float')).toBeVisible()

  // 打开工作区侧栏 → 添加工作区（env 预置目录）→ 自动绑定。
  await floatPage!.locator('.bp-float__ws-btn').click()
  const toolbar = floatPage!.locator('.cwt[data-variant="side"]')
  await expect(toolbar).toBeVisible()
  await toolbar.locator('.cwt__pickrow--add').click()
  await expect(toolbar.locator('.cwt__project-link')).toBeVisible({ timeout: 10_000 })

  // 「整理回复」→ intake → 粘贴 → 确认导入。
  await toolbar.getByRole('button', { name: '整理回复' }).click()
  const replyPanel = toolbar.locator('[data-reply-panel]')
  await expect(replyPanel.locator('.cwt__textarea')).toBeVisible()
  await replyPanel
    .locator('.cwt__textarea')
    .fill(
      [
        '# 重构方案',
        '把数据库层抽成 repository，保持接口稳定。',
        '',
        '## 修改文件',
        '',
        '- 修改 src/main/index.ts 的装配顺序',
        '- 新建 src/main/db/pool.ts',
        '',
        '```bash',
        'pnpm typecheck && pnpm test',
        '```',
        '',
        '```diff',
        '--- a/src/main/index.ts',
        '+++ b/src/main/index.ts',
        '@@ -1 +1,2 @@',
        "+import './pool'",
        '```',
        '',
        '参考：https://example.com/guide',
        '',
        '下一步：跑通 CI 后合并。'
      ].join('\n')
    )
  await replyPanel.getByRole('button', { name: '确认导入' }).click()

  // 分类结果：本地规则解析（无模型调用）——标题是重点、bash 是命令、diff 是 patch。
  await expect(replyPanel.locator('.cwt__tab', { hasText: '全部' })).toBeVisible()
  const segs = replyPanel.locator('.cwt__seg')
  await expect(segs.first()).toBeVisible({ timeout: 10_000 })
  await expect(replyPanel.locator('.cwt__chip', { hasText: '重点' }).first()).toBeVisible()
  await expect(replyPanel.locator('.cwt__chip', { hasText: '命令' }).first()).toBeVisible()
  await expect(replyPanel.locator('.cwt__chip', { hasText: 'Patch' }).first()).toBeVisible()

  // 过滤：切到「命令」tab 只剩命令段。
  await replyPanel.locator('.cwt__tab', { hasText: '命令' }).click()
  await expect(replyPanel.locator('.cwt__seg-content')).toContainText('pnpm typecheck')

  // 保存草稿 → 草稿视图显示风险提示与候选统计。
  await replyPanel.getByRole('button', { name: '存为草稿' }).click()
  await expect(replyPanel.locator('.cwt__seg-title').first()).toBeVisible({ timeout: 10_000 })
  await expect(replyPanel.locator('.cwt__pathline', { hasText: '命令候选' }).first()).toBeVisible()
  // 草稿是本地数据：持久化验证由单测覆盖，这里确认 UI 链路闭环。
  await expect(replyPanel.locator('.cwt__chip', { hasText: '草稿' }).first()).toBeVisible()

  await app.close()
})