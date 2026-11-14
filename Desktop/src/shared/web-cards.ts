import type { BrowserTabInfo } from './contracts/browser'

/**
 * 网页卡片的**派生模型**（Phase 2）。
 *
 * 卡片不再是本地数据：一张卡就是 BrowserTabManager 里的一个真实标签。
 * 这里只做纯计算——把「标签快照 + 架子顺序」换算成卡片列表与展示状态，
 * 不持有状态、不碰 IPC。`tabId` 是唯一身份，顺序只是展示层偏好。
 */

/** 卡片的展示形态：收起在架上 / 在主窗口浮窗里打开 / 在独立窗口里。 */
export type WebCardPresentation = 'shelved' | 'expanded-in-main' | 'detached'

/** 一个标签在架子上的形态。`windowId` 只是展示位置，不参与身份判定。 */
export type WebCardModel = {
  tabId: string
  title: string
  url: string
  domain: string
  loading: boolean
  error: BrowserTabInfo['error']
  presentation: WebCardPresentation
  /** 在圆桌上（由 Roundtable 的参与者列表决定，调用方填）。 */
  inRoundtable: boolean
}

export function presentationOf(tab: Pick<BrowserTabInfo, 'detached' | 'active'>): WebCardPresentation {
  if (tab.detached) return 'detached'
  if (tab.active) return 'expanded-in-main'
  return 'shelved'
}

/**
 * 对账卡片顺序：保留仍然存在的标签（按旧顺序），新标签按主进程顺序追加。
 * 关闭的标签自动消失；`tabId` 永不被改写。
 */
export function reconcileCardOrder(order: readonly string[], tabIds: readonly string[]): string[] {
  const alive = new Set(tabIds)
  const seen = new Set<string>()
  const next: string[] = []
  for (const id of order) {
    if (!alive.has(id) || seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  for (const id of tabIds) {
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

/** 按架子顺序排列标签；顺序里没有的（理论上不会）追加在末尾。 */
export function sortTabsByOrder(tabs: readonly BrowserTabInfo[], order: readonly string[]): BrowserTabInfo[] {
  const index = new Map(order.map((id, at) => [id, at]))
  return [...tabs].sort((a, b) => {
    const ia = index.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const ib = index.get(b.id) ?? Number.MAX_SAFE_INTEGER
    if (ia !== ib) return ia - ib
    return a.id.localeCompare(b.id)
  })
}

/**
 * 架内移动：把 `id` 插到 `beforeId` 之前（null = 末尾）。
 * 先删除再插入；锚点不存在时保持原顺序，避免「拖丢了」。
 */
export function moveCardBefore(order: readonly string[], id: string, beforeId: string | null): string[] {
  if (!order.includes(id)) return [...order]
  if (beforeId === id) return [...order]
  const next = order.filter((item) => item !== id)
  if (beforeId === null) {
    next.push(id)
    return next
  }
  const at = next.indexOf(beforeId)
  if (at === -1) return [...order]
  next.splice(at, 0, id)
  return next
}

/** 把标签换算成卡片展示模型；`participants` 是圆桌当前的 tabId 列表。 */
export function toWebCardModels(
  tabs: readonly BrowserTabInfo[],
  order: readonly string[],
  participants: readonly string[]
): WebCardModel[] {
  const joined = new Set(participants)
  return sortTabsByOrder(tabs, order).map((tab) => ({
    tabId: tab.id,
    title: tab.title,
    url: tab.url,
    domain: domainOf(tab.url),
    loading: tab.loading,
    error: tab.error,
    presentation: presentationOf(tab),
    inRoundtable: joined.has(tab.id)
  }))
}

/** 从 URL 里取域名（不带协议），失败回退到原串。 */
export function domainOf(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 卡片站点的展示名：标题优先，其次域名，最后兜底。 */
export function cardDisplayName(tab: Pick<BrowserTabInfo, 'title' | 'url'>, fallback: string): string {
  const title = tab.title.trim()
  if (title) return title
  return domainOf(tab.url) || fallback
}

/** 卡片图标文字：域名/标题首字母；空地址用占位点。 */
export function cardBadgeText(tab: Pick<BrowserTabInfo, 'title' | 'url'>, unnamed: string): string {
  if (!tab.url) return '·'
  const first = cardDisplayName(tab, unnamed).trim().charAt(0)
  return first || '·'
}

/** 只有真正有地址的标签才能进圆桌（空白标签/起始页不算参与者）。 */
export function isCardJoinable(tab: Pick<BrowserTabInfo, 'url'>): boolean {
  return tab.url.trim() !== ''
}

/** 还没有地址的标签：卡片进入内联地址输入态。 */
export function isCardAwaitingAddress(tab: Pick<BrowserTabInfo, 'url'>): boolean {
  return tab.url.trim() === ''
}
