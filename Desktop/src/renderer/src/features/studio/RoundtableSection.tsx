import { useEffect, useRef, useState } from 'react'
import {
  cardBadgeText,
  cardDisplayName,
  clampRoundtable,
  type PanelViewport,
  type WebCard
} from '@shared/roundtable'
import { useI18n } from '../../i18n'
import { useRoundtableStore } from './roundtable-store'

/**
 * AI 圆桌（Roundtable Phase 1）：Studio Home 底部第二层。
 *
 * 两副形态、一份状态：
 * - **停靠**：占满内容宽度，位置由文档流决定；标题栏可拖出，也有明确的
 *   「独立展开」按钮（键盘可达）。
 * - **浮动**：fixed 定位的**应用内**浮层（本阶段不创建 Electron BrowserWindow，
 *   规格 §4 明确禁止提前做跨窗口迁移）。可整块拖动、右下角调整尺寸、
 *   「归位」或 Esc 回到停靠位；内部状态（参与者、输入）全程保留。
 *
 * 拖入接应：卡片架的卡片按住移动进入 `draggingCardId` 状态后，document 级
 * pointerup 判定松手点是否落在圆桌热区内——两边只通过这一个 store 字段
 * 握手，互相不认识（规格 §5 的关系边界）。
 *
 * 拖动边界：只有标题栏（手柄与空白区）触发整块拖动；`closest('button,
 * input, a, select, textarea')` 一律排除，所以拖参与者卡片、点输入框不会
 * 误移动整个圆桌（规格 §4.2）。
 */

type PointerDrag =
  | { kind: 'pending'; pointerId: number; startX: number; startY: number }
  | { kind: 'move'; pointerId: number; startX: number; startY: number; origin: { x: number; y: number } }
  | { kind: 'resize'; pointerId: number; startX: number; startY: number; size: { width: number; height: number } }

const DRAG_THRESHOLD = 5

function viewportSize(): PanelViewport {
  return {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight
  }
}

export function RoundtableSection() {
  const { t } = useI18n()
  const roundtable = useRoundtableStore((state) => state.roundtable)
  const cards = useRoundtableStore((state) => state.cards)
  const zoneRef = useRef<HTMLDivElement>(null)

  // ---- 拖入接应：只做视觉反馈（热区高亮）----
  // 投递判定**不在这里**：pointerup 时卡片自己的监听会先 setDraggingCard(null)
  // 触发重渲染、卸掉这里的 effect——监听还没执行就没了（真实竞态，靠 E2E 抓到）。
  // 所以「松手落在哪」由卡片的 onUp 统一判定（见 WebCardShelf），
  // 这里只在 pointermove 时高亮热区，告诉用户可以松手。
  const draggingCardId = useRoundtableStore((state) => state.draggingCardId)
  const [dropActive, setDropActive] = useState(false)

  useEffect(() => {
    if (!draggingCardId) {
      setDropActive(false)
      return
    }
    const onMove = (event: PointerEvent): void => {
      const zone = zoneRef.current
      if (!zone) return
      const rect = zone.getBoundingClientRect()
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      setDropActive(inside)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setDropActive(false)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('keydown', onKey)
    }
  }, [draggingCardId])

  const participants = roundtable.participantIds
    .map((id) => cards.find((card) => card.id === id))
    .filter((card): card is WebCard => Boolean(card))

  return (
    <>
      {/* 停靠位：浮出后留一个轻量占位，说明圆桌去哪了（规格 §4.3）。 */}
      <div
        className={roundtable.docked ? 'roundtable' : 'roundtable roundtable--slot'}
        ref={roundtable.docked ? zoneRef : undefined}
        data-drop-active={dropActive && roundtable.docked}
      >
        {roundtable.docked ? (
          <DockedRoundtable participants={participants} zoneRef={zoneRef} dropActive={dropActive} />
        ) : (
          <p className="roundtable__slot-hint">{t.studio.roundtable.slotHint}</p>
        )}
      </div>
      {!roundtable.docked && (
        <FloatingRoundtable participants={participants} zoneRef={zoneRef} dropActive={dropActive} />
      )}
    </>
  )
}

/* ============================================================
 * 停靠形态：标题栏拖动 = 拖出浮动；「独立展开」按钮同效（键盘可达）。
 * ============================================================ */

function DockedRoundtable(props: {
  participants: WebCard[]
  zoneRef: React.RefObject<HTMLDivElement | null>
  dropActive: boolean
}) {
  const { t } = useI18n()
  const undock = useRoundtableStore((state) => state.undock)
  const drag = useRef<PointerDrag | null>(null)
  const [dragArmed, setDragArmed] = useState(false)

  const onHeadPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button, input, a, select, textarea')) return
    drag.current = { kind: 'pending', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  const onHeadPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId || state.kind !== 'pending') return
    if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < DRAG_THRESHOLD) return
    // 拖过阈值：整块拖出（undock 后由 FloatingRoundtable 接管后续移动）。
    drag.current = null
    setDragArmed(false)
    undock(viewportSize())
  }

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragArmed(false)
  }

  return (
    <>
      <header
        className="roundtable__head"
        onPointerDown={onHeadPointerDown}
        onPointerMove={onHeadPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title={t.studio.roundtable.dragHint}
        data-armed={dragArmed}
      >
        <span className="roundtable__grip" aria-hidden="true">
          ⠿
        </span>
        <h2 className="roundtable__title">{t.studio.roundtable.title}</h2>
        {props.participants.length > 0 && (
          <span className="roundtable__count">{t.studio.roundtable.count(props.participants.length)}</span>
        )}
        <button
          type="button"
          className="roundtable__undock"
          aria-label={t.studio.roundtable.undock}
          title={t.studio.roundtable.undock}
          onClick={() => undock(viewportSize())}
        >
          <span aria-hidden="true">↗</span>
          <span>{t.studio.roundtable.undockAction}</span>
        </button>
      </header>
      <RoundtableBody participants={props.participants} dropActive={props.dropActive} />
    </>
  )
}

/* ============================================================
 * 浮动形态：fixed 浮层 + 标题栏拖动 + 右下角 resize + 归位 / 关闭。
 * ============================================================ */

function FloatingRoundtable(props: {
  participants: WebCard[]
  zoneRef: React.RefObject<HTMLDivElement | null>
  dropActive: boolean
}) {
  const { t } = useI18n()
  const roundtable = useRoundtableStore((state) => state.roundtable)
  const moveFloating = useRoundtableStore((state) => state.moveFloating)
  const resizeFloating = useRoundtableStore((state) => state.resizeFloating)
  const dock = useRoundtableStore((state) => state.dock)
  const drag = useRef<PointerDrag | null>(null)
  const [dragging, setDragging] = useState(false)

  const geom = clampRoundtable(roundtable.position, roundtable.size, viewportSize())

  // Esc：归位（浮动圆桌最自然的取消路径）。输入框聚焦且有内容时先失焦。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const active = document.activeElement
      if (active instanceof HTMLInputElement && active.value !== '') {
        active.blur()
        return
      }
      event.preventDefault()
      dock()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dock])

  // 窗口尺寸变化：几何重新收进视口（clamp 在 shared 收口，这里只触发）。
  useEffect(() => {
    const onResize = (): void => {
      const current = useRoundtableStore.getState().roundtable
      const next = clampRoundtable(current.position, current.size, viewportSize())
      useRoundtableStore.setState({ roundtable: { ...current, ...next } })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onHeadPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button, input, a, select, textarea')) return
    drag.current = {
      kind: 'move',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: roundtable.position.x, y: roundtable.position.y }
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onHeadPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId || state.kind !== 'move') return
    moveFloating({ dx: event.clientX - state.startX, dy: event.clientY - state.startY }, viewportSize())
    setDragging(true)
  }

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }

  const onResizeDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    drag.current = {
      kind: 'resize',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      size: { width: roundtable.size.width, height: roundtable.size.height }
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  const onResizeMove = (event: React.PointerEvent<HTMLElement>): void => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId || state.kind !== 'resize') return
    resizeFloating({ dw: event.clientX - state.startX, dh: event.clientY - state.startY }, viewportSize())
  }

  return (
    <section
      className="roundtable roundtable--floating"
      style={{
        left: `${geom.position.x}px`,
        top: `${geom.position.y}px`,
        width: `${geom.size.width}px`,
        height: `${geom.size.height}px`
      }}
      data-dragging={dragging}
      role="dialog"
      aria-label={t.studio.roundtable.title}
      ref={props.zoneRef}
    >
      <header
        className="roundtable__head roundtable__head--floating"
        onPointerDown={onHeadPointerDown}
        onPointerMove={onHeadPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title={t.studio.roundtable.dragHint}
      >
        <span className="roundtable__grip" aria-hidden="true">
          ⠿
        </span>
        <h2 className="roundtable__title">{t.studio.roundtable.title}</h2>
        {props.participants.length > 0 && (
          <span className="roundtable__count">{t.studio.roundtable.count(props.participants.length)}</span>
        )}
        <span className="roundtable__float-actions">
          <button
            type="button"
            className="roundtable__float-btn"
            onClick={dock}
            aria-label={t.studio.roundtable.dock}
            title={t.studio.roundtable.dock}
          >
            {t.studio.roundtable.dockAction}
          </button>
          <button
            type="button"
            className="roundtable__float-btn roundtable__float-btn--close"
            aria-label={t.studio.roundtable.close}
            title={t.studio.roundtable.close}
            onClick={dock}
          >
            ✕
          </button>
        </span>
      </header>

      <RoundtableBody participants={props.participants} dropActive={props.dropActive} />

      <div
        className="roundtable__resize"
        aria-hidden="true"
        title={t.studio.roundtable.resizeHint}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </section>
  )
}

/* ============================================================
 * 圆桌正文（停靠与浮动共用）：参与区 + 统一提问输入。
 * 提问状态放在这里：归位/拖出只是换壳，正文不重新挂载——
 * 但浮层与停靠是两棵子树，切换时正文会重挂载。所以提问草稿
 * 存进 store（roundtable 输入不丢，规格 §4.4）。
 * ============================================================ */

function RoundtableBody(props: { participants: WebCard[]; dropActive: boolean }) {
  const { t } = useI18n()
  const question = useRoundtableStore((state) => state.draft)
  const setQuestion = useRoundtableStore((state) => state.setDraft)
  const leaveRoundtable = useRoundtableStore((state) => state.leaveRoundtable)
  const unnamed = t.studio.webShelf.unnamed

  const ready = props.participants.length > 0

  return (
    <>
      <div className="roundtable__stage" data-drop-active={props.dropActive}>
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
            {props.participants.map((card) => (
              <article className="roundtable__participant" role="listitem" key={card.id}>
                <span className="roundtable__participant-badge" aria-hidden="true">
                  {cardBadgeText(card, unnamed)}
                </span>
                <span className="roundtable__participant-body">
                  <span className="roundtable__participant-name">{cardDisplayName(card, unnamed)}</span>
                  <span className="roundtable__participant-state">{t.studio.roundtable.joined}</span>
                </span>
                <button
                  type="button"
                  className="roundtable__remove"
                  aria-label={t.studio.roundtable.remove(cardDisplayName(card, unnamed))}
                  onClick={() => leaveRoundtable(card.id)}
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
            // Phase 1：不发起真实提问（规格 §3 / §9），只保留输入。
            event.preventDefault()
          }}
        >
          <input
            className="roundtable__ask-input"
            placeholder={ready ? t.studio.roundtable.askPlaceholder : t.studio.roundtable.askPlaceholderIdle}
            aria-label={t.studio.roundtable.askLabel}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={!ready}
          />
          <button
            type="submit"
            className="roundtable__ask-submit"
            disabled={!ready || question.trim() === ''}
          >
            {t.studio.roundtable.start}
          </button>
        </form>
      </footer>
    </>
  )
}
