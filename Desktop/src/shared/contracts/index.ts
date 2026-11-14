import type { Bean, BeanDraft, Brew, BrewDraft, PhaseRule, Tasting, TastingDraft } from './entities/coffee'
import type { WorkContextStudioItem } from './work-context'
import type {
  AgentApplyOutcome,
  AgentConfigPlan,
  AgentDetection,
  AgentKind
} from './agents'
import type {
  AIChatTaskSnapshot,
  AIConversationDetail,
  AIConversationSummary,
  AIPlatformStatus,
  AIProvider
} from './ai-chat'
import type {
  CurrentState,
  CurrentStateDraft,
  Direction,
  DirectionInput,
  DirectionPatch,
  PersonalDirectionOverview,
  ProposalKind,
  StageGoal,
  StageGoalInput,
  StageGoalPatch
} from './personal-direction'
import type { Canvas, CanvasNode, CanvasNodeWithRecord, CanvasNote, CanvasStroke } from './entities/canvas'
import type { ImportImageResult, RecordDraft, RecordItem, RecordQuery, RecordTag } from './entities/records'
import type { SyncStatus, SyncConflictItem, WipeResult } from './sync'
import type {
  McpBridgeStatus,
  McpClientCreateInput,
  McpClientCreated,
  McpClientInfo,
  McpScope
} from './mcp'
import type {
  BrowserBounds,
  BrowserDragFrame,
  BrowserDragProbe,
  BrowserOpenInput,
  BrowserPreview,
  BrowserPreviewEvent,
  BrowserState
} from './browser'
import type { RoundtableSnapshot } from '../roundtable'
import type {
  BookmarkImportResult,
  BookmarkPreview,
  BookmarkTree,
  ChromeDetection
} from './bookmarks'
import type {
  ChromeCompanionInstallResult,
  ChromeCompanionStatus,
  ChromeSelfTestResult
} from './chrome-bridge'
import type { DataLocationChangeResult, DataLocationStatus } from './data-location'
import { APP_VERSION, DB_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from './version'

export * from './version'
export * from './entities/coffee'
export * from './entities/records'
export * from './entities/canvas'
export * from './sync'
export * from './mcp'
export * from './browser'
export * from './bookmarks'
export * from './chrome-bridge'
export * from './work-context'
export * from './personal-direction'
export * from './agents'
export * from './ai-chat'
export * from './data-location'
export * from './validation/ipc'

/**
 * 应用事件：主进程写入（尤其是 MCP Bridge 的写入）之后广播的领域名。
 * 页面收到后自己重新取数据——不把内容塞进事件，避免出现第二份状态。
 */
export const APP_DOMAINS = ['records', 'coffee', 'canvas', 'workContexts', 'personalDirection'] as const
export type AppDomain = (typeof APP_DOMAINS)[number]

/**
 * Renderer 能看到的全部能力。**只有这些**——preload 里逐条列出，不透传
 * `ipcRenderer`，也不给任何文件系统、SQLite 或 Node 的直接入口。
 */
export type AppInfo = {
  appVersion: string
  dbSchemaVersion: number
  syncProtocolVersion: number
  platform: string
  dataDir: string
  /**
   * 首次启动引导（配对指引）是否该出现：打包版为 true；dev / e2e 跑的是
   * `out/`（未打包）恒为 false，避免测试与开发被 overlay 挡住。
   * `BREWPHASE_FORCE_ONBOARDING=yes` 可强制打开（截图/验收用）。
   */
  onboardingEligible: boolean
}

export interface RendererApi {
  app: {
    info: () => Promise<AppInfo>
    /** 弹出主进程应用菜单（role 提供 Copy/Paste/Zoom 等与快捷键）。 */
    popupMenu: () => Promise<void>
    /** Studio Home「继续工作」区块的只读数据。 */
    studioList: () => Promise<WorkContextStudioItem[]>
    /**
     * 报告解析后的明暗，让窗口底色与 Windows 标题栏按钮跟随页面。
     * 只传 `light` / `dark`：色值定义在主进程，Renderer 不参与配色。
     */
    setAppearance: (appearance: 'light' | 'dark') => Promise<void>
    /** 主进程写入后的刷新通知（MCP/同步等外部来源）。 */
    onChanged: (listener: (domain: AppDomain) => void) => () => void
  }
  /**
   * Personal Direction：现状 / 方向 / 阶段。
   *
   * 这里的 `resolveProposal` 是「确认草稿」的唯一入口——MCP 侧没有对应能力，
   * 所以只有用户在这里点下去，AI 的提议才会变成正式资料。
   */
  direction: {
    overview: () => Promise<PersonalDirectionOverview>
    saveCurrentState: (draft: CurrentStateDraft) => Promise<CurrentState>
    confirmCurrentState: (id: string) => Promise<CurrentState>
    createDirection: (input: DirectionInput) => Promise<Direction>
    updateDirection: (
      id: string,
      expectedUpdatedAt: number,
      patch: DirectionPatch
    ) => Promise<Direction>
    deleteDirection: (id: string) => Promise<void>
    createStage: (input: StageGoalInput) => Promise<StageGoal>
    updateStage: (
      id: string,
      expectedUpdatedAt: number,
      patch: StageGoalPatch
    ) => Promise<StageGoal>
    deleteStage: (id: string) => Promise<void>
    /** 确认或丢弃一条草稿；确认后它才成为正式资料。 */
    resolveProposal: (
      kind: ProposalKind,
      id: string,
      action: 'confirm' | 'discard'
    ) => Promise<unknown>
  }
  coffee: {
    listBeans: () => Promise<Bean[]>
    createBean: (draft: BeanDraft) => Promise<Bean>
    updateBean: (id: string, draft: BeanDraft) => Promise<Bean>
    deleteBean: (id: string) => Promise<void>
    listBrews: (beanId: string | null) => Promise<Brew[]>
    createBrew: (draft: BrewDraft) => Promise<Brew>
    updateBrew: (id: string, draft: BrewDraft) => Promise<Brew>
    deleteBrew: (id: string) => Promise<void>
    listTastings: (beanId: string | null) => Promise<Tasting[]>
    listPhaseRules: () => Promise<PhaseRule[]>
  }
  records: {
    list: (query: RecordQuery) => Promise<RecordItem[]>
    get: (id: string) => Promise<RecordItem | null>
    create: (draft: RecordDraft) => Promise<RecordItem>
    update: (id: string, draft: RecordDraft) => Promise<RecordItem>
    remove: (id: string) => Promise<void>
    listTags: () => Promise<RecordTag[]>
    createTag: (name: string) => Promise<RecordTag>
    importImage: () => Promise<ImportImageResult | null>
    /**
     * 抓取并写入链接元数据（main process 安全网络层）。
     * `force = true` 跳过本地缓存（用户在详情侧栏主动刷新时用）。
     */
    resolveMetadata: (id: string, force?: boolean) => Promise<RecordItem | null>
    /**
     * `bpmedia://media/<fileName>`；只接受主进程校验过的文件名。
     *
     * `version` 只影响 URL（`?v=`），用来在**媒体文件晚于记录落盘**时让浏览器
     * 重新请求：同步先写记录、再分块传文件，若 URL 不变，浏览器会沿用上一次
     * 失败的结果，图片会一直是破图，直到切页或重启。
     */
    mediaUrl: (fileName: string, version?: number) => string
    /**
     * 后台元数据补全有了结果（成功或失败）时通知一次，用于自动刷新列表。
     * 主进程的 ResolveQueue 在每次任务结束后广播。
     */
    onMetadataUpdated: (listener: () => void) => () => void
  }
  sync: {
    status: () => Promise<SyncStatus>
    enable: (enabled: boolean) => Promise<SyncStatus>
    startPairing: () => Promise<SyncStatus>
    revokeDevice: (id: string) => Promise<SyncStatus>
    /**
     * 清空「同步实体」：记录 / 标签 / 画布 / 这些记录引用的媒体文件。
     * **不动豆子、冲煮、品鉴、阶段规则**——它们只属于这台 Mac。
     */
    wipeData: () => Promise<WipeResult>
    conflicts: () => Promise<SyncConflictItem[]>
    resolveConflict: (id: string, resolution: 'local' | 'remote') => Promise<SyncStatus>
    onChanged: (listener: () => void) => () => void
  }
  canvas: {
    list: () => Promise<Canvas[]>
    create: (name: string, note?: string) => Promise<Canvas>
    remove: (id: string) => Promise<void>
    nodes: (canvasId: string) => Promise<CanvasNodeWithRecord[]>
    addNode: (canvasId: string, recordId: string) => Promise<CanvasNode>
    moveNode: (id: string, positionX: number, positionY: number) => Promise<void>
    resizeNode: (id: string, width: number, height: number) => Promise<void>
    annotateNode: (id: string, annotation: string) => Promise<void>
    removeNode: (id: string) => Promise<void>
    rename: (id: string, name: string) => Promise<Canvas>
    notes: (canvasId: string) => Promise<CanvasNote[]>
    createNote: (canvasId: string, positionX: number, positionY: number) => Promise<CanvasNote>
    updateNote: (note: CanvasNote) => Promise<CanvasNote>
    removeNote: (id: string) => Promise<void>
    strokes: (canvasId: string) => Promise<CanvasStroke[]>
    saveStroke: (stroke: CanvasStroke) => Promise<CanvasStroke>
    removeStroke: (id: string) => Promise<void>
  }
  /**
   * AI 连接（MCP）。token 只在 createClient 的返回值里出现一次，
   * listClients 永远不会返回 token 或哈希。
   */
  /**
   * 可拆卸浏览器窗口。归属判定全在主进程；resolveDrop 传屏幕坐标，
   * dragProbe 是拖动中的节流探测（窗口内 / 窗口外）。
   * executeOnTab 只服务于主进程内的 Adapter（DOM 自动化按 tabId 定位）。
   */
  browserTabs: {
    create: () => Promise<BrowserState>
    /** 在卡片架上新建标签：不激活主窗口浮窗（新卡片进入地址输入态）。 */
    createShelfTab: () => Promise<BrowserState>
    activate: (tabId: string) => Promise<BrowserState>
    closeTab: (tabId: string) => Promise<BrowserState>
    /** 在某个标签里导航，不改主窗口当前标签（卡片内联地址栏）。 */
    navigate: (tabId: string, input: string) => Promise<BrowserState>
    reorder: (tabId: string, beforeTabId: string | null) => Promise<BrowserState>
    resolveDrop: (tabId: string, screenX: number, screenY: number) => Promise<BrowserState>
    /** 卡片拖出主窗口：直接拆成独立窗口，不打开浮窗。 */
    detach: (tabId: string, screenX: number, screenY: number) => Promise<BrowserState>
    /** 独立窗口里的标签收回卡片架：接回主窗口并收起浮窗，不重新加载。 */
    recall: (tabId: string) => Promise<BrowserState>
    dragProbe: (screenX: number, screenY: number) => Promise<BrowserDragProbe>
    reattach: (tabId: string) => Promise<BrowserState>
    floatActivate: (windowId: number, tabId: string) => Promise<BrowserState>
    floatBounds: (windowId: number, bounds: BrowserBounds) => Promise<void>
    executeOnTab: (tabId: string, script: string) => Promise<unknown>
  }
  /**
   * 网页缩略图（真实截图，主进程内存缓存）。
   *
   * `list` 用于首次挂载补齐；`request` 只在卡片没有预览时按需触发一次采集，
   * 是否真正截图由主进程的节流与错误处理决定。事件流只推更新与清理。
   */
  browserPreviews: {
    list: () => Promise<BrowserPreview[]>
    get: (tabId: string) => Promise<BrowserPreview | null>
    request: (tabId: string) => Promise<void>
    onChanged: (listener: (event: BrowserPreviewEvent) => void) => () => void
  }
  /**
   * 拖拽会话（Phase 3）：卡片拖出的三个意图 + 主进程光标帧广播。
   *
   * 「窗口外松手」的判定在主进程（`screen.getCursorScreenPoint()` 轮询），
   * 渲染层只报 dragstart / 内部投放 / dragend——真实桌面上渲染层拿不到
   * 窗口外的 pointer 事件，这个分工是拖出可靠性的根基。
   */
  browserDrag: {
    begin: (tabId: string) => Promise<boolean>
    /** 窗口内 drop 被接受（排序 / 加入圆桌）：会话按内部投放收尾，不拆窗。 */
    dropHandled: (tabId: string) => Promise<void>
    end: (tabId: string, point?: { screenX: number; screenY: number }) => Promise<void>
    /** 光标进出窗口边界的帧广播（拆出提示样式用）。 */
    onFrame: (listener: (frame: BrowserDragFrame) => void) => () => void
  }
  /**
   * AI 圆桌（Phase 3）：主进程唯一状态，主窗口与独立窗口订阅同一份快照。
   * 写草稿带 `baseVersion` 做乐观并发控制；detach 可带松手点（按钮拆出缺省）。
   */
  roundtable: {
    state: () => Promise<RoundtableSnapshot>
    join: (tabId: string) => Promise<RoundtableSnapshot>
    leave: (tabId: string) => Promise<RoundtableSnapshot>
    reorder: (tabId: string, overId: string) => Promise<RoundtableSnapshot>
    /** 草稿：后写者胜出，主进程推进版本并广播到两个窗口。 */
    setDraft: (draft: string) => Promise<RoundtableSnapshot>
    detach: (point?: { screenX: number; screenY: number }) => Promise<RoundtableSnapshot>
    dock: () => Promise<RoundtableSnapshot>
    focus: () => Promise<RoundtableSnapshot>
    /** 标题栏拖出 / 拖回的会话意图（与卡片共用同一个「单鼠标」会话）。 */
    dragBegin: () => Promise<boolean>
    /** 拖回主窗口停靠位的 drop 被接受：按内部投放收尾，不重复归位。 */
    dragDropHandled: () => Promise<void>
    dragEnd: (point?: { screenX: number; screenY: number }) => Promise<void>
    onSnapshot: (listener: (snapshot: RoundtableSnapshot) => void) => () => void
  }
  /**
   * AI Workspace（Multi-AI）。自动化全部发生在主进程：这里只传意图
   * （问一句、停一下、看状态），拿回的也只是页面真实显示的结果。
   */
  aiChat: {
    statuses: () => Promise<AIPlatformStatus[]>
    ask: (input: { prompt: string; providers: AIProvider[] }) => Promise<{
      conversationId: string
      snapshot: AIChatTaskSnapshot
    }>
    cancel: () => Promise<void>
    lastTask: () => Promise<AIChatTaskSnapshot | null>
    openLogin: (provider: AIProvider) => Promise<void>
    viewURL: (provider: AIProvider) => Promise<string>
    conversations: (limit?: number) => Promise<AIConversationSummary[]>
    conversation: (id: string) => Promise<AIConversationDetail | null>
    deleteConversation: (id: string) => Promise<boolean>
    /** 广播当前任务快照（无任务时是 null）；主窗口与圆桌独立窗口都会收到。 */
    onChanged: (listener: (snapshot: AIChatTaskSnapshot | null) => void) => () => void
  }
  /** AI Agent 自动配置：检测 → 预览 → 用户确认后写入。 */
  agents: {
    detect: () => Promise<AgentDetection[]>
    plan: (kind: AgentKind) => Promise<AgentConfigPlan>
    apply: (input: {
      kind: AgentKind
      name: string
      scopes: McpScope[]
      replaceExisting: boolean
    }) => Promise<AgentApplyOutcome>
  }
  mcp: {
    listClients: () => Promise<McpClientInfo[]>
    createClient: (input: McpClientCreateInput) => Promise<McpClientCreated>
    revokeClient: (id: string) => Promise<McpClientInfo>
    bridgeStatus: () => Promise<McpBridgeStatus>
  }
  /**
   * 内置浏览器（Phase 1）。
   *
   * 渲染层只操作「壳」：网页本身由主进程的 WebContentsView 绘制，**不在 React
   * DOM 里**。因此这里没有任何「读页面内容」的能力——只有导航、状态与几何。
   * 浮窗的显示状态跨空间常驻，不属于某个页面。
   */
  browser: {
    state: () => Promise<BrowserState>
    /** 打开浮窗：给了 url 就导航，否则恢复上次访问，再没有就停在初始页。 */
    open: (input?: BrowserOpenInput) => Promise<BrowserState>
    /** 隐藏但**不销毁**页面：登录态、滚动位置、播放进度都还在。 */
    hide: () => Promise<BrowserState>
    /** 关闭：销毁 WebContentsView，但保留持久化 Session 与上次访问地址。 */
    close: () => Promise<BrowserState>
    navigate: (input: string) => Promise<BrowserState>
    back: () => Promise<BrowserState>
    forward: () => Promise<BrowserState>
    reload: () => Promise<BrowserState>
    stop: () => Promise<BrowserState>
    /** 内容区在窗口里的矩形（CSS px）。原生 View 靠它对齐 React 外框。 */
    setBounds: (bounds: BrowserBounds) => Promise<void>
    /** 用系统默认浏览器打开当前页（用户主动触发，网页不能自己调）。 */
    openExternal: (url?: string) => Promise<void>
    /**
     * 回到起始页：只把 WebContentsView 藏起来，**不销毁**。
     * 当前网页的加载状态、滚动位置与 Session 都保留，再点书签直接继续。
     */
    showStart: () => Promise<BrowserState>
    /**
     * 从起始页恢复到**当前网页实例**。
     *
     * 与 `open({ url })` 不同：不调用 `loadURL()`，只把原生视图重新显示出来。
     * 页面不会重新导航，滚动位置、SPA 状态与 JS 内存状态都保留。
     * 没有可恢复的页面时原样返回当前状态。
     */
    showCurrentPage: () => Promise<BrowserState>
    /** 检测本机 Chrome 与可用 Profile（主进程解析路径，渲染层只拿名称）。 */
    detectChrome: () => Promise<ChromeDetection>
    /** 预览某个 Profile 的书签数量；不写库。 */
    previewChromeBookmarks: (profileId: string) => Promise<BookmarkPreview>
    /** 用户确认后导入：非破坏性合并进本地书签库。 */
    importChromeBookmarks: (profileId: string) => Promise<BookmarkImportResult>
    /** BrewPhase 当前的书签树（本地，不参与设备同步）。 */
    bookmarks: () => Promise<BookmarkTree>
    /** 导航、加载、标题、能力位变化时广播整份快照。 */
    onChanged: (listener: (state: BrowserState) => void) => () => void
  }
  /**
   * Chrome Companion：Desktop 侧只提供「状态 / 安装 / 卸载」三个管理动作。
   * 网页内容从 Native Messaging 进来，不经过 Renderer——这里没有任何
   * 「代写记录」的通道，扩展也不能借它绕过应用服务。
   */
  chrome: {
    status: () => Promise<ChromeCompanionStatus>
    /** 幂等：复制 Host、写 host-config、注册 Chrome Native Messaging manifest。 */
    install: () => Promise<ChromeCompanionInstallResult>
    uninstall: () => Promise<ChromeCompanionInstallResult>
    /** 本地 IPC 自检（hello + PING）；不代表 Chrome 已加载扩展。 */
    selfTest: () => Promise<ChromeSelfTestResult>
  }
  /**
   * 数据目录：`brewphase.db` 与 `media/` 的位置。切换后需要重启；
   * 迁移只复制、不删除原目录，失败不改配置。
   */
  dataLocation: {
    status: () => Promise<DataLocationStatus>
    choose: () => Promise<DataLocationChangeResult>
    reset: () => Promise<DataLocationChangeResult>
    relaunch: () => Promise<void>
  }
}

export const CONTRACT_VERSIONS = {
  app: APP_VERSION,
  db: DB_SCHEMA_VERSION,
  sync: SYNC_PROTOCOL_VERSION
} as const
