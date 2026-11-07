import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RecordCarrier, RecordDraft, RecordItem, RecordTag } from '@shared/contracts'
import { carrierLabel } from '@shared/contracts'
import { api, formatDate } from '../../shared/api'

const CARRIERS: (RecordCarrier | null)[] = [null, 'link', 'image', 'video', 'text']

/**
 * Records：四种载体、标签多对多、搜索与载体筛选。
 *
 * 图片走 `bpmedia://` 协议显示，renderer 从头到尾拿不到真实路径；缩略图用主进程
 * 生成的那一份，不是把原图塞进 <img>。
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
    <div className="columns">
      <section className="column">
        <h1 className="page-title">记录</h1>
        <p className="page-sub">{items.length} 条 · 本地资料库</p>

        <input
          placeholder="搜索标题、备注、网址…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ marginBottom: 10 }}
        />

        <div className="chips" style={{ marginBottom: 8 }}>
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

        <select value={tagId ?? ''} onChange={(event) => setTagId(event.target.value || null)} style={{ marginBottom: 10 }}>
          <option value="">所有标签</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>

        <div className="row" style={{ marginBottom: 12 }}>
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

        {error && <div className="error">{error}</div>}

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
            }}
          />
        )}

        <div className="list">
          {items.map((item) => (
            <button
              key={item.id}
              className="record-card"
              data-active={item.id === selected?.id}
              onClick={() => setSelectedId(item.id)}
            >
              <Thumb item={item} />
              <span className="record-card__body">
                <span className="record-card__title">{item.title || carrierLabel[item.carrier]}</span>
                <span className="record-card__meta">
                  <span>{carrierLabel[item.carrier]}</span>
                  <span>{formatDate(item.createdAt)}</span>
                  {item.tagIds.slice(0, 2).map((id) => (
                    <span key={id} className="tag">
                      {tagName.get(id) ?? '标签'}
                    </span>
                  ))}
                </span>
              </span>
            </button>
          ))}
          {items.length === 0 && <div className="empty">还没有记录。先从一条链接或一张图开始。</div>}
        </div>
      </section>

      <section className="column column--main">
        {selected ? (
          <div className="detail-body">
            <span className="overline">{carrierLabel[selected.carrier]}</span>
            <h2 className="detail-title">{selected.title || '未命名记录'}</h2>
            <div className="row" style={{ gap: 10, fontSize: 11, color: 'var(--ink-faint)', marginBottom: 16 }}>
              <span>{formatDate(selected.createdAt)}</span>
              {selected.sourceName && <span>{selected.sourceName}</span>}
              {selected.authorName && <span>{selected.authorName}</span>}
            </div>

            {selected.carrier === 'image' && selected.mediaPath && (
              <img
                className="detail-image"
                src={api.records.mediaUrl(selected.mediaPath)}
                alt={selected.title}
                style={{ marginBottom: 16 }}
              />
            )}

            {selected.carrier === 'link' && selected.urlString && (
              <div className="note" style={{ marginBottom: 16 }}>
                <a href={selected.urlString} target="_blank" rel="noreferrer">
                  {selected.urlString}
                </a>
                <div style={{ marginTop: 6 }}>链接元数据（标题/封面）在桌面端暂不抓取，同步后由 iOS 补齐。</div>
              </div>
            )}

            {selected.summary && <p className="note" style={{ marginBottom: 14 }}>{selected.summary}</p>}
            {selected.note && <div className="detail-note">{selected.note}</div>}
          </div>
        ) : (
          <div className="empty">左边还没有记录。</div>
        )}
      </section>

      <section className="column column--inspector">
        {selected ? (
          <RecordInspector
            item={selected}
            tags={tags}
            onChanged={load}
            onDeleted={() => {
              setSelectedId(null)
              void load()
            }}
          />
        ) : (
          <div className="empty">选中一条记录后，这里可以编辑标题、备注与标签。</div>
        )}
      </section>
    </div>
  )
}

function Thumb({ item }: { item: RecordItem }) {
  if ((item.carrier === 'image' || item.carrier === 'link' || item.carrier === 'video') && item.previewPath) {
    return <img className="thumb" src={api.records.mediaUrl(item.previewPath)} alt="" />
  }
  const glyph = item.carrier === 'image' ? '▣' : item.carrier === 'video' ? '▶' : item.carrier === 'link' ? '↗' : '¶'
  return <span className="thumb">{glyph}</span>
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

  return (
    <form
      className="stack panel"
      style={{ marginBottom: 14 }}
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        try {
          await props.onSubmit({
            carrier: props.carrier,
            title: title.trim(),
            note: props.carrier === 'text' ? body : '',
            urlString: url.trim(),
            provider: 'generic',
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
        <button className="button button--primary" type="submit" disabled={busy}>
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
  const [title, setTitle] = useState(item.title)
  const [note, setNote] = useState(item.note)
  const [tagIds, setTagIds] = useState(item.tagIds)
  const [newTag, setNewTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTitle(item.title)
    setNote(item.note)
    setTagIds(item.tagIds)
  }, [item.id])

  return (
    <div className="stack">
      <span className="overline" style={{ margin: 0 }}>
        记录属性
      </span>
      <div className="field">
        <label>标题</label>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
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
              await api.records.update(item.id, {
                carrier: item.carrier,
                title,
                note,
                urlString: item.urlString,
                provider: item.provider,
                sourceName: item.sourceName,
                authorName: item.authorName,
                summary: item.summary,
                mediaPath: item.mediaPath,
                previewPath: item.previewPath,
                tagIds
              })
              await props.onChanged()
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
