import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/contracts'
import { api } from '../shared/api'
import { BeanIcon, CanvasIcon, RecordsIcon, SlidersIcon } from '../shared/icons'
import { CanvasPage } from '../features/canvas/CanvasPage'
import { CoffeePage } from '../features/coffee/CoffeePage'
import { RecordsPage } from '../features/records/RecordsPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { useAppStore, type ModuleKey } from './store'

const SPACES: { key: ModuleKey; label: string; hint: string; icon: typeof BeanIcon }[] = [
  { key: 'coffee', label: '咖啡', hint: '豆子与冲煮', icon: BeanIcon },
  { key: 'records', label: '记录', hint: '收藏的资料', icon: RecordsIcon },
  { key: 'canvas', label: '画布', hint: '整理与创作', icon: CanvasIcon }
]

const SYSTEM: { key: ModuleKey; label: string; hint: string; icon: typeof BeanIcon }[] = [
  { key: 'settings', label: '更多', hint: '应用与数据', icon: SlidersIcon }
]

/**
 * 外壳：Café Workspace。
 *
 * 左边是「自己的工作室导航」——品牌、空间、系统三段，暖纸底；右边是当前
 * 空间。三个业务模块同级，谁也不寄生在谁里面。侧边栏上部留给 macOS 红绿灯
 * （`-webkit-app-region: drag`），条目本身 no-drag。
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

  const renderItem = (item: (typeof SPACES)[number]) => {
    const Icon = item.icon
    return (
      <button
        key={item.key}
        className="sidebar__item"
        data-active={module === item.key}
        onClick={() => setModule(item.key)}
        aria-label={item.label}
        title={item.hint}
      >
        <Icon size={18} />
        <span>{item.label}</span>
      </button>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">BREWPHASE</div>

        <div className="sidebar__group">空间</div>
        {SPACES.map(renderItem)}

        <div className="sidebar__group">系统</div>
        {SYSTEM.map(renderItem)}

        <div className="sidebar__spacer" />
        <div className="sidebar__meta">
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
