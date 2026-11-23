import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CanvasJourney, CanvasJourneyPlacement, CanvasNodeWithRecord } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { confirmAction } from '../../shared/ConfirmDialog'
import { EventGlyph, eventTypeAccent } from '../../shared/EventGlyph'
import { EventDetailSections } from '../../shared/EventDetailSections'
import { parseJourneyDetail } from '@shared/contracts'

/**
 * Journey Inspector 的内容体（R6-4.1 §4.4 / §5.2 / §6，R6-4.1.1 §8 精修）。
 *
 * 信息层级（自上而下，越靠上越稳定）：
 * 1. **Journey 头部**——标题、状态、计数、来源，始终可见；
 * 2. **Event 详情**——选中事件时才出现，标题与核心内容最突出，
 *    状态与时间是次级信息；
 * 3. **小节**——业务关系 / 跨记录关系 / 用户笔记，各自一致的标题样式、
 *    间距与分隔，空状态写人话；
 * 4. **危险操作**——「从画布移除」放在最底部、低干扰，且有确认保护。
 *
 * 数据隔离（§6.3）：这里所有写操作只碰 `agent_journey_notes` 与
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
  const journeyId = journey.placement.journey_id

  const [noteDraft, setNoteDraft] = useState('')
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)

  // 建立连接：目标记录必须已在画布上（§5.2.5 说必要时先加进画布）。
  const [linkRecordId, setLinkRecordId] = useState('')
  const [linkType, setLinkType] = useState('references')
  const [linkState, setLinkState] = useState<'idle' | 'busy' | 'done'>('idle')

  const event = useMemo(
    () => journey.events.find((item) => item.id === eventId) ?? null,
    [journey.events, eventId]
  )

  /** 结构化执行详情：拿不到就是 null（旧事件显示原始摘要，不放空卡片）。 */
  const structured = useMemo(
    () => parseJourneyDetail(event?.metadata ?? null),
    [event]
  )

  const [notes, setNotes] = useState<Array<{ id: string; event_id: string | null; body: string }>>(
    []
  )
  const [links, setLinks] = useState<
    Array<{ id: string; event_id: string; record_id: string; relationship_type: string }>
  >([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  const reload = useCallback(() => {
    api.agentJourneys
      .get(journeyId)
      .then((detail) => {
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
        setLoadedFor(journeyId)
      })
      .catch((cause: Error) => setError(cause.message))
  }, [journeyId])

  // 首次展开 / 换了 Journey 时取一次；写操作后由 reload() 手动再取。
  useEffect(() => {
    if (loadedFor === journeyId) return
    let alive = true
    api.agentJourneys
      .get(journeyId)
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
        setLoadedFor(journeyId)
      })
      .catch((cause: Error) => {
        if (alive) setError(cause.message)
      })
    return () => {
      alive = false
    }
  }, [loadedFor, journeyId])

  const visibleNotes = notes.filter((note) =>
    eventId ? note.event_id === eventId : note.event_id === null
  )
  const visibleLinks = eventId ? links.filter((link) => link.event_id === eventId) : []

  const saveNote = useCallback(async () => {
    const body = noteDraft.trim()
    if (!body || noteState === 'saving') return
    setNoteState('saving')
    setError(null)
    try {
      await api.agentJourneys.createNote(journeyId, body, eventId)
      setNoteDraft('')
      setNoteState('saved')
      reload()
      props.onChanged()
      window.setTimeout(() => setNoteState('idle'), 1800)
    } catch (cause) {
      setError((cause as Error).message)
      setNoteState('idle')
    }
  }, [noteDraft, noteState, eventId, journeyId, props, reload])

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
    if (!eventId || !linkRecordId || linkState === 'busy') return
    setLinkState('busy')
    setError(null)
    try {
      await api.agentJourneys.createLink({
        journeyId,
        eventId,
        recordId: linkRecordId,
        relationshipType: linkType as 'references'
      })
      setLinkState('done')
      setLinkRecordId('')
      reload()
      props.onChanged()
      window.setTimeout(() => setLinkState('idle'), 1800)
    } catch (cause) {
      setError((cause as Error).message)
      setLinkState('idle')
    }
  }, [eventId, linkRecordId, linkType, linkState, journeyId, props, reload])

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

  /** 从画布移除：只删摆位，但仍然是破坏性操作 → 要确认。 */
  const removeFromCanvas = useCallback(async () => {
    const confirmed = await confirmAction({
      title: t.canvas.journey.removeFromCanvas,
      description: t.canvas.journey.removeFromCanvasHint,
      confirmLabel: t.canvas.journey.removeFromCanvas,
      cancelLabel: t.common.cancel,
      tone: 'danger'
    })
    if (confirmed) props.onRemove()
  }, [t, props])

  const statusLabel =
    t.canvas.journey.status[journey.journey?.status as keyof typeof t.canvas.journey.status] ??
    journey.journey?.status ??
    ''

  const accent = event ? eventTypeAccent(event.event_type) : null

  return (
    <div className="journey-inspector">
      {/* ── 1. Journey 头部：稳定信息区 ─────────────────────── */}
      <div className="journey-inspector__head">
        <span className="journey-type-badge">
          <EventGlyph type="outcome" size={13} />
          {t.canvas.journey.detailTitle}
        </span>
        <h2 className="detail-title">{journey.journey?.title ?? ''}</h2>
        <div className="journey-meta-chips">
          <span className="journey-chip journey-chip--status" data-status={journey.journey?.status}>
            {statusLabel}
          </span>
          <span className="journey-chip">
            {t.canvas.journey.eventCount(journey.events.length)}
          </span>
          {journey.journey?.source_agent && (
            <span className="journey-chip">
              {t.canvas.journey.source(journey.journey.source_agent)}
            </span>
          )}
        </div>
        {journey.journey?.goal && <p className="note">{journey.journey.goal}</p>}
      </div>

      {/* ── 2. Event 详情：选中时出现，标题与核心内容最突出 ──── */}
      {event && (
        <section className="journey-inspector__section">
          <div className="journey-event__head">
            <span className="journey-event__seq">
              {t.canvas.journey.sequence(event.sequence)}
            </span>
            <span
              className="journey-event__glyph"
              style={{ color: `var(${accent ?? '--ink-faint'})` }}
            >
              <EventGlyph type={event.event_type} size={15} accent={accent ?? undefined} />
            </span>
            <span className="journey-event__type">
              {t.canvas.journey.eventType[
                event.event_type as keyof typeof t.canvas.journey.eventType
              ] ?? event.event_type}
            </span>
            <span className="journey-event__status" data-status={event.status}>
              {t.canvas.journey.eventStatus[
                event.status as keyof typeof t.canvas.journey.eventStatus
              ] ?? event.status}
            </span>
            <span className="journey-event__time">{formatDate(event.occurred_at)}</span>
          </div>

          <div className="journey-event__title">{event.title}</div>
          {event.summary && <div className="journey-event__summary">{event.summary}</div>}

          {event.content && (
            <div className="journey-event__detail">
              <span className="journey-event__detail-label">
                {t.canvas.journey.eventType.execution}
              </span>
              <p>{event.content}</p>
            </div>
          )}
          {event.reason && (
            <div className="journey-event__detail">
              <span className="journey-event__detail-label">
                {t.canvas.journey.eventType.decision}
              </span>
              <p>{event.reason}</p>
            </div>
          )}

          {/*
            * §9.2 分区详情：修改位置 / 决策依据 / 实际验证 / 证据来源……
            * 与 Records 详情共用同一份渲染实现，两处不会漂移。
            * 旧事件给一句明确说明，不放空卡片占位。
            */}
          {structured ? (
            <EventDetailSections
              detail={structured}
              evidenceLevel={event.evidence_level}
              metadata={event.metadata}
            />
          ) : (
            <p className="journey-inspector__hint" style={{ marginTop: 10 }}>
              {t.records.journey.detail.noDetail}
            </p>
          )}
        </section>
      )}

      {/* ── 3a. 业务关系 ────────────────────────────────────── */}
      <section className="journey-inspector__section">
        <h3 className="journey-inspector__title">{t.canvas.journey.timeline}</h3>
        {!event ? (
          <p className="journey-inspector__hint">{t.canvas.journey.selectEventFirst}</p>
        ) : journey.edges.filter((edge) => edge.from_event_id === event.id).length === 0 ? (
          <p className="journey-inspector__empty">{t.canvas.journey.edgeEmpty}</p>
        ) : (
          journey.edges
            .filter((edge) => edge.from_event_id === event.id)
            .map((edge) => (
              <div key={edge.id} className="journey-event__edge">
                {t.canvas.journey.edgeType[
                  edge.relationship_type as keyof typeof t.canvas.journey.edgeType
                ] ?? edge.relationship_type}{' '}
                →{' '}
                {journey.events.find((item) => item.id === edge.to_event_id)?.title ??
                  t.canvas.journey.eventMissing}
              </div>
            ))
        )}
      </section>

      {/* ── 3b. 跨记录关系 ──────────────────────────────────── */}
      <section className="journey-inspector__section">
        <h3 className="journey-inspector__title">{t.canvas.journey.linkToRecord}</h3>

        {!eventId ? (
          <p className="journey-inspector__hint">{t.canvas.journey.selectEventFirst}</p>
        ) : (
          <>
            {visibleLinks.length === 0 ? (
              <p className="journey-inspector__empty">{t.canvas.journey.linkEmpty}</p>
            ) : (
              <ul className="journey-notes">
                {visibleLinks.map((link) => {
                  const target = props.recordNodes.find((node) => node.recordID === link.record_id)
                  return (
                    <li key={link.id} className="journey-event__link">
                      <span className="journey-event__link-type">
                        {t.canvas.journey.linkType[
                          link.relationship_type as keyof typeof t.canvas.journey.linkType
                        ] ?? link.relationship_type}
                      </span>
                      <span className="journey-event__link-title">
                        {target?.recordTitle || t.records.journey.recordUnavailable}
                      </span>
                      <button
                        type="button"
                        className="button button--ghost journey-note__delete"
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
              <p className="journey-inspector__empty">{t.canvas.journey.addRecordTarget}</p>
            ) : (
              <div className="journey-inline">
                <select
                  value={linkRecordId}
                  onChange={(event2) => setLinkRecordId(event2.target.value)}
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
                  onChange={(event2) => setLinkType(event2.target.value)}
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
                  disabled={!linkRecordId || linkState === 'busy'}
                  onClick={() => void createLink()}
                >
                  {linkState === 'busy' ? t.records.journey.noteSaving : t.canvas.journey.linkCreate}
                </button>
              </div>
            )}
            {linkState === 'done' && (
              <p className="journey-inspector__hint" role="status">
                ✓ {t.canvas.journey.linkCreated}
              </p>
            )}
          </>
        )}
      </section>

      {/* ── 3c. 用户笔记：暖纸底，与 Agent 原始事件分离 ─────── */}
      <section className="journey-inspector__section">
        <h3 className="journey-inspector__title">{t.canvas.journey.noteLabel}</h3>
        <p className="journey-inspector__hint">
          {eventId ? t.canvas.journey.noteEventLevel : t.canvas.journey.noteJourneyLevel}
        </p>

        {visibleNotes.length === 0 ? (
          <p className="journey-inspector__empty">{t.canvas.journey.noteEmpty}</p>
        ) : (
          <ul className="journey-notes">
            {visibleNotes.map((note) => (
              <li key={note.id} className="journey-note">
                <p>{note.body}</p>
                <button
                  type="button"
                  className="button button--ghost journey-note__delete"
                  onClick={() => void deleteNote(note.id)}
                >
                  {t.canvas.journey.noteDelete}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="journey-note-editor">
          <textarea
            className="journey-note-editor__input"
            rows={2}
            placeholder={t.canvas.journey.notePlaceholder}
            value={noteDraft}
            onChange={(event2) => {
              setNoteDraft(event2.target.value)
              if (noteState === 'saved') setNoteState('idle')
            }}
            onKeyDown={(event2) => {
              if (event2.key === 'Enter' && (event2.metaKey || event2.ctrlKey)) {
                event2.preventDefault()
                void saveNote()
              }
            }}
          />
          <div className="journey-note-editor__actions">
            <button
              type="button"
              className="button"
              disabled={!noteDraft.trim() || noteState === 'saving'}
              onClick={() => void saveNote()}
            >
              {noteState === 'saving'
                ? t.records.journey.noteSaving
                : t.canvas.journey.noteSave}
            </button>
            {noteState === 'saved' && (
              <span className="journey-note-editor__feedback" role="status">
                ✓ {t.records.journey.noteSaved}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* ── 图例：三条连接不靠猜 ─────────────────────────────── */}
      <section className="journey-inspector__section">
        <h3 className="journey-inspector__title">{t.canvas.journey.legendTitle}</h3>
        <div className="journey-legend">
          <div className="journey-legend__row">
            <span className="journey-legend__swatch journey-legend__swatch--sequence" />
            {t.canvas.journey.legendSequence}
          </div>
          <div className="journey-legend__row">
            <span className="journey-legend__swatch journey-legend__swatch--edge" />
            {t.canvas.journey.legendEdge}
          </div>
          <div className="journey-legend__row">
            <span className="journey-legend__swatch journey-legend__swatch--record" />
            {t.canvas.journey.legendRecord}
          </div>
        </div>
      </section>

      {error && <p className="error">{error}</p>}

      {/* ── 4. 危险操作：最低干扰 + 确认保护 ─────────────────── */}
      <div className="journey-inspector__danger">
        <button type="button" className="button" onClick={() => void removeFromCanvas()}>
          {t.canvas.journey.removeFromCanvas}
        </button>
        <p className="journey-inspector__danger-hint">{t.canvas.journey.removeFromCanvasHint}</p>
      </div>
    </div>
  )
}

/** 分组行的类型收窄辅助：`event_id` 为 null 才是分组行。 */
export function isGroupPlacement(placement: CanvasJourneyPlacement): boolean {
  return placement.event_id === null
}
