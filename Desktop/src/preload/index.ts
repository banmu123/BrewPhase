import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/contracts/validation/ipc'
import {
  BROWSER_CHANGED_CHANNEL,
  BROWSER_DRAG_CHANNEL,
  BROWSER_PREVIEW_CHANNEL,
  type BrowserDragFrame,
  type BrowserPreviewEvent,
  type BrowserState
} from '../shared/contracts/browser'
import { ROUNDTABLE_CHANGED_CHANNEL, type RoundtableSnapshot } from '../shared/roundtable'
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
  // 可拆卸浏览器窗口：拖动归属由主进程裁定，这里只报意图与坐标。
  browserTabs: {
    create: () => invoke(IPC.browserCreateTab),
    createShelfTab: () => invoke(IPC.browserCreateShelfTab),
    activate: (tabId) => invoke(IPC.browserActivateTab, { tabId }),
    closeTab: (tabId) => invoke(IPC.browserCloseTab, { tabId }),
    navigate: (tabId, input) => invoke(IPC.browserNavigateTab, { tabId, input }),
    reorder: (tabId, beforeTabId) => invoke(IPC.browserReorderTab, { tabId, beforeTabId }),
    resolveDrop: (tabId, screenX, screenY) => invoke(IPC.browserResolveDrop, { tabId, screenX, screenY }),
    detach: (tabId, screenX, screenY) => invoke(IPC.browserDetachTab, { tabId, screenX, screenY }),
    recall: (tabId) => invoke(IPC.browserRecallTab, { tabId }),
    dragProbe: (screenX, screenY) => invoke(IPC.browserDragProbe, { screenX, screenY }),
    reattach: (tabId) => invoke(IPC.browserReattach, { tabId }),
    floatActivate: (windowId, tabId) => invoke(IPC.browserFloatActivate, { windowId, tabId }),
    floatBounds: (windowId, bounds) => invoke(IPC.browserFloatBounds, { windowId, bounds }),
    executeOnTab: (tabId, script) => invoke(IPC.browserExecuteOnTab, { tabId, script })
  },
  // 缩略图：只收主进程采集好的本地 data URL，Renderer 不接触页面内容。
  browserPreviews: {
    list: () => invoke(IPC.browserPreviewList),
    get: (tabId) => invoke(IPC.browserPreviewGet, { tabId }),
    request: (tabId) => invoke(IPC.browserPreviewRequest, { tabId }),
    onChanged: (listener) => {
      const wrapped = (_event: unknown, payload: BrowserPreviewEvent) => listener(payload)
      ipcRenderer.on(BROWSER_PREVIEW_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(BROWSER_PREVIEW_CHANNEL, wrapped)
    }
  },
  // 拖拽会话（Phase 3）：只报三个意图；「窗口外」判定在主进程轮询系统光标。
  browserDrag: {
    begin: (tabId) => invoke(IPC.browserDragBegin, { tabId }),
    dropHandled: (tabId) => invoke(IPC.browserDragDropHandled, { tabId }),
    end: (tabId, point) => invoke(IPC.browserDragEnd, { tabId, screenX: point?.screenX, screenY: point?.screenY }),
    onFrame: (listener) => {
      const wrapped = (_event: unknown, frame: BrowserDragFrame) => listener(frame)
      ipcRenderer.on(BROWSER_DRAG_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(BROWSER_DRAG_CHANNEL, wrapped)
    }
  },
  // AI 圆桌（Phase 3）：主进程唯一状态；这里只转发意图与快照。
  roundtable: {
    state: () => invoke(IPC.roundtableState),
    join: (tabId) => invoke(IPC.roundtableJoin, { tabId }),
    leave: (tabId) => invoke(IPC.roundtableLeave, { tabId }),
    reorder: (tabId, overId) => invoke(IPC.roundtableReorder, { tabId, overId }),
    setDraft: (draft) => invoke(IPC.roundtableSetDraft, { draft }),
    detach: (point) =>
      invoke(IPC.roundtableDetach, point ? { screenX: point.screenX, screenY: point.screenY } : undefined),
    dock: () => invoke(IPC.roundtableDock),
    focus: () => invoke(IPC.roundtableFocus),
    dragBegin: () => invoke(IPC.roundtableDragBegin),
    dragDropHandled: () => invoke(IPC.roundtableDragDropHandled),
    dragEnd: (point) =>
      invoke(IPC.roundtableDragEnd, point ? { screenX: point.screenX, screenY: point.screenY } : undefined),
    onSnapshot: (listener) => {
      const wrapped = (_event: unknown, snapshot: RoundtableSnapshot) => listener(snapshot)
      ipcRenderer.on(ROUNDTABLE_CHANGED_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(ROUNDTABLE_CHANGED_CHANNEL, wrapped)
    }
  },
  // AI Workspace：Multi-AI 并行提问。自动化全在主进程，这里只有意图。
  aiChat: {
    statuses: () => invoke(IPC.aiChatStatus),
    ask: (input) => invoke(IPC.aiChatAsk, input),
    cancel: () => invoke(IPC.aiChatCancel),
    lastTask: () => invoke(IPC.aiChatLastTask),
    openLogin: (provider) => invoke(IPC.aiChatOpenLogin, provider),
    viewURL: (provider) => invoke(IPC.aiChatViewURL, provider),
    conversations: () => invoke(IPC.aiChatConversations),
    conversation: (id) => invoke(IPC.aiChatConversation, { id }),
    deleteConversation: (id) => invoke(IPC.aiChatDeleteConversation, { id }),
    onChanged: (listener) => {
      const channel = IPC.aiChatStatus + ':changed'
      ipcRenderer.on(channel, (_event, payload) => listener(payload))
      return () => ipcRenderer.removeAllListeners(channel)
    }
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
