import { useEffect, useMemo, useRef, useState } from 'react'
import {
  isAIChatTaskBusy,
  type AIChatTaskSnapshot,
  type AIPlatformStatus,
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
 * AI 圆桌（Phase 3 + 4.1）：Studio Home 底部第二层。
 *
 * 两副形态、**主进程一份状态**：
 * - **停靠**：占满内容宽度；标题栏是 OS 拖拽源——拖出 BrewPhase 窗口外
 *   松手，主进程创建真正的独立 BrowserWindow（`#bpRoundtable` 路由）。
 *   「独立窗口」按钮同效（键盘 / 触控板可达）。
 * - **独立窗口**：主窗口只剩一个轻量占位区（人数 + 任务状态 + 重新打开
 *   + 归位），不再是 Phase 2 的 `position: fixed` 应用内浮层。
 *
 * 拖入接应（卡片 → 参与者）：卡片架的卡片是 OS 拖拽源；圆桌热区在
 * `dragover` 时识别 `WEB_CARD_MIME` 并高亮，`drop` 时把 tabId 交给主进程
 * join（主进程校验标签真实存在）。内部投放会通知拖拽会话 dropHandled，
 * 主进程不会把这张卡拆成窗口。
 *
 * Phase 4.1 的 AI 问答（平台选择 → 并行提问 → 回答区）直接内嵌在圆桌正文里：
 * **AI 平台参与者与网页资料参与者是两套状态**——平台选择是渲染层本地 UI
 * 状态（默认全选），绝不写入 participantTabIds；没有网页资料也能直接提问。
 * 任务状态来自主进程广播（roundtable-ai-store），两个窗口看到同一份。
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
    // 拖影 = 整块停靠圆桌（像把整张桌子端起来），而不是只有标题条。
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
 * 独立窗口占位：轻量状态区，不出现大块空白（规格 §5/§8）。
 * 同时是拖回归位的热区：圆桌窗口的标题栏拖到这里松手 = 归位。
 * Phase 4.1：任务状态也在这里给一行摘要——独立窗口提问时，
 * 主窗口同样能看到进度（§4.1.5 的双窗口同步）。
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

  const busy = isAIChatTaskBusy(task)
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
        // 内部投放：会话按 dropHandled 收尾；随后显式归位。
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
 *   参与区（网页资料） → AI 平台选择 → 提问行 → 本轮回答。
 * ============================================================ */

export function RoundtableBody(props: { participants: BrowserTabInfo[] }) {
  const { t } = useI18n()
  const snapshot = useRoundtableStore((state) => state.snapshot)
  const setDraft = useRoundtableStore((state) => state.setDraft)
  const leaveRoundtable = useRoundtableStore((state) => state.leaveRoundtable)
  const joinRoundtable = useRoundtableStore((state) => state.joinRoundtable)
  const task = useRoundtableAIStore((state) => state.task)
  const askTask = useRoundtableAIStore((state) => state.ask)
  const stopTask = useRoundtableAIStore((state) => state.stop)
  const [dropActive, setDropActive] = useState(false)
  // 平台选择是本轮的 UI 状态（默认全选）——独立于网页资料参与者。
  const [selected, setSelected] = useState<Set<'chatgpt' | 'claude'>>(new Set(['chatgpt', 'claude']))
  const unnamed = t.studio.webShelf.unnamed

  const busy = isAIChatTaskBusy(task)
  const canAsk = selected.size > 0 && snapshot.draft.trim() !== '' && !busy

  function toggle(provider: 'chatgpt' | 'claude'): void {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault()
    if (!canAsk) return
    void askTask([...selected])
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
          // 内部投放（加入圆桌）：先标记会话，再建参与关系——两步都是
          // 主进程收口，顺序保证 dropHandled 先于 dragend 到达。
          void api.browserDrag.dropHandled(tabId).catch(() => undefined)
          void joinRoundtable(tabId)
        }}
      >
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
              <article className="roundtable__participant" role="listitem" key={tab.id}>
                <ParticipantThumb tabId={tab.id} />
                <span className="roundtable__participant-body">
                  <span className="roundtable__participant-name">{cardDisplayName(tab, unnamed)}</span>
                  <span className="roundtable__participant-state">{t.studio.roundtable.joined}</span>
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

      {/* AI 平台参与者：与网页资料无关，没有卡片也能直接提问。 */}
      <RoundtablePlatforms selected={selected} onToggle={toggle} />

      <footer className="roundtable__ask">
        <form
          className="roundtable__ask-form"
          onSubmit={submit}
        >
          <input
            className="roundtable__ask-input"
            placeholder={
              selected.size === 0
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
          {selected.size === 0 ? (
            <span className="roundtable__ask-warning">{t.studio.roundtable.noneSelected}</span>
          ) : (
            <span>{t.studio.roundtable.selectedCount(selected.size)}</span>
          )}
          {busy && <span className="roundtable__ask-busy">{t.studio.roundtable.askBusyHint}</span>}
        </div>
      </footer>

      <RoundtableAnswers task={task} />
    </>
  )
}

/* ============================================================
 * AI 平台选择：名称 + 登录状态 + 本轮选中 + 任务状态。
 * 未登录 / 未打开的入口是「去登录」：用现有可见浏览器打开平台首页，
 * 登录态经共享 session（persist:brewphase-browser）回到后台代理页。
 * ============================================================ */

function RoundtablePlatforms(props: {
  selected: Set<'chatgpt' | 'claude'>
  onToggle: (provider: 'chatgpt' | 'claude') => void
}) {
  const { t } = useI18n()
  const statuses = useRoundtableAIStore((state) => state.statuses)
  const task = useRoundtableAIStore((state) => state.task)
  const refreshStatuses = useRoundtableAIStore((state) => state.refreshStatuses)
  const busy = isAIChatTaskBusy(task)

  const statusOf = (provider: 'chatgpt' | 'claude'): AIPlatformStatus | null =>
    statuses?.find((item) => item.provider === provider) ?? null

  return (
    <section className="roundtable__platforms" aria-label={t.studio.roundtable.platformsTitle}>
      <header className="roundtable__platforms-head">
        <span className="roundtable__platforms-title">{t.studio.roundtable.platformsTitle}</span>
        <button
          type="button"
          className="roundtable__recheck"
          onClick={() => void refreshStatuses()}
          title={t.studio.roundtable.recheck}
        >
          {t.studio.roundtable.recheck}
        </button>
      </header>
      <div className="roundtable__platform-row" role="group">
        {(['chatgpt', 'claude'] as const).map((provider) => {
          const status = statusOf(provider)
          const result = task?.results.find((item) => item.provider === provider)
          // 忙碌时展示实时任务状态；空闲时展示登录状态。
          const stateLabel = busy && result
            ? t.aiWorkspace.taskState[result.state as keyof typeof t.aiWorkspace.taskState]
            : !status || !status.pageAlive
              ? t.aiWorkspace.login.not_open
              : t.aiWorkspace.login[status.login]
          const needsLogin = !busy && (!status || !status.pageAlive || status.login === 'logged_out')
          return (
            <button
              key={provider}
              type="button"
              className="roundtable__platform"
              data-selected={props.selected.has(provider)}
              aria-pressed={props.selected.has(provider)}
              onClick={() => props.onToggle(provider)}
            >
              <span className="roundtable__platform-main">
                <span className="roundtable__platform-name">{t.aiWorkspace.providers[provider]}</span>
                <span className="roundtable__platform-state" data-state={busy && result ? result.state : status?.login ?? 'not_open'}>
                  {stateLabel}
                </span>
              </span>
              <span className="roundtable__platform-pick" aria-hidden="true">
                {props.selected.has(provider) ? '✓' : ''}
              </span>
            </button>
          )
        })}
      </div>
      {(['chatgpt', 'claude'] as const).some((provider) => {
        const status = statusOf(provider)
        return !busy && (!status || !status.pageAlive || status.login === 'logged_out')
      }) && (
        <div className="roundtable__login-row">
          {(['chatgpt', 'claude'] as const).map((provider) => {
            const status = statusOf(provider)
            if (status?.pageAlive && status.login !== 'logged_out') return null
            return (
              <button
                key={provider}
                type="button"
                className="roundtable__login-link"
                onClick={() => {
                  void api.aiChat.viewURL(provider).then((url) => {
                    if (url) void api.browser.open({ url })
                  })
                }}
              >
                {t.studio.roundtable.goLogin(t.aiWorkspace.providers[provider])}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

/* ============================================================
 * 本轮回答：每个平台一张卡，先完成先显示，互不覆盖。
 * 复用 Markdown 组件；复制与查看原网页都只作用于单张卡。
 * ============================================================ */

function RoundtableAnswers(props: { task: AIChatTaskSnapshot | null }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState<string | null>(null)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])

  const providers = useMemo(() => props.task?.results.map((item) => item.provider) ?? [], [props.task])
  const results = useMemo(() => {
    const byProvider = new Map(props.task?.results.map((item) => [item.provider, item]) ?? [])
    return providers.map((provider) => byProvider.get(provider)!).filter(Boolean)
  }, [props.task, providers])

  if (!props.task) return null

  function copyAnswer(provider: string, content: string): void {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(provider)
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
          return (
            <article key={result.provider} className="roundtable__answer" data-state={state}>
              <header className="roundtable__answer-head">
                <span className="roundtable__answer-name">{t.aiWorkspace.providers[result.provider as 'chatgpt' | 'claude']}</span>
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
                  <button
                    type="button"
                    className="roundtable__answer-action"
                    onClick={() => {
                      void api.aiChat.viewURL(result.provider as 'chatgpt' | 'claude').then((url) => {
                        if (url) void api.browser.open({ url })
                      })
                    }}
                  >
                    {t.aiWorkspace.result.viewSource}
                  </button>
                  <button type="button" className="roundtable__answer-action" onClick={() => copyAnswer(result.provider, result.content)}>
                    {copied === result.provider ? t.aiWorkspace.result.copied : t.aiWorkspace.result.copy}
                  </button>
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
