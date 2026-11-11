import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RecordCarrier, RecordDraft, RecordItem, RecordTag } from '@shared/contracts'
import { coalesce } from '@shared/coalesce'
import { canOpenInBrowser } from '@shared/browser-url'
import { api } from '../../shared/api'
import { useAppStore } from '../../app/store'
import { SearchIcon } from '../../shared/icons'
import { Modal } from '../../shared/Modal'
import { parseLink } from '@shared/link-parser'
import { useI18n } from '../../i18n'
import { useBrowserStore } from '../browser/browser-store'
import { confirmAction } from '../../shared/ConfirmDialog'
import { LinkPlayer } from './preview/LinkPlayer'
import { RecordTilePreview } from './preview/RecordTilePreview'
import { detectPlatform } from './preview/platform'
import { buildPreview, formatCount, recordDisplayTitle, type RecordPreview } from './preview/preview-model'
import {
  createInspectorForm,
  editField,
  editTags,
  markInspectorFieldsSaved,
  mergeInspectorItem,
  snapshotInspector,
  type InspectorForm
} from './inspector-state'

const CARRIERS: (RecordCarrier | null)[] = [null, 'link', 'image', 'video', 'text']

/**
 * Records：四种载体、标签多对多、搜索与载体筛选。
 *
 * 视觉上是一间「个人资料图书馆」：内容以收藏网格呈现，图片/封面是主角，
 * 文字以正文摘录为主角；选中后的详情与编辑收在右侧上下文栏。图片走
 * `bpmedia://` 协议显示，renderer 从头到尾拿不到真实路径。
 */
export function RecordsPage() {
  const { t, formatDate, formatNumber } = useI18n()
  /** 浏览器浮窗：链接记录的「在 BrewPhase 中打开」走这个入口。 */
  const openBrowser = useBrowserStore((store) => store.open)
  const [items, setItems] = useState<RecordItem[]>([])
  const [tags, setTags] = useState<RecordTag[]>([])
  const [search, setSearch] = useState('')
  const [carrier, setCarrier] = useState<RecordCarrier | null>(null)
  const [tagId, setTagId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState<'text' | 'link' | null>(null)

  /** 详情浮层按需出现：点卡片打开，✕ 关闭；不再常驻右侧挤压内容区。 */
  const [panelOpen, setPanelOpen] = useState(false)
  /**
   * 跨页跳转 pinned 的记录：目标可能在当前搜索/筛选之外、甚至不在最近 100 条里。
   * 用 `api.records.get(id)` 取完整详情，与列表数据解耦；删除则给提示。
   */
  const [pinnedRecord, setPinnedRecord] = useState<RecordItem | null>(null)
  const selected = items.find((item) => item.id === selectedId) ?? pinnedRecord
  const previewCopy = useMemo(
    () => ({ webPlatform: t.records.platform.web, socialPost: t.records.preview.socialPost }),
    [t]
  )

  // 画布双击节点跳转过来：按 ID 直接取记录详情（不依赖列表数据），然后清掉待办。
  // consume 放在 fetch 成功之后：StrictMode 下 effect 会双跑，先消费会取消第一次
  // 的取数且第二次拿不到待办 ID——跳转就静默丢失了。
  const openRecordId = useAppStore((state) => state.openRecordId)
  const consumeOpenRecord = useAppStore((state) => state.consumeOpenRecord)
  useEffect(() => {
    if (!openRecordId) return
    const id = openRecordId
    let alive = true
    api.records
      .get(id)
      .then((record) => {
        if (!alive) return
        consumeOpenRecord()
        if (!record) {
          setError(t.records.errors.recordDeleted)
          return
        }
        setPinnedRecord(record)
        setSelectedId(id)
        setPanelOpen(true)
      })
      .catch((cause: Error) => {
        if (alive) {
          consumeOpenRecord()
          setError(t.records.errors.openFailed(cause.message))
        }
      })
    return () => {
      alive = false
    }
  }, [openRecordId, consumeOpenRecord])

  // 列表刷新后 pinned 记录若已回到列表中，解除 pinned（数据以列表为准）。
  useEffect(() => {
    if (pinnedRecord && items.some((item) => item.id === pinnedRecord.id)) {
      setPinnedRecord(null)
    }
  }, [items, pinnedRecord])

  // 顶栏「快速添加 → 写一段文字 / 收藏一个链接」：只开本页已有的浮窗。
  const setModule = useAppStore((state) => state.setModule)
  const pendingCreate = useAppStore((state) => state.pendingCreate)
  const consumeCreate = useAppStore((state) => state.consumeCreate)
  useEffect(() => {
    if (!pendingCreate) return
    const kind = consumeCreate()
    if (kind === 'text' || kind === 'link') setCreating(kind)
  }, [pendingCreate, consumeCreate])

  /**
   * 媒体版本：只用来给 `bpmedia://` 加 `?v=`。
   *
   * 同步的顺序是「先写记录、再分块传文件」，记录先出现在列表里时图片还是
   * 破图；等 finalize 完，如果 URL 没变，浏览器会沿用上一次失败的结果，
   * 图片就一直不显示，直到切页或重启。版本号 +1 强制重新请求。
   */
  const [mediaVersion, setMediaVersion] = useState(0)
  const mediaUrl = useCallback(
    (name: string) => api.records.mediaUrl(name, mediaVersion),
    [mediaVersion]
  )

  /** 并发刷新保护：同步事件与元数据事件可能同时到，只认最后一次请求的结果。 */
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const [nextItems, nextTags] = await Promise.all([
        api.records.list({ search, carrier, tagId, limit: 100, offset: 0 }),
        api.records.listTags()
      ])
      if (seq !== loadSeq.current) return
      setItems(nextItems)
      setTags(nextTags)
      // 选中的记录被手机删掉（或不再匹配当前筛选）时，退回列表第一条；
      // 列表为空则清空选中，不让详情栏继续显示已经不存在的记录。
      setSelectedId((current) => (nextItems.some((item) => item.id === current) ? current : null))
    } catch (cause) {
      if (seq === loadSeq.current) setError((cause as Error).message)
    }
  }, [search, carrier, tagId])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180)
    return () => window.clearTimeout(timer)
  }, [load])

  /**
   * 手机同步写库 → 当前页面自动刷新（不需要切页或手动点）。
   *
   * 触发点已经在服务端接好：`POST /api/sync/apply` 事务提交后、以及
   * `POST /api/sync/media/finalize` 落盘后都会广播 `sync:changed`。
   * 一次同步会来多条，用 `coalesce` 合并成一轮查询，媒体版本跟着走一格。
   */
  useEffect(() => {
    const refresh = coalesce(() => {
      setMediaVersion((current) => current + 1)
      void load()
    }, 150)
    const off = api.sync.onChanged(refresh.run)
    return () => {
      // 先取消待执行的那一次，再解绑：卸载后不会再触发查询。
      refresh.cancel()
      off()
    }
  }, [load])

  // 后台元数据补全完成（成功/失败）后自动刷新：不需要用户切页才看到结果
  useEffect(() => api.records.onMetadataUpdated(() => void load()), [load])

  // Esc 关闭详情浮层：与右上角 ✕ 同一语义。
  // 播放器放大时 Esc 归播放器（退出放大，不销毁播放器），所以这一层必须让位——
  // 两个监听都挂在 window 上，注册顺序决定谁先跑，只能显式判断。
  // 新建浮窗打开时 Esc 归浮窗，详情侧栏保持不动。
  // 浏览器浮窗在最上层：它开着的时候 Esc 归它，否则会「关掉底下的详情、
  // 却把浏览器留在屏幕上」。
  useEffect(() => {
    if (!panelOpen || creating) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('.link-player--zoomed')) return
      if (document.querySelector('.browser-panel')) return
      setPanelOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [panelOpen, creating])

  // MCP / 其他主进程写入后的领域通知：页面没有发起请求，收到事件再取一次
  useEffect(
    () =>
      api.app.onChanged((domain) => {
        if (domain === 'records') void load()
      }),
    [load]
  )

  const tagName = useMemo(() => new Map(tags.map((tag) => [tag.id, tag.name])), [tags])

  // 详情区与播放器共用同一份预览视图：列表看到的和详情看到的永远一致。
  const selectedPreview = useMemo(
    () => (selected ? buildPreview(selected, mediaUrl, previewCopy) : null),
    [selected, mediaUrl, previewCopy]
  )

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__titles">
          <button type="button" className="back-link" onClick={() => setModule('studio')}>
            <span aria-hidden="true">←</span> {t.studio.back}
          </button>
          <h1 className="page-title">{t.records.title}</h1>
          <p className="page-sub">
            {t.records.subtitle} · {t.records.count(formatNumber(items.length))}
          </p>
        </div>
        <div className="page-header__actions">
          <div className="search">
            <SearchIcon size={15} />
            <input
              placeholder={t.records.searchPlaceholder}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <button className="button button--ghost" onClick={() => setCreating('text')}>
            {t.records.newText}
          </button>
          <button className="button button--primary" onClick={() => setCreating('link')}>
            {t.records.newLink}
          </button>
          <button
            className="button button--ghost"
            onClick={async () => {
              try {
                const imported = await api.records.importImage()
                if (!imported) return
                const created = await api.records.create({
                  carrier: 'image',
                  title: t.records.importedImageTitle,
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
                await load()
                setSelectedId(created.id)
                setPanelOpen(true)
              } catch (cause) {
                setError((cause as Error).message)
              }
            }}
          >
            {t.records.importImage}
          </button>
        </div>
      </header>

      <div className="page-body">
        <div className="record-layout">
          <section className="record-grid-wrap">
            <div className="record-toolbar">
              <div className="chips">
                {CARRIERS.map((item) => (
                  <button
                    key={item ?? 'all'}
                    className="chip"
                    data-active={carrier === item}
                    onClick={() => setCarrier(item)}
                  >
                    {item ? t.records.carrier[item] : t.common.all}
                  </button>
                ))}
              </div>
              <select
                value={tagId ?? ''}
                onChange={(event) => setTagId(event.target.value || null)}
                style={{ width: 160 }}
              >
                <option value="">{t.records.allTags}</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
              {error && <span className="error">{error}</span>}
            </div>

            {items.length === 0 ? (
              <div className="empty">{t.records.empty}</div>
            ) : (
              <div className="record-masonry">
                {items.map((item) => (
                  <RecordTile
                    key={item.id}
                    item={item}
                    mediaUrl={mediaUrl}
                    active={item.id === selected?.id}
                    tagNames={item.tagIds
                      .slice(0, 2)
                      .map((id) => tagName.get(id))
                      .filter((name): name is string => Boolean(name))}
                    onClick={() => {
                      setSelectedId(item.id)
                      setPanelOpen(true)
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          {panelOpen && selected && (
          <aside className="float-panel" role="dialog" aria-label={t.records.detail.ariaLabel}>
              <>
                <div className="record-side__detail">
                  <div className="row row--between">
                    <span className="overline" style={{ margin: 0 }}>{t.records.carrier[selected.carrier]}</span>
                    <button
                      className="button button--ghost"
                      aria-label={t.records.detail.close}
                      onClick={() => setPanelOpen(false)}
                    >
                      ✕
                    </button>
                  </div>
                  <h2 className="detail-title">{recordDisplayTitle(selected) || t.records.untitled}</h2>
                  <div className="detail-meta">
                    <span>{formatDate(selected.createdAt)}</span>
                    {(selected.sourceName || selected.metadata?.sourceName) && (
                      <span>{selected.sourceName || selected.metadata?.sourceName}</span>
                    )}
                    {(selected.authorName || selected.metadata?.authorName) && (
                      <span>{selected.authorName || selected.metadata?.authorName}</span>
                    )}
                  </div>

                  {selected.carrier === 'link' && selectedPreview && (
                    <LinkPlayer key={selected.id} preview={selectedPreview} />
                  )}

                  {selected.carrier === 'image' && selected.mediaPath && (
                    <img
                      className="detail-image"
                      src={mediaUrl(selected.mediaPath)}
                      alt={selected.title}
                    />
                  )}

                  {selected.carrier === 'link' && selected.urlString && (
                    <div className="detail-link-row">
                      <a className="detail-link" href={selected.urlString} target="_blank" rel="noreferrer">
                        {selected.urlString}
                      </a>
                      {/*
                        * 链接记录的上下文入口：交给**同一个**浏览器浮窗，不新建实例。
                        * 只在地址能过 http/https 白名单时出现——`javascript:`、`file:`
                        * 这类记录不该在界面上留一个「打开」的口子。
                        */}
                      {canOpenInBrowser(selected.urlString) && (
                        <button
                          type="button"
                          className="button button--ghost detail-link-row__open"
                          onClick={() => void openBrowser({ url: selected.urlString })}
                        >
                          {t.browser.records.openInside}
                        </button>
                      )}
                    </div>
                  )}

                  {selected.carrier !== 'link' && selected.summary && (
                    <p className="note" style={{ marginBottom: 14 }}>{selected.summary}</p>
                  )}
                  {selected.note && <div className="detail-note">{selected.note}</div>}
                </div>

                <div className="hairline" />
                <RecordInspector
                  item={selected}
                  tags={tags}
                  onChanged={load}
                  onDeleted={() => {
                    setSelectedId(null)
                    void load()
                  }}
                />
              </>
          </aside>
          )}

          {creating && (
            <Modal
              title={creating === 'text' ? t.records.newText : t.records.newLink}
              onClose={() => setCreating(null)}
              width={creating === 'link' ? 'md' : 'sm'}
            >
              <NewRecordForm
                carrier={creating}
                tags={tags}
                hideTitle
                onCancel={() => setCreating(null)}
                onSubmit={async (draft) => {
                  const created = await api.records.create(draft)
                  setCreating(null)
                  await load()
                  setSelectedId(created.id)
                  setPanelOpen(true)
                  // 元数据补全不阻塞保存：先让记录落到列表，再后台抓取并刷新。
                  if (draft.carrier === 'link' && draft.urlString.trim()) {
                    void api.records
                      .resolveMetadata(created.id)
                      .then(() => load())
                      .catch(() => undefined)
                  }
                }}
              />
            </Modal>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 收藏网格里的一块内容：媒体区按平台差异化渲染（GitHub 像 GitHub、
 * 视频像视频、X 像 X），标题/标签/时间保持既有排版。
 */
function RecordTile(props: {
  item: RecordItem
  mediaUrl: (name: string) => string
  active: boolean
  tagNames: string[]
  onClick: () => void
}) {
  const { item } = props
  const { t, formatDate } = useI18n()
  const platform = useMemo(() => detectPlatform(item, t.records.platform.web), [item, t])
  // 平台标签：链接用平台识别，本地媒体与文字用载体名——本地内容不该显示「网页」。
  const metaLabel = item.carrier === 'link' ? platform.label : t.records.carrier[item.carrier]
  const previewTitle = useMemo(() => {
    // 用户标题 → 本地派生标题 → GitHub 仓库身份 → 摘要首行 → 载体名
    const composed = recordDisplayTitle(item)
    if (composed) return composed
    const identity = item.platformContentID ?? item.metadata?.contentId ?? null
    if (platform.platform === 'github' && identity) return identity
    return t.records.carrier[item.carrier]
  }, [platform, item, t])
  // 视频平台把频道/UP 主带进元信息行（§顺手检查 2）。
  const metaAuthor =
    (platform.platform === 'youtube' || platform.platform === 'bilibili') && item.authorName
      ? item.authorName
      : null

  return (
    <button
      className="record-tile"
      data-active={props.active}
      data-platform={platform.platform}
      onClick={props.onClick}
      aria-label={previewTitle || t.records.carrier[item.carrier]}
    >
      <span className={`record-tile__media${item.carrier === 'text' ? ' record-tile__media--text' : ' record-tile__media--platform'}`}>
        <RecordTilePreview item={item} mediaUrl={props.mediaUrl} />
      </span>
      <span className="record-tile__body">
        <span className="record-tile__title">{previewTitle || t.records.carrier[item.carrier]}</span>
        <span className="record-tile__meta">
          <span data-platform-label={platform.platform}>{metaLabel}</span>
          {metaAuthor && <span>{metaAuthor}</span>}
          <span>{formatDate(item.createdAt)}</span>
          {props.tagNames.map((name) => (
            <span key={name} className="tag">
              {name}
            </span>
          ))}
        </span>
      </span>
    </button>
  )
}

/** 表单里的本地识别状态行：已识别什么平台、内容 ID 是否取到。 */
function ParsedLinkStatus(props: { parsed: ReturnType<typeof parseLink> | null }) {
  const { t } = useI18n()
  const { parsed } = props
  if (!parsed) return null
  if (!parsed.valid) {
    return <span className="field-hint field-hint--error">{t.records.link.invalid}</span>
  }
  const detail = parsed.shortLink
    ? t.records.link.short
    : parsed.contentId
      ? t.records.link.contentId
      : t.records.link.tryPreview
  return (
    <span className="field-hint">
      <span className="field-hint__ok">{t.records.link.recognized(t.records.provider[parsed.provider])}</span>
      <span> · {detail}</span>
    </span>
  )
}

function NewRecordForm(props: {
  carrier: 'text' | 'link'
  /** 放进浮窗时标题由浮窗提供。 */
  hideTitle?: boolean
  tags: RecordTag[]
  onCancel: () => void
  onSubmit: (draft: RecordDraft) => Promise<void>
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [url, setUrl] = useState('')
  const [tagIds, setTagIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 纯本地解析（不发网络请求）：输入过程中实时显示平台识别结果。
  const parsed = useMemo(
    () => (props.carrier === 'link' && url.trim() ? parseLink(url) : null),
    [props.carrier, url]
  )

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        try {
          if (props.carrier === 'link' && url.trim() && parsed && !parsed.valid) {
            setError(t.records.form.invalidUrlNotSaved)
            setBusy(false)
            return
          }
          await props.onSubmit({
            carrier: props.carrier,
            title: title.trim(),
            note: props.carrier === 'text' ? body : '',
            urlString: url.trim(),
            canonicalURL: parsed?.canonicalUrl || null,
            platformContentID: parsed?.contentId ?? null,
            provider: parsed?.provider ?? 'generic',
            sourceName: '',
            authorName: '',
            summary: '',
            mediaPath: null,
            previewPath: null,
            tagIds
          })
        } catch (cause) {
          setError((cause as Error).message)
          setBusy(false)
        }
      }}
    >
      {!props.hideTitle && (
        <span className="overline" style={{ margin: 0 }}>
          {props.carrier === 'text' ? t.records.newText : t.records.newLink}
        </span>
      )}
      <div className="field">
        <label>{t.records.form.title}</label>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      {props.carrier === 'link' ? (
        <div className="field">
          <label>{t.records.form.url}</label>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
          <ParsedLinkStatus parsed={parsed} />
        </div>
      ) : (
        <div className="field">
          <label>{t.records.form.body}</label>
          <textarea value={body} onChange={(event) => setBody(event.target.value)} />
        </div>
      )}
      <div className="chips">
        {props.tags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            className="chip"
            data-active={tagIds.includes(tag.id)}
            onClick={() =>
              setTagIds((current) =>
                current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id]
              )
            }
          >
            {tag.name}
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="dialog-actions">
        <button className="button" type="button" onClick={props.onCancel}>
          {t.common.cancel}
        </button>
        <button
          className="button button--primary"
          type="submit"
          disabled={busy || (props.carrier === 'link' && url.trim() !== '' && parsed != null && !parsed.valid)}
        >
          {busy ? t.common.saving : t.common.save}
        </button>
      </div>
    </form>
  )
}

/** 详情侧栏的「预览信息」：与卡片共用 buildPreview 的结果，不另造一套取值。 */
function PreviewInfo(props: { preview: RecordPreview }) {
  const { t } = useI18n()
  const { preview } = props
  const stats: string[] = []
  if (preview.language) stats.push(preview.language)
  if (preview.stars != null) stats.push(`★ ${formatCount(preview.stars)}`)
  if (preview.forks != null) stats.push(`⑂ ${formatCount(preview.forks)}`)
  const identity =
    preview.platform.platform === 'github' ? preview.repositoryName : preview.videoId
  const hasContent = Boolean(
    identity || stats.length > 0 || preview.description || preview.remoteImage
  )
  if (!hasContent) return null

  return (
    <div className="preview-info">
      <div className="row row--between">
        <span className="overline" style={{ margin: 0 }}>
          {t.records.preview.title}
        </span>
        <span className="preview-info__chip" data-platform={preview.platform.platform}>
          {preview.platform.label}
        </span>
      </div>
      {identity && (
        <InfoRow
          label={preview.platform.platform === 'github' ? t.records.preview.repository : t.records.preview.content}
          value={identity}
          mono
        />
      )}
      {stats.length > 0 && <InfoRow label={t.records.preview.stats} value={stats.join(' · ')} />}
      {preview.description && <p className="preview-info__desc">{preview.description}</p>}
      {preview.remoteImage && (
        <img className="preview-info__thumb" src={preview.remoteImage} alt="" loading="lazy" referrerPolicy="no-referrer" />
      )}
    </div>
  )
}

function InfoRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="preview-info__row">
      <span className="preview-info__label">{props.label}</span>
      <span className={props.mono ? 'preview-info__value mono' : 'preview-info__value'}>{props.value}</span>
    </div>
  )
}

function RecordInspector(props: {
  item: RecordItem
  tags: RecordTag[]
  onChanged: () => Promise<void>
  onDeleted: () => void
}) {
  const { t, formatDate } = useI18n()
  const { item } = props
  // 编辑态带 dirty 标记：异步元数据补全后列表会重载，只有**用户没改过**的
  // 字段才跟随 item 同步（见 inspector-state.ts）。
  const [form, setForm] = useState<InspectorForm>(() => createInspectorForm(item))
  const [newTag, setNewTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setForm((current) => mergeInspectorItem(current, item))
  }, [item])

  const { title, note, urlString, tagIds } = form
  const setTitle = (value: string) => setForm((current) => editField(current, 'title', value))
  const setNote = (value: string) => setForm((current) => editField(current, 'note', value))
  const setUrlString = (value: string) => setForm((current) => editField(current, 'urlString', value))
  const setTagIds = (updater: string[] | ((current: string[]) => string[])) =>
    setForm((current) => editTags(current, typeof updater === 'function' ? updater(current.tagIds) : updater))

  const urlChanged = urlString.trim() !== item.urlString.trim()
  const parsedUrl = useMemo(() => (urlChanged && urlString.trim() ? parseLink(urlString) : null), [urlChanged, urlString])
  // 与卡片用同一个组装结果，保证「列表看到的」和「详情看到的」永远一致
  const preview = useMemo(
    () =>
      buildPreview(item, api.records.mediaUrl, {
        webPlatform: t.records.platform.web,
        socialPost: t.records.preview.socialPost
      }),
    [item, t]
  )

  async function refreshPreview(force: boolean): Promise<void> {
    setRefreshing(true)
    try {
      await api.records.resolveMetadata(item.id, force)
      await props.onChanged()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="stack">
      <span className="overline" style={{ margin: 0 }}>
        {t.records.inspector.title}
      </span>
      {item.carrier === 'link' && (
        <div className="field">
          <label>{t.records.form.url}</label>
          <input value={urlString} onChange={(event) => setUrlString(event.target.value)} placeholder="https://" />
          {urlChanged && <ParsedLinkStatus parsed={parsedUrl} />}
        </div>
      )}
      {item.carrier === 'link' && (
        <div className="row row--between">
          <span className="note" style={{ margin: 0 }}>
            {item.metadataStatus === 'pending'
              ? t.records.metadata.pending
              : item.metadataStatus === 'ok' || item.metadataStatus === 'resolved'
                ? t.records.metadata.ok
                : item.metadataStatus === 'partial'
                  ? t.records.metadata.partial
                  : t.records.metadata.unavailable}
          </span>
          <button
            className="button button--ghost"
            type="button"
            disabled={refreshing}
            onClick={() => void refreshPreview(true)}
          >
            {refreshing
              ? t.records.metadata.fetching
              : item.metadataStatus === 'failed' || item.metadataStatus === 'idle'
                ? t.records.metadata.fetch
                : t.records.metadata.refresh}
          </button>
        </div>
      )}
      {item.carrier === 'link' && <PreviewInfo preview={preview} />}
      <div className="field">
        <label>{t.records.form.title}</label>
        <input
          value={title}
          placeholder={item.metadata?.title ?? ''}
          onChange={(event) => setTitle(event.target.value)}
        />
        {!title.trim() && item.metadata?.title && (
          <span className="field-hint">{t.records.inspector.titleHint}</span>
        )}
      </div>
      <div className="field">
        <label>{t.records.inspector.note}</label>
        <textarea
        className="detail-note-input"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      </div>
      <div className="field">
        <label>{t.records.inspector.tags}</label>
        <div className="chips">
          {props.tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="chip"
              data-active={tagIds.includes(tag.id)}
              onClick={() =>
                setTagIds((current) =>
                  current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id]
                )
              }
            >
              {tag.name}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <input placeholder={t.records.inspector.newTag} value={newTag} onChange={(event) => setNewTag(event.target.value)} />
        <button
          className="button"
          type="button"
          onClick={async () => {
            if (!newTag.trim()) return
            const created = await api.records.createTag(newTag.trim())
            setTagIds((current) => [...new Set([...current, created.id])])
            setNewTag('')
            await props.onChanged()
          }}
        >
          {t.records.inspector.addTag}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="row">
        <button
          className="button button--primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              const nextProvider = parsedUrl?.provider ?? item.provider
              // 提交快照：保存成功后只清除「这次提交且之后没再改」的字段 dirty，
              // 请求期间用户又敲进去的内容不会被当成已保存（第五轮 §一）。
              const submitted = snapshotInspector(form)
              await api.records.update(item.id, {
                carrier: item.carrier,
                // 没改过的字段回传记录原值：自动抓到的标题/摘要绝不能被
                // 「随手保存一下」升级成用户数据，否则同步指纹会被污染
                // （Phase 3.1）。
                title: form.titleDirty ? title.trim() : item.title,
                note: form.noteDirty ? note : item.note,
                urlString: urlChanged ? urlString.trim() : item.urlString,
                canonicalURL: urlChanged ? parsedUrl?.canonicalUrl ?? null : item.canonicalURL,
                platformContentID: urlChanged ? parsedUrl?.contentId ?? null : item.platformContentID,
                provider: nextProvider,
                sourceName: item.sourceName,
                authorName: item.authorName,
                summary: item.summary,
                mediaPath: item.mediaPath,
                previewPath: item.previewPath,
                tagIds
              })
              setForm((current) => markInspectorFieldsSaved(current, submitted))
              await props.onChanged()
              // URL 变了：旧元数据已在保存时清空，后台重新识别并补全。
              if (urlChanged && urlString.trim()) {
                void api.records.resolveMetadata(item.id, true).then(() => props.onChanged()).catch(() => undefined)
              }
            } catch (cause) {
              setError((cause as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? t.common.saving : t.records.inspector.saveChanges}
        </button>
        <button
          className="button button--danger"
          onClick={async () => {
            const confirmed = await confirmAction({
              title: t.records.inspector.deleteTitle,
              description: t.records.inspector.deleteBody,
              confirmLabel: t.common.delete,
              cancelLabel: t.common.cancel,
              tone: 'danger'
            })
            if (!confirmed) return
            await api.records.remove(item.id)
            props.onDeleted()
          }}
        >
          {t.common.delete}
        </button>
      </div>

      <div className="hairline" />
      <span className="overline">{t.records.inspector.info}</span>
      <div className="note">
        {t.records.inspector.carrierLine(t.records.carrier[item.carrier])}
        <br />
        {t.records.inspector.createdLine(formatDate(item.createdAt))}
        <br />
        {t.records.inspector.updatedLine(formatDate(item.updatedAt))}
        {item.mediaPath && (
          <>
            <br />
            {t.records.inspector.fileLine(item.mediaPath)}
          </>
        )}
      </div>
    </div>
  )
}
