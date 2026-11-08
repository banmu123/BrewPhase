import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC, ipcRequestSchemas } from '../../shared/contracts/validation/ipc'
import type { DatabaseHandle } from '../database/client'
import {
  createBean,
  createBrew,
  createTasting,
  deleteBean,
  deleteBrew,
  listBeans,
  listBrews,
  listPhaseRules,
  listTastings,
  seedPhaseRulesIfEmpty,
  updateBean,
  updateBrew
} from '../database/repositories/coffee'
import {
  createRecord,
  createTag,
  deleteRecord,
  deleteTag,
  getRecord,
  listRecords,
  listTags,
  updateRecord
} from '../database/repositories/records'
import {
  addNode,
  resizeNode,
  createCanvas,
  createNote,
  deleteCanvas,
  listCanvases,
  listNodes,
  listNotes,
  listStrokes,
  moveNode,
  removeNode,
  removeNote,
  removeStroke,
  renameCanvas,
  saveStroke,
  updateNote
} from '../database/repositories/canvas'
import { importImageFromDialog } from '../media/store'
import { resolveRecordMetadata } from '../metadata'
import type { SyncService } from '../sync/sync-service'
import { DEFAULT_PHASE_RULES } from '../../shared/domain/phase'
import { APP_VERSION, DB_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from '../../shared/contracts/version'

/**
 * IPC 注册表：**每一个通道**都先校验来源、再校验参数，最后才碰数据库。
 *
 * 三条边界：
 * 1. 只接受我们自己的窗口（开发时是 localhost 的 dev server，生产是 file://）；
 * 2. 参数必须能通过 zod（`ipcRequestSchemas`），任何多余字段都不会流进 SQL；
 * 3. 抛回 renderer 的错误只带 message，不带栈与路径。
 */
export function registerIpc(params: {
  db: DatabaseHandle
  devServerUrl: string | null
  sync: SyncService
}): void {
  const { db, devServerUrl, sync } = params

  // 首次启动铺默认阶段规则（之后由用户或同步决定，不覆盖）。
  seedPhaseRulesIfEmpty(db.db, DEFAULT_PHASE_RULES)

  const handle = <C extends keyof typeof ipcRequestSchemas>(
    channel: C,
    handler: (input: unknown) => unknown | Promise<unknown>
  ): void => {
    ipcMain.handle(channel, async (event, payload) => {
      assertTrustedSender(event, devServerUrl)
      const schema = ipcRequestSchemas[channel] as unknown as z.ZodTypeAny
      const input = schema.safeParse(payload ?? undefined)
      if (!input.success) {
        throw new Error(`invalid payload for ${channel}: ${input.error.issues[0]?.message ?? 'unknown'}`)
      }
      try {
        return await handler(input.data)
      } catch (error) {
        // 只把可读信息传回渲染进程；栈留在主进程日志里。
        console.error(`[ipc] ${channel} failed`, error)
        throw new Error((error as Error).message || 'operation failed')
      }
    })
  }

  handle(IPC.appInfo, () => ({
    appVersion: APP_VERSION,
    dbSchemaVersion: DB_SCHEMA_VERSION,
    syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    platform: process.platform,
    dataDir: db.sqlite.name
  }))

  // MARK: - Coffee

  handle(IPC.beansList, () => listBeans(db.db))
  handle(IPC.beanCreate, (input) => createBean(db.db, db.deviceId, input as never))
  handle(IPC.beanUpdate, (input) => {
    const value = input as { id: string; draft: never }
    return updateBean(db.db, db.deviceId, value.id, value.draft)
  })
  handle(IPC.beanDelete, (input) => {
    deleteBean(db.db, db.deviceId, (input as { id: string }).id)
    return null
  })

  handle(IPC.brewsList, (input) => listBrews(db.db, (input as { beanId: string | null }).beanId))
  handle(IPC.brewCreate, (input) => createBrew(db.db, db.deviceId, input as never))
  handle(IPC.brewUpdate, (input) => {
    const value = input as { id: string; draft: never }
    return updateBrew(db.db, db.deviceId, value.id, value.draft)
  })
  handle(IPC.brewDelete, (input) => {
    deleteBrew(db.db, db.deviceId, (input as { id: string }).id)
    return null
  })

  handle(IPC.tastingsList, (input) => listTastings(db.db, (input as { beanId: string | null }).beanId))
  handle(IPC.tastingCreate, (input) => createTasting(db.db, db.deviceId, input as never))

  handle(IPC.phaseRulesList, () => listPhaseRules(db.db))

  // MARK: - Records

  handle(IPC.recordsList, (input) => listRecords(db.db, input as never))
  handle(IPC.recordGet, (input) => getRecord(db.db, (input as { id: string }).id))
  handle(IPC.recordCreate, (input) => createRecord(db.db, db.deviceId, input as never))
  handle(IPC.recordUpdate, (input) => {
    const value = input as { id: string; draft: never }
    return updateRecord(db.db, db.deviceId, value.id, value.draft)
  })
  handle(IPC.recordDelete, (input) => {
    deleteRecord(db.db, db.deviceId, (input as { id: string }).id)
    return null
  })
  handle(IPC.recordImportImage, () => importImageFromDialog())
  handle(IPC.recordResolveMetadata, (input) => {
    const value = input as { id: string; force: boolean }
    return resolveRecordMetadata(db.db, db.deviceId, value.id, value.force)
  })
  handle(IPC.tagsList, () => listTags(db.db))
  handle(IPC.tagCreate, (input) => createTag(db.db, db.deviceId, (input as { name: string }).name))
  handle(IPC.tagDelete, (input) => {
    deleteTag(db.db, db.deviceId, (input as { id: string }).id)
    return null
  })

  // MARK: - Canvas

  handle(IPC.canvasesList, () => listCanvases(db.db))
  handle(IPC.canvasCreate, (input) => {
    const value = input as { name: string; note: string }
    return createCanvas(db.db, db.deviceId, value.name, value.note)
  })
  handle(IPC.canvasDelete, (input) => {
    deleteCanvas(db.db, db.deviceId, (input as { id: string }).id)
    return null
  })
  handle(IPC.canvasNodes, (input) => listNodes(db.db, (input as { canvasId: string }).canvasId))
  handle(IPC.canvasNodeAdd, (input) => {
    const value = input as { canvasId: string; recordId: string }
    return addNode(db.db, db.deviceId, value.canvasId, value.recordId)
  })
  handle(IPC.canvasNodeResize, (input) => {
    const value = input as { id: string; width: number; height: number }
    return resizeNode(db.db, db.deviceId, value.id, value.width, value.height)
  })
  handle(IPC.canvasNodeMove, (input) => {
    const value = input as { id: string; positionX: number; positionY: number }
    moveNode(db.db, db.deviceId, value.id, value.positionX, value.positionY)
    return null
  })
  handle(IPC.canvasRename, (input) => {
    const value = input as { id: string; name: string }
    return renameCanvas(db.db, db.deviceId, value.id, value.name)
  })
  handle(IPC.canvasNotes, (input) => listNotes(db.db, (input as { canvasId: string }).canvasId))
  handle(IPC.canvasNoteCreate, (input) => {
    const value = input as { canvasId: string; positionX: number; positionY: number }
    return createNote(db.db, db.deviceId, value)
  })
  handle(IPC.canvasNoteUpdate, (input) => updateNote(db.db, db.deviceId, input as Parameters<typeof updateNote>[2]))
  handle(IPC.canvasNoteRemove, (input) => removeNote(db.db, db.deviceId, (input as { id: string }).id))
  handle(IPC.canvasStrokes, (input) => listStrokes(db.db, (input as { canvasId: string }).canvasId))
  handle(IPC.canvasStrokeSave, (input) => saveStroke(db.db, db.deviceId, input as Parameters<typeof saveStroke>[2]))
  handle(IPC.canvasStrokeRemove, (input) => removeStroke(db.db, db.deviceId, (input as { id: string }).id))
  handle(IPC.canvasNodeRemove, (input) => {
    removeNode(db.db, db.deviceId, (input as { id: string }).id)
    return null
  })

  // MARK: - 设备同步

  handle(IPC.syncStatus, () => sync.status())
  handle(IPC.syncEnable, (input) => sync.enable(Boolean(input)))
  handle(IPC.syncStartPairing, () => sync.startPairing())
  handle(IPC.syncRevokeDevice, (input) => sync.revokeDevice((input as { id: string }).id))
  handle(IPC.syncWipeData, () => sync.wipeSyncedContent())
  handle(IPC.syncConflicts, () => sync.conflicts())
  handle(IPC.syncResolveConflict, (input) => {
    const value = input as { id: string; resolution: 'local' | 'remote' }
    return sync.resolveConflict(value.id, value.resolution)
  })

}

/**
 * 只信任主框架、且 URL 属于我们自己的页面。
 * 开发时是 electron-vite 的 dev server，生产是打包后的 `file://`。
 */
function assertTrustedSender(event: IpcMainInvokeEvent, devServerUrl: string | null): void {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null) throw new Error('untrusted sender: not the top frame')
  const url = frame.url
  if (devServerUrl && url.startsWith(devServerUrl)) return
  if (url.startsWith('file://')) return
  throw new Error('untrusted sender')
}
