import type { JourneyCard } from '@shared/contracts'
import { useI18n } from '../../i18n'
import { EventGlyph } from '../../shared/EventGlyph'

/**
 * Records 网格里的 **Agent Journey 卡片**（R6-4.1 §3.1，R6-4.1.1 §6 精修）。
 *
 * Journey 在 Records 中始终是**一条完整的执行记录**——不拆成一堆普通 Record，
 * 也不写进 `records` 表。这里只是展示层。
 *
 * 与普通 Record Tile 的关系（§6 的三条硬要求）：
 * - **不能完全一样**：顶部类型徽标 + 状态 Chip + 计数 Chip 组成的头部，
 *   加一条随状态变化的左侧色条，一眼能看出「这不是收藏」；
 * - **也不能做成夸张的独立大卡片**：沿用同一套 masonry 栅格、同一套
 *   圆角/边框/阴影与排版尺度，只是内部信息分层更细；
 * - 长标题两行截断、长摘要三行截断，中英文都不会把卡片撑歪。
 */
export function JourneyTile(props: {
  journey: JourneyCard
  active: boolean
  onClick: () => void
}) {
  const { t, formatDate } = useI18n()
  const { journey } = props
  const statusKey = journey.status as keyof typeof t.records.journey.status
  const statusLabel = t.records.journey.status[statusKey] ?? journey.status

  return (
    <button
      type="button"
      className="record-tile record-tile--journey"
      data-active={props.active}
      data-status={journey.status}
      onClick={props.onClick}
    >
      {/* 头部：类型徽标（字形 + 名称）+ 状态 Chip —— 两个维度分开，
          色彩不是唯一识别依据（字形与文字都在） */}
      <span className="record-tile__journey-head">
        <span className="journey-type-badge">
          <EventGlyph type="outcome" size={13} />
          {t.records.journey.typeLabel}
        </span>
        <span className="journey-chip journey-chip--status" data-status={journey.status}>
          {statusLabel}
        </span>
      </span>

      <span className="record-tile__journey-body">
        <span className="record-tile__title">{journey.title || t.records.untitled}</span>
        {journey.summary && (
          <span className="record-tile__journey-summary">{journey.summary}</span>
        )}
      </span>

      {/* 计数用小 Chip 而不是一段灰字：数字是可扫读的 */}
      <span className="record-tile__journey-counts">
        <span className="journey-chip">{t.records.journey.events(journey.event_count)}</span>
        {journey.link_count > 0 && (
          <span className="journey-chip">{t.records.journey.links(journey.link_count)}</span>
        )}
        {journey.note_count > 0 && (
          <span className="journey-chip">{t.records.journey.notes(journey.note_count)}</span>
        )}
      </span>

      <span className="record-tile__journey-foot">
        <span className="record-tile__journey-source">
          {journey.source_agent
            ? t.records.journey.source(journey.source_agent)
            : t.records.journey.selfReported}
        </span>
        <span>{formatDate(journey.updated_at)}</span>
      </span>
    </button>
  )
}
