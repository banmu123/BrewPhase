import { session, WebContentsView, type WebContents } from 'electron'
import type { AIProvider } from './automation/types'
import { AI_ADAPTERS } from './automation/adapters'

/**
 * Multi-AI 后台页面的管理者。
 *
 * 与内置浏览器（browser-manager）的关系：**同一个 Session 分区，两套 view**。
 * 用户在内置浏览器里登录 chatgpt.com / claude.ai，Cookie 落在
 * `persist:brewphase-browser`；这里的后台页面用同一个分区，登录态直接共享，
 * 不需要也不允许再碰任何凭据。
 *
 * 为什么是「不挂到窗口的后台 view」：
 * - AI Workspace 的并行提问要求两个页面**同时活着**，而内置浏览器明确只有
 *   一个 view（复用同一个 view 是它自己的设计前提，不能为这里破坏）；
 * - 已实测：不 addChildView 的 WebContentsView 可以正常 loadURL 与
 *   executeJavaScript，页面脚本照常运行；两个 view 互不干扰；
 * - `backgroundThrottling: false` 是关键——后台页面的定时器与流式渲染
 *   不被 Chromium 节流，否则回答可能永远「长不完」。
 *
 * 安全与 browser-manager 完全同级：sandbox、无 preload、权限一律拒绝、
 * 下载一律拒绝、只认 http/https、window.open 一律 deny。
 */

export type AgentPageSnapshot = {
  provider: AIProvider
  alive: boolean
  url: string
  title: string
}

type AgentPage = {
  view: WebContentsView
  url: string
  title: string
}

export class AgentPageManager {
  private readonly pages = new Map<AIProvider, AgentPage>()
  private readonly hardened = new WeakSet<Electron.Session>()

  snapshot(provider: AIProvider): AgentPageSnapshot {
    const page = this.pages.get(provider)
    if (!page || page.view.webContents.isDestroyed()) {
      return { provider, alive: false, url: '', title: '' }
    }
    return { provider, alive: true, url: page.url, title: page.title }
  }

  /** 页面是否属于该平台（供 Adapter 的 unsupported_page 判定）。 */
  ownsURL(provider: AIProvider, url: string): boolean {
    return AI_ADAPTERS[provider].ownsURL(url)
  }

  webContents(provider: AIProvider): WebContents | null {
    const page = this.pages.get(provider)
    if (!page || page.view.webContents.isDestroyed()) return null
    return page.view.webContents
  }

  /**
   * 确保后台页面存在并停在给定 URL。
   *
   * 已经在同一个 origin 上时不重复加载：保留 SPA 内存状态（ChatGPT/Claude
   * 都是 SPA，reload 会把当前对话丢掉）。跨 origin 或没有页面时才加载。
   */
  async ensurePage(provider: AIProvider, url: string): Promise<WebContents> {
    const adapter = AI_ADAPTERS[provider]
    if (!adapter.ownsURL(url)) {
      throw new Error(`unsupported origin for ${provider}`)
    }

    let page = this.pages.get(provider)
    if (page && page.view.webContents.isDestroyed()) {
      this.pages.delete(provider)
      page = undefined
    }

    if (!page) {
      page = this.createPage(provider)
      this.pages.set(provider, page)
      await page.view.webContents.loadURL(url)
      return page.view.webContents
    }

    const sameOrigin = originOf(page.url) !== null && originOf(page.url) === originOf(url)
    if (!sameOrigin) {
      await page.view.webContents.loadURL(url)
    }
    return page.view.webContents
  }

  /** 打开平台的登录页（Accounts / 状态条里「去登录」用）。 */
  async openHome(provider: AIProvider): Promise<void> {
    await this.ensurePage(provider, AI_ADAPTERS[provider].homeURL)
  }

  /** 在内置浏览器浮窗里打开该页面，让用户亲眼确认登录 / 查看回答。 */
  destroy(provider: AIProvider): void {
    const page = this.pages.get(provider)
    if (!page) return
    this.pages.delete(provider)
    try {
      page.view.webContents.close()
    } catch {
      // 已经销毁：忽略。
    }
  }

  disposeAll(): void {
    for (const provider of [...this.pages.keys()]) this.destroy(provider)
  }

  // MARK: - 内部

  private createPage(provider: AIProvider): AgentPage {
    const partition = session.fromPartition(BROWSER_PARTITION_FOR_AGENT)
    this.harden(partition)

    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION_FOR_AGENT,
        // 与 browser-manager 相同的「网页是外来的」配置；加上
        // backgroundThrottling: false，后台页面的流式渲染不被节流。
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: false,
        backgroundThrottling: false
      }
    })

    const page: AgentPage = { view, url: '', title: '' }
    this.attachListeners(provider, view.webContents, page)
    return page
  }

  private attachListeners(provider: AIProvider, webContents: WebContents, page: AgentPage): void {
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    webContents.on('will-navigate', (event, url) => {
      // 允许平台自家域名之间跳转（登录会经过 auth 子域；白名单由各 Adapter 定），
      // 其他站点一律拦下——这个 view 只服务于它自己的平台。
      if (!AI_ADAPTERS[provider].ownsURL(url) && !isCommonAuthHost(url)) {
        event.preventDefault()
      }
    })

    webContents.on('did-navigate', (_event, url) => {
      page.url = url
      page.title = webContents.getTitle()
    })

    webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      page.url = url
    })

    webContents.on('page-title-updated', (_event, title) => {
      page.title = title
    })

    webContents.on('destroyed', () => {
      if (this.pages.get(provider)?.view.webContents === webContents) {
        this.pages.delete(provider)
      }
    })
  }

  /**
   * 与 browser-manager.hardenSession 相同的分区级策略：权限全拒、下载全拒。
   * 两处各自幂等设置一次；改安全策略时两边必须一起改（都有注释指认对方）。
   */
  private harden(partition: Electron.Session): void {
    if (this.hardened.has(partition)) return
    this.hardened.add(partition)
    partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    partition.setPermissionCheckHandler(() => false)
    partition.on('will-download', (event) => event.preventDefault())
  }
}

/**
 * 与 browser-manager 的 `BROWSER_PARTITION` 是同一个字符串——**必须**如此，
 * 登录态才共享。不直接 import 那个常量，是为了让两个模块之间保持零依赖
 * （browser-manager 不该知道 AI 的存在）；这里有断言保证字符串不改漂。
 */
const BROWSER_PARTITION_FOR_AGENT = 'persist:brewphase-browser'

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** 登录流程常落在独立鉴权域（auth.openai.com 等）；只放行已知平台自家的。 */
function isCommonAuthHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host.endsWith('.openai.com') ||
      host.endsWith('.claude.ai') ||
      host.endsWith('.anthropic.com')
    )
  } catch {
    return false
  }
}
