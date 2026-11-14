import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/contracts'
import { api } from '../shared/api'
import { CanvasPage } from '../features/canvas/CanvasPage'
import { BrowserFloatWindow } from '../features/browser/BrowserFloatWindow'
import { CoffeePage } from '../features/coffee/CoffeePage'
import { RecordsPage } from '../features/records/RecordsPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { StudioHome } from '../features/studio/StudioHome'
import { BrowserPanel } from '../features/browser/BrowserPanel'
import { subscribeBrowserState, useBrowserStore } from '../features/browser/browser-store'
import { subscribeBrowserPreviews, useBrowserPreviewStore } from '../features/browser/preview-store'
import { useI18n } from '../i18n'
import { hasSeenOnboarding, hasSeenOnboardingV2, markOnboardingSeen, Onboarding } from './Onboarding'
import { SearchPalette } from './SearchPalette'
import { TopBar } from './TopBar'
import { useAppStore } from './store'
import { ConfirmHost } from '../shared/ConfirmDialog'
import { titleBarPlatform } from '../shared/platform'

/**
 * Studio Desk 外壳：一条极简全局顶栏 + 自适应工作区。
 *
 * 没有固定侧栏、也没有三空间的全局 Tab——默认落在 Studio Home，三个空间
 * 只从首页的内容入口进入（返回入口在各自页头）。顶栏只负责品牌、搜索、
 * 快速添加与设置，不承担空间切换。AI 讨论不再有独立一级页面（Roundtable
 * Phase 1 起由 Studio Home 底部的圆桌承载；AIWorkspacePage 及 ai-chat
 * 服务保留在代码里，等待后续阶段重新接入）。
 */
export function App() {
  const { module } = useAppStore()
  const { t } = useI18n()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  // 设置页可以随时重新打开接入向导；那条路径直接进 AI 分支。
  const agentOnboarding = useAppStore((state) => state.agentOnboarding)
  const closeAgentOnboarding = useAppStore((state) => state.closeAgentOnboarding)
  const [searchOpen, setSearchOpen] = useState(false)
  /** 平台形态：mac 红绿灯在左上角；Windows 原生按钮叠在右上角（WCO）。 */
  const platform = titleBarPlatform()

  useEffect(() => {
    api.app
      .info()
      .then(setInfo)
      .catch((cause: Error) => setError(cause.message))
  }, [])

  /**
   * 浏览器浮窗是**全局**的：订阅装一次、面板挂在模块切换之外，
   * 所以在 Coffee / Records / Canvas / Settings 之间走动时它不会消失。
   */
  useEffect(() => {
    const unsubscribe = subscribeBrowserState()
    void useBrowserStore.getState().hydrate()
    // 缩略图是独立通道：首次补齐 + 之后只接收 update/clear。
    const unsubscribePreviews = subscribeBrowserPreviews()
    void useBrowserPreviewStore.getState().hydrate()
    return () => {
      unsubscribe()
      unsubscribePreviews()
    }
  }, [])

  // 首次启动引导（配对指引）：打包版 + 没看过 + 未配对时出现一次。
  // 判定三条件都在 App 层收口，Onboarding 只负责呈现与出口。
  useEffect(() => {
    if (!info?.onboardingEligible) return
    // 看过新版引导：直接退出。
    if (hasSeenOnboardingV2()) return
    // 看过旧版的老用户：静默补上新标记，不因升级再弹一次。
    if (hasSeenOnboarding()) {
      markOnboardingSeen()
      return
    }
    // 已经配过对、或已经建过 MCP Client 的用户，都不需要被首次引导拦住。
    // 两件事都是「这个人在配置上已经动过手」的证据，任一成立就静默补标记；
    // 之后仍可从 设置 → AI 连接 主动重新打开。
    void Promise.all([api.sync.status(), api.mcp.listClients()])
      .then(([sync, clients]) => {
        const hasActiveClient = clients.some((client) => client.revokedAt === null)
        if (sync.devices.length > 0 || hasActiveClient) {
          markOnboardingSeen()
          return
        }
        setOnboardingOpen(true)
      })
      .catch(() => undefined)
  }, [info])

  // ⌘K / Ctrl+K 打开搜索：搜索是顶栏唯一的「随时可用」动作。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 独立浏览器窗口：同一份应用，#bpFloat=<windowId> 时只渲染浮窗壳。
  const floatWindowId = Number(/bpFloat=(\d+)/.exec(window.location.hash)?.[1]) || null

  if (floatWindowId) {
    return <BrowserFloatWindow windowId={floatWindowId} />
  }

  return (
    <>
      <div className="app">
        <TopBar platform={platform} onSearch={() => setSearchOpen(true)} />

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
          ) : module === 'settings' ? (
            <SettingsPage info={info} />
          ) : (
            <StudioHome />
          )}
        </main>
      </div>

      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
      {(onboardingOpen || agentOnboarding) && (
        <Onboarding
          initialStage={agentOnboarding ? 'agent' : 'welcome'}
          onClose={() => {
            setOnboardingOpen(false)
            closeAgentOnboarding()
          }}
        />
      )}
      {/* 命令式确认框（confirmAction）的宿主：挂在最外层，任何页面都能弹。 */}
      <ConfirmHost />
      {/* 浏览器浮在最上层，但仍在 Modal（z-index 100）之下：
          未来的「保存到 Records」表单要能盖住它。 */}
      <BrowserPanel />
    </>
  )
}
