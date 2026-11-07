import { z } from 'zod'
import { beanDraftSchema, brewDraftSchema, tastingDraftSchema } from '../entities/coffee'
import { recordDraftSchema, recordQuerySchema } from '../entities/records'
import { canvasNodeMoveSchema } from '../entities/canvas'

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
  tastingCreate: 'coffee:tasting:create',

  phaseRulesList: 'coffee:phase-rules:list',

  recordsList: 'records:list',
  recordGet: 'records:get',
  recordCreate: 'records:create',
  recordUpdate: 'records:update',
  recordDelete: 'records:delete',
  recordImportImage: 'records:import-image',
  tagsList: 'records:tags:list',
  tagCreate: 'records:tag:create',
  tagDelete: 'records:tag:delete',

  canvasesList: 'canvas:list',
  canvasCreate: 'canvas:create',
  canvasDelete: 'canvas:delete',
  canvasNodes: 'canvas:nodes',
  canvasNodeAdd: 'canvas:node:add',
  canvasNodeMove: 'canvas:node:move',
  canvasNodeRemove: 'canvas:node:remove'
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
  [IPC.tastingCreate]: tastingDraftSchema,

  [IPC.phaseRulesList]: z.void(),

  [IPC.recordsList]: recordQuerySchema,
  [IPC.recordGet]: z.object({ id: z.string().uuid() }),
  [IPC.recordCreate]: recordDraftSchema,
  [IPC.recordUpdate]: z.object({ id: z.string().uuid(), draft: recordDraftSchema }),
  [IPC.recordDelete]: z.object({ id: z.string().uuid() }),
  [IPC.recordImportImage]: z.void(),
  [IPC.tagsList]: z.void(),
  [IPC.tagCreate]: z.object({ name: z.string().min(1).max(40) }),
  [IPC.tagDelete]: z.object({ id: z.string().uuid() }),

  [IPC.canvasesList]: z.void(),
  [IPC.canvasCreate]: z.object({ name: z.string().min(1).max(120), note: z.string().max(2_000).default('') }),
  [IPC.canvasDelete]: z.object({ id: z.string().uuid() }),
  [IPC.canvasNodes]: z.object({ canvasId: z.string().uuid() }),
  [IPC.canvasNodeAdd]: z.object({ canvasId: z.string().uuid(), recordId: z.string().uuid() }),
  [IPC.canvasNodeMove]: canvasNodeMoveSchema,
  [IPC.canvasNodeRemove]: z.object({ id: z.string().uuid() })
} as const

export type IpcChannel = keyof typeof ipcRequestSchemas

export type IpcRequest<C extends IpcChannel> =
  (typeof ipcRequestSchemas)[C] extends z.ZodVoid ? void : z.infer<(typeof ipcRequestSchemas)[C]>
