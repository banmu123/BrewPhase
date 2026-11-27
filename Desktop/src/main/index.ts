import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, powerMonitor, protocol, safeStorage, screen, session, shell } from 'electron'
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
import { LocalWorkspaceService } from './application/local-workspace/local-workspace-service'
import { WorkspaceEvidenceService } from './application/agent-journey/workspace-evidence-service'
import { WorkspaceFileService } from './application/local-workspace/workspace-file-service'
import { ContextBuilder } from './application/local-workspace/context-builder'
import { ReplyIntelligenceService } from './application/reply-intelligence/reply-intelligence-service'
import { PersonalDirectionService } from './application/personal-direction/personal-direction-service'
import { AgentJourneyService } from './application/agent-journey/agent-journey-service'
import { CoffeeService } from './application/coffee/coffee-service'
import { CanvasService } from './application/canvas/canvas-service'
import { McpClientService } from './application/authorization/permission-service'
import { BrowserManager } from './browser/browser-manager'
import { BrowserDragSessionManager } from './browser/browser-drag'
import { RoundtableService } from './roundtable/roundtable-service'
import { RoundtableWindowManager } from './roundtable/roundtable-window-manager'
import {
  ROUNDTABLE_CHANGED_CHANNEL,
  ROUNDTABLE_ID,
  ROUNDTABLE_LAYOUT_CHANGED_CHANNEL,
  type RoundtableLayoutSnapshot,
  type RoundtableSnapshot
} from '../shared/roundtable'
import { ROUNDTABLE_AI_TASK_CHANGED_CHANNEL } from '../shared/contracts/roundtable-ai'
import { AIChatService } from './ai-chat/ai-chat-service'
import { ParticipantService } from './ai-chat/participant-service'
import { RoundtableLayoutManager } from './roundtable/roundtable-layout-manager'
import { RoundtableViewManager } from './roundtable/roundtable-view-manager'
import { BookmarkService } from './browser/bookmark-service'
import { ChromeService } from './integrations/chrome/chrome-service'
import { resolveDataLocation, setActiveDataDir } from './data-location'
import { DataLocationService } from './data-location-service'
import { BridgeServer } from './mcp-bridge/bridge-server'
import { createRemoteService, type RemoteService } from './remote/remote-service'
import { createHttpDeviceRegistrar } from './remote/registration'
import { REMOTE_CHANNELS } from '../shared/contracts/remote'
import { BRIDGE_PROTOCOL_VERSION, bridgePaths, platformSupportsBridge } from './mcp-bridge/bridge-contract'
import type { McpBridgeStatus } from '../shared/contracts/mcp'
import { UPDATE_CHANGED_CHANNEL } from '../shared/contracts/update'
import { DB_SCHEMA_VERSION } from '../shared/contracts/version'
import { EMBED_FRAME_ORIGINS } from '../shared/link-embed'
import { UpdateService } from './update/update-service'
import { AccountService } from './account/account-service'
import { CloudClient, resolveCloudBaseUrl } from './account/cloud-client'
import { CredentialStore } from './account/credentials'
import { startOAuthCallbackServer } from './account/oauth-callback-server'
import { ACCOUNT_CHANGED_CHANNEL } from '../shared/contracts/account'

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
// 圆桌工作空间管理器（在 bootstrap 里创建；before-quit / 测试钩子要用，
// 所以放在模块作用域）。
let roundtableLayoutManagerRef: RoundtableLayoutManager | null = null
let roundtableViewManagerRef: RoundtableViewManager | null = null
/** 主窗口的显式引用：getAllWindows 的顺序不可靠（浮窗加入后尤其如此）。 */
let mainWindowRef: BrowserWindow | null = null
let aiChatService: AIChatService | null = null
/** Cloud Account：退出时要关掉可能还开着的本机回调端口。 */
let accountService: AccountService | null = null
/** Remote MCP：退出前要停连接、关定时器（不阻塞 quit）。 */
let remoteService: RemoteService | null = null
/**
 * R6-4.3.3.1：工作区证据服务——退出前有界 flush、关库前封写入、
 * 数据目录迁移前同样封写（与 db 的生命周期绑在一起）。
 */
let workspaceEvidenceRef: WorkspaceEvidenceService | null = null
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
  // AI Card Workspace Bridge（Phase 1）：登记 / 绑定 / 只读文件 / 上下文。
  // 必须建在 AgentJourneyService 之前——R6-4.3.1 把它的 `authorize` 注入
  // Journey（窄接口：只校验、只回显示名，不带绝对路径，也不产生循环依赖）。
  const localWorkspaceService = new LocalWorkspaceService(db.db, events)
  // R6-4.3.3（P3）：工作区证据服务——只依赖 db / 同一个 events / 工作区授权，
  // 必须在 AgentJourneyService 之前构造（作为 T1–T5 的触发出口注入）。
  const workspaceEvidenceService = new WorkspaceEvidenceService(
    db.db,
    events,
    localWorkspaceService
  )
  workspaceEvidenceRef = workspaceEvidenceService
  // R6-4.3.3.1（启动恢复）：上个会话（崩溃 / 超时退出）遗留的 pending 快照
  // 统一标 failed + capture_interrupted——没完成的采集绝不伪装成完整成功，
  // 也绝不静默丢失「曾经尝试过」这条事实。必须在任何 T1–T5 触发之前跑。
  workspaceEvidenceService.recoverInterruptedCaptures()
  // Agent Journey（R6-2）：复用**同一个** ApplicationEvents——第二份实例会让
  // Renderer 只收到一半的 `app:changed`。
  const agentJourneys = new AgentJourneyService(
    db.db,
    events,
    localWorkspaceService,
    workspaceEvidenceService
  )
  const workspaceFileService = new WorkspaceFileService(db.db)
  const contextBuilder = new ContextBuilder(db.db, workspaceFileService)
  // AI Reply Intelligence（Phase 2）：来源识别用 tab 的真实 URL；tab 已关闭
  // 时允许导入（来源为空），但 UI 层只在卡片活着时提供入口。
  const replyIntelligenceService = new ReplyIntelligenceService(
    db.db,
    events,
    localWorkspaceService,
    (tabId) => {
      const info = browserManager?.resolveTabForAI(tabId)
      return info ? { url: info.url, title: info.title } : null
    }
  )

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
      { db: db.db, clients, records, coffee, canvas, workContexts, personalDirection, agentJourneys },
      app.getVersion()
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
    // 标签被销毁：圆桌立刻摘除失效参与者（两个窗口同步），并清理布局行
    // 与原生视图托管账本；卡片工作区绑定一并清理（规格 §5.8）。
    onTabClosed: (tabId) => {
      roundtableLayoutManagerRef?.handleTabClosed(tabId)
      roundtableViewManagerRef?.handleTabClosed(tabId)
      roundtableService?.syncTabs(browserManager?.liveTabIds() ?? [])
      localWorkspaceService.clearBinding(tabId)
    },
    // 页面加载完成：回填圆桌面板 URL（join 时导航可能尚未完成）。
    onPageSettled: (tabId) => {
      const url = browserManager?.resolveTabForAI(tabId)?.url
      if (url) roundtableLayoutManagerRef?.updateUrl(tabId, url)
    },
    // 用户尝试激活圆桌托管的标签：聚焦工作空间 / 独立窗口，绝不抢 view。
    onRoundtableTabFocus: (tabId) => {
      const snapshot = roundtableService?.snapshot()
      if (snapshot?.detached) roundtableManager.focus()
      else if (snapshot && !snapshot.workspaceOpen) roundtableService?.enterWorkspace()
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
    // 工作空间可见性 / 宿主变化的收口：overlay 开关、拆出、归位都在这里
    // 收敛（原生视图只在可见时托管；不可见时 hideAll，成员身份与布局不动）。
    // visible 期间每次广播都 retarget + 对账——宿主可能刚变化（拆出时
    // 窗口是 commit 之后才创建的，resolveHostWindow 那时还解析不到）。
    const viewManager = roundtableViewManagerRef
    if (!viewManager) return
    const visible = snapshot.detached || snapshot.workspaceOpen
    const wasVisible = viewManager.isWorkspaceVisible()
    if (visible !== wasVisible) {
      viewManager.setWorkspaceVisible(visible)
    }
    if (visible) {
      viewManager.retargetHost()
      viewManager.syncMembers(snapshot.participantTabIds)
    }
  }
  // 圆桌真实 WebCard 问答（Phase 4.2）：tabId 是身份，页面就是用户拖进来
  // 的那张。resolveTabForAI 只读解析真实 WebContents；成员被移出圆桌时，
  // 对应参与者的任务立即终止（cancelParticipant）。
  // 声明顺序解耦：RoundtableService 的回调与 ParticipantService 的
  // isParticipant 都通过闭包晚绑定到对方。
  let participantServiceRef: ParticipantService | null = null
  roundtableService = new RoundtableService({
    isTabAlive: (tabId) => browserManager?.hasTab(tabId) ?? false,
    broadcast: broadcastRoundtable,
    createWindow: (near) => roundtableManager.create(near),
    closeWindow: () => roundtableManager.close(),
    focusWindow: () => roundtableManager.focus(),
    drag: dragSession,
    onParticipantsChanged: ({ removed }) => {
      const snapshot = roundtableService?.snapshot()
      if (!snapshot) return
      const memberIds = snapshot.participantTabIds
      // 布局数据永远跟随成员（新成员给默认位、离场清行）；原生视图只在
      // 工作空间可见时托管——不打开工作空间的加入不动原 view。
      roundtableLayoutManagerRef?.syncMembers(memberIds)
      if (snapshot.detached || snapshot.workspaceOpen) {
        roundtableViewManagerRef?.syncMembers(memberIds)
      }
      for (const tabId of removed) participantServiceRef?.cancelParticipant(tabId)
    }
  })

  // 圆桌自由布局工作空间（Phase 4.2）：布局（纯数据）与原生视图（托管）
  // 分成两个管理器——LayoutManager 只碰数字与 SQLite，ViewManager 只碰
  // WebContentsView 的父容器 / bounds / 可见性 / z-order；页面生命周期
  // 权威仍是 BrowserManager。
  const broadcastRoundtableLayout = (snapshot: RoundtableLayoutSnapshot): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send(ROUNDTABLE_LAYOUT_CHANGED_CHANNEL, snapshot)
    }
  }
  const roundtableLayoutManager = new RoundtableLayoutManager({
    db: db.db,
    broadcast: broadcastRoundtableLayout,
    getTabUrl: (tabId) => browserManager?.resolveTabForAI(tabId)?.url ?? null
  })
  roundtableLayoutManagerRef = roundtableLayoutManager

  const resolveRoundtableHostWindow = (): BrowserWindow | null => {
    const snapshot = roundtableService?.snapshot()
    if (snapshot?.detached) {
      const id = roundtableManager.windowId()
      return id !== null ? BrowserWindow.fromId(id) : null
    }
    return mainWindowRef
  }
  const roundtableViewManager = new RoundtableViewManager({
    getView: (tabId) => browserManager?.resolveTabView(tabId) ?? null,
    resolveHostWindow: resolveRoundtableHostWindow,
    layout: () => {
      const snapshot = roundtableLayoutManagerRef?.snapshot()
      return { panels: snapshot?.panels ?? [], snapEnabled: snapshot?.snapEnabled ?? true }
    },
    hostTab: (tabId, hostWindowId) => browserManager?.hostTabInRoundtable(tabId, hostWindowId) ?? false,
    releaseTab: (tabId) => browserManager?.releaseTabFromRoundtable(tabId)
  })
  roundtableViewManagerRef = roundtableViewManager

  const participantService = new ParticipantService({
    db: db.db,
    resolver: { resolve: (tabId) => browserManager?.resolveTabForAI(tabId) ?? null },
    isParticipant: (tabId) => roundtableService?.hasParticipant(tabId) ?? false,
    broadcast: (snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue
        window.webContents.send(ROUNDTABLE_AI_TASK_CHANGED_CHANNEL, snapshot)
      }
    }
  })
  participantServiceRef = participantService

  // Multi-AI（AI Workspace / 圆桌 Phase 4.1）：后台页面管理 + 并行调度。
  // 通知必须**广播给所有窗口**——圆桌独立窗口（#bpRoundtable）也是合法的
  // 提交入口，getAllWindows()[0] 的顺序不可靠（浮窗、圆桌窗口加入后漂移），
  // 只发第一个窗口会让另一个窗口的任务状态永远停在旧值。
  // 与 browser:changed / roundtable:changed 同一模式：主进程是唯一事实来源。
  const aiChat = new AIChatService(db.db)
  aiChatService = aiChat
  aiChat.setNotifier(() => {
    const payload = aiChat.lastTask()
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send('ai-chat:status:changed', payload)
    }
  })

  const bookmarkService = new BookmarkService(db.db)

  // Chrome Companion：本地 IPC 与 Host 安装状态互相独立。IPC 先起来，
  // Host 是否安装由用户在设置页决定；已安装时这里会刷新 token。
  const chromeIntegration = new ChromeService({
    userDataDir: app.getPath('userData'),
    dataDir: initialDataLocation.dataDir,
    appVersion: app.getVersion(),
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
      // R6-4.3.3.1：迁移前同样封证据写入——db 关闭后不允许残留任务再落
      // 有效数据；未完成的 pending 由重启后的启动恢复标 capture_interrupted。
      workspaceEvidenceRef?.beginShutdown()
      workspaceEvidenceRef = null
      db?.close()
      db = null
    },
    relaunch: () => {
      app.relaunch()
      app.exit(0)
    }
  })

  // 版本感知：主进程唯一状态，结果广播给所有 Renderer 窗口（含独立窗口）。
  const updateService = new UpdateService({
    // 事实来源 = package.json 的 version（打包后即 Info.plist 的版本）。
    currentVersion: app.getVersion(),
    broadcast: (result) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(UPDATE_CHANGED_CHANNEL, result)
      }
    }
  })

  // Cloud Account（Phase 1.2）：登录 / 恢复 / 退出。
  //
  // - 凭据单独一个文件，放在 **userData** 而不是业务数据目录：它跟记录、媒体
  //   无关，换数据目录时不该被复制过去，退出登录也只删这一个文件；
  // - safeStorage 只在 app ready 之后可用，所以构造放在 bootstrap 里；
  // - restore() 只读本地密文，网络校验在后台跑：Cloud 挂了也不影响启动；
  // - 广播给所有窗口，与 browser/roundtable/update 同一模式（主进程是唯一事实来源）。
  const cloudBaseUrl = resolveCloudBaseUrl()
  const account = new AccountService({
    cloud: new CloudClient({
      baseUrl: cloudBaseUrl,
      fetchImpl: (url, init) => net.fetch(url, init)
    }),
    store: new CredentialStore({
      filePath: join(app.getPath('userData'), 'account', 'credentials.json'),
      secretBox: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (payload) => safeStorage.decryptString(payload)
      },
      log: (message) => console.warn(message)
    }),
    // 只打开主进程用 CloudClient 拼出来的地址（protocol 由 resolveCloudBaseUrl 限制）。
    openExternal: async (url) => {
      await shell.openExternal(url)
    },
    startCallback: (params) => startOAuthCallbackServer(params),
    // Remote 必须在账户凭据被清除**之前**收尾。这里读的是模块作用域变量：
    // RemoteService 在 `account.restore()` 之后才创建，闭包按调用时取值，
    // 所以不必打乱启动顺序，也不必让账户层认识 Remote。
    beforeSignOut: async () => {
      await remoteService?.prepareForSignOut()
    },
    broadcast: (snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue
        window.webContents.send(ACCOUNT_CHANGED_CHANNEL, snapshot)
      }
      // 账户变了就要重新判定远程可用性：否则连线会带着旧绑定继续存在。
      // 不 await：广播是同步路径，远程的收尾走自己的异步流程。
      void remoteService?.reconcile()
    }
  })
  accountService = account
  account.restore()

  // Remote MCP（Phase 1.1B）：**在主进程内**，与数据库同属一个进程。
  //
  // 顺序是契约的一部分：账户状态已经恢复（上一行），RemoteService 才能判断
  // 「本机绑定的用户 == 当前登录用户」。启动检查在 `start()` 内部完成，
  // 不依赖 Renderer，也不依赖用户打开设置页——默认关闭时零出站连接。
  remoteService = createRemoteService({
    db: db.db,
    services: { records, coffee, canvas, workContexts, personalDirection, agentJourneys },
    currentUserId: () => account.snapshot().user?.id ?? null,
    /**
     * 确认页要回答「这台设备会绑到哪个账号」——用账号的展示名（通常就是邮箱
     * 或 GitHub 昵称）。它只用于显示，**不参与任何身份判定**。
     */
    currentUserLabel: () => account.snapshot().user?.displayName ?? null,
    clientVersion: app.getVersion(),
    /**
     * 设备注册客户端（Phase 1.2A 接入真实 Cloud）。
     *
     * 用**工厂**形式是为了让 origin 只有一个来源：RemoteService 从
     * `deps.cloudOrigin ?? state.json` 解析出实际要连的 Cloud，再把同一个
     * origin 交给这里。若让本文件各传一份，迟早出现「注册到 A、连接 B」。
     *
     * `accessToken` 每次请求前向 AccountService 要一个**当前有效**的 token：
     * - 过期由 AccountService 自己刷（它已经有这套逻辑），本层不缓存；
     * - refresh token 从不流经 Remote；
     * - 未登录时 `accessToken()` 抛错 → registrar 归成 `unauthorized`
     *   （不可重试），轮询立刻停，而不是拿着旧身份继续敲。
     *
     * 依赖方向保持单向：AccountService → DeviceRegistrar → RemoteService。
     * 账户层完全不知道 Remote MCP 的存在。
     */
    registrar: (origin) =>
      createHttpDeviceRegistrar({
        origin,
        accessToken: () => account.accessToken()
      }),
    onChanged: (status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue
        window.webContents.send(REMOTE_CHANNELS.changed, status)
      }
    },
    log: (line) => console.warn(line)
  })
  // 不 await：Cloud 不可达不应拖慢启动；start() 内部的失败只影响远程状态。
  void remoteService.start()

  // 睡眠/唤醒：不信任旧 socket，唤醒后重新握手（回调用的是模块作用域变量）。
  powerMonitor.on('suspend', () => remoteService?.suspend())
  powerMonitor.on('resume', () => void remoteService?.resume())

  registerIpc({
    db,
    devServerUrl,
    sync: syncService,
    account,
    remote: remoteService,
    // R6-4.1：canvas 与 agentJourneys 必须是**同一个实例**——它们同时被
    // MCP Bridge（下方 BridgeServer）与 Remote 拿走，共享同一个 ApplicationEvents。
    services: { records, clients, workContexts, personalDirection, canvas, agentJourneys },
    aiChat: aiChatService,
    roundtableAI: participantService,
    roundtableLayout: roundtableLayoutManager,
    roundtableViews: roundtableViewManager,
    bridgeStatus,
    browser: browserManager,
    roundtable: roundtableService,
    bookmarks: bookmarkService,
    chrome: chromeIntegration,
    dataDir: initialDataLocation.dataDir,
    dataLocation,
    updates: updateService,
    localWorkspaces: localWorkspaceService,
    evidence: workspaceEvidenceService,
    workspaceFiles: workspaceFileService,
    contextBuilder: contextBuilder,
    replyIntelligence: replyIntelligenceService
  })

  // E2E / 单测钩子：注入假光标（拖拽会话的松手位置判定用）。
  // 打包版没有这个全局对象；真实用户路径永远读系统光标。
  if (!app.isPackaged) {
    ;(globalThis as unknown as Record<string, unknown>).__bpTestHooks = {
      setDragCursor: (point: { x: number; y: number } | null) => browserManager?.setDragCursorOverride(point),
      // E2E 的 expectRoundtableViewsAlive：原生视图存活 / bounds / 宿主 /
      // z-order 的唯一可靠观测入口（page.screenshot 拍不到 WebContentsView）。
      roundtableViews: () => roundtableViewManagerRef?.infos() ?? [],
      roundtableLayout: () => roundtableLayoutManagerRef?.snapshot() ?? null
    }
  }

  // 应用菜单必须在开窗前就位：快捷键（复制/粘贴/缩放…）随 role 注册，
  // Windows/Linux 的传统菜单栏由 autoHideMenuBar 收起，入口在 Renderer 顶栏。
  installApplicationMenu()

  const mainWindow = createMainWindow({ devServerUrl })
  mainWindowRef = mainWindow
  // 版本探针只在打包版跑：dev / e2e 不联网；定时器 unref，不阻止退出。
  if (app.isPackaged) updateService.startAutoCheck()
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
  // 登录进行中退出：先关本机回调端口，不留悬挂监听。
  accountService?.dispose()
  accountService = null
  // 浏览器浮窗持有原生 WebContentsView：不主动释放会留下孤儿 webContents，
  // 退出过程中可能报「对象已销毁」。
  browserManager?.dispose()
  browserManager = null
  aiChatService?.dispose()
  aiChatService = null
  // 圆桌布局：退出前把防抖中的最后一次状态落库。
  try {
    roundtableLayoutManagerRef?.flushPersist()
  } catch (error) {
    console.error('[roundtable-layout] flush on quit failed', error)
  }
  roundtableLayoutManagerRef?.dispose()
  // Bridge / Chrome / Remote 的关闭、以及证据队列的收尾都是异步的（关 socket、
  // 删 info / pipe 文件、等审计落库、等 fire-and-forget 采集排空）：
  // 先拦住这一次 quit，清理完再真正退出；第二次进入时 `quitting` 已置位，
  // 只封写 + 关库。
  //
  // **RemoteService 必须在 db.close() 之前停**：它的审计写要用连接，
  // 连接没了再写只会得到一串「audit write failed」。
  //
  // R6-4.3.3.1：证据 flush 与既有 stop() **共用同一次有界等待**（总超时兜底），
  // 不额外拖长退出、也不无限阻塞；超时后遗留的 pending 行不写半截——
  // 关库前 beginShutdown() 已封住写入，由下次启动统一标 capture_interrupted。
  if ((bridgeServer || chromeService || remoteService || workspaceEvidenceRef) && !quitting) {
    quitting = true
    const server = bridgeServer
    const chrome = chromeService
    const remote = remoteService
    const evidence = workspaceEvidenceRef
    bridgeServer = null
    chromeService = null
    remoteService = null
    event.preventDefault()
    // 总超时兜底：任何一个 stop() / flush 卡住都不能让应用永远退不出去。
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000))
    const stopped = Promise.allSettled([
      server?.stop(),
      chrome?.stop(),
      remote?.stop()
    ]).then(() => undefined)
    // R6-4.3.3.1：等证据队列排空（触发路径 fire-and-forget，退出给它收尾窗口）。
    const flushed: Promise<void> = evidence
      ? evidence.flushPending().catch(() => undefined)
      : Promise.resolve()
    void Promise.race([Promise.all([stopped, flushed]).then(() => undefined), timeout]).finally(
      () => app.quit()
    )
    return
  }
  // 关库前先封写：队列里没跑完的任务不再产生任何有效写入（行保持 pending，
  // 下次启动标 capture_interrupted）——绝不允许异步任务在 DB 关闭后继续写。
  workspaceEvidenceRef?.beginShutdown()
  workspaceEvidenceRef = null
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
