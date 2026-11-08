import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RecordCarrier, RecordDraft, RecordItem, RecordTag } from '@shared/contracts'
import { carrierLabel } from '@shared/contracts'
import { api, formatDate } from '../../shared/api'
import { SearchIcon } from '../../shared/icons'
import { parseLink, providerLabel } from '@shared/link-parser'
import { RecordTilePreview } from './preview/RecordTilePreview'
import { detectPlatform } from './preview/platform'
import { formatCount } from './preview/preview-model'
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
  const [items, setItems] = useState<RecordItem[]>([])
  const [tags, setTags] = useState<RecordTag[]>([])
  const [search, setSearch] = useState('')
  const [carrier, setCarrier] = useState<RecordCarrier | null>(null)
  const [tagId, setTagId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState<'text' | 'link' | null>(null)

  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null

  const load = useCallback(async () => {
    try {
      const [nextItems, nextTags] = await Promise.all([
        api.records.list({ search, carrier, tagId, limit: 100, offset: 0 }),
        api.records.listTags()
      ])
      setItems(nextItems)
      setTags(nextTags)
      setSelectedId((current) => (nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id ?? null))
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [search, carrier, tagId])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180)
    return () => window.clearTimeout(timer)
  }, [load])

  const tagName = useMemo(() => new Map(tags.map((tag) => [tag.id, tag.name])), [tags])

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__titles">
          <h1 className="page-title">记录</h1>
          <p className="page-sub">{items.length} 条 · 本地资料库</p>
        </div>
        <div className="page-header__actions">
          <div className="search">
            <SearchIcon size={15} />
            <input
              placeholder="搜索标题、备注、网址…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <button className="button" onClick={() => setCreating('text')}>
            新文字
          </button>
          <button className="button" onClick={() => setCreating('link')}>
            新链接
          </button>
          <button
            className="button"
            onClick={async () => {
              try {
                const imported = await api.records.importImage()
                if (!imported) return
                const created = await api.records.create({
                  carrier: 'image',
                  title: '导入的图片',
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
              } catch (cause) {
                setError((cause as Error).message)
              }
            }}
          >
            导入图片
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
                    {item ? carrierLabel[item] : '全部'}
                  </button>
                ))}
              </div>
              <select
                value={tagId ?? ''}
                onChange={(event) => setTagId(event.target.value || null)}
                style={{ width: 160 }}
              >
                <option value="">所有标签</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
              {error && <span className="error">{error}</span>}
            </div>

            {creating && (
              <NewRecordForm
                carrier={creating}
                tags={tags}
                onCancel={() => setCreating(null)}
                onSubmit={async (draft) => {
                  const created = await api.records.create(draft)
                  setCreating(null)
                  await load()
                  setSelectedId(created.id)
                  // 元数据补全不阻塞保存：先让记录落到列表，再后台抓取并刷新。
                  if (draft.carrier === 'link' && draft.urlString.trim()) {
                    void api.records
                      .resolveMetadata(created.id)
                      .then(() => load())
                      .catch(() => undefined)
                  }
                }}
              />
            )}

            {items.length === 0 ? (
              <div className="empty">还没有记录。先从一条链接、一张图或一段文字开始。</div>
            ) : (
              <div className="record-grid">
                {items.map((item) => (
                  <RecordTile
                    key={item.id}
                    item={item}
                    active={item.id === selected?.id}
                    tagNames={item.tagIds
                      .slice(0, 2)
                      .map((id) => tagName.get(id))
                      .filter((name): name is string => Boolean(name))}
                    onClick={() => setSelectedId(item.id)}
                  />
                ))}
              </div>
            )}
          </section>

          <aside className="record-side">
            {selected ? (
              <>
                <div className="record-side__detail">
                  <span className="overline">{carrierLabel[selected.carrier]}</span>
                  <h2 className="detail-title">{selected.title || '未命名记录'}</h2>
                  <div className="detail-meta">
                    <span>{formatDate(selected.createdAt)}</span>
                    {selected.sourceName && <span>{selected.sourceName}</span>}
                    {selected.authorName && <span>{selected.authorName}</span>}
                  </div>

                  {selected.carrier === 'image' && selected.mediaPath && (
                    <img
                      className="detail-image"
                      src={api.records.mediaUrl(selected.mediaPath)}
                      alt={selected.title}
                    />
                  )}

                  {selected.carrier === 'link' && selected.urlString && (
                    <p className="note" style={{ marginBottom: 14 }}>
                      <a className="detail-link" href={selected.urlString} target="_blank" rel="noreferrer">
                        {selected.urlString}
                      </a>
                      <LinkMetaLine item={selected} />
                    </p>
                  )}

                  {selected.summary && <p className="note" style={{ marginBottom: 14 }}>{selected.summary}</p>}
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
            ) : (
              <div className="empty">选中一条记录，这里会显示详情与编辑。</div>
            )}
          </aside>
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
  active: boolean
  tagNames: string[]
  onClick: () => void
}) {
  const { item } = props
  const platform = useMemo(() => detectPlatform(item), [item])
  // 平台标签：链接用平台识别，本地媒体与文字用载体名——本地内容不该显示「网页」。
  const metaLabel = item.carrier === 'link' ? platform.label : carrierLabel[item.carrier]
  const previewTitle = useMemo(() => {
    const local = item.metadata
    const identity = item.platformContentID ?? local?.contentId ?? null
    if (platform.platform === 'github' && identity) return identity
    const title = item.title.trim() || (local?.title ?? '').trim()
    if (title) return title
    const summary = item.summary.trim() || (local?.description ?? '').trim()
    return summary.split('\n')[0] || carrierLabel[item.carrier]
  }, [platform, item])
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
      aria-label={previewTitle || carrierLabel[item.carrier]}
    >
      <span className={`record-tile__media${item.carrier === 'text' ? ' record-tile__media--text' : ' record-tile__media--platform'}`}>
        <RecordTilePreview item={item} mediaUrl={(name) => api.records.mediaUrl(name)} />
      </span>
      <span className="record-tile__body">
        <span className="record-tile__title">{previewTitle || carrierLabel[item.carrier]}</span>
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

/** 详情侧栏的平台元信息行：仓库统计 / 视频来源 / 网页域名，如实展示。 */
function LinkMetaLine(props: { item: RecordItem }) {
  const { item } = props
  const platform = detectPlatform(item)
  const stats: string[] = []
  if (item.repositoryLanguage) stats.push(item.repositoryLanguage)
  if (item.repositoryStars !== null && item.repositoryStars > 0) stats.push(`★ ${formatCount(item.repositoryStars)}`)
  if (item.repositoryForks !== null && item.repositoryForks > 0) stats.push(`Fork ${formatCount(item.repositoryForks)}`)

  if (platform.platform === 'github' && stats.length > 0) {
    return <span style={{ display: 'block', marginTop: 6 }}>仓库 · {stats.join(' · ')}</span>
  }
  if (platform.platform === 'youtube' || platform.platform === 'bilibili') {
    return <span style={{ display: 'block', marginTop: 6 }}>视频 · {platform.label}{item.authorName ? ` · ${item.authorName}` : ''}</span>
  }
  if (item.sourceName || item.authorName) {
    return <span style={{ display: 'block', marginTop: 6 }}>{[item.sourceName, item.authorName].filter(Boolean).join(' · ')}</span>
  }
  return null
}

/** 表单里的本地识别状态行：已识别什么平台、内容 ID 是否取到。 */
function ParsedLinkStatus(props: { parsed: ReturnType<typeof parseLink> | null }) {
  const { parsed } = props
  if (!parsed) return null
  if (!parsed.valid) {
    return <span className="field-hint field-hint--error">不是有效的网页地址（只支持 http/https）</span>
  }
  const detail = parsed.shortLink
    ? '短链接，保存后解析最终地址'
    : parsed.contentId
      ? '已提取内容 ID，保存后获取预览'
      : '保存后尝试获取预览'
  return (
    <span className="field-hint">
      <span className="field-hint__ok">已识别 {providerLabel[parsed.provider]}</span>
      <span> · {detail}</span>
    </span>
  )
}

function NewRecordForm(props: {
  carrier: 'text' | 'link'
  tags: RecordTag[]
  onCancel: () => void
  onSubmit: (draft: RecordDraft) => Promise<void>
}) {
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
      className="stack panel"
      style={{ marginBottom: 16 }}
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        try {
          if (props.carrier === 'link' && url.trim() && parsed && !parsed.valid) {
            setError('这不是有效的网页地址，未保存')
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
      <span className="overline" style={{ margin: 0 }}>
        {props.carrier === 'text' ? '新文字' : '新链接'}
      </span>
      <div className="field">
        <label>标题</label>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      {props.carrier === 'link' ? (
        <div className="field">
          <label>网址</label>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
          <ParsedLinkStatus parsed={parsed} />
        </div>
      ) : (
        <div className="field">
          <label>正文</label>
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
      <div className="row">
        <button
          className="button button--primary"
          type="submit"
          disabled={busy || (props.carrier === 'link' && url.trim() !== '' && parsed != null && !parsed.valid)}
        >
          {busy ? '保存中…' : '保存'}
        </button>
        <button className="button button--ghost" type="button" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </form>
  )
}

function RecordInspector(props: {
  item: RecordItem
  tags: RecordTag[]
  onChanged: () => Promise<void>
  onDeleted: () => void
}) {
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
        记录属性
      </span>
      {item.carrier === 'link' && (
        <div className="field">
          <label>网址</label>
          <input value={urlString} onChange={(event) => setUrlString(event.target.value)} placeholder="https://" />
          {urlChanged && <ParsedLinkStatus parsed={parsedUrl} />}
        </div>
      )}
      {item.carrier === 'link' && (
        <div className="row row--between">
          <span className="note" style={{ margin: 0 }}>
            {item.metadataStatus === 'pending'
              ? '正在获取预览…'
              : item.metadataStatus === 'ok' || item.metadataStatus === 'resolved'
                ? '预览信息已更新'
                : item.metadataStatus === 'partial'
                  ? '已获取部分预览信息'
                  : '暂时无法获取预览'}
          </span>
          <button
            className="button button--ghost"
            type="button"
            disabled={refreshing}
            onClick={() => void refreshPreview(true)}
          >
            {refreshing ? '获取中…' : item.metadataStatus === 'failed' || item.metadataStatus === 'idle' ? '获取预览' : '刷新预览'}
          </button>
        </div>
      )}
      <div className="field">
        <label>标题</label>
        <input
          value={title}
          placeholder={item.metadata?.title ?? ''}
          onChange={(event) => setTitle(event.target.value)}
        />
        {!title.trim() && item.metadata?.title && (
          <span className="field-hint">灰字是本机抓到的标题，输入后才会成为你的标题</span>
        )}
      </div>
      <div className="field">
        <label>备注</label>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} style={{ minHeight: 90 }} />
      </div>
      <div className="field">
        <label>标签</label>
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
        <input placeholder="新标签" value={newTag} onChange={(event) => setNewTag(event.target.value)} />
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
          添加
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
          {busy ? '保存中…' : '保存修改'}
        </button>
        <button
          className="button button--danger"
          onClick={async () => {
            if (!window.confirm('删除这条记录？它所在的画布节点会一起消失。')) return
            await api.records.remove(item.id)
            props.onDeleted()
          }}
        >
          删除
        </button>
      </div>

      <div className="hairline" />
      <span className="overline">信息</span>
      <div className="note">
        载体：{carrierLabel[item.carrier]}
        <br />
        创建：{formatDate(item.createdAt)}
        <br />
        修改：{formatDate(item.updatedAt)}
        {item.mediaPath && (
          <>
            <br />
            文件：{item.mediaPath}
          </>
        )}
      </div>
    </div>
  )
}
