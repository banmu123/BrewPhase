import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/contracts/validation/ipc'
import { BROWSER_CHANGED_CHANNEL, type BrowserState } from '../shared/contracts/browser'
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
    info: () => invoke(IPC.appInfo),
    // 轻量菜单入口（Windows/Linux）：弹出主进程的应用菜单，快捷键随之可用。
    popupMenu: () => invoke(IPC.appPopupMenu),
    // Studio Home 只读：最近工作上下文。
    studioList: () => invoke(IPC.workContextsStudio),
    // 外观：只报明暗，窗口底色与标题栏配色由主进程映射。
    setAppearance: (appearance) => invoke(IPC.appThemeAppearance, appearance),
    onChanged: (listener) => {
      const wrapped = (_event: unknown, domain: string) => listener(domain as never)
      ipcRenderer.on('app:changed', wrapped)
      return () => ipcRenderer.removeListener('app:changed', wrapped)
    }
  },
  // Personal Direction：确认草稿只走这一组通道，MCP 侧没有对应能力。
  direction: {
    overview: () => invoke(IPC.directionOverview),
    saveCurrentState: (draft) => invoke(IPC.directionSaveCurrentState, draft),
    confirmCurrentState: (id) => invoke(IPC.directionConfirmCurrentState, { id }),
    createDirection: (input) => invoke(IPC.directionCreateDirection, input),
    updateDirection: (id, expectedUpdatedAt, patch) =>
      invoke(IPC.directionUpdateDirection, { id, expectedUpdatedAt, patch }),
    deleteDirection: (id) => invoke(IPC.directionDeleteDirection, { id }),
    createStage: (input) => invoke(IPC.directionCreateStage, input),
    updateStage: (id, expectedUpdatedAt, patch) =>
      invoke(IPC.directionUpdateStage, { id, expectedUpdatedAt, patch }),
    deleteStage: (id) => invoke(IPC.directionDeleteStage, { id }),
    resolveProposal: (kind, id, action) => invoke(IPC.directionResolveProposal, { kind, id, action })
  },
  // AI Agent 自动配置：目标路径由主进程解析，这里只传类型与 scope。
  agents: {
    detect: () => invoke(IPC.agentsDetect),
    plan: (kind) => invoke(IPC.agentsPlan, { kind }),
    apply: (input) => invoke(IPC.agentsApply, input)
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
    importImage: () => invoke(IPC.recordImportImage),
    resolveMetadata: (id, force = false) => invoke(IPC.recordResolveMetadata, { id, force }),
    // `version` 只进查询串：主进程按 pathname 取文件名，不解析 query。
    mediaUrl: (fileName: string, version?: number) =>
      `bpmedia://media/${encodeURIComponent(fileName)}${version ? `?v=${version}` : ''}`,
    onMetadataUpdated: (listener) => {
      const wrapped = () => listener()
      ipcRenderer.on('records:metadata-updated', wrapped)
      return () => ipcRenderer.removeListener('records:metadata-updated', wrapped)
    }
  },
  sync: {
    status: () => invoke(IPC.syncStatus),
    enable: (enabled) => invoke(IPC.syncEnable, enabled),
    startPairing: () => invoke(IPC.syncStartPairing),
    revokeDevice: (id) => invoke(IPC.syncRevokeDevice, { id }),
    wipeData: () => invoke(IPC.syncWipeData),
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
    resizeNode: (id, width, height) => invoke(IPC.canvasNodeResize, { id, width, height }),
    annotateNode: (id, annotation) => invoke(IPC.canvasNodeAnnotate, { id, annotation }),
    removeNode: (id) => invoke(IPC.canvasNodeRemove, { id }),
    rename: (id, name) => invoke(IPC.canvasRename, { id, name }),
    notes: (canvasId) => invoke(IPC.canvasNotes, { canvasId }),
    createNote: (canvasId, positionX, positionY) => invoke(IPC.canvasNoteCreate, { canvasId, positionX, positionY }),
    updateNote: (note) => invoke(IPC.canvasNoteUpdate, note),
    removeNote: (id) => invoke(IPC.canvasNoteRemove, { id }),
    strokes: (canvasId) => invoke(IPC.canvasStrokes, { canvasId }),
    saveStroke: (stroke) => invoke(IPC.canvasStrokeSave, stroke),
    removeStroke: (id) => invoke(IPC.canvasStrokeRemove, { id })
  },
  mcp: {
    listClients: () => invoke(IPC.mcpClientsList),
    createClient: (input) => invoke(IPC.mcpClientCreate, input),
    revokeClient: (id) => invoke(IPC.mcpClientRevoke, { id }),
    bridgeStatus: () => invoke(IPC.mcpBridgeStatus)
  },
  /**
   * 内置浏览器。网页由主进程的 WebContentsView 绘制，这里只有「壳」的操作：
   * 导航、几何与状态。没有任何读取页面内容、Cookie 或登录凭据的通道。
   */
  browser: {
    state: () => invoke(IPC.browserState),
    open: (input) => invoke(IPC.browserOpen, input ?? {}),
    hide: () => invoke(IPC.browserHide),
    close: () => invoke(IPC.browserClose),
    navigate: (input) => invoke(IPC.browserNavigate, { input }),
    back: () => invoke(IPC.browserBack),
    forward: () => invoke(IPC.browserForward),
    reload: () => invoke(IPC.browserReload),
    stop: () => invoke(IPC.browserStop),
    setBounds: async (bounds) => {
      await invoke(IPC.browserSetBounds, bounds)
    },
    openExternal: async (url) => {
      await invoke(IPC.browserOpenExternal, url ? { url } : {})
    },
    showStart: () => invoke(IPC.browserShowStart),
    showCurrentPage: () => invoke(IPC.browserShowCurrent),
    // 只传 Profile 目录名：preload 不构造路径，主进程也不接受路径。
    detectChrome: () => invoke(IPC.browserChromeDetect),
    previewChromeBookmarks: (profileId) => invoke(IPC.browserBookmarksPreview, { profileId }),
    importChromeBookmarks: (profileId) => invoke(IPC.browserBookmarksImport, { profileId }),
    bookmarks: () => invoke(IPC.browserBookmarksTree),
    onChanged: (listener) => {
      const wrapped = (_event: unknown, state: BrowserState) => listener(state)
      ipcRenderer.on(BROWSER_CHANGED_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(BROWSER_CHANGED_CHANNEL, wrapped)
    }
  },
  chrome: {
    status: () => invoke(IPC.chromeStatus),
    install: () => invoke(IPC.chromeInstall),
    uninstall: () => invoke(IPC.chromeUninstall),
    selfTest: () => invoke(IPC.chromeSelfTest)
  },
  dataLocation: {
    status: () => invoke(IPC.dataLocationStatus),
    choose: () => invoke(IPC.dataLocationChoose),
    reset: () => invoke(IPC.dataLocationReset),
    relaunch: () => invoke(IPC.dataLocationRelaunch)
  }
}

contextBridge.exposeInMainWorld('brewphase', api)
