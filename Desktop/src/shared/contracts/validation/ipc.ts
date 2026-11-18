import { z } from 'zod'
import { beanDraftSchema, brewDraftSchema } from '../entities/coffee'
import { recordDraftSchema, recordQuerySchema } from '../entities/records'
import { canvasNodeMoveSchema, canvasNodeResizeSchema, canvasNoteSchema, canvasStrokeSchema } from '../entities/canvas'
import { mcpClientCreateInputSchema, mcpScopeSchema } from '../mcp'
import { aiAskInputSchema, aiProviderSchema } from '../ai-chat'
import { roundtableAIAskInputSchema, roundtableAIDescribeInputSchema } from '../roundtable-ai'
import {
  CONTEXT_MAX_FILES,
  LOCAL_WORKSPACE_NAME_MAX,
  relativePathSchema
} from '../local-workspace'
import {
  REPLY_RAW_MAX_CHARS,
  actionRiskLevelSchema,
  replyCategorySchema
} from '../reply-intelligence'
import {
  browserDropSchema,
  browserDragProbeSchema,
  browserBoundsSchema,
  browserDetachTabSchema,
  browserNavigateTabSchema,
  browserPreviewRequestSchema,
  browserDragBeginSchema,
  browserDragDropHandledSchema,
  browserDragEndSchema
} from '../browser'
import { browserBoundsUpdateSchema, browserNavigateSchema, browserOpenSchema } from '../browser'
import { ROUNDTABLE_DRAFT_MAX } from '../../roundtable'
import { chromeProfileRequestSchema } from '../bookmarks'
import { agentKindSchema } from '../agents'
import {
  currentStateDraftSchema,
  directionInputSchema,
  directionPatchSchema,
  proposalKindSchema,
  stageGoalInputSchema,
  stageGoalPatchSchema
} from '../personal-direction'
import { accountProviderSchema } from '../account'

/**
 * IPC 的**唯一**契约清单：通道名 + 请求体校验 + 响应形状。
 *
 * 主进程对每个调用都先 `schema.parse`，再进 repository；任何一条请求不合法都
 * 在边界上被拒掉，不会带着脏参数闯进 SQL。Renderer 拿到的类型也来自这里，
 * 两端只有一份真相。
 */

export const IPC = {
  appInfo: 'app:info',
  // 版本感知：只查询 GitHub Releases 的版本号，不下载、不安装。
  updateCheck: 'update:check',
  updateOpenRelease: 'update:open-release',
  appPopupMenu: 'app:popup-menu',
  // 外观：Renderer 只报「现在是浅色还是深色」，色值由主进程自己决定。
  // 不让 Renderer 传颜色，是为了窗口底色与页面配色永远出自同一份定义。
  appThemeAppearance: 'app:theme-appearance',
  workContextsStudio: 'work-contexts:studio',

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

  // ---- Remote MCP（Phase 1.1B）----
  // 刻意**没有** `remote:call`：远程调用只能由 Cloud 发起，本地不开
  // 「手动触发一次远程工具」的入口——那会绕过所有 UI 确认。
  remoteStatus: 'remote:status',
  remoteEnable: 'remote:enable',
  remoteDisable: 'remote:disable',
  remoteRegister: 'remote:register',
  remoteForget: 'remote:forget',
  remoteUnbind: 'remote:unbind',
  remoteDiagnose: 'remote:diagnose',

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
  browserShowCurrent: 'browser:show-current',
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
  browserOpenExternal: 'browser:open-external',

  // Chrome Companion：Desktop 侧只暴露「状态 / 安装 / 卸载」三个管理动作。
  // 网页内容走 Native Messaging → 本地 IPC，不经过 Renderer。
  chromeStatus: 'chrome:status',
  chromeInstall: 'chrome:install',
  chromeUninstall: 'chrome:uninstall',
  chromeSelfTest: 'chrome:self-test',

  // 数据目录：只在本机选目录、迁移、重启；Renderer 不传路径。
  dataLocationStatus: 'data-location:status',
  dataLocationChoose: 'data-location:choose',
  dataLocationReset: 'data-location:reset',
  dataLocationRelaunch: 'data-location:relaunch',

  // Personal Direction：桌面端本地数据。**确认类动作只在这里出现**——
  // MCP 侧没有对应通道，AI 因此无法把草稿转成正式资料。
  directionOverview: 'direction:overview',
  directionSaveCurrentState: 'direction:current-state:save',
  directionConfirmCurrentState: 'direction:current-state:confirm',
  directionCreateDirection: 'direction:create',
  directionUpdateDirection: 'direction:update',
  directionDeleteDirection: 'direction:delete',
  directionCreateStage: 'direction:stage:create',
  directionUpdateStage: 'direction:stage:update',
  directionDeleteStage: 'direction:stage:delete',
  directionResolveProposal: 'direction:proposal:resolve',

  // AI Agent 自动配置：检测、预览、写入。目标路径永远由主进程解析。
  agentsDetect: 'agents:detect',
  agentsPlan: 'agents:plan',
  agentsApply: 'agents:apply',

  // AI Workspace：Multi-AI 并行提问
  aiChatStatus: 'ai-chat:status',
  aiChatAsk: 'ai-chat:ask',
  aiChatCancel: 'ai-chat:cancel',
  aiChatLastTask: 'ai-chat:last-task',
  aiChatOpenLogin: 'ai-chat:open-login',
  aiChatViewURL: 'ai-chat:view-url',
  aiChatConversations: 'ai-chat:conversations',
  aiChatConversation: 'ai-chat:conversation',
  aiChatDeleteConversation: 'ai-chat:conversation:delete',

  // 可拆卸浏览器窗口（Phase 0.5）
  browserCreateTab: 'browser:tab:create',
  browserActivateTab: 'browser:tab:activate',
  browserCloseTab: 'browser:tab:close',
  browserReorderTab: 'browser:tab:reorder',
  browserResolveDrop: 'browser:tab:drop',
  browserDragProbe: 'browser:tab:drag-probe',
  browserReattach: 'browser:tab:reattach',
  browserFloatActivate: 'browser:float:activate',
  browserFloatBounds: 'browser:float:bounds',
  browserExecuteOnTab: 'browser:tab:execute',
  // Phase 2：网页卡片 = 真实标签；缩略图与「架子上的标签」各自有独立入口。
  browserCreateShelfTab: 'browser:tab:create-shelf',
  browserNavigateTab: 'browser:tab:navigate',
  browserDetachTab: 'browser:tab:detach',
  browserRecallTab: 'browser:tab:recall-shelf',
  browserPreviewList: 'browser:preview:list',
  browserPreviewGet: 'browser:preview:get',
  browserPreviewRequest: 'browser:preview:request',
  // Phase 3：拖拽会话。主进程轮询系统光标做「窗口外」判定，
  // 渲染层只报 dragstart / 内部投放 / dragend 三个意图。
  browserDragBegin: 'browser:drag:begin',
  browserDragDropHandled: 'browser:drag:drop-handled',
  browserDragEnd: 'browser:drag:end',
  // Phase 3：AI 圆桌独立窗口。主进程是唯一状态持有者，两个 Renderer
  // 订阅同一份快照；写草稿带 baseVersion 做乐观并发控制。
  roundtableState: 'roundtable:state',
  roundtableJoin: 'roundtable:join',
  roundtableLeave: 'roundtable:leave',
  roundtableReorder: 'roundtable:reorder',
  roundtableSetDraft: 'roundtable:set-draft',
  roundtableDetach: 'roundtable:detach',
  roundtableDock: 'roundtable:dock',
  roundtableFocus: 'roundtable:focus',
  roundtableDragBegin: 'roundtable:drag:begin',
  roundtableDragDropHandled: 'roundtable:drag:drop-handled',
  roundtableDragEnd: 'roundtable:drag:end',
  // Phase 4.2 workspace：自由布局多网页工作空间。布局是主进程唯一状态；
  // rects 上报是「渲染层测量 → 主进程 setBounds 原生视图」的唯一路径。
  roundtableWorkspaceEnter: 'roundtable:workspace:enter',
  roundtableWorkspaceExit: 'roundtable:workspace:exit',
  roundtableLayoutGet: 'roundtable-layout:get',
  roundtableLayoutMove: 'roundtable-layout:move',
  roundtableLayoutResize: 'roundtable-layout:resize',
  roundtableLayoutFront: 'roundtable-layout:front',
  roundtableLayoutSnap: 'roundtable-layout:snap',
  roundtableLayoutWorkspaceSize: 'roundtable-layout:workspace-size',
  roundtableLayoutActive: 'roundtable-layout:active',
  roundtablePanelBounds: 'roundtable-layout:panel-bounds',
  roundtableAddWeb: 'roundtable:add-web',
  roundtableLayoutRebind: 'roundtable-layout:rebind',
  // Phase 4.2：真实 WebCard 驱动的圆桌问答。tabId 是参与者身份，主进程
  // 负责「校验成员 → 解析真实 WebContents → Registry 识别 → 执行」。
  roundtableAIAsk: 'roundtable-ai:ask',
  roundtableAICancel: 'roundtable-ai:cancel',
  roundtableAICancelParticipant: 'roundtable-ai:cancel-participant',
  roundtableAILastTask: 'roundtable-ai:last-task',
  roundtableAIDescribe: 'roundtable-ai:describe',

  // AI Card Workspace Bridge（Phase 1）：本地工作区 + 卡片绑定 + 只读文件
  // 访问 + 上下文打包。文件访问只接受 workspaceId + POSIX 相对路径——
  // 绝对路径与写操作没有对应通道。
  workspaceList: 'workspace:list',
  workspaceAdd: 'workspace:add',
  workspaceRename: 'workspace:rename',
  workspaceRemove: 'workspace:remove',
  workspaceBindingGet: 'workspace:binding:get',
  workspaceBindingSet: 'workspace:binding:set',
  workspaceFilesList: 'workspace:files:list',
  workspaceFileRead: 'workspace:file:read',
  workspaceSearch: 'workspace:search',
  workspaceContextBuild: 'workspace:context:build',
  // 结构化上下文「复制到 AI 对话」：主进程写剪贴板（无焦点窗口也可靠）。
  clipboardCopy: 'app:clipboard:copy',

  // AI Reply Intelligence（Phase 2）：回复导入 / 分类 / 草稿。剪贴板
  // 只在 captureFromClipboard 时读取一次——没有监听或轮询通道。
  replyCaptureClipboard: 'reply:capture:clipboard',
  replyCapturePaste: 'reply:capture:paste',
  replyList: 'reply:list',
  replyGet: 'reply:get',
  replyRemove: 'reply:remove',
  replySegmentUpdate: 'reply:segment:update',
  replySegmentRemove: 'reply:segment:remove',
  replyDraftCreate: 'reply:draft:create',
  replyDraftUpdate: 'reply:draft:update',
  replyDraftRemove: 'reply:draft:remove',
  replyDraftList: 'reply:draft:list',

  // Cloud Account（Phase 1.2）：只有四个意图。**登录不接收任何凭据**——
  // 入参只有一个 provider 名字；授权码、state、PKCE 全在主进程内产生与消费。
  accountStatus: 'account:status',
  accountLogin: 'account:login',
  accountCancelLogin: 'account:cancel-login',
  // 手动重新校验会话（设置页「刷新状态」）：只做一次，不带任何参数。
  accountRefresh: 'account:refresh',
  accountSignOut: 'account:sign-out'
} as const

export const ipcRequestSchemas = {
  [IPC.appInfo]: z.void(),
  // force 只由设置页「检查更新」按钮传 true；自动检查走 24h 缓存。
  [IPC.updateCheck]: z.object({ force: z.boolean().optional() }).optional(),
  // 刻意不收 URL：主进程只打开自己缓存且过白名单的 GitHub 地址。
  [IPC.updateOpenRelease]: z.void(),
  // Studio Home「继续工作」区块的只读读取（创建/更新走 MCP）。
  [IPC.workContextsStudio]: z.void(),
  // 轻量菜单入口：Renderer 顶栏按钮 → 主进程把应用菜单弹成 popup。
  // 无参数；菜单内容与快捷键都在主进程的 role 里，不经 Renderer 之手。
  [IPC.appPopupMenu]: z.void(),
  // 窗口底色与 Windows 标题栏按钮的配色：只接受两个已定义的取值。
  [IPC.appThemeAppearance]: z.enum(['light', 'dark']),
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
  [IPC.browserShowCurrent]: z.void(),

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
  [IPC.browserOpenExternal]: z.object({ url: z.string().max(2_048).optional() }).optional(),

  // Chrome Companion：三个动作都不带参数，避免 Renderer 传路径 / 扩展 ID。
  [IPC.chromeStatus]: z.void(),
  [IPC.chromeInstall]: z.void(),
  [IPC.chromeUninstall]: z.void(),
  [IPC.chromeSelfTest]: z.void(),

  [IPC.dataLocationStatus]: z.void(),
  [IPC.dataLocationChoose]: z.void(),
  [IPC.dataLocationReset]: z.void(),
  [IPC.dataLocationRelaunch]: z.void(),

  // Personal Direction
  [IPC.directionOverview]: z.void(),
  [IPC.directionSaveCurrentState]: currentStateDraftSchema,
  [IPC.directionConfirmCurrentState]: z.object({ id: z.string().uuid() }),
  [IPC.directionCreateDirection]: directionInputSchema,
  [IPC.directionUpdateDirection]: z.object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.number().int(),
    patch: directionPatchSchema
  }),
  [IPC.directionDeleteDirection]: z.object({ id: z.string().uuid() }),
  [IPC.directionCreateStage]: stageGoalInputSchema,
  [IPC.directionUpdateStage]: z.object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.number().int(),
    patch: stageGoalPatchSchema
  }),
  [IPC.directionDeleteStage]: z.object({ id: z.string().uuid() }),
  // 确认与丢弃合在一个通道：两者的入参形状相同，分成两条只会让
  // preload 多一个几乎一样的函数。
  [IPC.directionResolveProposal]: z.object({
    kind: proposalKindSchema,
    id: z.string().uuid(),
    action: z.enum(['confirm', 'discard'])
  }),

  // Agent 自动配置
  [IPC.agentsDetect]: z.void(),
  [IPC.agentsPlan]: z.object({ kind: agentKindSchema }),
  [IPC.agentsApply]: z.object({
    kind: agentKindSchema,
    name: z.string().trim().min(1).max(80),
    scopes: z.array(mcpScopeSchema).min(1),
    /** 已存在同名条目时，必须显式传 true 才允许替换。 */
    replaceExisting: z.boolean().default(false)
  }),

  [IPC.aiChatStatus]: z.void(),
  [IPC.aiChatAsk]: aiAskInputSchema,
  [IPC.aiChatCancel]: z.void(),
  [IPC.aiChatLastTask]: z.void(),
  [IPC.aiChatOpenLogin]: aiProviderSchema,
  [IPC.aiChatViewURL]: aiProviderSchema,
  [IPC.aiChatConversations]: z.void(),
  [IPC.aiChatConversation]: z.object({ id: z.string().uuid() }),
  [IPC.aiChatDeleteConversation]: z.object({ id: z.string().uuid() }),

  // Phase 4.2：圆桌真实 WebCard 问答。Renderer 只传 tabId；平台识别、
  // WebContents 解析与执行全部在主进程。
  [IPC.roundtableAIAsk]: roundtableAIAskInputSchema,
  [IPC.roundtableAICancel]: z.void(),
  [IPC.roundtableAICancelParticipant]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.roundtableAILastTask]: z.void(),
  [IPC.roundtableAIDescribe]: roundtableAIDescribeInputSchema,

  // Phase 4.2 workspace：自由布局。坐标都是工作区局部坐标。
  [IPC.roundtableWorkspaceEnter]: z.void(),
  [IPC.roundtableWorkspaceExit]: z.void(),
  [IPC.roundtableLayoutGet]: z.void(),
  [IPC.roundtableLayoutMove]: z.object({
    tabId: z.string().min(1).max(64),
    x: z.number(),
    y: z.number()
  }),
  [IPC.roundtableLayoutResize]: z.object({
    tabId: z.string().min(1).max(64),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    /** 缩放锚点（哪几条边随指针动）——防重叠解析要保住对侧边不动。 */
    anchor: z.enum(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']).optional()
  }),
  [IPC.roundtableLayoutFront]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.roundtableLayoutSnap]: z.object({ enabled: z.boolean() }),
  [IPC.roundtableLayoutWorkspaceSize]: z.object({ width: z.number(), height: z.number() }),
  [IPC.roundtableLayoutActive]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.roundtablePanelBounds]: z.object({
    rects: z
      .array(
        z.object({
          tabId: z.string().min(1).max(64),
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number()
        })
      )
      .max(24)
  }),
  [IPC.roundtableAddWeb]: z.object({ url: z.string().min(1).max(2048) }),
  [IPC.roundtableLayoutRebind]: z.object({
    oldTabId: z.string().min(1).max(64),
    url: z.string().min(1).max(2048)
  }),

  [IPC.browserCreateTab]: z.void(),
  [IPC.browserActivateTab]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.browserCloseTab]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.browserReorderTab]: z.object({ tabId: z.string().min(1).max(64), beforeTabId: z.string().min(1).max(64).nullable() }),
  [IPC.browserResolveDrop]: browserDropSchema,
  [IPC.browserDragProbe]: browserDragProbeSchema,
  [IPC.browserReattach]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.browserFloatActivate]: z.object({ windowId: z.number().int(), tabId: z.string().min(1).max(64) }),
  [IPC.browserFloatBounds]: z.object({ windowId: z.number().int(), bounds: browserBoundsSchema }),
  [IPC.browserExecuteOnTab]: z.object({
    tabId: z.string().min(1).max(64),
    script: z.string().min(1).max(32_000)
  }),
  [IPC.browserCreateShelfTab]: z.void(),
  [IPC.browserNavigateTab]: browserNavigateTabSchema,
  [IPC.browserDetachTab]: browserDetachTabSchema,
  [IPC.browserRecallTab]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.browserPreviewList]: z.void(),
  [IPC.browserPreviewGet]: browserPreviewRequestSchema,
  [IPC.browserPreviewRequest]: browserPreviewRequestSchema,

  // Phase 3：拖拽会话（卡片）。松手位置由主进程轮询的系统光标裁定，
  // dragEnd 的坐标只是无轮询读数时的兜底。
  [IPC.browserDragBegin]: browserDragBeginSchema,
  [IPC.browserDragDropHandled]: browserDragDropHandledSchema,
  [IPC.browserDragEnd]: browserDragEndSchema,

  // Phase 3：AI 圆桌。主进程唯一状态；detach 可带松手点（按钮拆出则缺省）。
  [IPC.roundtableState]: z.void(),
  [IPC.roundtableJoin]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.roundtableLeave]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.roundtableReorder]: z.object({
    tabId: z.string().min(1).max(64),
    overId: z.string().min(1).max(64)
  }),
  [IPC.roundtableSetDraft]: z.object({
    draft: z.string().max(ROUNDTABLE_DRAFT_MAX)
  }),
  [IPC.roundtableDetach]: z
    .object({ screenX: z.number().finite().optional(), screenY: z.number().finite().optional() })
    .optional(),
  [IPC.roundtableDock]: z.void(),
  [IPC.roundtableFocus]: z.void(),
  [IPC.roundtableDragBegin]: z.void(),
  [IPC.roundtableDragDropHandled]: z.void(),
  [IPC.roundtableDragEnd]: z
    .object({ screenX: z.number().finite().optional(), screenY: z.number().finite().optional() })
    .optional(),

  // ---- AI Card Workspace Bridge（Phase 1）----
  [IPC.workspaceList]: z.void(),
  [IPC.workspaceAdd]: z.void(),
  [IPC.workspaceRename]: z.object({ id: z.string().uuid(), name: z.string().min(1).max(LOCAL_WORKSPACE_NAME_MAX) }),
  [IPC.workspaceRemove]: z.object({ id: z.string().uuid() }),
  [IPC.workspaceBindingGet]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.workspaceBindingSet]: z.object({
    tabId: z.string().min(1).max(64),
    workspaceId: z.string().uuid().nullable()
  }),
  [IPC.workspaceFilesList]: z.object({
    workspaceId: z.string().uuid(),
    relativePath: relativePathSchema
  }),
  [IPC.workspaceFileRead]: z.object({
    workspaceId: z.string().uuid(),
    relativePath: relativePathSchema
  }),
  [IPC.workspaceSearch]: z.object({
    workspaceId: z.string().uuid(),
    query: z.string().min(1).max(200)
  }),
  [IPC.workspaceContextBuild]: z.object({
    workspaceId: z.string().uuid(),
    relativePaths: z.array(relativePathSchema).min(1).max(CONTEXT_MAX_FILES)
  }),
  [IPC.clipboardCopy]: z.object({ text: z.string().min(1).max(400_000) }),

  // ---- AI Reply Intelligence（Phase 2）----
  [IPC.replyCaptureClipboard]: z.object({ tabId: z.string().min(1).max(64) }),
  [IPC.replyCapturePaste]: z.object({
    tabId: z.string().min(1).max(64),
    content: z.string().min(1).max(REPLY_RAW_MAX_CHARS)
  }),
  [IPC.replyList]: z.object({ limit: z.number().int().min(1).max(100).optional() }).optional(),
  [IPC.replyGet]: z.object({ id: z.string().uuid() }),
  [IPC.replyRemove]: z.object({ id: z.string().uuid() }),
  [IPC.replySegmentUpdate]: z.object({
    id: z.string().uuid(),
    categories: z.array(replyCategorySchema).min(1).max(4),
    content: z.string().max(REPLY_RAW_MAX_CHARS).optional()
  }),
  [IPC.replySegmentRemove]: z.object({ id: z.string().uuid() }),
  [IPC.replyDraftCreate]: z.object({
    replyId: z.string().uuid(),
    segmentId: z.string().uuid().nullable().optional()
  }),
  [IPC.replyDraftUpdate]: z.object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(4_000).optional(),
    workingDirectory: z.string().max(1_024).optional(),
    riskLevel: actionRiskLevelSchema.optional()
  }),
  [IPC.replyDraftRemove]: z.object({ id: z.string().uuid() }),
  [IPC.replyDraftList]: z.object({
    replyId: z.string().uuid().nullable().optional(),
    limit: z.number().int().min(1).max(200).optional()
  }).optional(),

  // ---- Cloud Account（Phase 1.2）----
  // 登录入参刻意只有 provider：没有 code / state / token 的入口，
  // Renderer 也就无法「代用户完成登录」或把外部拿到的 token 塞进主进程。
  [IPC.accountStatus]: z.void(),
  [IPC.accountLogin]: z.object({ provider: accountProviderSchema }),
  [IPC.accountCancelLogin]: z.void(),
  [IPC.accountRefresh]: z.void(),
  [IPC.accountSignOut]: z.void(),

  // ---- Remote MCP（Phase 1.1B）----
  // 全部无入参：开启时的「授权范围确认」在 Renderer 完成，
  // 主进程不做「接受一组 scope」的设计——远程 scope 是常量，
  // 允许 Renderer 传 scope 等于让它自己扩大授权面。
  [IPC.remoteStatus]: z.void(),
  [IPC.remoteEnable]: z.void(),
  [IPC.remoteDisable]: z.void(),
  [IPC.remoteRegister]: z.void(),
  [IPC.remoteForget]: z.void(),
  [IPC.remoteUnbind]: z.void(),
  [IPC.remoteDiagnose]: z.void()
} as const

export type IpcChannel = keyof typeof ipcRequestSchemas

export type IpcRequest<C extends IpcChannel> =
  (typeof ipcRequestSchemas)[C] extends z.ZodVoid ? void : z.infer<(typeof ipcRequestSchemas)[C]>
