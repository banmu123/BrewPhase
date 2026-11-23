/**
 * Journey 在 Canvas 上的**确定性布局**（R6-4.1 §8）。
 *
 * 纯函数、无 IO、无随机：同一份 events + edges 永远算出同一份坐标，
 * 这样「重新打开画布」不会跳位置，测试也能直接断言数值。
 *
 * 两条坐标系，别混：
 * - **组内相对坐标**：本文件输出的 `x/y`，相对 Journey Group 左上角。
 * - **画布绝对坐标** = 分组 `position` + 组内相对坐标。
 *   `canvas_journey_placements` 两者都存：分组行存绝对位置，
 *   事件行存**绝对**位置（与普通 Record Node 同一坐标系，才能共存与对齐）。
 *
 * `sequence` 与业务 Edge 的分工（§4.5，必须区分）：
 * - `sequence` 决定**时间顺序** → 横向列号（左→右），这是布局的主轴；
 * - `agent_journey_edges` 决定**业务关系** → 只在非相邻的
 *   `branch_from` / `revises` / `retries` 上产生视觉分叉（换行）。
 *   时间上相邻的两个节点**不会**因为挨着就长出一条依赖线。
 */

export type JourneyLayoutEventType = string

export type JourneyLayoutEvent = {
  id: string
  sequence: number
  eventType: JourneyLayoutEventType
}

export type JourneyLayoutEdge = {
  fromEventId: string
  toEventId: string
  relationshipType: string
}

/** 会触发视觉分叉的关系；`depends_on` 是主干，留在同一行。 */
const FORK_RELATIONSHIPS = new Set(['branch_from', 'revises', 'retries'])

export const JOURNEY_NODE_SIZE = { width: 240, height: 140 } as const

export const JOURNEY_GROUP_PADDING = { top: 72, right: 40, bottom: 40, left: 40 } as const

export const JOURNEY_GAP = { x: 64, y: 48 } as const

export type JourneyNodeRect = {
  eventId: string
  /** 组内相对坐标。 */
  x: number
  y: number
  width: number
  height: number
  /** sequence 升序后的 0 基列号，仅用于断言与调试。 */
  column: number
  /** 分支行号：主干为 0。 */
  row: number
}

export type JourneyGroupRect = {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 计算组内每个事件节点的摆位。
 *
 * 规则（按顺序，缺一不可）：
 * 1. 事件按 `sequence` 升序 → 列号 = 序号下标，因此**列号唯一、永不重叠**；
 * 2. 行号默认 0（主干）；若某事件是**非相邻** `branch_from`/`revises`/`retries`
 *    边的起点，则行号 = 目标事件行号 + 1（视觉分叉）；
 * 3. 目标事件一定先于起点出现（`sequence` 更小），所以单趟扫描即可定案。
 *
 * `events` 传入顺序不作要求，函数内部会按 `sequence` 排序；
 * `sequence` 相同视为脏数据，以传入顺序兜底，保证输出稳定。
 */
export function layoutJourneyEvents(
  events: readonly JourneyLayoutEvent[],
  edges: readonly JourneyLayoutEdge[] = []
): JourneyNodeRect[] {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)
  if (ordered.length === 0) return []

  const rowByEvent = new Map<string, number>()
  const indexOf = new Map<string, number>()
  ordered.forEach((event, index) => {
    rowByEvent.set(event.id, 0)
    indexOf.set(event.id, index)
  })

  // 非相邻的分叉关系：起点列号比目标列号大 1 以上才算「绕开主干」。
  // 相邻的 branch_from 就是普通下一步，不换行。
  for (const edge of edges) {
    if (!FORK_RELATIONSHIPS.has(edge.relationshipType)) continue
    const fromIndex = indexOf.get(edge.fromEventId)
    const toIndex = indexOf.get(edge.toEventId)
    if (fromIndex === undefined || toIndex === undefined) continue
    if (fromIndex - toIndex <= 1) continue
    const current = rowByEvent.get(edge.fromEventId) ?? 0
    const target = rowByEvent.get(edge.toEventId) ?? 0
    rowByEvent.set(edge.fromEventId, Math.max(current, target + 1))
  }

  return ordered.map((event, column) => {
    const row = rowByEvent.get(event.id) ?? 0
    return {
      eventId: event.id,
      x: column * (JOURNEY_NODE_SIZE.width + JOURNEY_GAP.x),
      y: row * (JOURNEY_NODE_SIZE.height + JOURNEY_GAP.y),
      width: JOURNEY_NODE_SIZE.width,
      height: JOURNEY_NODE_SIZE.height,
      column,
      row
    }
  })
}

/**
 * 由组内节点矩形推导 Group 自身的包围盒（含标题栏与留白）。
 * 没有节点时给出一个最小可点选的尺寸，避免 0×0 的不可命中区域。
 */
export function journeyGroupRect(nodes: readonly JourneyNodeRect[]): JourneyGroupRect {
  if (nodes.length === 0) {
    return {
      x: 0,
      y: 0,
      width: JOURNEY_NODE_SIZE.width + JOURNEY_GROUP_PADDING.left + JOURNEY_GROUP_PADDING.right,
      height: JOURNEY_GROUP_PADDING.top + JOURNEY_NODE_SIZE.height + JOURNEY_GROUP_PADDING.bottom
    }
  }
  const maxRight = Math.max(...nodes.map((node) => node.x + node.width))
  const maxBottom = Math.max(...nodes.map((node) => node.y + node.height))
  return {
    x: 0,
    y: 0,
    width: maxRight + JOURNEY_GROUP_PADDING.right,
    height: maxBottom + JOURNEY_GROUP_PADDING.bottom
  }
}

/**
 * 折叠态下 Group 只留标题栏——事件节点全部藏进标题，
 * 画布内容多时整组可以收成一条。
 */
export function collapsedGroupHeight(): number {
  return JOURNEY_GROUP_PADDING.top
}
