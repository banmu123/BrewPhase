import { useEffect, useState } from 'react'
import { isRoundtableAITaskBusy, ROUNDTABLE_ASK_UI_ENABLED } from '@shared/contracts'
import type { BrowserTabInfo } from '@shared/contracts'
import { cardDisplayName } from '@shared/web-cards'
import { useI18n } from '../../i18n'
import { api } from '../../shared/api'
import { useBrowserStore } from '../browser/browser-store'
import { useRoundtableAIStore } from './roundtable-ai-store'
import { useRoundtableLayoutStore } from './roundtable-layout-store'
import { useRoundtableStore } from './roundtable-store'
import { RoundtableAnswers, ROUNDTABLE_MIME } from './RoundtableSection'
import { RoundtableWorkspace } from './RoundtableWorkspace'

/**
 * 圆桌独立窗口的壳（Phase 3 / 4.2）。
 *
 * App 检测到 `#bpRoundtable=<id>` 时只渲染这个组件：没有 Studio Home、
 * 没有主窗口导航——但同一个 React 应用、同一套 i18n / 主题 / preload。
 *
 * Phase 4.2 起**窗口主体就是自由布局工作空间**：同一批 WebContentsView
 * 随拆出 / 归位迁移宿主，不创建、不销毁、不重载。提问条与讨论抽屉挂在
 * 底部——Multi-AI 问答与多网页空间共存于同一个窗口。
 */
export function RoundtableWindow() {
  const { t } = useI18n()
  const snapshot = useRoundtableStore((state) => state.snapshot)
  const dockRoundtable = useRoundtableStore((state) => state.dockRoundtable)
  const setDraggingRoundtable = useRoundtableStore((state) => state.setDraggingRoundtable)
  const dragOutside = useRoundtableStore((state) => state.dragOutside)
  const tabs = useBrowserStore((state) => state.state.tabs)
  const task = useRoundtableAIStore((state) => state.task)
  const askTask = useRoundtableAIStore((state) => state.ask)
  const stopTask = useRoundtableAIStore((state) => state.stop)
  const [answersOpen, setAnswersOpen] = useState(false)

  const busy = isRoundtableAITaskBusy(task)
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
        <span className="rt-window__title">{t.studio.roundtable.workspaceTitle}</span>
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
        <RoundtableWorkspace host="detached" />

        {/* Multi-AI 提问条（开始讨论）暂时屏蔽（ROUNDTABLE_ASK_UI_ENABLED）：
            独立窗口底部只留工作空间，恢复时整块（提问条 + 讨论抽屉）随开关回来。 */}
        {ROUNDTABLE_ASK_UI_ENABLED && (
          <>
            {/* 提问条：Multi-AI 问答与多网页空间共存（草稿仍是同一份共享状态）。 */}
            <footer className="rt-window__ask">
              <form
                className="rt-window__ask-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!busy && snapshot.draft.trim() !== '') void askTask()
                }}
              >
                <input
                  className="roundtable__ask-input"
                  placeholder={t.studio.roundtable.askPlaceholder}
                  aria-label={t.studio.roundtable.askLabel}
                  value={snapshot.draft}
                  maxLength={2_000}
                  onChange={(event) => void useRoundtableStore.getState().setDraft(event.target.value)}
                />
                {busy ? (
                  <button type="button" className="roundtable__ask-submit roundtable__ask-submit--stop" onClick={() => void stopTask()}>
                    {t.studio.roundtable.askStop}
                  </button>
                ) : (
                  <button type="submit" className="roundtable__ask-submit" disabled={snapshot.draft.trim() === ''}>
                    {t.studio.roundtable.askStart}
                  </button>
                )}
                <button
                  type="button"
                  className="rt-window__ask-toggle"
                  data-open={answersOpen}
                  data-busy={busy ? 'true' : 'false'}
                  onClick={() => setAnswersOpen((current) => !current)}
                >
                  {t.studio.roundtable.answersToggle}
                </button>
              </form>
            </footer>

            {answersOpen && (
              <aside className="rt-window__drawer">
                <header className="rt-window__drawer-head">
                  <span>{t.studio.roundtable.answersTitle}</span>
                  <button type="button" className="rt-window__drawer-close" onClick={() => setAnswersOpen(false)} aria-label={t.studio.roundtable.answersTitle}>
                    ✕
                  </button>
                </header>
                <div className="rt-window__drawer-body">
                  <RoundtableAnswers task={task} />
                </div>
              </aside>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 参与者名单（占位区/标题栏共用的小字符串）。 */
export function participantNames(participants: BrowserTabInfo[], unnamed: string): string {
  return participants.map((tab) => cardDisplayName(tab, unnamed)).join(' · ')
}
