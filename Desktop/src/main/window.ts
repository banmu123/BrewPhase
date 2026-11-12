import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { isEmbedFrameURL } from '../shared/link-embed'

/**
 * 一个窗口，能开的只允许是应用自己。
 *
 * `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` 是硬约束：
 * renderer 拿不到 Node，也拿不到 preload 以外的任何桥。窗口内不允许跳外部站点，
 * `window.open` 一律拒绝——外部链接交给系统浏览器，而不是在应用里开一个没有
 * 地址栏的窗口。
 */
export function createMainWindow(params: { devServerUrl: string | null }): BrowserWindow {
  const mac = process.platform === 'darwin'
  const windows = process.platform === 'win32'

  // 开发态的窗口/任务栏/Alt-Tab 图标：不设就是 Electron 原子默认图标。
  // 打包版由 electron-builder 把 build/icon.ico 烧进 exe，这里只补 dev / preview。
  const iconCandidates = windows
    ? [join(app.getAppPath(), 'build/icon.ico'), join(app.getAppPath(), 'build/icon.png')]
    : [join(app.getAppPath(), 'build/icon.png')]
  const iconPath = iconCandidates.find((candidate) => existsSync(candidate))

  const window = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'BrewPhase',
    backgroundColor: '#f7f8f6',
    ...(iconPath && !mac ? { icon: iconPath } : {}),
    // 标题栏融合：
    // - macOS：hiddenInset 保留原生红绿灯（Renderer 顶栏左上角留出位置）；
    // - Windows：hidden + 原生 titleBarOverlay——最小化/最大化/关闭仍是系统
    //   画的按钮（行为、悬停、双击最大化都与原生一致），只是画进 Renderer
    //   顶部右侧；应用顶栏用 env(titlebar-area-*) 避开按钮安全区；
    // - Linux：WCO（窗口控制叠加）在桌面环境间行为不一，保持系统标题栏，
    //   仅用 autoHideMenuBar 弱化传统菜单栏。
    titleBarStyle: mac ? 'hiddenInset' : windows ? 'hidden' : 'default',
    ...(windows
      ? {
          titleBarOverlay: {
            color: '#f7f8f6',
            symbolColor: '#30372f',
            height: 44
          }
        }
      : {}),
    // Windows/Linux：传统菜单栏默认收起（Alt 唤出）；菜单本体仍然存在，
    // Renderer 顶栏的轻量按钮会通过 IPC 以 popup 方式弹出同一份菜单。
    autoHideMenuBar: !mac,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const allowed = params.devServerUrl ? url.startsWith(params.devServerUrl) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (url.startsWith('https://')) void shell.openExternal(url)
    }
  })

  // 子框架只允许待在自己那一家的播放器域名里（YouTube / B 站）。
  // 被嵌页面想把我们当跳板去别处，或借 iframe 打开登录页，一律拒绝。
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (isEmbedFrameURL(event.url)) return
    event.preventDefault()
  })

  if (params.devServerUrl) {
    void window.loadURL(params.devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
