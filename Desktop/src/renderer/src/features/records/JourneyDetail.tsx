import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Canvas, JourneyDetail as Detail, JourneyNote, JourneyRecordLink } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { EventGlyph, eventTypeAccent } from '../../shared/EventGlyph'

/**
 * Agent Journey 的**完整详情**（R6-4.1 §3.2，R6-4.1.1 §7 精修）。
 *
 * 一条 Journey 在 Records 中始终是一条完整记录：原始目标 → 全部事件
 * （按 `sequence` 升序）→ 事件间业务关系 → 最终结果 → 用户补充的笔记。
 * **不把 Journey 拆成一堆互相独立的普通 Record。**
 *
 * 三处精修：
 * - **§7.3 关联记录**：显示真实标题，解析不到就给明确的不可用态，
 *   **绝不把 UUID 片段当记录名**；
 * - **§7.4 笔记编辑**：显式输入区 + 保存按钮 + 保存中/成功反馈，
 *   不再是「只能按 Enter」的隐形操作；
 * - **§7.2 时间线**：序号 / 类型字形 / 标题 / 摘要 / 状态 Chip 分层，
 *   决策依据与执行内容只在数据存在时出现，不塞原始 JSON。
 */
export function JourneyDetailView(props: {
  detail: Detail
  onChanged: () => void
  onClose: () => void
}) {
  const { t, formatDate } = useI18n()
  const { detail } = props
  const { journey, events, edges, notes, links } = detail

  const [canvases, setCanvases] = useState<Canvas[]>([])
  const [pickedCanvas, setPickedCanvas] = useState('')
  const [canvasMessage, setCanvasMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** 关联记录的真实标题：`links` 只有 record_id，必须回查 Records。 */
  const [recordInfo, setRecordInfo] = useState<
    Map<string, { title: string; carrier: string } | null>
  >(new Map())

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

  const linkRecordIds = useMemo(
    () => [...new Set(links.map((link) => link.record_id))],
    [links]
  )

  useEffect(() => {
    if (linkRecordIds.length === 0) return
    let alive = true
    Promise.all(
      linkRecordIds.map((id) =>
        api.records
          .get(id)
          .then((record) => [id, record ? { title: record.title, carrier: record.carrier } : null] as const)
          .catch(() => [id, null] as const)
      )
    ).then((entries) => {
      if (alive) setRecordInfo(new Map(entries))
    })
    return () => {
      alive = false
    }
  }, [linkRecordIds])

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

  const linkTitle = useCallback(
    (recordId: string) => {
      const info = recordInfo.get(recordId)
      if (info === undefined) return null // 还在回查
      if (info === null) return { unavailable: true, text: t.records.journey.recordUnavailable }
      return { unavailable: false, text: info.title || t.records.untitled }
    },
    [recordInfo, t]
  )

  return (
    <div className="journey-detail">
      {/* ── §7.1 Header：先让人明白「这是一条完整的 Agent 执行记录」 ── */}
      <div className="row row--between">
        <span className="journey-type-badge">
          <EventGlyph type="outcome" size={13} />
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

      <div className="journey-meta-chips">
        <span className="journey-chip journey-chip--status" data-status={journey.status}>
          {statusLabel}
        </span>
        <span className="journey-chip">{t.records.journey.events(journey.event_count)}</span>
        {journey.link_count > 0 && (
          <span className="journey-chip">{t.records.journey.links(journey.link_count)}</span>
        )}
        {journey.note_count > 0 && (
          <span className="journey-chip">{t.records.journey.notes(journey.note_count)}</span>
        )}
      </div>

      <div className="detail-meta">
        <span>{formatDate(journey.created_at)}</span>
        {journey.source_agent && (
          <span>{t.records.journey.source(journey.source_agent)}</span>
        )}
        {journey.model && <span className="detail-meta__muted">{journey.model}</span>}
      </div>

      {journey.goal && (
        <section className="journey-section">
          <h3 className="journey-section__title">{t.records.journey.goal}</h3>
          <p className="note">{journey.goal}</p>
        </section>
      )}

      {/* ── §4.2 的 Records 侧入口：添加到画布 ───────────────── */}
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
        {canvasMessage && <p className="page-sub journey-inline__feedback">{canvasMessage}</p>}
      </section>

      {/* ── §7.2 执行时间线 ─────────────────────────────────── */}
      <section className="journey-section">
        <h3 className="journey-section__title">{t.records.journey.timeline}</h3>
        <ol className="journey-timeline">
          {events.map((event) => {
            const statusKey2 = event.status as keyof typeof t.records.journey.eventStatus
            const eventLinks = linksByEvent.get(event.id) ?? []
            const eventNotes = notesByEvent.get(event.id) ?? []
            const accent = eventTypeAccent(event.event_type)
            const typeLabel =
              t.records.journey.eventType[
                event.event_type as keyof typeof t.records.journey.eventType
              ] ?? event.event_type
            return (
              <li key={event.id} className="journey-event" data-event-type={event.event_type}>
                <div className="journey-event__head">
                  <span className="journey-event__seq">
                    {t.records.journey.sequence(event.sequence)}
                  </span>
                  <span className="journey-event__glyph" style={{ color: `var(${accent})` }}>
                    <EventGlyph type={event.event_type} size={15} accent={accent} />
                  </span>
                  <span className="journey-event__type">{typeLabel}</span>
                  <span className="journey-event__status" data-status={event.status}>
                    {t.records.journey.eventStatus[statusKey2] ?? event.status}
                  </span>
                  <span className="journey-event__time">{formatDate(event.occurred_at)}</span>
                </div>

                <div className="journey-event__title">{event.title}</div>
                {event.summary && <div className="journey-event__summary">{event.summary}</div>}

                {/* 决策依据 / 执行内容：数据存在才出现，且标明是哪一类 */}
                {event.reason && (
                  <div className="journey-event__detail">
                    <span className="journey-event__detail-label">
                      {t.records.journey.eventType.decision}
                    </span>
                    <p>{event.reason}</p>
                  </div>
                )}
                {event.content && (
                  <div className="journey-event__detail">
                    <span className="journey-event__detail-label">
                      {t.records.journey.eventType.execution}
                    </span>
                    <p>{event.content}</p>
                  </div>
                )}

                {/* 业务关系：来自 agent_journey_edges，不是时间线 */}
                {edges
                  .filter((edge) => edge.from_event_id === event.id)
                  .map((edge) => (
                    <div key={edge.id} className="journey-event__edge">
                      {t.records.journey.edgeLabel(edge.relationship_type)} →{' '}
                      {events.find((item) => item.id === edge.to_event_id)?.title ??
                        t.records.journey.eventMissing}
                    </div>
                  ))}

                {/* 跨记录关系：显示真实记录名 */}
                {eventLinks.map((link) => {
                  const info = linkTitle(link.record_id)
                  return (
                    <div
                      key={link.id}
                      className={`journey-event__link${info?.unavailable ? ' is-unavailable' : ''}`}
                    >
                      <span className="journey-event__link-type">
                        {t.records.journey.linkType[
                          link.relationship_type as keyof typeof t.records.journey.linkType
                        ] ?? link.relationship_type}
                      </span>
                      <span className="journey-event__link-title">
                        {info ? info.text : t.records.journey.recordResolving}
                      </span>
                    </div>
                  )
                })}

                {/* Event 级笔记：与 Agent 原始事件视觉分离（暖纸底） */}
                {eventNotes.map((note) => (
                  <div key={note.id} className="journey-note">
                    <span className="journey-note__label">{t.records.journey.noteEventLevel}</span>
                    <p>{note.body}</p>
                    <button
                      type="button"
                      className="button button--ghost journey-note__delete"
                      onClick={() => void deleteNote(note.id)}
                    >
                      {t.records.journey.noteDelete}
                    </button>
                  </div>
                ))}

                <NoteEditor
                  placeholder={t.records.journey.notePlaceholder}
                  saveLabel={t.records.journey.noteSave}
                  savingLabel={t.records.journey.noteSaving}
                  savedLabel={t.records.journey.noteSaved}
                  onSave={(body) =>
                    api.agentJourneys.createNote(journey.id, body, event.id).then(() => {
                      props.onChanged()
                    })
                  }
                />
              </li>
            )
          })}
        </ol>
      </section>

      {/* ── §7.4 Journey 级笔记 ─────────────────────────────── */}
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
                  className="button button--ghost journey-note__delete"
                  onClick={() => void deleteNote(note.id)}
                >
                  {t.records.journey.noteDelete}
                </button>
              </li>
            ))}
          </ul>
        )}
        <NoteEditor
          placeholder={t.records.journey.notePlaceholder}
          saveLabel={t.records.journey.noteSave}
          savingLabel={t.records.journey.noteSaving}
          savedLabel={t.records.journey.noteSaved}
          onSave={(body) =>
            api.agentJourneys.createNote(journey.id, body, null).then(() => {
              props.onChanged()
            })
          }
        />
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  )
}

/**
 * 笔记编辑区（§7.4）：显式输入 + 显式保存 + 保存中/成功反馈。
 *
 * 之前只有 input + Enter——保存是否成功全靠猜。空内容时按钮禁用，
 * 保存成功后清空并给一次可见反馈，失败时错误由上层统一展示。
 */
function NoteEditor(props: {
  placeholder: string
  saveLabel: string
  savingLabel: string
  savedLabel: string
  onSave: (body: string) => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')

  const save = useCallback(async () => {
    const body = value.trim()
    if (!body || state === 'saving') return
    setState('saving')
    try {
      await props.onSave(body)
      setValue('')
      setState('saved')
      window.setTimeout(() => setState('idle'), 1800)
    } catch {
      setState('idle')
    }
  }, [value, state, props])

  return (
    <div className="journey-note-editor">
      <textarea
        className="journey-note-editor__input"
        rows={2}
        placeholder={props.placeholder}
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          if (state === 'saved') setState('idle')
        }}
        onKeyDown={(event) => {
          // Ctrl/Cmd+Enter 才提交：Enter 留给换行，避免半句话发出去
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void save()
          }
        }}
      />
      <div className="journey-note-editor__actions">
        <button
          type="button"
          className="button"
          disabled={!value.trim() || state === 'saving'}
          onClick={() => void save()}
        >
          {state === 'saving' ? props.savingLabel : props.saveLabel}
        </button>
        {state === 'saved' && (
          <span className="journey-note-editor__feedback" role="status">
            ✓ {props.savedLabel}
          </span>
        )}
      </div>
    </div>
  )
}
