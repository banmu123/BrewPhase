import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'

const userData = mkdtempSync(join(tmpdir(), 'bp-canvas-diag-'))
const dbPath = join(userData, 'brewphase.db')

test('诊断：画布添加记录', async () => {
  mkdirSync(userData, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  for (const m of migrations) db.exec(m.sql)
  db.pragma(`user_version = ${migrations.length}`)
  const now = Date.now()
  db.prepare('insert into beans (id, name, created_at, updated_at) values (?,?,?,?)').run('a1a1a1a1-2222-4222-8222-000000000002', '豆', now, now)
  db.prepare(
    `insert into records (id, carrier, title, note, url_string, provider, is_sample, created_at, updated_at)
     values (?, 'text', '测试记录', '', '', 'generic', 0, ?, ?)`
  ).run('a1a1a1a1-1111-4111-8111-000000000001', now, now)
  db.prepare('insert into canvases (id, name, created_at, updated_at) values (?,?,?,?)').run('a1a1a1a1-3333-4333-8333-000000000003', '画布', now, now)
  db.close()

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
  page.on('console', (message) => console.log('[console]', message.type(), message.text()))
  page.on('pageerror', (error) => console.log('[pageerror]', error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'Canvas', exact: true }).click()
  await expect(page.locator('.canvas-topbar')).toBeVisible()
  await page.screenshot({ path: '/tmp/canvas-diag-1.png' })

  await page.getByRole('button', { name: '添加一条记录' }).click()
  await expect(page.locator('.canvas-panel')).toBeVisible()
  await page.screenshot({ path: '/tmp/canvas-diag-2.png' })
  await page.locator('.canvas-panel .add-card', { hasText: '测试记录' }).click()
  await page.waitForTimeout(800)
  const verify = new Database(dbPath, { readonly: true })
  console.log('[db] nodes =', JSON.stringify(verify.prepare('select position_x, position_y from canvas_nodes').all()))
  verify.close()
  // 拖动测试：节点世界坐标 0,0，Fit 后应在视野内。抓它的屏幕位置拖 60px。
  const box = await page.locator('.canvas-wrap').boundingBox()
  await page.mouse.move(box.x + 160, box.y + 160)
  await page.mouse.down()
  await page.mouse.move(box.x + 260, box.y + 260, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  const verify2 = new Database(dbPath, { readonly: true })
  console.log('[db] after drag =', JSON.stringify(verify2.prepare('select position_x, position_y from canvas_nodes').all()))
  verify2.close()
  await page.screenshot({ path: '/tmp/canvas-diag-3.png' })
  await app.close()
})

test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})
