/**
 * AI 圆桌的共享模型（Roundtable Phase 1，Phase 2 起参与者改为真实 tabId）。
 *
 * 圆桌只保存「谁在桌上」的引用与几何，不保存网页内容、不保存截图：
 * 参与者是 BrowserTabManager 的 `tabId`，网页状态以主进程快照为准。
 *
 * 三种操作的边界（规格 §5，测试也按这个写）：
 * - `addParticipant`：建立参与关系（网页仍在卡片架）；
 * - `removeParticipant`：解除参与关系（网页不关闭）；
 * - 关闭网页时由调用方先 `removeParticipant`，再销毁标签。
 */

/** 圆桌的参与者引用（挂在圆桌上的 tabId，按拖入顺序排列）。 */
export type Roundtable = {
  id: string
  /** 参与的真实标签 ID；同一张卡只能出现一次。 */
  participantTabIds: string[]
  /** 是否停靠在 Studio Home 底部。 */
  docked: boolean
  /** 浮动时的位置（窗口内容区 CSS px，左上角）。 */
  position: { x: number; y: number }
  /** 浮动时的尺寸（CSS px）。 */
  size: { width: number; height: number }
}

/** 初始圆桌：停靠、无参与者、浮动几何给合理默认值（首次拖出时用）。 */
export function initialRoundtable(): Roundtable {
  return {
    id: 'roundtable-main',
    participantTabIds: [],
    docked: true,
    position: { x: 96, y: 140 },
    size: { width: 560, height: 400 }
  }
}

/* ============================================================
 * 纯操作函数：输入 Roundtable，输出新值；不持有状态。
 * ============================================================ */

/** 拖入圆桌：建立参与关系（追加到末尾）；已在桌上的标签不变（幂等）。 */
export function addParticipant(roundtable: Roundtable, tabId: string): Roundtable {
  if (roundtable.participantTabIds.includes(tabId)) return roundtable
  return { ...roundtable, participantTabIds: [...roundtable.participantTabIds, tabId] }
}

/** 从圆桌移除参与者：只解除关系，网页留在架上（规格 §5）。 */
export function removeParticipant(roundtable: Roundtable, tabId: string): Roundtable {
  return {
    ...roundtable,
    participantTabIds: roundtable.participantTabIds.filter((id) => id !== tabId)
  }
}

/** 只保留仍然存在的标签（关闭网页后清理参与者）。 */
export function retainParticipants(roundtable: Roundtable, liveTabIds: readonly string[]): Roundtable {
  const alive = new Set(liveTabIds)
  const next = roundtable.participantTabIds.filter((id) => alive.has(id))
  if (next.length === roundtable.participantTabIds.length) return roundtable
  return { ...roundtable, participantTabIds: next }
}

/** 参与者在圆桌内排序（与卡片架同语义：插到目标前面）。 */
export function reorderParticipants(roundtable: Roundtable, tabId: string, overId: string): Roundtable {
  const next = reorderIds(roundtable.participantTabIds, tabId, overId)
  if (next === roundtable.participantTabIds) return roundtable
  return { ...roundtable, participantTabIds: next }
}

function reorderIds(ids: string[], id: string, overId: string): string[] {
  if (id === overId) return ids
  const from = ids.indexOf(id)
  const to = ids.indexOf(overId)
  if (from < 0 || to < 0) return ids
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  next.splice(from < to ? to - 1 : to, 0, moved)
  return next
}

/* ============================================================
 * 浮动几何：与 browser-layout 同一套约定（CSS px、先钳尺寸再钳位置），
 * 但常量独立——圆桌的最小尺寸比浏览器小得多。
 * ============================================================ */

export const ROUNDTABLE_MIN_WIDTH = 360
export const ROUNDTABLE_MIN_HEIGHT = 240
/** 顶栏高度：浮动圆桌的标题栏不能压住它。 */
export const ROUNDTABLE_TOP_INSET = 52

export type PanelViewport = { width: number; height: number }

/** 把浮动几何收进窗口：先钳尺寸，再钳位置（与 clampBrowserBounds 同序）。 */
export function clampRoundtable(
  position: { x: number; y: number },
  size: { width: number; height: number },
  viewport: PanelViewport
): { position: { x: number; y: number }; size: { width: number; height: number } } {
  const maxWidth = Math.max(ROUNDTABLE_MIN_WIDTH, Math.floor(viewport.width))
  const maxHeight = Math.max(ROUNDTABLE_MIN_HEIGHT, Math.floor(viewport.height))
  const width = Math.min(Math.max(Math.round(size.width), ROUNDTABLE_MIN_WIDTH), maxWidth)
  const height = Math.min(Math.max(Math.round(size.height), ROUNDTABLE_MIN_HEIGHT), maxHeight)
  const x = Math.min(Math.max(Math.round(position.x), 0), Math.max(0, Math.round(viewport.width) - width))
  const maxY = Math.max(0, Math.round(viewport.height) - height)
  const minY = Math.min(ROUNDTABLE_TOP_INSET, maxY)
  const y = Math.min(Math.max(Math.round(position.y), minY), maxY)
  return { position: { x, y }, size: { width, height } }
}

/** 拖出：停靠 → 浮动。位置先给默认值（调用方可再 clamp）。 */
export function undockRoundtable(roundtable: Roundtable): Roundtable {
  if (!roundtable.docked) return roundtable
  return { ...roundtable, docked: false }
}

/** 归位：浮动 → 停靠。参与者与几何都保留，几何留着下次拖出用。 */
export function dockRoundtable(roundtable: Roundtable): Roundtable {
  if (roundtable.docked) return roundtable
  return { ...roundtable, docked: true }
}
