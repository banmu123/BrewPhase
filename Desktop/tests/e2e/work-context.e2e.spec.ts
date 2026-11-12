import { test, expect, _electron as electron } from '@playwright/test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinLocale } from './locale'

/**
 * Work Context V1 E2E：MCP 建数据 → Studio Home「继续工作」区块展示 →
 * 资源 chip 点击跳转。隔离临时数据库，不碰真实用户数据。
 */

test('MCP 创建工作上下文后，Studio Home 展示并可点击关联资源跳转', async () => {
  test.setTimeout(120_000)
  const userData = mkdtempSync(join(tmpdir(), 'bp-work-context-e2e-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.BREWPHASE_FORCE_ONBOARDING

  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.topbar')).toBeVisible()

  // 1) 建 MCP 客户端（全 scope）→ stdio 连接
  const created = await page.evaluate(() =>
    window.brewphase.mcp.createClient({
      name: 'Work Context E2E',
      scopes: ['records:read', 'records:create', 'canvas:read', 'canvas:write', 'work_context:read', 'work_context:create', 'work_context:update', 'work_context:link']
    })
  )
  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(process.cwd(), 'out', 'mcp', 'stdio.mjs')],
    env: { ...process.env, BREWPHASE_MCP_USER_DATA_DIR: userData, BREWPHASE_MCP_TOKEN: created.token }
  })
  const client = new Client({ name: 'wc-e2e', version: '1.0.0' })
  await client.connect(transport)
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args })
    if (response.isError) throw new Error(`${name}: ${JSON.stringify(response.content)}`)
    return JSON.parse(response.content?.[0]?.type === 'text' ? response.content[0].text : '{}')
  }

  // 2) MCP 创建记录 / 画布 / 工作上下文并关联
  const record = (await call('create_record', {
    carrier: 'link',
    title: 'E2E 研究记录',
    note: '',
    url: 'https://example.com/e2e',
    idempotency_key: 'wc-e2e-record'
  })) as { record_id: string }
  const canvas = (await call('create_canvas', { name: 'E2E 研究画布', idempotency_key: 'wc-e2e-canvas' })) as {
    canvas_id: string
  }
  const context = (await call('create_work_context', {
    title: '继续研究 AI Agent 工作流',
    summary: '已完成三个项目的初步对比',
    next_step: '精读 LangGraph checkpoint 源码',
    idempotency_key: 'wc-e2e-context'
  })) as { context_id: string }
  await call('link_work_context_resource', {
    context_id: context.context_id,
    resource_type: 'record',
    resource_id: record.record_id,
    idempotency_key: 'wc-e2e-link-record'
  })
  await call('link_work_context_resource', {
    context_id: context.context_id,
    resource_type: 'canvas',
    resource_id: canvas.canvas_id,
    idempotency_key: 'wc-e2e-link-canvas'
  })
  await call('link_work_context_resource', {
    context_id: context.context_id,
    resource_type: 'url',
    url: 'https://example.com/spec',
    idempotency_key: 'wc-e2e-link-url'
  })

  // 3) 回到 Studio Home：区块显示标题 / 摘要 / 下一步 / 计数
  await page.getByRole('button', { name: 'BREWPHASE', exact: true }).click()
  await page.waitForTimeout(600)
  const section = page.locator('.work-context')
  await expect(section).toBeVisible()
  await expect(section.getByText('继续研究 AI Agent 工作流')).toBeVisible()
  await expect(section.getByText('已完成三个项目的初步对比')).toBeVisible()
  await expect(section.getByText('精读 LangGraph checkpoint 源码')).toBeVisible()
  await expect(section.getByText(/1 条记录 · 1 块画布 · 1 个链接/)).toBeVisible()

  // 4) 点击 record chip → 跳转到记录页
  await section.locator('.work-context__chip', { hasText: 'E2E 研究记录' }).click()
  await expect(page.locator('.record-masonry')).toBeVisible()
  await expect(page.locator('.record-masonry')).toContainText('E2E 研究记录')

  // 5) 回到 Studio → 点击 canvas chip → 进入画布模块
  await page.getByRole('button', { name: 'BREWPHASE', exact: true }).click()
  await page.waitForTimeout(500)
  await page.locator('.work-context__chip', { hasText: 'E2E 研究画布' }).click()
  await expect(page.locator('.page-header')).toBeVisible()

  // 6) MCP get_work_context 复核
  const detail = (await call('get_work_context', { context_id: context.context_id })) as {
    record_count: number
    canvas_count: number
    url_count: number
  }
  expect(detail.record_count).toBe(1)
  expect(detail.canvas_count).toBe(1)
  expect(detail.url_count).toBe(1)

  await client.close()
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})
