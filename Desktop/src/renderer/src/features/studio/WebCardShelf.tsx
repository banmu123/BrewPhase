import { useEffect, useRef, useState } from 'react'
import {
  cardBadgeText,
  cardDisplayName,
  isCardAwaitingAddress,
  toWebCardModels,
  type WebCardModel
} from '@shared/web-cards'
import { useI18n } from '../../i18n'
import { GlobeIcon, PlusIcon } from '../../shared/icons'
import { api } from '../../shared/api'
import { useBrowserStore } from '../browser/browser-store'
import { useBrowserPreviewStore } from '../browser/preview-store'
import { useRoundtableStore } from './roundtable-store'

/**
 * 网页卡片架（「正在使用」）：Studio Home 底部第一层。
 *
 * 一张卡 = BrowserTabManager 的一个真实标签（Phase 2 铁律不变）：
 * 预览是主进程采的真实截图，标题/地址/加载态/窗口归属全部来自快照。
 *
 * 拖拽（Phase 3 重做）：**OS 原生 HTML5 Drag and Drop**。
 * Phase 2 用 pointer 事件 + document 监听模拟拖动，但真实桌面上光标离开
 * BrowserWindow 后渲染层收不到可靠的 pointermove/pointerup——pointerup
 * 丢失时整个会话挂死，这就是「卡片拖不出去」的根因。HTML5 拖拽是操作
 * 系统级的拖拽会话：拖影由 OS 渲染（窗口外也可见），**终态事件 dragend
 * 必达**（窗口外松手、落到别的应用、Esc 取消都会触发）。
 *
 * 「松手点在不在窗口外」由主进程判定：dragstart 上报会话开始，主进程
 * 轮询 `screen.getCursorScreenPoint()`；dragend 时主进程按最后轮询到的
 * 光标位置决定拆出独立窗口还是取消（渲染层只报意图与兜底坐标）。
 */

/** 卡片拖拽的数据类型；圆桌热区用它识别「来的是一张网页卡片」。 */
export const WEB_CARD_MIME = 'application/x-brewphase-webcard'

export function WebCardShelf() {
  const { t } = useI18n()
  const tabs = useBrowserStore((state) => state.state.tabs)
  const createCard = useRoundtableStore((state) => state.createCard)
  const syncTabs = useRoundtableStore((state) => state.syncTabs)
  const cardOrder = useRoundtableStore((state) => state.cardOrder)
  const participants = useRoundtableStore((state) => state.snapshot.participantTabIds)
  const draggingTabId = useRoundtableStore((state) => state.draggingTabId)
  const dragOutside = useRoundtableStore((state) => state.dragOutside)
  const setDraggingTab = useRoundtableStore((state) => state.setDraggingTab)
  const moveCard = useRoundtableStore((state) => state.moveCard)

  const rowRef = useRef<HTMLDivElement>(null)
  /** 拖动结束后的那次 click 不算「打开」：原生拖拽本会抑制 click，这里是双保险。 */
  const suppressClick = useRef(false)

  // 浏览器快照变化 → 顺序对账（参与者的摘除在主进程完成并广播回来）。
  useEffect(() => {
    syncTabs(tabs.map((tab) => tab.id))
  }, [tabs, syncTabs])

  const cards = toWebCardModels(tabs, cardOrder, participants)

  /** 点击卡片 = 在浏览器浮窗里展开同一个页面（tabId 不变）。 */
  const openCard = (tabId: string): void => {
    if (suppressClick.current) return
    const state = useRoundtableStore.getState()
    state.selectTab(state.selectedTabId === tabId ? null : tabId)
    void api.browserTabs.activate(tabId)
  }

  /** 架内移动：把拖动的卡插到落点卡的前/后（data-insert 指示线已在 dragover 算好）。 */
  const dropOnCard = (draggedTabId: string, overCard: HTMLElement): void => {
    const overId = overCard.dataset.tabId ?? ''
    if (!overId || overId === draggedTabId) return
    const rect = overCard.getBoundingClientRect()
    const side = overCard.dataset.insert ?? (rect ? 'before' : 'before')
    const ids = cards.map((card) => card.tabId).filter((id) => id !== draggedTabId)
    const at = ids.indexOf(overId)
    const beforeId = side === 'after' ? (ids[at + 1] ?? null) : overId
    moveCard(draggedTabId, beforeId)
  }

  const clearInsertMarkers = (): void => {
    document.querySelectorAll<HTMLElement>('.web-card[data-insert]').forEach((element) => {
      element.removeAttribute('data-insert')
    })
  }

  /** HTML5 dragstart：登记会话（主进程开始轮询光标）+ OS 拖影。 */
  const onCardDragStart = (event: React.DragEvent<HTMLElement>, tabId: string): void => {
    if ((event.target as HTMLElement).closest('button, input, a, textarea, select')) {
      // 按钮上的按压不是「拿起卡片」：阻止进入拖拽会话，让 click 正常发生。
      event.preventDefault()
      return
    }
    // dataTransfer 的设置必须同步、最先做。整个处理器里**任何**异常都会让
    // Chromium 直接取消原生拖拽——所以后续步骤全部包进 try。
    event.dataTransfer.setData(WEB_CARD_MIME, tabId)
    event.dataTransfer.effectAllowed = 'move'
    try {
      const rect = event.currentTarget.getBoundingClientRect()
      event.dataTransfer.setDragImage(event.currentTarget, Math.max(8, event.clientX - rect.left), Math.max(8, event.clientY - rect.top))
      clearInsertMarkers()
      // 双保险：即使某些平台在拖拽结束后仍补发 click，也不误开主窗口面板。
      suppressClick.current = true
      setTimeout(() => {
        suppressClick.current = false
      }, 400)
      setDraggingTab(tabId)
      console.info(`[drag:card] dragstart tab=${tabId}`)
      void api.browserDrag.begin(tabId).catch((error) => console.error('[drag:card] begin failed', error))
    } catch (error) {
      // 拖影/状态失败不中止原生拖拽：OS 拖影兜底可用，会话随后由 dragend 收尾。
      console.error('[drag:card] dragstart side-effects failed', error)
    }
  }

  /** HTML5 dragend：会话终态。拆不拆窗由主进程按轮询光标裁定。 */
  const onCardDragEnd = (event: React.DragEvent<HTMLElement>, tabId: string): void => {
    clearInsertMarkers()
    setDraggingTab(null)
    console.info(`[drag:card] dragend tab=${tabId} at (${Math.round(event.screenX)}, ${Math.round(event.screenY)})`)
    void api.browserDrag.end(tabId, { screenX: event.screenX, screenY: event.screenY }).catch(() => undefined)
  }

  const onCardDragOver = (event: React.DragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes(WEB_CARD_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    // 关键：**不给正在被拖动的那张卡做插入标记**——对拖拽源做 DOM 变更会干扰
    // 原生拖拽会话（macOS 上表现就是拖到一半会话消失）。圆桌标题栏没有这个
    // 行为，因此它的真实鼠标拖出一直是好的；这是两者唯一的结构性差异之一。
    if (event.currentTarget.dataset.tabId === useRoundtableStore.getState().draggingTabId) return
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.setAttribute('data-insert', event.clientX < rect.left + rect.width / 2 ? 'before' : 'after')
  }

  const onCardDrop = (event: React.DragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes(WEB_CARD_MIME)) return
    event.preventDefault()
    event.stopPropagation()
    const draggedTabId = event.dataTransfer.getData(WEB_CARD_MIME)
    clearInsertMarkers()
    if (draggedTabId) {
      dropOnCard(draggedTabId, event.currentTarget)
      // 内部投放：会话按「dropHandled」收尾，主进程不会拆窗。
      void api.browserDrag.dropHandled(draggedTabId).catch(() => undefined)
    }
  }

  return (
    <section className="web-shelf" aria-label={t.studio.webShelf.title}>
      <header className="web-shelf__head">
        <span className="overline">{t.studio.webShelf.overline}</span>
        <h2 className="web-shelf__title">{t.studio.webShelf.title}</h2>
        <button type="button" className="web-shelf__add" onClick={() => void createCard()} aria-label={t.studio.webShelf.add}>
          <PlusIcon size={14} />
          <span>{t.studio.webShelf.add}</span>
        </button>
      </header>

      {cards.length === 0 ? (
        <button type="button" className="web-shelf__guide" onClick={() => void createCard()}>
          <span className="web-shelf__guide-mark" aria-hidden="true">
            +
          </span>
          <span className="web-shelf__guide-body">
            <span className="web-shelf__guide-title">{t.studio.webShelf.emptyTitle}</span>
            <span className="web-shelf__guide-hint">{t.studio.webShelf.emptyHint}</span>
          </span>
        </button>
      ) : (
        <div className="web-shelf__row" role="list" ref={rowRef}>
          {cards.map((card) => (
            <WebCardItem
              key={card.tabId}
              card={card}
              dragging={draggingTabId === card.tabId}
              onOpenClick={openCard}
              onDragStart={onCardDragStart}
              onDragEnd={onCardDragEnd}
              onDragOver={onCardDragOver}
              onDrop={onCardDrop}
              onDragLeave={clearInsertMarkers}
            />
          ))}
        </div>
      )}

      {draggingTabId && (
        <p className="web-shelf__drag-hint" data-outside={dragOutside} role="status">
          {dragOutside ? t.studio.webShelf.detachHint : t.studio.webShelf.dragHint}
        </p>
      )}
    </section>
  )
}

function WebCardItem(props: {
  card: WebCardModel
  dragging: boolean
  onOpenClick: (tabId: string) => void
  onDragStart: (event: React.DragEvent<HTMLElement>, tabId: string) => void
  onDragEnd: (event: React.DragEvent<HTMLElement>, tabId: string) => void
  onDragOver: (event: React.DragEvent<HTMLElement>) => void
  onDrop: (event: React.DragEvent<HTMLElement>) => void
  onDragLeave: () => void
}) {
  const { card } = props
  const { t } = useI18n()
  const selectTab = useRoundtableStore((state) => state.selectTab)
  const selected = useRoundtableStore((state) => state.selectedTabId === card.tabId)
  const closeCard = useRoundtableStore((state) => state.closeCard)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const awaitingAddress = isCardAwaitingAddress({ url: card.url })
  // 编辑态里导航失败（错误页）时标签仍是空地址：把主进程的错误如实带进表单。
  const tabError = useBrowserStore((state) => state.state.tabs.find((item) => item.id === card.tabId)?.error ?? null)

  useEffect(() => {
    if (awaitingAddress) inputRef.current?.focus()
  }, [awaitingAddress])

  const name = displayName(card, t.studio.webShelf.unnamed)
  const status = cardStatus(card, t)

  const submitAddress = (): void => {
    const value = draft.trim()
    if (!value || submitting) return
    setSubmitting(true)
    void api.browserTabs
      .navigate(card.tabId, value)
      .catch((error) => console.error('[web-cards] navigate failed', error))
      .finally(() => setSubmitting(false))
  }

  if (awaitingAddress) {
    return (
      <div className="web-card web-card--editing" role="listitem" data-tab-id={card.tabId} data-card-id={card.tabId}>
        <form
          className="web-card__form"
          onSubmit={(event) => {
            event.preventDefault()
            submitAddress()
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            void closeCard(card.tabId)
          }}
        >
          <span className="web-card__form-head">
            <span className="web-card__form-icon" aria-hidden="true">
              <ExternalGlyph />
            </span>
            <span className="web-card__form-title">{t.studio.webShelf.newCardTitle}</span>
          </span>
          <label className="web-card__form-label" htmlFor={`web-card-input-${card.tabId}`}>
            {t.studio.webShelf.formLabel}
          </label>
          <div className="web-card__input-wrap">
            <span className="web-card__input-icon" aria-hidden="true">
              <GlobeIcon size={14} />
            </span>
            <input
              ref={inputRef}
              id={`web-card-input-${card.tabId}`}
              className="web-card__input"
              placeholder={t.studio.webShelf.urlPlaceholder}
              aria-label={t.studio.webShelf.urlPlaceholder}
              value={draft}
              maxLength={2_048}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
            />
          </div>
          <p className="web-card__form-hint">{t.studio.webShelf.formHint}</p>
          {tabError && <p className="web-card__form-error">{t.studio.webShelf.formInvalid}</p>}
          <div className="web-card__form-actions">
            <button
              type="button"
              className="web-card__form-cancel"
              onClick={() => void closeCard(card.tabId)}
            >
              {t.studio.webShelf.cancel}
            </button>
            <button
              type="submit"
              className="web-card__form-ok"
              disabled={draft.trim() === '' || submitting}
            >
              {submitting ? t.studio.webShelf.formOpening : t.studio.webShelf.open}
            </button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <article
      className="web-card"
      role="listitem"
      data-tab-id={card.tabId}
      data-card-id={card.tabId}
      data-selected={selected}
      data-dragging={props.dragging}
      data-presentation={card.presentation}
      data-in-roundtable={card.inRoundtable}
      data-loading={card.loading}
      aria-label={`${name} — ${status}`}
      tabIndex={0}
      draggable
      onClick={() => props.onOpenClick(card.tabId)}
      onDragStart={(event) => props.onDragStart(event, card.tabId)}
      onDragEnd={(event) => props.onDragEnd(event, card.tabId)}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragLeave={props.onDragLeave}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          props.onOpenClick(card.tabId)
        }
        if (event.key === 'Escape') selectTab(null)
      }}
      title={t.studio.webShelf.editHint}
    >
      {/* 低调的六点握把：说明这张卡「可以拿起来」；纯装饰，不拦指针。 */}
      <span className="web-card__grip" aria-hidden="true">
        ⠿
      </span>
      <CardPreview tabId={card.tabId} card={card} />

      <div className="web-card__meta">
        <span className="web-card__identity">
          <span className="web-card__name">{name}</span>
          <span className="web-card__domain">{card.domain || t.studio.webShelf.emptyDomain}</span>
        </span>
        <span className="web-card__state">
          <span className="web-card__chip" data-tone={card.presentation === 'detached' ? 'detached' : card.error ? 'error' : card.loading ? 'loading' : 'ready'}>
            {status}
          </span>
        </span>
      </div>

      {card.inRoundtable && <span className="web-card__roundtable-dot" aria-label={t.studio.webShelf.inRoundtable} />}

      <span className="web-card__actions">
        {card.presentation === 'detached' && (
          <button
            type="button"
            className="web-card__action"
            title={t.studio.webShelf.recall}
            aria-label={t.studio.webShelf.recall}
            onClick={(event) => {
              event.stopPropagation()
              void api.browserTabs.recall(card.tabId)
            }}
          >
            {t.studio.webShelf.recallAction}
          </button>
        )}
        {card.presentation !== 'detached' && (
          <button
            type="button"
            className="web-card__action"
            title={t.studio.webShelf.detachAction}
            aria-label={t.studio.webShelf.detachAction}
            onClick={(event) => {
              event.stopPropagation()
              // 备用入口：与拖出共用同一个主进程 detach（同一页面实例迁移）。
              const rect = (event.currentTarget.closest('.web-card') as HTMLElement | null)?.getBoundingClientRect()
              const screenX = window.screenX + (rect ? Math.round(rect.right + 56) : 240)
              const screenY = window.screenY + (rect ? Math.round(rect.top + 90) : 240)
              void api.browserTabs.detach(card.tabId, screenX, screenY).catch((error) => console.error('[web-cards] detach failed', error))
            }}
          >
            {t.studio.webShelf.detachAction}
          </button>
        )}
        <button
          type="button"
          className="web-card__close"
          aria-label={t.studio.webShelf.close}
          title={t.studio.webShelf.close}
          onClick={(event) => {
            event.stopPropagation()
            void closeCard(card.tabId)
          }}
        >
          ✕
        </button>
      </span>
    </article>
  )
}

/** 表单头的小图标（内联 SVG，避免为一张表单引入新图标依赖）。 */
function ExternalGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.5 3.5H3.8A1.3 1.3 0 0 0 2.5 4.8v7.4a1.3 1.3 0 0 0 1.3 1.3h7.4a1.3 1.3 0 0 0 1.3-1.3V9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9.5 2.5h4v4M13.2 2.8 7.8 8.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 预览区：真实截图 / 加载中 / 失败 / 未生成，四种画面各自明确。 */
function CardPreview(props: { tabId: string; card: WebCardModel }) {
  const { t } = useI18n()
  const preview = useBrowserPreviewStore((state) => state.previews[props.tabId])
  const request = useBrowserPreviewStore((state) => state.request)
  const requested = useRef(false)

  useEffect(() => {
    if (preview || requested.current || props.card.loading || props.card.error) return
    requested.current = true
    request(props.tabId)
  }, [preview, props.card.loading, props.card.error, props.tabId, request])

  return (
    <div className="web-card__preview" data-has-image={Boolean(preview)}>
      {preview ? (
        <img
          className="web-card__image"
          src={preview.dataUrl}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="web-card__placeholder" aria-hidden="true">
          <span className="web-card__placeholder-mark">{cardBadgeText({ title: props.card.title, url: props.card.url }, '·')}</span>
          <span className="web-card__placeholder-text">
            {props.card.error
              ? t.studio.webShelf.previewFailed
              : props.card.loading
                ? t.studio.webShelf.previewLoading
                : t.studio.webShelf.previewPending}
          </span>
        </span>
      )}
      {props.card.loading && <span className="web-card__spinner" aria-hidden="true" />}
      {props.card.error && <span className="web-card__preview-error">{t.studio.webShelf.status.error}</span>}
    </div>
  )
}

function displayName(card: WebCardModel, fallback: string): string {
  return cardDisplayName({ title: card.title, url: card.url }, fallback)
}

function cardStatus(card: WebCardModel, t: ReturnType<typeof useI18n>['t']): string {
  if (card.error) return t.studio.webShelf.status.error
  if (card.loading) return t.studio.webShelf.status.loading
  if (card.presentation === 'detached') return t.studio.webShelf.status.detached
  if (card.presentation === 'expanded-in-main') return t.studio.webShelf.status.expanded
  return t.studio.webShelf.status.shelved
}
