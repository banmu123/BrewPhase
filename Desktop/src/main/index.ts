import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol, screen, session } from 'electron'
import { installApplicationMenu } from './app-menu'
import { openDatabase, type DatabaseHandle } from './database/client'
import { registerIpc } from './ipc/register'
import { MEDIA_HOST, MEDIA_SCHEME, mediaFilePath } from './media/store'
import { resolveUserDataDir } from './paths'
import { createMainWindow } from './window'
import { SyncService } from './sync/sync-service'
import { pendingMetadataJobs, prepareLocalMetadata } from './database/repositories/records'
import { recordIdsToResolve, resolveRecordMetadata } from './metadata'
import { ResolveQueue } from './metadata/resolve-queue'
import { activeMetadataFixture } from './metadata/metadata-fixture'
import { ApplicationEvents } from './application/events/application-events'
import { RecordService } from './application/records/record-service'
import { WorkContextService } from './application/work-context/work-context-service'
import { PersonalDirectionService } from './application/personal-direction/personal-direction-service'
import { CoffeeService } from './application/coffee/coffee-service'
import { CanvasService } from './application/canvas/canvas-service'
import { McpClientService } from './application/authorization/permission-service'
import { BrowserManager } from './browser/browser-manager'
import { BrowserDragSessionManager } from './browser/browser-drag'
import { RoundtableService } from './roundtable/roundtable-service'
import { RoundtableWindowManager } from './roundtable/roundtable-window-manager'
import { ROUNDTABLE_CHANGED_CHANNEL, ROUNDTABLE_ID, type RoundtableSnapshot } from '../shared/roundtable'
import { AIChatService } from './ai-chat/ai-chat-service'
import { BookmarkService } from './browser/bookmark-service'
import { ChromeService } from './integrations/chrome/chrome-service'
import { resolveDataLocation, setActiveDataDir } from './data-location'
import { DataLocationService } from './data-location-service'
import { BridgeServer } from './mcp-bridge/bridge-server'
import { BRIDGE_PROTOCOL_VERSION, bridgePaths, platformSupportsBridge } from './mcp-bridge/bridge-contract'
import type { McpBridgeStatus } from '../shared/contracts/mcp'
import { APP_VERSION } from '../shared/contracts/version'
import { EMBED_FRAME_ORIGINS } from '../shared/link-embed'

/**
 * MCP STDIO 入口的绝对路径。
 *
 * 打包后入口**不能**留在 `app.asar` 里：它是被 Codex / WorkBuddy 这类外部
 * 客户端用普通 Node `spawn` 起来的，而 Node 不认识 asar 的虚拟文件系统。
 * 所以 electron-builder 用 extraResources 把入口连同它需要的三个包
 * （@modelcontextprotocol/server、core、zod）复制到 `<resources>/mcp/`，
 * 这里返回那个真实路径。开发态仍用仓库内的 out/mcp。
 *
 * 纯函数式导出，便于单测在不启动 Electron 的情况下核对两种分支。
 */
export function resolveMcpEntryPath(params?: {
  packaged?: boolean
  resourcesPath?: string
  appPath?: string
}): string {
  const packaged = params?.packaged ?? app.isPackaged
  if (packaged) {
    const resources = params?.resourcesPath ?? process.resourcesPath
    return join(resources, 'mcp', 'stdio.mjs')
  }
  const appPath = params?.appPath ?? app.getAppPath()
  return join(appPath, 'out', 'mcp', 'stdio.mjs')
}

/**
 * 主进程入口。
 *
 * 启动顺序是有意为之：先开库（失败就退出，绝不带着半可用的库进界面）、再挂
 * 媒体协议、再装 IPC、最后开窗口。任何一个环节失败都不应该让窗口先亮起来。
 */

let db: DatabaseHandle | null = null
let syncService: SyncService | null = null
let bridgeServer: BridgeServer | null = null
let chromeService: ChromeService | null = null
let browserManager: BrowserManager | null = null
/** 主窗口的显式引用：getAllWindows 的顺序不可靠（浮窗加入后尤其如此）。 */
let mainWindowRef: BrowserWindow | null = null
let aiChatService: AIChatService | null = null
let quitting = false
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
// 打包版另有固定隔离：开发态与正式安装不能共用同一个库（见 paths.ts）。
const userDataDir = resolveUserDataDir(
  app.getPath('appData'),
  app.isPackaged,
  process.env.BREWPHASE_USER_DATA_DIR
)
if (userDataDir) app.setPath('userData', userDataDir)

// 业务数据目录（db + media）默认等于 userData，可在设置里改到任意空目录。
// 这个解析必须在打开数据库之前完成；配置损坏时回退默认，不阻塞启动。
const initialDataLocation = resolveDataLocation(app.getPath('userData'))
setActiveDataDir(initialDataLocation.dataDir)

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
  // Windows 的任务栏分组与系统通知身份：必须与 electron-builder 的 appId
  // 一致，否则任务栏、通知、系统弹窗都会显示「Electron」的默认原子图标。
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.brewphase.desktop')
  }

  // 开发态跑的是 Electron 自己的二进制，Dock 会显示 Electron 默认图标；
  // 打包版的图标来自 electron-builder 的 build/icon.icns，这里只补 dev / preview。
  if (!app.isPackaged && process.platform === 'darwin') {
    const iconPath = join(app.getAppPath(), 'build/icon.png')
    if (existsSync(iconPath)) app.dock?.setIcon(iconPath)
  }

  db = openDatabase(join(initialDataLocation.dataDir, 'brewphase.db'))

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

  // Application Service：Renderer IPC 与 MCP Bridge 共用。
  // Coffee 的 IPC 是纯读取（无业务规则），仍直连 Repository；MCP 侧走
  // CoffeeService 做只读 DTO 与参数收敛。
  const events = new ApplicationEvents()
  events.onChanged((domain) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('app:changed', domain)
    }
  })
  const records = new RecordService(db.db, db.deviceId, events, scheduleMetadataFor)
  const coffee = new CoffeeService(db.db)
  const canvas = new CanvasService(db.db, db.deviceId, events)
  const clients = new McpClientService(db.db)
  const workContexts = new WorkContextService(db.db, events)
  const personalDirection = new PersonalDirectionService(db.db, events)

  const bridgeStatus = (): McpBridgeStatus => ({
    running: bridgeServer?.isRunning() ?? false,
    socketPath: bridgeServer?.socketPath() ?? null,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    clientCount: clients.count(),
    userDataDir: app.getPath('userData'),
    mcpEntryPath: resolveMcpEntryPath(),
    platformSupported: platformSupportsBridge()
  })

  // Local Bridge：macOS/Linux 用 Unix socket，Windows 用 Named Pipe（ACL 限当前用户）。
  if (platformSupportsBridge()) {
    const server = new BridgeServer(
      bridgePaths(app.getPath('userData')),
      { db: db.db, clients, records, coffee, canvas, workContexts, personalDirection },
      APP_VERSION
    )
    bridgeServer = server
    void server.start().catch((error) => {
      console.error('[mcp-bridge] start failed', error)
      bridgeServer = null
    })
  }

  // 内置浏览器：先建管理器，再开窗。`getWindow` 是取值函数而不是窗口对象——
  // macOS 关窗后重新激活会换一个 BrowserWindow 实例，浮窗必须跟着走，
  // 否则原生视图会挂在一个已经销毁的父节点上。
  //
  // 拖拽会话（Phase 3）：网页卡片与圆桌共用同一个「单鼠标」会话。会话的
  // 落点判定/广播/拆窗回调都指向下面声明的引用（声明顺序解耦）。
  let roundtableService: RoundtableService | null = null
  const dragSession = new BrowserDragSessionManager({
    cursor: () => screen.getCursorScreenPoint(),
    classify: (point) => browserManager?.classifyDragPoint(point) ?? { windowId: null, mainWindow: false },
    onFrame: (frame) => browserManager?.broadcastDragFrame(frame),
    onReleaseOutside: (kind, tabId, point) => {
      if (kind === 'webcard' && tabId) {
        browserManager?.detachTab(tabId, point.x, point.y)
        return
      }
      // 圆桌标题栏拖出：窗口外松手 → 独立窗口贴近松手点（规格 §4.6）。
      roundtableService?.detach(point)
    },
    // 链路埋点：开发终端可见，用户排障时按 [drag] 过滤即可确认断在哪一环。
    log: (message) => console.log(`[drag] ${message}`)
  })

  browserManager = new BrowserManager({
    db: db.db,
    getWindow: () => mainWindowRef,
    devServerUrl,
    drag: dragSession,
    // 标签被销毁：圆桌立刻摘除失效参与者（两个窗口同步）。
    onTabClosed: () => {
      roundtableService?.syncTabs(browserManager?.liveTabIds() ?? [])
    }
  })

  // AI 圆桌（Phase 3）：主进程唯一状态 + 唯一实例的独立窗口。
  const roundtableManager = new RoundtableWindowManager({
    devServerUrl,
    roundtableId: ROUNDTABLE_ID,
    mainWindowPosition: () => {
      const main = mainWindowRef
      if (!main || main.isDestroyed()) return null
      const [x, y] = main.getPosition()
      return { x, y }
    },
    // 系统 ✕ = 归位（不是删状态）；应用退出时放行（isQuitting）。
    onUserClose: () => roundtableService?.dock(),
    // 窗口被外部销毁（崩溃 / destroy）：状态归位，不卡在 detached。
    onWindowLost: () => roundtableService?.dock(),
    isQuitting: () => quitting,
    onChange: () => {
      // 圆桌窗口消失时拖拽会话可能还挂着（拖回流程里 drop → dock 关窗，
      // dragend 再也到不了）：强制收尾，否则会话单例会挡住下一次拖动。
      dragSession.cancel()
      roundtableService && broadcastRoundtable(roundtableService.snapshot())
    }
  })
  const broadcastRoundtable = (snapshot: RoundtableSnapshot): void => {
    const main = mainWindowRef
    if (main && !main.isDestroyed()) main.webContents.send(ROUNDTABLE_CHANGED_CHANNEL, snapshot)
    roundtableManager.send(ROUNDTABLE_CHANGED_CHANNEL, snapshot)
  }
  roundtableService = new RoundtableService({
    isTabAlive: (tabId) => browserManager?.hasTab(tabId) ?? false,
    broadcast: broadcastRoundtable,
    createWindow: (near) => roundtableManager.create(near),
    closeWindow: () => roundtableManager.close(),
    focusWindow: () => roundtableManager.focus(),
    drag: dragSession
  })

  // Multi-AI（AI Workspace）：后台页面管理 + 并行调度。通知走主窗口广播，
  // 与 browser:changed 同一模式——主进程是唯一事实来源。
  const aiChat = new AIChatService(db.db)
  aiChatService = aiChat
  aiChat.setNotifier(() => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) return
    window.webContents.send('ai-chat:status:changed', aiChat.lastTask())
  })

  const bookmarkService = new BookmarkService(db.db)

  // Chrome Companion：本地 IPC 与 Host 安装状态互相独立。IPC 先起来，
  // Host 是否安装由用户在设置页决定；已安装时这里会刷新 token。
  const chromeIntegration = new ChromeService({
    userDataDir: app.getPath('userData'),
    dataDir: initialDataLocation.dataDir,
    appVersion: APP_VERSION,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    // 生产包可以在构建时注入固定扩展 ID；开发态读 ChromeExtension/extension-id.json。
    productionExtensionId: process.env.BREWPHASE_CHROME_EXTENSION_ID,
    // E2E / 便携：不写真实用户目录。
    hostDirOverride: process.env.BREWPHASE_CHROME_HOST_DIR,
    records
  })
  chromeService = chromeIntegration
  void chromeIntegration.start().catch((error) => {
    console.error('[chrome] start failed', error)
  })

  // 数据目录迁移：复制前先停掉所有会写库/写文件的服务；成功后由设置页
  // 触发重启（或自动重启），失败时原数据与配置都不动。
  const dataLocation = new DataLocationService({
    userDataDir: app.getPath('userData'),
    appPath: app.getAppPath(),
    onBeforeMigrate: async () => {
      await chromeIntegration.stop()
      const server = bridgeServer
      bridgeServer = null
      await server?.stop()
      roundtableManager.closeAll()
      browserManager?.dispose()
      browserManager = null
      roundtableService = null
      aiChatService?.dispose()
      aiChatService = null
      db?.close()
      db = null
    },
    relaunch: () => {
      app.relaunch()
      app.exit(0)
    }
  })

  registerIpc({
    db,
    devServerUrl,
    sync: syncService,
    services: { records, clients, workContexts, personalDirection },
    aiChat: aiChatService,
    bridgeStatus,
    browser: browserManager,
    roundtable: roundtableService,
    bookmarks: bookmarkService,
    chrome: chromeIntegration,
    dataDir: initialDataLocation.dataDir,
    dataLocation
  })

  // E2E / 单测钩子：注入假光标（拖拽会话的松手位置判定用）。
  // 打包版没有这个全局对象；真实用户路径永远读系统光标。
  if (!app.isPackaged) {
    ;(globalThis as unknown as Record<string, unknown>).__bpTestHooks = {
      setDragCursor: (point: { x: number; y: number } | null) => browserManager?.setDragCursorOverride(point)
    }
  }

  // 应用菜单必须在开窗前就位：快捷键（复制/粘贴/缩放…）随 role 注册，
  // Windows/Linux 的传统菜单栏由 autoHideMenuBar 收起，入口在 Renderer 顶栏。
  installApplicationMenu()

  const mainWindow = createMainWindow({ devServerUrl })
  mainWindowRef = mainWindow
  mainWindow.on('closed', () => {
    mainWindowRef = null
  })
  // 窗口尺寸变化：原生视图不归 CSS 管，必须显式收回来。
  // 渲染层也会重新上报 bounds，这里是「渲染层还没来得及报」时的兜底。
  mainWindow.on('resize', () => browserManager?.refit())
  mainWindow.on('closed', () => {
    browserManager?.onMainWindowClosed()
    // 采集宿主是 BaseWindow，不参与 BrowserWindow.getAllWindows()；主窗口关掉、
    // 又没有任何独立浏览器窗口时，按原语义退出（macOS 仍留在 Dock）。
    if (process.platform !== 'darwin' && BrowserWindow.getAllWindows().length === 0) app.quit()
  })
  // 上次运行没跑完的 pending 任务（应用被关掉 / 崩溃）：接着抓，不遗忘
  try {
    for (const job of pendingMetadataJobs(db.db)) metadataQueue.enqueue(job)
  } catch (error) {
    console.error('[metadata] pending recovery failed', error)
  }

  app.on('activate', () => {
    // 主窗口不在了就重建——**不能**用 getAllWindows().length 判断：
    // 圆桌独立窗口活着时它不是 0，但主窗口仍然需要回来（规格 §4.8）。
    const main = mainWindowRef
    if (!main || main.isDestroyed()) {
      const window = createMainWindow({ devServerUrl })
      mainWindowRef = window
      window.on('closed', () => {
        mainWindowRef = null
      })
    }
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

app.on('before-quit', (event) => {
  // 浏览器浮窗持有原生 WebContentsView：不主动释放会留下孤儿 webContents，
  // 退出过程中可能报「对象已销毁」。
  browserManager?.dispose()
  browserManager = null
  aiChatService?.dispose()
  aiChatService = null
  // Bridge 与 Chrome 本地 IPC 的关闭都是异步的（关 socket、删 info / pipe 文件）：
  // 先拦住这一次 quit，清理完再真正退出；第二次进入时 `quitting` 已置位，只关库。
  if ((bridgeServer || chromeService) && !quitting) {
    quitting = true
    const server = bridgeServer
    const chrome = chromeService
    bridgeServer = null
    chromeService = null
    event.preventDefault()
    void Promise.all([server?.stop(), chrome?.stop()]).finally(() => app.quit())
    return
  }
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
