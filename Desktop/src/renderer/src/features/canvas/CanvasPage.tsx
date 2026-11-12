import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { Group, Image as KonvaImage, Layer, Line, Rect, Shape, Stage, Text } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { Context } from 'konva/lib/Context'
import type {
  Canvas,
  CanvasNote,
  CanvasNodeWithRecord,
  CanvasStroke,
  CanvasTool,
  CanvasViewport,
  RecordItem
} from '@shared/contracts'
import { screenToWorld, zoomAt, CANVAS_LIMITS } from '@shared/contracts'
import { embedURL } from '@shared/link-embed'
import { nextNodeOrigin, fitViewport } from '@shared/domain/placement'
import { previewFileFor } from './canvas-thumbnail-model'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { useAppStore } from '../../app/store'
import { refreshThemeColors, themeColors } from '../../shared/tokens'
import { useTheme } from '../../shared/useTheme'
import { titleBarPlatform } from '../../shared/platform'
import { Modal } from '../../shared/Modal'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { CanvasThumbnail } from './CanvasThumbnail'
import { EraserIcon, FitIcon, MinusIcon, NoteIcon, PanIcon, PenIcon, PlusIcon, SelectIcon } from '../../shared/icons'

/**
 * Canvas 空间的两级结构（对标 iOS CanvasListView → CanvasWorkspaceView）：
 *
 * - **Gallery**：画布集合页。真实空间缩略图（`CanvasThumbnail`，复刻 iOS
 *   CanvasThumbnailPreview 的选点与包围盒算法）、新建、重命名、删除。
 * - **Workspace**：一块画布的工作区。节点 / 便签 / 笔迹全部**世界坐标**，
 *   Stage 只承担缩放平移；笔迹宽度按绘制时的视口比例折算，屏幕观感稳定。
 *
 * 播放对标 iOS CanvasNodeCard：`playingNodeId` 全局唯一，同一时刻只有一个
 * 节点在播；本地视频走 `<video>`，无本地文件但 Embed 合法（YouTube/B 站，
 * `embedURL` 只由内容 ID 拼）走 iframe；切画布 / 返回 Gallery / 卸载都停。
 * 双击打开原记录（跨页导航走 store）；画布备注只写 `CanvasNode.annotation`，
 * 与 Record.note 是两个字段。
 */

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type StudioTool = CanvasTool | 'select' | 'hand' | 'note'
type LoadState = 'loading' | 'ready' | 'error'

const PEN_COLORS = ['#30372f', '#849779', '#97765a', '#9a9f97', '#a8503f']
const NOTE_COLORS = ['#f6f2df', '#e3e9df', '#e8ebe5', '#f7e8df']
const PICKER_PAGE = 60

/** 某个节点能否播放、走哪条路径（对标 iOS CanvasNodeCard.canPlay）。 */
function playbackOf(node: CanvasNodeWithRecord): 'local' | 'embed' | null {
  if (node.recordCarrier === 'video' && node.recordMediaPath) return 'local'
  const embed = embedURL(node.recordProvider, node.recordPlatformContentID)
  if ((node.recordCarrier === 'video' || node.recordCarrier === 'link') && embed) return 'embed'
  return null
}

/** 全部内容的世界坐标矩形（节点 + 便签 + 笔迹逐点）：装窗计算的唯一输入。 */
function contentRects(
  nodes: CanvasNodeWithRecord[],
  notes: CanvasNote[],
  strokes: CanvasStroke[]
): Array<{ x: number; y: number; width: number; height: number }> {
  const rects: Array<{ x: number; y: number; width: number; height: number }> = []
  for (const node of nodes) {
    rects.push({ x: node.positionX, y: node.positionY, width: node.width, height: node.height })
  }
  for (const note of notes) {
    rects.push({ x: note.positionX, y: note.positionY, width: note.width, height: note.height })
  }
  for (const stroke of strokes) {
    for (let i = 0; i < stroke.points.length; i += 2) {
      rects.push({ x: stroke.points[i], y: stroke.points[i + 1], width: 0, height: 0 })
    }
  }
  return rects
}

export function CanvasPage() {
  const { t, formatDate, formatNumber } = useI18n()

  // 订阅外观：切浅色/深色时这一层重渲染，下面各个 Shape 取色时 `themeColors()`
  // 会发现 `data-theme` 变了并重读（见 shared/tokens.ts）。画布是唯一读不到
  // CSS 的地方，所以也只有这里需要显式订阅——其余界面由 CSS 变量自己换。
  useTheme()

  // ===== 视图层级 =====
  const [view, setView] = useState<'gallery' | 'workspace'>('gallery')
  const [canvases, setCanvases] = useState<Canvas[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  /**
   * 工作区有自己的工具栏，且画布要顶到窗口上沿：这段时间隐藏全局顶栏。
   * 在 layout 阶段切 body class，避免先画一帧带顶栏的布局再跳。
   */
  useLayoutEffect(() => {
    document.body.classList.toggle('canvas-workspace', view === 'workspace')
    return () => document.body.classList.remove('canvas-workspace')
  }, [view])

  // ===== Gallery =====
  const [galleryLoading, setGalleryLoading] = useState(true)

  // ===== Workspace =====
  const [nodes, setNodes] = useState<CanvasNodeWithRecord[]>([])
  const [notes, setNotes] = useState<CanvasNote[]>([])
  const [strokes, setStrokes] = useState<CanvasStroke[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [viewport, setViewport] = useState<CanvasViewport>({ scale: 1, offsetX: 0, offsetY: 0 })
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState({ width: 800, height: 600 })
  const [tool, setTool] = useState<StudioTool>('select')
  const [penColor, setPenColor] = useState(PEN_COLORS[0])
  /** 右侧浮层同一时间只有一个：'picker' 选记录，'inspector' 看选中内容。 */
  const [sidePanel, setSidePanel] = useState<'picker' | 'inspector' | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [dialog, setDialog] = useState<{
    kind: 'create' | 'rename' | 'delete'
    canvasId?: string
    value: string
  } | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [draft, setDraft] = useState<CanvasStroke | null>(null)
  /** 播放状态全局唯一：对标 iOS playingNodeID。 */
  const [playingNodeId, setPlayingNodeId] = useState<string | null>(null)
  /** 右键菜单（DOM，fixed 定位）。 */
  const [contextMenu, setContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  /** 画布备注编辑态（node-panel 内）。 */
  const [annotationDraft, setAnnotationDraft] = useState<{ id: string; value: string } | null>(null)
  /** 内容加载状态：失败不是空画布——保留上一份内容 + 横幅重试。 */
  const [loadState, setLoadState] = useState<LoadState>('loading')

  // ===== Picker（分页 + 多选）=====
  const [pickerRecords, setPickerRecords] = useState<RecordItem[]>([])
  const [pickerHasMore, setPickerHasMore] = useState(false)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerLoadingMore, setPickerLoadingMore] = useState(false)
  const [pickerSearch, setPickerSearch] = useState('')
  const [pickerCarrier, setPickerCarrier] = useState<'all' | 'image' | 'video' | 'link' | 'text'>('all')
  /** 多选跨筛选保留：iOS 同款（picked: [Record]，换载体不清）。 */
  const [pickedItems, setPickedItems] = useState<Map<string, RecordItem>>(new Map())
  const [pickerError, setPickerError] = useState<string | null>(null)

  const active = canvases.find((canvas) => canvas.id === activeId) ?? null
  /**
   * 画布容器元素用**回调 ref** 存进 state：Gallery / Workspace 两级视图下，
   * wrap 元素在首次渲染（Gallery 分支）时还不存在——普通 ref + `[]` 依赖的
   * effect 会在那时拿到 null 然后永远不再执行，ResizeObserver 就挂空了
   * （size 停在默认 800×600，装窗全错）。元素真正挂载时这里触发重渲染。
   */
  const [wrapElement, setWrapElement] = useState<HTMLDivElement | null>(null)
  const panRef = useRef<{ pointerX: number; pointerY: number; offsetX: number; offsetY: number } | null>(null)
  const spaceRef = useRef(false)
  const saveTimer = useRef(0)
  const pickerSeq = useRef(0)
  /** 内容加载请求序号：只有最新一次请求可以更新页面（防跨画布竞态）。 */
  const loadSeq = useRef(0)
  const pickerQueryRef = useRef<{ search: string; carrier: 'all' | 'image' | 'video' | 'link' | 'text'; offset: number }>({
    search: '',
    carrier: 'all',
    offset: 0
  })

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null
  const addedRecordIds = useMemo(() => new Set(nodes.map((node) => node.recordID)), [nodes])

  const openRecord = useAppStore((state) => state.openRecord)
  const openRecordId = useAppStore((state) => state.openRecordId)

  // 顶栏「快速添加 → 新建一块画布」：回到 Gallery 再开这里原有的新建弹窗。
  const setModule = useAppStore((state) => state.setModule)
  const pendingCreate = useAppStore((state) => state.pendingCreate)
  const consumeCreate = useAppStore((state) => state.consumeCreate)
  useEffect(() => {
    if (!pendingCreate) return
    if (consumeCreate() === 'canvas') {
      setView('gallery')
      setActiveId(null)
      setDialog({ kind: 'create', value: t.canvas.newCanvasName })
    }
  }, [pendingCreate, consumeCreate, t])

  const withSave = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    setSaveState('saving')
    try {
      const result = await task()
      setSaveState('saved')
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => setSaveState('idle'), 1600)
      return result
    } catch (cause) {
      setError((cause as Error).message)
      setSaveState('error')
      throw cause
    }
  }, [])

  const loadCanvases = useCallback(async () => {
    try {
      const next = await api.canvas.list()
      setCanvases(next)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setGalleryLoading(false)
    }
  }, [])

  /**
   * 内容加载。请求序号防竞态：快速切换画布时，旧画布的响应返回更晚也**必须**
   * 被丢弃，不能覆盖新画布的数据（用户会把旧内容当成放错位置的数据）。
   *
   * silent（同画布重试/写后刷新）：失败保留上一份有效内容，不把「读不到」画成
   * 空画布；跨画布的切换由 activeId effect 先清空再加载。
   */
  const loadContent = useCallback(async (canvasId: string, silent = false) => {
    const seq = ++loadSeq.current
    if (!silent) setLoadState('loading')
    try {
      const [nextNodes, nextNotes, nextStrokes] = await Promise.all([
        api.canvas.nodes(canvasId),
        api.canvas.notes(canvasId),
        api.canvas.strokes(canvasId)
      ])
      if (seq !== loadSeq.current) return // 过期响应：丢弃
      setNodes(nextNodes)
      setNotes(nextNotes)
      setStrokes(nextStrokes)
      setLoadState('ready')
    } catch (cause) {
      if (seq !== loadSeq.current) return // 过期响应的错误：同样丢弃
      setError((cause as Error).message)
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    void loadCanvases()
    refreshThemeColors()
  }, [loadCanvases])

  // 进入工作区 / 切换画布：清一切上一块画布的痕迹（内容、选中、播放、视角、
  // Picker 会话），再读新内容。旧内容哪怕多显示一帧，都会被当成「放错位置的数据」。
  useEffect(() => {
    setPlayingNodeId(null)
    setSelectedNodeId(null)
    setSelectedNoteId(null)
    setSidePanel(null)
    setContextMenu(null)
    setPickedItems(new Map())
    setEditingNoteId(null)
    fitMeta.current = { didFit: false, width: 0, height: 0, userAdjusted: false }
    setViewport({ scale: 1, offsetX: 0, offsetY: 0 })
    if (!activeId) {
      setNodes([])
      setNotes([])
      setStrokes([])
      setLoadState('loading')
      return
    }
    setNodes([])
    setNotes([])
    setStrokes([])
    setLoadState('loading')
    void loadContent(activeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // MCP / 其他主进程写入后的领域通知：刷新画布列表；当前画布 silent 重取
  // （silent 保留上一份有效内容，不把外部写入画成加载态闪烁）。
  useEffect(
    () =>
      api.app.onChanged((domain) => {
        if (domain !== 'canvas') return
        void loadCanvases()
        if (activeId) void loadContent(activeId, true)
      }),
    [activeId, loadCanvases, loadContent]
  )

  useEffect(() => {
    if (!wrapElement) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(wrapElement)
    return () => observer.disconnect()
  }, [wrapElement])

  useEffect(() => {
    document.body.classList.toggle('canvas-focus', focusMode)
    return () => {
      document.body.classList.toggle('canvas-focus', false)
    }
  }, [focusMode])

  // MARK: - Picker 数据（分页 + 搜索去抖，复用 records.list 的数据库谓词）

  const loadPickerPage = useCallback(async (page: 'first' | 'more') => {
    const query = pickerQueryRef.current
    const seq = ++pickerSeq.current
    if (page === 'first') setPickerLoading(true)
    else setPickerLoadingMore(true)
    try {
      const rows = await api.records.list({
        search: query.search,
        carrier: query.carrier === 'all' ? null : query.carrier,
        tagId: null,
        limit: PICKER_PAGE,
        offset: page === 'first' ? 0 : query.offset
      })
      if (seq !== pickerSeq.current) return
      setPickerRecords((current) => {
        const merged = page === 'first' ? rows : [...current, ...rows]
        const seen = new Set<string>()
        return merged.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
      })
      setPickerHasMore(rows.length === PICKER_PAGE)
      query.offset = page === 'first' ? rows.length : query.offset + rows.length
      setPickerError(null)
    } catch (cause) {
      if (seq === pickerSeq.current) setPickerError((cause as Error).message)
    } finally {
      if (seq !== pickerSeq.current) return // 过期响应：状态交给最新请求
      setPickerLoading(false)
      setPickerLoadingMore(false)
    }
  }, [])

  // 搜索 / 筛选变化：200ms 去抖后重读第一页（iOS CanvasRecordPicker 同款节奏）。
  useEffect(() => {
    if (sidePanel !== 'picker') return
    const timer = window.setTimeout(() => {
      pickerQueryRef.current = { search: pickerSearch.trim(), carrier: pickerCarrier, offset: 0 }
      void loadPickerPage('first')
    }, 200)
    return () => window.clearTimeout(timer)
  }, [pickerSearch, pickerCarrier, sidePanel, loadPickerPage])

  // 面板打开时载入第一页；面板一旦离开 picker（关闭/切 Inspector），未提交的
  // 多选立即清空——iOS 同款取消语义，不会残留到下一次打开。
  useEffect(() => {
    if (sidePanel !== 'picker') {
      setPickedItems(new Map())
      return
    }
    if (pickerRecords.length === 0 && !pickerHasMore) {
      pickerQueryRef.current = { search: pickerSearch.trim(), carrier: pickerCarrier, offset: 0 }
      void loadPickerPage('first')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidePanel])

  // MARK: - Fit All / 100%

  /**
   * 装窗元数据（对标 iOS CanvasWorkspaceView.fitIfNeeded）：
   * 只在「第一次看到非空内容」或「尺寸变了且用户还没动过视角」时装窗；
   * 用户一旦平移/缩放过，自动装窗不再覆盖他的视角。
   */
  const fitMeta = useRef({ didFit: false, width: 0, height: 0, userAdjusted: false })
  const markUserAdjusted = useCallback(() => {
    fitMeta.current.userAdjusted = true
  }, [])

  const fitAll = useCallback(() => {
    setViewport(fitViewport(contentRects(nodes, notes, strokes), size, 80, CANVAS_LIMITS))
    fitMeta.current = {
      didFit: true,
      width: size.width,
      height: size.height,
      userAdjusted: true
    }
  }, [nodes, notes, strokes, size])

  // 首次拿到非空内容、或（用户没动过时）尺寸变化：自动装窗。
  // 第一次布局时 ResizeObserver 可能还没报出真实尺寸，按占位值装窗会把
  // 整块内容推出屏幕——这是 iOS 在 fittedSize != canvasSize 时重装窗的原因。
  useEffect(() => {
    if (view !== 'workspace' || !activeId || size.width <= 0) return
    const meta = fitMeta.current
    const empty = nodes.length === 0 && notes.length === 0 && strokes.length === 0
    if (empty) {
      if (meta.didFit) {
        fitMeta.current = { didFit: false, width: 0, height: 0, userAdjusted: false }
        setViewport({ scale: 1, offsetX: 0, offsetY: 0 })
      }
      return
    }
    const sizeChanged = meta.width !== size.width || meta.height !== size.height
    if (!meta.didFit || (!meta.userAdjusted && sizeChanged)) {
      setViewport(fitViewport(contentRects(nodes, notes, strokes), size, 80, CANVAS_LIMITS))
      fitMeta.current = { didFit: true, width: size.width, height: size.height, userAdjusted: meta.userAdjusted }
    }
  }, [view, activeId, size, nodes, notes, strokes])

  // MARK: - 快捷键（输入框聚焦时让路）

  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null
      return !!element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceRef.current = true
      if (isTyping(event.target)) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') return
      switch (event.key.toLowerCase()) {
        case 'v': setTool('select'); break
        case 'h': setTool('hand'); break
        case 'p': setTool('pen'); break
        case 'e': setTool('eraser'); break
        case 'n': setTool('note'); break
        case '0': fitAll(); break
        case '1': markUserAdjusted(); setViewport((current) => zoomAt(current, 1, { x: size.width / 2, y: size.height / 2 })); break
        case 'escape':
          if (contextMenu) setContextMenu(null)
          else if (playingNodeId) setPlayingNodeId(null)
          else if (editingNoteId) setEditingNoteId(null)
          else if (dialog) setDialog(null)
          else if (switcherOpen) setSwitcherOpen(false)
          else if (sidePanel) setSidePanel(null)
          else { setSelectedNodeId(null); setSelectedNoteId(null); setTool('select') }
          break
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitAll, size, sidePanel, editingNoteId, dialog, switcherOpen, contextMenu, playingNodeId])

  // MARK: - 写操作

  const createNote = useCallback(async (): Promise<void> => {
    if (!active) return
    const center = screenToWorld({ x: size.width / 2, y: size.height / 2 }, viewport)
    try {
      const note = await withSave(() => api.canvas.createNote(active.id, center.x - 110, center.y - 90))
      setNotes((current) => [...current, note])
      setSelectedNoteId(note.id)
      setEditingNoteId(note.id)
    } catch {
      await loadContent(active.id, true) // 失败恢复：以数据库为准
    }
  }, [active, size, viewport, withSave, loadContent])

  const updateNote = useCallback(
    async (note: CanvasNote): Promise<void> => {
      const previous = notes.find((item) => item.id === note.id)
      setNotes((current) => current.map((item) => (item.id === note.id ? note : item)))
      try {
        await withSave(() => api.canvas.updateNote(note))
      } catch {
        if (previous) setNotes((current) => current.map((item) => (item.id === previous.id ? previous : item)))
        else if (active) await loadContent(active.id, true)
      }
    },
    [withSave, notes, active, loadContent]
  )

  const removeNote = useCallback(
    async (id: string): Promise<void> => {
      const previous = notes.find((note) => note.id === id)
      setNotes((current) => current.filter((note) => note.id !== id))
      setSelectedNoteId(null)
      setEditingNoteId(null)
      try {
        await withSave(() => api.canvas.removeNote(id))
      } catch {
        // 失败恢复：便签还在库里，把它放回来——界面不能显示「已删除」的假象
        if (previous) setNotes((current) => [...current, previous].sort((a, b) => a.createdAt - b.createdAt))
        else if (active) await loadContent(active.id, true)
      }
    },
    [withSave, notes, active, loadContent]
  )

  const removeNodeById = useCallback(
    async (nodeId: string): Promise<void> => {
      const previous = nodes.find((node) => node.id === nodeId)
      setNodes((current) => current.filter((node) => node.id !== nodeId))
      if (selectedNodeId === nodeId) setSelectedNodeId(null)
      if (playingNodeId === nodeId) setPlayingNodeId(null)
      try {
        await withSave(() => api.canvas.removeNode(nodeId))
      } catch {
        // 失败恢复：节点还在库里，放回原位——不允许「看起来删了、其实没删」
        if (previous) setNodes((current) => [...current, previous])
        else if (active) await loadContent(active.id, true)
      }
    },
    [nodes, selectedNodeId, playingNodeId, withSave, active, loadContent]
  )

  const saveAnnotation = useCallback(async (): Promise<void> => {
    if (!annotationDraft) return
    const { id, value } = annotationDraft
    const previousAnnotation = nodes.find((node) => node.id === id)?.annotation ?? ''
    setNodes((current) => current.map((node) => (node.id === id ? { ...node, annotation: value.trim() } : node)))
    setAnnotationDraft(null)
    try {
      await withSave(() => api.canvas.annotateNode(id, value))
    } catch {
      // 失败恢复：备注没存进去，回滚显示——不允许「看起来保存了、库里没有」
      setNodes((current) => current.map((node) => (node.id === id ? { ...node, annotation: previousAnnotation } : node)))
    }
  }, [annotationDraft, nodes, withSave])

  const addImage = useCallback(async (): Promise<void> => {
    if (!active) return
    try {
      const imported = await api.records.importImage()
      if (!imported) return
      const created = await api.records.create({
        carrier: 'image',
        title: imported.fileName.replace(/\.[a-z0-9]+$/i, ''),
        note: '',
        urlString: '',
        canonicalURL: null,
        platformContentID: null,
        provider: 'generic',
        sourceName: '',
        authorName: '',
        summary: '',
        mediaPath: imported.fileName,
        previewPath: imported.previewName,
        tagIds: []
      })
      const center = screenToWorld({ x: size.width / 2, y: size.height / 2 }, viewport)
      const node = await withSave(() => api.canvas.addNode(active.id, created.id))
      await api.canvas.moveNode(node.id, center.x - node.width / 2, center.y - node.height / 2)
      await loadContent(active.id, true)
    } catch {
      await loadContent(active.id, true) // 任一步失败：以数据库为准恢复
    }
  }, [active, size, viewport, withSave, loadContent])

  /**
   * 批量加入。两个可靠性要点：
   * 1. **最终坐标进 occupied**——节点被搬进视野后，occupied 必须存 moveNode
   *    之后的坐标，否则同批次后续节点仍按它原来的位置避让，会叠在它上面；
   * 2. **部分失败明确告知**——某一条失败不代表整批回滚，已成功的内容要列出。
   */
  const addPicked = useCallback(async (): Promise<void> => {
    if (!active || pickedItems.size === 0) return
    const batch: Array<{ x: number; y: number; width: number; height: number }> = nodes.map((node) => ({
      x: node.positionX,
      y: node.positionY,
      width: node.width,
      height: node.height
    }))
    const viewLeft = -viewport.offsetX / viewport.scale
    const viewTop = -viewport.offsetY / viewport.scale
    const succeeded: string[] = []
    let lastError: string | null = null
    for (const record of pickedItems.values()) {
      try {
        const node = await withSave(() => api.canvas.addNode(active.id, record.id))
        let finalX = node.positionX
        let finalY = node.positionY
        const inside =
          node.positionX + node.width > viewLeft &&
          node.positionX < viewLeft + size.width / viewport.scale &&
          node.positionY + node.height > viewTop &&
          node.positionY < viewTop + size.height / viewport.scale
        if (!inside) {
          const origin = nextNodeOrigin({
            occupied: batch,
            width: node.width,
            height: node.height,
            startX: Math.round(viewLeft),
            startY: Math.round(viewTop)
          })
          await api.canvas.moveNode(node.id, origin.x, origin.y)
          finalX = origin.x
          finalY = origin.y
        }
        batch.push({ x: finalX, y: finalY, width: node.width, height: node.height })
        succeeded.push(record.title || t.canvas.untitledRecord)
      } catch (cause) {
        lastError = (cause as Error).message
        break // 连续失败大概率是同一原因：停止本批，已成功的保留
      }
    }
    if (succeeded.length > 0) {
      setPickedItems((current) => {
        const next = new Map(current)
        for (const record of pickedItems.values()) {
          if (succeeded.includes(record.title || t.canvas.untitledRecord)) next.delete(record.id)
        }
        return next
      })
      await loadContent(active.id, true)
    }
    if (lastError) {
      const skipped = pickedItems.size - succeeded.length
      setPickerError(t.canvas.picker.batchPartial(succeeded.length, succeeded, skipped, lastError))
    }
  }, [active, pickedItems, nodes, viewport, size, withSave, loadContent, t])

  // MARK: - 笔迹

  const beginStroke = useCallback(
    (screen: { x: number; y: number }) => {
      if (!active) return
      const world = screenToWorld(screen, viewport)
      setDraft({
        id: crypto.randomUUID(),
        canvasID: active.id,
        toolType: 'pen',
        points: [world.x, world.y],
        color: penColor,
        width: Math.max(0.75, 2 / viewport.scale),
        opacity: 1,
        zIndex: 5,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    },
    [active, penColor, viewport]
  )

  const extendStroke = useCallback(
    (screen: { x: number; y: number }) => {
      const world = screenToWorld(screen, viewport)
      setDraft((current) => (current ? { ...current, points: [...current.points, world.x, world.y] } : current))
    },
    [viewport]
  )

  const endStroke = useCallback(async () => {
    const stroke = draft
    setDraft(null)
    if (!stroke || stroke.points.length < 4) return
    setStrokes((current) => [...current, stroke])
    try {
      await withSave(() => api.canvas.saveStroke(stroke))
    } catch {
      setStrokes((current) => current.filter((item) => item.id !== stroke.id)) // 笔迹没存进去，回滚
    }
  }, [draft, withSave])

  const eraseStroke = useCallback(
    async (id: string) => {
      const previous = strokes.find((stroke) => stroke.id === id)
      setStrokes((current) => current.filter((stroke) => stroke.id !== id))
      try {
        await withSave(() => api.canvas.removeStroke(id))
      } catch {
        if (previous) setStrokes((current) => [...current, previous].sort((a, b) => a.createdAt - b.createdAt))
        else if (active) await loadContent(active.id, true)
      }
    },
    [withSave, strokes, active, loadContent]
  )

  // MARK: - Dialog 确认执行

  const confirmDialog = useCallback(async (): Promise<void> => {
    if (!dialog) return
    if (dialog.kind === 'create') {
      const created = await api.canvas.create(dialog.value.trim() || t.canvas.untitledCanvas)
      await loadCanvases()
      setActiveId(created.id)
      setView('workspace')
      setDialog(null)
      return
    }
    if (dialog.kind === 'rename' && dialog.canvasId) {
      await withSave(() => api.canvas.rename(dialog.canvasId!, dialog.value.trim() || t.canvas.untitledCanvas))
      await loadCanvases()
      setDialog(null)
      return
    }
    if (dialog.kind === 'delete' && dialog.canvasId) {
      await api.canvas.remove(dialog.canvasId)
      if (activeId === dialog.canvasId) {
        setActiveId(null)
        setView('gallery')
      }
      await loadCanvases()
      setDialog(null)
    }
  }, [dialog, activeId, loadCanvases, withSave, t])

  // MARK: - Gallery

  if (view === 'gallery') {
    return (
      <div className="page">
        <header className="page-header">
          <div className="page-header__titles">
            <button type="button" className="back-link" onClick={() => setModule('studio')}>
              <span aria-hidden="true">←</span> {t.studio.back}
            </button>
            <h1 className="page-title">{t.canvas.title}</h1>
            <p className="page-sub">{t.canvas.gallerySubtitle(canvases.length)}</p>
          </div>
          <div className="page-header__actions">
            <button
              className="button button--primary"
              onClick={() => setDialog({ kind: 'create', value: t.canvas.newCanvasName })}
            >
              {t.canvas.gallery.newCanvas}
            </button>
          </div>
        </header>

        <div className="page-body page-body--gutter">
          {error && <div className="error">{error}</div>}
          {galleryLoading ? (
            <div className="empty">{t.canvas.gallery.loading}</div>
          ) : canvases.length === 0 ? (
            <div className="empty" style={{ padding: '60px 0' }}>
              <strong>{t.canvas.gallery.emptyTitle}</strong>
              <div style={{ marginTop: 8, color: 'var(--ink-faint)' }}>{t.canvas.gallery.emptyBody}</div>
            </div>
          ) : (
            <div className="gallery-grid">
              {canvases.map((canvas) => (
                <div key={canvas.id} className="gallery-card">
                  <button className="gallery-card__open" onClick={() => { setActiveId(canvas.id); setView('workspace') }}>
                    <CanvasThumbnail canvas={canvas} />
                    <span className="gallery-card__body">
                      <span className="gallery-card__name">{canvas.name || t.canvas.untitledCanvas}</span>
                      {canvas.note && <span className="gallery-card__note">{canvas.note}</span>}
                      <span className="gallery-card__meta">{t.canvas.updatedAt(formatDate(canvas.updatedAt))}</span>
                    </span>
                  </button>
                  <span className="gallery-card__actions">
                    <button
                      className="button button--ghost"
                      title={t.canvas.gallery.rename}
                      aria-label={t.canvas.gallery.renameNamed(canvas.name || t.canvas.untitledCanvas)}
                      onClick={() => setDialog({ kind: 'rename', canvasId: canvas.id, value: canvas.name || '' })}
                    >
                      ✎
                    </button>
                    <button
                      className="button button--ghost"
                      title={t.canvas.gallery.deleteCanvas}
                      aria-label={t.canvas.gallery.deleteNamed(canvas.name || t.canvas.untitledCanvas)}
                      onClick={() => setDialog({ kind: 'delete', canvasId: canvas.id, value: '' })}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {dialog && (
          <CanvasDialog
            dialog={dialog}
            onChange={(value) => setDialog((current) => (current ? { ...current, value } : current))}
            onCancel={() => setDialog(null)}
            onConfirm={() => void confirmDialog()}
          />
        )}
      </div>
    )
  }

  // MARK: - Workspace

  return (
    <div className="page">
      <div className="canvas-shell">
        <div className="canvas-topbar" data-platform={titleBarPlatform()}>
          <button
            className="button button--ghost canvas-back"
            aria-label={t.canvas.workspace.back}
            title={t.canvas.workspace.back}
            onClick={() => {
              setPlayingNodeId(null)
              setView('gallery')
            }}
          >
            ‹
          </button>
          {active && (
            <div className="switcher-wrap">
              <button
                className="switcher-trigger"
                data-open={switcherOpen}
                onClick={() => setSwitcherOpen((value) => !value)}
                aria-label={t.canvas.workspace.switchCanvas}
              >
                <span className="switcher-trigger__name">{active.name || t.canvas.untitledCanvas}</span>
                <span className="switcher-trigger__arrow">▾</span>
              </button>
              {switcherOpen && (
                <>
                  <div className="pop-backdrop" onClick={() => setSwitcherOpen(false)} />
                  <div className="switcher-pop" role="menu">
                    <div className="row row--between" style={{ padding: '2px 4px 10px' }}>
                      <span className="overline" style={{ margin: 0 }}>{t.canvas.workspace.myCanvases}</span>
                      <button
                        className="button button--ghost"
                        onClick={() => setDialog({ kind: 'create', value: t.canvas.newCanvasName })}
                      >
                        {t.canvas.workspace.newCanvas}
                      </button>
                    </div>
                    <div className="switcher-list">
                      {canvases.map((canvas) => (
                        <div key={canvas.id} className="switcher-item" data-active={canvas.id === active.id}>
                          <button
                            className="switcher-item__main"
                            onClick={() => {
                              setActiveId(canvas.id)
                              setSwitcherOpen(false)
                            }}
                          >
                            <span className="switcher-item__name">{canvas.name || t.canvas.untitledCanvas}</span>
                            <span className="switcher-item__meta">
                              {t.canvas.updatedAt(formatDate(canvas.updatedAt))}
                            </span>
                          </button>
                          <button
                            className="switcher-item__more"
                            title={t.canvas.gallery.rename}
                            onClick={() => setDialog({ kind: 'rename', canvasId: canvas.id, value: canvas.name || '' })}
                          >
                            ✎
                          </button>
                          <button
                            className="switcher-item__more"
                            title={t.canvas.gallery.deleteCanvas}
                            onClick={() => setDialog({ kind: 'delete', canvasId: canvas.id, value: '' })}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      {canvases.length === 0 && <div className="empty">{t.canvas.gallery.emptyTitle}</div>}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          <SaveBadge state={saveState} />
          <span className="spacer" />
          <button className="button button--ghost" title={t.canvas.workspace.focusMode} onClick={() => setFocusMode(true)}>
            {t.canvas.workspace.focus}
          </button>
        </div>

        {/* 视口可观测性：E2E 与调试用（世界坐标 → 屏幕换算的唯一事实来源） */}
        <div
          className={`canvas-wrap canvas-cursor--${tool}`}
          ref={setWrapElement}
          data-viewport={`${viewport.scale},${viewport.offsetX},${viewport.offsetY}`}
        >
          {active ? (
            <Stage
              width={size.width}
              height={size.height}
              scaleX={viewport.scale}
              scaleY={viewport.scale}
              x={viewport.offsetX}
              y={viewport.offsetY}
              onWheel={(event) => {
                event.evt.preventDefault()
                markUserAdjusted()
                const stage = event.target.getStage()
                const pointer = stage?.getPointerPosition()
                if (!pointer) return
                if (event.evt.ctrlKey) {
                  const factor = event.evt.deltaY > 0 ? 0.94 : 1.06
                  setViewport((current) => zoomAt(current, current.scale * factor, pointer))
                  return
                }
                setViewport((current) => ({
                  ...current,
                  offsetX: current.offsetX - event.evt.deltaX,
                  offsetY: current.offsetY - event.evt.deltaY
                }))
              }}
              onMouseDown={(event) => {
                const stage = event.target.getStage()
                if (!stage) return
                const pointer = stage.getPointerPosition()
                if (!pointer) return
                const onBlank = event.target === stage
                const wantPan =
                  spaceRef.current || tool === 'hand' || event.evt.button === 1 || (onBlank && tool === 'select')
                if (wantPan) {
                  if (onBlank) {
                    setSelectedNodeId(null)
                    setSelectedNoteId(null)
                  }
                  markUserAdjusted()
                  panRef.current = {
                    pointerX: pointer.x,
                    pointerY: pointer.y,
                    offsetX: viewport.offsetX,
                    offsetY: viewport.offsetY
                  }
                  return
                }
                if (tool === 'pen') {
                  beginStroke(pointer)
                  return
                }
                if (tool === 'note' && onBlank) {
                  const world = screenToWorld(pointer, viewport)
                  void (async () => {
                    if (!active) return
                    const note = await withSave(() => api.canvas.createNote(active.id, world.x, world.y))
                    setNotes((current) => [...current, note])
                    setSelectedNoteId(note.id)
                    setEditingNoteId(note.id)
                    setTool('select')
                  })()
                  return
                }
                if (onBlank) {
                  setSelectedNodeId(null)
                  setSelectedNoteId(null)
                }
              }}
              onMouseMove={(event) => {
                const stage = event.target.getStage()
                const pointer = stage?.getPointerPosition()
                if (!pointer) return
                const pan = panRef.current
                if (pan) {
                  setViewport((current) => ({
                    ...current,
                    offsetX: pan.offsetX + (pointer.x - pan.pointerX),
                    offsetY: pan.offsetY + (pointer.y - pan.pointerY)
                  }))
                  return
                }
                if (draft) extendStroke(pointer)
              }}
              onMouseUp={() => {
                panRef.current = null
                void endStroke()
              }}
              onMouseLeave={() => {
                panRef.current = null
                void endStroke()
              }}
            >
              <Layer listening={false}>
                <DotGrid width={size.width} height={size.height} viewport={viewport} />
              </Layer>
              <Layer>
                {strokes.map((stroke) => (
                  <Line
                    key={stroke.id}
                    points={stroke.points}
                    stroke={stroke.color}
                    strokeWidth={stroke.width}
                    opacity={stroke.opacity}
                    lineCap="round"
                    lineJoin="round"
                    tension={0.35}
                    onClick={() => {
                      if (tool === 'eraser') void eraseStroke(stroke.id)
                    }}
                  />
                ))}
                {draft && (
                  <Line
                    points={draft.points}
                    stroke={draft.color}
                    strokeWidth={draft.width}
                    opacity={draft.opacity}
                    lineCap="round"
                    lineJoin="round"
                    tension={0.35}
                  />
                )}
              </Layer>
              <Layer>
                {nodes.map((node) => (
                  <CanvasNodeShape
                    key={node.id}
                    node={node}
                    selected={node.id === selectedNodeId}
                    draggable={tool === 'select'}
                    isPlaying={playingNodeId === node.id}
                    onSelect={() => {
                      setSelectedNodeId(node.id)
                      setSidePanel('inspector')
                      setAnnotationDraft(null)
                    }}
                    onOpenRecord={() => {
                      if (playingNodeId === node.id) return // 播放中点击让给播放器
                      openRecord(node.recordID)
                    }}
                    onTogglePlay={() => {
                      // 播放面（video/iframe）与播放按钮同心。若在 pointerdown 的
                      // 处理里立即渲染，真实 pointerup 会落进新 DOM 而不冒泡回
                      // Konva——capture 永不释放，之后画布上所有点击都失效
                      // （Konva 的 canClick 要求 down/up 的 target 一致）。
                      // 推迟到宏任务：up 先回到画布，再出现播放面。
                      window.setTimeout(() => {
                        setPlayingNodeId((current) => (current === node.id ? null : node.id))
                      }, 0)
                    }}
                    onContextMenu={(x, y) => {
                      setSelectedNodeId(node.id)
                      setContextMenu({ nodeId: node.id, x, y })
                    }}
                    onMoved={async (positionX, positionY) => {
                      const previous = { x: node.positionX, y: node.positionY }
                      setNodes((current) =>
                        current.map((item) => (item.id === node.id ? { ...item, positionX, positionY } : item))
                      )
                      try {
                        await withSave(() => api.canvas.moveNode(node.id, positionX, positionY))
                      } catch {
                        // 失败回滚：节点回到拖动前的世界坐标（保存状态已由 withSave 标 error）
                        setNodes((current) =>
                          current.map((item) =>
                            item.id === node.id ? { ...item, positionX: previous.x, positionY: previous.y } : item
                          )
                        )
                      }
                    }}
                    onLiveResize={(width, height) => {
                      setNodes((current) =>
                        current.map((item) => (item.id === node.id ? { ...item, width, height } : item))
                      )
                    }}
                    onResized={async (width, height) => {
                      const previous = { width: node.width, height: node.height }
                      try {
                        await withSave(() => api.canvas.resizeNode(node.id, width, height))
                      } catch {
                        setNodes((current) =>
                          current.map((item) =>
                            item.id === node.id ? { ...item, width: previous.width, height: previous.height } : item
                          )
                        )
                      }
                    }}
                  />
                ))}
                {notes.map((note) => (
                  <NoteShape
                    key={note.id}
                    note={note}
                    selected={note.id === selectedNoteId}
                    draggable={tool === 'select'}
                    onSelect={() => {
                      setSelectedNoteId(note.id)
                      setSidePanel('inspector')
                      setAnnotationDraft(null)
                    }}
                    onDoubleClick={() => {
                      setSelectedNoteId(note.id)
                      setEditingNoteId(note.id)
                    }}
                    onMoved={async (positionX, positionY) => {
                      const previous = { x: note.positionX, y: note.positionY }
                      setNotes((current) =>
                        current.map((item) => (item.id === note.id ? { ...item, positionX, positionY } : item))
                      )
                      try {
                        await withSave(() => api.canvas.updateNote({ ...note, positionX, positionY }))
                      } catch {
                        setNotes((current) =>
                          current.map((item) =>
                            item.id === note.id ? { ...item, positionX: previous.x, positionY: previous.y } : item
                          )
                        )
                      }
                    }}
                  />
                ))}
              </Layer>
            </Stage>
          ) : (
            <div className="canvas-empty">{t.canvas.workspace.noCanvas}</div>
          )}

          {active && loadState === 'loading' && nodes.length === 0 && (
            <div className="canvas-loading">{t.canvas.workspace.loading}</div>
          )}

          {active && loadState === 'error' && (
            <div className="canvas-failure">
              <span>{t.canvas.workspace.loadFailed}</span>
              <button className="button" onClick={() => active && void loadContent(active.id)}>
                {t.canvas.workspace.reload}
              </button>
            </div>
          )}

          {active && loadState === 'ready' && nodes.length === 0 && notes.length === 0 && strokes.length === 0 && (
            <CanvasEmptyState
              onAddRecord={() => setSidePanel('picker')}
              onAddImage={() => void addImage()}
              onAddNote={() => void createNote()}
              onStartDraw={() => setTool('pen')}
            />
          )}

          {active && tool === 'note' && <div className="canvas-hint">{t.canvas.workspace.noteHint}</div>}

          <StudioToolbar
            tool={tool}
            penColor={penColor}
            pickerActive={sidePanel === 'picker'}
            onTool={setTool}
            onPenColor={setPenColor}
            onNote={() => void createNote()}
            onAddImage={() => void addImage()}
            onAddRecord={() => setSidePanel((value) => (value === 'picker' ? null : 'picker'))}
          />

          {/* 缩放控件与底部 Studio 工具栏同一套胶囊语言：一个容器、一条分隔线、
              步进区（− 读数 +）和视图预设区分开。旧实现是五个各自带白底的方块，
              固定 40px 宽度装不下「适配」，中文会撑破按钮，看起来像散落的标签。 */}
          <div className="canvas-hud" role="group" aria-label={t.canvas.zoom.controls}>
            <button
              className="canvas-hud__icon"
              aria-label={t.canvas.zoom.out}
              title={t.canvas.zoom.out}
              onClick={() => { markUserAdjusted(); setViewport((current) => zoomAt(current, current.scale / 1.15, { x: size.width / 2, y: size.height / 2 })) }}
            >
              <MinusIcon size={16} />
            </button>
            <span className="canvas-hud__zoom mono">{formatNumber(Math.round(viewport.scale * 100))}%</span>
            <button
              className="canvas-hud__icon"
              aria-label={t.canvas.zoom.in}
              title={t.canvas.zoom.in}
              onClick={() => { markUserAdjusted(); setViewport((current) => zoomAt(current, current.scale * 1.15, { x: size.width / 2, y: size.height / 2 })) }}
            >
              <PlusIcon size={16} />
            </button>
            <span className="canvas-hud__divider" />
            <button
              className="canvas-hud__action"
              aria-label={t.canvas.zoom.fit}
              title={t.canvas.zoom.fitTitle}
              onClick={() => fitAll()}
            >
              <FitIcon size={15} />
              {t.canvas.zoom.fitLabel}
            </button>
            <button
              className="canvas-hud__action mono"
              aria-label={t.canvas.zoom.reset}
              title={t.canvas.zoom.resetTitle}
              onClick={() => { markUserAdjusted(); setViewport((current) => zoomAt(current, 1, { x: size.width / 2, y: size.height / 2 })) }}
            >
              1:1
            </button>
          </div>

          {/* 添加记录：独立 Picker（搜索走 records.list 数据库谓词 + 分页 + 多选） */}
          {sidePanel === 'picker' && active && (
            <aside className="picker-panel" role="dialog" aria-label={t.canvas.picker.title}>
              <div className="row row--between" style={{ marginBottom: 4 }}>
                <span className="overline" style={{ margin: 0 }}>{t.canvas.picker.title}</span>
                <button
                  className="button button--ghost"
                  aria-label={t.canvas.workspace.closePanel}
                  onClick={() => setSidePanel(null)}
                >
                  ✕
                </button>
              </div>
              <p className="page-sub" style={{ margin: '0 0 10px' }}>{t.canvas.picker.subtitle}</p>

              <input
                placeholder={t.canvas.picker.searchPlaceholder}
                value={pickerSearch}
                onChange={(event) => setPickerSearch(event.target.value)}
                style={{ marginBottom: 10 }}
              />

              <div className="chips" style={{ marginBottom: 12 }}>
                {([
                  ['all', t.canvas.carrier.all],
                  ['image', t.canvas.carrier.image],
                  ['video', t.canvas.carrier.video],
                  ['link', t.canvas.carrier.link],
                  ['text', t.canvas.carrier.text]
                ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      className="chip"
                      data-active={pickerCarrier === key}
                      onClick={() => setPickerCarrier(key)}
                    >
                      {label}
                    </button>
                  )
                )}
              </div>

              <div
                className="picker-list"
                onScroll={(event) => {
                  const element = event.currentTarget
                  if (!pickerHasMore || pickerLoading || pickerLoadingMore) return
                  if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) {
                    void loadPickerPage('more')
                  }
                }}
              >
                {pickerRecords.map((record) => {
                  const already = addedRecordIds.has(record.id)
                  const isOn = pickedItems.has(record.id)
                  return (
                    <button
                      key={record.id}
                      className="add-card"
                      disabled={already}
                      style={{ opacity: already ? 0.5 : 1 }}
                      onClick={() => {
                        if (already) return
                        setPickedItems((current) => {
                          const next = new Map(current)
                          if (next.has(record.id)) next.delete(record.id)
                          else next.set(record.id, record)
                          return next
                        })
                      }}
                    >
                      {record.carrier === 'text' ? (
                        <span className="add-card__thumb add-card__thumb--text">
                          {(record.title || record.summary || record.note || t.canvas.carrier[record.carrier]).slice(0, 2)}
                        </span>
                      ) : previewFileFor(record.carrier, record.previewPath, record.mediaPath) ? (
                        <img
                          className="add-card__thumb"
                          src={api.records.mediaUrl(
                            previewFileFor(record.carrier, record.previewPath, record.mediaPath)!
                          )}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <span className="add-card__thumb add-card__thumb--text">
                          {record.carrier === 'video' ? '▶' : '↗'}
                        </span>
                      )}
                      <span className="add-card__body">
                        <span className="add-card__title">{record.title || t.canvas.untitledRecord}</span>
                        <span className="add-card__meta">
                          {t.canvas.carrier[record.carrier]}
                          {already && t.canvas.picker.alreadyOnCanvas}
                          {isOn && t.canvas.picker.selected}
                        </span>
                      </span>
                      <span className={`add-card__check${isOn ? ' add-card__check--on' : ''}`} aria-hidden>
                        {isOn ? '✓' : ''}
                      </span>
                    </button>
                  )
                })}
                {pickerLoading && <div className="empty">{t.canvas.picker.loading}</div>}
                {pickerLoadingMore && <div className="empty">{t.canvas.picker.loadingMore}</div>}
                {!pickerLoading && pickerRecords.length === 0 && (
                  <div className="empty">
                    {t.canvas.picker.empty}
                    {pickerSearch.trim() && (
                      <button className="button" style={{ marginTop: 8 }} onClick={() => setPickerSearch('')}>
                        {t.canvas.picker.clearSearch}
                      </button>
                    )}
                  </div>
                )}
                {pickerError && <div className="error">{pickerError}</div>}
              </div>

              {pickedItems.size > 0 && (
                <button className="button button--primary picker-join" onClick={() => void addPicked()}>
                  {t.canvas.picker.addCount(pickedItems.size)}
                </button>
              )}
            </aside>
          )}

          {/* 选中内容：节点 / 便签 inspector（备注编辑只写 CanvasNode.annotation） */}
          {sidePanel === 'inspector' && active && (selectedNode || selectedNote) && (
            <aside className="node-panel" role="dialog" aria-label={t.canvas.inspector.title}>
              <div className="row row--between" style={{ marginBottom: 12 }}>
                <span className="overline" style={{ margin: 0 }}>{t.canvas.inspector.overline}</span>
                <button
                  className="button button--ghost"
                  aria-label={t.canvas.workspace.closePanel}
                  onClick={() => setSidePanel(null)}
                >
                  ✕
                </button>
              </div>

              {selectedNode ? (
                <div className="stack">
                  <div className="note">{selectedNode.recordTitle || t.canvas.untitledRecord}</div>
                  <div className="note mono">
                    {selectedNode.width}×{selectedNode.height} · ({selectedNode.positionX.toFixed(0)},{' '}
                    {selectedNode.positionY.toFixed(0)})
                  </div>
                  {playbackOf(selectedNode) && (
                    <button
                      className="button button--primary"
                      onClick={() =>
                        setPlayingNodeId((current) => (current === selectedNode.id ? null : selectedNode.id))
                      }
                    >
                      {playingNodeId === selectedNode.id ? t.canvas.inspector.stopPlay : t.canvas.inspector.play}
                    </button>
                  )}

                  {annotationDraft && annotationDraft.id === selectedNode.id ? (
                    <>
                      <span className="overline">{t.canvas.inspector.annotationLabel}</span>
                      <textarea
                        value={annotationDraft.value}
                        placeholder={t.canvas.inspector.annotationPlaceholder}
                        autoFocus
                        onChange={(event) =>
                          setAnnotationDraft({ id: selectedNode.id, value: event.target.value })
                        }
                      />
                      <div className="row">
                        <button className="button button--primary" onClick={() => void saveAnnotation()}>
                          {t.common.save}
                        </button>
                        <button className="button" onClick={() => setAnnotationDraft(null)}>
                          {t.common.cancel}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      {selectedNode.annotation && (
                        <div className="note" style={{ fontStyle: 'italic', color: 'var(--ink-soft)' }}>
                          {t.canvas.inspector.annotationQuote(selectedNode.annotation)}
                        </div>
                      )}
                      <button
                        className="button"
                        onClick={() => setAnnotationDraft({ id: selectedNode.id, value: selectedNode.annotation })}
                      >
                        {t.canvas.inspector.editAnnotation}
                      </button>
                    </>
                  )}

                  <button className="button button--danger" onClick={() => void removeNodeById(selectedNode.id)}>
                    {t.canvas.inspector.remove}
                  </button>
                  <div className="note">{t.canvas.inspector.removeHint}</div>
                </div>
              ) : selectedNote ? (
                <NoteEditor
                  note={selectedNote}
                  onChange={(next) => void updateNote(next)}
                  onRemove={() => void removeNote(selectedNote.id)}
                />
              ) : null}
            </aside>
          )}

          {/* 右键菜单：打开原记录 / 原始来源 / 备注 / 移除 */}
          {contextMenu && (
            <>
              <div className="pop-backdrop" onClick={() => setContextMenu(null)} onContextMenu={(event) => { event.preventDefault(); setContextMenu(null) }} />
              <div className="node-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
                {(() => {
                  const node = nodes.find((item) => item.id === contextMenu.nodeId)
                  if (!node) return null
                  return (
                    <>
                      <button role="menuitem" onClick={() => { openRecord(node.recordID); setContextMenu(null) }}>
                        {t.canvas.contextMenu.openRecord}
                      </button>
                      {node.recordURLString && (
                        <button
                          role="menuitem"
                          onClick={() => {
                            window.open(node.recordURLString, '_blank')
                            setContextMenu(null)
                          }}
                        >
                          {t.canvas.contextMenu.openSource}
                        </button>
                      )}
                      <button
                        role="menuitem"
                        onClick={() => {
                          setSelectedNodeId(node.id)
                          setAnnotationDraft({ id: node.id, value: node.annotation })
                          setSidePanel('inspector')
                          setContextMenu(null)
                        }}
                      >
                        {t.canvas.inspector.editAnnotation}
                      </button>
                      <button
                        role="menuitem"
                        className="node-context-menu__danger"
                        onClick={() => {
                          void removeNodeById(node.id)
                          setContextMenu(null)
                        }}
                      >
                        {t.canvas.inspector.remove}
                      </button>
                    </>
                  )
                })()}
              </div>
            </>
          )}

          {/* 播放面（DOM overlay，跟随视口）：本地视频 <video>；Embed 走 embedURL 白名单 */}
          {playingNodeId &&
            (() => {
              const node = nodes.find((item) => item.id === playingNodeId)
              if (!node) return null
              return (
                <NodePlaySurface
                  node={node}
                  viewport={viewport}
                  wrapElement={wrapElement}
                  onStop={() => setPlayingNodeId(null)}
                />
              )
            })()}

          {editingNoteId && selectedNote && (
            <NoteEditorOverlay
              note={selectedNote}
              viewport={viewport}
              onChange={(next) => void updateNote(next)}
              onClose={() => setEditingNoteId(null)}
            />
          )}

          {dialog && (
            <CanvasDialog
              dialog={dialog}
              onChange={(value) => setDialog((current) => (current ? { ...current, value } : current))}
              onCancel={() => setDialog(null)}
              onConfirm={() => void confirmDialog()}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// MARK: - 播放面

/**
 * 节点内播放：fixed 定位在节点的**窗口矩形**上。
 *
 * 坐标换算唯一入口：Stage 内坐标（世界 × scale + offset）必须再加画布容器的
 * 窗口偏移——fixed 的参照系是窗口视口，直接用 Stage 坐标会整体偏移一个顶栏。
 * 尺寸严格等于节点的屏幕矩形（iOS 节点内嵌语义）：缩小时播放器跟着小，
 * 不额外放大遮挡相邻节点；窗口尺寸变化由 ResizeObserver 驱动重渲染。
 */
function NodePlaySurface(props: {
  node: CanvasNodeWithRecord
  viewport: CanvasViewport
  wrapElement: HTMLDivElement | null
  onStop: () => void
}) {
  const { node, viewport, wrapElement } = props
  const { t } = useI18n()
  const [, forceTick] = useState(0)
  // 窗口/容器尺寸变化 → 重取 getBoundingClientRect（fixed 坐标随布局走）。
  // handler 在 effect 内定义一次：add 与 remove 必须是同一个引用。
  useEffect(() => {
    if (!wrapElement) return
    const bump = () => forceTick((tick) => tick + 1)
    const observer = new ResizeObserver(bump)
    observer.observe(wrapElement)
    window.addEventListener('resize', bump)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', bump)
    }
  }, [wrapElement])
  const rect = wrapElement?.getBoundingClientRect()
  const left = (rect?.left ?? 0) + node.positionX * viewport.scale + viewport.offsetX
  const top = (rect?.top ?? 0) + node.positionY * viewport.scale + viewport.offsetY
  const width = node.width * viewport.scale
  const height = node.height * viewport.scale
  const embed = embedURL(node.recordProvider, node.recordPlatformContentID)
  const wantsLocal = node.recordCarrier === 'video' && !!node.recordMediaPath
  // 本地文件加载失败 → 回退 Embed；两者都不可用 → 错误 + 打开来源。
  const [localFailed, setLocalFailed] = useState(false)
  const useLocal = wantsLocal && !localFailed
  useEffect(() => {
    setLocalFailed(false)
  }, [node.recordMediaPath])

  let body: React.ReactNode
  if (useLocal) {
    body = (
      <video
        key={node.recordMediaPath ?? 'local'}
        src={api.records.mediaUrl(node.recordMediaPath!)}
        controls
        autoPlay
        onError={() => setLocalFailed(true)}
      />
    )
  } else if (embed) {
    body = (
      <iframe
        src={embed}
        title={t.canvas.player.videoTitle}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
      />
    )
  } else {
    body = (
      <div className="node-play-surface__error">
        <span>{t.canvas.player.loadFailed}</span>
        {node.recordURLString && (
          <button className="button" onClick={() => window.open(node.recordURLString, '_blank')}>
            {t.canvas.player.openInBrowser}
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className="node-play-surface"
      style={{ left, top, width, height }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {body}
      <button
        className="node-play-surface__stop"
        aria-label={t.canvas.player.stop}
        title={t.canvas.player.stopTitle}
        onClick={props.onStop}
      >
        ⏸
      </button>
    </div>
  )
}

// MARK: - Gallery 对话框

function CanvasDialog(props: {
  dialog: { kind: 'create' | 'rename' | 'delete'; canvasId?: string; value: string }
  onChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const { dialog } = props
  const { t } = useI18n()

  // 删除是纯确认：标题说清动作，正文说清后果，动作区靠右。
  // 走共享确认框，和记录 / 豆子 / 同步冲突的删除保持同一种形状。
  if (dialog.kind === 'delete') {
    return (
      <ConfirmDialog
        title={t.canvas.dialog.deleteTitle}
        description={t.canvas.dialog.deleteBody}
        confirmLabel={t.canvas.dialog.confirmDelete}
        cancelLabel={t.common.cancel}
        tone="danger"
        onConfirm={props.onConfirm}
        onCancel={props.onCancel}
      />
    )
  }

  const isCreate = dialog.kind === 'create'
  return (
    <Modal
      title={isCreate ? t.canvas.dialog.createTitle : t.canvas.dialog.renameTitle}
      onClose={props.onCancel}
      width="sm"
      footer={
        <>
          <button className="button" type="button" onClick={props.onCancel}>
            {t.common.cancel}
          </button>
          <button className="button button--primary" type="button" onClick={props.onConfirm}>
            {t.common.confirm}
          </button>
        </>
      }
    >
      <input
        value={dialog.value}
        autoFocus
        placeholder={t.canvas.dialog.namePlaceholder}
        aria-label={t.canvas.dialog.namePlaceholder}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') props.onConfirm()
        }}
      />
    </Modal>
  )
}

// MARK: - 工具栏

function StudioToolbar(props: {
  tool: StudioTool
  penColor: string
  pickerActive: boolean
  onTool: (tool: StudioTool) => void
  onPenColor: (color: string) => void
  onNote: () => void
  onAddImage: () => void
  onAddRecord: () => void
}) {
  const { t } = useI18n()
  // 图标与导航栏同一套线性 SVG（不再用 ✋ 这类彩色 emoji：字重、基线、
  // 选中态都由 currentColor 统一控制）。
  const items: Array<{ key: StudioTool; hint: string; icon: React.ReactNode }> = [
    { key: 'select', hint: t.canvas.tools.selectHint, icon: <SelectIcon size={18} /> },
    { key: 'hand', hint: t.canvas.tools.handHint, icon: <PanIcon size={18} /> },
    { key: 'pen', hint: t.canvas.tools.penHint, icon: <PenIcon size={18} /> },
    { key: 'eraser', hint: t.canvas.tools.eraserHint, icon: <EraserIcon size={18} /> },
    { key: 'note', hint: t.canvas.tools.noteHint, icon: <NoteIcon size={18} /> }
  ]
  return (
    <div className="studio-toolbar">
      {items.map((item) => (
        <button
          key={item.key}
          className="studio-toolbar__tool"
          data-active={props.tool === item.key}
          title={item.hint}
          aria-label={item.hint}
          onClick={() => props.onTool(item.key)}
        >
          {item.icon}
        </button>
      ))}
      {props.tool === 'pen' && (
        <span className="studio-toolbar__colors">
          {PEN_COLORS.map((color) => (
            <button
              key={color}
              className="studio-toolbar__color"
              style={{ background: color }}
              data-active={props.penColor === color}
              aria-label={t.canvas.tools.penColor(color)}
              onClick={() => props.onPenColor(color)}
            />
          ))}
        </span>
      )}
      <span className="studio-toolbar__divider" />
      <button
        className="studio-toolbar__tool studio-toolbar__tool--wide"
        title={t.canvas.toolbar.newNoteTitle}
        onClick={props.onNote}
      >
        {t.canvas.toolbar.note}
      </button>
      <button
        className="studio-toolbar__tool studio-toolbar__tool--wide"
        title={t.canvas.toolbar.importImageTitle}
        onClick={props.onAddImage}
      >
        {t.canvas.toolbar.image}
      </button>
      <button
        className="studio-toolbar__tool studio-toolbar__tool--wide"
        data-active={props.pickerActive}
        title={t.canvas.toolbar.addRecordTitle}
        onClick={props.onAddRecord}
      >
        {t.canvas.toolbar.record}
      </button>
    </div>
  )
}

function SaveBadge({ state }: { state: SaveState }) {
  const { t } = useI18n()
  if (state === 'idle') return null
  return (
    <span className="canvas-save" data-state={state}>
      {state === 'saving' ? t.common.saving : state === 'saved' ? t.canvas.save.saved : t.canvas.save.failed}
    </span>
  )
}

// MARK: - 便签

function NoteShape(props: {
  note: CanvasNote
  selected: boolean
  draggable: boolean
  onSelect: () => void
  onDoubleClick: () => void
  onMoved: (x: number, y: number) => void | Promise<void>
}) {
  const colors = themeColors()
  const { t } = useI18n()
  return (
    <Group
      x={props.note.positionX}
      y={props.note.positionY}
      draggable={props.draggable}
      onClick={props.onSelect}
      onTap={props.onSelect}
      onDblClick={props.onDoubleClick}
      onDblTap={props.onDoubleClick}
      onDragEnd={(event) => {
        void props.onMoved(event.target.x(), event.target.y())
      }}
    >
      <Rect
        width={props.note.width}
        height={props.note.height}
        fill={props.note.color}
        cornerRadius={14}
        stroke={props.selected ? colors.sage : colors.hairline}
        strokeWidth={props.selected ? 1.5 : 1}
        shadowColor="#30372f"
        shadowOpacity={0.08}
        shadowBlur={10}
        shadowOffsetY={3}
      />
      <Text
        x={14}
        y={12}
        width={props.note.width - 28}
        text={props.note.title || t.canvas.note.defaultTitle}
        fontSize={13}
        fontStyle="600"
        fontFamily={KONVA_FONT}
        fill={colors.ink}
        lineHeight={1.3}
        wrap="word"
        ellipsis
        height={22}
      />
      <Text
        x={14}
        y={40}
        width={props.note.width - 28}
        height={props.note.height - 54}
        text={props.note.body || t.canvas.note.defaultBody}
        fontSize={12}
        fontFamily={KONVA_FONT}
        fill={colors.inkSoft}
        lineHeight={1.5}
        wrap="word"
        ellipsis
      />
    </Group>
  )
}

function NoteEditor(props: {
  note: CanvasNote
  onChange: (next: CanvasNote) => void
  onRemove: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="stack">
      <input
        value={props.note.title}
        placeholder={t.canvas.note.titlePlaceholder}
        onChange={(event) => void props.onChange({ ...props.note, title: event.target.value })}
      />
      <textarea
        value={props.note.body}
        placeholder={t.canvas.note.bodyPlaceholder}
        onChange={(event) => void props.onChange({ ...props.note, body: event.target.value })}
      />
      <div className="row">
        {NOTE_COLORS.map((color) => (
          <button
            key={color}
            className="studio-toolbar__color"
            style={{ background: color }}
            data-active={props.note.color === color}
            aria-label={t.canvas.note.colorLabel(color)}
            onClick={() => void props.onChange({ ...props.note, color })}
          />
        ))}
        <span style={{ flex: 1 }} />
        <button className="button button--danger" onClick={props.onRemove}>
          {t.canvas.note.delete}
        </button>
      </div>
    </div>
  )
}

/** 双击便签后的就地编辑浮层（屏幕坐标定位）。 */
function NoteEditorOverlay(props: {
  note: CanvasNote
  viewport: CanvasViewport
  onChange: (next: CanvasNote) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const left = props.note.positionX * props.viewport.scale + props.viewport.offsetX
  const top = props.note.positionY * props.viewport.scale + props.viewport.offsetY
  return (
    <div
      className="note-editor-overlay"
      style={{
        left: Math.min(left, window.innerWidth - 330),
        top: Math.min(top, window.innerHeight - 280),
        width: Math.max(260, props.note.width * props.viewport.scale)
      }}
    >
      <input
        value={props.note.title}
        placeholder={t.canvas.note.titlePlaceholder}
        autoFocus
        onChange={(event) => void props.onChange({ ...props.note, title: event.target.value })}
      />
      <textarea
        value={props.note.body}
        placeholder={t.canvas.note.bodyPlaceholder}
        onChange={(event) => void props.onChange({ ...props.note, body: event.target.value })}
      />
      <div className="row">
        {NOTE_COLORS.map((color) => (
          <button
            key={color}
            className="studio-toolbar__color"
            style={{ background: color }}
            data-active={props.note.color === color}
            aria-label={t.canvas.note.colorLabel(color)}
            onClick={() => void props.onChange({ ...props.note, color })}
          />
        ))}
        <span style={{ flex: 1 }} />
        <button className="button" onClick={props.onClose}>
          {t.canvas.note.done}
        </button>
      </div>
    </div>
  )
}

// MARK: - 节点（对标 iOS CanvasNodeCard 的四类内容 + 独立播放按钮）

function CanvasNodeShape(props: {
  node: CanvasNodeWithRecord
  selected: boolean
  draggable: boolean
  isPlaying: boolean
  onSelect: () => void
  onOpenRecord: () => void
  onTogglePlay: () => void
  onContextMenu: (screenX: number, screenY: number) => void
  onMoved: (x: number, y: number) => void | Promise<void>
  onLiveResize?: (width: number, height: number) => void
  onResized?: (width: number, height: number) => void | Promise<void>
}) {
  const { node, isPlaying } = props
  const { t } = useI18n()
  const playback = playbackOf(node)
  // 按载体选预览文件（视频本体绝不当图片）；播放中封面不需要再加载。
  const image = useLocalImage(
    isPlaying && playback
      ? null
      : previewFileFor(node.recordCarrier, node.recordPreviewPath, node.recordMediaPath)
  )
  const colors = themeColors()
  const radius = 14

  return (
    <Group
      x={node.positionX}
      y={node.positionY}
      draggable={props.draggable}
      onClick={props.onSelect}
      onTap={props.onSelect}
      onDblClick={() => {
        if (!isPlaying) props.onOpenRecord()
      }}
      onDblTap={() => {
        if (!isPlaying) props.onOpenRecord()
      }}
      onContextMenu={(event: KonvaEventObject<PointerEvent>) => {
        event.cancelBubble = true
        props.onContextMenu(event.evt.clientX, event.evt.clientY)
      }}
      onDragEnd={(event) => {
        void props.onMoved(event.target.x(), event.target.y())
      }}
    >
      {/* 交互层：透明命中区域覆盖整卡（视觉元素全部 listening={false}）。 */}
      <Rect width={node.width} height={node.height} fill="rgba(255,255,255,0.001)" />

      {node.recordCarrier === 'image' && (
        <MediaCover
          node={node}
          image={image}
          colors={colors}
          radius={radius}
          selected={props.selected}
          missingSymbol="▣"
          fallbackTitle={t.canvas.untitledRecord}
        />
      )}
      {node.recordCarrier === 'video' && (
        <>
          <MediaCover
            node={node}
            image={image}
            colors={colors}
            radius={radius}
            selected={props.selected}
            missingSymbol="▶"
            fallbackTitle={t.canvas.untitledVideo}
          />
          {playback !== null && !isPlaying && <PlayBadge onTogglePlay={props.onTogglePlay} node={node} />}
        </>
      )}
      {node.recordCarrier === 'link' && (
        <LinkCardBody
          node={node}
          image={image}
          isPlaying={isPlaying}
          canPlay={playback === 'embed'}
          colors={colors}
          radius={radius}
          selected={props.selected}
          onTogglePlay={props.onTogglePlay}
          onOpenSource={() => window.open(node.recordURLString, '_blank')}
        />
      )}
      {node.recordCarrier === 'text' && (
        <TextCardBody node={node} colors={colors} radius={radius} selected={props.selected} />
      )}

      {props.selected && (
        <>
          <Rect
            width={node.width}
            height={node.height}
            cornerRadius={radius}
            stroke={colors.sage}
            strokeWidth={1.5}
            listening={false}
          />
          <Rect
            x={node.width - 7}
            y={node.height - 7}
            width={14}
            height={14}
            fill={colors.sage}
            cornerRadius={4}
            draggable
            onDragMove={(event) => {
              const nextW = Math.max(120, event.target.x() + 7)
              const nextH = Math.max(90, event.target.y() + 7)
              event.target.position({ x: nextW - 7, y: nextH - 7 })
              props.onLiveResize?.(nextW, nextH)
            }}
            onDragEnd={(event) => {
              void props.onResized?.(event.target.x() + 7, event.target.y() + 7)
            }}
          />
        </>
      )}
    </Group>
  )
}

/**
 * 媒体卡封面（图片卡与视频卡共用）：整卡裁剪图 + 底部渐变标题区
 * （白字标题 + 斜体画布备注，iOS mediaCaption）；图片缺失落 MissingMediaBody。
 */
function MediaCover(props: {
  node: CanvasNodeWithRecord
  image: HTMLImageElement | null
  colors: ReturnType<typeof themeColors>
  radius: number
  selected: boolean
  /** 图片缺失占位符：图片卡 ▣ / 视频卡 ▶ */
  missingSymbol: string
  /** 标题缺失时的兜底文案（区分图片/视频） */
  fallbackTitle: string
}) {
  const { node, image, colors } = props
  if (!image) {
    return <MissingMediaBody node={node} symbol={props.missingSymbol} colors={colors} radius={props.radius} />
  }
  return (
    <Group clipFunc={(ctx) => roundedRectPath(ctx, 0, 0, node.width, node.height, props.radius)}>
      <KonvaImage
        image={image}
        width={node.width}
        height={node.height}
        crop={coverCrop(image, node.width, node.height)}
        listening={false}
      />
      {/* 渐变标题区：透明 → 墨色 */}
      <Rect
        y={node.height - captionHeight(node)}
        width={node.width}
        height={captionHeight(node)}
        fillLinearGradientStartPoint={{ x: 0, y: 0 }}
        fillLinearGradientEndPoint={{ x: 0, y: captionHeight(node) }}
        fillLinearGradientColorStops={[0, 'rgba(20,24,18,0)', 1, 'rgba(20,24,18,0.72)']}
        listening={false}
      />
      <Text
        x={12}
        y={node.height - captionHeight(node) + 10}
        width={node.width - 24}
        text={node.recordTitle || props.fallbackTitle}
        fontSize={12.5}
        fontStyle="600"
        fontFamily={KONVA_FONT}
        fill="#ffffff"
        wrap="word"
        ellipsis
        height={20}
        listening={false}
      />
      {node.annotation && (
        <Text
          x={12}
          y={node.height - captionHeight(node) + 32}
          width={node.width - 24}
          text={`❝ ${node.annotation}`}
          fontSize={10}
          fontStyle="italic"
          fontFamily={KONVA_FONT}
          fill="rgba(255,255,255,0.85)"
          wrap="word"
          ellipsis
          height={captionHeight(node) - 38}
          listening={false}
        />
      )}
    </Group>
  )
}

/** 链接卡：封面 / 来源 / 标题 / 摘要 / 打开来源 / 播放（iOS linkCard）。 */
function LinkCardBody(props: {
  node: CanvasNodeWithRecord
  image: HTMLImageElement | null
  isPlaying: boolean
  canPlay: boolean
  colors: ReturnType<typeof themeColors>
  radius: number
  selected: boolean
  onTogglePlay: () => void
  onOpenSource: () => void
}) {
  const { node, image, colors } = props
  const { t } = useI18n()
  const coverHeight = Math.max(60, Math.min(160, node.height * 0.5))
  const bodyTop = coverHeight
  const bodyHeight = node.height - coverHeight
  return (
    <>
      <Group clipFunc={(ctx) => roundedRectPath(ctx, 0, 0, node.width, node.height, props.radius)}>
        <Rect width={node.width} height={node.height} fill={colors.card} listening={false} />
        {image ? (
          <KonvaImage image={image} width={node.width} height={coverHeight} listening={false} />
        ) : (
          <Rect width={node.width} height={coverHeight} fill={colors.well} listening={false} />
        )}
        <Rect y={bodyTop} width={node.width} height={bodyHeight} fill={colors.card} listening={false} />
        <Text
          x={12}
          y={bodyTop + 10}
          width={node.width - 24}
          text={node.recordTitle || t.canvas.untitledLink}
          fontSize={12.5}
          fontStyle="600"
          fontFamily={KONVA_FONT}
          fill={colors.ink}
          wrap="word"
          ellipsis
          height={32}
          listening={false}
        />
        <Text
          x={12}
          y={bodyTop + 44}
          width={node.width - 24}
          text={node.recordSourceName || providerHostOf(node)}
          fontSize={10.5}
          fontFamily={KONVA_FONT}
          fill={colors.inkFaint}
          wrap="word"
          ellipsis
          height={16}
          listening={false}
        />
        {node.recordSummary && bodyHeight > 78 && (
          <Text
            x={12}
            y={bodyTop + 62}
            width={node.width - 24}
            height={bodyHeight - 74}
            text={node.recordSummary}
            fontSize={10.5}
            fontFamily={KONVA_FONT}
            fill={colors.inkSoft}
            lineHeight={1.4}
            wrap="word"
            ellipsis
            listening={false}
          />
        )}
        {node.annotation && (
          <Text
            x={12}
            y={node.height - 24}
            width={node.width - 24}
            text={`❝ ${node.annotation}`}
            fontSize={10}
            fontStyle="italic"
            fontFamily={KONVA_FONT}
            fill={colors.inkFaint}
            wrap="word"
            ellipsis
            height={20}
            listening={false}
          />
        )}
      </Group>
      {/* 打开来源：独立按钮（iOS arrow.up.right badge） */}
      {node.recordURLString && (
        <Group x={node.width - 30} y={bodyTop + 8} onClick={(event) => { event.cancelBubble = true; props.onOpenSource() }}>
          <Rect width={22} height={22} cornerRadius={6} fill="rgba(255,255,255,0.001)" />
          <Text text="↗" fontSize={13} fontFamily={KONVA_FONT} fill={colors.inkFaint} width={22} height={22} align="center" verticalAlign="middle" />
        </Group>
      )}
      {props.canPlay && !props.isPlaying && (
        <PlayBadge onTogglePlay={props.onTogglePlay} node={node} small centerY={coverHeight / 2} />
      )}
    </>
  )
}

/** 文字卡：标题 + 正文预览 + 备注行（iOS textCard）。 */
function TextCardBody(props: {
  node: CanvasNodeWithRecord
  colors: ReturnType<typeof themeColors>
  radius: number
  selected: boolean
}) {
  const { node, colors } = props
  const { t } = useI18n()
  const hasTitle = !!node.recordTitle.trim()
  return (
    <>
      <Rect
        width={node.width}
        height={node.height}
        fill={colors.card}
        cornerRadius={props.radius}
        stroke={props.selected ? colors.sage : colors.hairline}
        strokeWidth={props.selected ? 1.5 : 1}
        shadowColor="#30372f"
        shadowOpacity={0.06}
        shadowBlur={8}
        shadowOffsetY={2}
      />
      {hasTitle && (
        <Text
          x={14}
          y={14}
          width={node.width - 28}
          text={node.recordTitle}
          fontSize={13}
          fontStyle="600"
          fontFamily={KONVA_FONT}
          fill={colors.ink}
          lineHeight={1.4}
          wrap="word"
          ellipsis
          height={38}
          listening={false}
        />
      )}
      <Text
        x={14}
        y={hasTitle ? 56 : 14}
        width={node.width - 28}
        height={node.height - (hasTitle ? 92 : 48)}
        text={node.recordNote || t.canvas.textCard.noBody}
        fontSize={12}
        fontFamily={KONVA_FONT}
        fill={colors.inkSoft}
        lineHeight={1.55}
        wrap="word"
        ellipsis
        listening={false}
      />
      {node.annotation && (
        <Text
          x={14}
          y={node.height - 30}
          width={node.width - 28}
          text={`❝ ${node.annotation}`}
          fontSize={10}
          fontStyle="italic"
          fontFamily={KONVA_FONT}
          fill={colors.inkFaint}
          wrap="word"
          ellipsis
          height={22}
          listening={false}
        />
      )}
    </>
  )
}

/** 媒体缺失占位（iOS missingMedia）：中性底 + 类型符号。 */
function MissingMediaBody(props: {
  node: CanvasNodeWithRecord
  symbol: string
  colors: ReturnType<typeof themeColors>
  radius: number
}) {
  const { node, colors } = props
  const { t } = useI18n()
  return (
    <>
      <Rect
        width={node.width}
        height={node.height}
        fill={colors.well}
        cornerRadius={props.radius}
        stroke={colors.hairline}
        strokeWidth={1}
      />
      <Text
        text={props.symbol}
        fontSize={24}
        fontFamily={KONVA_FONT}
        fill={colors.inkFaint}
        width={node.width}
        height={node.height}
        align="center"
        verticalAlign="middle"
        listening={false}
      />
      <Text
        x={12}
        y={node.height - 26}
        width={node.width - 24}
        text={node.recordTitle || carrierLabelOf(t.canvas.carrier, node.recordCarrier)}
        fontSize={11}
        fontStyle="600"
        fontFamily={KONVA_FONT}
        fill={colors.inkSoft}
        wrap="word"
        ellipsis
        height={22}
        listening={false}
      />
    </>
  )
}

/**
 * 播放按钮是**独立按钮**：点它只播放，cancelBubble 隔离选中 / 拖动 /
 * 双击打开（iOS playBadge 同语义）。
 */
function PlayBadge(props: {
  onTogglePlay: () => void
  node: CanvasNodeWithRecord
  small?: boolean
  /** 覆盖默认的整卡中心：链接卡放封面区中心，避免压住标题行。 */
  centerY?: number
}) {
  const size = props.small ? 34 : 44
  return (
    <Group
      x={props.node.width / 2 - size / 2}
      y={(props.centerY ?? props.node.height / 2) - size / 2}
      onClick={(event) => {
        event.cancelBubble = true
        props.onTogglePlay()
      }}
      onTap={(event) => {
        event.cancelBubble = true
        props.onTogglePlay()
      }}
    >
      <Rect width={size} height={size} cornerRadius={size / 2} fill="rgba(255,255,255,0.001)" />
      <Rect width={size} height={size} cornerRadius={size / 2} fill="#ffffff" opacity={0.92} listening={false} />
      <Text
        text="▶"
        fontSize={size * 0.32}
        fontFamily={KONVA_FONT}
        fill="#30372f"
        width={size}
        height={size}
        align="center"
        verticalAlign="middle"
        listening={false}
      />
    </Group>
  )
}

function CanvasEmptyState(props: {
  onAddRecord: () => void
  onAddImage: () => void
  onAddNote: () => void
  onStartDraw: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="canvas-empty canvas-empty--guide">
      <span className="overline" style={{ margin: 0 }}>{t.canvas.empty.overline}</span>
      <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="button" onClick={props.onAddRecord}>{t.canvas.empty.addRecord}</button>
        <button className="button" onClick={props.onAddImage}>{t.canvas.empty.addImage}</button>
        <button className="button" onClick={props.onAddNote}>{t.canvas.empty.addNote}</button>
        <button className="button" onClick={props.onStartDraw}>{t.canvas.empty.draw}</button>
      </div>
    </div>
  )
}

const KONVA_FONT = "-apple-system, 'PingFang SC', 'Segoe UI', sans-serif"

function carrierLabelOf(
  labels: { image: string; video: string; link: string; text: string },
  carrier: string
): string {
  return carrier === 'text' ? labels.text : carrier === 'link' ? labels.link : carrier === 'video' ? labels.video : labels.image
}

function providerHostOf(node: CanvasNodeWithRecord): string {
  try {
    return node.recordURLString ? new URL(node.recordURLString).hostname : ''
  } catch {
    return ''
  }
}

/**
 * Cover crop（对标 iOS `scaledToFill().clipped()`）：保持图片原始比例等比放大
 * 到盖满节点，居中裁掉超出部分。crop 是源图上的取样矩形，width/height 是
 * 节点尺寸——两者比例一致，视觉上无拉伸。
 */
function coverCrop(
  image: HTMLImageElement | null,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } | undefined {
  if (!image || !image.naturalWidth || !image.naturalHeight) return undefined
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const cropWidth = width / scale
  const cropHeight = height / scale
  return {
    x: (image.naturalWidth - cropWidth) / 2,
    y: (image.naturalHeight - cropHeight) / 2,
    width: cropWidth,
    height: cropHeight
  }
}

/** 媒体卡底部渐变标题区的高度：标题一行 + 备注两行的安全高度。 */
function captionHeight(node: CanvasNodeWithRecord): number {
  const base = 46
  const annotation = node.annotation ? 26 : 0
  return Math.min(node.height * 0.6, base + annotation)
}

function roundedRectPath(ctx: Context, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

/** 点阵：世界坐标网格，屏幕间距钳在 16–44px，淡墨低透明度。 */
function DotGrid(props: { width: number; height: number; viewport: CanvasViewport }) {
  const { width, height, viewport } = props
  return (
    <Shape
      sceneFunc={(context) => {
        const colors = themeColors()
        const { scale, offsetX, offsetY } = viewport
        if (scale <= 0) return
        let spacing = 26
        while (spacing * scale < 16) spacing *= 2
        while (spacing * scale > 44) spacing /= 2
        const x0 = -offsetX / scale
        const y0 = -offsetY / scale
        const x1 = (width - offsetX) / scale
        const y1 = (height - offsetY) / scale
        const radius = 1.1 / scale
        context.fillStyle = colors.inkFaint
        context.globalAlpha = 0.32
        for (let wx = Math.floor(x0 / spacing) * spacing; wx <= x1; wx += spacing) {
          for (let wy = Math.floor(y0 / spacing) * spacing; wy <= y1; wy += spacing) {
            context.beginPath()
            context.arc(wx, wy, radius, 0, Math.PI * 2)
            context.fill()
          }
        }
      }}
    />
  )
}

function useLocalImage(fileName: string | null): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!fileName) {
      setImage(null)
      return
    }
    const element = new window.Image()
    element.src = api.records.mediaUrl(fileName)
    element.onload = () => setImage(element)
    element.onerror = () => setImage(null)
    return () => {
      element.onload = null
      element.onerror = null
    }
  }, [fileName])
  return image
}
