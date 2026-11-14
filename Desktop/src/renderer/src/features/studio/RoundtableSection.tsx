import { useEffect, useMemo, useRef, useState } from 'react'
import {
  isRoundtableAITaskBusy,
  type AIRoundtableParticipantStatus,
  type AIRoundtableTaskSnapshot,
  type BrowserTabInfo
} from '@shared/contracts'
import { cardBadgeText, cardDisplayName } from '@shared/web-cards'
import { useI18n } from '../../i18n'
import { api } from '../../shared/api'
import { useBrowserStore } from '../browser/browser-store'
import { useBrowserPreviewStore } from '../browser/preview-store'
import { Markdown } from '../ai-workspace/markdown'
import { useRoundtableAIStore } from './roundtable-ai-store'
import { useRoundtableStore } from './roundtable-store'
import { WEB_CARD_MIME } from './WebCardShelf'

/**
 * AI 圆桌（Phase 3 框架 + Phase 4.2 真实 WebCard 问答）。
 *
 * 两副形态、**主进程一份状态**：
 * - **停靠**：占满内容宽度；标题栏是 OS 拖拽源——拖出 BrewPhase 窗口外
 *   松手，主进程创建真正的独立 BrowserWindow（`#bpRoundtable` 路由）。
 * - **独立窗口**：主窗口只剩轻量占位区（人数 + 任务状态 + 重新打开 + 归位）。
 *
 * Phase 4.2 的核心变化：**不再有固定的 ChatGPT / Claude 选择器**。
 * 圆桌成员就是用户拖进来的真实 WebCard（tabId 是身份）：
 * - 平台身份由主进程 Registry 对实时 URL 识别，渲染层无从伪造；
 * - 支持自动问答的 AI 网页默认参与本轮讨论，普通网页继续作为资料；
 * - 用户移除某个成员即可把它排除出本轮；
 * - 自动化使用原始 WebContents——不创建隐藏副本，登录就在卡片里完成。
 */

export function RoundtableSection() {
  const detached = useRoundtableStore((state) => state.snapshot.detached)
  if (detached) return <RoundtableSlot />
  return <DockedRoundtable />
}

/* ============================================================
 * 停靠形态：标题栏拖出 = 独立窗口；「独立窗口」按钮同效。
 * ============================================================ */

function DockedRoundtable() {
  const { t } = useI18n()
  const tabs = useBrowserStore((state) => state.state.tabs)
  const participantTabIds = useRoundtableStore((state) => state.snapshot.participantTabIds)
  const detachRoundtable = useRoundtableStore((state) => state.detachRoundtable)
  const setDraggingRoundtable = useRoundtableStore((state) => state.setDraggingRoundtable)
  const dragOutside = useRoundtableStore((state) => state.dragOutside)
  const [dragArmed, setDragArmed] = useState(false)

  const participants = participantTabIds
    .map((tabId) => tabs.find((tab) => tab.id === tabId))
    .filter((tab): tab is BrowserTabInfo => Boolean(tab))

  /** OS 拖拽源：整块圆桌跟着系统拖影走，窗口外松手由主进程拆窗。 */
  const onHeadDragStart = (event: React.DragEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('button, input, a, select, textarea')) {
      event.preventDefault()
      return
    }
    event.dataTransfer.setData(ROUNDTABLE_MIME, '1')
    event.dataTransfer.effectAllowed = 'move'
    const source = event.currentTarget.closest('.roundtable') ?? event.currentTarget
    const rect = source.getBoundingClientRect()
    event.dataTransfer.setDragImage(source, Math.max(12, event.clientX - rect.left), Math.max(10, event.clientY - rect.top))
    setDragArmed(true)
    setDraggingRoundtable(true)
    void api.roundtable.dragBegin().catch(() => undefined)
  }

  const onHeadDragEnd = (event: React.DragEvent<HTMLElement>): void => {
    setDragArmed(false)
    setDraggingRoundtable(false)
    void api.roundtable.dragEnd({ screenX: event.screenX, screenY: event.screenY }).catch(() => undefined)
  }

  return (
    <div className="roundtable">
      <header
        className="roundtable__head"
        draggable
        onDragStart={onHeadDragStart}
        onDragEnd={onHeadDragEnd}
        data-armed={dragArmed}
        title={t.studio.roundtable.dragHint}
      >
        <span className="roundtable__grip" aria-hidden="true">
          ⠿
        </span>
        <h2 className="roundtable__title">{t.studio.roundtable.title}</h2>
        {participants.length > 0 && (
          <span className="roundtable__count">{t.studio.roundtable.count(participants.length)}</span>
        )}
        {dragArmed && (
          <span className="roundtable__detach-hint" data-outside={dragOutside} role="status">
            {dragOutside ? t.studio.roundtable.detachHint : t.studio.roundtable.dragHint}
          </span>
        )}
        <button
          type="button"
          className="roundtable__undock"
          aria-label={t.studio.roundtable.undock}
          title={t.studio.roundtable.undock}
          onClick={() => void detachRoundtable()}
        >
          <span aria-hidden="true">↗</span>
          <span>{t.studio.roundtable.undockAction}</span>
        </button>
      </header>
      <RoundtableBody participants={participants} />
    </div>
  )
}

/* ============================================================
 * 独立窗口占位：轻量状态区 + 拖回归位热区。
 * 任务状态在这里给一行摘要——独立窗口提问时主窗口同样看得到进度。
 * ============================================================ */

/** 圆桌拖拽的数据类型；主窗口占位区用它识别「来的是整个圆桌」。 */
export const ROUNDTABLE_MIME = 'application/x-brewphase-roundtable'

function RoundtableSlot() {
  const { t } = useI18n()
  const tabs = useBrowserStore((state) => state.state.tabs)
  const participantTabIds = useRoundtableStore((state) => state.snapshot.participantTabIds)
  const focusRoundtable = useRoundtableStore((state) => state.focusRoundtable)
  const dockRoundtable = useRoundtableStore((state) => state.dockRoundtable)
  const task = useRoundtableAIStore((state) => state.task)
  const [dropActive, setDropActive] = useState(false)

  const busy = isRoundtableAITaskBusy(task)
  const done = task !== null && !busy

  return (
    <div
      className="roundtable roundtable--slot"
      data-drop-active={dropActive}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(ROUNDTABLE_MIME)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropActive(true)
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(ROUNDTABLE_MIME)) return
        event.preventDefault()
        setDropActive(false)
        void api.roundtable.dragDropHandled().catch(() => undefined)
        void dockRoundtable()
      }}
    >
      <p className="roundtable__slot-hint">{t.studio.roundtable.slotHint}</p>
      {participantTabIds.length > 0 && (
        <p className="roundtable__slot-count">{t.studio.roundtable.count(participantTabIds.length)}</p>
      )}
      {busy && (
        <p className="roundtable__slot-status" data-busy="true" role="status">
          {t.studio.roundtable.slotBusy}
        </p>
      )}
      {done && (
        <p className="roundtable__slot-status" role="status">
          {t.studio.roundtable.slotDone}
        </p>
      )}
      <div className="roundtable__slot-actions">
        <button type="button" className="roundtable__slot-btn" onClick={() => void focusRoundtable()}>
          {t.studio.roundtable.reopen}
        </button>
        <button type="button" className="roundtable__slot-btn roundtable__slot-btn--dock" onClick={() => void dockRoundtable()}>
          {t.studio.roundtable.dockAction}
        </button>
      </div>
      {participantTabIds.length > 0 && (
        <p className="roundtable__slot-names">
          {participantTabIds
            .map((tabId) => tabs.find((tab) => tab.id === tabId))
            .filter((tab): tab is BrowserTabInfo => Boolean(tab))
            .map((tab) => cardDisplayName(tab, t.studio.webShelf.unnamed))
            .join(' · ')}
        </p>
      )}
    </div>
  )
}

/* ============================================================
 * 圆桌正文（停靠与独立窗口共用）：
 *   圆桌成员（真实 WebCard） → 提问行 → 本轮回答。
 * ============================================================ */

export function RoundtableBody(props: { participants: BrowserTabInfo[] }) {
  const { t } = useI18n()
  const snapshot = useRoundtableStore((state) => state.snapshot)
  const setDraft = useRoundtableStore((state) => state.setDraft)
  const leaveRoundtable = useRoundtableStore((state) => state.leaveRoundtable)
  const joinRoundtable = useRoundtableStore((state) => state.joinRoundtable)
  const task = useRoundtableAIStore((state) => state.task)
  const members = useRoundtableAIStore((state) => state.members)
  const membersLoading = useRoundtableAIStore((state) => state.membersLoading)
  const aiError = useRoundtableAIStore((state) => state.error)
  const refreshMembers = useRoundtableAIStore((state) => state.refreshMembers)
  const askTask = useRoundtableAIStore((state) => state.ask)
  const stopTask = useRoundtableAIStore((state) => state.stop)
  const [dropActive, setDropActive] = useState(false)
  const unnamed = t.studio.webShelf.unnamed

  const busy = isRoundtableAITaskBusy(task)
  // 「可参与」= 已识别 + 已适配 + 已登录（主进程会在提交时再做一次同样的筛选）。
  const capableCount = props.participants.filter((tab) => {
    const member = members[tab.id]
    return member?.adapted && member.login === 'logged_in'
  }).length
  const canAsk = capableCount > 0 && snapshot.draft.trim() !== '' && !busy

  // 成员识别是拉取式：成员增减、页面导航（URL 变化）时重新识别。
  const memberSignature = props.participants.map((tab) => `${tab.id}:${tab.url}`).join('|')
  useEffect(() => {
    const tabIds = memberSignature.split('|').map((item) => item.split(':')[0]).filter(Boolean)
    void refreshMembers(tabIds)
  }, [memberSignature, refreshMembers])

  function submit(event: React.FormEvent): void {
    event.preventDefault()
    if (!canAsk) return
    void askTask()
  }

  return (
    <>
      <div
        className="roundtable__stage"
        data-drop-active={dropActive}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(WEB_CARD_MIME)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropActive(true)
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(WEB_CARD_MIME)) return
          event.preventDefault()
          setDropActive(false)
          const tabId = event.dataTransfer.getData(WEB_CARD_MIME)
          if (!tabId) return
          void api.browserDrag.dropHandled(tabId).catch(() => undefined)
          void joinRoundtable(tabId)
        }}
      >
        <header className="roundtable__members-head">
          <span className="roundtable__members-title">{t.studio.roundtable.membersTitle}</span>
          <button
            type="button"
            className="roundtable__recheck"
            onClick={() => void refreshMembers(snapshot.participantTabIds)}
            title={t.studio.roundtable.recheck}
          >
            {t.studio.roundtable.recheck}
          </button>
        </header>
        {props.participants.length === 0 ? (
          <div className="roundtable__empty">
            <p className="roundtable__empty-title">{t.studio.roundtable.emptyTitle}</p>
            <p className="roundtable__empty-hint">{t.studio.roundtable.emptyHint}</p>
            <div className="roundtable__seats" aria-hidden="true">
              <span className="roundtable__seat" />
              <span className="roundtable__seat" />
            </div>
          </div>
        ) : (
          <div className="roundtable__participants" role="list">
            {props.participants.map((tab) => (
              <article className="roundtable__participant" role="listitem" key={tab.id} data-tab-id={tab.id}>
                <ParticipantThumb tabId={tab.id} />
                <span className="roundtable__participant-body">
                  <span className="roundtable__participant-name">{cardDisplayName(tab, unnamed)}</span>
                  <MemberStatusLine tab={tab} member={members[tab.id]} loading={membersLoading} />
                </span>
                <button
                  type="button"
                  className="roundtable__remove"
                  aria-label={t.studio.roundtable.remove(cardDisplayName(tab, unnamed))}
                  onClick={() => void leaveRoundtable(tab.id)}
                >
                  {t.studio.roundtable.removeAction}
                </button>
              </article>
            ))}
          </div>
        )}
      </div>

      <footer className="roundtable__ask">
        <form className="roundtable__ask-form" onSubmit={submit}>
          <input
            className="roundtable__ask-input"
            placeholder={
              props.participants.length === 0
                ? t.studio.roundtable.askPlaceholderNoAI
                : t.studio.roundtable.askPlaceholder
            }
            aria-label={t.studio.roundtable.askLabel}
            value={snapshot.draft}
            maxLength={2_000}
            onChange={(event) => void setDraft(event.target.value)}
          />
          {busy ? (
            <button type="button" className="roundtable__ask-submit roundtable__ask-submit--stop" onClick={() => void stopTask()}>
              {t.studio.roundtable.askStop}
            </button>
          ) : (
            <button type="submit" className="roundtable__ask-submit" disabled={!canAsk}>
              {t.studio.roundtable.askStart}
            </button>
          )}
        </form>
        <div className="roundtable__ask-meta" role="status">
          {busy ? (
            <span className="roundtable__ask-busy">{t.studio.roundtable.askBusyHint}</span>
          ) : capableCount > 0 ? (
            <span>{t.studio.roundtable.capableCount(capableCount)}</span>
          ) : (
            <span className="roundtable__ask-warning">{t.studio.roundtable.noCapableHint}</span>
          )}
          {aiError && <span className="roundtable__ask-warning">{aiError}</span>}
        </div>
      </footer>

      <RoundtableAnswers task={task} />
    </>
  )
}

/* ============================================================
 * 成员状态行：按主进程识别结果显示能力与登录态。
 * AI 成员任务中的实时状态来自任务广播，优先于静态识别结果。
 * ============================================================ */

function MemberStatusLine(props: {
  tab: BrowserTabInfo
  member?: AIRoundtableParticipantStatus
  loading: boolean
}) {
  const { t } = useI18n()
  const task = useRoundtableAIStore((state) => state.task)
  const busy = isRoundtableAITaskBusy(task)
  const live = task?.results.find((item) => item.tabId === props.tab.id)
  const liveState = Boolean(busy && live && !['completed', 'failed', 'timeout', 'cancelled', 'login_required', 'unsupported_page', 'page_unavailable'].includes(live.state))

  let label = t.studio.roundtable.memberDetecting
  let dataState = 'detecting'
  if (liveState && live) {
    label = t.aiWorkspace.taskState[live.state as keyof typeof t.aiWorkspace.taskState]
    dataState = live.state
  } else if (!props.member) {
    if (!props.loading) {
      label = t.studio.roundtable.memberUnavailable
      dataState = 'unavailable'
    }
  } else if (props.member.login === 'unavailable') {
    label = t.studio.roundtable.memberUnavailable
    dataState = 'unavailable'
  } else if (props.member.platformId === null) {
    label = t.studio.roundtable.memberReference
    dataState = 'reference'
  } else if (!props.member.adapted) {
    label = t.studio.roundtable.memberNotAdapted(props.member.platformName ?? props.member.platformId ?? '')
    dataState = 'not-adapted'
  } else if (props.member.login === 'logged_in') {
    label = t.studio.roundtable.memberReady(props.member.platformName ?? props.member.platformId ?? '')
    dataState = 'ready'
  } else if (props.member.login === 'logged_out') {
    label = t.studio.roundtable.memberLoginRequired(props.member.platformName ?? props.member.platformId ?? '')
    dataState = 'login-required'
  } else {
    label = t.studio.roundtable.memberUnknown(props.member.platformName ?? props.member.platformId ?? '')
    dataState = 'unknown'
  }

  return (
    <span className="roundtable__member-state" data-state={dataState}>
      {label}
      {dataState === 'login-required' && (
        <button
          type="button"
          className="roundtable__member-login"
          onClick={() => void api.browserTabs.activate(props.tab.id)}
        >
          {t.studio.roundtable.memberLoginAction}
        </button>
      )}
    </span>
  )
}

/* ============================================================
 * 本轮回答：每个参与者一张卡（tabId 区分，同平台多卡互不混淆）。
 * 复用 Markdown 组件；复制与查看原网页都只作用于单张卡。
 * ============================================================ */

function RoundtableAnswers(props: { task: AIRoundtableTaskSnapshot | null }) {
  const { t } = useI18n()
  const tabs = useBrowserStore((state) => state.state.tabs)
  const [copied, setCopied] = useState<string | null>(null)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])

  const results = useMemo(() => props.task?.results ?? [], [props.task])

  if (!props.task || results.length === 0) return null

  function copyAnswer(tabId: string, content: string): void {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(tabId)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(null), 1_600)
    })
  }

  return (
    <section className="roundtable__answers" aria-label={t.studio.roundtable.answersTitle}>
      <header className="roundtable__answers-head">
        <span className="roundtable__answers-title">{t.studio.roundtable.answersTitle}</span>
        <span className="roundtable__answers-prompt">{props.task.prompt}</span>
      </header>
      <div className="roundtable__answers-grid">
        {results.map((result) => {
          const state = result.state
          const showAnswer = state === 'completed' && result.content.length > 0
          const showFailure =
            state !== 'idle' && state !== 'completed' && state !== 'generating' && state !== 'checking' && state !== 'sending'
          const sourceTab = tabs.find((tab) => tab.id === result.tabId)
          const cardTitle = sourceTab ? cardDisplayName(sourceTab, t.studio.webShelf.unnamed) : result.title
          return (
            <article key={result.tabId} className="roundtable__answer" data-state={state}>
              <header className="roundtable__answer-head">
                <span className="roundtable__answer-name">{result.displayName}</span>
                <span className="roundtable__answer-title">{cardTitle}</span>
                <span className="roundtable__answer-state" data-state={state}>
                  {t.aiWorkspace.taskState[state as keyof typeof t.aiWorkspace.taskState]}
                </span>
              </header>
              <div className="roundtable__answer-body">
                {showAnswer ? (
                  <Markdown source={result.content} />
                ) : showFailure ? (
                  <p className="roundtable__answer-note">
                    {t.aiWorkspace.result.notePrefix} {result.note || t.aiWorkspace.result.noContent}
                  </p>
                ) : state === 'generating' ? (
                  <p className="roundtable__answer-note" aria-busy="true">…</p>
                ) : (
                  <p className="roundtable__answer-note roundtable__answer-note--empty">{t.aiWorkspace.ask.emptyHint}</p>
                )}
              </div>
              {showAnswer && (
                <footer className="roundtable__answer-foot">
                  {/* 打开原网页 = 定位回答所属的那张原始卡片（tabId），
                      绝不重新创建一张平台页面。 */}
                  <button
                    type="button"
                    className="roundtable__answer-action"
                    onClick={() => void api.browserTabs.activate(result.tabId)}
                  >
                    {t.aiWorkspace.result.viewSource}
                  </button>
                  <button type="button" className="roundtable__answer-action" onClick={() => copyAnswer(result.tabId, result.content)}>
                    {copied === result.tabId ? t.aiWorkspace.result.copied : t.aiWorkspace.result.copy}
                  </button>
                  <span className="roundtable__answer-tabid" title={result.url}>
                    {result.tabId}
                  </span>
                </footer>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

/* ============================================================
 * 参与者身份：优先用同一份缩略图（不复制、不额外采集），
 * 没有预览时退回首字母徽章。
 * ============================================================ */

function ParticipantThumb(props: { tabId: string }) {
  const { t } = useI18n()
  const preview = useBrowserPreviewStore((state) => state.previews[props.tabId])
  const tab = useBrowserStore((state) => state.state.tabs.find((item) => item.id === props.tabId))
  if (preview) {
    return <img className="roundtable__participant-thumb" src={preview.dataUrl} alt="" draggable={false} referrerPolicy="no-referrer" />
  }
  return (
    <span className="roundtable__participant-badge" aria-hidden="true">
      {tab ? cardBadgeText(tab, t.studio.webShelf.unnamed) : '·'}
    </span>
  )
}
