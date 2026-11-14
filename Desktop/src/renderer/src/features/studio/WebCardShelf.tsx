import { useEffect, useRef, useState } from 'react'
import {
  cardBadgeText,
  cardDisplayName,
  isCardAwaitingAddress,
  toWebCardModels,
  type WebCardModel
} from '@shared/web-cards'
import { useI18n } from '../../i18n'
import { PlusIcon } from '../../shared/icons'
import { api } from '../../shared/api'
import { useBrowserStore } from '../browser/browser-store'
import { useBrowserPreviewStore } from '../browser/preview-store'
import { useRoundtableStore } from './roundtable-store'

/**
 * 网页卡片架（「正在使用」）：Studio Home 底部第一层。
 *
 * Phase 2 起一张卡 = BrowserTabManager 的一个真实标签：
 * - 预览是主进程用 `capturePage()` 采的真实截图（内存缓存，不落库）；
 * - 标题 / 地址 / 加载态 / 是否独立窗口全部来自 browser-store 快照；
 * - 点击卡片在浏览器浮窗里展开同一个页面（tabId 不变）；
 * - 按住拖出主窗口 → 主进程把**同一个 WebContentsView** 迁到新窗口；
 * - 拖到圆桌 → 只建立 tabId 引用，不复制网页状态。
 *
 * 这里没有任何「本地网页数据」：卡片消失只可能是标签被关闭。
 */

const DRAG_THRESHOLD = 5
const PROBE_INTERVAL_MS = 140

type DragState = {
  tabId: string
  pointerId: number
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  width: number
  height: number
  outside: boolean
  lastProbe: number
}

export function WebCardShelf() {
  const { t } = useI18n()
  const tabs = useBrowserStore((state) => state.state.tabs)
  const createCard = useRoundtableStore((state) => state.createCard)
  const syncTabs = useRoundtableStore((state) => state.syncTabs)
  const cardOrder = useRoundtableStore((state) => state.cardOrder)
  const participants = useRoundtableStore((state) => state.roundtable.participantTabIds)
  const draggingTabId = useRoundtableStore((state) => state.draggingTabId)
  const setDraggingTab = useRoundtableStore((state) => state.setDraggingTab)
  const setDragOutside = useRoundtableStore((state) => state.setDragOutside)
  const dragOutside = useRoundtableStore((state) => state.dragOutside)
  const moveCard = useRoundtableStore((state) => state.moveCard)
  const joinRoundtable = useRoundtableStore((state) => state.joinRoundtable)

  const dragRef = useRef<DragState | null>(null)
  const suppressClick = useRef(false)
  const [ghost, setGhost] = useState<{ tabId: string; x: number; y: number } | null>(null)

  // 浏览器快照变化 → 顺序对账 + 圆桌参与者清理。
  useEffect(() => {
    syncTabs(tabs.map((tab) => tab.id))
  }, [tabs, syncTabs])

  const cards = toWebCardModels(tabs, cardOrder, participants)
  const draggingCard = draggingTabId ? cards.find((card) => card.tabId === draggingTabId) ?? null : null
  // 拖动过程中卡片顺序/列表会重渲染；落点判定要读最新顺序，但不该因数组身份
  // 变化反复重挂 document 监听（那会丢掉手指抬起的那一帧）。
  const cardsRef = useRef(cards)
  cardsRef.current = cards

  // 拖动投递：整只架子只有这一处 document 级 pointerup（Phase 1 的竞态教训：
  // 两处监听会因先清状态触发的重渲染而互相卸掉）。
  useEffect(() => {
    if (!draggingTabId) return

    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      setGhost({ tabId: drag.tabId, x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY })

      const now = Date.now()
      if (now - drag.lastProbe > PROBE_INTERVAL_MS) {
        drag.lastProbe = now
        void api.browserTabs
          .dragProbe(event.screenX, event.screenY)
          .then((probe) => {
            const outside = probe.windowId === null
            if (outside !== drag.outside) {
              drag.outside = outside
              setDragOutside(outside)
            }
          })
          .catch(() => undefined)
      }

      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      const over = target?.closest<HTMLElement>('.web-card:not([data-dragging="true"])') ?? null
      document.querySelectorAll<HTMLElement>('.web-card[data-insert]').forEach((element) => {
        if (element !== over) element.removeAttribute('data-insert')
      })
      if (!over) return
      const rect = over.getBoundingClientRect()
      over.setAttribute('data-insert', event.clientX < rect.left + rect.width / 2 ? 'before' : 'after')
    }

    const onUp = (event: PointerEvent): void => {
      const drag = dragRef.current
      dragRef.current = null
      document.querySelectorAll<HTMLElement>('.web-card[data-insert]').forEach((element) => {
        element.removeAttribute('data-insert')
      })
      if (!drag || drag.pointerId !== event.pointerId) {
        setDraggingTab(null)
        setGhost(null)
        return
      }
      suppressClick.current = true

      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      const zone = target?.closest<HTMLElement>('.roundtable__stage') ?? null
      const overCard = target?.closest<HTMLElement>('.web-card') ?? null

      void (async () => {
        try {
          const probe = await api.browserTabs.dragProbe(event.screenX, event.screenY)
          const outside = probe.windowId === null
          if (outside) {
            // 拖出客户端：主进程把同一个 view 迁进新窗口；卡片仍然留在架上。
            await api.browserTabs.detach(drag.tabId, event.screenX, event.screenY)
          } else if (zone) {
            joinRoundtable(drag.tabId)
          } else if (overCard && !overCard.classList.contains('web-card--editing')) {
            const overId = overCard.dataset.tabId ?? ''
            if (overId && overId !== drag.tabId) {
              const rect = overCard.getBoundingClientRect()
              const after = event.clientX >= rect.left + rect.width / 2
              const ids = cardsRef.current.map((card) => card.tabId).filter((id) => id !== drag.tabId)
              const at = ids.indexOf(overId)
              const beforeId = after ? (ids[at + 1] ?? null) : overId
              moveCard(drag.tabId, beforeId)
            }
          }
        } catch (error) {
          console.error('[web-cards] drop failed', error)
        } finally {
          setDraggingTab(null)
          setDragOutside(false)
          setGhost(null)
          // 拖完会紧跟一次 click：短暂吞掉它，避免“松手即打开”；
          // 即使没有 click 也会自动恢复，不会吞掉下一次真实点击。
          setTimeout(() => {
            suppressClick.current = false
          }, 250)
        }
      })()
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      dragRef.current = null
      document.querySelectorAll<HTMLElement>('.web-card[data-insert]').forEach((element) => {
        element.removeAttribute('data-insert')
      })
      setDraggingTab(null)
      setDragOutside(false)
      setGhost(null)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('keydown', onKey)
    }
  }, [draggingTabId, joinRoundtable, moveCard, setDragOutside, setDraggingTab])

  /** 点击卡片 = 在浏览器浮窗里展开同一个页面；拖动结束后的那次 click 不算。 */
  const openCard = (tabId: string): void => {
    if (suppressClick.current) return
    const state = useRoundtableStore.getState()
    state.selectTab(state.selectedTabId === tabId ? null : tabId)
    void api.browserTabs.activate(tabId)
  }

  const onCardDragStart = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button, input, a, textarea, select')) return
    const element = event.currentTarget
    const tabId = element.dataset.tabId ?? ''
    if (!tabId) return
    const rect = element.getBoundingClientRect()
    // 先记起点再 capture：capture 抛异常不能把起点一起丢掉（Phase 1 踩过）。
    dragRef.current = {
      tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      outside: false,
      lastProbe: 0
    }
    event.preventDefault()
    try {
      element.setPointerCapture(event.pointerId)
    } catch {
      // 无指针环境：拖动退化为不可用，点击仍正常。
    }
  }

  const onCardPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return
    dragRef.current = { ...drag, startX: event.clientX, startY: event.clientY }
    // 每帧都 set 会无意义地重渲染整只架子；只在第一次进入拖动态时写。
    if (useRoundtableStore.getState().draggingTabId !== drag.tabId) {
      setDraggingTab(drag.tabId)
    }
    setGhost({ tabId: drag.tabId, x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY })
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
        <div className="web-shelf__row" role="list">
          {cards.map((card) => (
            <WebCardItem
              key={card.tabId}
              card={card}
              dragging={draggingTabId === card.tabId}
              onDragStart={onCardDragStart}
              onPointerMove={onCardPointerMove}
              onOpen={openCard}
            />
          ))}
        </div>
      )}

      {draggingCard && ghost && (
        <div
          className="web-card-ghost"
          style={{ left: `${ghost.x}px`, top: `${ghost.y}px`, width: `${dragRef.current?.width ?? 200}px` }}
          data-outside={dragOutside}
          aria-hidden="true"
        >
          <CardPreview tabId={draggingCard.tabId} card={draggingCard} />
          <span className="web-card-ghost__meta">
            <span className="web-card__name">{displayName(draggingCard, t.studio.webShelf.unnamed)}</span>
            <span className="web-card__domain">{draggingCard.domain || t.studio.webShelf.emptyDomain}</span>
          </span>
          {dragOutside && <span className="web-card-ghost__hint">{t.studio.webShelf.detachHint}</span>}
        </div>
      )}
    </section>
  )
}

function displayName(card: WebCardModel, fallback: string): string {
  return cardDisplayName({ title: card.title, url: card.url }, fallback)
}

function WebCardItem(props: {
  card: WebCardModel
  dragging: boolean
  onDragStart: (event: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
  onOpen: (tabId: string) => void
}) {
  const { card } = props
  const { t } = useI18n()
  const selectTab = useRoundtableStore((state) => state.selectTab)
  const selected = useRoundtableStore((state) => state.selectedTabId === card.tabId)
  const closeCard = useRoundtableStore((state) => state.closeCard)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const awaitingAddress = isCardAwaitingAddress({ url: card.url })

  useEffect(() => {
    if (awaitingAddress) inputRef.current?.focus()
  }, [awaitingAddress])

  const name = displayName(card, t.studio.webShelf.unnamed)
  const status = cardStatus(card, t)

  const submitAddress = (): void => {
    const value = draft.trim()
    if (!value) return
    void api.browserTabs.navigate(card.tabId, value).catch((error) => {
      console.error('[web-cards] navigate failed', error)
    })
    setDraft('')
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
        >
          <span className="web-card__form-title">{t.studio.webShelf.newCardTitle}</span>
          <input
            ref={inputRef}
            className="web-card__input"
            placeholder={t.studio.webShelf.urlPlaceholder}
            aria-label={t.studio.webShelf.urlPlaceholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
          <div className="web-card__form-actions">
            <button type="submit" className="web-card__form-ok" disabled={draft.trim() === ''}>
              {t.studio.webShelf.open}
            </button>
            <button type="button" className="web-card__form-cancel" onClick={() => void closeCard(card.tabId)}>
              {t.studio.webShelf.cancel}
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
      onClick={() => {
        if (props.dragging) return
        props.onOpen(card.tabId)
      }}
      onPointerDown={props.onDragStart}
      onPointerMove={props.onPointerMove}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          props.onOpen(card.tabId)
        }
        if (event.key === 'Escape') selectTab(null)
      }}
      title={t.studio.webShelf.editHint}
    >
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

function cardStatus(card: WebCardModel, t: ReturnType<typeof useI18n>['t']): string {
  if (card.error) return t.studio.webShelf.status.error
  if (card.loading) return t.studio.webShelf.status.loading
  if (card.presentation === 'detached') return t.studio.webShelf.status.detached
  if (card.presentation === 'expanded-in-main') return t.studio.webShelf.status.expanded
  return t.studio.webShelf.status.shelved
}
