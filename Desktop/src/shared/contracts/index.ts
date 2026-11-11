import type { Bean, BeanDraft, Brew, BrewDraft, PhaseRule, Tasting, TastingDraft } from './entities/coffee'
import type { Canvas, CanvasNode, CanvasNodeWithRecord, CanvasNote, CanvasStroke } from './entities/canvas'
import type { ImportImageResult, RecordDraft, RecordItem, RecordQuery, RecordTag } from './entities/records'
import type { SyncStatus, SyncConflictItem, WipeResult } from './sync'
import type { McpBridgeStatus, McpClientCreateInput, McpClientCreated, McpClientInfo } from './mcp'
import type { BrowserBounds, BrowserOpenInput, BrowserState } from './browser'
import { APP_VERSION, DB_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from './version'

export * from './version'
export * from './entities/coffee'
export * from './entities/records'
export * from './entities/canvas'
export * from './sync'
export * from './mcp'
export * from './browser'
export * from './validation/ipc'

/**
 * 应用事件：主进程写入（尤其是 MCP Bridge 的写入）之后广播的领域名。
 * 页面收到后自己重新取数据——不把内容塞进事件，避免出现第二份状态。
 */
export const APP_DOMAINS = ['records', 'coffee', 'canvas'] as const
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
    /** 主进程写入后的刷新通知（MCP/同步等外部来源）。 */
    onChanged: (listener: (domain: AppDomain) => void) => () => void
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
    /** 导航、加载、标题、能力位变化时广播整份快照。 */
    onChanged: (listener: (state: BrowserState) => void) => () => void
  }
}

export const CONTRACT_VERSIONS = {
  app: APP_VERSION,
  db: DB_SCHEMA_VERSION,
  sync: SYNC_PROTOCOL_VERSION
} as const
