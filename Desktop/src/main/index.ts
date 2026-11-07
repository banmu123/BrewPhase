import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol, session } from 'electron'
import { openDatabase, type DatabaseHandle } from './database/client'
import { registerIpc } from './ipc/register'
import { MEDIA_HOST, MEDIA_SCHEME, mediaFilePath } from './media/store'
import { createMainWindow } from './window'
import { SyncService } from './sync/sync-service'

/**
 * 主进程入口。
 *
 * 启动顺序是有意为之：先开库（失败就退出，绝不带着半可用的库进界面）、再挂
 * 媒体协议、再装 IPC、最后开窗口。任何一个环节失败都不应该让窗口先亮起来。
 */

let db: DatabaseHandle | null = null
let syncService: SyncService | null = null
const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? null

// 自定义协议必须在 app ready 之前声明权限：媒体图片要给 <img> 用。
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

// 便携/测试场景：库与媒体目录整体重定向。必须在 requestSingleInstanceLock
// 之前设置——实例锁文件就在 userData 里，重定向后不同目录可各自持锁。
if (process.env.BREWPHASE_USER_DATA_DIR) {
  app.setPath('userData', process.env.BREWPHASE_USER_DATA_DIR)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(bootstrap).catch((error) => {
    console.error('[main] failed to start', error)
    app.quit()
  })
}

function bootstrap(): void {
  db = openDatabase(join(app.getPath('userData'), 'brewphase.db'))

  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== MEDIA_HOST) return new Response('not found', { status: 404 })
      const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
      return await net.fetch(pathToFileURL(mediaFilePath(name)).toString())
    } catch {
      // 名字不合法 / 文件已不在：都按「没有这张图」处理，不泄漏路径。
      return new Response('not found', { status: 404 })
    }
  })

  applyCsp(session.defaultSession, devServerUrl)

  // 同步服务：按持久化开关恢复（用户启用过才监听端口）。
  syncService = new SyncService(db.sqlite, () => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('sync:changed')
    }
  })
  void syncService.restore().catch((error) => {
    console.error('[sync] restore failed', error)
  })

  registerIpc({ db, devServerUrl, sync: syncService })
  createMainWindow({ devServerUrl })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ devServerUrl })
  })
}

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows()
  if (window) {
    if (window.isMinimized()) window.restore()
    window.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  db?.close()
  db = null
})

/**
 * CSP 由主进程下发，而不是只写在 HTML 里——meta 标签可以被注入的内容绕过，
 * 响应头不能。开发时放开 HMR 需要的 ws 与 eval，生产收紧到最小。
 */
function applyCsp(target: Electron.Session, dev: string | null): void {
  const policy = dev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' bpmedia: data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*"
      ].join('; ')
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' bpmedia: data:",
        "font-src 'self' data:",
        "connect-src 'self'"
      ].join('; ')

  target.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}
