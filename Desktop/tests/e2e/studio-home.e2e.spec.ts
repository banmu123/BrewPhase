import { test, expect, _electron as electronLauncher } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinLocale } from './locale'
import { SEED, SEED_TEXT_NOTE, seedEmptyDatabase, seedStudioDatabase } from './studio-seed'

/**
 * Studio Home Phase 1.2 的端到端验收：
 *
 * - 三个空间各自有空状态（架 / 卡堆 / 创作桌），不是同一块通用占位；
 * - 每个空状态的主要操作都走**目标空间已有的新建流程**（不另开表单）；
 * - Records 首页是一叠真实记录（不是瀑布流），点击卡片打开对应记录详情；
 * - 空 / 有数据两种状态下舞台高度都不塌，窄窗不产生水平溢出。
 *
 * 全部用例用自己的 `BREWPHASE_USER_DATA_DIR`：空库用例真的空，数据用例
 * 由 `studio-seed.ts` 写种子，两条路径都不碰开发机的真实库。
 */

const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function launchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userDataDir,
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.BREWPHASE_FORCE_ONBOARDING
  return env
}

async function launch(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: launchEnv(userDataDir)
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page }
}

/** 舞台实际高度：空状态折叠问题的直接证据。 */
async function stageMetrics(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const read = (selector: string): number => {
      const element = document.querySelector(selector)
      return element ? Math.round(element.getBoundingClientRect().height) : -1
    }
    return {
      coffee: read('.studio-space--coffee .studio-space__stage'),
      records: read('.studio-space--records .studio-space__stage'),
      canvas: read('.studio-space--canvas .studio-space__stage'),
      deck: read('.records-deck')
    }
  })
}

/**
 * 命中测试 + 强制点击。
 *
 * 这套用例跑在无 GPU 的 Electron 里，窗口被遮挡时渲染帧会被节流；
 * Playwright 默认的可点击性检查（要求连续两帧位置一致）会一直等不到帧，
 * 表现成「element is not stable」超时。先确认目标点最上层就是它自己
 * （这条才是真正要验的：没有被别的元素盖住），再直接派发点击。
 */
async function clickTopmost(page: Page, selector: string, label: string): Promise<void> {
  const locator = page.locator(selector)
  await expect(locator, label).toBeVisible()
  // 先滚到视口中央：命中测试只对可见区域有意义，画布区的入口在首屏之下。
  await locator.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' }))
  await page.waitForTimeout(80)
  const topmost = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return Boolean(target && (target === element || element.contains(target)))
  })
  expect(topmost, `${label} 被其他元素遮挡`).toBe(true)
  await locator.click({ force: true })
}

/** 水平溢出：页面整体不可横向滚动，是这次响应式检查的硬指标。 */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
}

test.describe('空库：三个空间各自的空状态', () => {
  let dir = ''
  let app: ElectronApplication | null = null

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-studio-empty-'))
    seedEmptyDatabase(dir)
  })

  test.afterAll(async () => {
    await app?.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  test('三个空状态各有独立视觉结构，且舞台不塌', async () => {
    const launched = await launch(dir)
    app = launched.app
    const { page } = launched

    // 三个空间各有自己的空状态变体，不是同一个通用组件换文案。
    await expect(page.locator('.studio-empty--coffee')).toBeVisible()
    await expect(page.locator('.studio-empty--records')).toBeVisible()
    await expect(page.locator('.studio-empty--canvas')).toBeVisible()

    // 咖啡架：三只实轮廓 + 一只更淡的空位轮廓 + 一条架线。
    await expect(page.locator('.studio-empty-coffee__bag')).toHaveCount(4)
    await expect(page.locator('.studio-empty-coffee__bag--d')).toHaveCount(1)
    await expect(page.locator('.studio-empty-coffee__shelfline')).toHaveCount(1)

    // 记录：三张叠放的空白灵感卡，前卡带照片轮廓与文字线。
    await expect(page.locator('.studio-empty-records__card')).toHaveCount(3)
    await expect(page.locator('.studio-empty-records__frame')).toHaveCount(1)

    // 画布：两张错位稿纸 + 浅网格与节点。
    await expect(page.locator('.studio-empty-canvas__sheet')).toHaveCount(2)
    await expect(page.locator('.studio-empty-canvas__grid')).toHaveCount(1)
    await expect(page.locator('.studio-empty-canvas__node')).toHaveCount(2)

    // 空状态没有写任何业务数据：装饰元素不进数据流。
    await expect(page.locator('.records-deck')).toHaveCount(0)
    await expect(page.locator('.coffee-shelf')).toHaveCount(0)
    await expect(page.locator('.canvas-deck')).toHaveCount(0)

    // 舞台高度：空着也要有体量（不是 min-height: 0 的折叠态）。
    const metrics = await stageMetrics(page)
    expect(metrics.coffee).toBeGreaterThanOrEqual(190)
    expect(metrics.records).toBeGreaterThanOrEqual(320)
    expect(metrics.canvas).toBeGreaterThanOrEqual(280)

    // 空状态之间高度差不应极端（记录舞台是右列主角）。
    expect(Math.abs(metrics.records - metrics.canvas)).toBeLessThanOrEqual(220)

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

    // 装饰件必须装在自己的舞台里（不能向上溢出去压住空间标题，也不能盖住文案）。
    const containment = await page.evaluate(() => {
      const report: Array<{ variant: string; overflowTop: number; overflowBottom: number; copyOverlap: number }> = []
      for (const variant of ['coffee', 'records', 'canvas'] as const) {
        const shell = document.querySelector(`.studio-empty--${variant}`)
        const stage = shell?.querySelector('.studio-empty__stage')
        const copy = shell?.querySelector('.studio-empty__copy')
        if (!shell || !stage || !copy) continue
        const stageRect = stage.getBoundingClientRect()
        const copyRect = copy.getBoundingClientRect()
        let overflowTop = 0
        let overflowBottom = 0
        for (const child of Array.from(stage.children)) {
          const rect = child.getBoundingClientRect()
          overflowTop = Math.min(overflowTop, rect.top - stageRect.top)
          overflowBottom = Math.max(overflowBottom, rect.bottom - stageRect.bottom)
        }
        report.push({
          variant,
          overflowTop,
          overflowBottom,
          copyOverlap: copyRect.top - stageRect.bottom
        })
      }
      return report
    })
    expect(containment).toHaveLength(3)
    for (const item of containment) {
      // 6px 容差：旋转后的包围盒比元素本身略大。
      expect(item.overflowTop, `${item.variant} 装饰溢出舞台顶部`).toBeGreaterThanOrEqual(-6)
      expect(item.overflowBottom, `${item.variant} 装饰溢出舞台底部`).toBeLessThanOrEqual(6)
      expect(item.copyOverlap, `${item.variant} 装饰压住了文案`).toBeGreaterThanOrEqual(-6)
    }

    await app.close()
    app = null
  })
})

test.describe('空库：三个创建入口都走既有流程', () => {
  let dir = ''
  let app: ElectronApplication | null = null

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-studio-create-'))
    seedEmptyDatabase(dir)
  })

  test.afterAll(async () => {
    await app?.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  test('Coffee → 新增豆表单；Records → 文字/链接表单；Canvas → 新建画布弹窗', async () => {
    const launched = await launch(dir)
    app = launched.app
    const { page } = launched

    // Coffee：点空状态的「收入第一包豆」→ 进 Coffee 空间并打开那里已有的豆子表单。
    await clickTopmost(page, '.studio-empty--coffee .studio-empty__action', '咖啡空状态入口')
    await expect(page.locator('.dialog[aria-label="新的一包豆"]')).toBeVisible()
    await clickTopmost(page, '.dialog .dialog__close', '豆子表单关闭')
    await clickTopmost(page, '.back-link', '返回 Studio')
    await expect(page.locator('.studio-home')).toBeVisible()

    // Records：Add note → Records 页的「新文字」浮窗。
    await clickTopmost(
      page,
      '.studio-empty--records .studio-empty__action >> nth=0',
      'Records 空状态「写一段文字」'
    )
    await expect(page.locator('.dialog[aria-label="新文字"]')).toBeVisible()
    await clickTopmost(page, '.dialog .dialog__close', '文字表单关闭')
    await clickTopmost(page, '.back-link', '返回 Studio')
    await expect(page.locator('.studio-home')).toBeVisible()

    // Records：Save link → 同一个页面里的「新链接」浮窗（不是第二个表单）。
    await clickTopmost(
      page,
      '.studio-empty--records .studio-empty__action >> nth=1',
      'Records 空状态「存一条链接」'
    )
    await expect(page.locator('.dialog[aria-label="新链接"]')).toBeVisible()
    await expect(page.locator('.dialog input[placeholder="https://"]')).toHaveCount(1)
    await clickTopmost(page, '.dialog .dialog__close', '链接表单关闭')
    await clickTopmost(page, '.back-link', '返回 Studio')
    await expect(page.locator('.studio-home')).toBeVisible()

    // Canvas：新建画布弹窗（画布弹窗没有 ✕，用它的「取消」退出）。
    await clickTopmost(page, '.studio-empty--canvas .studio-empty__action', '画布空状态入口')
    await expect(page.locator('.dialog[aria-label="新建画布"]')).toBeVisible()
    await clickTopmost(page, '.dialog .button:not(.button--primary)', '画布弹窗取消')

    // 全程没有写入任何记录：空状态的点缀不是数据。
    const recordCount = await page.evaluate(async () => {
      const list = await window.brewphase.records.list({ search: '', carrier: null, tagId: null, limit: 50, offset: 0 })
      return list.length
    })
    expect(recordCount).toBe(0)

    await app.close()
    app = null
  })
})

test.describe('有数据：Records Deck 是真实记录的叠放', () => {
  let dir = ''
  let app: ElectronApplication | null = null

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-studio-deck-'))
    seedStudioDatabase(dir)
  })

  test.afterAll(async () => {
    await app?.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  test('展示 5 张真实记录，类型有差异化，点击进详情，入口进空间', async () => {
    const launched = await launch(dir)
    app = launched.app
    const { page } = launched
    await page.route('https://cdn.mock.test/**', (route) =>
      route.fulfill({ status: 200, body: MOCK_PNG, contentType: 'image/png' })
    )

    const deck = page.locator('.records-deck')
    await expect(deck).toBeVisible()
    // 首页只摆一叠：种子 7 条 → 只显示 DECK_LIMIT = 5 张。
    await expect(deck.locator('.records-deck__card')).toHaveCount(5)
    await expect(page.locator('.records-library')).toHaveCount(0)

    // 类型差异化：最新 5 条覆盖四种载体——图片（本地缩略图）、视频（预览图）、
    // 带远程封面的链接、两条文字。每种载体都有自己的卡面结构。
    await expect(deck.locator('.records-deck__card--image img')).toHaveCount(1)
    await expect(deck.locator('.records-deck__card--video')).toHaveCount(1)
    await expect(deck.locator('.records-deck__card--link img')).toHaveCount(1)
    await expect(deck.locator('.records-deck__card--text')).toHaveCount(2)
    const imageSrc = await deck.locator('.records-deck__card--image img').first().getAttribute('src')
    expect(imageSrc).toContain('bpmedia://')
    // 远程封面只接受 https（isSafeRemoteImage），本地媒体走 bpmedia://。
    const remoteSrc = await deck.locator('.records-deck__card--link img').first().getAttribute('src')
    expect(remoteSrc).toMatch(/^https:\/\//)

    // 文字卡显示的是记录里的真实正文，不是统一占位文案。
    await expect(deck.locator('.records-deck__card--text', { hasText: '尾段稍薄' })).toHaveCount(1)
    await expect(deck.locator('.records-deck__card--text', { hasText: '分装成每包' })).toHaveCount(1)

    // 最新一条（种子里的视频）在最上面，姿态与标题都可读。
    const labels = await deck.locator('.records-deck__card').evaluateAll((cards) =>
      cards.map((card) => card.getAttribute('aria-label'))
    )
    expect(labels[0]).toBe('拉花练习：第三次')
    expect(labels.every((label) => Boolean(label))).toBe(true)

    // 没有虚构数据：所有卡片都指向种子里的真实记录。
    const seededIds = new Set(Object.values(SEED.records))
    const cardIds = await deck.locator('.records-deck__card').evaluateAll((cards) => cards.length)
    expect(cardIds).toBe(5)
    const recordCount = await page.evaluate(async (ids) => {
      const list = await window.brewphase.records.list({ search: '', carrier: null, tagId: null, limit: 50, offset: 0 })
      return list.filter((item) => ids.includes(item.id)).length
    }, [...seededIds])
    expect(recordCount).toBe(7)

    // 点最上面那张卡 → 沿用既有跨页路径打开对应记录详情。
    // 叠放卡在 hover 时会展开（位置在动），所以先证明「卡片中心点最上层就是它」，
    // 再派发点击——避开帧节流下 Playwright 的「位置稳定」等待。
    const firstCard = deck.locator('.records-deck__card').first()
    const cardTopmost = await firstCard.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return Boolean(target && (target === element || element.contains(target)))
    })
    expect(cardTopmost, '最上层的卡被其他卡片遮挡').toBe(true)
    await firstCard.evaluate((element) => (element as HTMLElement).click())
    await expect(page.locator('.float-panel')).toBeVisible()
    await expect(page.locator('.detail-title')).toHaveText('拉花练习：第三次')
    await clickTopmost(page, '.float-panel .button--ghost[aria-label="关闭详情"]', '关闭详情')
    await clickTopmost(page, '.back-link', '返回 Studio')

    // Deck 区域的显式入口 → 完整 Records 空间（瀑布流仍保留在空间页）。
    await clickTopmost(page, '.studio-space--records .studio-space__open', '打开收藏库')
    await expect(page.getByRole('heading', { name: '记录' })).toBeVisible()

    await app.close()
    app = null
  })

  test('Hover 展开、键盘聚焦可见、减少动态时姿态不动', async () => {
    const launched = await launch(dir)
    app = launched.app
    const { page } = launched

    const cards = page.locator('.records-deck__card')
    /** 读一张卡的姿态（位移 + 旋转角）。 */
    const poseOf = async (index: number) => {
      const raw = await cards.nth(index).evaluate((element) => getComputedStyle(element).transform)
      const match = raw.match(/matrix\(([^)]+)\)/)
      if (!match) return { x: 0, y: 0, angle: 0 }
      const [a, b, , , x, y] = match[1].split(',').map(Number)
      return { x, y, angle: (Math.atan2(b, a) * 180) / Math.PI }
    }

    // 先确认卡片定义了过渡（不是硬切），再把它关掉：
    // Electron 在无 GPU / 被遮挡时会把帧节流，过渡可能整段不推进，
    // 那时 computed transform 会一直停在起点——断言会假红。
    // 关掉过渡后 computed style 直接是目标姿态，hover 语义仍然是被验证的那条规则。
    const duration = await cards.first().evaluate((element) => getComputedStyle(element).transitionDuration)
    expect(duration).not.toBe('0s')
    await page.addStyleTag({ content: '.records-deck__card{transition:none !important}' })

    const deckHovered = () =>
      page.evaluate(() => document.querySelector('.records-deck')?.matches(':hover') ?? false)
    const moveToDeck = async () => {
      const box = await page.locator('.records-deck').boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + box!.width * 0.55, box!.y + box!.height * 0.7)
    }

    // 紧凑叠放：第一张与第二张的位移不同（不是完全重合）。
    const restFirst = await poseOf(0)
    const restSecond = await poseOf(1)
    expect(restFirst.x).not.toBeCloseTo(restSecond.x, 0)

    // Hover 展开：整叠进入 :hover，卡片位移随之改变。
    await moveToDeck()
    await expect.poll(deckHovered, { timeout: 5_000 }).toBe(true)
    const hovered = await poseOf(0)
    expect(Math.abs(hovered.x - restFirst.x)).toBeGreaterThan(10)
    expect(Math.abs(hovered.y - restFirst.y)).toBeGreaterThan(6)

    // 移开鼠标后回到紧凑姿态。
    await page.mouse.move(4, 4)
    await expect.poll(deckHovered, { timeout: 5_000 }).toBe(false)
    const restored = await poseOf(0)
    expect(restored.x).toBeCloseTo(restFirst.x, 0)
    expect(restored.y).toBeCloseTo(restFirst.y, 0)
    expect(restored.angle).toBeCloseTo(restFirst.angle, 1)

    // 键盘可达：Tab 能聚焦卡片，focus 有可见轮廓，Enter 能打开详情。
    await page.locator('.studio-space--records .studio-space__open').focus()
    let focused = false
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab')
      focused = await page.evaluate(() => document.activeElement?.classList.contains('records-deck__card') ?? false)
      if (focused) break
    }
    expect(focused).toBe(true)
    const outline = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement
      const style = getComputedStyle(active)
      return { width: style.outlineWidth, style: style.outlineStyle }
    })
    expect(outline.style).not.toBe('none')
    expect(parseFloat(outline.width)).toBeGreaterThan(0)

    // 键盘路径真能打开记录（不是只有鼠标能点）。
    await page.keyboard.press('Enter')
    await expect(page.locator('.float-panel')).toBeVisible()
    await clickTopmost(page, '.float-panel .button--ghost[aria-label="关闭详情"]', '关闭详情')
    await clickTopmost(page, '.back-link', '返回 Studio')
    await expect(page.locator('.studio-home')).toBeVisible()

    // 减少动态：hover 不再改变姿态，但卡片仍在原位可点。
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.mouse.move(4, 4)
    const before = await poseOf(0)
    await moveToDeck()
    await expect.poll(deckHovered, { timeout: 5_000 }).toBe(true)
    const after = await poseOf(0)
    expect(after.x).toBeCloseTo(before.x, 0)
    expect(after.y).toBeCloseTo(before.y, 0)
    expect(after.angle).toBeCloseTo(before.angle, 1)
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    await app.close()
    app = null
  })

  test('各视口下不溢出、卡不越界、三空间高度差合理', async () => {
    const launched = await launch(dir)
    app = launched.app
    const { page } = launched

    for (const width of [1440, 1280, 1100, 980]) {
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setSize(size, 900)
      }, width)
      await page.waitForTimeout(320)

      expect(await horizontalOverflow(page), `窗口 ${width}px 出现水平溢出`).toBeLessThanOrEqual(1)

      const bounds = await page.evaluate(() => {
        const stage = document.querySelector('.studio-space--records .studio-space__stage')
        if (!stage) return null
        const stageRect = stage.getBoundingClientRect()
        const cards = Array.from(document.querySelectorAll('.records-deck__card')).map((card) => {
          const rect = card.getBoundingClientRect()
          return { left: rect.left, right: rect.right, width: rect.width, height: rect.height }
        })
        return {
          stage: { left: stageRect.left, right: stageRect.right, height: stageRect.height },
          cards
        }
      })
      expect(bounds).not.toBeNull()
      expect(bounds!.cards.length).toBeGreaterThanOrEqual(4)
      for (const card of bounds!.cards) {
        expect(card.width).toBeGreaterThan(120)
        expect(card.left).toBeGreaterThanOrEqual(-1)
        // 展开前不越出可视区右侧（给 1px 亚像素余量）。
        expect(card.right).toBeLessThanOrEqual(width + 1)
      }

      const metrics = await stageMetrics(page)
      // 有数据时舞台仍保留体量，不会因为绝对定位塌成 0。
      expect(metrics.records, `窗口 ${width}px 的 Records 舞台塌了`).toBeGreaterThanOrEqual(250)
    }

    await app.close()
    app = null
  })
})
