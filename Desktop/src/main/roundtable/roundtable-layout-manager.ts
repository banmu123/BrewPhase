import {
  clampPanelIntoWorkspace,
  defaultPanelLayout,
  findFreePanelSpot,
  ROUNDTABLE_ID,
  resolveMoveWithoutOverlap,
  resolveResizeWithoutOverlap,
  type ResizeAnchor,
  type RoundtableLayoutSnapshot,
  type RoundtablePanelLayout,
  type WorkspaceSize
} from '../../shared/roundtable'
import {
  deleteRoundtablePanel,
  selectRoundtablePanels,
  upsertRoundtablePanel
} from '../database/repositories/roundtable-panels'
import { readState, writeState, type Db } from '../database/client'

/**
 * 圆桌自由布局的**唯一状态持有者**（主进程，Phase 4.2 workspace）。
 *
 * 职责边界：只管布局数据（位置 / 尺寸 / 层级 / 吸附开关），**绝不碰
 * WebContents**——原生视图的挂载与 bounds 由 RoundtableViewManager 负责，
 * 页面生命周期权威仍在 BrowserManager。
 *
 * 持久化策略：内存即时更新 + 广播；SQLite **防抖 300ms** 合并写——
 * 拖动过程中的每一帧都只改内存，绝不逐帧写库；拖动 / 缩放结束后的
 * 最终状态由防抖兜底落库（flushPersist 供关键节点立即落盘）。
 *
 * 坐标是工作区局部坐标；窗口尺寸变化时 adaptLayoutsOnWorkspaceResize
 * 适配后广播并持久化。
 */

const PERSIST_DEBOUNCE_MS = 300

/** local_state 键：吸附开关与工作区尺寸（轻量元数据，不建表）。 */
const KEY_SNAP = 'roundtable.snapEnabled'
const KEY_WORKSPACE = 'roundtable.workspaceSize'

export type RoundtableLayoutManagerParams = {
  db: Db
  /** 布局变化广播（主窗口 + 圆桌独立窗口）。 */
  broadcast: (snapshot: RoundtableLayoutSnapshot) => void
  /** 面板对应的网页地址（持久化用；重启后幽灵面板重开）。 */
  getTabUrl?: (tabId: string) => string | null
  /** 测试可注入时钟。 */
  now?: () => number
}

export class RoundtableLayoutManager {
  private panels = new Map<string, RoundtablePanelLayout>()
  private workspace: WorkspaceSize = { width: 0, height: 0 }
  private activeTabId: string | null = null
  private snapEnabled = true
  private version = 0
  private persistTimer: NodeJS.Timeout | null = null

  constructor(private readonly params: RoundtableLayoutManagerParams) {
    this.restore()
  }

  // MARK: - 恢复

  private restore(): void {
    try {
      const rows = selectRoundtablePanels(this.params.db, ROUNDTABLE_ID)
      for (const row of rows) {
        this.panels.set(row.tabId, {
          tabId: row.tabId,
          url: row.url,
          x: row.x,
          y: row.y,
          width: row.width,
          height: row.height,
          z: row.zIndex
        })
      }
      this.snapEnabled = readState(this.params.db, KEY_SNAP) !== '0'
      const rawWorkspace = readState(this.params.db, KEY_WORKSPACE)
      if (rawWorkspace) {
        try {
          const parsed = JSON.parse(rawWorkspace) as WorkspaceSize
          if (Number.isFinite(parsed?.width) && Number.isFinite(parsed?.height)) {
            this.workspace = { width: parsed.width, height: parsed.height }
          }
        } catch {
          // 损坏的元数据不影响布局行本身。
        }
      }
    } catch (error) {
      // 布局读不出来就当空白桌：用户重新摆，绝不为布局丢数据退出。
      console.error('[roundtable-layout] restore failed', error)
      this.panels.clear()
    }
  }

  // MARK: - 查询

  snapshot(): RoundtableLayoutSnapshot {
    return {
      roundtableId: ROUNDTABLE_ID,
      panels: [...this.panels.values()].sort((a, b) => a.z - b.z || a.tabId.localeCompare(b.tabId)),
      activeTabId: this.activeTabId,
      snapEnabled: this.snapEnabled,
      workspace: { ...this.workspace },
      updatedAt: this.params.now?.() ?? Date.now(),
      version: this.version
    }
  }

  panelOf(tabId: string): RoundtablePanelLayout | null {
    return this.panels.get(tabId) ?? null
  }

  // MARK: - 成员对账（join / leave / 关闭网页）

  /**
   * 成员变化时对账：新成员找**不与任何面板重叠**的空位（级联种子 →
   * 网格扫描 → 最小尺寸再扫）；离开的成员清布局（持久化行同步删除）。
   * **不覆盖已有布局**——重新加入的老成员回到它上次的位置。
   */
  syncMembers(memberTabIds: readonly string[]): RoundtableLayoutSnapshot {
    const alive = new Set(memberTabIds)
    let changed = false
    for (const tabId of memberTabIds) {
      if (!this.panels.has(tabId)) {
        const index = this.panels.size
        const url = this.params.getTabUrl?.(tabId) ?? ''
        const workspace = this.workspaceOrFallback()
        const seed = clampPanelIntoWorkspace(defaultPanelLayout(tabId, index, workspace, url), workspace)
        const others = this.othersOf(tabId)
        // 默认尺寸放不下 → 退到最小尺寸再扫；仍找不到（工作区真的挤满）
        // 才退回种子位（该情形实际上达不到，落日志留痕）。
        const minSize = clampPanelIntoWorkspace(
          { ...seed, x: 0, y: 0, width: 0, height: 0 },
          workspace
        )
        const spot =
          findFreePanelSpot({ x: seed.x, y: seed.y }, { width: seed.width, height: seed.height }, others, workspace) ??
          findFreePanelSpot(
            { x: seed.x, y: seed.y },
            { width: Math.max(minSize.width, 1), height: Math.max(minSize.height, 1) },
            others,
            workspace
          )
        if (!spot) {
          console.error('[roundtable-layout] no free spot for new member, fallback to seed', tabId)
        }
        const panel: RoundtablePanelLayout = {
          ...seed,
          ...(spot ? { x: spot.x, y: spot.y } : {}),
          z: this.nextZ()
        }
        this.panels.set(tabId, panel)
        this.persistPanel(panel)
        changed = true
      }
    }
    for (const tabId of [...this.panels.keys()]) {
      if (!alive.has(tabId)) {
        this.panels.delete(tabId)
        try {
          deleteRoundtablePanel(this.params.db, ROUNDTABLE_ID, tabId)
        } catch (error) {
          console.error('[roundtable-layout] delete failed', tabId, error)
        }
        changed = true
      }
    }
    if (this.activeTabId !== null && !alive.has(this.activeTabId)) {
      this.activeTabId = null
      changed = true
    }
    if (changed) this.commit()
    return this.snapshot()
  }

  // MARK: - 布局操作（渲染层意图）

  /**
   * 产品规则（用户补充）：自由布局，但**面板互不重叠**。所有布局写入
   * 都经过防重叠解析——推不出去（被围死）就保持原位，绝不落一个会
   * 压到别的面板的位置。
   */

  /** 拖动：更新位置（吸附由渲染层算好传入；主进程只 clamp + 防重叠 + 落库）。 */
  movePanel(tabId: string, x: number, y: number): RoundtableLayoutSnapshot {
    const panel = this.panels.get(tabId)
    if (!panel) return this.snapshot()
    const next = this.resolvePlacement(tabId, { ...panel, x: Math.round(x), y: Math.round(y) })
    if (!next || (next.x === panel.x && next.y === panel.y)) return this.snapshot()
    this.panels.set(tabId, next)
    this.persistPanel(next)
    this.commit()
    return this.snapshot()
  }

  /** 拖动期间的轻量路径：只改内存 + 广播，持久化走防抖。 */
  movePanelLive(tabId: string, x: number, y: number): RoundtableLayoutSnapshot {
    const panel = this.panels.get(tabId)
    if (!panel) return this.snapshot()
    const next = this.resolvePlacement(tabId, { ...panel, x: Math.round(x), y: Math.round(y) })
    if (!next || (next.x === panel.x && next.y === panel.y)) return this.snapshot()
    this.panels.set(tabId, next)
    this.schedulePersistPanel(tabId)
    this.commit()
    return this.snapshot()
  }

  resizePanel(
    tabId: string,
    x: number,
    y: number,
    width: number,
    height: number,
    anchor: ResizeAnchor = 'se'
  ): RoundtableLayoutSnapshot {
    const panel = this.panels.get(tabId)
    if (!panel) return this.snapshot()
    const clamped = clampPanelIntoWorkspace(
      { ...panel, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
      this.workspaceOrFallback()
    )
    const resolved = resolveResizeWithoutOverlap(
      { x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height },
      anchor,
      this.othersOf(tabId)
    )
    // 被邻居挡死 / 与最小尺寸冲突：保持原 rect（缩放不生效，不产生重叠）。
    if (!resolved) return this.snapshot()
    const next: RoundtablePanelLayout = { ...panel, ...resolved }
    this.panels.set(tabId, next)
    this.persistPanel(next)
    this.commit()
    return this.snapshot()
  }

  /** clamp 进工作区 → 防重叠解析；推不出去返回 null（保持原位）。 */
  private resolvePlacement(tabId: string, candidate: RoundtablePanelLayout): RoundtablePanelLayout | null {
    const clamped = clampPanelIntoWorkspace(candidate, this.workspaceOrFallback())
    const spot = resolveMoveWithoutOverlap(
      { x: clamped.x, y: clamped.y },
      { width: clamped.width, height: clamped.height },
      this.othersOf(tabId),
      this.workspaceOrFallback()
    )
    if (!spot) return null
    return { ...clamped, x: spot.x, y: spot.y }
  }

  private othersOf(tabId: string): RoundtablePanelLayout[] {
    return [...this.panels.values()].filter((panel) => panel.tabId !== tabId)
  }

  /** 点击面板置顶：z = max + 1；已是顶层时不动（避免无谓版本推进）。 */
  bringToFront(tabId: string): RoundtableLayoutSnapshot {
    const panel = this.panels.get(tabId)
    if (!panel) return this.snapshot()
    const maxZ = Math.max(0, ...[...this.panels.values()].map((item) => item.z))
    if (panel.z === maxZ) {
      if (this.activeTabId !== tabId) {
        this.activeTabId = tabId
        this.commit()
      }
      return this.snapshot()
    }
    const next = { ...panel, z: maxZ + 1 }
    this.panels.set(tabId, next)
    this.persistPanel(next)
    this.activeTabId = tabId
    this.commit()
    return this.snapshot()
  }

  setSnapEnabled(enabled: boolean): RoundtableLayoutSnapshot {
    if (this.snapEnabled === enabled) return this.snapshot()
    this.snapEnabled = enabled
    writeState(this.params.db, KEY_SNAP, enabled ? '1' : '0')
    this.commit()
    return this.snapshot()
  }

  /**
   * 工作区尺寸上报：只更新 clamp 参照系（当前宿主的工作区），**不改写
   * 任何面板的存储位置**——拆出 / 归位往返不会降级布局；宿主变小时由
   * 渲染层按 clamp 显示，宿主变回时原位置原样恢复。
   */
  setWorkspaceSize(size: WorkspaceSize): RoundtableLayoutSnapshot {
    const width = Math.max(0, Math.round(size.width))
    const height = Math.max(0, Math.round(size.height))
    if (this.workspace.width === width && this.workspace.height === height) return this.snapshot()
    this.workspace = { width, height }
    writeState(this.params.db, KEY_WORKSPACE, JSON.stringify(this.workspace))
    this.commit()
    return this.snapshot()
  }

  /** 页面加载完成：回填面板 URL（join 时导航可能尚未完成）。 */
  updateUrl(tabId: string, url: string): void {
    const panel = this.panels.get(tabId)
    if (!panel || !url || panel.url === url) return
    const next = { ...panel, url }
    this.panels.set(tabId, next)
    this.persistPanel(next)
  }

  /** 立即落盘（拖动结束等关键节点调用；平时由防抖兜底）。 */
  flushPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    for (const panel of this.panels.values()) this.persistPanelNow(panel)
  }

  /**
   * 幽灵面板重开（Phase 4.2 workspace）：应用重启后 WebContents 必然消失，
   * 布局行还在。用户「重新打开网页」创建新标签后，把布局**原几何**绑定到
   * 新 tabId（清旧行、写新行），面板位置 / 尺寸 / 层级一步不差。
   */
  rebindPanel(oldTabId: string, newTabId: string): RoundtableLayoutSnapshot {
    const panel = this.panels.get(oldTabId)
    if (!panel || oldTabId === newTabId) return this.snapshot()
    this.panels.delete(oldTabId)
    const next: RoundtablePanelLayout = {
      ...panel,
      tabId: newTabId,
      url: this.params.getTabUrl?.(newTabId) ?? panel.url
    }
    this.panels.set(newTabId, next)
    try {
      deleteRoundtablePanel(this.params.db, ROUNDTABLE_ID, oldTabId)
    } catch (error) {
      console.error('[roundtable-layout] rebind delete failed', oldTabId, error)
    }
    this.persistPanelNow(next)
    if (this.activeTabId === oldTabId) this.activeTabId = newTabId
    this.commit()
    return this.snapshot()
  }

  /** 标签被关闭：清掉对应布局（内存 + 持久化行），不影响其他成员。 */
  handleTabClosed(tabId: string): void {
    if (!this.panels.has(tabId)) return
    this.panels.delete(tabId)
    try {
      deleteRoundtablePanel(this.params.db, ROUNDTABLE_ID, tabId)
    } catch (error) {
      console.error('[roundtable-layout] delete on close failed', tabId, error)
    }
    if (this.activeTabId === tabId) this.activeTabId = null
    this.commit()
  }

  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
  }

  // MARK: - 内部

  private workspaceOrFallback(): WorkspaceSize {
    if (this.workspace.width > 0 && this.workspace.height > 0) return this.workspace
    // 首次（还没有尺寸上报）：给一个保守可用的工作区，bounds 上报后会被适配。
    return { width: 960, height: 600 }
  }

  private nextZ(): number {
    return Math.max(0, ...[...this.panels.values()].map((item) => item.z)) + 1
  }

  private commit(): void {
    this.version += 1
    this.params.broadcast(this.snapshot())
  }

  private persistPanel(panel: RoundtablePanelLayout): void {
    this.schedulePersistPanel(panel.tabId)
  }

  private schedulePersistPanel(tabId: string): void {
    void tabId
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      for (const panel of this.panels.values()) this.persistPanelNow(panel)
    }, PERSIST_DEBOUNCE_MS)
  }

  private persistPanelNow(panel: RoundtablePanelLayout): void {
    try {
      upsertRoundtablePanel(this.params.db, {
        roundtableId: ROUNDTABLE_ID,
        tabId: panel.tabId,
        url: panel.url,
        x: panel.x,
        y: panel.y,
        width: panel.width,
        height: panel.height,
        zIndex: panel.z,
        updatedAt: this.params.now?.() ?? Date.now()
      })
    } catch (error) {
      console.error('[roundtable-layout] persist failed', panel.tabId, error)
    }
  }
}
