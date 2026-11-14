/**
 * AI 圆桌的共享模型（Phase 3：主进程为唯一事实来源）。
 *
 * Phase 2 之前圆桌状态住在渲染层 Zustand 里；Phase 3 起主窗口与圆桌独立
 * 窗口是**两个 Renderer**，不能再各持一份。主进程的 RoundtableService
 * 持有唯一的 `RoundtableSnapshot`，两个窗口都通过 IPC 订阅这份快照。
 *
 * 参与者仍然是真实网页的 `tabId`（Phase 2 的铁律不变）：
 * 主进程在 join 时校验标签存在，网页关闭时自动摘除失效参与者。
 *
 * 并发保护：`version` 单调递增。草稿写入必须带 `baseVersion`，主进程
 * 发现版本过期就拒绝——任何一个 Renderer 都不能静默覆盖另一个窗口的
 * 新状态（规格 §4.4）。
 */

export type RoundtableSnapshot = {
  id: string
  /** 参与的真实标签 ID，按加入/排序后的顺序。 */
  participantTabIds: string[]
  /** 统一提问草稿：停靠 ↔ 独立窗口切换也不丢。 */
  draft: string
  /** 圆桌是否正在独立 BrowserWindow 里运行。 */
  detached: boolean
  /** 最后一次变更时间（epoch ms）。 */
  updatedAt: number
  /** 单调递增版本号：每次真实变更 +1。 */
  version: number
}

/** 只有一张圆桌；id 稳定，独立窗口路由用它寻址。 */
export const ROUNDTABLE_ID = 'roundtable-main'

/**
 * 圆桌快照广播通道。与 `browser:changed` 同一模式：preload 是 sandboxed 的，
 * 不能 import 主进程模块，通道名只能放共享层。
 */
export const ROUNDTABLE_CHANGED_CHANNEL = 'roundtable:changed'

export function initialRoundtableSnapshot(): RoundtableSnapshot {
  return {
    id: ROUNDTABLE_ID,
    participantTabIds: [],
    draft: '',
    detached: false,
    updatedAt: 0,
    version: 0
  }
}

/** 草稿的长度上限：与 IPC 校验、输入框 maxLength 三处一致。 */
export const ROUNDTABLE_DRAFT_MAX = 2_000

/* ============================================================
 * 纯操作函数：输入快照，输出新快照（无变化时返回同一引用）。
 * 主进程的 RoundtableService 负责校验 + 版本号 + 广播。
 * ============================================================ */

/** 拖入圆桌：幂等建立参与关系（同一张卡只能出现一次）。 */
export function addParticipant(snapshot: RoundtableSnapshot, tabId: string): RoundtableSnapshot | null {
  if (!tabId || snapshot.participantTabIds.includes(tabId)) return null
  return {
    ...snapshot,
    participantTabIds: [...snapshot.participantTabIds, tabId]
  }
}

/** 从圆桌移除参与者：只解除关系，网页不关闭。 */
export function removeParticipant(snapshot: RoundtableSnapshot, tabId: string): RoundtableSnapshot | null {
  if (!snapshot.participantTabIds.includes(tabId)) return null
  return {
    ...snapshot,
    participantTabIds: snapshot.participantTabIds.filter((id) => id !== tabId)
  }
}

/** 只保留仍然存在的标签（关闭网页后清理参与者）。 */
export function retainParticipants(snapshot: RoundtableSnapshot, liveTabIds: readonly string[]): RoundtableSnapshot | null {
  const alive = new Set(liveTabIds)
  const next = snapshot.participantTabIds.filter((id) => alive.has(id))
  if (next.length === snapshot.participantTabIds.length) return null
  return { ...snapshot, participantTabIds: next }
}

/** 参与者在圆桌内排序（语义与卡片架一致：插到目标前面）。 */
export function reorderParticipants(snapshot: RoundtableSnapshot, tabId: string, overId: string): RoundtableSnapshot | null {
  const ids = snapshot.participantTabIds
  if (tabId === overId) return null
  const from = ids.indexOf(tabId)
  const to = ids.indexOf(overId)
  if (from < 0 || to < 0) return null
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  next.splice(from < to ? to - 1 : to, 0, moved)
  if (next.every((id, at) => id === ids[at])) return null
  return { ...snapshot, participantTabIds: next }
}

/** 草稿更新（主进程校验 baseVersion 后调用）。 */
export function writeDraft(snapshot: RoundtableSnapshot, draft: string): RoundtableSnapshot | null {
  const value = draft.slice(0, ROUNDTABLE_DRAFT_MAX)
  if (value === snapshot.draft) return null
  return { ...snapshot, draft: value }
}

/** 拆出 / 归位：只翻转 detached；参与者与草稿原样保留。 */
export function setDetached(snapshot: RoundtableSnapshot, detached: boolean): RoundtableSnapshot | null {
  if (snapshot.detached === detached) return null
  return { ...snapshot, detached }
}

/* ============================================================
 * 独立窗口的默认几何：真正的尺寸决定在主进程窗口管理器里，
 * 这里只保留共享的最小值，供窗口构造与 E2E 断言使用。
 * ============================================================ */

export const ROUNDTABLE_WINDOW_MIN_WIDTH = 460
export const ROUNDTABLE_WINDOW_MIN_HEIGHT = 340
