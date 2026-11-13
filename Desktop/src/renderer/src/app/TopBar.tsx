import { useEffect, useRef, useState } from 'react'
import { BeanIcon, CanvasIcon, GlobeIcon, MenuIcon, RecordsIcon, SearchIcon, SlidersIcon, SparkIcon } from '../shared/icons'
import { useI18n } from '../i18n'
import { useBrowserStore } from '../features/browser/browser-store'
import { api } from '../shared/api'
import { useAppStore, type CreateKind } from './store'

/** 平台形态：决定标题栏左侧（红绿灯）与右侧（Windows 原生按钮）的留白。 */
export type TitleBarPlatform = 'mac' | 'windows' | 'other'

/**
 * 全局顶栏 = 融合式标题栏（44px）。
 *
 * 整条是拖动区；交互控件 `no-drag`。macOS 上红绿灯压在左上角（`hiddenInset`，
 * 左侧留 80px）；Windows 上原生最小化/最大化/关闭画在右上角
 * （`titleBarOverlay`，CSS 用 `env(titlebar-area-*)` 避开按钮安全区）；
 * Windows/Linux 还有一个轻量菜单按钮，把主进程的应用菜单弹成 popup——
 * 传统菜单栏由 `autoHideMenuBar` 收起，功能与快捷键一份不少。
 */
export function TopBar(props: { onSearch: () => void; platform: TitleBarPlatform }) {
  const { t } = useI18n()
  const setModule = useAppStore((state) => state.setModule)
  const module = useAppStore((state) => state.module)
  const requestCreate = useAppStore((state) => state.requestCreate)
  const openBrowser = useBrowserStore((state) => state.open)
  const browserVisible = useBrowserStore((state) => state.state.visible)
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
    <header className="topbar" data-platform={props.platform}>
      {props.platform !== 'mac' && (
        <button
          type="button"
          className="topbar__appmenu"
          aria-label={t.studio.appMenu}
          title={t.studio.appMenu}
          onClick={() => void api.app.popupMenu()}
        >
          <MenuIcon size={16} />
        </button>
      )}

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

      {/*
        * AI Workspace 入口：一级导航（Multi-AI 并行提问是默认页）。
        * 放在品牌之后、搜索之前——它是「工作」而不是「辅助操作」。
        */}
      <button
        type="button"
        className="topbar__nav"
        data-active={module === 'ai'}
        aria-pressed={module === 'ai'}
        onClick={() => setModule('ai')}
      >
        <SparkIcon size={16} />
        <span>{t.aiWorkspace.title}</span>
      </button>

      <button
        type="button"
        className="topbar__search"
        onClick={props.onSearch}
        aria-label={t.studio.search}
      >
        <SearchIcon size={15} />
        <span>{t.studio.search}</span>
        <kbd>{props.platform === 'mac' ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      {/*
        * 浏览器入口：放在「随时可用」的辅助操作里，紧挨搜索与快速添加。
        * 不新增侧栏、也不恢复三空间全局导航——它只是把已存在的浮窗叫出来。
        * 已打开时再点不会新建，只会让它重新可见（主进程只有一个 view）。
        */}
      <button
        type="button"
        className="topbar__icon"
        aria-label={t.browser.open}
        aria-pressed={browserVisible}
        title={t.browser.label}
        data-active={browserVisible}
        onClick={() => void openBrowser()}
      >
        <GlobeIcon size={18} />
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
