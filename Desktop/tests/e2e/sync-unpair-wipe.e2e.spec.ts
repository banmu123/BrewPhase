import { test, expect } from '@playwright/test'
import { pinLocale } from './locale'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electronLauncher } from '@playwright/test'
import { migrations } from '../../src/main/database/migrations'

/**
 * 撤销配对时的「清空同步内容」。
 *
 * 这是应用里唯一会成批删数据的入口，所以验收的不是按钮能点，而是两件事：
 * 1. 该走的都走了：记录 / 画布 / 媒体 / 同步状态；
 * 2. 不该动的没动：豆子（这台 Mac 自己的数据）。
 *
 * 数据库直接用真实迁移建，设备也真的插在 devices 里——设置页显示的是
 * 真实 IPC 查询出来的状态，不是造出来的假 UI。
 */

const userData = mkdtempSync(join(tmpdir(), 'bp-unpair-wipe-'))
const dbPath = join(userData, 'brewphase.db')

function seed(): void {
  mkdirSync(userData, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  for (const migration of migrations) db.exec(migration.sql)
  db.pragma(`user_version = ${migrations.length}`)

  const now = Date.now()
  db.prepare('insert into beans (id, name, created_at, updated_at) values (?,?,?,?)').run(
    'bean-unpair-1',
    '耶加雪菲 沃卡',
    now,
    now
  )
  db.prepare(
    `insert into records (id, carrier, title, note, url_string, provider, is_sample, created_at, updated_at)
     values (?, 'text', '撤销测试记录', '来自手机的一段正文', '', 'generic', 0, ?, ?)`
  ).run('record-unpair-1', now, now)
  db.prepare('insert into canvases (id, name, created_at, updated_at) values (?,?,?,?)').run(
    'canvas-unpair-1',
    '测试画布',
    now,
    now
  )
  db.prepare(
    'insert into devices (id, name, kind, token_hash, paired_at) values (?,?,?,?,?)'
  ).run('bp_ios_unpair_test', 'iPhone', 'ios', 'a'.repeat(64), now)
  db.close()
}

test.beforeAll(() => {
  seed()
})

test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

test('撤销授权并清空：同步实体清零，豆子保留', async () => {
  test.setTimeout(60_000)
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
  await pinLocale(page)
  await page.waitForLoadState('domcontentloaded')

  // 清空之前：记录页有内容
  await page.getByRole('button', { name: '记录', exact: true }).click()
  await expect(page.locator('.record-tile')).toHaveCount(1)
  await expect(page.locator('.record-tile', { hasText: '撤销测试记录' })).toHaveCount(1)

  // 设置页 → 设备同步子页 → 撤销授权 → 选「撤销并清空内容」
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '设备同步', exact: true }).click()
  await expect(page.getByText('已配对设备')).toBeVisible()
  await page.getByRole('button', { name: '撤销授权' }).click()
  // 两个后果分开的按钮：确认 UI 没有把「清空」藏在默认动作里
  await expect(page.getByRole('button', { name: '只撤销授权' })).toBeVisible()
  await page.getByRole('button', { name: '撤销并清空内容' }).click()

  await expect(page.getByText(/已清空 1 条记录/)).toBeVisible({ timeout: 15_000 })
  // 设备已撤销 → 列表回到空状态
  await expect(page.getByText('还没有配对的设备。')).toBeVisible()

  // 直接核对数据库：页面断言会被「切页后列表刚挂载、items 还是空数组」骗过去，
  // 这种假阳性在删除类测试里最危险——它会在什么都没删的情况下也变绿。
  const verify = new Database(dbPath, { readonly: true })
  try {
    const count = (table: string): number =>
      Number((verify.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n)
    expect(count('records'), '记录应该被清空').toBe(0)
    expect(count('canvases'), '画布应该被清空').toBe(0)
    expect(count('record_tags')).toBe(0)
    expect(count('beans'), '豆子必须保留').toBe(1)
  } finally {
    verify.close()
  }

  // 记录页跟着变空（撤销时广播了 sync:changed）
  await page.getByRole('button', { name: '记录', exact: true }).click()
  await expect(page.locator('.record-tile')).toHaveCount(0)
  await page.waitForTimeout(600)
  await expect(page.locator('.record-tile')).toHaveCount(0)
  await expect(page.getByText('还没有记录。先从一条链接、一张图或一段文字开始。')).toBeVisible()

  // 咖啡数据一条都不能少
  await page.getByRole('button', { name: '咖啡', exact: true }).click()
  await expect(page.getByText('耶加雪菲 沃卡').first()).toBeVisible()

  await page.screenshot({ path: '/tmp/sync-unpair-wipe.png' })
  await app.close()
})
