import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/contracts'
import { api } from '../shared/api'
import { BeanIcon, CanvasIcon, RecordsIcon, SlidersIcon } from '../shared/icons'
import { CanvasPage } from '../features/canvas/CanvasPage'
import { CoffeePage } from '../features/coffee/CoffeePage'
import { RecordsPage } from '../features/records/RecordsPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { useAppStore, type ModuleKey } from './store'

const MODULES: { key: ModuleKey; label: string; icon: typeof BeanIcon }[] = [
  { key: 'coffee', label: '咖啡', icon: BeanIcon },
  { key: 'records', label: '记录', icon: RecordsIcon },
  { key: 'canvas', label: '画布', icon: CanvasIcon },
  { key: 'settings', label: '更多', icon: SlidersIcon }
]

/**
 * 外壳：左侧模块栏 + 当前模块。三个业务模块同级，谁也不寄生在谁里面。
 * 顶部留出 macOS 红绿灯的位置（`-webkit-app-region: drag` 在 rail 上）。
 */
export function App() {
  const { module, setModule } = useAppStore()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.app
      .info()
      .then(setInfo)
      .catch((cause: Error) => setError(cause.message))
  }, [])

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail__brand">BREWPHASE</div>
        {MODULES.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.key}
              className="rail__item"
              data-active={module === item.key}
              onClick={() => setModule(item.key)}
              aria-label={item.label}
            >
              <Icon size={19} />
              <span>{item.label}</span>
            </button>
          )
        })}
        <div className="rail__spacer" />
        <div className="rail__meta">
          {info ? `v${info.appVersion}` : '—'}
          <br />
          {info ? info.platform : ''}
        </div>
      </aside>

      <main className="workspace">
        {error ? (
          <div className="empty" style={{ margin: 40 }}>
            <strong>应用没能连上本地服务。</strong>
            <div className="error">{error}</div>
          </div>
        ) : module === 'coffee' ? (
          <CoffeePage />
        ) : module === 'records' ? (
          <RecordsPage />
        ) : module === 'canvas' ? (
          <CanvasPage />
        ) : (
          <SettingsPage info={info} />
        )}
      </main>
    </div>
  )
}
