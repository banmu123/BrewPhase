import { app, BrowserWindow, ipcMain, Menu, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC, ipcRequestSchemas } from '../../shared/contracts/validation/ipc'
import type { DatabaseHandle } from '../database/client'
import {
  createBean,
  createBrew,
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
import type { McpClientService } from '../application/authorization/permission-service'
import type { RecordService } from '../application/records/record-service'
import type { WorkContextService } from '../application/work-context/work-context-service'
import type { McpBridgeStatus } from '../../shared/contracts/mcp'
import {
  addNode,
  resizeNode,
  setAnnotation,
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
import type { BrowserManager } from '../browser/browser-manager'
import type { BookmarkService } from '../browser/bookmark-service'
import type { ChromeService } from '../integrations/chrome/chrome-service'
import type { DataLocationService } from '../data-location-service'
import { DEFAULT_PHASE_RULES } from '../../shared/domain/phase'
import { APP_VERSION, DB_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from '../../shared/contracts/version'
import { WINDOW_CHROME, type WindowAppearance } from '../appearance'
import type {
  DirectionInput,
  PersonalDirectionService,
  StageGoalInput
} from '../application/personal-direction/personal-direction-service'
import type {
  UpdateDirectionPatch,
  UpdateStageGoalPatch
} from '../database/repositories/personal-direction'
import type { CurrentStateDraft, ProposalKind } from '../../shared/contracts/personal-direction'
import { ApplicationError } from '../application/errors'
import { detectAgents } from '../integrations/ai-agents/detection-service'
import { applyAgentConfig, planAgentConfig } from '../integrations/ai-agents/config-service'
import type { AgentKind } from '../integrations/ai-agents/types'
import type { McpScope } from '../../shared/contracts/mcp'

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
  /** Application Service：Renderer 与 MCP 共用（记录写路径）。 */
  services: {
    records: RecordService
    clients: McpClientService
    workContexts: WorkContextService
    personalDirection: PersonalDirectionService
  }
  bridgeStatus: () => McpBridgeStatus
  /** 内置浏览器：网页在主进程绘制，IPC 只表达意图。 */
  browser: BrowserManager
  /** Chrome 书签导入：检测 / 预览 / 导入 / 读取本地书签树。 */
  bookmarks: BookmarkService
  /** Chrome Companion：查看本地 IPC 与 Native Host 的安装状态。 */
  chrome: ChromeService
  /** 当前业务数据目录（db + media），可能与 userData 不同。 */
  dataDir: string
  /** 数据目录选择/迁移；成功后需要重启。 */
  dataLocation: DataLocationService
}): void {
  const {
    db,
    devServerUrl,
    sync,
    services,
    bridgeStatus,
    browser,
    bookmarks,
    chrome,
    dataDir,
    dataLocation
  } = params

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
    dataDir,
    onboardingEligible: app.isPackaged || process.env.BREWPHASE_FORCE_ONBOARDING === 'yes'
  }))

  // 轻量菜单入口：把应用菜单（role + 快捷键都在其中）弹在窗口鼠标位置。
  // 菜单是主进程对象，Renderer 只发一个空请求，拿不到任何菜单结构。
  // 走原生 ipcMain.handle 而不是上面的 handle 助手——这里需要 event.sender
  // 定位宿主窗口，助手只透传 schema 解析后的参数。
  // Studio Home「继续工作」：最近活动的上下文（含资源标签，存在性已校验）。
  handle(IPC.workContextsStudio, () => services.workContexts.listForStudio(3))

  ipcMain.handle(IPC.appPopupMenu, async (event) => {
    assertTrustedSender(event, devServerUrl)
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
    Menu.getApplicationMenu()?.popup({ window })
  })

  // 外观切换：Renderer 在 `<html data-theme>` 落地之后报一次，主进程只负责
  // 窗口自己那一层——底色与 Windows 标题栏按钮。窗口在缩放时露出的颜色、
  // 以及最小化/最大化的原生按钮，都靠这一步跟着页面一起变深。
  // 同样走原生 ipcMain.handle：需要 event.sender 定位是哪个窗口。
  ipcMain.handle(IPC.appThemeAppearance, async (event, payload) => {
    assertTrustedSender(event, devServerUrl)
    const parsed = ipcRequestSchemas[IPC.appThemeAppearance].safeParse(payload)
    if (!parsed.success) {
      throw new Error(`invalid payload for ${IPC.appThemeAppearance}`)
    }
    const appearance: WindowAppearance = parsed.data
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) return null
    const chrome = WINDOW_CHROME[appearance]
    window.setBackgroundColor(chrome.background)
    // titleBarOverlay 只存在于 Windows；其余平台调它没有意义，也可能抛错。
    if (process.platform === 'win32') {
      window.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbol, height: 44 })
    }
    return null
  })

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

  handle(IPC.phaseRulesList, () => listPhaseRules(db.db))

  // MARK: - Records

  handle(IPC.recordsList, (input) => services.records.list(input as never))
  handle(IPC.recordGet, (input) => services.records.get((input as { id: string }).id))
  handle(IPC.recordCreate, (input) => services.records.createFromDraft(input as never))
  handle(IPC.recordUpdate, (input) => {
    const value = input as { id: string; draft: never }
    return services.records.updateFromDraft(value.id, value.draft)
  })
  handle(IPC.recordDelete, (input) => {
    services.records.delete((input as { id: string }).id)
    return null
  })
  handle(IPC.recordImportImage, () => importImageFromDialog())
  handle(IPC.recordResolveMetadata, (input) => {
    const value = input as { id: string; force: boolean }
    return resolveRecordMetadata(db.db, value.id, value.force)
  })
  handle(IPC.tagsList, () => services.records.listTags())
  handle(IPC.tagCreate, (input) => services.records.createTagFromRenderer((input as { name: string }).name))

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
  handle(IPC.canvasNodeAnnotate, (input) => {
    const value = input as { id: string; annotation: string }
    return setAnnotation(db.db, db.deviceId, value.id, value.annotation)
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

  // MARK: - AI 连接（MCP 客户端授权）

  handle(IPC.mcpClientsList, () => services.clients.list())
  handle(IPC.mcpClientCreate, (input) => services.clients.create(input as never))
  handle(IPC.mcpClientRevoke, (input) => services.clients.revoke((input as { id: string }).id))
  handle(IPC.mcpBridgeStatus, () => bridgeStatus())

  // MARK: - AI Agent 自动配置
  //
  // 目标路径由这里的 bridgeStatus 解析，Renderer 只能传 Agent 类型与 scope。
  // 用户确认之前不会创建 Client；写入失败必须撤销刚建的 Client，否则会留下
  // 一个永远不会被使用的授权。

  handle(IPC.agentsDetect, () => {
    const status = bridgeStatus()
    const target =
      status.mcpEntryPath && status.userDataDir
        ? { entryPath: status.mcpEntryPath, userDataDir: status.userDataDir }
        : null
    return detectAgents(target)
  })

  handle(IPC.agentsPlan, (input) => {
    const status = bridgeStatus()
    if (!status.running) {
      throw new ApplicationError('VALIDATION_ERROR', 'MCP bridge is not running')
    }
    return planAgentConfig((input as { kind: AgentKind }).kind, {
      entryPath: status.mcpEntryPath,
      userDataDir: status.userDataDir
    })
  })

  handle(IPC.agentsApply, (input) => {
    const value = input as {
      kind: AgentKind
      name: string
      scopes: McpScope[]
      replaceExisting: boolean
    }
    const status = bridgeStatus()
    if (!status.running) {
      throw new ApplicationError('VALIDATION_ERROR', 'MCP bridge is not running')
    }

    const target = { entryPath: status.mcpEntryPath, userDataDir: status.userDataDir }
    const plan = planAgentConfig(value.kind, target)
    if (plan.conflict && !value.replaceExisting) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'an existing brewphase entry requires explicit replacement'
      )
    }

    const client = services.clients.create({ name: value.name, scopes: value.scopes })
    try {
      const result = applyAgentConfig(value.kind, target, client.token)
      if (!result.ok) {
        // 配置没写成功：撤销刚创建的客户端，不留无用授权。
        services.clients.revoke(client.id)
        return {
          ok: false as const,
          kind: value.kind,
          configPath: result.configPath,
          backupPath: result.backupPath,
          rollbackFailed: result.error?.includes('rollback failed') ?? false
        }
      }
      return {
        ok: true as const,
        kind: value.kind,
        clientId: client.id,
        clientName: client.name,
        configPath: result.configPath,
        backupPath: result.backupPath,
        requiresRestart: result.requiresRestart
      }
    } catch (error) {
      services.clients.revoke(client.id)
      throw error
    }
  })

  // MARK: - 内置浏览器 · Chrome 书签

  // 入参只有 Profile 目录名，且已由正则白名单校验；文件位置由主进程自己解析，
  // 渲染层无法指定任意路径。检测与预览都不写库，只有用户点「导入」才落盘。
  handle(IPC.browserChromeDetect, () => bookmarks.detect())
  handle(IPC.browserBookmarksPreview, (input) =>
    bookmarks.preview((input as { profileId: string }).profileId)
  )
  handle(IPC.browserBookmarksImport, (input) =>
    bookmarks.import((input as { profileId: string }).profileId)
  )
  handle(IPC.browserBookmarksTree, () => bookmarks.tree())
  handle(IPC.browserShowStart, () => browser.showStart())
  handle(IPC.browserShowCurrent, () => browser.showCurrentPage())

  // MARK: - Chrome Companion
  //
  // 只暴露管理动作：网页内容的写入通道是 Native Messaging → 本地 socket，
  // Renderer 拿不到、也不需要「代扩展写记录」的能力。
  handle(IPC.chromeStatus, () => chrome.status())
  handle(IPC.chromeInstall, () => chrome.install())
  handle(IPC.chromeUninstall, () => chrome.uninstall())
  handle(IPC.chromeSelfTest, () => chrome.selfTest())

  // MARK: - 数据目录
  //
  // 迁移会关闭数据库与本地服务，成功后必须重启；这里留一点时间让渲染层
  // 先画出「正在重启」。E2E 用 BREWPHASE_NO_AUTO_RELAUNCH 阻止自动退出。
  const scheduleRelaunch = (delayMs: number): void => {
    if (process.env.BREWPHASE_NO_AUTO_RELAUNCH === '1') return
    setTimeout(() => dataLocation.relaunch(), delayMs)
  }
  handle(IPC.dataLocationStatus, () => dataLocation.status())
  handle(IPC.dataLocationChoose, async () => {
    const result = await dataLocation.choose()
    if (result.ok) scheduleRelaunch(900)
    return result
  })
  handle(IPC.dataLocationReset, async () => {
    const result = await dataLocation.reset()
    if (result.ok) scheduleRelaunch(900)
    return result
  })
  handle(IPC.dataLocationRelaunch, () => {
    scheduleRelaunch(120)
    return null
  })

  // MARK: - Personal Direction
  //
  // 这一组是**唯一**能把草稿变成正式资料的路径，而它只挂在 IPC 上。
  // MCP 侧没有对应工具，所以「AI 不能自己把提议转正」不靠自觉，靠通道不存在。

  handle(IPC.directionOverview, () => services.personalDirection.overview())

  handle(IPC.directionSaveCurrentState, (input) =>
    services.personalDirection.saveCurrentState(input as CurrentStateDraft)
  )

  handle(IPC.directionConfirmCurrentState, (input) =>
    services.personalDirection.confirmCurrentState((input as { id: string }).id)
  )

  handle(IPC.directionCreateDirection, (input) =>
    services.personalDirection.createDirection(input as DirectionInput)
  )

  handle(IPC.directionUpdateDirection, (input) => {
    const value = input as { id: string; expectedUpdatedAt: number; patch: UpdateDirectionPatch }
    return services.personalDirection.updateDirection(value.id, value.expectedUpdatedAt, value.patch)
  })

  handle(IPC.directionDeleteDirection, (input) => {
    services.personalDirection.deleteDirection((input as { id: string }).id)
    return null
  })

  handle(IPC.directionCreateStage, (input) =>
    services.personalDirection.createStage(input as StageGoalInput)
  )

  handle(IPC.directionUpdateStage, (input) => {
    const value = input as { id: string; expectedUpdatedAt: number; patch: UpdateStageGoalPatch }
    return services.personalDirection.updateStage(value.id, value.expectedUpdatedAt, value.patch)
  })

  handle(IPC.directionDeleteStage, (input) => {
    services.personalDirection.deleteStage((input as { id: string }).id)
    return null
  })

  // 确认与丢弃：同一入口分派。Agent 拿不到这两个动作里的任何一个。
  handle(IPC.directionResolveProposal, (input) => {
    const value = input as { kind: ProposalKind; id: string; action: 'confirm' | 'discard' }
    if (value.action === 'discard') {
      services.personalDirection.discardDraft(value.kind, value.id)
      return null
    }
    if (value.kind === 'currentState') {
      return services.personalDirection.confirmCurrentState(value.id)
    }
    if (value.kind === 'direction') {
      return services.personalDirection.confirmDirection(value.id)
    }
    return services.personalDirection.confirmStage(value.id)
  })

  // MARK: - 内置浏览器

  // 这些 handler 只做「转交」：真实状态由 BrowserManager 持有，所有返回值都是
  // 同一份快照。参数已经过 zod，`openExternal` 的地址还会再过一次协议白名单。
  handle(IPC.browserState, () => browser.state())
  handle(IPC.browserOpen, (input) => browser.open(input as { url?: string } | undefined))
  handle(IPC.browserHide, () => browser.hide())
  handle(IPC.browserClose, () => browser.close())
  handle(IPC.browserNavigate, (input) => browser.navigate((input as { input: string }).input))
  handle(IPC.browserBack, () => browser.back())
  handle(IPC.browserForward, () => browser.forward())
  handle(IPC.browserReload, () => browser.reload())
  handle(IPC.browserStop, () => browser.stop())
  handle(IPC.browserSetBounds, (input) => {
    browser.setBounds(input as { x: number; y: number; width: number; height: number })
    return null
  })
  handle(IPC.browserOpenExternal, (input) => {
    browser.openExternal((input as { url?: string } | undefined)?.url)
    return null
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
