import { useCallback, useEffect, useRef, useState } from 'react'
import type { AIChatTaskSnapshot, AIPlatformStatus } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { Markdown } from './markdown'

/**
 * Multi-AI：一次提问，两个已登录的 AI 网页并行作答。
 *
 * 状态来自主进程广播（aiChat.onChanged）——渲染层不猜测进度，只画收到的
 * 快照。提交是长任务：await ask 会等到全部平台落定才返回，期间的 UI 全靠
 * 广播刷新；「停止」只发意图，不本地猜状态。
 */
export function MultiAI() {
  const { t } = useI18n()
  const [statuses, setStatuses] = useState<AIPlatformStatus[] | null>(null)
  const [snapshot, setSnapshot] = useState<AIChatTaskSnapshot | null>(null)
  const [prompt, setPrompt] = useState('')
  const [selected, setSelected] = useState<Set<'chatgpt' | 'claude'>>(new Set(['chatgpt', 'claude']))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 谁已完成（收到结果就置位）；防止任务结束后重复触发滚动等副作用。 */
  const loadedRef = useRef(false)

  const refreshStatuses = useCallback(async () => {
    try {
      setStatuses(await api.aiChat.statuses())
    } catch {
      setStatuses(null)
    }
  }, [])

  useEffect(() => {
    void refreshStatuses()
    void api.aiChat.lastTask().then((task) => {
      if (task) setSnapshot(task)
    })
    return api.aiChat.onChanged((next) => {
      if (!next) return
      setSnapshot(next)
      const running = next.results.some((item) => !['completed', 'failed', 'timeout', 'cancelled', 'login_required', 'page_unavailable', 'unsupported_page'].includes(item.state))
      setBusy(running)
      if (!running) void refreshStatuses()
    })
  }, [refreshStatuses])

  function toggle(provider: 'chatgpt' | 'claude'): void {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  async function submit(): Promise<void> {
    const text = prompt.trim()
    if (!text || selected.size === 0 || busy) return
    setBusy(true)
    setError(null)
    loadedRef.current = false
    try {
      const { snapshot: result } = await api.aiChat.ask({ prompt: text, providers: [...selected] })
      setSnapshot(result)
    } catch (caught) {
      setError(String(caught instanceof Error ? caught.message : caught))
    } finally {
      setBusy(false)
      void refreshStatuses()
    }
  }

  function stop(): void {
    void api.aiChat.cancel()
  }

  const statusOf = (provider: 'chatgpt' | 'claude'): AIPlatformStatus | null =>
    statuses?.find((item) => item.provider === provider) ?? null

  return (
    <section className="multi-ai">
      {/* 平台选择与状态 */}
      <div className="multi-ai__providers" role="group" aria-label={t.aiWorkspace.ask.pickHint}>
        {(['chatgpt', 'claude'] as const).map((provider) => {
          const status = statusOf(provider)
          const state = busy && snapshot?.results.find((item) => item.provider === provider)
          const stateLabel = state
            ? t.aiWorkspace.taskState[state.state as keyof typeof t.aiWorkspace.taskState]
            : !status || !status.pageAlive
              ? // 页面根本没开过：说「未知」没有信息量，直接告诉用户去哪开始
                t.aiWorkspace.login.not_open
              : t.aiWorkspace.login[status.login]
          return (
            <button
              key={provider}
              type="button"
              className="multi-ai__provider"
              data-selected={selected.has(provider)}
              onClick={() => toggle(provider)}
            >
              <span className="multi-ai__provider-name">{t.aiWorkspace.providers[provider]}</span>
              <span
                className="multi-ai__provider-state"
                data-state={busy && state ? state.state : status?.login ?? 'unknown'}
              >
                {stateLabel}
              </span>
            </button>
          )
        })}
      </div>

      <textarea
        className="multi-ai__input"
        value={prompt}
        rows={4}
        placeholder={t.aiWorkspace.ask.placeholder}
        onChange={(event) => setPrompt(event.target.value)}
        disabled={busy}
      />

      <div className="multi-ai__actions">
        <button className="button button--primary" onClick={() => void submit()} disabled={busy || !prompt.trim() || selected.size === 0}>
          {busy ? t.aiWorkspace.ask.submitBusy : t.aiWorkspace.ask.submit}
        </button>
        {busy && (
          <button className="button" onClick={stop}>
            {t.aiWorkspace.ask.stop}
          </button>
        )}
        <button className="button button--ghost" onClick={() => setPrompt('')} disabled={busy}>
          {t.aiWorkspace.ask.clear}
        </button>
        {error && <span className="multi-ai__error">{error}</span>}
      </div>

      {/* 并排结果：窄窗口由 CSS 折成上下 */}
      <div className="multi-ai__results">
        {(['chatgpt', 'claude'] as const).map((provider) => {
          const result = snapshot?.results.find((item) => item.provider === provider)
          const state = result?.state ?? 'idle'
          const showAnswer = result && result.state === 'completed' && result.content.length > 0
          const showFailure = result && result.state !== 'idle' && result.state !== 'completed' && result.state !== 'generating' && result.state !== 'checking' && result.state !== 'sending'
          return (
            <article key={provider} className="multi-ai__card" data-state={result?.state ?? 'idle'}>
              <header className="multi-ai__card-head">
                <span className="multi-ai__card-name">{t.aiWorkspace.providers[provider]}</span>
                <span className="multi-ai__card-state" data-state={state}>
                  {t.aiWorkspace.taskState[state as keyof typeof t.aiWorkspace.taskState]}
                </span>
              </header>
              <div className="multi-ai__card-body">
                {showAnswer ? (
                  <Markdown source={result.content} />
                ) : showFailure ? (
                  <p className="multi-ai__card-note">
                    {t.aiWorkspace.result.notePrefix} {result.note || t.aiWorkspace.result.noContent}
                  </p>
                ) : result?.state === 'generating' ? (
                  <p className="multi-ai__card-note">…</p>
                ) : (
                  <p className="multi-ai__card-note multi-ai__card-note--empty">{t.aiWorkspace.ask.emptyHint}</p>
                )}
              </div>
              {showAnswer && (
                <footer className="multi-ai__card-foot">
                  <button
                    className="direction__link"
                    onClick={() => {
                      void api.aiChat.viewURL(provider).then((url) => {
                        if (url) void api.browser.open({ url })
                      })
                    }}
                  >
                    {t.aiWorkspace.result.viewSource}
                  </button>
                  <button
                    className="direction__link"
                    onClick={() => {
                      void navigator.clipboard.writeText(result.content)
                    }}
                  >
                    {t.aiWorkspace.result.copy}
                  </button>
                </footer>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
