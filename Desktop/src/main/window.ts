import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'

/**
 * 一个窗口，能开的只允许是应用自己。
 *
 * `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` 是硬约束：
 * renderer 拿不到 Node，也拿不到 preload 以外的任何桥。窗口内不允许跳外部站点，
 * `window.open` 一律拒绝——外部链接交给系统浏览器，而不是在应用里开一个没有
 * 地址栏的窗口。
 */
export function createMainWindow(params: { devServerUrl: string | null }): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: 'BrewPhase',
    backgroundColor: '#f6f1e7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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

  if (params.devServerUrl) {
    void window.loadURL(params.devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
