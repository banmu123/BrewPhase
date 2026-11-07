import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/contracts/validation/ipc'
import type { RendererApi } from '../shared/contracts'

/**
 * Renderer 与主进程之间**唯一的桥**。
 *
 * 逐条列出能力，不暴露 `ipcRenderer` 本身：renderer 只能调用这里出现的函数，
 * 也就无法构造任意通道名去试探主进程。参数校验在主进程再做一次——preload 里
 * 的 TypeScript 类型只是开发期约束，运行时不算数。
 */
const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload)

const api: RendererApi = {
  app: {
    info: () => invoke(IPC.appInfo)
  },
  coffee: {
    listBeans: () => invoke(IPC.beansList),
    createBean: (draft) => invoke(IPC.beanCreate, draft),
    updateBean: (id, draft) => invoke(IPC.beanUpdate, { id, draft }),
    deleteBean: (id) => invoke(IPC.beanDelete, { id }),
    listBrews: (beanId) => invoke(IPC.brewsList, { beanId }),
    createBrew: (draft) => invoke(IPC.brewCreate, draft),
    updateBrew: (id, draft) => invoke(IPC.brewUpdate, { id, draft }),
    deleteBrew: (id) => invoke(IPC.brewDelete, { id }),
    listTastings: (beanId) => invoke(IPC.tastingsList, { beanId }),
    createTasting: (draft) => invoke(IPC.tastingCreate, draft),
    listPhaseRules: () => invoke(IPC.phaseRulesList)
  },
  records: {
    list: (query) => invoke(IPC.recordsList, query),
    get: (id) => invoke(IPC.recordGet, { id }),
    create: (draft) => invoke(IPC.recordCreate, draft),
    update: (id, draft) => invoke(IPC.recordUpdate, { id, draft }),
    remove: (id) => invoke(IPC.recordDelete, { id }),
    listTags: () => invoke(IPC.tagsList),
    createTag: (name) => invoke(IPC.tagCreate, { name }),
    deleteTag: (id) => invoke(IPC.tagDelete, { id }),
    importImage: () => invoke(IPC.recordImportImage),
    resolveMetadata: (id, force = false) => invoke(IPC.recordResolveMetadata, { id, force }),
    mediaUrl: (fileName: string) => `bpmedia://media/${encodeURIComponent(fileName)}`
  },
  sync: {
    status: () => invoke(IPC.syncStatus),
    enable: (enabled) => invoke(IPC.syncEnable, enabled),
    startPairing: () => invoke(IPC.syncStartPairing),
    revokeDevice: (id) => invoke(IPC.syncRevokeDevice, { id }),
    conflicts: () => invoke(IPC.syncConflicts),
    resolveConflict: (id, resolution) => invoke(IPC.syncResolveConflict, { id, resolution }),
    onChanged: (listener) => {
      const wrapped = () => listener()
      ipcRenderer.on('sync:changed', wrapped)
      return () => ipcRenderer.removeListener('sync:changed', wrapped)
    }
  },
  canvas: {
    list: () => invoke(IPC.canvasesList),
    create: (name, note = '') => invoke(IPC.canvasCreate, { name, note }),
    remove: (id) => invoke(IPC.canvasDelete, { id }),
    nodes: (canvasId) => invoke(IPC.canvasNodes, { canvasId }),
    addNode: (canvasId, recordId) => invoke(IPC.canvasNodeAdd, { canvasId, recordId }),
    moveNode: (id, positionX, positionY) => invoke(IPC.canvasNodeMove, { id, positionX, positionY }),
    removeNode: (id) => invoke(IPC.canvasNodeRemove, { id })
  }
}

contextBridge.exposeInMainWorld('brewphase', api)
