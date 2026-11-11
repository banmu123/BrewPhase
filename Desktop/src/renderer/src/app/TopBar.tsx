import { useEffect, useRef, useState } from 'react'
import { BeanIcon, CanvasIcon, RecordsIcon, SearchIcon, SlidersIcon } from '../shared/icons'
import { useI18n } from '../i18n'
import { useAppStore, type CreateKind } from './store'

/**
 * 全局顶栏：品牌 / 搜索 / 快速添加 / 设置。
 *
 * 它**不承担空间切换**——三个空间只从 Studio 首页的内容入口进入。
 * 顶栏高度固定 52px，整条是 macOS 的拖动区（`hiddenInset` 下红绿灯压在左上角，
 * 所以 mac 上留出 92px 让品牌不与红绿灯重叠）；所有控件 `no-drag`。
 */
export function TopBar(props: { onSearch: () => void; isMac: boolean }) {
  const { t } = useI18n()
  const setModule = useAppStore((state) => state.setModule)
  const requestCreate = useAppStore((state) => state.requestCreate)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // 点别处 / Esc 关闭菜单；只在打开时挂监听，不必给整页铺透明遮罩。
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const kinds: { kind: CreateKind; label: string; icon: typeof BeanIcon }[] = [
    { kind: 'bean', label: t.studio.newBean, icon: BeanIcon },
    { kind: 'text', label: t.studio.newText, icon: RecordsIcon },
    { kind: 'link', label: t.studio.newLink, icon: RecordsIcon },
    { kind: 'canvas', label: t.studio.newCanvas, icon: CanvasIcon }
  ]

  return (
    <header className="topbar" data-mac={props.isMac}>
      <button
        type="button"
        className="topbar__brand"
        onClick={() => setModule('studio')}
        title={t.studio.brand}
      >
        <PhaseOrbit />
        <span className="topbar__wordmark">{t.studio.brand}</span>
      </button>

      <div className="topbar__spacer" />

      <button
        type="button"
        className="topbar__search"
        onClick={props.onSearch}
        aria-label={t.studio.search}
      >
        <SearchIcon size={15} />
        <span>{t.studio.search}</span>
        <kbd>{props.isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      <div className="topbar__menu-anchor" ref={menuRef}>
        <button
          type="button"
          className="topbar__add"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">＋</span>
          {t.studio.quickAdd}
        </button>

        {menuOpen && (
          <div className="topbar__menu" role="menu" aria-label={t.studio.quickAddTitle}>
            <p className="topbar__menu-hint">{t.studio.quickAddHint}</p>
            {kinds.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.kind}
                  type="button"
                  role="menuitem"
                  className="topbar__menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    requestCreate(item.kind)
                  }}
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <button
        type="button"
        className="topbar__icon"
        aria-label={t.studio.settings}
        title={t.studio.settings}
        onClick={() => setModule('settings')}
      >
        <SlidersIcon size={18} />
      </button>
    </header>
  )
}

/** Phase Orbit：轨道环 + 一颗在轨的豆——品牌图形，只出现在顶栏。 */
function PhaseOrbit() {
  return (
    <svg width="22" height="22" viewBox="0 0 28 28" fill="none" aria-hidden="true">
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
