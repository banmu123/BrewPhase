import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Canvas,
  JourneyDetail as Detail,
  JourneyNote,
  JourneyRecordLink
} from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { EventGlyph, eventTypeAccent } from '../../shared/EventGlyph'
import { EventDetailSections } from '../../shared/EventDetailSections'
import { parseJourneyDetail } from '@shared/contracts'
import {
  INITIAL_WORKSPACE_LIST_STATE,
  journeyWorkspaceView,
  workspaceListFailure,
  workspaceListStart,
  workspaceListSuccess,
  type JourneyWorkspaceListState
} from './journey-workspace-view'
import {
  createJourneyEvidenceLoader,
  journeyEvidenceViews,
  INITIAL_EVIDENCE_LOAD_STATE,
  type EvidenceFileRowView,
  type EventEvidenceView,
  type JourneyEvidenceLoadState
} from './journey-evidence-view'

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

  /** 展开的事件：§9.3 要求「按需展开」，不把全部详情压进一条长 timeline。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [canvases, setCanvases] = useState<Canvas[]>([])
  const [pickedCanvas, setPickedCanvas] = useState('')
  const [canvasMessage, setCanvasMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** 关联记录的真实标题：`links` 只有 record_id，必须回查 Records。 */
  const [recordInfo, setRecordInfo] = useState<
    Map<string, { title: string; carrier: string } | null>
  >(new Map())

  /**
   * R6-4.3.1.1：已登记工作区的**读取状态**（loading / loaded / failed）。
   *
   * 不能用空数组同时代表「还没加载」「加载失败」和「确实没登记」——
   * 状态机与序号守卫在 `journey-workspace-view.ts`（纯函数，可单测）。
   * 只用于下拉与显示名，主进程才是权限。
   */
  const [listState, setListState] = useState<JourneyWorkspaceListState>(
    INITIAL_WORKSPACE_LIST_STATE
  )
  /** 已发出的最新请求序号；卸载或新请求都会推进它，在途旧结果一律作废。 */
  const listSeqRef = useRef(0)
  const [pickedWorkspace, setPickedWorkspace] = useState('')
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null)
  /**
   * 绑定成功后主进程返回的新卡片。父级 detail 只在**切换选中**时才重新
   * 拉取，所以这里用返回值覆盖展示，让关联状态立即更新；父级下次拉到
   * 一致的数据后由下面的 effect 清掉覆盖。
   */
  const [workspaceOverride, setWorkspaceOverride] = useState<string | null | undefined>(undefined)

  const loadWorkspaces = useCallback((initial: boolean) => {
    const seq = ++listSeqRef.current
    setListState((prev) => workspaceListStart(prev, seq, initial))
    void api.localWorkspace.list().then(
      (items) => setListState((prev) => workspaceListSuccess(prev, seq, items)),
      // 失败明确进 failed，**绝不**吞掉异常当成空列表。
      () => setListState((prev) => workspaceListFailure(prev, seq))
    )
  }, [])

  /** 读取失败后的重试入口（规格 §三）：重新调用 `api.localWorkspace.list()`。 */
  const retryWorkspaceList = useCallback(() => loadWorkspaces(true), [loadWorkspaces])

  useEffect(() => {
    loadWorkspaces(true)
    // 工作区登记在别处增删时同步（与 CardWorkspaceToolbar 同一事件）；
    // 后台刷新不回退到 loading，保持当前状态只换数据。
    const off = api.app.onChanged((domain) => {
      if (domain === 'localWorkspaces') loadWorkspaces(false)
    })
    return () => {
      // 卸载：推进序号让在途结果全部失效（IPC 无法中止，但结果不再写回）。
      listSeqRef.current += 1
      off()
    }
  }, [loadWorkspaces])

  /**
   * R6-P5.1：Evidence 读取（loading / loaded / failed 三态，绝不拿空数组顶替）
   * 与竞态守卫都在 `journey-evidence-view.ts`（纯函数，可单测）：
   * - 打开 / 切换 Journey → 立即取数（切换时旧数据先清空）；
   * - `agentJourneys` 领域更新（MCP 写事件 / 笔记 / 证据落库）→ 后台刷新；
   * - 卸载 / 切换 → 序号推进 + dispose，在途结果一律作废。
   */
  const [evidenceState, setEvidenceState] = useState<JourneyEvidenceLoadState>(
    INITIAL_EVIDENCE_LOAD_STATE
  )
  const evidenceLoaderRef = useRef<ReturnType<typeof createJourneyEvidenceLoader> | null>(null)
  useEffect(() => {
    const loader = createJourneyEvidenceLoader({
      fetchEvidence: (id) => api.agentJourneys.evidence(id),
      onChange: setEvidenceState
    })
    evidenceLoaderRef.current = loader
    loader.open(journey.id)
    const off = api.app.onChanged((domain) => {
      if (domain === 'agentJourneys') loader.refresh()
    })
    return () => {
      off()
      loader.dispose()
      evidenceLoaderRef.current = null
    }
  }, [journey.id])
  const retryEvidence = useCallback(() => evidenceLoaderRef.current?.retry(), [])

  // 换了一条 Journey（或父级已拉到最新数据）时清掉本地覆盖。
  useEffect(() => {
    setWorkspaceOverride(undefined)
  }, [journey.id, journey.workspace_id])

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

  const toggleExpanded = useCallback((eventId: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(eventId)) next.delete(eventId)
      else next.add(eventId)
      return next
    })
  }, [])

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

  // MARK: R6-4.3.1 工作区关联（绑定 / 换绑 / 解绑）

  const bindPicked = useCallback(async () => {
    if (!pickedWorkspace) return
    setWorkspaceMessage(null)
    setError(null)
    try {
      const updated = await api.agentJourneys.bindWorkspace(journey.id, pickedWorkspace)
      setWorkspaceOverride(updated.workspace_id)
      // 绑定按钮只在列表 loaded 时可点，这里一定能拿到名字。
      const name =
        listState.status === 'loaded'
          ? (listState.workspaces.find((workspace) => workspace.id === pickedWorkspace)?.name ?? '')
          : ''
      setWorkspaceMessage(t.records.journey.workspaceBindDone(name))
      props.onChanged()
    } catch (cause) {
      // 主进程的拒绝原因（不存在 / 不可用 / 执行已开始）原样呈现。
      setWorkspaceMessage(t.records.journey.workspaceBindFailed((cause as Error).message))
    }
  }, [pickedWorkspace, journey.id, listState, t, props])

  const unlinkWorkspace = useCallback(async () => {
    setWorkspaceMessage(null)
    setError(null)
    try {
      const updated = await api.agentJourneys.bindWorkspace(journey.id, null)
      setWorkspaceOverride(updated.workspace_id)
      setWorkspaceMessage(t.records.journey.workspaceUnbindDone)
      props.onChanged()
    } catch (cause) {
      setWorkspaceMessage(t.records.journey.workspaceUnbindFailed((cause as Error).message))
    }
  }, [journey.id, t, props])

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

  /**
   * 每个事件的 Evidence 视图（P5.1 §五）：只在 `loaded` 时产出——
   * loading / failed 由区域层分别呈现，事件不会被误标成「没有证据」。
   * 分类 / 置信度 / 历史兼容全部来自 `buildEvidenceComparison()` 纯函数。
   */
  const evidenceViews = useMemo(
    () => journeyEvidenceViews(evidenceState, detail),
    [evidenceState, detail]
  )

  /** R6-4.3.1：关联状态 + 能否修改的纯函数判定（规则单测覆盖）。 */
  const workspaceView = journeyWorkspaceView({
    journey: {
      status: journey.status,
      workspace_id: workspaceOverride !== undefined ? workspaceOverride : journey.workspace_id
    },
    events,
    list: listState
  })

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

      {/* ── R6-4.3.1 工作区关联：授权范围的显式管理 ───────────
          只显示已登记工作区的**名字**，不展示机器绝对路径；
          执行已开始 / Journey 终态时锁定（服务端也会再拒一次）。
          R6-4.3.1.1：加载中 / 加载失败是**独立状态**——既不显示「已删除」，
          也不把接口异常吞成空列表；列表没加载出来前不渲染绑定操作。 */}
      <section className="journey-section">
        <h3 className="journey-section__title">{t.records.journey.workspaceTitle}</h3>
        <p className="note">
          {workspaceView.state === 'loading' && t.records.journey.workspaceLoading}
          {workspaceView.state === 'load_failed' && t.records.journey.workspaceLoadFailed}
          {workspaceView.state === 'none' && t.records.journey.workspaceNone}
          {workspaceView.state === 'linked' &&
            t.records.journey.workspaceLinked(workspaceView.label ?? '')}
          {workspaceView.state === 'unavailable' &&
            t.records.journey.workspaceUnavailable(workspaceView.label ?? '')}
          {workspaceView.state === 'deleted' && t.records.journey.workspaceDeleted}
        </p>

        {workspaceView.state === 'load_failed' && (
          <div className="journey-inline">
            <button
              type="button"
              className="button"
              onClick={() => retryWorkspaceList()}
            >
              {t.records.journey.workspaceRetry}
            </button>
          </div>
        )}

        {/* 锁定提示只在「本该出现绑定操作」的时机出现——列表没加载出来时
            控件缺席的原因是读取状态，不是生命周期。 */}
        {!workspaceView.canManage && workspaceView.listLoaded && (
          <p className="page-sub journey-inline__feedback">
            {workspaceView.lockedReason === 'journey_finished'
              ? t.records.journey.workspaceLockedFinished
              : t.records.journey.workspaceLockedStarted}
          </p>
        )}

        {workspaceView.canManage && workspaceView.listLoaded ? (
          <div className="journey-inline">
            <select
              value={pickedWorkspace}
              onChange={(event) => setPickedWorkspace(event.target.value)}
              aria-label={t.records.journey.workspacePick}
            >
              <option value="">{t.records.journey.workspacePick}</option>
              {workspaceView.options.map((option) => (
                <option key={option.id} value={option.id} disabled={option.disabled}>
                  {option.name}
                  {option.available ? '' : t.records.journey.workspaceOptionUnavailable}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button"
              disabled={!pickedWorkspace}
              onClick={() => void bindPicked()}
            >
              {workspaceView.workspaceId
                ? t.records.journey.workspaceRebind
                : t.records.journey.workspaceBind}
            </button>
            {workspaceView.workspaceId && (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void unlinkWorkspace()}
              >
                {t.records.journey.workspaceUnbind}
              </button>
            )}
          </div>
        ) : null}

        {workspaceView.canManage &&
          workspaceView.listLoaded &&
          workspaceView.options.length === 0 && (
            <p className="page-sub">{t.records.journey.workspaceNoRegistered}</p>
          )}
        {workspaceMessage && (
          <p className="page-sub journey-inline__feedback">{workspaceMessage}</p>
        )}
      </section>

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
        {/* Evidence 读取状态独立呈现：查询失败 ≠ 没有证据（P5.1 §五.5） */}
        {evidenceState.status === 'loading' && (
          <p className="page-sub" role="status">
            {t.records.journey.evidence.loading}
          </p>
        )}
        {evidenceState.status === 'failed' && (
          <div className="journey-inline">
            <p className="page-sub journey-inline__feedback">
              {t.records.journey.evidence.loadFailed}
            </p>
            <button type="button" className="button" onClick={retryEvidence}>
              {t.records.journey.evidence.retry}
            </button>
          </div>
        )}
        <ol className="journey-timeline">
          {events.map((event) => {
            const statusKey2 = event.status as keyof typeof t.records.journey.eventStatus
            // 结构化详情：拿不到（旧事件 / 结构脏）就是 null，
            // 这时只显示原始摘要与正文，**不放空卡片占位**（§9.2 / 场景 E）。
            const structured = parseJourneyDetail(event.metadata)
            const isExpanded = expanded.has(event.id)
            const fileCount = structured?.changes?.length ?? 0
            const checkCount = structured?.verification?.length ?? 0
            const eventLinks = linksByEvent.get(event.id) ?? []
            const eventNotes = notesByEvent.get(event.id) ?? []
            const accent = eventTypeAccent(event.event_type)
            const typeLabel =
              t.records.journey.eventType[
                event.event_type as keyof typeof t.records.journey.eventType
              ] ?? event.event_type
            const evidenceView = evidenceViews?.get(event.id) ?? null
            const hasEvidenceFiles = Boolean(evidenceView && evidenceView.fileRows.length > 0)
            // 有结构化详情**或**有证据文件对照才给展开开关（按需展开不回退）。
            const canExpand = Boolean(structured) || hasEvidenceFiles
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

                {/* P5.1 §五：有 Evidence 报告的执行事件 → 紧凑摘要（文件对照按需展开） */}
                {evidenceView && <JourneyEvidenceSummary view={evidenceView} expanded={isExpanded} />}

                {/*
                  * §9.3「按需展开」：有结构化详情才给开关（否则展开也无内容）；
                  * 旧事件给一句明确说明，而不是一个空的占位卡片。
                  */}
                <div className="journey-event__detailbar">
                  {canExpand ? (
                    <>
                      <span className="journey-event__counts">
                        {structured && fileCount > 0 && t.records.journey.changesCount(fileCount)}
                        {structured && fileCount > 0 && checkCount > 0 && ' · '}
                        {structured && checkCount > 0 && t.records.journey.verifyCount(checkCount)}
                        {!structured && hasEvidenceFiles && (
                          <>
                            {t.records.journey.evidence.filesCount(
                              evidenceView?.fileRows.length ?? 0
                            )}
                          </>
                        )}
                      </span>
                      <button
                        type="button"
                        className="button button--ghost journey-event__toggle"
                        aria-expanded={isExpanded}
                        onClick={() => toggleExpanded(event.id)}
                      >
                        {isExpanded
                          ? t.records.journey.detail.collapse
                          : t.records.journey.detail.expand}
                      </button>
                    </>
                  ) : (
                    <span className="journey-event__nodetail">
                      {t.records.journey.detail.noDetail}
                    </span>
                  )}
                </div>

                {isExpanded && structured && (
                  <EventDetailSections
                    detail={structured}
                    evidenceLevel={event.evidence_level}
                    metadata={event.metadata}
                  />
                )}

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
 * 单个执行事件的 Evidence 摘要（P5.1 §五.1/5.4）：
 * 置信度与计数常驻（紧凑一行），文件级对照只在事件展开后出现。
 * **不渲染任何 Diff 正文**（按需读取属 P5.2）。
 */
function JourneyEvidenceSummary(props: { view: EventEvidenceView; expanded: boolean }) {
  const { t } = useI18n()
  const { view } = props
  const evidenceT = t.records.journey.evidence
  const confKey = view.confidence as keyof typeof evidenceT.confidence
  const counts = view.counts
  return (
    <div className="journey-event__evidence" data-confidence={view.confidence}>
      <div className="journey-evidence__line">
        <span className="journey-evidence__confidence">
          {evidenceT.confidence[confKey] ?? view.confidence}
        </span>
        <span className="journey-evidence__counts">
          {evidenceT.countsLine(
            counts.reported,
            counts.observed,
            counts.matched,
            counts.reportedOnly,
            counts.observedOnly
          )}
        </span>
      </div>
      {/*
        * §五.4：空态必须区分窗口完整性——完整窗口才允许说「未发现变化」；
        * 窗口不完整绝不给确定性结论。
        */}
      {view.emptyKind !== 'none' && (
        <p className="journey-evidence__empty">
          {view.emptyKind === 'complete' ? evidenceT.emptyComplete : evidenceT.emptyIncomplete}
        </p>
      )}
      {props.expanded && view.fileRows.length > 0 && (
        <ul className="journey-evidence__files">
          {view.fileRows.map((row) => (
            <EvidenceFileRow key={row.key} row={row} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 文件级对照行（P5.1 §五.2）：Agent Reported 与 Workspace Observed
 * **分块、带来源标签**，绝不合并成无法判断来源的一段描述。
 * reported_only 保留「不代表报告不真实」的既有解释（§五.3）。
 */
function EvidenceFileRow(props: { row: EvidenceFileRowView }) {
  const { t } = useI18n()
  const evidenceT = t.records.journey.evidence
  const { row } = props
  const attrKey = row.attribution as keyof typeof evidenceT.attribution
  const reportedTypeKey = row.reported?.changeType as
    | keyof typeof t.records.journey.detail.changeType
    | undefined
  const changeKindKey = row.observed?.changeKind as
    | keyof typeof evidenceT.changeKind
    | undefined
  const artifactKindKey = row.observed?.artifactKind as
    | keyof typeof evidenceT.artifactKind
    | undefined
  const artifactOmissionKey = row.observed?.artifactOmission as
    | keyof typeof evidenceT.artifactOmission
    | undefined
  // 历史行（observation_status = null）如实标注「未保存观察状态」，不伪造。
  const observationLabel =
    row.observed?.observationStatus === null || row.observed?.observationStatus === undefined
      ? evidenceT.observation.legacy
      : evidenceT.observation[row.observed.observationStatus]
  return (
    <li className="journey-evidence-file" data-attribution={row.attribution}>
      <div className="journey-evidence-file__head">
        <code className="journey-evidence-file__path">{row.path}</code>
        <span className="journey-evidence-file__attribution">
          {evidenceT.attribution[attrKey] ?? row.attribution}
        </span>
      </div>
      {row.reported && (
        <div className="journey-evidence-file__side journey-evidence-file__side--agent">
          <span className="journey-evidence-file__side-label">{evidenceT.agentReported}</span>
          <span className="journey-evidence-file__side-body">
            {reportedTypeKey
              ? t.records.journey.detail.changeType[reportedTypeKey]
              : row.reported.changeType}
            {' · '}
            {row.reported.changeSummary}
            {row.reported.previousPath && ` · ${evidenceT.renameFrom(row.reported.previousPath)}`}
          </span>
        </div>
      )}
      {row.observed && (
        <div className="journey-evidence-file__side journey-evidence-file__side--workspace">
          <span className="journey-evidence-file__side-label">{evidenceT.workspaceObserved}</span>
          <span className="journey-evidence-file__side-body">
            {changeKindKey ? evidenceT.changeKind[changeKindKey] : row.observed.changeKind}
            {row.observed.insertions !== null &&
              row.observed.deletions !== null &&
              ` · ${evidenceT.diffStat(row.observed.insertions, row.observed.deletions)}`}
            {row.observed.renameFrom && ` · ${evidenceT.renameFrom(row.observed.renameFrom)}`}
            {' · '}
            {observationLabel}
            {row.observed.artifactKind &&
              ` · ${
                artifactKindKey
                  ? evidenceT.artifactKind[artifactKindKey]
                  : row.observed.artifactKind
              }${
                row.observed.artifactOmission && artifactOmissionKey
                  ? `（${evidenceT.artifactOmission[artifactOmissionKey]}）`
                  : ''
              }`}
          </span>
        </div>
      )}
      {row.attribution === 'reported_only' && (
        <p className="journey-evidence-file__hint">{evidenceT.reportedOnlyHint}</p>
      )}
    </li>
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
