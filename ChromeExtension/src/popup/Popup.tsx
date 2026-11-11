import { useEffect, useState } from 'react'
import { collectActivePage } from '../lib/page-metadata'
import {
  PREVIEW_SELECTED_TEXT,
  type ChromeCompanionResponse,
  type PagePayload
} from '../shared/protocol'

/**
 * Popup：只做两件事——展示当前页、提交保存。
 *
 * 所有网页内容都当作纯文本渲染（React 默认转义），不注入 innerHTML；
 * URL 只作为文本显示，不做可点击跳转。
 */

type Connection = 'checking' | 'connected' | 'offline'
type SaveState = 'idle' | 'saving' | 'saved' | 'failed'
type CollectError = 'unsupported' | 'failed' | null

const COPY = {
  zh: {
    connected: '已连接',
    checking: '连接中',
    offline: '未运行',
    save: '保存到 BrewPhase',
    target: 'Records',
    saving: '正在保存',
    saved: '已保存到 BrewPhase Records',
    saveFailed: '保存失败，请重试',
    unsupportedTitle: '当前网页暂不支持保存',
    unsupportedHint: '只能保存 http / https 页面',
    offlineHint: '请先启动 BrewPhase Desktop',
    extractFailed: '未能读取当前网页',
    retry: '重试',
    selection: '选中的文字',
    description: '页面摘要',
    privacy: '只在你点击时读取当前页面',
    loading: '正在读取当前网页'
  },
  en: {
    connected: 'Connected',
    checking: 'Connecting',
    offline: 'Not running',
    save: 'Save to BrewPhase',
    target: 'Records',
    saving: 'Saving',
    saved: 'Saved to BrewPhase Records',
    saveFailed: 'Save failed, try again',
    unsupportedTitle: 'This page cannot be saved',
    unsupportedHint: 'Only http / https pages are supported',
    offlineHint: 'Start BrewPhase Desktop first',
    extractFailed: 'Could not read this page',
    retry: 'Retry',
    selection: 'Selected text',
    description: 'Page summary',
    privacy: 'Reads the current page only when you click',
    loading: 'Reading the current page'
  }
} as const

function copy() {
  return navigator.language.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
}

export function Popup() {
  const t = copy()
  const [page, setPage] = useState<PagePayload | null>(null)
  const [collectError, setCollectError] = useState<CollectError>(null)
  const [connection, setConnection] = useState<Connection>('checking')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [message, setMessage] = useState('')
  const [iconFailed, setIconFailed] = useState(false)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const result = await collectActivePage()
      if (cancelled) return
      if (result.ok) {
        setPage(result.page)
      } else {
        setCollectError(result.reason === 'unsupported' ? 'unsupported' : 'failed')
      }

      const ping = await ask({ source: 'brewphase-popup', type: 'PING' })
      if (cancelled) return
      setConnection(ping?.success ? 'connected' : 'offline')
    })()

    return () => {
      cancelled = true
    }
  }, [])

  async function handleSave(): Promise<void> {
    if (!page || saveState === 'saving' || saveState === 'saved') return
    setSaveState('saving')
    setMessage('')

    const response = await ask({ source: 'brewphase-popup', type: 'SAVE_PAGE', payload: page })
    if (response?.success && response.code === 'OK') {
      setSaveState('saved')
      setConnection('connected')
      return
    }

    setSaveState('failed')
    if (response?.code === 'APP_NOT_RUNNING') {
      setConnection('offline')
      setMessage(t.offlineHint)
    } else {
      setMessage(t.saveFailed)
    }
  }

  const connectionLabel =
    connection === 'connected' ? t.connected : connection === 'offline' ? t.offline : t.checking

  return (
    <div className="app">
      <header className="head">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <CupIcon />
          </span>
          <span className="brand__name">BrewPhase</span>
          <span className="brand__product">Chrome Companion</span>
        </div>
        <span className="conn" data-state={connection}>
          <i aria-hidden="true" />
          {connectionLabel}
        </span>
      </header>

      <main className="body">
        {!page && !collectError && (
          <div className="loading">
            <span className="loading__dot" />
            {t.loading}
          </div>
        )}

        {collectError && (
          <div className="empty">
            <span className="empty__mark" aria-hidden="true">
              !
            </span>
            <h2 className="empty__title">
              {collectError === 'unsupported' ? t.unsupportedTitle : t.extractFailed}
            </h2>
            <p className="empty__hint">
              {collectError === 'unsupported' ? t.unsupportedHint : t.saveFailed}
            </p>
          </div>
        )}

        {page && (
          <>
            <section className="page" aria-label="current page">
              <div className="page__head">
                <span className="page__icon" aria-hidden="true">
                  {page.faviconUrl && !iconFailed ? (
                    <img src={page.faviconUrl} alt="" onError={() => setIconFailed(true)} />
                  ) : (
                    (page.domain.charAt(0) || '·').toUpperCase()
                  )}
                </span>
                <div className="page__titles">
                  <h1 className="page__title">{page.title || page.domain}</h1>
                  <span className="page__domain">{page.domain}</span>
                </div>
              </div>
              <p className="page__url" title={page.url}>
                {page.url}
              </p>

              {page.selectedText && (
                <div className="quote">
                  <span className="overline">{t.selection}</span>
                  <p>
                    {page.selectedText.length > PREVIEW_SELECTED_TEXT
                      ? `${page.selectedText.slice(0, PREVIEW_SELECTED_TEXT)}…`
                      : page.selectedText}
                  </p>
                </div>
              )}

              {!page.selectedText && page.description && (
                <div className="quote quote--muted">
                  <span className="overline">{t.description}</span>
                  <p>{page.description}</p>
                </div>
              )}
            </section>

            <button
              className="save"
              type="button"
              onClick={() => void handleSave()}
              disabled={saveState === 'saving' || saveState === 'saved'}
              data-state={saveState}
            >
              <span className="save__label">
                {saveState === 'saving' ? t.saving : saveState === 'saved' ? t.saved : t.save}
              </span>
              <span className="save__target">{t.target}</span>
            </button>

            <p className="status" data-tone={saveState === 'failed' ? 'error' : saveState === 'saved' ? 'ok' : 'muted'}>
              {saveState === 'saved'
                ? t.saved
                : saveState === 'failed'
                  ? message || t.saveFailed
                  : connection === 'offline'
                    ? t.offlineHint
                    : ''}
            </p>
          </>
        )}
      </main>

      <footer className="foot">{t.privacy}</footer>
    </div>
  )
}

/** 与 Desktop 的浏览器图标同一支咖啡杯。 */
function CupIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 8h11v6.2A4.8 4.8 0 0 1 11.2 19H9.8A4.8 4.8 0 0 1 5 14.2V8Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M16 9.5h1.6a2.4 2.4 0 0 1 0 4.8H16" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5.2c0-.8 1-1 1-1.8M12 5.2c0-.8 1-1 1-1.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

async function ask(message: unknown): Promise<ChromeCompanionResponse | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as ChromeCompanionResponse
  } catch {
    return null
  }
}
