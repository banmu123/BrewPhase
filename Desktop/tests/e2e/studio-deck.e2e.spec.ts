import { test, expect, _electron as electronLauncher } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinLocale } from './locale'
import { seedStudioDatabase } from './studio-seed'

/**
 * 三个空间的叠放（Phase 1.5）。
 *
 * 这一组守的是**满载**形态：每栏最多 5 个，而且叠放不能挤、不能溢。
 * 早先咖啡是「一排 5 包横铺整列」——每包被压掉 70%，只剩五条竖边，展开时
 * 还顶出列外；现在三个空间共用 `deck-model` 的同一套姿态。
 *
 * 两个让断言稳定的手法：
 * 1. 种子里只有 3 包豆 / 2 块画布，这里复制数据行补到 5，才测得到满载；
 * 2. **用 CSS 把静置姿态钉死**，不依赖 `:hover`——真实系统光标若停在某张卡上，
 *    `:hover` 会让整叠切到展开姿态，量出来的是另一组数字（曾因此得到
 *    「右侧溢出 47px」的假结论）。
 */

/** 把整叠钉在静置姿态：与鼠标/焦点状态无关，测量才是确定的。 */
const PIN_REST = `
  .coffee-shelf__card,
  .records-deck__card,
  .canvas-deck__card { transition: none !important; }
  .coffee-shelf:hover .coffee-shelf__card,
  .coffee-shelf:focus-within .coffee-shelf__card,
  .coffee-shelf .coffee-shelf__card:hover,
  .records-deck:hover .records-deck__card,
  .records-deck:focus-within .records-deck__card,
  .records-deck .records-deck__card:hover,
  .canvas-deck:hover .canvas-deck__card,
  .canvas-deck:focus-within .canvas-deck__card,
  .canvas-deck .canvas-deck__card:hover {
    transform: translate(var(--deck-x), var(--deck-y)) rotate(var(--deck-r)) !important;
  }
`

const LIMIT = 5

function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.BREWPHASE_FORCE_ONBOARDING
  return env
}

/** 把种子里的豆子与画布复制到 5 条：首页的满载上限就是 5。 */
function fillToLimit(appData: string): void {
  const db = new Database(join(appData, 'brewphase.db'))
  try {
    const copyRows = (table: string, ids: string[], label: string) => {
      const row = db.prepare(`select * from ${table} limit 1`).get() as Record<string, unknown> | undefined
      if (!row) return
      for (let index = 0; index < ids.length; index += 1) {
        const copy: Record<string, unknown> = { ...row, id: ids[index], name: `${label} ${index + 1}` }
        const keys = Object.keys(copy)
        db.prepare(`insert into ${table} (${keys.join(',')}) values (${keys.map((key) => `@${key}`).join(',')})`).run(copy)
      }
    }
    // 种子已有 3 包豆 / 2 块画布：分别补 2 块与 3 块，都到 5。
    copyRows('beans', ['ffffffff-1111-4111-8111-000000000004', 'ffffffff-1111-4111-8111-000000000005'], '补充豆')
    copyRows(
      'canvases',
      [
        'ffffffff-2222-4222-8222-000000000003',
        'ffffffff-2222-4222-8222-000000000004',
        'ffffffff-2222-4222-8222-000000000005'
      ],
      '补充画布'
    )
  } finally {
    db.close()
  }
}

async function launch(appData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(appData)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page }
}

type DeckMetrics = {
  count: number
  stageWidth: number
  cardWidth: number
  gapLeft: number
  gapRight: number
  distinctOffsets: number
}

const SPACES = [
  { space: 'coffee' as const, card: '.coffee-shelf__card' },
  { space: 'records' as const, card: '.records-deck__card' },
  { space: 'canvas' as const, card: '.canvas-deck__card' }
]

async function measure(page: Page): Promise<Record<string, DeckMetrics | null>> {
  return page.evaluate((spaces) => {
    const result: Record<string, DeckMetrics | null> = {}
    for (const { space, card } of spaces) {
      const stage = document.querySelector(`.studio-space--${space} .studio-space__stage`)
      if (!stage) {
        result[space] = null
        continue
      }
      const stageRect = stage.getBoundingClientRect()
      const rects = Array.from(stage.querySelectorAll(card)).map((element) => element.getBoundingClientRect())
      if (rects.length === 0) {
        result[space] = null
        continue
      }
      const offsets = new Set(rects.map((rect) => Math.round(rect.left - stageRect.left)))
      result[space] = {
        count: rects.length,
        stageWidth: Math.round(stageRect.width),
        cardWidth: Math.round(rects[0]!.width),
        gapLeft: Math.round(Math.min(...rects.map((rect) => rect.left)) - stageRect.left),
        gapRight: Math.round(stageRect.right - Math.max(...rects.map((rect) => rect.right))),
        distinctOffsets: offsets.size
      }
    }
    return result
  }, SPACES)
}

test('每栏最多 5 个，满载时仍居中且不溢出', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'brewphase-deck-'))
  seedStudioDatabase(appData)
  fillToLimit(appData)
  const { app, page } = await launch(appData)
  try {
    await page.addStyleTag({ content: PIN_REST })

    for (const width of [1440, 1280, 1100, 980]) {
      await app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(size, 900)
      }, width)
      await page.waitForTimeout(320)

      const metrics = await measure(page)
      for (const { space } of SPACES) {
        const item = metrics[space]
        expect(item, `${width}px 的 ${space} 没有卡片`).not.toBeNull()

        // 满载上限：有 5 条数据就只摆 5 张，不会溢出成一条条。
        expect(item!.count, `${width}px 的 ${space} 张数`).toBe(LIMIT)
        // 叠放而不是并排：至少三张卡的横向位置各不相同。
        expect(item!.distinctOffsets, `${width}px 的 ${space} 没有错开`).toBeGreaterThanOrEqual(3)
        // 居中：两侧留白相等（旋转会让包围盒多几像素，给 8px 容差）。
        expect(
          Math.abs(item!.gapLeft - item!.gapRight),
          `${width}px 的 ${space} 偏心 ${Math.abs(item!.gapLeft - item!.gapRight)}px（左 ${item!.gapLeft} / 右 ${item!.gapRight}）`
        ).toBeLessThanOrEqual(8)
        // 不溢出：两侧都真的留了白。
        expect(item!.gapLeft, `${width}px 的 ${space} 左侧贴边`).toBeGreaterThanOrEqual(8)
        expect(item!.gapRight, `${width}px 的 ${space} 右侧贴边`).toBeGreaterThanOrEqual(8)
      }
    }

    // 水平方向不许出现滚动条（溢出会把整页撑宽）。
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
    rmSync(appData, { recursive: true, force: true })
  }
})

test('三栏叠放共用一个姿态：同一索引的位移完全一致', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'brewphase-deck-shared-'))
  seedStudioDatabase(appData)
  fillToLimit(appData)
  const { app, page } = await launch(appData)
  try {
    await page.addStyleTag({ content: PIN_REST })
    await page.waitForTimeout(200)

    const poses = await page.evaluate(() => {
      const read = (space: string, card: string) => {
        const stage = document.querySelector(`.studio-space--${space} .studio-space__stage`)
        const first = stage?.querySelector(card)
        if (!first) return null
        const style = getComputedStyle(first)
        return {
          x: style.getPropertyValue('--deck-x').trim(),
          y: style.getPropertyValue('--deck-y').trim(),
          r: style.getPropertyValue('--deck-r').trim(),
          xs: style.getPropertyValue('--deck-x-spread').trim(),
          ys: style.getPropertyValue('--deck-y-spread').trim()
        }
      }
      return {
        coffee: read('coffee', '.coffee-shelf__card'),
        records: read('records', '.records-deck__card'),
        canvas: read('canvas', '.canvas-deck__card')
      }
    })

    // 三个空间的第一张卡都取 DECK_REST[0] / DECK_SPREAD[0]——同一套姿态。
    expect(poses.coffee).toEqual(poses.records)
    expect(poses.canvas).toEqual(poses.records)
    expect(poses.records?.x).toBe('0px')
  } finally {
    await app.close()
    rmSync(appData, { recursive: true, force: true })
  }
})

/**
 * 咖啡卡与记录卡**宽高完全一致**。
 *
 * 守的是一次返工：三列曾经不等宽（1fr / 1.08fr / 0.94fr），同一个 `62%` 算出
 * 三种卡宽（1440 下 231 / 249 / 217），并排就能看出大小不一；咖啡还一度是
 * 132:196 的竖幅袋型，比记录卡窄一半、高一倍。现在三列等宽 + 卡宽只有一个
 * 来源（`.studio-desk` 的 `--card-w`）+ 同一个 4:3 比例。
 */
test('咖啡卡与记录卡的宽高完全一致', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'brewphase-deck-size-'))
  seedStudioDatabase(appData)
  fillToLimit(appData)
  const { app, page } = await launch(appData)
  try {
    await page.addStyleTag({ content: PIN_REST })

    for (const width of [1440, 1280, 1100, 980]) {
      await app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(size, 900)
      }, width)
      await page.waitForTimeout(300)

      const sizes = await page.evaluate(() => {
        const read = (space: string, card: string) => {
          const element = document.querySelector(`.studio-space--${space} .studio-space__stage ${card}`)
          if (!element) return null
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            ratio: style.aspectRatio
          }
        }
        return {
          coffee: read('coffee', '.coffee-shelf__card'),
          records: read('records', '.records-deck__card')
        }
      })

      expect(sizes.coffee, `${width}px 缺咖啡卡`).not.toBeNull()
      expect(sizes.records, `${width}px 缺记录卡`).not.toBeNull()
      // 宽一致。
      expect(sizes.coffee!.width, `${width}px 咖啡与记录卡宽不同`).toBe(sizes.records!.width)
      // 高也一致（同一个 box-sizing 与比例，误差只可能来自亚像素取整）。
      expect(
        Math.abs(sizes.coffee!.height - sizes.records!.height),
        `${width}px 咖啡卡高 ${sizes.coffee!.height} vs 记录卡高 ${sizes.records!.height}`
      ).toBeLessThanOrEqual(2)
      // 同一个比例，不做「一栏竖幅一栏横幅」。
      expect(sizes.coffee!.ratio, `${width}px 咖啡卡比例`).toBe(sizes.records!.ratio)
    }

    await app.close()
  } finally {
    rmSync(appData, { recursive: true, force: true })
  }
})
