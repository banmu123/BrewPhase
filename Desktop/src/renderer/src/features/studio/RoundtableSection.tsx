import { useState } from 'react'
import type { BrowserTabInfo } from '@shared/contracts'
import { cardBadgeText, cardDisplayName } from '@shared/web-cards'
import { useI18n } from '../../i18n'
import { api } from '../../shared/api'
import { useBrowserStore } from '../browser/browser-store'
import { useBrowserPreviewStore } from '../browser/preview-store'
import { useRoundtableStore } from './roundtable-store'
import { WEB_CARD_MIME } from './WebCardShelf'

/**
 * AI 圆桌（Phase 3）：Studio Home 底部第二层。
 *
 * 两副形态、**主进程一份状态**：
 * - **停靠**：占满内容宽度；标题栏是 OS 拖拽源——拖出 BrewPhase 窗口外
 *   松手，主进程创建真正的独立 BrowserWindow（`#bpRoundtable` 路由）。
 *   「独立窗口」按钮同效（键盘 / 触控板可达）。
 * - **独立窗口**：主窗口只剩一个轻量占位区（人数 + 重新打开 + 归位），
 *   不再是 Phase 2 的 `position: fixed` 应用内浮层——那不是真正的多窗口。
 *
 * 拖入接应（卡片 → 参与者）：卡片架的卡片是 OS 拖拽源；圆桌热区在
 * `dragover` 时识别 `WEB_CARD_MIME` 并高亮，`drop` 时把 tabId 交给主进程
 * join（主进程校验标签真实存在）。内部投放会通知拖拽会话 dropHandled，
 * 主进程不会把这张卡拆成窗口。
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
 * ============================================================ */

/** 圆桌拖拽的数据类型；主窗口占位区用它识别「来的是整个圆桌」。 */
export const ROUNDTABLE_MIME = 'application/x-brewphase-roundtable'

function RoundtableSlot() {
  const { t } = useI18n()
  const tabs = useBrowserStore((state) => state.state.tabs)
  const participantTabIds = useRoundtableStore((state) => state.snapshot.participantTabIds)
  const focusRoundtable = useRoundtableStore((state) => state.focusRoundtable)
  const dockRoundtable = useRoundtableStore((state) => state.dockRoundtable)
  const [dropActive, setDropActive] = useState(false)

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
 * 圆桌正文（停靠与独立窗口共用）：参与区 + 统一提问输入。
 * ============================================================ */

export function RoundtableBody(props: { participants: BrowserTabInfo[] }) {
  const { t } = useI18n()
  const snapshot = useRoundtableStore((state) => state.snapshot)
  const setDraft = useRoundtableStore((state) => state.setDraft)
  const leaveRoundtable = useRoundtableStore((state) => state.leaveRoundtable)
  const joinRoundtable = useRoundtableStore((state) => state.joinRoundtable)
  const [dropActive, setDropActive] = useState(false)
  const unnamed = t.studio.webShelf.unnamed

  const ready = props.participants.length > 0

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

      <footer className="roundtable__ask">
        <form
          className="roundtable__ask-form"
          onSubmit={(event) => {
            // Phase 3：不发起真实提问（规格 §7），只保留输入与草稿同步。
            event.preventDefault()
          }}
        >
          <input
            className="roundtable__ask-input"
            placeholder={ready ? t.studio.roundtable.askPlaceholder : t.studio.roundtable.askPlaceholderIdle}
            aria-label={t.studio.roundtable.askLabel}
            value={snapshot.draft}
            maxLength={2_000}
            onChange={(event) => void setDraft(event.target.value)}
            disabled={!ready}
          />
          <button
            type="submit"
            className="roundtable__ask-submit"
            disabled={!ready || snapshot.draft.trim() === ''}
          >
            {t.studio.roundtable.start}
          </button>
        </form>
      </footer>
    </>
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
