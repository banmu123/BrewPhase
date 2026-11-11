import { useEffect, useRef, useState } from 'react'
import type { BookmarkItem, BookmarkNode, BookmarkRoot, BookmarkTree, BrowserVisit } from '@shared/contracts'
import { useI18n } from '../../i18n'
import { GlobeIcon } from '../../shared/icons'

/**
 * 浏览器起始页：**没有打开网页时**的欢迎面，也是书签的落点。
 *
 * 三条约束：
 * 1. 全部由 React 画——此时主进程把 WebContentsView 藏起来了，否则原生层会
 *    盖住这块界面；
 * 2. 最近访问只来自真实的 `did-navigate` 记录；书签只来自用户主动导入的本地
 *    副本，不预置、不联网；
 * 3. 输入框和地址栏走**同一个** `resolveBrowserInput`，所以这里输入
 *    `example.com`、`咖啡豆` 或 `javascript:` 的行为与工具栏完全一致。
 */
export function BrowserStartPage(props: {
  recent: BrowserVisit[]
  lastVisit: BrowserVisit | null
  /** `null` = 还没从主进程取到，先不画书签区，避免闪一下空态。 */
  bookmarks: BookmarkTree | null
  /** 仍活着的当前网页：显示「返回当前页面」，点击只恢复视图、不重新加载。 */
  currentPage: { title: string; url: string } | null
  onResumeCurrent: () => void
  onSubmit: (value: string) => void
  onOpen: (url: string) => void
  /** 空态里的导入入口：跳到 设置 → 浏览器。 */
  onImport: () => void
}) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开浮窗就把光标放进输入框：起始页的唯一主动作是「输入」。
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const recent = props.recent.slice(0, 6)
  const roots = props.bookmarks?.roots.filter((root) => root.children.length > 0) ?? []
  const hasBookmarks = roots.length > 0

  return (
    <div className="browser-start">
      <div className="browser-start__inner">
        <div className="browser-start__mark" aria-hidden="true">
          <GlobeIcon size={30} />
        </div>
        <h2 className="browser-start__title">{t.browser.start.title}</h2>
        <p className="browser-start__hint">{t.browser.start.hint}</p>

        <form
          className="browser-start__field"
          onSubmit={(event) => {
            event.preventDefault()
            if (!value.trim()) return
            props.onSubmit(value)
          }}
        >
          <GlobeIcon size={16} />
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t.browser.start.placeholder}
            aria-label={t.browser.toolbar.address}
            spellCheck={false}
            autoComplete="off"
          />
          <button className="browser-start__go" type="submit" disabled={!value.trim()}>
            {t.browser.toolbar.go}
          </button>
        </form>

        {/* 当前页面优先：它就在原生容器里活着，点一下只是把视图重新显示出来。
            有它时不再显示「继续上次访问」——两张卡指向同一页面只会让人分不清
            哪个会重新加载。 */}
        {props.currentPage ? (
          <button
            type="button"
            className="browser-start__resume browser-start__resume--current"
            title={props.currentPage.url}
            onClick={props.onResumeCurrent}
          >
            <span className="browser-start__resume-label">{t.browser.start.returnCurrent}</span>
            <span className="browser-start__resume-title">
              {props.currentPage.title.trim() || hostOf(props.currentPage.url) || t.browser.status.untitled}
            </span>
            <span className="browser-start__current-host">{hostOf(props.currentPage.url)}</span>
          </button>
        ) : (
          props.lastVisit && (
            <button
              type="button"
              className="browser-start__resume"
              onClick={() => props.onOpen(props.lastVisit!.url)}
            >
              <span className="browser-start__resume-label">{t.browser.start.resume}</span>
              <span className="browser-start__resume-title">
                {visitTitle(props.lastVisit, t.browser.status.untitled)}
              </span>
            </button>
          )
        )}

        {props.bookmarks !== null &&
          (hasBookmarks ? (
            <div className="browser-shelves">
              {roots.map((root) => (
                <BookmarkShelf key={root.id} root={root} onOpen={props.onOpen} />
              ))}
            </div>
          ) : (
            <button type="button" className="browser-shelves__empty" onClick={props.onImport}>
              <span className="browser-shelves__empty-title">{t.browser.bookmarks.emptyTitle}</span>
              <span className="browser-shelves__empty-hint">{t.browser.bookmarks.emptyHint}</span>
              <span className="browser-shelves__empty-action">{t.browser.bookmarks.import}</span>
            </button>
          ))}

        <section className="browser-start__recent" aria-label={t.browser.start.recent}>
          <span className="overline">{t.browser.start.recent}</span>
          {recent.length === 0 ? (
            <p className="browser-start__empty">{t.browser.start.empty}</p>
          ) : (
            <ul className="browser-start__list">
              {recent.map((visit) => (
                <li key={visit.url}>
                  <button type="button" onClick={() => props.onOpen(visit.url)} title={visit.url}>
                    <span className="browser-start__dot" aria-hidden="true">
                      {initial(visit)}
                    </span>
                    <span className="browser-start__text">
                      <span className="browser-start__name">{visitTitle(visit, t.browser.status.untitled)}</span>
                      <span className="browser-start__host">{hostOf(visit.url)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

/** 一个 Chrome 根（书签栏 / 其他书签 / 移动设备书签）。空根不渲染。 */
function BookmarkShelf({ root, onOpen }: { root: BookmarkRoot; onOpen: (url: string) => void }) {
  const { t } = useI18n()
  return (
    <section className="browser-shelf">
      <div className="browser-shelf__head">
        <span className="overline">{rootTitle(root, t)}</span>
        <span className="browser-shelf__count">{countBookmarks(root.children)}</span>
      </div>
      <ul className="browser-shelf__list">
        {root.children.map((node) => (
          <BookmarkNodeRow key={node.id} node={node} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  )
}

function BookmarkNodeRow(props: { node: BookmarkNode; onOpen: (url: string) => void }) {
  return props.node.kind === 'folder' ? (
    <BookmarkFolderRow folder={props.node} onOpen={props.onOpen} />
  ) : (
    <BookmarkLink item={props.node} onOpen={props.onOpen} />
  )
}

/**
 * 文件夹：默认收起，点一下展开。保留层级而不是把整棵树拍平——用户找书签
 * 靠的就是自己当年分的类。
 */
function BookmarkFolderRow(props: {
  folder: import('@shared/contracts').BookmarkFolder
  onOpen: (url: string) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const count = countBookmarks(props.folder.children)

  return (
    <li className="browser-node">
      <button
        type="button"
        className="browser-node__row browser-node__row--folder"
        data-open={open}
        aria-expanded={open}
        title={props.folder.title}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="browser-node__chevron" aria-hidden="true" />
        <span className="browser-node__name">{props.folder.title || t.browser.bookmarks.untitled}</span>
        <span className="browser-node__count">{count}</span>
      </button>
      {open && (
        <ul className="browser-node__children">
          {props.folder.children.map((child) => (
            <BookmarkNodeRow key={child.id} node={child} onOpen={props.onOpen} />
          ))}
        </ul>
      )}
    </li>
  )
}

function BookmarkLink(props: { item: BookmarkItem; onOpen: (url: string) => void }) {
  const { t } = useI18n()
  const host = hostOf(props.item.url)
  return (
    <li className="browser-node">
      <button
        type="button"
        className="browser-node__row"
        title={`${props.item.title || host}\n${props.item.url}`}
        onClick={() => props.onOpen(props.item.url)}
      >
        <span className="browser-node__dot" aria-hidden="true">
          {(host.charAt(0) || '·').toUpperCase()}
        </span>
        <span className="browser-node__name">{props.item.title || host || t.browser.bookmarks.untitled}</span>
        <span className="browser-node__host">{host}</span>
      </button>
    </li>
  )
}

function rootTitle(root: BookmarkRoot, t: ReturnType<typeof useI18n>['t']): string {
  if (root.kind === 'bookmark_bar') return t.browser.bookmarks.roots.bookmarkBar
  if (root.kind === 'synced') return t.browser.bookmarks.roots.synced
  return t.browser.bookmarks.roots.other
}

function countBookmarks(nodes: readonly BookmarkNode[]): number {
  let total = 0
  for (const node of nodes) {
    if (node.kind === 'bookmark') total += 1
    else total += countBookmarks(node.children)
  }
  return total
}

function visitTitle(visit: BrowserVisit, fallback: string): string {
  const title = visit.title.trim()
  return title || hostOf(visit.url) || fallback
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** 没有 favicon 时用域名首字母——不去请求第三方 favicon 服务，避免泄漏访问记录。 */
function initial(visit: BrowserVisit): string {
  const host = hostOf(visit.url)
  return (host.charAt(0) || '·').toUpperCase()
}
