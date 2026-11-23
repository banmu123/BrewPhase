import { useCallback, useEffect, useState } from 'react'
import type { Canvas, JourneyDetail as Detail, JourneyNote, JourneyRecordLink } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'

/**
 * Agent Journey 的**完整详情**（R6-4.1 §3.2）。
 *
 * 一条 Journey 在 Records 中始终是一条完整记录：原始目标 → 全部事件
 * （按 `sequence` 升序）→ 事件间业务关系 → 最终结果 → 用户补充的笔记。
 * **不把 Journey 拆成一堆互相独立的普通 Record。**
 *
 * 数据全部来自 `api.agentJourneys.get()`（真实 SQLite 查询，不是前端拼的）。
 * 笔记走独立表 `agent_journey_notes`——编辑/删除绝不触碰 Agent 原始事件。
 */
export function JourneyDetailView(props: {
  detail: Detail
  onChanged: () => void
  onClose: () => void
}) {
  const { t, formatDate } = useI18n()
  const { detail } = props
  const { journey, events, edges, notes, links } = detail

  const [noteDraft, setNoteDraft] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  const [canvases, setCanvases] = useState<Canvas[]>([])
  const [pickedCanvas, setPickedCanvas] = useState('')
  const [canvasMessage, setCanvasMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 「添加到画布」需要画布清单：只读，打开详情时取一次。
  useEffect(() => {
    let alive = true
    api.canvas
      .list()
      .then((items) => {
        if (alive) setCanvases(items)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const statusKey = journey.status as keyof typeof t.records.journey.status
  const statusLabel = t.records.journey.status[statusKey] ?? journey.status

  const journeyNotes = notes.filter((note) => note.event_id === null)
  const notesByEvent = new Map<string, JourneyNote[]>()
  for (const note of notes) {
    if (!note.event_id) continue
    const list = notesByEvent.get(note.event_id) ?? []
    list.push(note)
    notesByEvent.set(note.event_id, list)
  }
  const linksByEvent = new Map<string, JourneyRecordLink[]>()
  for (const link of links) {
    const list = linksByEvent.get(link.event_id) ?? []
    list.push(link)
    linksByEvent.set(link.event_id, list)
  }

  const eventTypeLabel = useCallback(
    (type: string) => {
      const key = type as keyof typeof t.records.journey.eventType
      return t.records.journey.eventType[key] ?? type
    },
    [t]
  )

  const saveNote = useCallback(
    async (body: string, eventId?: string | null) => {
      const trimmed = body.trim()
      if (!trimmed) return
      setNoteBusy(true)
      setError(null)
      try {
        await api.agentJourneys.createNote(journey.id, trimmed, eventId ?? null)
        setNoteDraft('')
        props.onChanged()
      } catch (cause) {
        setError((cause as Error).message)
      } finally {
        setNoteBusy(false)
      }
    },
    [journey.id, props]
  )

  const deleteNote = useCallback(
    async (id: string) => {
      setError(null)
      try {
        await api.agentJourneys.removeNote(id)
        props.onChanged()
      } catch (cause) {
        setError((cause as Error).message)
      }
    },
    [props]
  )

  const addToCanvas = useCallback(async () => {
    if (!pickedCanvas) return
    setCanvasMessage(null)
    setError(null)
    try {
      await api.canvas.addJourney(pickedCanvas, journey.id)
      const target = canvases.find((item) => item.id === pickedCanvas)
      setCanvasMessage(t.records.journey.addToCanvasDone(target?.name ?? ''))
    } catch (cause) {
      setCanvasMessage(t.records.journey.addToCanvasFailed((cause as Error).message))
    }
  }, [pickedCanvas, journey.id, canvases, t])

  return (
    <div className="journey-detail">
      <div className="row row--between">
        <span className="overline" style={{ margin: 0 }}>
          {t.records.journey.typeLabel}
        </span>
        <button
          type="button"
          className="button button--ghost"
          aria-label={t.records.detail.close}
          onClick={props.onClose}
        >
          ✕
        </button>
      </div>

      <h2 className="detail-title">{journey.title || t.records.untitled}</h2>

      <div className="detail-meta">
        <span className="journey-status" data-status={journey.status}>
          {statusLabel}
        </span>
        <span>{formatDate(journey.created_at)}</span>
        {journey.source_agent && <span>{journey.source_agent}</span>}
        <span>{t.records.journey.events(journey.event_count)}</span>
        {journey.link_count > 0 && <span>{t.records.journey.links(journey.link_count)}</span>}
        {journey.note_count > 0 && <span>{t.records.journey.notes(journey.note_count)}</span>}
      </div>

      {journey.goal && (
        <section className="journey-section">
          <h3 className="journey-section__title">{t.records.journey.goal}</h3>
          <p className="note">{journey.goal}</p>
        </section>
      )}

      {/* ── 添加到画布（§4.2 的 Records 侧入口） ───────────────── */}
      <section className="journey-section">
        <h3 className="journey-section__title">{t.records.journey.addToCanvas}</h3>
        <div className="journey-inline">
          <select
            value={pickedCanvas}
            onChange={(event) => setPickedCanvas(event.target.value)}
            aria-label={t.records.journey.addToCanvasPick}
          >
            <option value="">{t.records.journey.addToCanvasPick}</option>
            {canvases.map((canvas) => (
              <option key={canvas.id} value={canvas.id}>
                {canvas.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button"
            disabled={!pickedCanvas}
            onClick={() => void addToCanvas()}
          >
            {t.records.journey.addToCanvas}
          </button>
        </div>
        {canvasMessage && <p className="page-sub">{canvasMessage}</p>}
      </section>

      {/* ── 执行过程：全部事件按 sequence 升序 ─────────────────── */}
      <section className="journey-section">
        <h3 className="journey-section__title">{t.records.journey.timeline}</h3>
        <ol className="journey-timeline">
          {events.map((event) => {
            const typeKey = event.event_type as keyof typeof t.records.journey.eventType
            const statusKey = event.status as keyof typeof t.records.journey.eventStatus
            const eventLinks = linksByEvent.get(event.id) ?? []
            const eventNotes = notesByEvent.get(event.id) ?? []
            return (
              <li key={event.id} className="journey-event" data-event-type={event.event_type}>
                <div className="journey-event__head">
                  <span className="journey-event__seq">
                    {t.records.journey.sequence(event.sequence)}
                  </span>
                  <span className="journey-event__type">{eventTypeLabel(event.event_type)}</span>
                  <span className="journey-event__status" data-status={event.status}>
                    {t.records.journey.eventStatus[statusKey] ?? event.status}
                  </span>
                </div>
                <div className="journey-event__title">{event.title}</div>
                {event.summary && <div className="journey-event__summary">{event.summary}</div>}

                {/* 业务关系：来自 agent_journey_edges，不是时间线 */}
                {edges
                  .filter((edge) => edge.from_event_id === event.id)
                  .map((edge) => (
                    <div key={edge.id} className="journey-event__edge">
                      {t.records.journey.edgeLabel(edge.relationship_type)} →{' '}
                      {events.find((item) => item.id === edge.to_event_id)?.title ??
                        edge.to_event_id.slice(0, 8)}
                    </div>
                  ))}

                {eventLinks.map((link) => (
                  <div key={link.id} className="journey-event__link">
                    {t.records.journey.linkType[
                      link.relationship_type as keyof typeof t.records.journey.linkType
                    ] ?? link.relationship_type}
                    {' · '}
                    {link.record_id.slice(0, 8)}
                  </div>
                ))}

                {eventNotes.map((note) => (
                  <div key={note.id} className="journey-event__note">
                    <span className="journey-note__label">{t.records.journey.notesTitle}</span>
                    <p>{note.body}</p>
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => void deleteNote(note.id)}
                    >
                      {t.records.journey.noteDelete}
                    </button>
                  </div>
                ))}

                <div className="journey-event__addnote">
                  <input
                    placeholder={t.records.journey.notePlaceholder}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      const value = (event.target as HTMLInputElement).value
                      void saveNote(value, event.currentTarget.dataset.eventId)
                    }}
                    data-event-id={event.id}
                  />
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      {/* ── Journey 级笔记 ─────────────────────────────────────── */}
      <section className="journey-section">
        <h3 className="journey-section__title">{t.records.journey.notesTitle}</h3>
        {journeyNotes.length === 0 ? (
          <p className="page-sub">{t.records.journey.noteEmpty}</p>
        ) : (
          <ul className="journey-notes">
            {journeyNotes.map((note) => (
              <li key={note.id} className="journey-note">
                <p>{note.body}</p>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => void deleteNote(note.id)}
                >
                  {t.records.journey.noteDelete}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="journey-inline">
          <input
            placeholder={t.records.journey.notePlaceholder}
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
          />
          <button
            type="button"
            className="button"
            disabled={noteBusy || !noteDraft.trim()}
            onClick={() => void saveNote(noteDraft)}
          >
            {t.records.journey.noteSave}
          </button>
        </div>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  )
}
