/**
 * AI 圆桌的共享模型（Phase 3：主进程为唯一事实来源）。
 *
 * Phase 2 之前圆桌状态住在渲染层 Zustand 里；Phase 3 起主窗口与圆桌独立
 * 窗口是**两个 Renderer**，不能再各持一份。主进程的 RoundtableService
 * 持有唯一的 `RoundtableSnapshot`，两个窗口都通过 IPC 订阅这份快照。
 *
 * 参与者仍然是真实网页的 `tabId`（Phase 2 的铁律不变）：
 * 主进程在 join 时校验标签存在，网页关闭时自动摘除失效参与者。
 *
 * 并发保护：`version` 单调递增。草稿写入必须带 `baseVersion`，主进程
 * 发现版本过期就拒绝——任何一个 Renderer 都不能静默覆盖另一个窗口的
 * 新状态（规格 §4.4）。
 */

export type RoundtableSnapshot = {
  id: string
  /** 参与的真实标签 ID，按加入/排序后的顺序。 */
  participantTabIds: string[]
  /** 统一提问草稿：停靠 ↔ 独立窗口切换也不丢。 */
  draft: string
  /** 圆桌是否正在独立 BrowserWindow 里运行。 */
  detached: boolean
  /**
   * 主窗口的**工作空间 overlay** 是否打开（Phase 4.2）。detached 时独立
   * 窗口本身就是工作空间，这个字段只对停靠形态有意义。
   */
  workspaceOpen: boolean
  /** 最后一次变更时间（epoch ms）。 */
  updatedAt: number
  /** 单调递增版本号：每次真实变更 +1。 */
  version: number
}

/** 只有一张圆桌；id 稳定，独立窗口路由用它寻址。 */
export const ROUNDTABLE_ID = 'roundtable-main'

/**
 * 圆桌快照广播通道。与 `browser:changed` 同一模式：preload 是 sandboxed 的，
 * 不能 import 主进程模块，通道名只能放共享层。
 */
export const ROUNDTABLE_CHANGED_CHANNEL = 'roundtable:changed'

export function initialRoundtableSnapshot(): RoundtableSnapshot {
  return {
    id: ROUNDTABLE_ID,
    participantTabIds: [],
    draft: '',
    detached: false,
    workspaceOpen: false,
    updatedAt: 0,
    version: 0
  }
}

/** 草稿的长度上限：与 IPC 校验、输入框 maxLength 三处一致。 */
export const ROUNDTABLE_DRAFT_MAX = 2_000

/* ============================================================
 * 纯操作函数：输入快照，输出新快照（无变化时返回同一引用）。
 * 主进程的 RoundtableService 负责校验 + 版本号 + 广播。
 * ============================================================ */

/** 拖入圆桌：幂等建立参与关系（同一张卡只能出现一次）。 */
export function addParticipant(snapshot: RoundtableSnapshot, tabId: string): RoundtableSnapshot | null {
  if (!tabId || snapshot.participantTabIds.includes(tabId)) return null
  return {
    ...snapshot,
    participantTabIds: [...snapshot.participantTabIds, tabId]
  }
}

/** 从圆桌移除参与者：只解除关系，网页不关闭。 */
export function removeParticipant(snapshot: RoundtableSnapshot, tabId: string): RoundtableSnapshot | null {
  if (!snapshot.participantTabIds.includes(tabId)) return null
  return {
    ...snapshot,
    participantTabIds: snapshot.participantTabIds.filter((id) => id !== tabId)
  }
}

/** 只保留仍然存在的标签（关闭网页后清理参与者）。 */
export function retainParticipants(snapshot: RoundtableSnapshot, liveTabIds: readonly string[]): RoundtableSnapshot | null {
  const alive = new Set(liveTabIds)
  const next = snapshot.participantTabIds.filter((id) => alive.has(id))
  if (next.length === snapshot.participantTabIds.length) return null
  return { ...snapshot, participantTabIds: next }
}

/** 参与者在圆桌内排序（语义与卡片架一致：插到目标前面）。 */
export function reorderParticipants(snapshot: RoundtableSnapshot, tabId: string, overId: string): RoundtableSnapshot | null {
  const ids = snapshot.participantTabIds
  if (tabId === overId) return null
  const from = ids.indexOf(tabId)
  const to = ids.indexOf(overId)
  if (from < 0 || to < 0) return null
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  next.splice(from < to ? to - 1 : to, 0, moved)
  if (next.every((id, at) => id === ids[at])) return null
  return { ...snapshot, participantTabIds: next }
}

/** 草稿更新（主进程校验 baseVersion 后调用）。 */
export function writeDraft(snapshot: RoundtableSnapshot, draft: string): RoundtableSnapshot | null {
  const value = draft.slice(0, ROUNDTABLE_DRAFT_MAX)
  if (value === snapshot.draft) return null
  return { ...snapshot, draft: value }
}

/** 拆出 / 归位：只翻转 detached；参与者与草稿原样保留。 */
export function setDetached(snapshot: RoundtableSnapshot, detached: boolean): RoundtableSnapshot | null {
  if (snapshot.detached === detached) return null
  return { ...snapshot, detached }
}

/** 工作空间 overlay 开关（只对停靠形态有意义；归位时主进程会顺手关掉）。 */
export function setWorkspaceOpen(snapshot: RoundtableSnapshot, open: boolean): RoundtableSnapshot | null {
  if (snapshot.workspaceOpen === open) return null
  return { ...snapshot, workspaceOpen: open }
}

/* ============================================================
 * 独立窗口的默认几何：真正的尺寸决定在主进程窗口管理器里，
 * 这里只保留共享的最小值，供窗口构造与 E2E 断言使用。
 * ============================================================ */

export const ROUNDTABLE_WINDOW_MIN_WIDTH = 460
export const ROUNDTABLE_WINDOW_MIN_HEIGHT = 340

/* ============================================================
 * 自由布局（Phase 4.2 workspace）：纯模型与几何函数。
 * 坐标一律是**工作区局部坐标**；持久化与恢复都按工作区尺寸 clamp。
 * ============================================================ */

export type RoundtablePanelLayout = {
  tabId: string
  /** 面板对应的网页地址；重启后幽灵面板按它一键重开（rebind 保留几何）。 */
  url: string
  x: number
  y: number
  width: number
  height: number
  /** 数值越大越在上层；同 z 时按加入顺序稳定排序。 */
  z: number
}

export type RoundtableLayoutSnapshot = {
  roundtableId: string
  panels: RoundtablePanelLayout[]
  activeTabId: string | null
  snapEnabled: boolean
  /** 上次已知的工作区尺寸（恢复时用来适配布局）。 */
  workspace: { width: number; height: number }
  updatedAt: number
  version: number
}

/** 布局广播通道（与 roundtable:changed 同模式；两个窗口都订阅）。 */
export const ROUNDTABLE_LAYOUT_CHANGED_CHANNEL = 'roundtable-layout:changed'

/** 面板最小尺寸：小于它网页就无法正常交互。 */
export const ROUNDTABLE_PANEL_MIN_WIDTH = 320
export const ROUNDTABLE_PANEL_MIN_HEIGHT = 200

/** 新面板的默认尺寸。 */
export const ROUNDTABLE_PANEL_DEFAULT_WIDTH = 560
export const ROUNDTABLE_PANEL_DEFAULT_HEIGHT = 420

/** 工作区自身的最小尺寸（低于它不布局，UI 显示提示）。 */
export const ROUNDTABLE_WORKSPACE_MIN_WIDTH = 480
export const ROUNDTABLE_WORKSPACE_MIN_HEIGHT = 320

/** 面板保持可达：位置 clamp 时至少保留这么多可见宽度/高度。 */
export const ROUNDTABLE_PANEL_KEEP_VISIBLE_WIDTH = 180
export const ROUNDTABLE_PANEL_KEEP_VISIBLE_HEIGHT = 120

/** 吸附阈值（px）。 */
export const ROUNDTABLE_SNAP_THRESHOLD = 8

export type WorkspaceSize = { width: number; height: number }

/** 新成员的默认布局：级联错位，超出工作区时 clamp。 */
export function defaultPanelLayout(
  tabId: string,
  index: number,
  workspace: WorkspaceSize,
  url = ''
): RoundtablePanelLayout {
  const width = Math.min(ROUNDTABLE_PANEL_DEFAULT_WIDTH, Math.max(ROUNDTABLE_PANEL_MIN_WIDTH, workspace.width - 32))
  const height = Math.min(ROUNDTABLE_PANEL_DEFAULT_HEIGHT, Math.max(ROUNDTABLE_PANEL_MIN_HEIGHT, workspace.height - 32))
  const stagger = index % 6
  const x = Math.min(24 + stagger * 36, Math.max(0, workspace.width - width))
  const y = Math.min(16 + stagger * 32, Math.max(0, workspace.height - height))
  return { tabId, url, x, y, width, height, z: index + 1 }
}

/**
 * 把面板 clamp 进工作区：宽高不超过工作区（也不小于最小尺寸），
 * 位置保证至少 KEEP_VISIBLE 的宽度/高度留在工作区内——面板可以部分
 * 超出边界，但用户永远有办法把它拖回来。
 */
export function clampPanelIntoWorkspace(
  panel: RoundtablePanelLayout,
  workspace: WorkspaceSize
): RoundtablePanelLayout {
  const width = Math.min(Math.max(panel.width, ROUNDTABLE_PANEL_MIN_WIDTH), Math.max(ROUNDTABLE_PANEL_MIN_WIDTH, workspace.width))
  const height = Math.min(Math.max(panel.height, ROUNDTABLE_PANEL_MIN_HEIGHT), Math.max(ROUNDTABLE_PANEL_MIN_HEIGHT, workspace.height))
  const maxX = Math.max(0, workspace.width - ROUNDTABLE_PANEL_KEEP_VISIBLE_WIDTH)
  const maxY = Math.max(0, workspace.height - ROUNDTABLE_PANEL_KEEP_VISIBLE_HEIGHT)
  const x = Math.min(Math.max(panel.x, -width + ROUNDTABLE_PANEL_KEEP_VISIBLE_WIDTH), maxX)
  const y = Math.min(Math.max(panel.y, -height + ROUNDTABLE_PANEL_KEEP_VISIBLE_HEIGHT), maxY)
  return { ...panel, x, y, width, height }
}

export type SnapEdges = {
  left: number[]
  right: number[]
  top: number[]
  bottom: number[]
}

/** 收集吸附目标：工作区边界 + 其他面板的边缘。 */
export function collectSnapEdges(panels: RoundtablePanelLayout[], self: string, workspace: WorkspaceSize): SnapEdges {
  const edges: SnapEdges = { left: [0], right: [workspace.width], top: [0], bottom: [workspace.height] }
  for (const panel of panels) {
    if (panel.tabId === self) continue
    edges.left.push(panel.x)
    edges.right.push(panel.x + panel.width)
    edges.top.push(panel.y)
    edges.bottom.push(panel.y + panel.height)
  }
  return edges
}

const SNAP = ROUNDTABLE_SNAP_THRESHOLD

function snapValue(value: number, targets: number[]): number | null {
  let best: number | null = null
  let bestDistance = SNAP
  for (const target of targets) {
    const distance = Math.abs(value - target)
    if (distance <= bestDistance) {
      best = target
      bestDistance = distance
    }
  }
  return best
}

/**
 * 拖动时的吸附（仅位置；辅助而非限制）。返回 null 表示无需吸附。
 * 左边吸 left 边或「右边-宽」，顶边同理。
 */
export function snapPanelPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  edges: SnapEdges
): { x: number; y: number } | null {
  const snappedX = snapValue(position.x, edges.left) ?? (() => {
    const rightEdge = snapValue(position.x + size.width, edges.right)
    return rightEdge === null ? null : rightEdge - size.width
  })()
  const snappedY = snapValue(position.y, edges.top) ?? (() => {
    const bottomEdge = snapValue(position.y + size.height, edges.bottom)
    return bottomEdge === null ? null : bottomEdge - size.height
  })()
  if (snappedX === null && snappedY === null) return null
  return { x: snappedX ?? position.x, y: snappedY ?? position.y }
}

/* ============================================================
 * 防重叠（产品规则补充：自由布局，但面板互不重叠）。
 * 渲染层拖动 / 缩放的实时预览与主进程的落库 enforcement 共用这套
 * 纯函数——两边算法一致，用户看到的位置就是最终落库的位置。
 * ============================================================ */

export type PanelRect = {
  x: number
  y: number
  width: number
  height: number
}

export type ResizeAnchor = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** 两块矩形是否相交（共享边不算重叠）。 */
export function rectsIntersect(a: PanelRect, b: PanelRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** 位置 clamp（保持 KEEP_VISIBLE 可达）；宽高原样保留。 */
function clampRect(rect: PanelRect, workspace: WorkspaceSize): PanelRect {
  const maxX = Math.max(0, workspace.width - ROUNDTABLE_PANEL_KEEP_VISIBLE_WIDTH)
  const maxY = Math.max(0, workspace.height - ROUNDTABLE_PANEL_KEEP_VISIBLE_HEIGHT)
  return {
    x: Math.min(Math.max(rect.x, -rect.width + ROUNDTABLE_PANEL_KEEP_VISIBLE_WIDTH), maxX),
    y: Math.min(Math.max(rect.y, -rect.height + ROUNDTABLE_PANEL_KEEP_VISIBLE_HEIGHT), maxY),
    width: rect.width,
    height: rect.height
  }
}

/**
 * 防重叠拖动解析：候选位置与其他面板相交时，沿「离用户意图最近」的
 * 方向推出去（推出后 clamp 回工作区），迭代到无重叠（上限 8 轮）。
 * 推不出去（被其他面板围死）返回 null——调用方保持原位。
 */
export function resolveMoveWithoutOverlap(
  desired: { x: number; y: number },
  size: { width: number; height: number },
  others: ReadonlyArray<RoundtablePanelLayout>,
  workspace: WorkspaceSize
): { x: number; y: number } | null {
  let current: PanelRect = { x: desired.x, y: desired.y, width: size.width, height: size.height }
  for (let round = 0; round < 8; round += 1) {
    const hit = others.find((other) => rectsIntersect(current, other))
    if (!hit) return { x: current.x, y: current.y }
    // 四个推出方向，取离 desired 最近的有效候选（用户意图优先）。
    const options: Array<PanelRect> = [
      { x: hit.x + hit.width, y: current.y, width: current.width, height: current.height },
      { x: hit.x - current.width, y: current.y, width: current.width, height: current.height },
      { x: current.x, y: hit.y + hit.height, width: current.width, height: current.height },
      { x: current.x, y: hit.y - current.height, width: current.width, height: current.height }
    ]
    let best: PanelRect | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const option of options) {
      const clamped = clampRect(option, workspace)
      if (rectsIntersect(clamped, hit)) continue
      const distance = Math.abs(option.x - desired.x) + Math.abs(option.y - desired.y)
      if (distance < bestDistance) {
        bestDistance = distance
        best = clamped
      }
    }
    if (!best) return null
    current = best
  }
  return null
}

/**
 * 防重叠缩放（收缩式解析）：候选 rect 与某面板相交时，把随指针移动的
 * 「自由边」收缩到刚好避开对方，多条路径可选时取**面积损失最小**的一条
 * （用户正在拖的边通常损失最小，自然优先）；迭代到无重叠。
 * 锚定边（对侧）保持不动。无法在不违反最小尺寸的前提下避开 → 返回
 * null，调用方保持原 rect（绝不产生重叠）。
 */
export function resolveResizeWithoutOverlap(
  desired: PanelRect,
  anchor: ResizeAnchor,
  others: ReadonlyArray<RoundtablePanelLayout>
): PanelRect | null {
  let rect: PanelRect = { ...desired }
  const freeRight = anchor.includes('e')
  const freeLeft = anchor.includes('w')
  const freeBottom = anchor.includes('s')
  const freeTop = anchor.includes('n')

  for (let round = 0; round < 16; round += 1) {
    const hit = others.find((panel) => rectsIntersect(rect, panel))
    if (!hit) return { ...rect }
    // 收缩候选：每个自由边各给一条「缩到刚好避开 hit」的路径，取损失最小。
    const options: Array<{ next: PanelRect; loss: number }> = []
    if (freeRight) {
      const width = hit.x - rect.x
      if (width >= ROUNDTABLE_PANEL_MIN_WIDTH) {
        options.push({ next: { ...rect, width }, loss: rect.width - width })
      }
    }
    if (freeLeft) {
      const left = hit.x + hit.width
      const width = rect.x + rect.width - left
      if (width >= ROUNDTABLE_PANEL_MIN_WIDTH) {
        options.push({ next: { ...rect, x: left, width }, loss: rect.width - width })
      }
    }
    if (freeBottom) {
      const height = hit.y - rect.y
      if (height >= ROUNDTABLE_PANEL_MIN_HEIGHT) {
        options.push({ next: { ...rect, height }, loss: rect.height - height })
      }
    }
    if (freeTop) {
      const top = hit.y + hit.height
      const height = rect.y + rect.height - top
      if (height >= ROUNDTABLE_PANEL_MIN_HEIGHT) {
        options.push({ next: { ...rect, y: top, height }, loss: rect.height - height })
      }
    }
    if (options.length === 0) return null
    options.sort((a, b) => a.loss - b.loss)
    rect = options[0].next
  }
  return null
}

/**
 * 新成员落位：从级联种子开始网格扫描（24px 步进）第一个与任何面板都
 * 不相交的位置；种子位本身可用时直接用。找不到（工作区已被挤满）返回
 * null——调用方决定降级策略（缩小到最小尺寸再试 / 退回种子位）。
 */
export function findFreePanelSpot(
  seed: { x: number; y: number },
  size: { width: number; height: number },
  others: ReadonlyArray<RoundtablePanelLayout>,
  workspace: WorkspaceSize
): { x: number; y: number } | null {
  const fits = (rect: PanelRect): boolean =>
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= workspace.width &&
    rect.y + rect.height <= workspace.height &&
    !others.some((other) => rectsIntersect(rect, other))
  const seedRect: PanelRect = { x: seed.x, y: seed.y, width: size.width, height: size.height }
  if (fits(seedRect)) return { x: seedRect.x, y: seedRect.y }
  const step = 24
  const maxX = Math.max(0, workspace.width - size.width)
  const maxY = Math.max(0, workspace.height - size.height)
  for (let y = 0; y <= maxY; y += step) {
    for (let x = 0; x <= maxX; x += step) {
      if (fits({ x, y, width: size.width, height: size.height })) return { x, y }
    }
  }
  return null
}
