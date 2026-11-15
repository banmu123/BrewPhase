import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CardWorkspaceBinding,
  ContextPackage,
  LocalWorkspace,
  WorkspaceFileListing
} from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'

/**
 * CardWorkspaceToolbar —— AI Card 的本地工作区工具栏（Phase 1）。
 *
 * **同一套组件服务两种宿主**：独立网页窗口（variant="normal"）与圆桌
 * 面板（variant="compact"）。归属由 tabId 决定——这是组件唯一的身份输入，
 * 不同卡片（甚至同一平台的第二张卡）各自绑定、互不覆盖。
 *
 * 布局铁律：它出现在**正常文档流**里（标题栏之下、网页内容区之上），
 * 靠挤压内容区腾出空间——原生 WebContentsView 永远盖在 DOM 之上，
 * 任何「浮在网页上」的方案都不成立。展开/收起只改 DOM 高度，宿主通过
 * 对内容区重测 bounds 让原生视图跟随，绝不触碰 WebContents / Session。
 *
 * 交互基调（参照 BrewPing 的目录选择弹层）：没有大标题和说明文——展开
 * 即是可操作内容；未绑定直接呈现项目列表（添加是列表末尾的一行，不是
 * 突兀的按钮）；已绑定时是「一行项目 + 一行路径」的紧凑条。
 *
 * 交接模型（规格 §8.1）：选文件 → 生成 ContextPackage → 预览 →
 * 用户点「复制到 AI 对话」→ 粘贴发送。没有自动注入、没有 DOM 扫描。
 */

export function CardWorkspaceToolbar(props: {
  tabId: string
  variant: 'normal' | 'compact'
  onClose: () => void
}) {
  const { t } = useI18n()
  const [binding, setBinding] = useState<CardWorkspaceBinding | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [panel, setPanel] = useState<'main' | 'workspaces' | 'files' | 'context'>('workspaces')
  const [workspaces, setWorkspaces] = useState<LocalWorkspace[]>([])
  const [listing, setListing] = useState<WorkspaceFileListing | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchResult, setSearchResult] = useState<WorkspaceFileListing['entries'] | null>(null)
  const [package_, setPackage] = useState<ContextPackage | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshBinding = useCallback(async (): Promise<void> => {
    try {
      const next = await api.localWorkspace.binding(props.tabId)
      setBinding(next)
      setError(null)
      // 未绑定（含绑定失效）→ 直接呈现项目选择；已绑定 → 项目条。
      setPanel((current) =>
        current === 'workspaces' || current === 'main'
          ? next.workspace
            ? 'main'
            : 'workspaces'
          : current
      )
    } catch {
      setError(t.workspace.loadFailed)
    } finally {
      setLoaded(true)
    }
  }, [props.tabId, t.workspace.loadFailed])

  useEffect(() => {
    setLoaded(false)
    setPanel('workspaces')
    setListing(null)
    setSelected(new Set())
    setSearchResult(null)
    setPackage(null)
    void refreshBinding()
  }, [refreshBinding])

  // 工作区数据变化（另一张卡换绑 / 设置页增删 / 标签关闭清理）→ 各窗口
  // 的工具栏自己重取——不把内容塞进事件，避免出现第二份状态。
  useEffect(
    () =>
      api.app.onChanged((domain) => {
        if (domain !== 'localWorkspaces') return
        void refreshBinding()
      }),
    [refreshBinding]
  )

  const refreshWorkspaces = async (): Promise<void> => {
    try {
      setWorkspaces(await api.localWorkspace.list())
      setError(null)
    } catch {
      setError(t.workspace.loadFailed)
    }
  }

  const openWorkspaces = async (): Promise<void> => {
    await refreshWorkspaces()
    setPanel('workspaces')
  }

  const chooseWorkspace = async (workspaceId: string | null): Promise<void> => {
    try {
      const next = await api.localWorkspace.setBinding(props.tabId, workspaceId)
      setBinding(next)
      setSelected(new Set())
      setListing(null)
      setSearchResult(null)
      setPackage(null)
      setPanel(next.workspace ? 'main' : 'workspaces')
      setError(null)
    } catch (err) {
      setError((err as Error).message || t.workspace.loadFailed)
    }
  }

  const addWorkspace = async (): Promise<void> => {
    const result = await api.localWorkspace.add()
    if (result.ok) {
      await refreshWorkspaces()
      await chooseWorkspace(result.workspace.id)
    } else if (!result.canceled && result.error) {
      setError(result.error)
    }
  }

  const openFiles = async (relativePath = ''): Promise<void> => {
    const workspace = binding?.workspace
    if (!workspace) return
    try {
      setListing(await api.localWorkspace.listFiles(workspace.id, relativePath))
      setSearchResult(null)
      setPanel('files')
      setError(null)
    } catch (err) {
      setError((err as Error).message || t.workspace.loadFailed)
    }
  }

  const runSearch = async (query: string): Promise<void> => {
    const workspace = binding?.workspace
    if (!workspace) return
    const trimmed = query.trim()
    if (!trimmed) {
      setSearchResult(null)
      return
    }
    try {
      const result = await api.localWorkspace.search(workspace.id, trimmed)
      setSearchResult(result.entries)
      setError(null)
    } catch (err) {
      setError((err as Error).message || t.workspace.loadFailed)
    }
  }

  const toggleSelect = (relativePath: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(relativePath)) next.delete(relativePath)
      else next.add(relativePath)
      return next
    })
  }

  const buildContext = async (): Promise<void> => {
    const workspace = binding?.workspace
    if (!workspace || selected.size === 0) return
    try {
      const result = await api.localWorkspace.buildContext(workspace.id, [...selected])
      setPackage(result)
      setCopied(false)
      setPanel('context')
      setError(null)
    } catch (err) {
      setError(`${t.workspace.contextFailed}：${(err as Error).message}`)
    }
  }

  const copyContext = async (): Promise<void> => {
    if (!package_) return
    try {
      // 主进程写剪贴板：浮窗 / 面板没有焦点时 navigator.clipboard 会被拒。
      await api.app.copyText(package_.formattedText)
      setCopied(true)
    } catch {
      setError(t.workspace.copyFailed)
    }
  }

  const workspace = binding?.workspace ?? null
  const searchTimer = useRef<number | null>(null)

  return (
    <div className="cwt" data-variant={props.variant}>
      {error && <p className="cwt__error">{error}</p>}

      {!loaded && <div className="cwt__skeleton" aria-hidden="true" />}

      {loaded && panel === 'main' && workspace && (
        <div className="cwt__body">
          <div className="cwt__row">
            <span className="cwt__folder" aria-hidden="true">
              📁
            </span>
            <button
              type="button"
              className="cwt__project-link"
              title={t.workspace.switchWorkspace}
              onClick={() => void openWorkspaces()}
            >
              {workspace.name}
            </button>
            <span
              className="cwt__dot"
              data-missing={workspace.availability === 'missing'}
              title={workspace.availability === 'available' ? t.workspace.available : t.workspace.missing}
            />
            <span className="spacer" />
            <button type="button" className="cwt__mini" onClick={() => void openWorkspaces()}>
              {t.workspace.switchWorkspace}
            </button>
            <button
              type="button"
              className="cwt__mini cwt__mini--primary"
              disabled={workspace.availability !== 'available'}
              onClick={() => void openFiles()}
            >
              {t.workspace.browseFiles}
            </button>
            <button
              type="button"
              className="cwt__mini cwt__mini--icon"
              onClick={props.onClose}
              title={t.workspace.collapse}
              aria-label={t.workspace.collapse}
            >
              ✕
            </button>
          </div>
          <p className="cwt__pathline" title={workspace.absolutePath}>
            {workspace.absolutePath}
          </p>
          {workspace.availability === 'missing' && <p className="cwt__stateline">{t.workspace.missingHint}</p>}
        </div>
      )}

      {loaded && panel === 'workspaces' && (
        <div className="cwt__body">
          <div className="cwt__row">
            <span className="cwt__rowtitle">{t.workspace.workspacePickerTitle}</span>
            {binding?.missing && (
              <span className="cwt__stateline cwt__stateline--inline">{t.workspace.boundMissingTitle}</span>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="cwt__mini cwt__mini--icon"
              onClick={props.onClose}
              title={t.workspace.collapse}
              aria-label={t.workspace.collapse}
            >
              ✕
            </button>
          </div>
          <div className="cwt__picker">
            {binding?.missing && (
              <button type="button" className="cwt__mini" onClick={() => void chooseWorkspace(null)}>
                {t.workspace.clearBinding}
              </button>
            )}
            {workspaces.map((item) => (
              <button
                key={item.id}
                type="button"
                className="cwt__pickrow"
                data-active={workspace?.id === item.id}
                data-missing={item.availability === 'missing'}
                onClick={() => void chooseWorkspace(item.id)}
              >
                <span className="cwt__folder" aria-hidden="true">
                  📁
                </span>
                <span className="cwt__pickname">{item.name}</span>
                <span className="cwt__pickpath" title={item.absolutePath}>
                  {item.absolutePath}
                </span>
              </button>
            ))}
            <button type="button" className="cwt__pickrow cwt__pickrow--add" onClick={() => void addWorkspace()}>
              <span className="cwt__folder" aria-hidden="true">
                ＋
              </span>
              {t.workspace.addWorkspace}
            </button>
            {workspaces.length === 0 && <p className="cwt__stateline">{t.workspace.noWorkspaceHint}</p>}
          </div>
        </div>
      )}

      {loaded && panel === 'files' && workspace && (
        <div className="cwt__body cwt__body--files">
          <div className="cwt__row">
            <button
              type="button"
              className="cwt__mini cwt__mini--icon"
              onClick={() => setPanel('main')}
              title={t.workspace.backToWorkspace}
              aria-label={t.workspace.backToWorkspace}
            >
              ‹
            </button>
            <span className="cwt__crumb" title={listing?.relativePath || workspace.name}>
              {workspace.name}
              {listing?.relativePath ? ` / ${listing.relativePath}` : ''}
            </span>
            <span className="spacer" />
            {listing?.relativePath ? (
              <button
                type="button"
                className="cwt__mini cwt__mini--icon"
                onClick={() => void openFiles(parentOf(listing.relativePath))}
                title={t.workspace.parentDir}
                aria-label={t.workspace.parentDir}
              >
                ↑
              </button>
            ) : null}
            <button
              type="button"
              className="cwt__mini cwt__mini--icon"
              onClick={props.onClose}
              title={t.workspace.collapse}
              aria-label={t.workspace.collapse}
            >
              ✕
            </button>
          </div>
          <input
            className="cwt__search"
            type="search"
            placeholder={t.workspace.searchPlaceholder}
            onChange={(event) => {
              const value = event.target.value
              if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
              searchTimer.current = window.setTimeout(() => void runSearch(value), 200)
            }}
          />
          <div className="cwt__file-list">
            {searchResult ? (
              searchResult.length === 0 ? (
                <p className="cwt__stateline">{t.workspace.searchNoResult}</p>
              ) : (
                searchResult.map((entry) => (
                  <FileRow
                    key={entry.relativePath}
                    entry={entry}
                    selected={selected.has(entry.relativePath)}
                    onToggle={() => toggleSelect(entry.relativePath)}
                  />
                ))
              )
            ) : listing && listing.entries.length === 0 ? (
              <p className="cwt__stateline">{t.workspace.emptyDir}</p>
            ) : (
              listing?.entries.map((entry) => (
                <FileRow
                  key={entry.relativePath}
                  entry={entry}
                  selected={selected.has(entry.relativePath)}
                  onToggle={
                    entry.kind === 'directory'
                      ? () => void openFiles(entry.relativePath)
                      : () => toggleSelect(entry.relativePath)
                  }
                />
              ))
            )}
          </div>
          <div className="cwt__row cwt__row--foot">
            <span className="cwt__count">
              {selected.size > 0 ? t.workspace.selectedCount(selected.size) : t.workspace.selectionHint}
            </span>
            {selected.size > 0 && (
              <button type="button" className="cwt__mini" onClick={() => setSelected(new Set())}>
                {t.workspace.clearSelection}
              </button>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="cwt__mini cwt__mini--primary"
              disabled={selected.size === 0}
              onClick={() => void buildContext()}
            >
              {t.workspace.generateContext}
            </button>
          </div>
        </div>
      )}

      {loaded && panel === 'context' && package_ && (
        <div className="cwt__body cwt__body--context">
          <div className="cwt__row">
            <button
              type="button"
              className="cwt__mini cwt__mini--icon"
              onClick={() => setPanel('files')}
              title={t.workspace.backToFiles}
              aria-label={t.workspace.backToFiles}
            >
              ‹
            </button>
            <span className="cwt__rowtitle">{t.workspace.previewTitle}</span>
            <span className="cwt__stateline cwt__stateline--inline">
              {t.workspace.previewHint(package_.totalCharacters)}
            </span>
            {package_.truncated && (
              <span className="cwt__stateline cwt__stateline--inline">{t.workspace.truncatedNote}</span>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="cwt__mini cwt__mini--icon"
              onClick={props.onClose}
              title={t.workspace.collapse}
              aria-label={t.workspace.collapse}
            >
              ✕
            </button>
          </div>
          <pre className="cwt__preview">
            {package_.selectedFiles.map((file) => (
              <span key={file.relativePath}>
                <span className="cwt__preview-file">{file.relativePath}</span>
                {file.content}
              </span>
            ))}
          </pre>
          <div className="cwt__row cwt__row--foot">
            <button type="button" className="cwt__mini cwt__mini--primary" onClick={() => void copyContext()}>
              {copied ? `✓ ${t.workspace.copied}` : t.workspace.copyToAI}
            </button>
            <span className="spacer" />
            <span className="cwt__count">
              {t.workspace.selectedCount(package_.selectedFiles.length)} · {package_.totalCharacters}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function FileRow(props: {
  entry: WorkspaceFileListing['entries'][number]
  selected: boolean
  onToggle: () => void
}) {
  const { t } = useI18n()
  const isFile = props.entry.kind === 'file'
  return (
    <button
      type="button"
      className="cwt__pickrow cwt__file"
      data-selected={props.selected}
      data-kind={props.entry.kind}
      onClick={props.onToggle}
      title={
        isFile && props.entry.oversize
          ? `${props.entry.relativePath}（${t.workspace.truncatedNote}）`
          : props.entry.relativePath
      }
    >
      <span className="cwt__folder" aria-hidden="true">
        {props.entry.kind === 'directory' ? '▸' : '·'}
      </span>
      <span className="cwt__pickname">{props.entry.name}</span>
      <span className="cwt__pickpath">{isFile && props.entry.size > 0 ? formatSize(props.entry.size) : ''}</span>
      {props.selected && (
        <span className="cwt__check" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  )
}

function parentOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/')
  return index <= 0 ? '' : relativePath.slice(0, index)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
