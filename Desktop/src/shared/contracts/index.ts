import type { Bean, BeanDraft, Brew, BrewDraft, PhaseRule, Tasting, TastingDraft } from './entities/coffee'
import type { Canvas, CanvasNode, CanvasNodeWithRecord } from './entities/canvas'
import type { ImportImageResult, RecordDraft, RecordItem, RecordQuery, RecordTag } from './entities/records'
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
    /** `bpmedia://media/<fileName>`；只接受主进程校验过的文件名。 */
    mediaUrl: (fileName: string) => string
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
