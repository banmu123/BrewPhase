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

/**
 * 事件卡片尺寸。R6-4.1.1 从 240×140 提到 264×160：
 * 卡内要放「序号+类型字形 / 标题两行 / 摘要三行 / 状态 Chip + 时间」四层，
 * 140 高会让摘要只剩一行多一点，层级挤在一起。
 */
export const JOURNEY_NODE_SIZE = { width: 264, height: 160 } as const

/**
 * 分组盒的内缩：左/右 18、上 70（标题条 58 + 呼吸位 12）、下 18。
 * **这是唯一的一份几何定义**——渲染（JourneyGroupShape）、放置避让
 * （canvas-service）、装窗包围盒（CanvasPage.contentRects）都读它，
 * 三处各写一份迟早会漂移成「装窗把标题条切掉」。
 */
export const JOURNEY_GROUP_PADDING = { top: 70, right: 18, bottom: 18, left: 18 } as const

/** 内容原点在分组盒内的偏移：盒左上角 + 这个量 = 第一个事件节点的原点。 */
export const JOURNEY_GROUP_INSET = {
  x: JOURNEY_GROUP_PADDING.left,
  y: JOURNEY_GROUP_PADDING.top
} as const

/** 列间距要塞得下关系标签（~50px），行间距要够分叉视觉分层。 */
export const JOURNEY_GAP = { x: 76, y: 56 } as const

export type JourneyNodeRect = {
  eventId: string
  /** 组内相对坐标。 */
  x: number
  y: number
  width: number
  height: number
  /** 行带内的 0 基列号（序号下标对 JOURNEY_MAX_COLUMNS 取模）。 */
  column: number
  /** 行号 = 行带 × 每带行数 + 分叉深度；主干为 0。 */
  row: number
}

export type JourneyGroupRect = {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 每行最多几列，超过就换行。
 *
 * 不换行的话，9 步的 Journey 会摊成近 3000px 宽的一条，1440 视口下
 * fit 到 0.45 倍——标题只剩 6px，「打开就能看懂」直接不成立。
 * 5 列时 9 个事件落在 2 个 band 内，fit 约 0.87 倍，正文仍然可读。
 */
export const JOURNEY_MAX_COLUMNS = 5

/**
 * 计算组内每个事件节点的摆位。**纯展示层**：同一份输入永远同一份坐标。
 *
 * 规则（按顺序，缺一不可）：
 * 1. 事件按 `sequence` 升序 → 列号 = 序号下标 **对 JOURNEY_MAX_COLUMNS 取模**，
 *    行带 = 下标整除列数——因此同一行带内列号唯一、行带之间行号错开，**永不重叠**；
 * 2. 分叉深度：某事件是**非相邻** `branch_from`/`revises`/`retries` 边的起点时，
 *    深度 = 目标事件深度 + 1（相邻的 branch_from 就是普通下一步，不换行）；
 * 3. 最终行号 = 行带 × 每带行数 + 分叉深度，每带行数 = 全局最大深度 + 1，
 *    这样分叉只在**自己那个行带内**下沉，不会把后面的行带整体推歪；
 * 4. 目标事件一定先于起点出现（`sequence` 更小），按下标顺序单趟扫描即可定案。
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

  const indexOf = new Map<string, number>()
  ordered.forEach((event, index) => indexOf.set(event.id, index))

  // 按下标顺序算分叉深度：目标下标更小，深度已经定案，一趟即可。
  const depthByEvent = new Map<string, number>()
  const incoming = new Map<string, JourneyLayoutEdge[]>()
  for (const edge of edges) {
    if (!FORK_RELATIONSHIPS.has(edge.relationshipType)) continue
    const list = incoming.get(edge.fromEventId) ?? []
    list.push(edge)
    incoming.set(edge.fromEventId, list)
  }

  let maxDepth = 0
  ordered.forEach((event) => {
    let depth = 0
    for (const edge of incoming.get(event.id) ?? []) {
      const toIndex = indexOf.get(edge.toEventId)
      const fromIndex = indexOf.get(event.id)
      // 只有「非相邻」才算绕开主干；目标必须真的先于起点出现。
      if (toIndex === undefined || fromIndex === undefined) continue
      if (fromIndex - toIndex <= 1) continue
      depth = Math.max(depth, (depthByEvent.get(edge.toEventId) ?? 0) + 1)
    }
    depthByEvent.set(event.id, depth)
    maxDepth = Math.max(maxDepth, depth)
  })

  const rowsPerBand = maxDepth + 1

  return ordered.map((event, index) => {
    const band = Math.floor(index / JOURNEY_MAX_COLUMNS)
    const column = index % JOURNEY_MAX_COLUMNS
    const row = band * rowsPerBand + (depthByEvent.get(event.id) ?? 0)
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
/**
 * 分组盒的完整尺寸（含标题条与四周内缩）。
 *
 * 返回值的 `x/y` 恒为 0：它是**盒子自身的矩形**，而 `canvas_journey_placements`
 * 存的 `position_x/y` 是**内容原点**（第一个节点的左上角）。两者相差
 * `JOURNEY_GROUP_INSET`——放置避让用盒子尺寸、节点落位用内容原点。
 */
export function journeyGroupRect(nodes: readonly JourneyNodeRect[]): JourneyGroupRect {
  const { top, right, bottom, left } = JOURNEY_GROUP_PADDING
  if (nodes.length === 0) {
    return {
      x: 0,
      y: 0,
      width: JOURNEY_NODE_SIZE.width + left + right,
      height: top + JOURNEY_NODE_SIZE.height + bottom
    }
  }
  const maxRight = Math.max(...nodes.map((node) => node.x + node.width))
  const maxBottom = Math.max(...nodes.map((node) => node.y + node.height))
  return {
    x: 0,
    y: 0,
    width: maxRight + left + right,
    height: top + maxBottom + bottom
  }
}

/**
 * 折叠态下 Group 只留标题栏——事件节点全部藏进标题，
 * 画布内容多时整组可以收成一条。
 */
export function collapsedGroupHeight(): number {
  return JOURNEY_GROUP_PADDING.top
}
