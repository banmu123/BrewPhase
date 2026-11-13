import { test, expect } from '@playwright/test'
import { _electron as electronLauncher } from '@playwright/test'
import Database from 'better-sqlite3'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrations } from '../../src/main/database/migrations'
import { pinLocale } from './locale'
import { openSpace } from './nav'

/**
 * Canvas 视觉验收（仅 `VISUAL_CHECK=1` 时跑）。
 *
 * 功能回归在 canvas-add.e2e.spec.ts；这里只负责把「看得到的东西」截下来：
 * 空白台面、四类节点混排、选中态、工具栏、Inspector，以及深色下的同一屏。
 *
 * 布局直接写进 canvas_nodes，不靠拖拽——截图要的是可复现的构图。
 */

const visual = Boolean(process.env.VISUAL_CHECK)
test.skip(!visual, '视觉验收用例，设 VISUAL_CHECK=1 才跑')

const NOW = Date.now()
const CANVAS_ID = 'c0c0c0c0-1111-4111-8111-000000000001'
const EMPTY_CANVAS_ID = 'c0c0c0c0-1111-4111-8111-000000000002'

type Fixture = { userData: string; dbPath: string }

function seed(fixture: Fixture): void {
  const { userData, dbPath } = fixture
  mkdirSync(userData, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  for (const m of migrations) db.exec(m.sql)
  db.pragma(`user_version = ${migrations.length}`)

  const record = db.prepare(
    `insert into records (id, carrier, title, note, summary, url_string, provider,
      platform_content_id, media_path, preview_path, is_sample, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  )

  // 1) 有封面的链接 + 画布备注
  record.run(
    'b0b0b0b0-1111-4111-8111-000000000001',
    'link',
    '一杯手冲的十二个变量',
    '',
    '水温、粉水比、研磨度、滤杯——每个变量都值得单独固定下来试一遍。这篇把新手最容易踩的坑整理成了一张表。',
    'https://sspai.com/post/000000',
    'generic',
    null,
    null,
    'canvas-cover-a.jpg',
    NOW,
    NOW
  )
  // 2) 图片
  record.run(
    'b0b0b0b0-1111-4111-8111-000000000002',
    'image',
    '周六早上的窗边',
    '',
    '',
    '',
    'generic',
    null,
    'canvas-cover-b.jpg',
    null,
    NOW,
    NOW
  )
  // 3) 文字
  record.run(
    'b0b0b0b0-1111-4111-8111-000000000003',
    'text',
    '关于安静的几点想法',
    '不被打断的时间比任何工具都重要。先把桌面清空，再谈效率。',
    '',
    '',
    'generic',
    null,
    null,
    null,
    NOW,
    NOW
  )
  // 4) 视频（有封面）
  record.run(
    'b0b0b0b0-1111-4111-8111-000000000004',
    'video',
    '烘焙曲线讲解',
    '',
    '',
    '',
    'generic',
    null,
    'sample-video.mp4',
    'canvas-cover-c.jpg',
    NOW,
    NOW
  )
  // 5) 无封面链接（走域名首字兜底）
  record.run(
    'b0b0b0b0-1111-4111-8111-000000000005',
    'link',
    'Notes on slowness',
    '',
    'Doing fewer things, more slowly, tends to compound. A short essay on attention as a craft.',
    'https://marginalia.nu/notes',
    'generic',
    null,
    null,
    null,
    NOW,
    NOW
  )

  db.prepare('insert into canvases (id, name, created_at, updated_at) values (?,?,?,?)').run(
    CANVAS_ID,
    '工作台',
    NOW,
    NOW
  )
  db.prepare('insert into canvases (id, name, created_at, updated_at) values (?,?,?,?)').run(
    EMPTY_CANVAS_ID,
    '未命名',
    NOW - 60_000,
    NOW - 60_000
  )

  const node = db.prepare(
    `insert into canvas_nodes (id, canvas_id, record_id, position_x, position_y, width, height,
      z_index, annotation, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  )
  node.run('n0000000-0000-4000-8000-000000000001', CANVAS_ID, 'b0b0b0b0-1111-4111-8111-000000000001', 40, 32, 268, 268, '水温、粉水比、研磨度——三个变量先固定两个。', NOW, NOW)
  node.run('n0000000-0000-4000-8000-000000000002', CANVAS_ID, 'b0b0b0b0-1111-4111-8111-000000000002', 352, 48, 232, 232, '', NOW, NOW)
  node.run('n0000000-0000-4000-8000-000000000003', CANVAS_ID, 'b0b0b0b0-1111-4111-8111-000000000003', 40, 336, 268, 208, '', NOW, NOW)
  node.run('n0000000-0000-4000-8000-000000000004', CANVAS_ID, 'b0b0b0b0-1111-4111-8111-000000000004', 340, 316, 244, 228, '第三段降温是关键。', NOW, NOW)
  node.run('n0000000-0000-4000-8000-000000000005', CANVAS_ID, 'b0b0b0b0-1111-4111-8111-000000000005', 632, 64, 226, 196, '', NOW, NOW)

  db.prepare(
    `insert into canvas_notes (id, canvas_id, title, body, color, position_x, position_y, width, height, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'q0000000-0000-4000-8000-000000000001',
    CANVAS_ID,
    '下周要试的',
    '换一支水洗豆，把研磨调粗半格。',
    '#f6f2df',
    636,
    312,
    220,
    156,
    NOW,
    NOW
  )

  mkdirSync(join(userData, 'media'), { recursive: true })
  for (const name of ['canvas-cover-a.jpg', 'canvas-cover-b.jpg', 'canvas-cover-c.jpg']) {
    copyFileSync(join(__dirname, '..', 'fixtures', name), join(userData, 'media', name))
  }
  copyFileSync(
    join(__dirname, '..', 'fixtures', 'sample-video.mp4'),
    join(userData, 'media', 'sample-video.mp4')
  )
  db.close()
}

async function shoot(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.addStyleTag({ content: '*{transition:none !important;animation:none !important}' })
  await page.waitForTimeout(260)
  await page.screenshot({ path: `/tmp/canvas-${name}.png` })
}

test('Canvas 视觉：台面、四类节点、选中态、工具栏与 Inspector', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'bp-canvas-visual-'))
  const fixture: Fixture = { userData: dir, dbPath: join(dir, 'brewphase.db') }
  seed(fixture)

  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: {
      ...process.env,
      BREWPHASE_USER_DATA_DIR: fixture.userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
  })
  const page = await app.firstWindow()
  await pinLocale(page)
  await page.waitForLoadState('domcontentloaded')

  try {
    await openSpace(page, '画布')
    await page.waitForTimeout(600)
    // Gallery：画布列表
    await shoot(page, '1-gallery')

    // 空白台面：切到第二块空画布
    await page.locator('.gallery-card', { hasText: '未命名' }).locator('.gallery-card__open').click()
    await page.waitForTimeout(500)
    await shoot(page, '2-empty')

    // 回到有内容的画布，适配全部 → 四类节点同屏
    await page.locator('.canvas-back').click()
    await page.locator('.gallery-card', { hasText: '工作台' }).locator('.gallery-card__open').click()
    await page.getByRole('button', { name: '适配全部内容' }).click()
    await page.waitForTimeout(500)
    await shoot(page, '3-mixed')

    // 选中一张卡：espresso 细描边 + Inspector
    const wrap = await page.locator('.canvas-wrap').boundingBox()
    expect(wrap).not.toBeNull()
    await page.mouse.click(wrap!.x + 220, wrap!.y + 210)
    await page.waitForTimeout(400)
    await expect(page.locator('.node-panel')).toBeVisible()
    await shoot(page, '4-selected')

    // 工具栏：单独裁一条，看分组、间距与主操作
    const toolbar = await page.locator('.studio-toolbar').boundingBox()
    expect(toolbar).not.toBeNull()
    await page.screenshot({
      path: '/tmp/canvas-5-toolbar.png',
      clip: {
        x: Math.max(0, toolbar!.x - 24),
        y: Math.max(0, toolbar!.y - 24),
        width: toolbar!.width + 48,
        height: toolbar!.height + 48
      }
    })

    // 画笔展开色板
    await page.getByRole('button', { name: /画笔/ }).click()
    await page.waitForTimeout(300)
    const toolbarPen = await page.locator('.studio-toolbar').boundingBox()
    await page.screenshot({
      path: '/tmp/canvas-6-toolbar-pen.png',
      clip: {
        x: Math.max(0, toolbarPen!.x - 24),
        y: Math.max(0, toolbarPen!.y - 24),
        width: toolbarPen!.width + 48,
        height: toolbarPen!.height + 48
      }
    })
    await page.getByRole('button', { name: /选择/ }).click()

    // 深色：同一屏必须仍然成立
    await page.evaluate(() => localStorage.setItem('brewphase.desktop.theme', 'dark'))
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(900)
    await openSpace(page, '画布')
    await page.locator('.gallery-card', { hasText: '工作台' }).locator('.gallery-card__open').click()
    await page.getByRole('button', { name: '适配全部内容' }).click()
    await page.waitForTimeout(600)
    await shoot(page, '7-mixed-dark')
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
