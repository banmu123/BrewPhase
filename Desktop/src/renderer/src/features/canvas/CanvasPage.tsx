import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Image as KonvaImage, Layer, Line, Rect, Shape, Stage, Text } from 'react-konva'
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
import { api } from '../../shared/api'
import { refreshThemeColors, themeColors } from '../../shared/tokens'

/**
 * Quiet Infinite Studio——一块安静的无限画布。
 *
 * 坐标系不变：节点 / 便签 / 笔迹全部用**世界坐标**，Stage 只承担缩放平移。
 * 笔迹点集落库前不做屏幕换算；宽度按绘制时的视口比例折算（width / scale），
 * 屏幕观感稳定。橡皮按笔画擦除，绝不动 Record 节点。
 * 快捷键在输入框聚焦时全部让路；Undo/Redo 本版未做（见交付报告）。
 */

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type StudioTool = CanvasTool | 'select' | 'hand' | 'note'

const PEN_COLORS = ['#30372f', '#849779', '#97765a', '#9a9f97', '#a8503f']
const NOTE_COLORS = ['#f6f2df', '#e3e9df', '#e8ebe5', '#f7e8df']

export function CanvasPage() {
  const [canvases, setCanvases] = useState<Canvas[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [nodes, setNodes] = useState<CanvasNodeWithRecord[]>([])
  const [notes, setNotes] = useState<CanvasNote[]>([])
  const [strokes, setStrokes] = useState<CanvasStroke[]>([])
  const [records, setRecords] = useState<RecordItem[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [viewport, setViewport] = useState<CanvasViewport>({ scale: 1, offsetX: 0, offsetY: 0 })
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState({ width: 800, height: 600 })
  const [tool, setTool] = useState<StudioTool>('select')
  const [penColor, setPenColor] = useState(PEN_COLORS[0])
  const [panelOpen, setPanelOpen] = useState(false)
  const [addSearch, setAddSearch] = useState('')
  const [focusMode, setFocusMode] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [draft, setDraft] = useState<CanvasStroke | null>(null)
  const [playingVideo, setPlayingVideo] = useState<CanvasNodeWithRecord | null>(null)

  const active = canvases.find((canvas) => canvas.id === activeId) ?? canvases[0] ?? null
  const containerRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<{ pointerX: number; pointerY: number; offsetX: number; offsetY: number } | null>(null)
  const spaceRef = useRef(false)
  const saveTimer = useRef(0)

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null
  const addedRecordIds = useMemo(() => new Set(nodes.map((node) => node.recordID)), [nodes])
  const filteredRecords = useMemo(
    () => records.filter((record) => (record.title || '').toLowerCase().includes(addSearch.trim().toLowerCase())),
    [records, addSearch]
  )

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
      setActiveId((current) => current ?? next[0]?.id ?? null)
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  const loadContent = useCallback(async (canvasId: string) => {
    try {
      const [nextNodes, nextNotes, nextStrokes] = await Promise.all([
        api.canvas.nodes(canvasId),
        api.canvas.notes(canvasId),
        api.canvas.strokes(canvasId)
      ])
      setNodes(nextNodes)
      setNotes(nextNotes)
      setStrokes(nextStrokes)
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  useEffect(() => {
    void loadCanvases()
    api.records
      .list({ search: '', carrier: null, tagId: null, limit: 60, offset: 0 })
      .then(setRecords)
      .catch((cause: Error) => setError(cause.message))
    refreshThemeColors()
  }, [loadCanvases])

  useEffect(() => {
    if (!active) {
      setNodes([])
      setNotes([])
      setStrokes([])
      return
    }
    void loadContent(active.id)
    setSelectedNodeId(null)
    setSelectedNoteId(null)
  }, [active?.id, loadContent])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    document.body.classList.toggle('canvas-focus', focusMode)
    return () => {
      document.body.classList.toggle('canvas-focus', false)
    }
  }, [focusMode])

  // MARK: - Fit All / 100%

  const fitAll = useCallback(() => {
    const xs: number[] = []
    const ys: number[] = []
    for (const node of nodes) {
      xs.push(node.positionX, node.positionX + node.width)
      ys.push(node.positionY, node.positionY + node.height)
    }
    for (const note of notes) {
      xs.push(note.positionX, note.positionX + note.width)
      ys.push(note.positionY, note.positionY + note.height)
    }
    for (const stroke of strokes) {
      for (let i = 0; i < stroke.points.length; i += 2) {
        xs.push(stroke.points[i])
        ys.push(stroke.points[i + 1])
      }
    }
    if (xs.length === 0) {
      setViewport({ scale: 1, offsetX: 0, offsetY: 0 })
      return
    }
    const pad = 80
    const minX = Math.min(...xs) - pad
    const minY = Math.min(...ys) - pad
    const width = Math.max(1, Math.max(...xs) + pad - minX)
    const height = Math.max(1, Math.max(...ys) + pad - minY)
    const scale = Math.min(
      CANVAS_LIMITS.maxScale,
      Math.max(CANVAS_LIMITS.minScale, Math.min(size.width / width, size.height / height))
    )
    setViewport({
      scale,
      offsetX: -minX * scale + (size.width - width * scale) / 2,
      offsetY: -minY * scale + (size.height - height * scale) / 2
    })
  }, [nodes, notes, strokes, size])

  useEffect(() => {
    if (active && size.width > 0) fitAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])

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
        case '1': setViewport((current) => zoomAt(current, 1, { x: size.width / 2, y: size.height / 2 })); break
        case 'escape':
          if (editingNoteId) setEditingNoteId(null)
          else if (panelOpen) setPanelOpen(false)
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
  }, [fitAll, size, panelOpen, editingNoteId])

  // MARK: - 写操作（带保存状态）

  const createNote = useCallback(async (): Promise<void> => {
    if (!active) return
    const center = screenToWorld({ x: size.width / 2, y: size.height / 2 }, viewport)
    const note = await withSave(() => api.canvas.createNote(active.id, center.x - 110, center.y - 90))
    setNotes((current) => [...current, note])
    setSelectedNoteId(note.id)
    setEditingNoteId(note.id)
  }, [active, size, viewport, withSave])

  const updateNote = useCallback(
    async (note: CanvasNote): Promise<void> => {
      setNotes((current) => current.map((item) => (item.id === note.id ? note : item)))
      await withSave(() => api.canvas.updateNote(note))
    },
    [withSave]
  )

  const removeNote = useCallback(
    async (id: string): Promise<void> => {
      setNotes((current) => current.filter((note) => note.id !== id))
      setSelectedNoteId(null)
      setEditingNoteId(null)
      await withSave(() => api.canvas.removeNote(id))
    },
    [withSave]
  )

  const removeSelectedNode = useCallback(async (): Promise<void> => {
    if (!active || !selectedNodeId) return
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId))
    setSelectedNodeId(null)
    await withSave(() => api.canvas.removeNode(selectedNodeId))
  }, [active, selectedNodeId, withSave])

  const addImage = useCallback(async (): Promise<void> => {
    if (!active) return
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
    await loadContent(active.id)
  }, [active, size, viewport, withSave, loadContent])

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
    await withSave(() => api.canvas.saveStroke(stroke))
  }, [draft, withSave])

  const eraseStroke = useCallback(
    async (id: string) => {
      setStrokes((current) => current.filter((stroke) => stroke.id !== id))
      await withSave(() => api.canvas.removeStroke(id))
    },
    [withSave]
  )

  // MARK: - Stage

  return (
    <div className="page">
      <div className="canvas-shell">
        <div className="canvas-topbar">
          {canvases.length > 0 && (
            <select
              value={active?.id ?? ''}
              aria-label="切换画布"
              onChange={(event) => setActiveId(event.target.value || null)}
            >
              {canvases.map((canvas) => (
                <option key={canvas.id} value={canvas.id}>{canvas.name || '未命名画布'}</option>
              ))}
            </select>
          )}
          <span className="page-sub">{canvases.length} 块</span>
          <SaveBadge state={saveState} />
          <span className="spacer" />
          <button
            className="button button--ghost"
            title="重命名这块画布"
            onClick={async () => {
              if (!active) return
              const name = window.prompt('画布名称', active.name || '未命名画布')
              if (!name?.trim()) return
              const updated = await withSave(() => api.canvas.rename(active.id, name.trim()))
              setCanvases((current) => current.map((canvas) => (canvas.id === updated.id ? updated : canvas)))
            }}
          >
            重命名
          </button>
          <button
            className="button button--ghost"
            title="新建画布"
            onClick={async () => {
              const name = window.prompt('这块画布叫什么？', '新的画布')
              if (!name) return
              const created = await api.canvas.create(name)
              await loadCanvases()
              setActiveId(created.id)
            }}
          >
            新建
          </button>
          <button className="button button--ghost" title="沉浸模式" onClick={() => setFocusMode(true)}>
            Focus
          </button>
        </div>

        <div className="canvas-wrap" ref={containerRef}>
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
                const wantPan = spaceRef.current || tool === 'hand' || event.evt.button === 1 || (onBlank && tool === 'select')
                if (wantPan) {
                  if (onBlank) {
                    setSelectedNodeId(null)
                    setSelectedNoteId(null)
                  }
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
                    draggable={tool === 'select' || tool === 'hand' || tool === 'note'}
                    onSelect={() => {
                      setSelectedNodeId(node.id)
                      setPanelOpen(true)
                    }}
                    onMoved={async (positionX, positionY) => {
                      setNodes((current) =>
                        current.map((item) => (item.id === node.id ? { ...item, positionX, positionY } : item))
                      )
                      await withSave(() => api.canvas.moveNode(node.id, positionX, positionY))
                    }}
                    onLiveResize={(width, height) => {
                      setNodes((current) =>
                        current.map((item) => (item.id === node.id ? { ...item, width, height } : item))
                      )
                    }}
                    onResized={async (width, height) => {
                      await withSave(() => api.canvas.resizeNode(node.id, width, height))
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
                      setPanelOpen(true)
                    }}
                    onDoubleClick={() => {
                      setSelectedNoteId(note.id)
                      setEditingNoteId(note.id)
                    }}
                    onMoved={async (positionX, positionY) => {
                      setNotes((current) =>
                        current.map((item) => (item.id === note.id ? { ...item, positionX, positionY } : item))
                      )
                      await withSave(() => api.canvas.updateNote({ ...note, positionX, positionY }))
                    }}
                  />
                ))}
              </Layer>
            </Stage>
          ) : (
            <div className="canvas-empty">还没有画布。点右上角「新建」开始。</div>
          )}

          {active && nodes.length === 0 && notes.length === 0 && strokes.length === 0 && (
            <CanvasEmptyState
              onAddRecord={() => setPanelOpen(true)}
              onAddImage={() => void addImage()}
              onAddNote={() => void createNote()}
              onStartDraw={() => setTool('pen')}
            />
          )}

          {active && tool === 'note' && <div className="canvas-hint">在画布上点一下，放一张便签</div>}

          <StudioToolbar
            tool={tool}
            penColor={penColor}
            addActive={panelOpen}
            onTool={setTool}
            onPenColor={setPenColor}
            onNote={() => void createNote()}
            onAddImage={() => void addImage()}
            onAddRecord={() => setPanelOpen((value) => !value)}
          />

          <div className="canvas-hud">
            <span className="canvas-hud__zoom mono">{Math.round(viewport.scale * 100)}%</span>
            <button
              className="button"
              aria-label="缩小"
              title="缩小"
              onClick={() => setViewport((current) => zoomAt(current, current.scale / 1.15, { x: size.width / 2, y: size.height / 2 }))}
            >
              －
            </button>
            <button
              className="button"
              aria-label="放大"
              title="放大"
              onClick={() => setViewport((current) => zoomAt(current, current.scale * 1.15, { x: size.width / 2, y: size.height / 2 }))}
            >
              ＋
            </button>
            <button className="button" aria-label="适配全部内容" title="Fit All (0)" onClick={() => fitAll()}>
              Fit
            </button>
            <button
              className="button"
              aria-label="回到 100%"
              title="100% (1)"
              onClick={() => setViewport((current) => zoomAt(current, 1, { x: size.width / 2, y: size.height / 2 }))}
            >
              1:1
            </button>
          </div>

          {panelOpen && active && (
            <aside className="canvas-panel" role="dialog" aria-label="画布操作">
              <div className="row row--between" style={{ marginBottom: 12 }}>
                <span className="overline" style={{ margin: 0 }}>添加到画布</span>
                <button className="button button--ghost" aria-label="关闭面板" onClick={() => setPanelOpen(false)}>
                  ✕
                </button>
              </div>

              <input
                placeholder="搜索记录…"
                value={addSearch}
                onChange={(event) => setAddSearch(event.target.value)}
                style={{ marginBottom: 10 }}
              />

              <div className="list" style={{ maxHeight: 240, overflow: 'auto', marginBottom: 14 }}>
                {filteredRecords.map((record) => {
                  const thumb = record.previewPath ?? record.mediaPath
                  return (
                    <button
                      key={record.id}
                      className="add-card"
                      disabled={addedRecordIds.has(record.id)}
                      style={{ opacity: addedRecordIds.has(record.id) ? 0.45 : 1 }}
                      onClick={async () => {
                        await withSave(() => api.canvas.addNode(active.id, record.id))
                        await loadContent(active.id)
                      }}
                    >
                      {thumb ? (
                        <img className="add-card__thumb" src={api.records.mediaUrl(thumb)} alt="" loading="lazy" />
                      ) : (
                        <span className="add-card__thumb add-card__thumb--text">
                          {(record.title || record.summary || record.note || record.carrier).slice(0, 2)}
                        </span>
                      )}
                      <span className="add-card__body">
                        <span className="add-card__title">{record.title || '未命名记录'}</span>
                        <span className="add-card__meta">
                          {record.carrier}
                          {addedRecordIds.has(record.id) && ' · 已在画布'}
                        </span>
                      </span>
                    </button>
                  )
                })}
                {filteredRecords.length === 0 && <div className="empty">没有匹配的记录。</div>}
              </div>

              <div className="hairline" />
              <span className="overline">选中的内容</span>
              {selectedNode && selectedNode.recordCarrier === 'video' ? (
                <div className="stack">
                  <div className="note">{selectedNode.recordTitle || '未命名视频'}</div>
                  <button className="button button--primary" onClick={() => setPlayingVideo(selectedNode)}>
                    ▶ 在浮层中播放
                  </button>
                  <button className="button button--danger" onClick={() => void removeSelectedNode()}>
                    从画布移除
                  </button>
                </div>
              ) : selectedNode ? (
                <div className="stack">
                  <div className="note">{selectedNode.recordTitle || '未命名记录'}</div>
                  {selectedNode.annotation && <div className="note">备注：{selectedNode.annotation}</div>}
                  <button className="button button--danger" onClick={() => void removeSelectedNode()}>
                    从画布移除
                  </button>
                  <div className="note">只解除引用，原始记录还在记录库里。</div>
                </div>
              ) : selectedNote ? (
                <NoteEditor
                  note={selectedNote}
                  onChange={(next) => void updateNote(next)}
                  onRemove={() => void removeNote(selectedNote.id)}
                />
              ) : (
                <div className="empty">点选一张卡片或便签查看与编辑。</div>
              )}

              <div className="hairline" />
              <button
                className="button button--danger"
                onClick={async () => {
                  if (!window.confirm('删除这块画布？画布上的节点、便签和笔迹会一起消失，记录不受影响。')) return
                  await api.canvas.remove(active.id)
                  setActiveId(null)
                  setPanelOpen(false)
                  await loadCanvases()
                }}
              >
                删除这块画布
              </button>
            </aside>
          )}

          {playingVideo && (
            <div className="video-overlay" onClick={() => setPlayingVideo(null)}>
              <video
                src={api.records.mediaUrl(playingVideo.recordMediaPath ?? '')}
                controls
                autoPlay
                onClick={(event) => event.stopPropagation()}
              />
              <button className="button" aria-label="关闭播放" onClick={() => setPlayingVideo(null)}>
                关闭
              </button>
            </div>
          )}

          {editingNoteId && selectedNote && (
            <NoteEditorOverlay
              note={selectedNote}
              viewport={viewport}
              onChange={(next) => void updateNote(next)}
              onClose={() => setEditingNoteId(null)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// MARK: - 工具栏

function StudioToolbar(props: {
  tool: StudioTool
  penColor: string
  addActive: boolean
  onTool: (tool: StudioTool) => void
  onPenColor: (color: string) => void
  onNote: () => void
  onAddImage: () => void
  onAddRecord: () => void
}) {
  const items: Array<{ key: StudioTool; label: string; hint: string; glyph: string }> = [
    { key: 'select', label: 'Select', hint: '选择 (V)', glyph: '◇' },
    { key: 'hand', label: 'Hand', hint: '抓 Hand (H / Space)', glyph: '✋' },
    { key: 'pen', label: 'Pen', hint: '画笔 (P)', glyph: '✎' },
    { key: 'eraser', label: 'Eraser', hint: '按笔画擦除 (E)', glyph: '⌫' },
    { key: 'note', label: 'Note', hint: '点画布放便签 (N)', glyph: '▤' }
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
          {item.glyph}
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
              aria-label={`画笔颜色 ${color}`}
              onClick={() => props.onPenColor(color)}
            />
          ))}
        </span>
      )}
      <span className="studio-toolbar__divider" />
      <button
        className="studio-toolbar__tool studio-toolbar__tool--wide"
        title="新建便签 (N)"
        onClick={props.onNote}
      >
        便签
      </button>
      <button className="studio-toolbar__tool studio-toolbar__tool--wide" title="导入图片" onClick={props.onAddImage}>
        图片
      </button>
      <button
        className="studio-toolbar__tool studio-toolbar__tool--wide"
        data-active={props.addActive}
        title="添加记录"
        onClick={props.onAddRecord}
      >
        记录
      </button>
    </div>
  )
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state === 'idle') return null
  return (
    <span className="canvas-save" data-state={state}>
      {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save Failed'}
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
        text={props.note.title || '便签'}
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
        text={props.note.body || '双击编辑这条想法。'}
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
  return (
    <div className="stack">
      <input
        value={props.note.title}
        placeholder="标题"
        onChange={(event) => void props.onChange({ ...props.note, title: event.target.value })}
      />
      <textarea
        value={props.note.body}
        placeholder="写点什么…"
        onChange={(event) => void props.onChange({ ...props.note, body: event.target.value })}
      />
      <div className="row">
        {NOTE_COLORS.map((color) => (
          <button
            key={color}
            className="studio-toolbar__color"
            style={{ background: color }}
            data-active={props.note.color === color}
            aria-label={`便签颜色 ${color}`}
            onClick={() => void props.onChange({ ...props.note, color })}
          />
        ))}
        <span style={{ flex: 1 }} />
        <button className="button button--danger" onClick={props.onRemove}>
          删除便签
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
        placeholder="标题"
        autoFocus
        onChange={(event) => void props.onChange({ ...props.note, title: event.target.value })}
      />
      <textarea
        value={props.note.body}
        placeholder="写点什么…"
        onChange={(event) => void props.onChange({ ...props.note, body: event.target.value })}
      />
      <div className="row">
        {NOTE_COLORS.map((color) => (
          <button
            key={color}
            className="studio-toolbar__color"
            style={{ background: color }}
            data-active={props.note.color === color}
            aria-label={`便签颜色 ${color}`}
            onClick={() => void props.onChange({ ...props.note, color })}
          />
        ))}
        <span style={{ flex: 1 }} />
        <button className="button" onClick={props.onClose}>
          完成
        </button>
      </div>
    </div>
  )
}

// MARK: - 节点分层渲染（image 原图 / video·link 封面+标题条 / text 文字卡）

function CanvasNodeShape(props: {
  node: CanvasNodeWithRecord
  selected: boolean
  draggable: boolean
  onSelect: () => void
  onMoved: (x: number, y: number) => void | Promise<void>
  onLiveResize?: (width: number, height: number) => void
  onResized?: (width: number, height: number) => void | Promise<void>
}) {
  const { node } = props
  const image = useLocalImage(
    node.recordCarrier === 'image'
      ? node.recordMediaPath
      : node.recordCarrier === 'link' || node.recordCarrier === 'video'
        ? node.recordPreviewPath
        : null
  )
  const colors = themeColors()
  const radius = 14
  const stroke = props.selected ? colors.sage : colors.hairline
  const coverHeight = node.height - 44

  return (
    <Group
      x={node.positionX}
      y={node.positionY}
      draggable={props.draggable}
      onClick={props.onSelect}
      onTap={props.onSelect}
      onDragEnd={(event) => {
        void props.onMoved(event.target.x(), event.target.y())
      }}
    >
      {image && node.recordCarrier === 'image' && (
        <Group clipFunc={(ctx) => roundedRectPath(ctx, 0, 0, node.width, node.height, radius)}>
          <KonvaImage image={image} width={node.width} height={node.height} listening={false} />
        </Group>
      )}
      {image && (node.recordCarrier === 'link' || node.recordCarrier === 'video') && (
        <>
          <Group clipFunc={(ctx) => roundedRectPath(ctx, 0, 0, node.width, coverHeight, radius)}>
            <KonvaImage image={image} width={node.width} height={coverHeight} listening={false} />
          </Group>
          {node.recordCarrier === 'video' && (
            <Text
              x={14}
              y={coverHeight / 2 - 14}
              text="▶"
              fontSize={26}
              fontFamily={KONVA_FONT}
              fill="#ffffff"
              shadowColor="#000000"
              shadowOpacity={0.5}
              shadowBlur={6}
              listening={false}
            />
          )}
          <Rect
            y={coverHeight}
            width={node.width}
            height={44}
            fill={colors.card}
            cornerRadius={[0, 0, radius, radius]}
            stroke={stroke}
            strokeWidth={1}
            listening={false}
          />
          <Text
            x={12}
            y={coverHeight + 11}
            width={node.width - 24}
            text={node.recordTitle || '未命名记录'}
            fontSize={12}
            fontStyle="600"
            fontFamily={KONVA_FONT}
            fill={colors.ink}
            wrap="word"
            ellipsis
            height={22}
            listening={false}
          />
        </>
      )}
      {!image && (
        <>
          <Rect
            width={node.width}
            height={node.height}
            fill={colors.card}
            cornerRadius={radius}
            stroke={stroke}
            strokeWidth={props.selected ? 1.5 : 1}
          />
          <Text
            x={16}
            y={16}
            width={node.width - 32}
            text={node.recordTitle || '未命名记录'}
            fontSize={13}
            fontStyle="600"
            fontFamily={KONVA_FONT}
            fill={colors.ink}
            lineHeight={1.4}
            wrap="word"
            ellipsis
            height={node.height - 46}
          />
          <Text
            x={16}
            y={node.height - 26}
            text={carrierLabelOf(node.recordCarrier)}
            fontSize={10.5}
            fontFamily={KONVA_FONT}
            fill={colors.inkFaint}
            listening={false}
          />
        </>
      )}
    </Group>
  )
}

function CanvasEmptyState(props: {
  onAddRecord: () => void
  onAddImage: () => void
  onAddNote: () => void
  onStartDraw: () => void
}) {
  return (
    <div className="canvas-empty canvas-empty--guide">
      <span className="overline" style={{ margin: 0 }}>从一个小动作开始</span>
      <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="button" onClick={props.onAddRecord}>添加一条记录</button>
        <button className="button" onClick={props.onAddImage}>导入一张图片</button>
        <button className="button" onClick={props.onAddNote}>创建一张便签</button>
        <button className="button" onClick={props.onStartDraw}>随手画一笔</button>
      </div>
    </div>
  )
}

const KONVA_FONT = "-apple-system, 'PingFang SC', 'Segoe UI', sans-serif"

function carrierLabelOf(carrier: string): string {
  return carrier === 'text' ? '文字' : carrier === 'link' ? '链接' : carrier === 'video' ? '视频' : '图片'
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
