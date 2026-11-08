import type { Bean, BeanDraft, Brew, BrewDraft, PhaseRule, Tasting, TastingDraft } from './entities/coffee'
import type { Canvas, CanvasNode, CanvasNodeWithRecord } from './entities/canvas'
import type { ImportImageResult, RecordDraft, RecordItem, RecordQuery, RecordTag } from './entities/records'
import type { SyncStatus, SyncConflictItem } from './sync'
import { APP_VERSION, DB_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from './version'

export * from './version'
export * from './entities/coffee'
export * from './entities/records'
export * from './entities/canvas'
export * from './sync'
export * from './validation/ipc'

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
}

export interface RendererApi {
  app: {
    info: () => Promise<AppInfo>
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
    createTasting: (draft: TastingDraft) => Promise<Tasting>
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
    deleteTag: (id: string) => Promise<void>
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
    removeNode: (id: string) => Promise<void>
  }
}

export const CONTRACT_VERSIONS = {
  app: APP_VERSION,
  db: DB_SCHEMA_VERSION,
  sync: SYNC_PROTOCOL_VERSION
} as const
