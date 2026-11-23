import type { JourneyCard } from '@shared/contracts'
import { useI18n } from '../../i18n'

/**
 * Records 网格里的 **Agent Journey 卡片**（R6-4.1 §3.1）。
 *
 * Journey 在 Records 中始终是**一条完整的执行记录**——不拆成一堆普通 Record，
 * 也不写进 `records` 表。这里只是展示层：卡片带明确的类型标识
 * （左上角 `Agent Journey` 徽标 + 状态色条），与四种载体的 Record 卡片区分开。
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
      <span className="record-tile__journey-badge">{t.records.journey.typeLabel}</span>

      <span className="record-tile__journey-body">
        <span className="record-tile__title">{journey.title || t.records.untitled}</span>
        {journey.summary && (
          <span className="record-tile__journey-summary">{journey.summary}</span>
        )}
      </span>

      <span className="record-tile__journey-meta">
        <span className="record-tile__journey-status" data-status={journey.status}>
          {statusLabel}
        </span>
        <span>{t.records.journey.events(journey.event_count)}</span>
        {journey.link_count > 0 && <span>{t.records.journey.links(journey.link_count)}</span>}
        {journey.note_count > 0 && <span>{t.records.journey.notes(journey.note_count)}</span>}
      </span>

      <span className="record-tile__journey-foot">
        {journey.source_agent && (
          <span className="record-tile__journey-source">
            {t.records.journey.source(journey.source_agent)}
          </span>
        )}
        <span>{formatDate(journey.updated_at)}</span>
      </span>
    </button>
  )
}
