import { useState } from 'react'
import { useI18n } from '../../i18n'
import { Accounts } from './Accounts'
import { Conversations } from './Conversations'
import { MultiAI } from './MultiAI'

/**
 * AI Workspace 容器：二级导航 + 三个区块。
 *
 * 结构刻意与 SettingsPage 同构（settings-shell 的视觉语言）——同一个应用里
 * 「二级导航」只该长一种样子。Browser 不做成区块：浏览器是全局浮窗，
 * 顶栏 Globe 随时能叫出来，在这里再造一个入口只会出现两个「浏览器」。
 */
export function AIWorkspacePage() {
  const { t } = useI18n()
  const [tab, setTab] = useState<'multi' | 'conversations' | 'accounts'>('multi')

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">{t.aiWorkspace.title}</h1>
      </header>
      <div className="page-body">
        <div className="settings-shell">
          <nav className="settings-nav" aria-label={t.aiWorkspace.title}>
            {(
              [
                ['multi', t.aiWorkspace.nav.multi],
                ['conversations', t.aiWorkspace.nav.conversations],
                ['accounts', t.aiWorkspace.nav.accounts]
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className="settings-nav__item"
                data-active={tab === key}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {tab === 'multi' && <MultiAI />}
            {tab === 'conversations' && <Conversations />}
            {tab === 'accounts' && <Accounts />}
          </div>
        </div>
      </div>
    </div>
  )
}
