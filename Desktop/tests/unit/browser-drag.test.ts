import { describe, expect, it, vi } from 'vitest'
import { BrowserDragSessionManager, type DragPoint } from '../../src/main/browser/browser-drag'

/**
 * 主进程拖拽会话（Phase 3 的核心裁判）。
 *
 * 设计背景：真实桌面上渲染层在窗口外收不到可靠的 pointer 事件（Phase 2
 * 「拖不出去」的根因）。会话用可注入的光标读数模拟主进程轮询，验证：
 * - 会话单例（一次拖动绝不双开窗口）；
 * - 窗口外松手 → onReleaseOutside；窗口内松手 / 内部投放 → 取消；
 * - 松手位置优先级：轮询光标 > 渲染层兜底坐标；
 * - 会话被打断（标签关闭 / 强制取消）不拆窗。
 */

function makeSession(options?: {
  classify?: (point: DragPoint) => { windowId: number | null; mainWindow: boolean }
  cursor?: DragPoint
}) {
  const frames: Array<{ active: boolean; outside: boolean; kind: string; tabId: string | null }> = []
  const released: Array<{ kind: string; tabId: string | null; point: DragPoint }> = []
  let cursor: DragPoint = options?.cursor ?? { x: 100, y: 100 }
  const classify = options?.classify ?? ((point: DragPoint) => (point.x > 500 ? { windowId: null, mainWindow: false } : { windowId: 1, mainWindow: true }))
  const session = new BrowserDragSessionManager({
    cursor: () => cursor,
    classify,
    onFrame: (frame) => frames.push(frame),
    onReleaseOutside: (kind, tabId, point) => released.push({ kind, tabId, point }),
    pollIntervalMs: 8
  })
  return {
    session,
    frames,
    released,
    setCursor: (point: DragPoint) => {
      cursor = point
    }
  }
}

/** 推进一次轮询（真实实现里是 setInterval；测试里手动触发 poll 行为）。 */
function pump(session: BrowserDragSessionManager): void {
  // poll 是私有方法；通过 advanceTimers 推进。这里用 vi 的假时钟。
  vi.advanceTimersByTime(10)
  void session
}

describe('拖拽会话：终态裁定', () => {
  it('渲染层兜底坐标不可信：有轮询读数时以轮询光标为准（窗口内 → 取消）', () => {
    const { session, released } = makeSession()
    session.begin('webcard', 'tab-1') // 轮询光标 (100,100)：窗口内
    session.end({ x: 900, y: 300 }) // 渲染层报的「窗口外」坐标——必须被忽略
    expect(released).toHaveLength(0)
    expect(session.active()).toBeNull()
  })

  it('光标移出窗口后松手 → 按轮询光标判定为拆出', () => {
    const { session, released, setCursor } = makeSession()
    session.begin('webcard', 'tab-1')
    setCursor({ x: 900, y: 300 }) // 拖出窗口之外
    session.end()
    expect(released).toHaveLength(1)
    expect(released[0]).toEqual({ kind: 'webcard', tabId: 'tab-1', point: { x: 900, y: 300 } })
  })

  it('窗口内松手（没有内部投放）→ 取消，不拆窗', () => {
    const { session, released } = makeSession()
    session.begin('webcard', 'tab-1')
    session.end()
    expect(released).toHaveLength(0)
    expect(session.active()).toBeNull()
  })

  it('内部投放（dropHandled）→ 无论光标在哪都不拆窗', () => {
    const { session, released, setCursor } = makeSession()
    session.begin('webcard', 'tab-1')
    setCursor({ x: 900, y: 300 })
    session.markDropHandled()
    session.end()
    expect(released).toHaveLength(0)
  })

  it('会话单例：已有会话时 begin 被拒绝（一次拖动绝不双开）', () => {
    const { session } = makeSession()
    expect(session.begin('webcard', 'tab-1')).toBe(true)
    expect(session.begin('webcard', 'tab-2')).toBe(false)
    expect(session.active()?.tabId).toBe('tab-1')
    session.cancel()
  })

  it('第一轮拒绝后，旧会话结束可以再开新会话', () => {
    const { session } = makeSession()
    session.begin('webcard', 'tab-1')
    session.cancel()
    expect(session.begin('webcard', 'tab-2')).toBe(true)
    session.cancel()
  })

  it('cancel：强制收尾（标签被关闭 / 应用退出），不拆窗', () => {
    const { session, released, setCursor } = makeSession()
    session.begin('webcard', 'tab-1')
    setCursor({ x: 900, y: 300 })
    session.cancel()
    expect(released).toHaveLength(0)
    expect(session.active()).toBeNull()
  })

  it('无轮询读数且无兜底坐标 → 不拆窗（宁可不响应）', () => {
    const released: DragPoint[] = []
    const session = new BrowserDragSessionManager({
      cursor: () => ({ x: Number.NaN, y: Number.NaN }),
      classify: () => ({ windowId: null, mainWindow: false }),
      onFrame: () => undefined,
      onReleaseOutside: (_kind, _tabId, point) => released.push(point)
    })
    session.begin('webcard', 'tab-1')
    session.end()
    expect(released).toHaveLength(0)
  })

  it('兜底坐标只在无有效轮询读数时使用（E2E 注入假光标的路径）', () => {
    const released: DragPoint[] = []
    const session = new BrowserDragSessionManager({
      cursor: () => ({ x: Number.NaN, y: Number.NaN }),
      classify: () => ({ windowId: null, mainWindow: false }),
      onFrame: () => undefined,
      onReleaseOutside: (_kind, _tabId, point) => released.push(point)
    })
    session.begin('webcard', 'tab-1')
    session.end({ x: -300, y: 80 }) // 第二显示器（负坐标）上的松手点
    expect(released).toEqual([{ x: -300, y: 80 }])
  })

  it('overrideCursor：测试钩子取代真实光标读数', () => {
    const { session, released } = makeSession()
    // 注入点 (700, 200) 在分类器里是「所有窗口之外」。
    session.overrideCursor({ x: 700, y: 200 })
    session.begin('webcard', 'tab-1')
    session.end()
    expect(released).toEqual([{ kind: 'webcard', tabId: 'tab-1', point: { x: 700, y: 200 } }])
  })
})

describe('拖拽会话：帧广播', () => {
  it('会话开始 / 结束各推一帧；outside 变化时推帧', () => {
    vi.useFakeTimers()
    const { session, frames, setCursor } = makeSession({ cursor: { x: 100, y: 100 } })
    session.begin('webcard', 'tab-1')
    expect(frames[0]).toEqual({ active: true, kind: 'webcard', tabId: 'tab-1', outside: false })

    setCursor({ x: 900, y: 300 })
    pump(session)
    expect(frames.at(-1)).toEqual({ active: true, kind: 'webcard', tabId: 'tab-1', outside: true })

    session.end()
    expect(frames.at(-1)?.active).toBe(false)
    vi.useRealTimers()
  })

  it('轮询读数无效时保持上一帧，不把 NaN 判成窗口外', () => {
    vi.useFakeTimers()
    const frames: Array<{ outside: boolean }> = []
    let read: DragPoint = { x: 100, y: 100 }
    const session = new BrowserDragSessionManager({
      cursor: () => read,
      classify: (point) => (point.x > 500 ? { windowId: null, mainWindow: false } : { windowId: 1, mainWindow: true }),
      onFrame: (frame) => frames.push(frame),
      onReleaseOutside: () => undefined,
      pollIntervalMs: 8
    })
    session.begin('webcard', 'tab-1')
    read = { x: Number.NaN, y: Number.NaN }
    vi.advanceTimersByTime(40)
    expect(frames.every((frame) => frame.outside === false)).toBe(true)
    session.cancel()
    vi.useRealTimers()
  })
})
