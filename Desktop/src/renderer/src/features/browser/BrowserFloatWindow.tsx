import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserBounds } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { subscribeBrowserState, useBrowserStore } from './browser-store'
import { BrowserTabStrip } from './BrowserTabStrip'

/**
 * 独立浏览器窗口的壳。
 *
 * 这个窗口加载的是同一份 React 应用（`?bpFloat=<windowId>`），App 检测到参数
 * 后**只渲染这里**——品牌标题栏 + 标签条 + 一块留白的 stage。网页本体是主进程
 * 的 WebContentsView，对齐 stage 的矩形；stage 变化实时上报（rAF 合并）。
 *
 * 「回主窗口」= reattach 当前标签：标签移动但页面实例不动，浮窗空了会自己关。
 */
export function BrowserFloatWindow(props: { windowId: number }) {
  const { t } = useI18n()
  const state = useBrowserStore((store) => store.state)
  const store = useBrowserStore
  const stageRef = useRef<HTMLDivElement>(null)
  const lastReported = useRef('')
  const rafRef = useRef<number | null>(null)
  const [mounted, setMounted] = useState(false)
  const recallDrag = useRef<{ pointerId: number; startX: number; startY: number; tabId: string; lastProbe: number } | null>(null)
  const recallDraggingRef = useRef(false)
  const [recallDragging, setRecallDragging] = useState(false)
  const [recallOverMain, setRecallOverMain] = useState(false)

  useEffect(() => {
    setMounted(true)
    void store.getState().hydrate()
    // 主进程把同一份状态广播到每个浮窗窗口；这里订阅自己收到的那份。
    const unsubscribe = subscribeBrowserState()
    const resize = (): void => report()
    window.addEventListener('resize', resize)
    return () => {
      unsubscribe()
      window.removeEventListener('resize', resize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.windowId])

  const report = (): void => {
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
    void api.browserTabs.floatBounds(props.windowId, next)
  }

  useLayoutEffect(() => {
    if (!mounted) return
    report()
  }, [mounted, state.activeTabId, report])

  // 主窗口视角的 activeTabId 在浮窗里没有意义：浮窗只显示归属自己的标签，
  // 激活态取「本窗口标签条里的第一个激活者」——主进程 floatActivate 会回写。
  const ownTabs = state.tabs.filter((tab) => tab.windowId === props.windowId)
  const activeInFloat = ownTabs.some((tab) => tab.id === state.activeTabId)
    ? state.activeTabId
    : (ownTabs[0]?.id ?? null)
  const activeTab = ownTabs.find((tab) => tab.id === activeInFloat) ?? null

  /**
   * 「拖回卡片架」：按住标题区拖动，松手落在主窗口上即收回。
   *
   * 这不是移动窗口本身——拖动的是**页面**：主进程只把同一个 WebContentsView
   * 接回主窗口并收起浮窗，不重新 loadURL、不碰 Session。指针捕获让光标离开
   * 浮窗后仍能收到 pointerup；落点由主进程的窗口几何裁定。
   */
  const startRecallDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || !activeTab) return
    recallDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      tabId: activeTab.id,
      lastProbe: 0
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 忽略：没有指针捕获时仍可用「收回卡片架」按钮。
    }
    event.preventDefault()
  }

  const moveRecallDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = recallDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6 && !recallDraggingRef.current) return
    recallDraggingRef.current = true
    setRecallDragging(true)
    const now = Date.now()
    if (now - drag.lastProbe < 140) return
    drag.lastProbe = now
    void api.browserTabs
      .dragProbe(event.screenX, event.screenY)
      .then((probe) => setRecallOverMain(probe.mainWindow))
      .catch(() => undefined)
  }

  const endRecallDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = recallDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    recallDrag.current = null
    const wasDragging = recallDraggingRef.current
    recallDraggingRef.current = false
    setRecallDragging(false)
    setRecallOverMain(false)
    if (!wasDragging) return
    void api.browserTabs
      .dragProbe(event.screenX, event.screenY)
      .then((probe) => {
        if (probe.mainWindow) return api.browserTabs.recall(drag.tabId)
        return undefined
      })
      .catch(() => undefined)
  }

  const windows = navigator.platform.toLowerCase().includes('win')
  const titlebarStyle: React.CSSProperties = windows
    ? { paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))' }
    : { paddingLeft: 76 }

  return (
    <div className="bp-float">
      <header className="bp-float__titlebar" style={titlebarStyle}>
        <span
          className="bp-float__ident"
          data-dragging={recallDragging}
          data-over-main={recallOverMain}
          title={t.browser.tabs.recallHint}
          onPointerDown={startRecallDrag}
          onPointerMove={moveRecallDrag}
          onPointerUp={endRecallDrag}
          onPointerCancel={endRecallDrag}
        >
          <span className="bp-float__brand">BREWPHASE</span>
          <span className="bp-float__title">{activeTab?.title || activeTab?.url || t.browser.label}</span>
          {recallDragging && (
            <span className="bp-float__recall-hint">
              {recallOverMain ? t.browser.tabs.recallNow : t.browser.tabs.recallHint}
            </span>
          )}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="bp-float__home"
          title={t.browser.tabs.recall}
          aria-label={t.browser.tabs.recall}
          disabled={!activeTab}
          onClick={() => {
            if (activeTab) void api.browserTabs.recall(activeTab.id)
          }}
        >
          {t.browser.tabs.recall}
        </button>
      </header>

      <BrowserTabStrip
        tabs={ownTabs}
        ownWindowId={props.windowId}
        activeTabId={activeInFloat}
        onActivate={(tabId) => {
          void api.browserTabs.floatActivate(props.windowId, tabId)
        }}
        onClose={(tabId) => void api.browserTabs.closeTab(tabId)}
      />

      {/* 网页画在这块留白上（原生层）。 */}
      <div className="bp-float__stage" ref={stageRef} />
    </div>
  )
}
