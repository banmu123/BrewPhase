import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { dialog } from 'electron'
import type { Db } from '../../database/client'
import {
  deleteBinding,
  deleteWorkspace,
  insertWorkspace,
  selectBinding,
  selectWorkspace,
  selectWorkspaceByPathCI,
  selectWorkspaces,
  updateWorkspaceName,
  upsertBinding
} from '../../database/repositories/local-workspaces'
import {
  LOCAL_WORKSPACE_MAX,
  LOCAL_WORKSPACE_NAME_MAX,
  type CardWorkspaceBinding,
  type LocalWorkspace,
  type LocalWorkspaceAvailability
} from '../../../shared/contracts/local-workspace'
import { ApplicationError } from '../errors'
import { resolveWorkspaceRoot } from './workspace-file-service'
import type { ApplicationEvents } from '../events/application-events'

/**
 * LocalWorkspaceService：本地项目文件夹的授权登记（AI Card Workspace Bridge Phase 1）。
 *
 * 职责边界：
 * - 「授权」只是**登记**：添加 / 改名 / 删除登记、检查目录可用性。删除登记
 *   绝不触碰真实文件夹；登记也绝不把文件系统访问权交给渲染层。
 * - 卡片绑定（tabId → workspaceId）：每张 WebCard 独立绑定，多卡可绑同一
 *   工作区；tab 关闭时由装配层调 `clearBinding` 清理。
 * - 与 Roundtable Workspace 是两个概念：这里是本地项目文件夹（LocalWorkspace），
 *   那是圆桌自由布局画布——命名刻意区分。
 *
 * 数据只进本地库（migration 12），不进 change_log / iOS 同步。
 */

export class LocalWorkspaceError extends ApplicationError {
  constructor(
    code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'PERMISSION_DENIED',
    message: string
  ) {
    super(code, message)
    this.name = 'LocalWorkspaceError'
  }
}

export type LocalWorkspaceAddResult =
  | { ok: true; workspace: LocalWorkspace }
  | { ok: false; canceled: true }
  | { ok: false; error: string }

export class LocalWorkspaceService {
  constructor(
    private readonly db: Db,
    private readonly events: ApplicationEvents
  ) {}

  // MARK: - 工作区登记（CRUD）

  list(): LocalWorkspace[] {
    return selectWorkspaces(this.db).map((row) => this.toDto(row))
  }

  get(id: string): LocalWorkspace | null {
    const row = selectWorkspace(this.db, id)
    return row ? this.toDto(row) : null
  }

  /**
   * 弹系统目录选择对话框登记一个本地项目文件夹。
   * E2E / 测试用 `BREWPHASE_WORKSPACE_DIR_CHOICE` 预置路径，不弹窗。
   */
  async addFromDialog(): Promise<LocalWorkspaceAddResult> {
    const preset = process.env.BREWPHASE_WORKSPACE_DIR_CHOICE
    let target = preset
    if (!target) {
      const result = await dialog.showOpenDialog({
        title: '选择本地项目文件夹',
        buttonLabel: '添加工作区',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
      target = result.filePaths[0]
    }
    try {
      return { ok: true, workspace: this.add(target, basename(target)) }
    } catch (error) {
      const message = error instanceof ApplicationError ? error.message : '无法添加这个文件夹'
      return { ok: false, error: message }
    }
  }

  /**
   * 登记一个已存在的文件夹。路径先 realpath 规范化（解析 symlink、
   * 统一分隔符），同一规范化路径（大小写不敏感）不允许重复登记。
   */
  add(absolutePath: string, name?: string): LocalWorkspace {
    if (selectWorkspaces(this.db).length >= LOCAL_WORKSPACE_MAX) {
      throw new LocalWorkspaceError('VALIDATION_ERROR', `最多登记 ${LOCAL_WORKSPACE_MAX} 个工作区`)
    }
    let real: string
    try {
      real = realpathSync(absolutePath)
    } catch {
      throw new LocalWorkspaceError('VALIDATION_ERROR', '文件夹不存在或无法访问')
    }
    const stat = statSync(real)
    if (!stat.isDirectory()) {
      throw new LocalWorkspaceError('VALIDATION_ERROR', '请选择文件夹而不是文件')
    }
    const existing = selectWorkspaceByPathCI(this.db, real)
    if (existing) {
      throw new LocalWorkspaceError('VALIDATION_ERROR', `这个文件夹已登记为「${existing.name}」`)
    }
    const trimmed = (name ?? basename(real)).trim().slice(0, LOCAL_WORKSPACE_NAME_MAX)
    const inserted = insertWorkspace(this.db, {
      id: randomUUID(),
      name: trimmed || basename(real),
      absolutePath: real,
      platform: process.platform,
      now: Date.now()
    })
    if (!inserted) {
      throw new LocalWorkspaceError('VALIDATION_ERROR', '这个文件夹已登记')
    }
    this.events.emit('localWorkspaces')
    return this.toDto(inserted)
  }

  rename(id: string, name: string): LocalWorkspace {
    const trimmed = name.trim().slice(0, LOCAL_WORKSPACE_NAME_MAX)
    if (!trimmed) throw new LocalWorkspaceError('VALIDATION_ERROR', '名称不能为空')
    const updated = updateWorkspaceName(this.db, id, trimmed, Date.now())
    if (!updated) throw new LocalWorkspaceError('NOT_FOUND', `workspace ${id} does not exist`)
    this.events.emit('localWorkspaces')
    return this.toDto(updated)
  }

  /** 只删除授权登记；真实文件夹不动。悬空绑定留给卡片显示「绑定失效」。 */
  remove(id: string): void {
    if (!deleteWorkspace(this.db, id)) {
      throw new LocalWorkspaceError('NOT_FOUND', `workspace ${id} does not exist`)
    }
    this.events.emit('localWorkspaces')
  }

  /** 供文件服务与 UI 校验：lstat 不跟随叶子链接——目录被换成 junction 直接判失效。 */
  resolveRoot(workspaceId: string): string {
    const row = selectWorkspace(this.db, workspaceId)
    if (!row) throw new LocalWorkspaceError('NOT_FOUND', `workspace ${workspaceId} does not exist`)
    return resolveWorkspaceRoot(row.absolutePath, row.name)
  }

  // MARK: - 卡片绑定（tabId → workspaceId）

  binding(tabId: string): CardWorkspaceBinding {
    const row = selectBinding(this.db, tabId)
    if (!row) return { tabId, workspace: null, missing: false }
    const workspace = this.get(row.workspaceId)
    if (!workspace) return { tabId, workspace: null, missing: true }
    return { tabId, workspace, missing: false }
  }

  /** 换绑 / 解绑（workspaceId=null）。绑定不存在的工作区被拒绝。 */
  setBinding(tabId: string, workspaceId: string | null): CardWorkspaceBinding {
    if (workspaceId !== null && !selectWorkspace(this.db, workspaceId)) {
      throw new LocalWorkspaceError('NOT_FOUND', `workspace ${workspaceId} does not exist`)
    }
    upsertBinding(this.db, { tabId, workspaceId, now: Date.now() })
    this.events.emit('localWorkspaces')
    return this.binding(tabId)
  }

  /** 标签销毁后清理绑定（规格 §5.8）；装配层在 onTabClosed 里调用。 */
  clearBinding(tabId: string): void {
    if (deleteBinding(this.db, tabId)) this.events.emit('localWorkspaces')
  }

  // MARK: - 内部

  private toDto(row: {
    id: string
    name: string
    absolutePath: string
    platform: string
    createdAt: number
    updatedAt: number
  }): LocalWorkspace {
    const availability: LocalWorkspaceAvailability = this.isDirectoryAvailable(row.absolutePath)
      ? 'available'
      : 'missing'
    return { ...row, availability }
  }

  private isDirectoryAvailable(absolutePath: string): boolean {
    try {
      return lstatSync(absolutePath).isDirectory()
    } catch {
      return false
    }
  }
}
