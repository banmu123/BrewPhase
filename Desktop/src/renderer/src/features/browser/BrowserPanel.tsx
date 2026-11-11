import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserBounds } from '@shared/contracts'
import {
  defaultBrowserBounds,
  fitBrowserBounds,
  isUsableBrowserBounds,
  moveBrowserBounds,
  resizeBrowserBounds,
  type BrowserViewport,
  type ResizeDirection
} from '@shared/browser-layout'
import { displayURL } from '@shared/browser-url'
import { useI18n } from '../../i18n'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalIcon,
  ReloadIcon,
  StopIcon
} from '../../shared/icons'
import { BrowserStartPage } from './BrowserStartPage'
import { browserErrorKey, isRetryableError } from './browser-error'
import { useBrowserStore } from './browser-store'

/** 与 CSS 里 `.browser-panel` 的圆角保持一致；原生 WebContentsView 用同一个值。 */
const PANEL_RADIUS = 10

function viewportSize(): BrowserViewport {
  return {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight
  }
}

type DragState = { pointerId: number; startX: number; startY: number; bounds: BrowserBounds }
type ResizeState = DragState & { direction: ResizeDirection }

/**
 * 内置浏览器浮窗。
 *
 * 它由**两层**拼成，这是理解本文件的前提：
 * - 这一层是 React：标题栏、工具栏、起始页、错误页、八个缩放手柄；
 * - 下面是主进程的 WebContentsView（原生），网页由 Chromium 直接绘制。
 *
 * 原生层永远在 DOM 之上，**任何 CSS z-index 都盖不住它**。所以：
 * 1. 网页显示区域（`stage`）里不能放需要被看见的 React 内容——起始页与错误页
 *    出现时，主进程会把原生层 `setVisible(false)` 让开；
 * 2. 缩放手柄只能落在 stage **外面**的那圈留白里，否则会被网页盖住、拖不到；
 * 3. 面板的矩形是权威——每次变化都把 stage 的 `getBoundingClientRect()`
 *    报给主进程，由它 `setBounds()` 对齐原生层。
 */
export function BrowserPanel() {
  const { t } = useI18n()
  const state = useBrowserStore((store) => store.state)
  const store = useBrowserStore

  const [bounds, setBounds] = useState<BrowserBounds | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)

  const panelRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const resizeRef = useRef<ResizeState | null>(null)
  const lastReported = useRef('')
  const rafRef = useRef<number | null>(null)

  const { visible, url, error, loading, canGoBack, canGoForward, progress, title } = state

  /**
   * 位置只初始化一次（每次从隐藏变可见）：之后由拖动/缩放接管。
   * 不能把它挂到 `state.layout` 上——主进程每次 `setBounds` 都会回写 layout，
   * 那样会把用户正在拖的位置反复重置成上一次持久化的值。
   */
  const layoutRef = useRef(state.layout)
  useEffect(() => {
    layoutRef.current = state.layout
  }, [state.layout])

  useEffect(() => {
    if (!visible) return
    const viewport = viewportSize()
    const stored = layoutRef.current
    setBounds(
      isUsableBrowserBounds(stored) ? fitBrowserBounds(stored, viewport) : defaultBrowserBounds(viewport)
    )
  }, [visible])

  /** 把 stage 的真实矩形报给主进程。rAF 合并，拖动时每帧最多一次 IPC。 */
  const reportBounds = useCallback(() => {
    const element = stageRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const next: BrowserBounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
    const key = `${next.x},${next.y},${next.width},${next.height}`
    if (key === lastReported.current) return
    lastReported.current = key
    void store.getState().setBounds(next)
  }, [store])

  const scheduleReport = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      reportBounds()
    })
  }, [reportBounds])

  // DOM 更新之后立刻测量：拖动/缩放/窗口变化都在这里收口。
  useLayoutEffect(() => {
    if (!visible || !bounds) return
    reportBounds()
  }, [visible, bounds, reportBounds])

  // 窗口尺寸变化：原生层不归 CSS 管，得显式跟着收。
  useEffect(() => {
    if (!visible) return
    const onResize = (): void => {
      setBounds((current) => (current ? fitBrowserBounds(current, viewportSize()) : current))
      scheduleReport()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [visible, scheduleReport])

  // 地址栏跟随真实 URL；正在输入时不抢用户的字。
  useEffect(() => {
    if (editing) return
    setDraft(displayURL(url))
  }, [url, editing])

  // Esc：收起浮窗（输入框内先退出编辑，避免误关）。
  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (editing) {
        setEditing(false)
        setDraft(displayURL(url))
        return
      }
      event.preventDefault()
      void store.getState().hide()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible, editing, url, store])

  if (!visible) return null

  const current = bounds ?? defaultBrowserBounds(viewportSize())
  const showStart = !url && !error
  const showError = error !== null

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    // 标题栏里的按钮/输入框不触发拖动——即使按钮将来嵌进标题栏也成立。
    if ((event.target as HTMLElement).closest('button, input, a, select, textarea')) return
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      bounds: current
    }
    event.preventDefault()
  }

  const moveDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setBounds(
      moveBrowserBounds(drag.bounds, event.clientX - drag.startX, event.clientY - drag.startY, viewportSize())
    )
    scheduleReport()
  }

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    reportBounds()
  }

  const startResize = (direction: ResizeDirection) => (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    resizeRef.current = {
      pointerId: event.pointerId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      bounds: current
    }
  }

  const moveResize = (event: React.PointerEvent<HTMLElement>): void => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    setBounds(
      resizeBrowserBounds(
        resize.bounds,
        event.clientX - resize.startX,
        event.clientY - resize.startY,
        resize.direction,
        viewportSize()
      )
    )
    scheduleReport()
  }

  const endResize = (event: React.PointerEvent<HTMLElement>): void => {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    resizeRef.current = null
    reportBounds()
  }

  const submitAddress = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!draft.trim()) return
    setEditing(false)
    void store.getState().navigate(draft)
    // 失焦，让网页立刻能接收键盘
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  const errorKey = error ? browserErrorKey(error) : null
  const errorMessage = errorKey ? t.browser.error[errorKey] : ''

  return (
    <section
      className="browser-panel"
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label={t.browser.label}
      style={{
        left: `${current.x}px`,
        top: `${current.y}px`,
        width: `${current.width}px`,
        height: `${current.height}px`,
        ['--browser-radius' as string]: `${PANEL_RADIUS}px`
      }}
    >
      <header
        className="browser-panel__titlebar"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title={t.browser.titlebarHint}
      >
        <span className="browser-panel__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="browser-panel__name">
          {title || (url ? t.browser.status.untitled : t.browser.label)}
        </span>
        <button
          type="button"
          className="browser-panel__close"
          aria-label={t.browser.close}
          title={t.browser.close}
          onClick={() => void store.getState().close()}
        >
          ✕
        </button>
      </header>

      <div className="browser-panel__toolbar">
        <button
          type="button"
          className="browser-panel__nav"
          aria-label={t.browser.toolbar.back}
          title={t.browser.toolbar.back}
          disabled={!canGoBack}
          onClick={() => void store.getState().back()}
        >
          <ArrowLeftIcon size={17} />
        </button>
        <button
          type="button"
          className="browser-panel__nav"
          aria-label={t.browser.toolbar.forward}
          title={t.browser.toolbar.forward}
          disabled={!canGoForward}
          onClick={() => void store.getState().forward()}
        >
          <ArrowRightIcon size={17} />
        </button>
        <button
          type="button"
          className="browser-panel__nav"
          aria-label={loading ? t.browser.toolbar.stop : t.browser.toolbar.reload}
          title={loading ? t.browser.toolbar.stop : t.browser.toolbar.reload}
          onClick={() => void (loading ? store.getState().stop() : store.getState().reload())}
        >
          {loading ? <StopIcon size={17} /> : <ReloadIcon size={17} />}
        </button>

        <form className="browser-panel__address" onSubmit={submitAddress}>
          <input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setEditing(true)
            }}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            placeholder={t.browser.toolbar.address}
            aria-label={t.browser.toolbar.address}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          {loading && (
            <span className="browser-panel__spinner" aria-hidden="true" />
          )}
        </form>

        <button
          type="button"
          className="browser-panel__nav"
          aria-label={t.browser.toolbar.openExternal}
          title={t.browser.toolbar.openExternal}
          disabled={!url}
          onClick={() => void store.getState().openExternal()}
        >
          <ExternalIcon size={17} />
        </button>
      </div>

      {loading && (
        <div
          className="browser-panel__progress"
          role="progressbar"
          aria-label={t.browser.status.loading}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <i style={{ transform: `scaleX(${Math.max(progress, 0.05)})` }} />
        </div>
      )}

      {/* 这层是原生网页的落点：网页显示时它只是一块白色占位。 */}
      <div className="browser-panel__stage" ref={stageRef}>
        {showStart && (
          <BrowserStartPage
            recent={state.recent}
            lastVisit={state.lastVisit}
            onSubmit={(value) => void store.getState().navigate(value)}
            onOpen={(target) => void store.getState().open({ url: target })}
          />
        )}
        {showError && error && (
          <div className="browser-error">
            <span className="browser-error__mark" aria-hidden="true">
              !
            </span>
            <h3 className="browser-error__title">{t.browser.error.title}</h3>
            <p className="browser-error__message">{errorMessage}</p>
            <p className="browser-error__url">{displayURL(error.url) || error.url}</p>
            {error.description && (
              <p className="browser-error__detail">{t.browser.error.detail(error.description)}</p>
            )}
            <div className="browser-error__actions">
              {isRetryableError(error) && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void store.getState().reload()}
                >
                  {t.browser.error.retry}
                </button>
              )}
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void store.getState().hide()}
              >
                {t.browser.error.backToStart}
              </button>
            </div>
          </div>
        )}
      </div>

      <ResizeHandles onStart={startResize} onMove={moveResize} onEnd={endResize} />
    </section>
  )
}

/**
 * 八个缩放手柄。它们必须待在 stage 外圈的留白里——落进 stage 就会被原生网页
 * 盖住，鼠标根本够不着。CSS 负责把那圈留白留出来（见 `.browser-panel` 的
 * padding 与 `.browser-panel__handle` 的定位）。
 */
function ResizeHandles(props: {
  onStart: (direction: ResizeDirection) => (event: React.PointerEvent<HTMLElement>) => void
  onMove: (event: React.PointerEvent<HTMLElement>) => void
  onEnd: (event: React.PointerEvent<HTMLElement>) => void
}) {
  const directions: ResizeDirection[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  return (
    <>
      {directions.map((direction) => (
        <div
          key={direction}
          className="browser-panel__handle"
          data-dir={direction}
          aria-hidden="true"
          onPointerDown={props.onStart(direction)}
          onPointerMove={props.onMove}
          onPointerUp={props.onEnd}
          onPointerCancel={props.onEnd}
        />
      ))}
    </>
  )
}
