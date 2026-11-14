import type { BrowserWindow } from 'electron'
import type { RoundtablePanelLayout } from '../../shared/roundtable'

/**
 * 圆桌原生视图托管（Phase 4.2 workspace）。
 *
 * **身份铁律**：面板就是用户拖进来的那张 WebCard——按 tabId 从
 * BrowserTabManager 取**原始 WebContentsView**，只做「换父容器 + setBounds +
 * setVisible + z-order」，绝不创建视图、绝不 reload、绝不复制页面。
 *
 * 与 BrowserManager 的分工：页面生命周期（创建 / 销毁 / Session）权威在
 * BrowserManager；这里只负责「圆桌宿主窗口内的摆放」。宿主是主窗口
 * （工作空间 overlay 打开时）或独立圆桌窗口（detached）——拆出 / 归位 =
 * 同一批 view 换一次父容器。
 *
 * 原生视图永远在 DOM 之上：面板标题栏 / 拖拽手柄都在渲染层 DOM 里、
 * **在 view bounds 之外**（content rect 由渲染层逐面板上报），不存在
 * 「用 z-index 盖住网页」的方案。
 */

export type PanelRect = { tabId: string; x: number; y: number; width: number; height: number }

/** 原生视图的存活信息（E2E 的 expectRoundtableViewsAlive 用）。 */
export type RoundtableViewInfo = {
  tabId: string
  hostWindowId: number | null
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  destroyed: boolean
  /** 按当前 z 顺序排列（数组顺序 = 层级从低到高）。 */
  order: number
}

export type RoundtableViewManagerParams = {
  /** 按 tabId 取原始视图（BrowserTabManager 视角；销毁返回 null）。 */
  getView: (tabId: string) => Electron.WebContentsView | null
  /** 当前宿主窗口：detached → 独立圆桌窗口；否则主窗口。null = 无宿主。 */
  resolveHostWindow: () => BrowserWindow | null
  /** 布局（z 顺序与成员集合来源）。 */
  layout: () => { panels: RoundtablePanelLayout[]; snapEnabled: boolean }
  /**
   * 成员首次被圆桌接管时的协作钩子：让出浏览器面板激活位、从浮窗账本
   * 摘除、移动到宿主窗口。由装配层接 BrowserManager.hostTabInRoundtable。
   */
  hostTab: (tabId: string, hostWindowId: number) => boolean
  /** 成员离开圆桌：归还卡片架（park），不销毁。 */
  releaseTab: (tabId: string) => void
}

export class RoundtableViewManager {
  /** 当前托管的成员（tabId → 宿主窗口 id）。 */
  private hosted = new Map<string, number>()
  /** 最近一次各宿主窗口上报的 rects（窗口相对坐标）。 */
  private rects = new Map<string, PanelRect>()
  /** 工作空间是否应当可见（overlay 打开或 detached）。 */
  private visible = false

  constructor(private readonly params: RoundtableViewManagerParams) {}

  // MARK: - 托管 / 释放

  /**
   * 确保成员被**当前**宿主窗口持有：换父容器（复用原始 view）、隐藏等首次
   * rects 上报后再显示——避免在错误位置闪现。宿主变化（拆出 / 归位 /
   * 主窗口重建）时自动重托管。
   */
  hostMember(tabId: string): void {
    const host = this.params.resolveHostWindow()
    if (!host || host.isDestroyed()) return
    if (this.hosted.get(tabId) === host.id) return
    if (!this.params.hostTab(tabId, host.id)) return
    const view = this.params.getView(tabId)
    if (!view) return
    this.hosted.set(tabId, host.id)
    // 换宿主后先隐藏：渲染层 rects 到位前不显示（避免闪现在旧坐标）。
    view.setVisible(false)
    this.refreshZOrder()
  }

  /** 成员离开圆桌：归还原始页面（park 回卡片架），清理托管账本。 */
  releaseMember(tabId: string): void {
    if (!this.hosted.delete(tabId)) return
    this.rects.delete(tabId)
    this.params.releaseTab(tabId)
  }

  /** 成员对账：新成员 host、离场成员 release（join/leave/syncTabs 后调用）。 */
  syncMembers(memberTabIds: readonly string[]): void {
    const alive = new Set(memberTabIds)
    for (const tabId of memberTabIds) this.hostMember(tabId)
    for (const tabId of [...this.hosted.keys()]) {
      if (!alive.has(tabId)) this.releaseMember(tabId)
    }
  }

  // MARK: - 可见性与几何

  /** 工作空间可见性（overlay 打开 / detached 窗口存在）。 */
  setWorkspaceVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.applyVisibility()
  }

  isWorkspaceVisible(): boolean {
    return this.visible
  }

  /** 全部托管视图按可见性收敛（隐藏 = 保父容器与 rect，只为再次打开时秒回）。 */
  private applyVisibility(): void {
    for (const tabId of this.hosted.keys()) {
      const view = this.params.getView(tabId)
      if (!view) continue
      view.setVisible(this.visible)
    }
  }

  /**
   * 渲染层上报的面板内容区 rects（宿主窗口相对坐标）。只有宿主窗口的
   * 工作空间处于挂载状态，其渲染层才会发送——宿主窗口在主进程解析
   * （resolveHostWindow），非宿主的迟到上报直接忽略。未托管 / 宿主漂移
   * 的成员在这里自愈——**这就是原生视图跟随布局的唯一路径**。
   */
  applyRects(rects: PanelRect[]): void {
    const host = this.params.resolveHostWindow()
    if (!host || host.isDestroyed()) return
    const windowId = host.id
    // 只收当前成员的 rects：迟到/过期的上报（面板刚被移除）绝不能把
    // 已经归还的 view 重新托管回来。
    const memberIds = new Set(this.params.layout().panels.map((panel) => panel.tabId))
    for (const rect of rects) {
      if (!memberIds.has(rect.tabId)) continue
      // 宿主漂移自愈：托管账本指向旧宿主（拆出 / 主窗口重建）时，
      // 按当前宿主重新托管——绝不因账本过期而永远忽略 rects。
      if (this.hosted.get(rect.tabId) !== windowId) {
        this.hostMember(rect.tabId)
      }
      const hostWindowId = this.hosted.get(rect.tabId)
      if (hostWindowId !== windowId) continue
      const view = this.params.getView(rect.tabId)
      if (!view) continue
      this.rects.set(rect.tabId, rect)
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      view.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width, height })
      if (this.visible) view.setVisible(true)
    }
  }

  /** 拆出 / 归位：同一批 view 迁移到新宿主窗口（不创建、不销毁）。 */
  retargetHost(): void {
    for (const tabId of [...this.hosted.keys()]) this.hostMember(tabId)
  }

  /** z 变化 / 宿主切换后：按布局 z 序重建原生子视图顺序（后加 = 更上层）。 */
  refreshZOrder(): void {
    const host = this.params.resolveHostWindow()
    if (!host || host.isDestroyed()) return
    const panels = [...this.params.layout().panels].sort((a, b) => a.z - b.z)
    for (const panel of panels) {
      const view = this.params.getView(panel.tabId)
      if (!view || this.hosted.get(panel.tabId) !== host.id) continue
      try {
        host.contentView.removeChildView(view)
        host.contentView.addChildView(view)
      } catch {
        // 宿主正在销毁：下一次几何同步会再收敛。
      }
    }
  }

  /** 标签被关闭：清理托管账本（view 销毁由 TabManager 负责）。 */
  handleTabClosed(tabId: string): void {
    this.hosted.delete(tabId)
    this.rects.delete(tabId)
  }

  /** 全部隐藏（工作空间关闭 / 模块切走 / 归位前过渡）。 */
  hideAll(): void {
    for (const tabId of this.hosted.keys()) {
      this.params.getView(tabId)?.setVisible(false)
    }
  }

  // MARK: - 观测（E2E：expectRoundtableViewsAlive）

  infos(): RoundtableViewInfo[] {
    const panels = [...this.params.layout().panels].sort((a, b) => a.z - b.z)
    const order = new Map(panels.map((panel, index) => [panel.tabId, index]))
    const out: RoundtableViewInfo[] = []
    for (const [tabId, hostWindowId] of this.hosted.entries()) {
      const view = this.params.getView(tabId)
      out.push({
        tabId,
        hostWindowId,
        visible: view?.getVisible() ?? false,
        bounds: view?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
        destroyed: view === null,
        order: order.get(tabId) ?? -1
      })
    }
    return out
  }
}
