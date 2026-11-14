import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clampPanelIntoWorkspace,
  collectSnapEdges,
  resolveMoveWithoutOverlap,
  resolveResizeWithoutOverlap,
  ROUNDTABLE_PANEL_MIN_HEIGHT,
  ROUNDTABLE_PANEL_MIN_WIDTH,
  snapPanelPosition,
  type RoundtablePanelLayout
} from '@shared/roundtable'
import { cardDisplayName } from '@shared/web-cards'
import { useI18n } from '../../i18n'
import { api } from '../../shared/api'
import { useBrowserStore } from '../browser/browser-store'
import { useBrowserPreviewStore } from '../browser/preview-store'
import { useRoundtableLayoutStore } from './roundtable-layout-store'
import { useRoundtableStore } from './roundtable-store'

/**
 * 圆桌自由布局工作空间（Phase 4.2）。
 *
 * **原生视图与渲染层的分工**：WebContentsView 是原生视图，永远盖在 DOM
 * 之上——所以每个面板的 DOM 只画「标题栏 + 边框 + 拖拽手柄」，内容区是
 * 一块**预留的空白矩形**；渲染层测量它的 rects 上报主进程，主进程把原始
 * WebContentsView setBounds 到那个矩形里。标题栏 / 手柄都在 view bounds
 * 之外，天然可点，不存在「用 z-index 盖住网页」的方案。
 *
 * 布局唯一状态在主进程（广播回放）；拖动 / 缩放期间被操作的面板用本地
 * 乐观位置（IPC 往返跟不上指针），落定后以广播为准。面板位置/尺寸经由
 * IPC 流式更新原生视图 bounds——网页跟手，不闪不抖。
 */

export function RoundtableWorkspace(props: { host: 'docked' | 'detached' }) {
  const { t } = useI18n()
  const layout = useRoundtableLayoutStore((state) => state.layout)
  const hydrated = useRoundtableLayoutStore((state) => state.hydrated)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRefs = useRef(new Map<string, HTMLElement>())
  const reportRef = useRef<number | null>(null)

  // 工作区尺寸上报：变化时主进程适配布局并广播。
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      void useRoundtableLayoutStore.getState().setWorkspaceSize(Math.round(width), Math.round(height))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  /** 面板内容区 rects 上报（rAF 节流）：原生视图跟随布局的唯一路径。 */
  const reportRects = useCallback(() => {
    if (reportRef.current !== null) return
    reportRef.current = window.requestAnimationFrame(() => {
      reportRef.current = null
      const rects: Array<{ tabId: string; x: number; y: number; width: number; height: number }> = []
      for (const [tabId, element] of contentRefs.current.entries()) {
        const rect = element.getBoundingClientRect()
        rects.push({ tabId, x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      }
      if (rects.length > 0) useRoundtableLayoutStore.getState().reportBounds(rects)
    })
  }, [])

  // 布局变化 / 容器尺寸变化后重报 rects。
  useEffect(() => {
    reportRects()
  }, [layout, reportRects])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => reportRects())
    observer.observe(container)
    return () => observer.disconnect()
  }, [reportRects])

  const ordered = useMemo(() => [...layout.panels].sort((a, b) => a.z - b.z), [layout.panels])

  /**
   * 显示布局（产品规则：自由布局，但面板互不重叠）。存储位原样保留，
   * 但显示时按 z 序逐个 clamp + 防重叠解析——宿主变小把面板挤到一起时
   * 显示层也不会叠上；原生 view bounds 跟随 DOM rects，自动一致。
   */
  const displayMap = useMemo(() => {
    const map = new Map<string, RoundtablePanelLayout>()
    const placed: RoundtablePanelLayout[] = []
    for (const panel of ordered) {
      const clamped = clampPanelIntoWorkspace(panel, layout.workspace)
      const spot =
        resolveMoveWithoutOverlap(
          { x: clamped.x, y: clamped.y },
          { width: clamped.width, height: clamped.height },
          placed,
          layout.workspace
        ) ?? { x: clamped.x, y: clamped.y }
      const display: RoundtablePanelLayout = { ...clamped, x: spot.x, y: spot.y }
      placed.push(display)
      map.set(panel.tabId, display)
    }
    return map
  }, [ordered, layout.workspace])

  return (
    <div className="rt-workspace" data-host={props.host}>
      <header className="rt-workspace__head">
        <span className="rt-workspace__title">{t.studio.roundtable.workspaceTitle}</span>
        <span className="rt-workspace__count">{t.studio.roundtable.count(layout.panels.length)}</span>
        <span className="spacer" />
        <button
          type="button"
          className="rt-workspace__btn"
          data-active={layout.snapEnabled}
          onClick={() => void useRoundtableLayoutStore.getState().setSnap(!layout.snapEnabled)}
          title={t.studio.roundtable.snapToggle}
        >
          {t.studio.roundtable.snapToggle}
        </button>
        <AddWebPopover />
        {props.host === 'docked' && (
          <button
            type="button"
            className="rt-workspace__btn"
            onClick={() => void useRoundtableStore.getState().detachRoundtable()}
          >
            {t.studio.roundtable.undockAction}
          </button>
        )}
        {props.host === 'docked' && (
          <button type="button" className="rt-workspace__btn" onClick={() => void useRoundtableLayoutStore.getState().exitWorkspace()}>
            {t.studio.roundtable.exitWorkspace}
          </button>
        )}
      </header>
      <div className="rt-workspace__canvas" ref={containerRef}>
        {ordered.map((panel) => (
          <WorkspacePanel
            key={panel.tabId}
            panel={panel}
            display={displayMap.get(panel.tabId) ?? panel}
            onContentRef={(element) => {
              if (element) contentRefs.current.set(panel.tabId, element)
              else contentRefs.current.delete(panel.tabId)
              reportRects()
            }}
          />
        ))}
        {hydrated && ordered.length === 0 && (
          <div className="rt-workspace__empty">
            <p className="rt-workspace__empty-title">{t.studio.roundtable.workspaceEmptyTitle}</p>
            <p className="rt-workspace__empty-hint">{t.studio.roundtable.workspaceEmptyHint}</p>
            <QuickLinks />
          </div>
        )}
      </div>
    </div>
  )
}

/* ============================================================
 * 面板：DOM 画标题栏 / 边框 / 手柄，内容区预留矩形给原生 view。
 * ============================================================ */

const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

function WorkspacePanel(props: {
  panel: RoundtablePanelLayout
  /** 显示位置（clamp + 防重叠解析后）；拖拽起点与渲染都按它来。 */
  display: RoundtablePanelLayout
  onContentRef: (element: HTMLElement | null) => void
}) {
  const { t } = useI18n()
  const tab = useBrowserStore((state) => state.state.tabs.find((item) => item.id === props.panel.tabId))
  const preview = useBrowserPreviewStore((state) => state.previews[props.panel.tabId])
  const move = useRoundtableLayoutStore((state) => state.move)
  const resize = useRoundtableLayoutStore((state) => state.resize)
  const front = useRoundtableLayoutStore((state) => state.front)
  const setDragging = useRoundtableLayoutStore((state) => state.setDragging)
  const leaveRoundtable = useRoundtableStore((state) => state.leaveRoundtable)
  const layout = useRoundtableLayoutStore((state) => state.layout)
  const draggingTabId = useRoundtableLayoutStore((state) => state.draggingTabId)
  const [copied, setCopied] = useState(false)
  const localRef = useRef(props)
  localRef.current = props

  const isDragging = draggingTabId === props.panel.tabId
  const active = layout.activeTabId === props.panel.tabId

  /** 除自己以外的面板（防重叠解析的障碍物）。 */
  const othersOf = (tabId: string): RoundtablePanelLayout[] =>
    useRoundtableLayoutStore.getState().layout.panels.filter((panel) => panel.tabId !== tabId)

  /** 拖动标题栏：本地乐观位置（吸附 + 防重叠）+ rAF 节流的 IPC move。 */
  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const origin = { x: localRef.current.display.x, y: localRef.current.display.y }
    const size = { width: localRef.current.display.width, height: localRef.current.display.height }
    let frame: number | null = null
    let latest = origin
    setDragging(props.panel.tabId)
    void front(props.panel.tabId)

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY
      let next = { x: origin.x + dx, y: origin.y + dy }
      if (layout.snapEnabled) {
        const snapped = snapPanelPosition(
          next,
          size,
          collectSnapEdges(othersOf(props.panel.tabId), props.panel.tabId, useRoundtableLayoutStore.getState().layout.workspace)
        )
        if (snapped) next = snapped
      }
      // 防重叠：预览位置与主进程落库位置同源同算法——看到的不会叠上。
      const resolved = resolveMoveWithoutOverlap(
        next,
        size,
        othersOf(props.panel.tabId),
        useRoundtableLayoutStore.getState().layout.workspace
      )
      if (!resolved) return // 被围死：停在原地（保持上一次有效位置）
      latest = resolved
      if (frame === null) {
        frame = window.requestAnimationFrame(() => {
          frame = null
          void move(props.panel.tabId, latest.x, latest.y)
        })
      }
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (frame !== null) window.cancelAnimationFrame(frame)
      void move(props.panel.tabId, latest.x, latest.y)
      setDragging(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** 边缘 / 四角缩放：自由边被邻居挡住时停在其边缘，不越过对方。 */
  const startResize = (dir: (typeof RESIZE_DIRS)[number], event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startY = event.clientY
    const origin = { ...localRef.current.display }
    let frame: number | null = null
    let latest = { x: origin.x, y: origin.y, width: origin.width, height: origin.height }
    setDragging(props.panel.tabId)
    void front(props.panel.tabId)

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY
      let { x, y, width, height } = origin
      if (dir.includes('e')) width = origin.width + dx
      if (dir.includes('s')) height = origin.height + dy
      if (dir.includes('w')) {
        width = origin.width - dx
        x = origin.x + dx
      }
      if (dir.includes('n')) {
        height = origin.height - dy
        y = origin.y + dy
      }
      width = Math.max(ROUNDTABLE_PANEL_MIN_WIDTH, width)
      height = Math.max(ROUNDTABLE_PANEL_MIN_HEIGHT, height)
      if (dir.includes('w') && width === ROUNDTABLE_PANEL_MIN_WIDTH) x = origin.x + origin.width - width
      if (dir.includes('n') && height === ROUNDTABLE_PANEL_MIN_HEIGHT) y = origin.y + origin.height - height
      // 防重叠：与主进程同一解析——自由边最多到邻居边缘；null = 挤死，保持原状。
      const resolved = resolveResizeWithoutOverlap({ x, y, width, height }, dir, othersOf(props.panel.tabId))
      if (!resolved) return
      latest = resolved
      if (frame === null) {
        frame = window.requestAnimationFrame(() => {
          frame = null
          void resize(props.panel.tabId, latest.x, latest.y, latest.width, latest.height, dir)
        })
      }
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (frame !== null) window.cancelAnimationFrame(frame)
      void resize(props.panel.tabId, latest.x, latest.y, latest.width, latest.height, dir)
      setDragging(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const url = tab?.url ?? ''
  // 幽灵面板：应用重启后 WebContents 必然消失，布局行还在——如实显示
  // 「标签已关闭」，一键重开（rebind 保留原几何），不伪造任何页面内容。
  const isGhost = !tab
  // 显示位置由父级算好（clamp + 防重叠，z 序解析）；存储布局不改写——
  // 拆出归位往返、窗口变化都不会降级用户的摆放。
  const display = props.display

  return (
    <section
      className="rt-panel"
      data-tab-id={props.panel.tabId}
      data-ghost={isGhost ? 'true' : 'false'}
      data-active={active}
      style={{ left: display.x, top: display.y, width: display.width, height: display.height, zIndex: props.panel.z }}
      onPointerDown={() => {
        if (!active) void front(props.panel.tabId)
      }}
    >
      <header
        className="rt-panel__titlebar"
        title={t.studio.roundtable.workspaceDragHint}
        onPointerDown={startDrag}
        onDoubleClick={() => {
          // 焦点模式（Phase 4.3）的预留入口：双击标题栏放大到主工作区。
        }}
      >
        {preview ? (
          <img className="rt-panel__icon" src={preview.dataUrl} alt="" draggable={false} referrerPolicy="no-referrer" />
        ) : (
          <span className="rt-panel__dot" aria-hidden="true" data-loading={tab?.loading ? 'true' : 'false'} />
        )}
        <span className="rt-panel__name" title={isGhost ? props.panel.url : url}>
          {tab
            ? cardDisplayName(tab, t.studio.webShelf.unnamed)
            : isGhost
              ? t.studio.roundtable.ghostTitle
              : props.panel.tabId}
        </span>
        {tab?.loading && <span className="rt-panel__loading" aria-busy="true">{t.studio.roundtable.loadingLabel}</span>}
        <span className="spacer" />
        <button
          type="button"
          className="rt-panel__action"
          title={t.studio.roundtable.refreshAction}
          onClick={(event) => {
            event.stopPropagation()
            if (props.panel.tabId && url) void api.browserTabs.navigate(props.panel.tabId, url)
          }}
        >
          ⟳
        </button>
        <button
          type="button"
          className="rt-panel__action"
          title={t.aiWorkspace.result.copy}
          onClick={(event) => {
            event.stopPropagation()
            const link = isGhost ? props.panel.url : url
            if (!link) return
            void navigator.clipboard.writeText(link).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1_500)
            })
          }}
        >
          {copied ? '✓' : '⧉'}
        </button>
        <button
          type="button"
          className="rt-panel__action rt-panel__action--remove"
          title={t.studio.roundtable.removeAction}
          onClick={(event) => {
            event.stopPropagation()
            void leaveRoundtable(props.panel.tabId)
          }}
        >
          ✕
        </button>
      </header>
      <div
        className="rt-panel__content"
        ref={props.onContentRef}
        data-tab-id={props.panel.tabId}
      >
        {isGhost && (
          <div className="rt-panel__ghost">
            <p className="rt-panel__ghost-hint">{t.studio.roundtable.ghostHint}</p>
            <button
              type="button"
              className="rt-workspace__btn rt-workspace__btn--primary"
              onClick={(event) => {
                event.stopPropagation()
                void useRoundtableLayoutStore
                  .getState()
                  .rebind(props.panel.tabId, props.panel.url)
                  .catch(() => undefined)
              }}
            >
              {t.studio.roundtable.ghostReopen}
            </button>
          </div>
        )}
        {/* 预留矩形：原生 WebContentsView 由主进程 setBounds 对齐到这里。 */}
      </div>
      {RESIZE_DIRS.map((dir) => (
        <span
          key={dir}
          className={`rt-panel__handle rt-panel__handle--${dir}`}
          onPointerDown={(event) => startResize(dir, event)}
        />
      ))}
    </section>
  )
}

/* ============================================================
 * 添加网页：地址输入 + 常用站点快捷方式（只是网址，不是固定 Provider）。
 * ============================================================ */

const QUICK_LINKS: Array<{ label: string; url: string }> = [
  { label: 'ChatGPT', url: 'https://chatgpt.com/' },
  { label: 'Claude', url: 'https://claude.ai/new' },
  { label: 'Gemini', url: 'https://gemini.google.com/' },
  { label: 'Grok', url: 'https://grok.com/' }
]

function AddWebPopover() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const addWeb = useRoundtableLayoutStore((state) => state.addWeb)

  const submit = async (value: string): Promise<void> => {
    setError(null)
    try {
      await addWeb(value)
      setOpen(false)
      setUrl('')
    } catch {
      setError(t.studio.roundtable.addWebInvalid)
    }
  }

  return (
    <div className="rt-workspace__add">
      <button type="button" className="rt-workspace__btn rt-workspace__btn--primary" onClick={() => setOpen((current) => !current)}>
        {t.studio.roundtable.addWeb}
      </button>
      {open && (
        <div className="rt-workspace__add-pop">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit(url.trim())
            }}
          >
            <input
              className="rt-workspace__add-input"
              placeholder={t.studio.roundtable.addWebPlaceholder}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoFocus
            />
            <button type="submit" className="rt-workspace__btn rt-workspace__btn--primary">
              {t.studio.roundtable.addWebSubmit}
            </button>
          </form>
          <div className="rt-workspace__quick">
            {QUICK_LINKS.map((link) => (
              <button key={link.url} type="button" className="rt-workspace__quick-link" onClick={() => void submit(link.url)}>
                {link.label}
              </button>
            ))}
          </div>
          {error && <p className="rt-workspace__add-error">{error}</p>}
        </div>
      )}
    </div>
  )
}

function QuickLinks() {
  const { t } = useI18n()
  const addWeb = useRoundtableLayoutStore((state) => state.addWeb)
  return (
    <div className="rt-workspace__quick">
      {QUICK_LINKS.map((link) => (
        <button key={link.url} type="button" className="rt-workspace__quick-link" onClick={() => void addWeb(link.url)}>
          {link.label}
        </button>
      ))}
      <span className="rt-workspace__quick-hint">{t.studio.roundtable.workspaceQuickHint}</span>
    </div>
  )
}
