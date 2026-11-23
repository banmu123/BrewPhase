import { Group, Line, Rect, Text } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { CanvasJourney, CanvasJourneyPlacement, CanvasNodeWithRecord } from '@shared/contracts'
import { themeColors } from '../../shared/tokens'
import { useI18n } from '../../i18n'

/**
 * 画布上的 **Journey Group**（R6-4.1 §4.3 / §4.4）。
 *
 * 一条 Journey 作为一个完整流程分组：标题栏 + 组内事件节点 + 业务连接。
 * 与普通 Record Node 的关系：
 * - 坐标系**完全相同**（画布绝对坐标，来自 `canvas_journey_placements`），
 *   因此两者能共存、对齐、互相连接；
 * - 视觉上靠**分组外框 + 标题栏**与纯卡片的 Record 区分，不抢留白。
 *
 * 三条线各不相同，绝不能混（§4.5）：
 * - `sequence` → 只体现为节点的**排布顺序**（左→右），不画线；
 * - `agent_journey_edges` → 组内**业务关系**，实线带箭头；
 * - `journey_record_links` → 跨记录关系，暖色线，画到画布上的 Record 节点。
 * 时间上相邻**不会**自动长出一条线——线只来自真实数据。
 */

const TYPE_ACCENT: Record<string, string> = {
  user_input: '#8fa8c4',
  plan: '#9db8a4',
  decision: '#b8a6c4',
  execution: '#c4a882',
  observation: '#a4b0be',
  revision: '#c49a8f',
  verification: '#8bb0b8',
  outcome: '#8fae7f',
  user_annotation: '#c9b98f'
}

const HEADER_HEIGHT = 72

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

export function JourneyGroupShape(props: Props) {
  const { t } = useI18n()
  const colors = themeColors()
  const { journey, placements, collapsed } = props

  // 分组外框：由组内事件的**相对坐标**包围盒推出（渲染已在 Group 内，
  // 必须用 local 值；直接拿 DB 的绝对坐标会把外框甩到几千像素外）。
  const groupPlacement = journey.placement
  const localRects = journey.events
    .map((event) => {
      const placement = placements.get(event.id)
      if (!placement) return null
      return {
        x: placement.position_x - groupPlacement.position_x,
        y: placement.position_y - groupPlacement.position_y,
        width: placement.width,
        height: placement.height
      }
    })
    .filter((item): item is { x: number; y: number; width: number; height: number } =>
      Boolean(item)
    )
  const frame = frameOf(localRects, collapsed)

  const group = placements.get(journey.placement.event_id ?? '') ?? journey.placement
  const originX = group.position_x
  const originY = group.position_y

  // 组内偏移 = 绝对摆位 − 分组原点（DB 存绝对坐标，渲染按分组平移）。
  const localOf = (eventId: string) => {
    const placement = placements.get(eventId)
    if (!placement) return null
    return { x: placement.position_x - originX, y: placement.position_y - originY, w: placement.width, h: placement.height }
  }

  const statusLabel =
    t.canvas.journey.status[journey.journey?.status as keyof typeof t.canvas.journey.status] ??
    journey.journey?.status ??
    ''

  return (
    <Group
      x={originX}
      y={originY}
      draggable={props.draggable}
      onClick={props.onSelect}
      onTap={props.onSelect}
      onDragEnd={(event) => props.onGroupMoved(event.target.x(), event.target.y())}
    >
      {/* ── 分组外框与标题栏 ─────────────────────────────── */}
      <Rect
        x={-16}
        y={-HEADER_HEIGHT}
        width={frame.width + 32}
        height={collapsed ? HEADER_HEIGHT : frame.height + HEADER_HEIGHT}
        cornerRadius={16}
        fill={props.selected ? 'rgba(185,159,134,0.10)' : 'rgba(255,253,249,0.72)'}
        stroke={props.selected ? colors.espresso : '#e6ddd0'}
        strokeWidth={props.selected ? 2 : 1}
        dash={[6, 5]}
      />
      <Rect
        x={-16}
        y={-HEADER_HEIGHT}
        width={frame.width + 32}
        height={HEADER_HEIGHT}
        cornerRadius={16}
        fill="#f4ede2"
      />
      {/* 标题栏下方的直角补丁：让圆角只留在上面两角 */}
      <Rect x={-16} y={-24} width={frame.width + 32} height={24} fill="#f4ede2" />

      <Text
        x={0}
        y={-HEADER_HEIGHT + 14}
        width={Math.max(frame.width - 120, 160)}
        text={journey.journey?.title ?? ''}
        fontSize={15}
        fontStyle="bold"
        fill="#30372f"
        wrap="word"
        ellipsis
      />
      <Text
        x={0}
        y={-HEADER_HEIGHT + 38}
        width={Math.max(frame.width - 160, 120)}
        text={`${statusLabel} · ${t.canvas.journey.eventCount(journey.events.length)}`}
        fontSize={11.5}
        fill="#747a71"
        wrap="word"
        ellipsis
      />
      {/* 折叠开关：整组收成一条，画布内容多时靠它减负 */}
      <Text
        x={Math.max(frame.width - 84, 40)}
        y={-HEADER_HEIGHT + 26}
        width={72}
        text={collapsed ? t.canvas.journey.expand : t.canvas.journey.collapse}
        fontSize={12}
        align="right"
        fill="#747a71"
        onClick={(event) => {
          event.cancelBubble = true
          props.onToggleCollapsed()
        }}
        onTap={(event) => {
          event.cancelBubble = true
          props.onToggleCollapsed()
        }}
      />

      {collapsed && (
        <Text
          x={0}
          y={-HEADER_HEIGHT + 54}
          text={journey.events.map((event) => event.title).filter(Boolean).join(' · ')}
          fontSize={11}
          width={Math.max(frame.width - 20, 100)}
          fill="#8b9187"
          ellipsis
        />
      )}

      {/* ── 业务连接（agent_journey_edges）：只画真实存在的关系 ── */}
      {!collapsed &&
        journey.edges.map((edge) => {
          const from = localOf(edge.from_event_id)
          const to = localOf(edge.to_event_id)
          if (!from || !to) return null
          // from = 新事件，to = 旧事件：线从新指向旧（依赖/修订的语义方向）
          const x1 = from.x
          const y1 = from.y + from.h / 2
          const x2 = to.x + to.w
          const y2 = to.y + to.h / 2
          const midX = (x1 + x2) / 2
          return (
            <Line
              key={edge.id}
              points={[x1, y1, midX, y1, midX, y2, x2, y2]}
              stroke="#97765a"
              strokeWidth={1.6}
              lineCap="round"
              lineJoin="round"
              dash={edge.relationship_type === 'retries' ? [7, 5] : undefined}
              listening={false}
            />
          )
        })}

      {/* ── 跨记录连接（journey_record_links）：逐条画 event → record ──
          链接表存的是 `record_id`，画布节点是 `canvas_nodes.id`——两者不同，
          必须按 `node.recordID` 匹配；目标记录没在画布上时就不画
          （§5.2.5 要求先把它加进画布，连线才有落点）。 */}
      {!collapsed &&
        props.links.flatMap((link) => {
          const from = localOf(link.eventId)
          if (!from) return []
          const target = props.recordNodes.find((node) => node.recordID === link.recordId)
          if (!target) return []
          const x1 = from.x + from.w
          const y1 = from.y + from.h / 2
          const x2 = target.positionX - originX
          const y2 = target.positionY - originY + target.height / 2
          const midX = (x1 + x2) / 2
          return (
            <Line
              key={link.id}
              points={[x1, y1, midX, y1, midX, y2, x2, y2]}
              stroke="#c9b98f"
              strokeWidth={2}
              lineCap="round"
              lineJoin="round"
              listening={false}
            />
          )
        })}

      {/* ── 事件节点 ───────────────────────────────────── */}
      {!collapsed &&
        journey.events.map((event) => {
          const local = localOf(event.id)
          if (!local) return null
          const accent = TYPE_ACCENT[event.event_type] ?? '#a4b0be'
          const isSelected = props.selectedEventId === event.id
          return (
            <Group
              key={event.id}
              x={local.x}
              y={local.y}
              draggable={props.draggable}
         onClick={(event2) => {
                event2.cancelBubble = true
                props.onSelectEvent(event.id)
              }}
              onTap={(event2) => {
                event2.cancelBubble = true
                props.onSelectEvent(event.id)
              }}
              onDragEnd={(event2) => {
                event2.cancelBubble = true
                props.onEventMoved(event.id, event2.target.x(), event2.target.y())
              }}
            >
              <Rect
                width={local.w}
                height={local.h}
                cornerRadius={12}
                fill="#fffdf9"
                stroke={isSelected ? colors.espresso : '#e6ddd0'}
                strokeWidth={isSelected ? 2 : 1}
                shadowColor="rgba(48,55,47,0.10)"
                shadowBlur={6}
                shadowOffsetY={2}
              />
              {/* 左侧类型色条：九种事件类型一眼区分 */}
              <Rect width={5} height={local.h} cornerRadius={2.5} fill={accent} />
              <Rect width={5} height={local.h} fill={accent} />

              <Text
                x={14}
                y={11}
                width={local.w - 26}
                text={`#${event.sequence} · ${
                  t.canvas.journey.eventType[
                    event.event_type as keyof typeof t.canvas.journey.eventType
                  ] ?? event.event_type
                }`}
                fontSize={11}
                fill="#8b9187"
                wrap="word"
                ellipsis
              />
              <Text
                x={14}
                y={29}
                width={local.w - 26}
                text={event.title}
                fontSize={14}
                fontStyle="bold"
                fill="#30372f"
                wrap="word"
                ellipsis
                height={36}
              />
              {event.summary && (
                <Text
                  x={14}
                  y={68}
                  width={local.w - 26}
                  height={local.h - 78}
                  text={event.summary}
                  fontSize={11.5}
                  fill="#747a71"
                  wrap="word"
                  ellipsis
                />
              )}
              <Text
                x={14}
                y={local.h - 22}
                width={local.w - 26}
                text={
                  t.canvas.journey.eventStatus[
                    event.status as keyof typeof t.canvas.journey.eventStatus
                  ] ?? event.status
                }
                fontSize={10.5}
                fill={event.status === 'failed' ? '#a36a55' : '#8b9187'}
                ellipsis
              />
            </Group>
          )
        })}
    </Group>
  )
}

/**
 * 组内事件**相对坐标**的包围盒（含留白）；折叠时只留标题栏高度。
 *
 * 用 `max(右/下)` 而不是 `max - min`：分组原点就是摆位原点，布局从 0 开始
 * （`layoutJourneyEvents` 第一列 x=0），标题栏要从原点一直盖到最远的节点。
 */
function frameOf(
  rects: Array<{ x: number; y: number; width: number; height: number }>,
  collapsed: boolean
): { width: number; height: number } {
  if (collapsed || rects.length === 0) return { width: 360, height: 0 }
  const right = Math.max(...rects.map((item) => item.x + item.width))
  const bottom = Math.max(...rects.map((item) => item.y + item.height))
  return { width: Math.max(right, 320) + 40, height: Math.max(bottom, 140) + 40 }
}

export { HEADER_HEIGHT as JOURNEY_HEADER_HEIGHT }
