import { useCallback, useEffect, useState } from 'react'
import type { AIPlatformStatus } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'

/**
 * 账号：展示两个平台后台页面的登录状态。
 *
 * 登录判定只来自页面 DOM 的可见信号（输入框在不在、是否在登录页），
 * 不读 Cookie——所以显示 unknown 时，含义是「判定不了」，不是「没登录」。
 */
export function Accounts() {
  const { t } = useI18n()
  const [statuses, setStatuses] = useState<AIPlatformStatus[] | null>(null)
  const [opening, setOpening] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatuses(await api.aiChat.statuses())
    } catch {
      setStatuses(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function openLogin(provider: 'chatgpt' | 'claude'): Promise<void> {
    setOpening(provider)
    try {
      await api.aiChat.openLogin(provider)
      // 给页面一点加载时间再刷状态；登录与否仍以用户确认为准。
      setTimeout(() => void refresh(), 2500)
    } finally {
      setOpening(null)
    }
  }

  return (
    <section className="ai-accounts">
      <p className="settings-lead">{t.aiWorkspace.accounts.lead}</p>
      <div className="ai-accounts__list">
        {(['chatgpt', 'claude'] as const).map((provider) => {
          const status = statuses?.find((item) => item.provider === provider)
          const login = status?.pageAlive ? status.login : 'not_open'
          return (
            <div key={provider} className="ai-accounts__card">
              <div className="ai-accounts__head">
                <span className="ai-accounts__name">{t.aiWorkspace.providers[provider]}</span>
                <span className="ai-accounts__login" data-login={login}>
                  {t.aiWorkspace.login[login]}
                </span>
              </div>
              <p className="ai-accounts__url">
                {status?.pageAlive ? `${t.aiWorkspace.accounts.urlLabel}：${status.url}` : t.aiWorkspace.accounts.empty}
              </p>
              <div className="ai-accounts__actions">
                <button
                  className="button"
                  disabled={opening === provider}
                  onClick={() => void openLogin(provider)}
                >
                  {t.aiWorkspace.accounts.openLogin}
                </button>
                <button className="button button--ghost" onClick={() => void refresh()}>
                  {t.aiWorkspace.accounts.reloadStatus}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
