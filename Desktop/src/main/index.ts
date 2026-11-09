import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol, session } from 'electron'
import { openDatabase, type DatabaseHandle } from './database/client'
import { registerIpc } from './ipc/register'
import { MEDIA_HOST, MEDIA_SCHEME, mediaFilePath } from './media/store'
import { createMainWindow } from './window'
import { SyncService } from './sync/sync-service'
import { pendingMetadataJobs, prepareLocalMetadata } from './database/repositories/records'
import { recordIdsToResolve, resolveRecordMetadata } from './metadata'
import { ResolveQueue } from './metadata/resolve-queue'
import { activeMetadataFixture } from './metadata/metadata-fixture'
import { EMBED_FRAME_ORIGINS } from '../shared/link-embed'

/**
 * 主进程入口。
 *
 * 启动顺序是有意为之：先开库（失败就退出，绝不带着半可用的库进界面）、再挂
 * 媒体协议、再装 IPC、最后开窗口。任何一个环节失败都不应该让窗口先亮起来。
 */

let db: DatabaseHandle | null = null
let syncService: SyncService | null = null
const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? null

/**
 * 本地元数据补全队列（Phase 3.2）：
 * - 只在 `applyBatch()` 提交之后、或应用启动扫描 pending 时入队；
 * - 并发 2，同一 recordId + URL 去重；
 * - 抓取失败不重试（状态落 failed，用户手动刷新才重来）；
 * - 结束后通知渲染层刷新，不需要用户切页。
 */
const metadataQueue = new ResolveQueue({
  concurrency: 2,
  run: async (job) => {
    const handle = db
    if (!handle) return
    await resolveRecordMetadata(
      handle.db,
      job.recordId,
      false,
      job.urlString,
      activeMetadataFixture()
    )
  },
  onSettled: () => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('records:metadata-updated')
    }
  }
})

/** 同步落库后：为新建 / URL 变更的链接准备派生元数据行，需要时入队。 */
function scheduleMetadataFor(recordIds: string[]): void {
  const handle = db
  if (!handle) return
  for (const id of recordIds) {
    try {
      const prepared = prepareLocalMetadata(handle.db, id)
      if (prepared?.needsFetch) {
        metadataQueue.enqueue({ recordId: id, urlString: prepared.urlString })
      }
    } catch (error) {
      // 单条调度失败不能影响其它记录，更不能影响同步结果
      console.error('[metadata] schedule failed', id, error)
    }
  }
}

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
  syncService = new SyncService(
    db.sqlite,
    () => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('sync:changed')
      }
    },
    (outcome) => {
      // 只处理真正落库的 record（跳过 skipped / conflict / failed）；
      // URL 是否变化由 prepareLocalMetadata 自己比对
      scheduleMetadataFor(recordIdsToResolve(outcome))
    }
  )
  void syncService.restore().catch((error) => {
    console.error('[sync] restore failed', error)
  })

  registerIpc({ db, devServerUrl, sync: syncService })
  createMainWindow({ devServerUrl })

  // 上次运行没跑完的 pending 任务（应用被关掉 / 崩溃）：接着抓，不遗忘
  try {
    for (const job of pendingMetadataJobs(db.db)) metadataQueue.enqueue(job)
  } catch (error) {
    console.error('[metadata] pending recovery failed', error)
  }

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
 *
 * `frame-src` 只放行官方播放器来源（YouTube / B 站），与 `@shared/link-embed`
 * 共用同一份白名单；不写 `https:`，否则任意站点都能进 iframe。
 */
function applyCsp(target: Electron.Session, dev: string | null): void {
  const frameSrc = `frame-src ${EMBED_FRAME_ORIGINS.join(' ')}`
  // img-src 的 https: 是远程缩略图（og:image、i.ytimg.com）的加载通道；
  // 失败由组件落平台 fallback，不放宽 connect-src/script-src 等其他指令。
  // media-src bpmedia: 是画布节点内嵌视频（<video>）的加载通道——没有它
  // media 请求会回退 default-src 被拦，video 只会静默 onError。
  const policy = dev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' bpmedia: data: https: blob:",
        "media-src 'self' bpmedia:",
        "font-src 'self' data:",
        frameSrc,
        "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*"
      ].join('; ')
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' bpmedia: data: https:",
        "media-src 'self' bpmedia:",
        "font-src 'self' data:",
        frameSrc,
        "connect-src 'self'"
      ].join('; ')

  target.webRequest.onHeadersReceived((details, callback) => {
    // 只给**应用自己的顶层文档**下发 CSP。iframe 里加载的是平台的播放器页面，
    // 给它塞一条 `default-src 'self'` 会把播放器自己的脚本全部拦死——
    // 表现就是一块黑屏，而且看不出是 CSP 干的。
    if (details.resourceType !== 'mainFrame') return callback({})
    const own = dev ? details.url.startsWith(dev) : details.url.startsWith('file://')
    if (!own) return callback({})

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}
