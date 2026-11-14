import { useEffect } from 'react'
import type { BrowserTabInfo } from '@shared/contracts'
import { cardDisplayName } from '@shared/web-cards'
import { useI18n } from '../../i18n'
import { api } from '../../shared/api'
import { useBrowserStore } from '../browser/browser-store'
import { useRoundtableStore } from './roundtable-store'
import { ROUNDTABLE_MIME, RoundtableBody } from './RoundtableSection'

/**
 * 圆桌独立窗口的壳（Phase 3）。
 *
 * App 检测到 `#bpRoundtable=<id>` 时只渲染这个组件：没有 Studio Home、
 * 没有主窗口导航——但同一个 React 应用、同一套 i18n / 主题 / preload。
 *
 * 标题栏的把手段是**拖回归位**的 OS 拖拽源：把它拖到主窗口的圆桌占位区
 * 松手（drop → dock），或直接点「归位」按钮——两种路径完全同效，都是
 * 主进程 RoundtableService.dock()（状态不丢，窗口随之关闭）。
 */
export function RoundtableWindow() {
  const { t } = useI18n()
  const snapshot = useRoundtableStore((state) => state.snapshot)
  const dockRoundtable = useRoundtableStore((state) => state.dockRoundtable)
  const setDraggingRoundtable = useRoundtableStore((state) => state.setDraggingRoundtable)
  const dragOutside = useRoundtableStore((state) => state.dragOutside)
  const tabs = useBrowserStore((state) => state.state.tabs)

  const participants = snapshot.participantTabIds
    .map((tabId) => tabs.find((tab) => tab.id === tabId))
    .filter((tab): tab is BrowserTabInfo => Boolean(tab))

  // Esc = 归位（独立圆桌最自然的取消路径）；输入框有内容时先失焦。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const active = document.activeElement
      if (active instanceof HTMLInputElement && active.value !== '') {
        active.blur()
        return
      }
      event.preventDefault()
      void dockRoundtable()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dockRoundtable])

  return (
    <div className="rt-window">
      <header className="rt-window__titlebar" title={t.studio.roundtable.dragBackHint}>
        {/* 专用拖回手柄：标题栏本体负责移动窗口（app-region drag），
            OS 拖拽源必须与它分开——同一个区域两者会互相抢事件。 */}
        <span
          className="rt-window__grip"
          draggable
          aria-label={t.studio.roundtable.dragBackHint}
          title={t.studio.roundtable.dragBackHint}
          onDragStart={(event) => {
            if ((event.target as HTMLElement).closest('button, input, a, select, textarea')) {
              event.preventDefault()
              return
            }
            event.dataTransfer.setData(ROUNDTABLE_MIME, '1')
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setDragImage(event.currentTarget.closest('.rt-window') ?? event.currentTarget, 120, 20)
            setDraggingRoundtable(true)
            void api.roundtable.dragBegin().catch(() => undefined)
          }}
          onDragEnd={(event) => {
            setDraggingRoundtable(false)
            void api.roundtable.dragEnd({ screenX: event.screenX, screenY: event.screenY }).catch(() => undefined)
          }}
        >
          ⠿
        </span>
        <span className="rt-window__brand">BREWPHASE</span>
        <span className="rt-window__title">{t.studio.roundtable.title}</span>
        {participants.length > 0 && (
          <span className="rt-window__count">{t.studio.roundtable.count(participants.length)}</span>
        )}
        <span className="rt-window__hint" data-outside={dragOutside} role="status">
          {dragOutside ? t.studio.roundtable.dragBackHint : ''}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="rt-window__dock"
          title={t.studio.roundtable.dock}
          aria-label={t.studio.roundtable.dock}
          onClick={() => void dockRoundtable()}
        >
          {t.studio.roundtable.dockAction}
        </button>
      </header>

      <div className="rt-window__body">
        <RoundtableBody participants={participants} />
      </div>
    </div>
  )
}

/** 参与者名单（占位区/标题栏共用的小字符串）。 */
export function participantNames(participants: BrowserTabInfo[], unnamed: string): string {
  return participants.map((tab) => cardDisplayName(tab, unnamed)).join(' · ')
}
