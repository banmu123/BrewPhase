import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CanvasJourney, CanvasJourneyPlacement, CanvasNodeWithRecord } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'

/**
 * Journey Inspector 的内容体（R6-4.1 §4.4 / §5.2 / §6）。
 *
 * 两种形态：
 * - **未选中事件**（`eventId === null`）→ 整条 Journey 的信息 + Journey 级笔记；
 * - **选中事件** → 事件详情（只读，来自 Agent 原始记录）+ Event 级笔记
 *   + 到普通 Record 的跨记录连接。
 *
 * 数据隔离（§6.3）：这里所有的写操作只碰 `agent_journey_notes` 与
 * `journey_record_links` 两张表。**没有任何入口能改 `agent_journey_events`**
 * ——事件内容对用户是只读的，用户补充永远是新增行。
 */
export function JourneyInspectorBody(props: {
  journey: CanvasJourney
  eventId: string | null
  canvasId: string
  recordNodes: CanvasNodeWithRecord[]
  onChanged: () => void
  onRemove: () => void
}) {
  const { t, formatDate } = useI18n()
  const { journey, eventId } = props

  const [noteDraft, setNoteDraft] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 建立连接：目标记录必须已在画布上（§5.2.5 说必要时先加进画布）。
  const [linkRecordId, setLinkRecordId] = useState('')
  const [linkType, setLinkType] = useState('references')

  const event = useMemo(
    () => journey.events.find((item) => item.id === eventId) ?? null,
    [journey.events, eventId]
  )

  // 笔记由详情接口返回（画布载荷不含笔记，避免每次拖动都重传）。
  // 这里单独取一次，编辑后由 onChanged 触发父层重取。
  const [notes, setNotes] = useState<Array<{ id: string; event_id: string | null; body: string }>>(
    []
  )
  const [links, setLinks] = useState<
    Array<{ id: string; event_id: string; record_id: string; relationship_type: string }>
  >([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  const reload = useCallback(() => {
    api.agentJourneys
      .get(props.journey.placement.journey_id)
      .then((detail) => {
        setNotes(detail.notes.map((note) => ({ id: note.id, event_id: note.event_id, body: note.body })))
        setLinks(
          detail.links.map((link) => ({
            id: link.id,
            event_id: link.event_id,
            record_id: link.record_id,
            relationship_type: link.relationship_type
          }))
        )
        setLoadedFor(props.journey.placement.journey_id)
      })
      .catch((cause: Error) => setError(cause.message))
  }, [props.journey.placement.journey_id])

  // 首次展开 / 换了 Journey 时取一次；写操作后由 reload() 手动再取。
  useEffect(() => {
    if (loadedFor === props.journey.placement.journey_id) return
    let alive = true
    api.agentJourneys
      .get(props.journey.placement.journey_id)
      .then((detail) => {
        if (!alive) return
        setNotes(
          detail.notes.map((note) => ({ id: note.id, event_id: note.event_id, body: note.body }))
        )
        setLinks(
          detail.links.map((link) => ({
            id: link.id,
            event_id: link.event_id,
            record_id: link.record_id,
            relationship_type: link.relationship_type
          }))
        )
        setLoadedFor(props.journey.placement.journey_id)
      })
      .catch((cause: Error) => {
        if (alive) setError(cause.message)
      })
    return () => {
      alive = false
    }
  }, [loadedFor, props.journey.placement.journey_id])

  const visibleNotes = notes.filter((note) =>
    eventId ? note.event_id === eventId : note.event_id === null
  )
  const visibleLinks = eventId ? links.filter((link) => link.event_id === eventId) : []

  const saveNote = useCallback(async () => {
    const body = noteDraft.trim()
    if (!body) return
    setNoteBusy(true)
    setError(null)
    try {
      await api.agentJourneys.createNote(props.journey.placement.journey_id, body, eventId)
      setNoteDraft('')
      reload()
      props.onChanged()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setNoteBusy(false)
    }
  }, [noteDraft, eventId, props, reload])

  const deleteNote = useCallback(
    async (id: string) => {
      setError(null)
      try {
        await api.agentJourneys.removeNote(id)
        reload()
        props.onChanged()
      } catch (cause) {
        setError((cause as Error).message)
      }
    },
    [props, reload]
  )

  const createLink = useCallback(async () => {
    if (!eventId || !linkRecordId) return
    setError(null)
    setMessage(null)
    try {
      await api.agentJourneys.createLink({
        journeyId: props.journey.placement.journey_id,
        eventId,
        recordId: linkRecordId,
        relationshipType: linkType as 'references'
      })
      setMessage(t.canvas.journey.linkCreate)
      reload()
      props.onChanged()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [eventId, linkRecordId, linkType, props, reload, t])

  const deleteLink = useCallback(
    async (id: string) => {
      setError(null)
      try {
        await api.agentJourneys.removeLink(id)
        reload()
        props.onChanged()
      } catch (cause) {
        setError((cause as Error).message)
      }
    },
    [props, reload]
  )

  const statusLabel =
    t.canvas.journey.status[journey.journey?.status as keyof typeof t.canvas.journey.status] ??
    journey.journey?.status ??
    ''

  return (
    <div className="journey-inspector">
      {/* ── 头部：整条 Journey 的元信息 ─────────────────── */}
      <h2 className="detail-title">{journey.journey?.title ?? ''}</h2>
      <div className="detail-meta">
        <span className="journey-status" data-status={journey.journey?.status}>
          {statusLabel}
        </span>
        <span>{t.canvas.journey.eventCount(journey.events.length)}</span>
        {journey.journey?.source_agent && (
          <span>{journey.journey.source_agent}</span>
        )}
      </div>
      {journey.journey?.goal && (
        <p className="note" style={{ marginTop: 8 }}>
          {journey.journey.goal}
        </p>
      )}

      {/* ── 事件详情（只读） ─────────────────────────────── */}
      {event && (
        <section className="journey-section">
          <h3 className="journey-section__title">
            {t.canvas.journey.sequence(event.sequence)} ·{' '}
            {t.canvas.journey.eventType[
              event.event_type as keyof typeof t.canvas.journey.eventType
            ] ?? event.event_type}
          </h3>
          <div className="journey-event__title">{event.title}</div>
          <div className="detail-meta">
            <span className="journey-event__status" data-status={event.status}>
              {t.canvas.journey.eventStatus[
                event.status as keyof typeof t.canvas.journey.eventStatus
              ] ?? event.status}
            </span>
            <span>{formatDate(event.occurred_at)}</span>
          </div>
          {event.summary && <p className="note">{event.summary}</p>}
          {event.content && <div className="detail-note">{event.content}</div>}
          {event.reason && (
            <div className="detail-note">
              <span className="journey-note__label">
                {t.canvas.journey.eventType.decision}
              </span>
              {event.reason}
            </div>
          )}
        </section>
      )}

      {/* ── 业务关系：来自 agent_journey_edges ─────────────── */}
      {event && journey.edges.filter((edge) => edge.from_event_id === event.id).length > 0 && (
        <section className="journey-section">
          <h3 className="journey-section__title">{t.canvas.journey.timeline}</h3>
          {journey.edges
            .filter((edge) => edge.from_event_id === event.id)
            .map((edge) => (
              <div key={edge.id} className="journey-event__edge">
                {t.canvas.journey.edgeType[
                  edge.relationship_type as keyof typeof t.canvas.journey.edgeType
                ] ?? edge.relationship_type}{' '}
                →{' '}
                {journey.events.find((item) => item.id === edge.to_event_id)?.title ??
                  edge.to_event_id.slice(0, 8)}
              </div>
            ))}
        </section>
      )}

      {/* ── 跨记录连接（§5） ─────────────────────────────── */}
      <section className="journey-section">
        <h3 className="journey-section__title">{t.canvas.journey.linkToRecord}</h3>

        {!eventId ? (
          <p className="page-sub">{t.canvas.journey.selectEventFirst}</p>
        ) : (
          <>
            {visibleLinks.length === 0 ? (
              <p className="page-sub">{t.canvas.journey.linkEmpty}</p>
            ) : (
              <ul className="journey-notes">
                {visibleLinks.map((link) => {
                  const target = props.recordNodes.find((node) => node.recordID === link.record_id)
                  return (
                    <li key={link.id} className="journey-event__link">
                      {t.canvas.journey.linkType[
                        link.relationship_type as keyof typeof t.canvas.journey.linkType
                      ] ?? link.relationship_type}
                      {' · '}
                      {target?.recordTitle ?? link.record_id.slice(0, 8)}
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => void deleteLink(link.id)}
                      >
                        {t.canvas.journey.linkRemove}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            {props.recordNodes.length === 0 ? (
              <p className="page-sub">{t.canvas.journey.addRecordTarget}</p>
            ) : (
              <div className="journey-inline">
                <select
                  value={linkRecordId}
                  onChange={(event) => setLinkRecordId(event.target.value)}
                  aria-label={t.canvas.journey.linkPickRecord}
                >
                  <option value="">{t.canvas.journey.linkPickRecord}</option>
                  {props.recordNodes.map((node) => (
                    <option key={node.id} value={node.recordID}>
                      {node.recordTitle || node.recordID.slice(0, 8)}
                    </option>
                  ))}
                </select>
                <select
                  value={linkType}
                  onChange={(event) => setLinkType(event.target.value)}
                  aria-label={t.canvas.journey.linkToRecord}
                >
                  {(['references', 'supports', 'produces', 'validates', 'related_to'] as const).map(
                    (kind) => (
                      <option key={kind} value={kind}>
                        {t.canvas.journey.linkType[kind]}
                      </option>
                    )
                  )}
                </select>
                <button
                  type="button"
                  className="button"
                  disabled={!linkRecordId}
                  onClick={() => void createLink()}
                >
                  {t.canvas.journey.linkCreate}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── 用户笔记（§6）：与 Agent 原始事件分离 ─────────── */}
      <section className="journey-section">
        <h3 className="journey-section__title">{t.canvas.journey.noteLabel}</h3>
        <p className="page-sub">
          {eventId ? t.canvas.journey.noteEventLevel : t.canvas.journey.noteJourneyLevel}
        </p>

        {visibleNotes.length === 0 ? (
          <p className="page-sub">{t.canvas.journey.noteEmpty}</p>
        ) : (
          <ul className="journey-notes">
            {visibleNotes.map((note) => (
              <li key={note.id} className="journey-note">
                <p>{note.body}</p>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => void deleteNote(note.id)}
                >
                  {t.canvas.journey.noteDelete}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="journey-inline">
          <input
            placeholder={t.canvas.journey.notePlaceholder}
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
          />
          <button
            type="button"
            className="button"
            disabled={noteBusy || !noteDraft.trim()}
            onClick={() => void saveNote()}
          >
            {t.canvas.journey.noteSave}
          </button>
        </div>
      </section>

      {message && <p className="page-sub">{message}</p>}
      {error && <p className="error">{error}</p>}

      <div className="hairline" />
      <button type="button" className="button" onClick={props.onRemove}>
        {t.canvas.journey.removeFromCanvas}
      </button>
      <p className="page-sub">{t.canvas.journey.removeFromCanvasHint}</p>
    </div>
  )
}

/** 分组行的类型收窄辅助：`event_id` 为 null 才是分组行。 */
export function isGroupPlacement(placement: CanvasJourneyPlacement): boolean {
  return placement.event_id === null
}
