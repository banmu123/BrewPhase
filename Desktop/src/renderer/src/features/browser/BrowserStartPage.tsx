import { useEffect, useRef, useState } from 'react'
import type { BrowserVisit } from '@shared/contracts'
import { useI18n } from '../../i18n'
import { GlobeIcon } from '../../shared/icons'

/**
 * 浏览器初始页：**没有地址时**的欢迎面，不是空白窗口。
 *
 * 三条约束：
 * 1. 全部由 React 画——此时主进程把 WebContentsView 藏起来了，否则原生层会
 *    盖住这块界面；
 * 2. 不预置任何网站。最近访问只来自真实的 `did-navigate` 记录（local_state
 *    里只有地址、标题、时间），没有就明说「还没有访问记录」；
 * 3. 输入框和地址栏走**同一个** `resolveBrowserInput`，所以这里输入
 *    `example.com`、`咖啡豆` 或 `javascript:` 的行为与工具栏完全一致。
 */
export function BrowserStartPage(props: {
  recent: BrowserVisit[]
  lastVisit: BrowserVisit | null
  onSubmit: (value: string) => void
  onOpen: (url: string) => void
}) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开浮窗就把光标放进输入框：初始页的唯一主动作就是「输入」。
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const recent = props.recent.slice(0, 6)

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

        {props.lastVisit && (
          <button
            type="button"
            className="browser-start__resume"
            onClick={() => props.onOpen(props.lastVisit!.url)}
          >
            <span className="browser-start__resume-label">{t.browser.start.resume}</span>
            <span className="browser-start__resume-title">{visitTitle(props.lastVisit, t.browser.status.untitled)}</span>
          </button>
        )}

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
