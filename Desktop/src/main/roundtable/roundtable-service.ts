import {
  ROUNDTABLE_DRAFT_MAX,
  ROUNDTABLE_ID,
  addParticipant,
  initialRoundtableSnapshot,
  removeParticipant,
  reorderParticipants,
  retainParticipants,
  setDetached,
  writeDraft,
  type RoundtableSnapshot
} from '../../shared/roundtable'
import type { BrowserDragSessionManager, DragPoint } from '../browser/browser-drag'

/**
 * AI 圆桌的**唯一状态持有者**（主进程）。
 *
 * 主窗口与圆桌独立窗口是两个 Renderer，各自的 Zustand 不能再互为真相。
 * 所有读写都走这里：join/leave/reorder/setDraft/detach/dock，每次真实变更
 * `version` +1、`updatedAt` 刷新，然后广播整份快照——两个窗口永远看到
 * 同一份状态。
 *
 * 写入护栏：
 * - `join` 校验 tabId 是活着的真实标签（不创建隐藏网页来模拟参与者）；
 * - `setDraft` 带 `baseVersion`，过期写入被拒绝（返回最新快照，绝不静默覆盖）；
 * - 网页关闭时由装配层调 `syncTabs`，失效参与者自动摘除。
 *
 * Electron 窗口操作通过构造参数注入（createWindow/closeWindow/focusWindow）：
 * 本类保持可注入、可单测，不直接 import BrowserWindow。
 */

export type RoundtableServiceParams = {
  /** 校验 tabId 是否是活着的真实标签（BrowserTabManager 视角）。 */
  isTabAlive: (tabId: string) => boolean
  /** 快照变化广播（主窗口 + 圆桌窗口）。 */
  broadcast: (snapshot: RoundtableSnapshot) => void
  /** 拆出独立窗口（贴近松手点）。 */
  createWindow: (near?: DragPoint) => void
  /** 归位：关闭独立窗口（保留全部状态）。 */
  closeWindow: () => void
  /** 聚焦已存在的独立窗口；返回是否真的存在。 */
  focusWindow: () => boolean
  /**
   * 共享拖拽会话（与网页卡片同一个「单鼠标」会话，装配层注入）。
   * 缺省时拖拽意图退化为 no-op——单元测试不依赖 Electron。
   */
  drag?: BrowserDragSessionManager
  /**
   * 参与成员发生变化（Phase 4.2）：移出成员的自动化任务必须立刻终止。
   * 装配层把 removed 交给 ParticipantService.cancelParticipant；
   * added 目前无人消费（识别是拉取式的），留作后续推送入口。
   */
  onParticipantsChanged?: (change: { added: string[]; removed: string[] }) => void
  /** 测试可注入时钟；缺省 Date.now。 */
  now?: () => number
}

export class RoundtableService {
  private state: RoundtableSnapshot = initialRoundtableSnapshot()

  constructor(private readonly params: RoundtableServiceParams) {}

  snapshot(): RoundtableSnapshot {
    return this.state
  }

  /** 卡片拖入圆桌：校验标签真实存在；幂等。 */
  join(tabId: string): RoundtableSnapshot {
    if (!this.params.isTabAlive(tabId)) return this.state
    return this.commit(addParticipant(this.state, tabId))
  }

  /** 从圆桌移除参与者：只解除关系，网页不关闭。 */
  leave(tabId: string): RoundtableSnapshot {
    return this.commit(removeParticipant(this.state, tabId))
  }

  /** 参与者在圆桌内排序。 */
  reorder(tabId: string, overId: string): RoundtableSnapshot {
    return this.commit(reorderParticipants(this.state, tabId, overId))
  }

  /**
   * 草稿写入：后写者胜出（last-writer-wins），每次写入推进版本并广播。
   *
   * 为什么不做 baseVersion 门控：两个键击之间隔着一次 IPC 往返，按版本
   * 门控会让快速打字必然被拒绝、丢字符。草稿是共享文本框，采用与结构
   * 状态（参与者/拆出）不同的并发模型——后写者胜出，两个窗口始终看到
   * 同一份最终值；「静默覆盖」的防护留在结构性写入上。
   */
  setDraft(draft: string): RoundtableSnapshot {
    return this.commit(writeDraft(this.state, draft.slice(0, ROUNDTABLE_DRAFT_MAX)))
  }

  /** 拆出独立窗口。已拆出时聚焦现有窗口，绝不重复创建（规格 §4.8）。 */
  detach(near?: DragPoint): RoundtableSnapshot {
    if (this.state.detached) {
      this.params.focusWindow()
      return this.state
    }
    // 先翻状态再建窗口：新窗口加载后第一次拉状态就能看到 detached=true，
    // 主窗口的占位区也立刻出现——不存在「窗口已开、两边都还显示停靠位」的空档。
    this.commit(setDetached(this.state, true))
    this.params.createWindow(near)
    return this.state
  }

  /** 归位：关独立窗口，参与者与草稿原样保留。 */
  dock(): RoundtableSnapshot {
    if (!this.state.detached) return this.state
    const next = this.commit(setDetached(this.state, false))
    this.params.closeWindow()
    return next
  }

  /** 聚焦独立窗口（主窗口占位区的「重新打开」）。 */
  focus(): RoundtableSnapshot {
    if (this.state.detached) this.params.focusWindow()
    return this.state
  }

  // MARK: - 拖拽会话（标题栏拖出 / 拖回，与卡片共用同一个会话）

  /** 圆桌标题栏开始拖动（HTML5 dragstart）。已有会话在跑时拒绝。 */
  beginDrag(): boolean {
    return this.params.drag ? this.params.drag.begin('roundtable', null) : false
  }

  /** 拖回主窗口停靠位的 drop 被接受：会话按内部投放收尾。 */
  markDragDropHandled(): void {
    this.params.drag?.markDropHandled()
  }

  /** 拖动终态：窗口外松手由会话回调装配层拆窗，其余取消。 */
  endDrag(fallback?: DragPoint): void {
    this.params.drag?.end(fallback)
  }

  /** 会话被打断（窗口销毁等）：强制收尾。 */
  cancelDrag(): void {
    this.params.drag?.cancel()
  }

  /** 浏览器标签变化时对账：关闭的网页自动摘出圆桌。 */
  syncTabs(liveTabIds: readonly string[]): RoundtableSnapshot {
    return this.commit(retainParticipants(this.state, liveTabIds))
  }

  /** tabId 是否是当前圆桌成员（圆桌问答的成员校验唯一入口）。 */
  hasParticipant(tabId: string): boolean {
    return this.state.participantTabIds.includes(tabId)
  }

  /** 重置为初始状态（仅测试用）。 */
  resetForTesting(): void {
    this.state = initialRoundtableSnapshot()
  }

  /** 真实变更才提交：版本 +1、时间刷新、广播。 */
  private commit(next: RoundtableSnapshot | null): RoundtableSnapshot {
    if (!next) return this.state
    const before = new Set(this.state.participantTabIds)
    const after = new Set(next.participantTabIds)
    const added = next.participantTabIds.filter((id) => !before.has(id))
    const removed = this.state.participantTabIds.filter((id) => !after.has(id))
    this.state = {
      ...next,
      id: ROUNDTABLE_ID,
      version: this.state.version + 1,
      updatedAt: this.params.now?.() ?? Date.now()
    }
    if (added.length > 0 || removed.length > 0) {
      try {
        this.params.onParticipantsChanged?.({ added, removed })
      } catch (error) {
        // 回调失败不能影响成员状态本身。
        console.error('[roundtable] onParticipantsChanged failed', error)
      }
    }
    this.params.broadcast(this.state)
    return this.state
  }
}
