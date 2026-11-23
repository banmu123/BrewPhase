import { useState, type ReactNode } from 'react'
import { Group, Line, Rect, Shape, Text } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { Context } from 'konva/lib/Context'
import type { CanvasJourney, CanvasJourneyPlacement, CanvasNodeWithRecord } from '@shared/contracts'
import { themeColors, type ThemeColors } from '../../shared/tokens'
import { JOURNEY_MAX_COLUMNS } from '@shared/domain/journey-layout'
import { useI18n } from '../../i18n'

/**
 * 画布上的 **Journey Group**（R6-4.1 §4.3 / §4.4，R6-4.1.1 视觉精修）。
 *
 * 一条 Journey = 一个有明确边界的流程分组：标题条 + 组内事件卡片 + 三类连接。
 * 与普通 Record Node 同一坐标系、同一 Layer，因此能共存、对齐、互相连接。
 *
 * ## 三条连接，三种视觉（绝不能混）
 *
 * | 线 | 来源 | 画法 | 方向 |
 * |---|---|---|---|
 * | 时间顺序 | `sequence`（**纯展示，不落库**） | 中性灰细线 + 箭头，走列间空隙 | 旧 → 新（向右） |
 * | 业务关系 | `agent_journey_edges` | roast 色，带关系标签；相邻直接走空隙，跨列走底部回环道 | from → to（新 → 旧） |
 * | 跨记录关系 | `journey_record_links` | 冷青色 + 关系标签，出组后走侧边道 | event → record |
 *
 * 时间上相邻**不会**自动长出业务线——线只来自真实数据；`sequence` 线也
 * **只画不存**，拖动只写 `canvas_journey_placements`。
 *
 * 颜色全部经 `shared/tokens.ts` 从 `app.css` 读取（浅/暗双主题自动跟随），
 * 本文件不持有任何色值。
 */

// MARK: - 几何常量

/** 标题条高度：只放得下「标题 + 元信息」两行，不做成大横幅。 */
const HEADER = 58
/** 标题条与首个事件之间的呼吸位。 */
const HEAD_GAP = 12
/** 分组四周留白。 */
const PAD = 18
/** 行与行之间的空隙（换行走线用）。 */
const JOURNEY_GAP_Y = 56
/** 列与列之间的空隙：竖直走线只允许落在这里。 */
const JOURNEY_GAP_X = 76
/** 分组最小宽度（事件很少时也不至于缩成一条）。 */
const MIN_BOX_WIDTH = 320

// MARK: - 事件类型

/** 九类事件的 token 键：颜色唯一来源是 app.css，这里只做 type → token 的映射。 */
const ACCENT_KEY: Record<string, keyof ThemeColors> = {
  user_input: 'eventUserInput',
  plan: 'eventPlan',
  decision: 'eventDecision',
  execution: 'eventExecution',
  observation: 'eventObservation',
  revision: 'eventRevision',
  verification: 'eventVerification',
  outcome: 'eventOutcome',
  user_annotation: 'eventUserAnnotation'
}

/**
 * 事件类型字形：Konva 画不了 DOM/SVG 图标，所以每个类型是一条 **16×16 的
 * 描边路径**，由 `Shape.sceneFunc` 直接画。只描边不填充——九张卡保持同一种
 * 笔画粗细与形态语言，颜色只做辅助（色彩不是唯一识别依据）。
 */
function roundedRect(c: Context, x: number, y: number, w: number, h: number, r: number) {
  c.moveTo(x + r, y)
  c.lineTo(x + w - r, y)
  c.arcTo(x + w, y, x + w, y + r, r)
  c.lineTo(x + w, y + h - r)
  c.arcTo(x + w, y + h, x + w - r, y + h, r)
  c.lineTo(x + r, y + h)
  c.arcTo(x, y + h, x, y + h - r, r)
  c.lineTo(x, y + r)
  c.arcTo(x, y, x + r, y, r)
  c.closePath()
}

const GLYPH_PATH: Record<string, (c: Context) => void> = {
  /* 用户需求：对话气泡 */
  user_input: (c) => {
    roundedRect(c, 1.5, 2.5, 13, 8.5, 3)
    c.stroke()
    c.beginPath()
    c.moveTo(5, 11)
    c.lineTo(5, 14.5)
    c.lineTo(8.5, 11)
    c.stroke()
  },
  /* 计划：三条带项目点的横线 */
  plan: (c) => {
    for (const y of [4.2, 8.5, 12.8]) {
      c.beginPath()
      c.moveTo(6.5, y)
      c.lineTo(14.5, y)
      c.stroke()
      c.beginPath()
      c.arc(3.2, y, 1.3, 0, Math.PI * 2)
      c.stroke()
    }
  },
  /* 决策：菱形（分叉的形状本身就是决策） */
  decision: (c) => {
    c.beginPath()
    c.moveTo(8, 1.5)
    c.lineTo(14.5, 8)
    c.lineTo(8, 14.5)
    c.lineTo(1.5, 8)
    c.closePath()
    c.stroke()
  },
  /* 执行：播放三角 */
  execution: (c) => {
    c.beginPath()
    c.moveTo(4.5, 2.5)
    c.lineTo(14, 8)
    c.lineTo(4.5, 13.5)
    c.closePath()
    c.stroke()
  },
  /* 观察：眼睛（轮廓 + 瞳孔） */
  observation: (c) => {
    c.beginPath()
    c.moveTo(1.5, 8)
    c.quadraticCurveTo(8, 1.8, 14.5, 8)
    c.quadraticCurveTo(8, 14.2, 1.5, 8)
    c.closePath()
    c.stroke()
    c.beginPath()
    c.arc(8, 8, 2.3, 0, Math.PI * 2)
    c.stroke()
  },
  /* 修订：环形箭头 */
  revision: (c) => {
    c.beginPath()
    c.arc(8, 8, 5.4, Math.PI * 0.3, Math.PI * 1.85)
    c.stroke()
    c.beginPath()
    c.moveTo(11.4, 4.6)
    c.lineTo(13.9, 6.4)
    c.lineTo(11.9, 8.6)
    c.stroke()
  },
  /* 验证：对勾 */
  verification: (c) => {
    c.beginPath()
    c.moveTo(2, 8.6)
    c.lineTo(6.4, 13.2)
    c.lineTo(14, 3.4)
    c.stroke()
  },
  /* 结果：旗帜 */
  outcome: (c) => {
    c.beginPath()
    c.moveTo(4.2, 14.5)
    c.lineTo(4.2, 2.4)
    c.stroke()
    c.beginPath()
    c.moveTo(4.2, 3)
    c.lineTo(13.6, 5.6)
    c.lineTo(4.2, 8.4)
    c.closePath()
    c.stroke()
  },
  /* 用户补充：铅笔（与 Agent 事件的几何形明显不同） */
  user_annotation: (c) => {
    c.beginPath()
    c.moveTo(2.4, 13.6)
    c.lineTo(4, 9.8)
    c.lineTo(11.8, 2.6)
    c.lineTo(14.2, 5)
    c.lineTo(6.6, 12.6)
    c.closePath()
    c.stroke()
    c.beginPath()
    c.moveTo(2.4, 13.6)
    c.lineTo(6.6, 12.6)
    c.stroke()
  }
}

/** 分组标题左侧的「流程」标记：三个节点串成一条折线。 */
function journeyMarkPath(c: Context) {
  c.beginPath()
  c.moveTo(3.4, 12.4)
  c.lineTo(8, 4.6)
  c.lineTo(12.8, 10.4)
  c.stroke()
  for (const [x, y] of [
    [3.4, 12.4],
    [8, 4.6],
    [12.8, 10.4]
  ]) {
    c.beginPath()
    c.arc(x, y, 1.9, 0, Math.PI * 2)
    c.stroke()
  }
}

/** 折叠按钮的雪佛龙：展开时朝下，折叠时朝右。 */
function chevronPath(c: Context, collapsed: boolean) {
  c.beginPath()
  if (collapsed) {
    c.moveTo(6, 4)
    c.lineTo(10.5, 8)
    c.lineTo(6, 12)
  } else {
    c.moveTo(4.5, 6.5)
    c.lineTo(8, 10)
    c.lineTo(11.5, 6.5)
  }
  c.stroke()
}

// MARK: - 连接线工具

/**
 * 「可以走最短直连」的判定：下标差 1 **且**落在同一行带。
 *
 * 布局会换行，下标相邻的两个事件可能被拆到上下两带——它们在画布上
 * 横跨整行，只按列号判相邻会画出一条穿过别人的直线。
 */
function isAdjacentLocal(
  aId: string,
  bId: string,
  indexOf: Map<string, number>
): boolean {
  const a = indexOf.get(aId)
  const b = indexOf.get(bId)
  if (a === undefined || b === undefined) return false
  if (Math.abs(a - b) !== 1) return false
  return Math.floor(a / JOURNEY_MAX_COLUMNS) === Math.floor(b / JOURNEY_MAX_COLUMNS)
}

/**
 * 箭头三角（三点，闭合）。方向是**语义方向**，不由视觉便利决定：
 * 时间线向右（旧→新），业务边指向 `to`（新→旧），跨记录指向 Record。
 */
function arrowHead(x: number, y: number, dir: 'left' | 'right' | 'up' | 'down', size = 6.5): number[] {
  const wing = size * 0.6
  switch (dir) {
    case 'right':
      return [x, y, x - size, y - wing, x - size, y + wing]
    case 'left':
      return [x, y, x + size, y - wing, x + size, y + wing]
    case 'up':
      return [x, y, x - wing, y + size, x + wing, y + size]
    case 'down':
      return [x, y, x - wing, y - size, x + wing, y - size]
  }
}

/** 折线中点（按弧长取），标签放在那里不会压住任一端的节点。 */
function pointAlong(points: number[], fraction: number): { x: number; y: number } {
  const segments: Array<{ x1: number; y1: number; x2: number; y2: number; len: number }> = []
  let total = 0
  for (let i = 0; i + 3 < points.length; i += 2) {
    const x1 = points[i]
    const y1 = points[i + 1]
    const x2 = points[i + 2]
    const y2 = points[i + 3]
    const len = Math.hypot(x2 - x1, y2 - y1)
    segments.push({ x1, y1, x2, y2, len })
    total += len
  }
  if (total === 0 || segments.length === 0) return { x: points[0] ?? 0, y: points[1] ?? 0 }
  let target = total * fraction
  for (const seg of segments) {
    if (target <= seg.len) {
      const ratio = seg.len === 0 ? 0 : target / seg.len
      return { x: seg.x1 + (seg.x2 - seg.x1) * ratio, y: seg.y1 + (seg.y2 - seg.y1) * ratio }
    }
    target -= seg.len
  }
  const last = segments[segments.length - 1]
  return { x: last.x2, y: last.y2 }
}

/**
 * 估算文本宽度：标签底片要比文字宽一点，而 Konva 的 `Text.getTextWidth()`
 * 要实例才拿得到。中日韩全角按 1em、其余按 0.56em 估——误差几个像素
 * 在 10px 的小标签上读不出来。
 */
function estimateWidth(text: string, fontSize: number): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    width += wide ? fontSize : fontSize * 0.56
  }
  return width
}

/** 折线 + 箭头：一根线的两个可复用部分。 */
function Connector(props: {
  points: number[]
  color: string
  width?: number
  dash?: number[]
  arrow?: { x: number; y: number; dir: 'left' | 'right' | 'up' | 'down' }
}) {
  return (
    <>
      <Line
        points={props.points}
        stroke={props.color}
        strokeWidth={props.width ?? 1.5}
        lineCap="round"
        lineJoin="round"
        dash={props.dash}
        listening={false}
      />
      {props.arrow && (
        <Line
          points={arrowHead(props.arrow.x, props.arrow.y, props.arrow.dir)}
          fill={props.color}
          closed
          listening={false}
        />
      )}
    </>
  )
}

/** 关系标签：一小片底 + 一行小字，压在线的中点上，不抢节点的注意力。 */
function EdgeLabel(props: { x: number; y: number; text: string; color: string; surface: string }) {
  const fontSize = 9.5
  const padX = 6
  const width = estimateWidth(props.text, fontSize) + padX * 2
  const height = 15
  return (
    <Group x={props.x - width / 2} y={props.y - height / 2} listening={false}>
      <Rect width={width} height={height} cornerRadius={height / 2} fill={props.surface} opacity={0.94} />
      <Text
        x={padX}
        y={2}
        width={width - padX * 2}
        text={props.text}
        fontSize={fontSize}
        align="center"
        fill={props.color}
        wrap="none"
        ellipsis
        listening={false}
      />
    </Group>
  )
}

// MARK: - Props

type Props = {
  journey: CanvasJourney
  /** 事件摆位（画布绝对坐标），按 event_id 索引。 */
  placements: Map<string, CanvasJourneyPlacement>
  /** 画布上的 Record 节点：跨记录连线的落点。 */
  recordNodes: CanvasNodeWithRecord[]
  /** 跨记录关系（journey_record_links）：逐条画 event → record。 */
  links: Array<{ id: string; eventId: string; recordId: string; relationshipType: string }>
  collapsed: boolean
  selected: boolean
  selectedEventId: string | null
  draggable: boolean
  onSelect: () => void
  onSelectEvent: (eventId: string) => void
  onToggleCollapsed: () => void
  onGroupMoved: (x: number, y: number) => void | Promise<void>
  onEventMoved: (eventId: string, x: number, y: number) => void | Promise<void>
}

// MARK: - 分组

export function JourneyGroupShape(props: Props) {
  const { t, formatDate } = useI18n()
  const colors = themeColors()
  const { journey, placements, collapsed, selected } = props
  const [hover, setHover] = useState(false)

  const origin = journey.placement
  const originX = origin.position_x
  const originY = origin.position_y

  /** 组内相对坐标 = 绝对摆位 − 分组原点（DB 存绝对坐标，渲染按分组平移）。 */
  const localOf = (eventId: string) => {
    const placement = placements.get(eventId)
    if (!placement) return null
    return {
      x: placement.position_x - originX,
      y: placement.position_y - originY,
      w: placement.width,
      h: placement.height
    }
  }

  const locals = journey.events
    .map((event) => ({ event, rect: localOf(event.id) }))
    .filter((item): item is { event: CanvasJourney['events'][number]; rect: NonNullable<ReturnType<typeof localOf>> } =>
      Boolean(item.rect)
    )

  const indexOf = new Map<string, number>()
  locals.forEach((item, index) => indexOf.set(item.event.id, index))

  const contentW = locals.reduce((max, item) => Math.max(max, item.rect.x + item.rect.w), 0)
  const contentH = locals.reduce((max, item) => Math.max(max, item.rect.y + item.rect.h), 0)

  const boxW = Math.max(contentW + PAD * 2, MIN_BOX_WIDTH)
  const boxY = -(HEADER + HEAD_GAP)

  /*
   * 底部通道（lane）：跨列的业务边与跨记录关系都从这里绕行——
   * 竖直段只走列间隙、横平段只走通道，两者都不会从节点身上穿过去。
   * 通道要占高度，所以分组盒要跟着长高，否则标签会掉到托盘外面。
   */
  const nonAdjacentEdges = journey.edges.filter(
    (edge) => !isAdjacentLocal(edge.from_event_id, edge.to_event_id, indexOf)
  ).length
  const laneBase = contentH + 30
  const laneReserve = (nonAdjacentEdges + props.links.length) > 0
    ? 30 + Math.max(nonAdjacentEdges - 1, 0) * 11 + 30
    : 0

  const boxH = collapsed
    ? HEADER + HEAD_GAP + 34
    : HEADER + HEAD_GAP + contentH + laneReserve + PAD

  const statusLabel =
    t.canvas.journey.status[journey.journey?.status as keyof typeof t.canvas.journey.status] ??
    journey.journey?.status ??
    ''
  const statusColor = statusColorOf(journey.journey?.status ?? '', colors)

  /*
   * 邻接判定必须同时看**行带**与**行带内列号**：
   * 布局会换行（JOURNEY_MAX_COLUMNS），两个下标相邻的事件可能被拆到两带，
   * 它们在画布上横跨整行——只按列号判相邻会画出一条穿过别人的直线。
   */
  const isAdjacent = (aId: string, bId: string) => isAdjacentLocal(aId, bId, indexOf)

  /** 业务关系 → 本地化标签；未知类型退回原值，不吞掉信息。 */
  const edgeLabelOf = (type: string) =>
    t.canvas.journey.edgeType[type as keyof typeof t.canvas.journey.edgeType] ?? type
  /** 跨记录关系 → 本地化标签（参考资料 / 支持决策 / 产生记录 …）。 */
  const linkLabelOf = (type: string) =>
    t.canvas.journey.linkType[type as keyof typeof t.canvas.journey.linkType] ?? type

  return (
    <Group
      x={originX}
      y={originY}
      draggable={props.draggable}
      onClick={props.onSelect}
      onTap={props.onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDragEnd={(event) => props.onGroupMoved(event.target.x(), event.target.y())}
    >
      {/* ── 分组托盘：比台面深一档的凹陷区，卡片才浮得起来 ── */}
      <Rect
        x={-PAD}
        y={boxY}
        width={boxW}
        height={boxH}
        cornerRadius={16}
        fill={selected ? colors.journeySelected : colors.journeySurface}
        stroke={selected ? colors.espresso : colors.journeyBorder}
        strokeWidth={selected ? 1.5 : 1}
        listening={false}
      />

      <GroupHeader
        journey={journey}
        boxX={-PAD}
        boxY={boxY}
        boxW={boxW}
        colors={colors}
        statusLabel={statusLabel}
        statusColor={statusColor}
        hover={hover}
        collapsed={collapsed}
        onToggle={props.onToggleCollapsed}
        formatDate={formatDate}
      />

      {/* 折叠态：用一排类型色点 + 标题串给出「整组在说什么」的预览 */}
      {collapsed && (
        <CollapsedPreview journey={journey} boxX={-PAD} boxY={boxY} colors={colors} />
      )}

      {!collapsed && (
        <>
          {/* 标题条与内容之间的分隔：一条发丝线，不做色块 */}
          <Rect
            x={-PAD + 12}
            y={-6}
            width={boxW - 24}
            height={1}
            fill={colors.journeyBorder}
            listening={false}
          />

          {renderSequenceFlow(journey, locals, colors)}
          {renderBusinessEdges(journey, locals, isAdjacent, colors, edgeLabelOf, laneBase)}
          {renderRecordLinks(props, locals, { originX, originY, boxW, colors, laneBase }, linkLabelOf)}

          {locals.map(({ event, rect }) => (
            <EventNodeShape
              key={event.id}
              event={event}
              rect={rect}
              colors={colors}
              selected={props.selectedEventId === event.id}
              draggable={props.draggable}
              onSelect={() => props.onSelectEvent(event.id)}
              onMoved={(x, y) => props.onEventMoved(event.id, x, y)}
              formatDate={formatDate}
            />
          ))}
        </>
      )}
    </Group>
  )
}

// MARK: - 标题条

function GroupHeader(props: {
  journey: CanvasJourney
  boxX: number
  boxY: number
  boxW: number
  colors: ThemeColors
  statusLabel: string
  statusColor: string
  hover: boolean
  collapsed: boolean
  onToggle: () => void
  formatDate: (value: number | Date) => string
}) {
  const { t } = useI18n()
  const { journey, colors, boxX, boxY, boxW } = props
  const [btnHover, setBtnHover] = useState(false)

  const glyphX = boxX + 14
  const textX = glyphX + 26
  const btnSize = 26
  const btnX = boxX + boxW - 12 - btnSize
  const btnY = boxY + 16

  const eventCountText = t.canvas.journey.eventCount(journey.events.length)
  const countW = estimateWidth(eventCountText, 10) + 14
  const statusW = estimateWidth(props.statusLabel, 10) + 14
  const chipsRight = btnX - 8
  const countX = chipsRight - countW
  const statusX = countX - 6 - statusW

  const titleRight = Math.max(textX + 80, statusX - 10)
  const titleW = titleRight - textX

  const source = journey.journey?.source_agent
  const meta = source
    ? t.canvas.journey.source(source)
    : (journey.journey?.goal ?? '').trim()

  return (
    <>
      {/* 流程标记：三节点折线，一眼看出「这是一条流程」 */}
      <Shape
        x={glyphX}
        y={boxY + 17}
        sceneFunc={(context) => {
          context.beginPath()
          journeyMarkPath(context)
        }}
        stroke={colors.roast}
        strokeWidth={1.5}
        lineCap="round"
        lineJoin="round"
        listening={false}
      />

      <Text
        x={textX}
        y={boxY + 12}
        width={titleW}
        text={journey.journey?.title ?? ''}
        fontSize={14.5}
        fontStyle="600"
        fill={colors.ink}
        wrap="word"
        ellipsis
        height={22}
        listening={false}
      />

      {/* 状态 Chip：底片用同色低透明度，字用同一色——失败一眼可见但不刺眼 */}
      <Group x={statusX} y={boxY + 16} listening={false}>
        <Rect width={statusW} height={18} cornerRadius={9} fill={props.statusColor} opacity={0.16} />
        <Text
          x={7}
          y={3.5}
          width={statusW - 14}
          text={props.statusLabel}
          fontSize={10}
          align="center"
          fill={props.statusColor}
          wrap="none"
          ellipsis
          listening={false}
        />
      </Group>

      <Group x={countX} y={boxY + 16} listening={false}>
        <Rect width={countW} height={18} cornerRadius={9} fill={colors.canvasChip} />
        <Text
          x={7}
          y={3.5}
          width={countW - 14}
          text={eventCountText}
          fontSize={10}
          align="center"
          fill={colors.journeyInk}
          wrap="none"
          ellipsis
          listening={false}
        />
      </Group>

      {meta && (
        <Text
          x={textX}
          y={boxY + 38}
          width={boxW - (textX - boxX) - 12}
          text={meta}
          fontSize={10.5}
          fill={colors.journeyInk}
          wrap="word"
          ellipsis
          height={16}
          listening={false}
        />
      )}

      {/* 折叠开关：有底片、有 hover 反馈的真实控件，不是一行字 */}
      <Group
        x={btnX}
        y={btnY}
        onClick={(event) => {
          event.cancelBubble = true
          props.onToggle()
        }}
        onTap={(event) => {
          event.cancelBubble = true
          props.onToggle()
        }}
        onMouseEnter={() => setBtnHover(true)}
        onMouseLeave={() => setBtnHover(false)}
      >
        <Rect
          width={btnSize}
          height={btnSize}
          cornerRadius={7}
          fill={btnHover ? colors.wellDeep : colors.canvasChip}
          stroke={colors.journeyBorder}
          strokeWidth={1}
        />
        <Shape
          x={5}
          y={5}
          sceneFunc={(context) => {
            context.beginPath()
            chevronPath(context, props.collapsed)
          }}
          stroke={colors.journeyInk}
          strokeWidth={1.6}
          lineCap="round"
          lineJoin="round"
          listening={false}
        />
      </Group>
    </>
  )
}

function CollapsedPreview(props: {
  journey: CanvasJourney
  boxX: number
  boxY: number
  colors: ThemeColors
}) {
  const { journey, colors, boxX, boxY } = props
  const y = boxY + HEADER + HEAD_GAP
  const titles = journey.events
    .map((event) => event.title)
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      {/* 类型色点按 sequence 排开：折叠时也能看出这条 Journey 的构成 */}
      {journey.events.slice(0, 24).map((event, index) => (
        <Rect
          key={event.id}
          x={boxX + 16 + index * 11}
          y={y + 4}
          width={7}
          height={7}
          cornerRadius={3.5}
          fill={colors[ACCENT_KEY[event.event_type] ?? 'eventObservation']}
          listening={false}
        />
      ))}
      <Text
        x={boxX + 16}
        y={y + 17}
        width={journey.events.length > 24 ? 240 : journey.events.length * 11 + 8}
        text={titles}
        fontSize={10.5}
        fill={colors.journeyInk}
        wrap="none"
        ellipsis
        listening={false}
      />
      <Text
        x={boxX + 16 + Math.min(journey.events.length, 24) * 11 + 8}
        y={y + 3}
        text=""
        listening={false}
      />
    </>
  )
}

// MARK: - 事件卡片

function EventNodeShape(props: {
  event: CanvasJourney['events'][number]
  rect: { x: number; y: number; w: number; h: number }
  colors: ThemeColors
  selected: boolean
  draggable: boolean
  onSelect: () => void
  onMoved: (x: number, y: number) => void | Promise<void>
  formatDate: (value: number | Date) => string
}) {
  const { t } = useI18n()
  const { event, rect, colors, selected } = props
  const [hover, setHover] = useState(false)

  const accent = colors[ACCENT_KEY[event.event_type] ?? 'eventObservation']
  const typeLabel =
    t.canvas.journey.eventType[event.event_type as keyof typeof t.canvas.journey.eventType] ??
    event.event_type
  const statusLabel =
    t.canvas.journey.eventStatus[event.status as keyof typeof t.canvas.journey.eventStatus] ??
    event.status
  const statusColor = eventStatusColor(event.status, colors)

  const pad = 13
  const badgeW = 26
  const glyphSize = 22

  const statusW = estimateWidth(statusLabel, 9.5) + 16
  const footerY = rect.h - pad - 17
  const hasTime = event.occurred_at > 0
  const timeText = hasTime ? props.formatDate(event.occurred_at) : ''

  return (
    <Group
      x={rect.x}
      y={rect.y}
      draggable={props.draggable}
      onClick={(e) => {
        e.cancelBubble = true
        props.onSelect()
      }}
      onTap={(e) => {
        e.cancelBubble = true
        props.onSelect()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDragEnd={(e) => {
        e.cancelBubble = true
        props.onMoved(e.target.x(), e.target.y())
      }}
    >
      {/* 命中层：透明矩形覆盖整卡（视觉元素全部 listening={false}） */}
      <Rect width={rect.w} height={rect.h} fill="rgba(255,255,255,0.001)" />

      <Rect
        width={rect.w}
        height={rect.h}
        cornerRadius={11}
        fill={colors.eventSurface}
        stroke={selected ? colors.espresso : hover ? colors.latte : colors.eventBorder}
        strokeWidth={selected ? 1.5 : 1}
        shadowColor={colors.ink}
        shadowOpacity={selected ? 0.16 : 0.08}
        shadowBlur={selected ? 10 : 6}
        shadowOffsetY={2}
        listening={false}
      />

      {/* 顶部：序号徽标 + 类型字形 + 类型名（颜色之外还有形状，不靠颜色单独识别） */}
      <Group x={pad} y={12} listening={false}>
        <Rect width={badgeW} height={16} cornerRadius={8} fill={accent} opacity={0.18} />
        <Text
          x={0}
          y={2.5}
          width={badgeW}
          text={`#${event.sequence}`}
          fontSize={9.5}
          fontStyle="600"
          align="center"
          fill={accent}
          wrap="none"
          listening={false}
        />
      </Group>

      <Rect
        x={pad + badgeW + 7}
        y={10}
        width={glyphSize}
        height={glyphSize}
        cornerRadius={6}
        fill={accent}
        opacity={0.15}
        listening={false}
      />
      <Shape
        x={pad + badgeW + 7 + 3}
        y={13}
        sceneFunc={(context) => {
          const path = GLYPH_PATH[event.event_type]
          context.beginPath()
          if (path) path(context)
          else {
            context.arc(8, 8, 6, 0, Math.PI * 2)
          }
        }}
        stroke={accent}
        strokeWidth={1.5}
        lineCap="round"
        lineJoin="round"
        listening={false}
      />
      <Text
        x={pad + badgeW + 7 + glyphSize + 7}
        y={16}
        width={rect.w - pad * 2 - badgeW - glyphSize - 28}
        text={typeLabel}
        fontSize={10.5}
        fontStyle="600"
        fill={colors.journeyInk}
        wrap="none"
        ellipsis
        listening={false}
      />

      {/* 标题：卡片的主角 */}
      <Text
        x={pad}
        y={40}
        width={rect.w - pad * 2}
        text={event.title}
        fontSize={14}
        fontStyle="600"
        fill={colors.ink}
        lineHeight={1.35}
        wrap="word"
        ellipsis
        height={38}
        listening={false}
      />

      {/* 摘要：最多三行，完整内容交给 Inspector */}
      {event.summary && (
        <Text
          x={pad}
          y={82}
          width={rect.w - pad * 2}
          height={footerY - 82 - 8}
          text={event.summary}
          fontSize={11.5}
          fill={colors.journeyInk}
          lineHeight={1.5}
          wrap="word"
          ellipsis
          listening={false}
        />
      )}

      {/* 底部：状态 Chip（不是一行灰字）+ 时间 */}
      <Group x={pad} y={footerY} listening={false}>
        <Rect width={statusW} height={17} cornerRadius={8.5} fill={statusColor} opacity={0.15} />
        <Text
          x={8}
          y={3}
          width={statusW - 16}
          text={statusLabel}
          fontSize={9.5}
          align="center"
          fill={statusColor}
          wrap="none"
          ellipsis
          listening={false}
        />
      </Group>
      {hasTime && (
        <Text
          x={pad + statusW + 8}
          y={footerY + 3.5}
          width={rect.w - pad * 2 - statusW - 8}
          text={timeText}
          fontSize={9.5}
          fill={colors.journeyInk}
          align="right"
          wrap="none"
          ellipsis
          listening={false}
        />
      )}
    </Group>
  )
}

// MARK: - 连接系统

type LocalRect = { x: number; y: number; w: number; h: number }
type LocalEvent = { event: CanvasJourney['events'][number]; rect: LocalRect }

/**
 * 时间顺序线：**只画不存**的纯展示引导。
 *
 * 走列与列之间的空隙，因此永远不会压住节点；行号变化（分叉）时用一个
 * 折弯过渡。方向是旧 → 新（向右），与业务边的新 → 旧正好相反——
 * 两种线一眼就分得开。
 */
function renderSequenceFlow(
  journey: CanvasJourney,
  locals: LocalEvent[],
  colors: ThemeColors
) {
  const nodes: ReactNode[] = []
  for (let i = 0; i + 1 < locals.length; i += 1) {
    const from = locals[i].rect
    const to = locals[i + 1].rect
    const x1 = from.x + from.w
    const y1 = from.y + from.h / 2
    const x2 = to.x
    const y2 = to.y + to.h / 2

    // 换行了（下一个事件回到最左列）：不能直接连——那会横穿整行。
    // 改走「本行下方空隙 → 左侧留白 → 进入下一个事件的左边」，
    // 两段都在节点之外，永远不会压住内容。
    if (x2 <= x1) {
      const laneY = from.y + from.h + JOURNEY_GAP_Y / 2
      const marginX = -PAD + 8
      nodes.push(
        <Connector
          key={`seq-${journey.placement.id}-${i}`}
          points={[
            from.x + from.w / 2,
            from.y + from.h,
            from.x + from.w / 2,
            laneY,
            marginX,
            laneY,
            marginX,
            y2,
            x2,
            y2
          ]}
          color={colors.connectorSequence}
          width={1.4}
          arrow={{ x: x2, y: y2, dir: 'right' }}
        />
      )
      continue
    }

    const points =
      Math.abs(y1 - y2) < 1
        ? [x1, y1, x2, y2]
        : [x1, y1, x1 + (x2 - x1) / 2, y1, x1 + (x2 - x1) / 2, y2, x2, y2]
    nodes.push(
      <Connector
        key={`seq-${journey.placement.id}-${i}`}
        points={points}
        color={colors.connectorSequence}
        width={1.4}
        arrow={{ x: x2, y: y2, dir: 'right' }}
      />
    )
  }
  return nodes
}

/**
 * 业务关系（`agent_journey_edges`）：方向严格按 `from_event_id → to_event_id`
 * （新事件 → 旧事件），**不为视觉便利颠倒语义**。
 *
 * 跨列时中间可能有同排的节点——直接连线会从别人身上穿过去，所以改成
 * 走**分组底部的回环道**：下到道上 → 横移 → 上到 `to` 的底边，
 * 箭头指进 `to`。相邻列则直接走列间空隙，保持最短路径。
 */
function renderBusinessEdges(
  journey: CanvasJourney,
  locals: LocalEvent[],
  isAdjacent: (a: string, b: string) => boolean,
  colors: ThemeColors,
  labelOf: (type: string) => string,
  laneBase: number
) {
  const byId = new Map(locals.map((item) => [item.event.id, item]))
  const nodes: ReactNode[] = []

  journey.edges.forEach((edge, index) => {
    const from = byId.get(edge.from_event_id)
    const to = byId.get(edge.to_event_id)
    if (!from || !to) return

    let points: number[]
    let arrow: { x: number; y: number; dir: 'left' | 'right' | 'up' | 'down' }

    if (isAdjacent(edge.from_event_id, edge.to_event_id)) {
      // 同行带内相邻：列间隙里走最短路径，一眼看出「紧接上一步」。
      const x1 = from.rect.x
      const y1 = from.rect.y + from.rect.h / 2
      const x2 = to.rect.x + to.rect.w
      const y2 = to.rect.y + to.rect.h / 2
      const midX = (x1 + x2) / 2
      points = Math.abs(y1 - y2) < 1 ? [x1, y1, x2, y2] : [x1, y1, midX, y1, midX, y2, x2, y2]
      arrow = { x: x2, y: y2, dir: 'left' }
    } else {
      /*
       * 跨列 / 跨行带：竖直段只落在**列间隙**，横平段只落在**底部通道**。
       * 两条路都在节点之外，因此无论中间隔着几行几列都不会穿过别人。
       * 方向仍是 from → to（新 → 旧），不为视觉便利颠倒语义。
       */
      const fromRight = to.rect.x > from.rect.x
      const exitX = fromRight
        ? from.rect.x + from.rect.w + JOURNEY_GAP_X / 2
        : from.rect.x - JOURNEY_GAP_X / 2
      const enterX = fromRight
        ? to.rect.x - JOURNEY_GAP_X / 2
        : to.rect.x + to.rect.w + JOURNEY_GAP_X / 2
      const laneY = laneBase + index * 11
      points = [
        fromRight ? from.rect.x + from.rect.w : from.rect.x,
        from.rect.y + from.rect.h / 2,
        exitX,
        from.rect.y + from.rect.h / 2,
        exitX,
        laneY,
        enterX,
        laneY,
        enterX,
        to.rect.y + to.rect.h / 2,
        fromRight ? to.rect.x : to.rect.x + to.rect.w,
        to.rect.y + to.rect.h / 2
      ]
      arrow = fromRight
        ? { x: to.rect.x, y: to.rect.y + to.rect.h / 2, dir: 'right' }
        : { x: to.rect.x + to.rect.w, y: to.rect.y + to.rect.h / 2, dir: 'left' }
    }

    nodes.push(
      <Connector
        key={edge.id}
        points={points}
        color={colors.connectorEdge}
        width={1.5}
        dash={dashFor(edge.relationship_type)}
        arrow={arrow}
      />
    )
    // 标签压在线的中点：底片托住文字，跨过空隙也不会糊
    const at = pointAlong(points, 0.5)
    nodes.push(
      <EdgeLabel
        key={`${edge.id}-label`}
        x={at.x}
        y={at.y}
        text={labelOf(edge.relationship_type)}
        color={colors.connectorEdge}
        surface={colors.eventSurface}
      />
    )
  })
  return nodes
}

/** 关系类型的线型区分：依赖实线、分支长划、修订点划、重试密点。 */
function dashFor(type: string): number[] | undefined {
  switch (type) {
    case 'branch_from':
      return [8, 5]
    case 'revises':
      return [10, 4, 2, 4]
    case 'retries':
      return [3, 4]
    default:
      return undefined
  }
}

/**
 * 跨记录关系（`journey_record_links`）：冷青色，**与业务边不同色不同道**。
 *
 * 出组之后走侧边道再横移，避免竖线切过组内其他事件。
 * 目标记录不在画布上就不画（先加进画布，连线才有落点）。
 */
function renderRecordLinks(
  props: Props,
  locals: LocalEvent[],
  ctx: {
    originX: number
    originY: number
    boxW: number
    colors: ThemeColors
    laneBase: number
  },
  labelOf: (type: string) => string
) {
  const byId = new Map(locals.map((item) => [item.event.id, item]))
  const nodes: ReactNode[] = []
  const { colors } = ctx

  props.links.forEach((link, index) => {
    const from = byId.get(link.eventId)
    if (!from) return
    const target = props.recordNodes.find((node) => node.recordID === link.recordId)
    if (!target) return

    const x1 = from.rect.x + from.rect.w
    const y1 = from.rect.y + from.rect.h / 2
    const targetX = target.positionX - ctx.originX
    const targetY = target.positionY - ctx.originY
    const targetCenterY = targetY + target.height / 2

    /*
     * 出组走「列间隙 → 底部通道 → 组外竖道」：
     * 水平段在通道里、竖直段在组外，组内事件一个都不会被切到。
     * 组外竖道固定在托盘右侧外，多条连线各偏移几像素避免叠在一起。
     */
    const exitX = x1 + JOURNEY_GAP_X / 2
    const outsideX = ctx.boxW - PAD + 26 + index * 6
    const laneY = ctx.laneBase + 16 + index * 11
    const points = [x1, y1, exitX, y1, exitX, laneY, outsideX, laneY, outsideX, targetCenterY, targetX, targetCenterY]

    nodes.push(
      <Connector
        key={link.id}
        points={points}
        color={colors.connectorRecord}
        width={1.8}
        arrow={{ x: targetX, y: targetCenterY, dir: 'right' }}
      />
    )
    const at = pointAlong(points, 0.55)
    nodes.push(
      <EdgeLabel
        key={`${link.id}-label`}
        x={at.x}
        y={at.y}
        text={labelOf(link.relationshipType)}
        color={colors.connectorRecord}
        surface={colors.eventSurface}
      />
    )
  })
  return nodes
}

// MARK: - 颜色与标签

function statusColorOf(status: string, colors: ThemeColors): string {
  switch (status) {
    case 'running':
      return colors.statusRunning
    case 'completed':
      return colors.statusCompleted
    case 'failed':
      return colors.statusFailed
    case 'paused':
      return colors.latte
    case 'cancelled':
    case 'abandoned':
      return colors.statusSkipped
    default:
      return colors.statusPending
  }
}

function eventStatusColor(status: string, colors: ThemeColors): string {
  switch (status) {
    case 'running':
      return colors.statusRunning
    case 'completed':
      return colors.statusCompleted
    case 'failed':
      return colors.statusFailed
    case 'skipped':
    case 'cancelled':
      return colors.statusSkipped
    default:
      return colors.statusPending
  }
}
