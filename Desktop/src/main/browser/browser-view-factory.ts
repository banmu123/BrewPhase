import { session, WebContentsView, type WebContents } from 'electron'

/**
 * 浏览器视图工厂：`WebContentsView` 的创建与分区加固只在这一处。
 *
 * browser-manager（主窗口浮窗）与 float-window（独立窗口）都要创建 view，
 * 两边的安全配置**必须**完全一致——网页是外来的，任何一边松一档都是漏洞。
 * 从 browser-manager 提取到这里，就是为了「两处漂移」在结构上不可能。
 */

/** 与内置浏览器、AI Workspace 后台页共用的持久分区：登录一次，处处可用。 */
export const BROWSER_PARTITION = 'persist:brewphase-browser'

export function hardenBrowserSession(partition: Electron.Session, alreadyHardened: WeakSet<Electron.Session>): void {
  if (alreadyHardened.has(partition)) return
  alreadyHardened.add(partition)
  // 权限全拒：本阶段没有任何「用户明确同意」的授权界面。
  partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  partition.on('will-download', (event) => event.preventDefault())
}

export function createBrowserView(): WebContentsView {
  const partition = session.fromPartition(BROWSER_PARTITION)
  hardenBrowserSession(partition, hardenedSessions)

  const view = new WebContentsView({
    webPreferences: {
      partition: BROWSER_PARTITION,
      // 网页是外来的：不给 Node、不给 preload、不给任何桥。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false
    }
  })
  view.setBackgroundColor('#ffffff')
  return view
}

/** 与 hardenedBrowserSession 配对的已加固集合；一个分区只加固一次。 */
const hardenedSessions = new WeakSet<Electron.Session>()

/** 与 browser-manager 相同的导航守卫：只认 http/https，window.open 全拒。 */
export function attachBrowserGuards(
  webContents: WebContents,
  isAllowed: (url: string) => boolean
): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) event.preventDefault()
  })
  webContents.on('will-frame-navigate', (event) => {
    if (!isAllowed(event.url)) event.preventDefault()
  })
  webContents.on('will-attach-webview', (event) => event.preventDefault())
}
