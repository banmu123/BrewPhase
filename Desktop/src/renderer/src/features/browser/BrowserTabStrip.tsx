import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserTabInfo } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'

/**
 * 浏览器标签条：主窗口浮窗与独立窗口共用同一组件。
 *
 * 拖动模型（一个手势，三种归宿）：
 * - **标签条内松手** → 排序（以插入线为准，主进程 reorder 保持 tabId）；
 * - **窗口内其他位置松手** → 什么也不做（回到原位）；
 * - **窗口外松手** → pointerup 把屏幕坐标报给主进程 resolveDrop，
 *   由它裁定「接回主窗口 / 移到某个浮窗 / 拆出独立窗口」。
 *
 * 拖动中每 150ms 上报一次光标位置（dragProbe），光标离开窗口时标签上出现
 * 「松手即拆出」提示——没有 OS 级跨窗口拖拽预览可用，这个提示是唯一反馈。
 */

type DragPhase =
  | { kind: 'pending'; pointerId: number; tabId: string; startX: number; startY: number }
  | { kind: 'dragging'; pointerId: number; tabId: string }

const DRAG_THRESHOLD = 6
const PROBE_INTERVAL_MS = 150

export function BrowserTabStrip(props: {
  tabs: BrowserTabInfo[]
  /** 本窗口 id；主窗口传 null（主窗口视角的 detached 判定由主进程 state 给出）。 */
  ownWindowId: number | null
  /** 本窗口当前显示的标签。 */
  activeTabId: string | null
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
}) {
  const { t } = useI18n()
  const stripRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragPhase | null>(null)
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<'before' | 'after' | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** 拖动中光标是否已离开本窗口（松手将拆分）。 */
  const [outsideWindow, setOutsideWindow] = useState(false)

  const clearDrag = useCallback(() => {
    drag.current = null
    setDragTabId(null)
    setDropHint(null)
    setDropTarget(null)
    setOutsideWindow(false)
  }, [])

  useEffect(() => {
    if (!dragTabId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') clearDrag()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragTabId, clearDrag])

  function startDrag(event: React.PointerEvent<HTMLButtonElement>, tab: BrowserTabInfo): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    drag.current = { kind: 'pending', pointerId: event.pointerId, tabId: tab.id, startX: event.clientX, startY: event.clientY }
  }

  function moveDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return

    if (state.kind === 'pending') {
      const moved = Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
      if (moved < DRAG_THRESHOLD) return
      drag.current = { kind: 'dragging', pointerId: state.pointerId, tabId: state.tabId }
      setDragTabId(state.tabId)
    }

    // 插入位置：悬停目标的左右半区（仅当光标在本标签条内）。
    const strip = stripRef.current
    if (strip) {
      const rect = strip.getBoundingClientRect()
      const inside = event.clientY >= rect.top && event.clientY <= rect.bottom && event.clientX >= rect.left && event.clientX <= rect.right
      if (inside) {
        const target = props.tabs.find((tab) => {
          // 必须在本标签条内找：网页卡片也用 data-tab-id，全局 querySelector
          // 会先命中架子上的卡片，落点判定永远失败（真实缺陷，E2E 抓到过）。
          const el = stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${tab.id}"]`)
          if (!el) return false
          const r = el.getBoundingClientRect()
          return event.clientX >= r.left && event.clientX <= r.right
        })
        if (target && target.id !== state.tabId) {
          const el = stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${target.id}"]`)
          const r = el!.getBoundingClientRect()
          setDropTarget(target.id)
          setDropHint(event.clientX < r.left + r.width / 2 ? 'before' : 'after')
        } else {
          setDropTarget(null)
          setDropHint(null)
        }
        setOutsideWindow(false)
      } else {
        setDropTarget(null)
        setDropHint(null)
      }
    }

    // 节流探测：光标是否在本窗口外（拆分提示）。
    const now = Date.now()
    if (now - lastProbe.current > PROBE_INTERVAL_MS) {
      lastProbe.current = now
      void api.browserTabs.dragProbe(event.screenX, event.screenY).then((probe) => {
        setOutsideWindow(probe.windowId === null)
      }).catch(() => undefined)
    }
  }

  const lastProbe = useRef(0)

  function endDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return

    if (state.kind === 'dragging') {
      const strip = stripRef.current
      const rect = strip?.getBoundingClientRect()
      const insideStrip =
        rect && event.clientY >= rect.top && event.clientY <= rect.bottom && event.clientX >= rect.left && event.clientX <= rect.right

      if (insideStrip && dropTarget && dropHint) {
        // 窗口内排序：tabId 不变。
        const before = dropHint === 'before' ? dropTarget : null
        void api.browserTabs.reorder(state.tabId, before)
      } else {
        // 窗口内其他位置：保持原状；窗口外或标签条外：交给主进程裁定归属。
        void api.browserTabs.resolveDrop(state.tabId, event.screenX, event.screenY)
      }
    }
    clearDrag()
  }

  return (
    <div className="browser-tabs" ref={stripRef} role="tablist" aria-label={t.browser.label}>
      {props.tabs.map((tab) => {
        const active = tab.id === props.activeTabId
        const dragging = tab.id === dragTabId
        const isDropTarget = tab.id === dropTarget
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className="browser-tabs__item"
            data-active={active}
            data-detached={tab.detached}
            data-dragging={dragging}
            data-drop-before={isDropTarget && dropHint === 'before'}
            data-drop-after={isDropTarget && dropHint === 'after'}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="browser-tabs__main"
              title={dragging && outsideWindow ? t.browser.tabs.detachHint : tab.title || tab.url}
              onPointerDown={(event) => startDrag(event, tab)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={clearDrag}
              onClick={() => {
                if (!dragging) props.onActivate(tab.id)
              }}
            >
              <span className="browser-tabs__title">
                {tab.loading ? '⏳ ' : ''}
                {tab.title || tab.url || t.browser.tabs.newTab}
              </span>
              {/* 「已拆出」徽章只在主窗口的标签条上有意义；浮窗里它就是本地标签 */}
              {tab.detached && props.ownWindowId === null && (
                <span className="browser-tabs__badge">{t.browser.tabs.detachedBadge}</span>
              )}
              {dragging && outsideWindow && (
                <span className="browser-tabs__detach-hint">{t.browser.tabs.detachHint}</span>
              )}
            </button>
            <button
              type="button"
              className="browser-tabs__close"
              aria-label={t.browser.tabs.closeTab}
              title={t.browser.tabs.closeTab}
              onClick={(event) => {
                event.stopPropagation()
                props.onClose(tab.id)
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
      <button
        type="button"
        className="browser-tabs__add"
        aria-label={t.browser.tabs.newTab}
        title={t.browser.tabs.newTab}
        onClick={() => props.onActivate('')}
      >
        ＋
      </button>
    </div>
  )
}
