import { useEffect, useRef, useState } from 'react'
import type { RecordItem } from '@shared/contracts'
import { api } from '../shared/api'
import { SearchIcon } from '../shared/icons'
import { useI18n } from '../i18n'
import { recordDisplayTitle } from '../features/records/preview/preview-model'
import { useAppStore } from './store'

/**
 * 顶栏搜索：只做「找到并打开一条记录」，不复制 Records 页的筛选与详情。
 *
 * 结果点击后走 `openRecord(id)` —— 与画布双击节点同一条跨页路径：
 * Records 页按 ID 取完整详情并打开浮层，搜索框本身不多存一份记录。
 */
export function SearchPalette(props: { onClose: () => void }) {
  const { t } = useI18n()
  const openRecord = useAppStore((state) => state.openRecord)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<RecordItem[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 只认最后一次请求：快速改词时旧响应不许覆盖新结果。 */
  const seq = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [props.onClose])

  useEffect(() => {
    const text = query.trim()
    const id = ++seq.current
    if (!text) {
      setItems([])
      setBusy(false)
      return
    }
    setBusy(true)
    // 180ms 合并输入：每敲一个字都查库没有必要，也不会快到看不见。
    const timer = window.setTimeout(() => {
      api.records
        .list({ search: text, carrier: null, tagId: null, limit: 8, offset: 0 })
        .then((next) => {
          if (id !== seq.current) return
          setItems(next)
          setBusy(false)
        })
        .catch(() => {
          if (id !== seq.current) return
          setItems([])
          setBusy(false)
        })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query])

  const empty = query.trim().length > 0 && !busy && items.length === 0

  return (
    <div
      className="dialog-backdrop dialog-backdrop--top"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label={t.studio.searchTitle}>
        <div className="palette__field">
          <SearchIcon size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.studio.searchPlaceholder}
            aria-label={t.studio.searchPlaceholder}
            spellCheck={false}
          />
          <kbd>ESC</kbd>
        </div>

        <div className="palette__results">
          {query.trim().length === 0 ? (
            <p className="palette__note">{t.studio.searchEmpty}</p>
          ) : empty ? (
            <p className="palette__note">{t.studio.searchNoResults}</p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="palette__row"
                onClick={() => {
                  props.onClose()
                  openRecord(item.id)
                }}
              >
                <span className={`palette__glyph palette__glyph--${item.carrier}`} aria-hidden="true">
                  {item.carrier === 'text' ? '¶' : item.carrier === 'link' ? '↗' : item.carrier === 'video' ? '▶' : '▣'}
                </span>
                <span className="palette__text">
                  <strong>{recordDisplayTitle(item) || t.studio.records.untitled}</strong>
                  {/* 只给来源名/作者；provider 是内部枚举，不往界面上摆。 */}
                  <span>{item.sourceName || item.authorName}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
