import { z } from 'zod'
import { beanDraftSchema, brewDraftSchema } from '../entities/coffee'
import { recordDraftSchema, recordQuerySchema } from '../entities/records'
import { canvasNodeMoveSchema, canvasNodeResizeSchema, canvasNoteSchema, canvasStrokeSchema } from '../entities/canvas'
import { mcpClientCreateInputSchema } from '../mcp'
import { browserBoundsUpdateSchema, browserNavigateSchema, browserOpenSchema } from '../browser'
import { chromeProfileRequestSchema } from '../bookmarks'

/**
 * IPC 的**唯一**契约清单：通道名 + 请求体校验 + 响应形状。
 *
 * 主进程对每个调用都先 `schema.parse`，再进 repository；任何一条请求不合法都
 * 在边界上被拒掉，不会带着脏参数闯进 SQL。Renderer 拿到的类型也来自这里，
 * 两端只有一份真相。
 */

export const IPC = {
  appInfo: 'app:info',

  beansList: 'coffee:beans:list',
  beanCreate: 'coffee:bean:create',
  beanUpdate: 'coffee:bean:update',
  beanDelete: 'coffee:bean:delete',

  brewsList: 'coffee:brews:list',
  brewCreate: 'coffee:brew:create',
  brewUpdate: 'coffee:brew:update',
  brewDelete: 'coffee:brew:delete',

  tastingsList: 'coffee:tastings:list',

  phaseRulesList: 'coffee:phase-rules:list',

  recordsList: 'records:list',
  recordGet: 'records:get',
  recordCreate: 'records:create',
  recordUpdate: 'records:update',
  recordDelete: 'records:delete',
  recordImportImage: 'records:import-image',
  recordResolveMetadata: 'records:resolve-metadata',

  syncStatus: 'sync:status',
  syncEnable: 'sync:enable',
  syncStartPairing: 'sync:start-pairing',
  syncRevokeDevice: 'sync:revoke-device',
  syncWipeData: 'sync:wipe-data',
  syncConflicts: 'sync:conflicts',
  syncResolveConflict: 'sync:resolve-conflict',
  tagsList: 'records:tags:list',
  tagCreate: 'records:tag:create',

  mcpClientsList: 'mcp:clients:list',
  mcpClientCreate: 'mcp:client:create',
  mcpClientRevoke: 'mcp:client:revoke',
  mcpBridgeStatus: 'mcp:bridge:status',

  canvasesList: 'canvas:list',
  canvasCreate: 'canvas:create',
  canvasDelete: 'canvas:delete',
  canvasNodes: 'canvas:nodes',
  canvasNodeAdd: 'canvas:node:add',
  canvasNodeMove: 'canvas:node:move',
  canvasNodeResize: 'canvas:node:resize',
  canvasNodeAnnotate: 'canvas:node:annotate',
  canvasNodeRemove: 'canvas:node:remove',
  canvasRename: 'canvas:rename',
  canvasNotes: 'canvas:notes',
  canvasNoteCreate: 'canvas:note:create',
  canvasNoteUpdate: 'canvas:note:update',
  canvasNoteRemove: 'canvas:note:remove',
  canvasStrokes: 'canvas:strokes',
  canvasStrokeSave: 'canvas:stroke:save',
  canvasStrokeRemove: 'canvas:stroke:remove',

  // 内置浏览器（Phase 2）：Chrome 书签导入。入参只有 Profile 目录名，
  // 从不接受文件路径——路径解析全部留在主进程。
  browserChromeDetect: 'browser:chrome:detect',
  browserBookmarksPreview: 'browser:bookmarks:preview',
  browserBookmarksImport: 'browser:bookmarks:import',
  browserBookmarksTree: 'browser:bookmarks:tree',
  browserShowStart: 'browser:show-start',

  // 内置浏览器（Phase 1）：只有「壳」的操作，网页渲染在主进程的 WebContentsView。
  browserState: 'browser:state',
  browserOpen: 'browser:open',
  browserHide: 'browser:hide',
  browserClose: 'browser:close',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserStop: 'browser:stop',
  browserSetBounds: 'browser:set-bounds',
  browserOpenExternal: 'browser:open-external'
} as const

export const ipcRequestSchemas = {
  [IPC.appInfo]: z.void(),
  [IPC.beansList]: z.void(),
  [IPC.beanCreate]: beanDraftSchema,
  [IPC.beanUpdate]: z.object({ id: z.string().uuid(), draft: beanDraftSchema }),
  [IPC.beanDelete]: z.object({ id: z.string().uuid() }),

  [IPC.brewsList]: z.object({ beanId: z.string().uuid().nullable().default(null) }),
  [IPC.brewCreate]: brewDraftSchema,
  [IPC.brewUpdate]: z.object({ id: z.string().uuid(), draft: brewDraftSchema }),
  [IPC.brewDelete]: z.object({ id: z.string().uuid() }),

  [IPC.tastingsList]: z.object({ beanId: z.string().uuid().nullable().default(null) }),

  [IPC.phaseRulesList]: z.void(),

  [IPC.recordsList]: recordQuerySchema,
  [IPC.recordGet]: z.object({ id: z.string().uuid() }),
  [IPC.recordCreate]: recordDraftSchema,
  [IPC.recordUpdate]: z.object({ id: z.string().uuid(), draft: recordDraftSchema }),
  [IPC.recordDelete]: z.object({ id: z.string().uuid() }),
  [IPC.recordImportImage]: z.void(),
  [IPC.recordResolveMetadata]: z.object({ id: z.string().uuid(), force: z.boolean().default(false) }),

  // 设备同步（Phase 2）
  [IPC.syncStatus]: z.void(),
  [IPC.syncEnable]: z.boolean(),
  [IPC.syncStartPairing]: z.void(),
  [IPC.syncRevokeDevice]: z.object({ id: z.string().min(1) }),
  [IPC.syncWipeData]: z.void(),
  [IPC.syncConflicts]: z.void(),
  [IPC.syncResolveConflict]: z.object({ id: z.string().min(1), resolution: z.enum(['local', 'remote']) }),
  [IPC.tagsList]: z.void(),
  [IPC.tagCreate]: z.object({ name: z.string().min(1).max(40) }),

  [IPC.mcpClientsList]: z.void(),
  [IPC.mcpClientCreate]: mcpClientCreateInputSchema,
  [IPC.mcpClientRevoke]: z.object({ id: z.string().min(1) }),
  [IPC.mcpBridgeStatus]: z.void(),

  [IPC.canvasesList]: z.void(),
  [IPC.canvasCreate]: z.object({ name: z.string().min(1).max(120), note: z.string().max(2_000).default('') }),
  [IPC.canvasDelete]: z.object({ id: z.string().uuid() }),
  [IPC.canvasNodes]: z.object({ canvasId: z.string().uuid() }),
  [IPC.canvasNodeAdd]: z.object({ canvasId: z.string().uuid(), recordId: z.string().uuid() }),
  [IPC.canvasNodeMove]: canvasNodeMoveSchema,
  [IPC.canvasNodeResize]: canvasNodeResizeSchema,
  [IPC.canvasNodeAnnotate]: z.object({ id: z.string().uuid(), annotation: z.string().max(2_000) }),
  [IPC.canvasNodeRemove]: z.object({ id: z.string().uuid() }),
  [IPC.canvasRename]: z.object({ id: z.string().uuid(), name: z.string().min(1).max(120) }),
  [IPC.canvasNotes]: z.object({ canvasId: z.string().uuid() }),
  [IPC.canvasNoteCreate]: z.object({ canvasId: z.string().uuid(), positionX: z.number().finite(), positionY: z.number().finite() }),
  [IPC.canvasNoteUpdate]: canvasNoteSchema,
  [IPC.canvasNoteRemove]: z.object({ id: z.string().uuid() }),
  [IPC.canvasStrokes]: z.object({ canvasId: z.string().uuid() }),
  [IPC.canvasStrokeSave]: canvasStrokeSchema,
  [IPC.canvasStrokeRemove]: z.object({ id: z.string().uuid() }),

  // 内置浏览器 · Chrome 书签导入
  [IPC.browserChromeDetect]: z.void(),
  [IPC.browserBookmarksPreview]: chromeProfileRequestSchema,
  [IPC.browserBookmarksImport]: chromeProfileRequestSchema,
  [IPC.browserBookmarksTree]: z.void(),
  [IPC.browserShowStart]: z.void(),

  // 内置浏览器
  [IPC.browserState]: z.void(),
  [IPC.browserOpen]: browserOpenSchema,
  [IPC.browserHide]: z.void(),
  [IPC.browserClose]: z.void(),
  [IPC.browserNavigate]: browserNavigateSchema,
  [IPC.browserBack]: z.void(),
  [IPC.browserForward]: z.void(),
  [IPC.browserReload]: z.void(),
  [IPC.browserStop]: z.void(),
  [IPC.browserSetBounds]: browserBoundsUpdateSchema,
  [IPC.browserOpenExternal]: z.object({ url: z.string().max(2_048).optional() }).optional()
} as const

export type IpcChannel = keyof typeof ipcRequestSchemas

export type IpcRequest<C extends IpcChannel> =
  (typeof ipcRequestSchemas)[C] extends z.ZodVoid ? void : z.infer<(typeof ipcRequestSchemas)[C]>
