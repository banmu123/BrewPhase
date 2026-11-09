import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/contracts'
import { api } from '../shared/api'
import { BeanIcon, CanvasIcon, RecordsIcon, SlidersIcon } from '../shared/icons'
import { CanvasPage } from '../features/canvas/CanvasPage'
import { CoffeePage } from '../features/coffee/CoffeePage'
import { RecordsPage } from '../features/records/RecordsPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { useI18n } from '../i18n'
import { useAppStore, type ModuleKey } from './store'

/**
 * Light Studio 外壳：76px 窄侧边栏 + 自适应主工作区。
 *
 * 侧栏只是空间切换工具，不是视觉中心——Phase Orbit 品牌图形在顶，
 * 三个空间用图标 + 小字，设置沉底。左侧栏整体是 macOS 的拖动区，
 * 红绿灯落在它的上沿；条目本身 no-drag。
 */
export function App() {
  const { module, setModule } = useAppStore()
  const { t } = useI18n()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.app
      .info()
      .then(setInfo)
      .catch((cause: Error) => setError(cause.message))
  }, [])

  const spaces: { key: ModuleKey; label: string; hint: string; icon: typeof BeanIcon }[] = [
    { key: 'records', label: t.navigation.records, hint: t.navigation.hint.records, icon: RecordsIcon },
    { key: 'coffee', label: t.navigation.coffee, hint: t.navigation.hint.coffee, icon: BeanIcon },
    { key: 'canvas', label: t.navigation.canvas, hint: t.navigation.hint.canvas, icon: CanvasIcon }
  ]

  const systems: { key: ModuleKey; label: string; hint: string; icon: typeof BeanIcon }[] = [
    { key: 'settings', label: t.navigation.settings, hint: t.navigation.hint.settings, icon: SlidersIcon }
  ]

  const renderItem = (item: (typeof spaces)[number]) => {
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
        <Icon size={20} />
        <span>{item.label}</span>
      </button>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <PhaseOrbit />
          <span className="sr-only">BREWPHASE</span>
        </div>

        <nav className="sidebar__nav">{spaces.map(renderItem)}</nav>

        <div className="sidebar__spacer" />
        {systems.map(renderItem)}
        <div className="sidebar__meta">{info ? `v${info.appVersion}` : '—'}</div>
      </aside>

      <main className="workspace">
        {error ? (
          <div className="empty" style={{ margin: 40 }}>
            <strong>{t.navigation.appUnreachable}</strong>
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

/** Phase Orbit：轨道环 + 一颗在轨的豆——品牌图形，只出现在这里。 */
function PhaseOrbit() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <ellipse
        cx="14"
        cy="14"
        rx="11.5"
        ry="7.5"
        transform="rotate(-24 14 14)"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity="0.5"
      />
      <circle cx="14" cy="14" r="3.6" fill="currentColor" />
      <circle cx="22.6" cy="8.2" r="1.9" fill="currentColor" opacity="0.85" />
    </svg>
  )
}
