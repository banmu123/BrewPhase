import { useEffect, useRef, useState } from 'react'
import { domainOf, cardBadgeText, isJoinableCard, type WebCard } from '@shared/roundtable'
import { useI18n } from '../../i18n'
import { PlusIcon } from '../../shared/icons'
import { useRoundtableStore } from './roundtable-store'

/**
 * 网页卡片架（「正在使用」）：Studio Home 底部第一层。
 *
 * 卡片是「桌面上的快捷入口」，不是浏览器标签栏：紧凑、轻量、只报身份
 * （图标 / 名称 / 域名 / 状态），不渲染网页缩略图（规格 §3.4）。
 *
 * 拖动模型与 BrowserTabStrip 同一套：按住移动超过阈值才算拖动（避免
 * 点击被误判），拖动中用插入线提示落点；松手在圆桌热区上则加入圆桌
 * （由 RoundtableSection 通过 store 的 dragOverRoundtable 状态判定）。
 */

/** 按住多少 px 才算拖动（与 BrowserTabStrip 的 DRAG_THRESHOLD 一致）。 */
const DRAG_THRESHOLD = 5

export function WebCardShelf() {
  const { t } = useI18n()
  const cards = useRoundtableStore((state) => state.cards)
  const addCard = useRoundtableStore((state) => state.addCard)

  return (
    <section className="web-shelf" aria-label={t.studio.webShelf.title}>
      <header className="web-shelf__head">
        <span className="overline">{t.studio.webShelf.overline}</span>
        <h2 className="web-shelf__title">{t.studio.webShelf.title}</h2>
        <button
          type="button"
          className="web-shelf__add"
          onClick={addCard}
          aria-label={t.studio.webShelf.add}
        >
          <PlusIcon size={14} />
          <span>{t.studio.webShelf.add}</span>
        </button>
      </header>

      <div className="web-shelf__row" role="list">
        {cards.map((card, index) => (
          <WebCardItem key={card.id} card={card} index={index} total={cards.length} />
        ))}
      </div>
    </section>
  )
}

function WebCardItem(props: { card: WebCard; index: number; total: number }) {
  const { card, index, total } = props
  const { t } = useI18n()
  const selected = useRoundtableStore((state) => state.selectedCardId === card.id)
  const dragging = useRoundtableStore((state) => state.draggingCardId === card.id)
  const draggingCardId = useRoundtableStore((state) => state.draggingCardId)
  const inRoundtable = useRoundtableStore((state) => state.roundtable.participantIds.includes(card.id))
  const selectCard = useRoundtableStore((state) => state.selectCard)
  const closeCard = useRoundtableStore((state) => state.closeCard)
  const updateCard = useRoundtableStore((state) => state.updateCard)
  const setDraggingCard = useRoundtableStore((state) => state.setDraggingCard)

  const [editing, setEditing] = useState(card.status === 'empty')
  const [draftTitle, setDraftTitle] = useState(card.title)
  const [draftUrl, setDraftUrl] = useState(card.url)
  const rowRef = useRef<HTMLDivElement>(null)
  const press = useRef<{ x: number; y: number; pointerId: number } | null>(null)

  const reorderCard = useRoundtableStore((state) => state.reorderCard)
  const joinRoundtable = useRoundtableStore((state) => state.joinRoundtable)

  /** 拖动投递：松手点落在哪由这里统一判定——
   * 圆桌热区（.roundtable__stage）→ 加入圆桌；另一张卡 → 排序；其他 → 取消。
   * 必须收在一处：圆桌自己的监听会因 setDraggingCard(null) 触发的重渲染
   * 被提前卸掉（真实竞态，E2E 抓到过），不能依赖两处监听的执行顺序。 */
  useEffect(() => {
    if (draggingCardId !== card.id) return
    const onMove = (event: PointerEvent): void => {
      const target = document.elementFromPoint(event.clientX, event.clientY)
      const over = (target as HTMLElement | null)?.closest<HTMLElement>('.web-card:not([data-dragging="true"])')
      document.querySelectorAll<HTMLElement>('.web-card[data-insert]').forEach((el) => {
        if (el !== over) el.removeAttribute('data-insert')
      })
      if (!over || over === rowRef.current) return
      const rect = over.getBoundingClientRect()
      const before = event.clientX < rect.left + rect.width / 2
      over.setAttribute('data-insert', before ? 'before' : 'after')
    }
    const onUp = (event: PointerEvent): void => {
      document.querySelectorAll<HTMLElement>('.web-card[data-insert]').forEach((el) => el.removeAttribute('data-insert'))
      const target = document.elementFromPoint(event.clientX, event.clientY)
      const zone = (target as HTMLElement | null)?.closest<HTMLElement>('.roundtable__stage')
      if (zone) {
        joinRoundtable(card.id)
      } else {
        const over = (target as HTMLElement | null)?.closest<HTMLElement>('.web-card')
        if (over && over !== rowRef.current && !over.classList.contains('web-card--editing')) {
          // 按落点前/后半决定插到 over 前面还是后面：后面 = over 的下一张前面。
          const rect = over.getBoundingClientRect()
          const after = event.clientX >= rect.left + rect.width / 2
          let anchorId = over.dataset.cardId ?? ''
          if (after) {
            const cardsNow = useRoundtableStore.getState().cards
            const overIndex = cardsNow.findIndex((item) => item.id === anchorId)
            const next = cardsNow[overIndex + 1]
            if (next && next.id !== card.id) anchorId = next.id
          }
          if (anchorId) reorderCard(card.id, anchorId)
        }
      }
      setDraggingCard(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      document.querySelectorAll<HTMLElement>('.web-card[data-insert]').forEach((el) => el.removeAttribute('data-insert'))
      setDraggingCard(null)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('keydown', onKey)
    }
  }, [draggingCardId, card.id, reorderCard, setDraggingCard, joinRoundtable, rowRef])

  const joinable = isJoinableCard(card)
  const unnamed = t.studio.webShelf.unnamed

  const commitEdit = (): void => {
    const url = draftUrl.trim()
    const title = draftTitle.trim()
    if (!url) {
      // 没填地址：保持空白卡，退出编辑态即可（关掉它就是删除）。
      setEditing(false)
      return
    }
    updateCard(card.id, {
      url,
      title,
      // 地址有效即视为就绪（本阶段不真实加载，status 只做展示语义）。
      status: 'ready'
    })
    setEditing(false)
  }

  /** 按住卡片移动：超过阈值进入拖动。setPointerCapture 让指针移出卡片后
   * 仍由本元素接收 move/up——否则往圆桌拖的第一步就断流（真实缺陷，
   * 不只是测试问题）。capture 失败（环境限制）时退化为普通监听：
   * 慢速拖动仍可用，快速甩出卡片外才会丢。 */
  const onPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button, input, a, textarea')) return
    // 先记起点再 capture：capture 抛异常不能把起点一起丢掉。
    press.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    // 阻止文本选择/原生拖拽接管指针：否则浏览器 drag 一起，后续
    // pointermove 就被吞掉，合成拖动永远走不到阈值分支。
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 忽略：无指针环境（自动化/辅助技术）下 capture 可能不可用。
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const start = press.current
    if (!start || start.pointerId !== event.pointerId) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    // 进入拖动态：本组件只负责置状态与视觉，跨区判定在 document 层收口。
    press.current = null
    setDraggingCard(card.id)
  }

  const onPointerUp = (event: React.PointerEvent<HTMLElement>): void => {
    if (press.current?.pointerId !== event.pointerId) return
    press.current = null
    try {
      ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
    } catch {
      // 指针可能已被浏览器释放（pointercancel 路径），忽略。
    }
  }

  if (editing) {
    return (
      <div className="web-card web-card--editing" role="listitem">
        <form
          className="web-card__form"
          onSubmit={(event) => {
            event.preventDefault()
            commitEdit()
          }}
        >
          <input
            className="web-card__input"
            placeholder={t.studio.webShelf.namePlaceholder}
            aria-label={t.studio.webShelf.namePlaceholder}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            autoFocus
          />
          <input
            className="web-card__input"
            placeholder={t.studio.webShelf.urlPlaceholder}
            aria-label={t.studio.webShelf.urlPlaceholder}
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="web-card__form-actions">
            <button type="submit" className="web-card__form-ok">
              {t.studio.webShelf.save}
            </button>
            {index > 0 || total > 1 ? (
              <button
                type="button"
                className="web-card__form-cancel"
                onClick={() => {
                  setDraftTitle(card.title)
                  setDraftUrl(card.url)
                  setEditing(false)
                }}
              >
                {t.studio.webShelf.cancel}
              </button>
            ) : null}
          </div>
        </form>
      </div>
    )
  }

  return (
    <div
      className="web-card"
      role="listitem"
      data-card-id={card.id}
      data-selected={selected}
      data-dragging={dragging}
      data-joinable={joinable}
      data-in-roundtable={inRoundtable}
      aria-label={cardDisplayNameA11y(card, unnamed)}
      tabIndex={0}
      ref={rowRef}
      onClick={() => selectCard(selected ? null : card.id)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setEditing(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') setEditing(true)
        if (event.key === 'Escape') selectCard(null)
      }}
      title={t.studio.webShelf.editHint}
    >
      <span className="web-card__badge" aria-hidden="true">
        {cardBadgeText(card, unnamed)}
      </span>
      <span className="web-card__body">
        <span className="web-card__name">{cardDisplayNameA11y(card, unnamed)}</span>
        <span className="web-card__domain">{domainOf(card.url) || t.studio.webShelf.emptyDomain}</span>
      </span>
      <span className="web-card__state">
        {inRoundtable ? (
          <span className="web-card__chip" data-tone="roundtable">
            {t.studio.webShelf.inRoundtable}
          </span>
        ) : joinable ? (
          <span className="web-card__chip">{t.studio.webShelf.status.ready}</span>
        ) : (
          <span className="web-card__chip" data-tone="empty">
            {t.studio.webShelf.status.empty}
          </span>
        )}
      </span>
      <button
        type="button"
        className="web-card__close"
        aria-label={t.studio.webShelf.close}
        title={t.studio.webShelf.close}
        onClick={(event) => {
          event.stopPropagation()
          closeCard(card.id)
        }}
      >
        ✕
      </button>
    </div>
  )

  function cardDisplayNameA11y(card: WebCard, unnamed: string): string {
    if (card.title.trim()) return card.title.trim()
    return domainOf(card.url) || unnamed
  }
}
