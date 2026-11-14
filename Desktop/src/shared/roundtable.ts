/**
 * 网页卡片架与 AI 圆桌（Roundtable Phase 1）的共享模型。
 *
 * 本阶段只有**本地 UI 状态**：网页卡片是测试数据（不连 WebContents），
 * 圆桌只管理参与者引用，不发起任何 AI 请求。真实浏览器与 AI 能力在后续
 * 阶段接入时，只替换数据来源，不改这里的操作语义。
 *
 * 三种操作的边界（规格 §5，测试也按这个写）：
 * - `addParticipant`：建立参与关系（卡片仍在架上）；
 * - `removeParticipant`：解除参与关系（卡片仍在架上）；
 * - `closeCard`：关闭卡片，同时把它从圆桌参与者里摘掉（关网页 ≠ 留讨论位）。
 */

/** 网页卡片：架上的一张卡。本阶段由本地状态模拟，不连真实网页。 */
export type WebCard = {
  /** 稳定 ID：圆桌参与者只引用它，不复制卡片内容。 */
  id: string
  /** 站点名，如 "ChatGPT"；空白卡为空串。 */
  title: string
  /** 完整地址；空白卡为空串。 */
  url: string
  /** 站点图标（本阶段用文字首字母，不抓真实 favicon）。 */
  favicon?: string
  status: 'empty' | 'ready' | 'loading' | 'error'
}

/** 圆桌参与者的引用（挂在圆桌上的 ID，按拖入顺序排列）。 */
export type Roundtable = {
  id: string
  /** 参与的网页卡片 ID 列表；同一张卡只能出现一次。 */
  participantIds: string[]
  /** 是否停靠在 Studio Home 底部。 */
  docked: boolean
  /** 浮动时的位置（窗口内容区 CSS px，左上角）。 */
  position: { x: number; y: number }
  /** 浮动时的尺寸（CSS px）。 */
  size: { width: number; height: number }
}

/** 生成稳定卡片 ID：调用方（store）注入前缀保证测试可控。 */
let cardSeq = 0
export function nextWebCardId(): string {
  cardSeq += 1
  return `webcard-${cardSeq}`
}

/** 测试用：把序号拨回起点，保证 `nextWebCardId()` 的输出可预测。 */
export function resetWebCardSeqForTesting(): void {
  cardSeq = 0
}

/** 初始圆桌：停靠、无参与者、浮动几何给合理默认值（首次拖出时用）。 */
export function initialRoundtable(): Roundtable {
  return {
    id: 'roundtable-main',
    participantIds: [],
    docked: true,
    position: { x: 96, y: 140 },
    size: { width: 560, height: 400 }
  }
}

/** 首次进入的默认卡片：一张空白卡（规格 §3：默认只有一张空白网页卡片）。 */
export function blankWebCard(id: string): WebCard {
  return { id, title: '', url: '', status: 'empty' }
}

/** 卡片是否可作为参与者拖入：空白卡（还没填地址）不算数。 */
export function isJoinableCard(card: WebCard): boolean {
  return card.status !== 'empty' && card.url !== ''
}

/** 从 URL 里取域名（不带协议），失败回退到原串。卡片展示用。 */
export function domainOf(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 卡片站点的展示名：没填名字时用域名兜底，再兜底到「未命名」。 */
export function cardDisplayName(card: WebCard, fallback: string): string {
  if (card.title.trim()) return card.title.trim()
  const domain = domainOf(card.url)
  return domain || fallback
}

/** 卡片图标文字：优先 favicon；空白卡用占位点，否则站名/域名首字母。 */
export function cardBadgeText(card: WebCard, unnamed: string): string {
  if (card.favicon) return card.favicon
  if (card.status === 'empty' && !card.url) return '·'
  const name = cardDisplayName(card, unnamed)
  const first = name.trim().charAt(0)
  return first || '·'
}

/* ============================================================
 * 纯操作函数：输入 (cards | roundtable)，输出新值；不持有状态。
 * ============================================================ */

/** 添加一张空白卡片（「+ 添加网页」）。 */
export function addBlankCard(cards: WebCard[], id: string): WebCard[] {
  return [...cards, blankWebCard(id)]
}

/** 关闭卡片：从架上移除，并解除它在圆桌上的参与关系。 */
export function closeCard(cards: WebCard[], roundtable: Roundtable, cardId: string): { cards: WebCard[]; roundtable: Roundtable } {
  return {
    cards: cards.filter((card) => card.id !== cardId),
    roundtable: removeParticipant(roundtable, cardId)
  }
}

/** 架内拖动排序：把 `cardId` 移到 `overId` 的位置（拖到谁身上就插到谁前面）。
 *
 * 先删后插时目标会前移一位：源在目标前面时要回退一格，否则「把 a 拖到
 * b 前」会被记录成「把 a 挪到 b 后」——位置没动，顺序却变了。
 */
export function reorderCards(cards: WebCard[], cardId: string, overId: string): WebCard[] {
  if (cardId === overId) return cards
  const from = cards.findIndex((card) => card.id === cardId)
  const to = cards.findIndex((card) => card.id === overId)
  if (from < 0 || to < 0) return cards
  const next = [...cards]
  const [moved] = next.splice(from, 1)
  next.splice(from < to ? to - 1 : to, 0, moved)
  return next
}

/** 拖入圆桌：建立参与关系（追加到末尾）；已在桌上的卡不变（幂等）。 */
export function addParticipant(roundtable: Roundtable, cardId: string): Roundtable {
  if (roundtable.participantIds.includes(cardId)) return roundtable
  return { ...roundtable, participantIds: [...roundtable.participantIds, cardId] }
}

/** 从圆桌移除参与者：只解除关系，卡片留在架上（规格 §5）。 */
export function removeParticipant(roundtable: Roundtable, cardId: string): Roundtable {
  return { ...roundtable, participantIds: roundtable.participantIds.filter((id) => id !== cardId) }
}

/** 参与者在圆桌内排序（与卡片架同语义：插到目标前面）。 */
export function reorderParticipants(roundtable: Roundtable, cardId: string, overId: string): Roundtable {
  return {
    ...roundtable,
    participantIds: reorderIds(roundtable.participantIds, cardId, overId)
  }
}

function reorderIds(ids: string[], id: string, overId: string): string[] {
  if (id === overId) return ids
  const from = ids.indexOf(id)
  const to = ids.indexOf(overId)
  if (from < 0 || to < 0) return ids
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  next.splice(from < to ? to - 1 : to, 0, moved)
  return next
}

/* ============================================================
 * 浮动几何：与 browser-layout 同一套约定（CSS px、先钳尺寸再钳位置），
 * 但常量独立——圆桌的最小尺寸比浏览器小得多。
 * ============================================================ */

export const ROUNDTABLE_MIN_WIDTH = 360
export const ROUNDTABLE_MIN_HEIGHT = 240
/** 顶栏高度：浮动圆桌的标题栏不能压住它。 */
export const ROUNDTABLE_TOP_INSET = 52

export type PanelViewport = { width: number; height: number }

/** 把浮动几何收进窗口：先钳尺寸，再钳位置（与 clampBrowserBounds 同序）。 */
export function clampRoundtable(
  position: { x: number; y: number },
  size: { width: number; height: number },
  viewport: PanelViewport
): { position: { x: number; y: number }; size: { width: number; height: number } } {
  const maxWidth = Math.max(ROUNDTABLE_MIN_WIDTH, Math.floor(viewport.width))
  const maxHeight = Math.max(ROUNDTABLE_MIN_HEIGHT, Math.floor(viewport.height))
  const width = Math.min(Math.max(Math.round(size.width), ROUNDTABLE_MIN_WIDTH), maxWidth)
  const height = Math.min(Math.max(Math.round(size.height), ROUNDTABLE_MIN_HEIGHT), maxHeight)
  const x = Math.min(Math.max(Math.round(position.x), 0), Math.max(0, Math.round(viewport.width) - width))
  const maxY = Math.max(0, Math.round(viewport.height) - height)
  const minY = Math.min(ROUNDTABLE_TOP_INSET, maxY)
  const y = Math.min(Math.max(Math.round(position.y), minY), maxY)
  return { position: { x, y }, size: { width, height } }
}

/** 拖出：停靠 → 浮动。位置先给默认值（调用方可再 clamp）。 */
export function undockRoundtable(roundtable: Roundtable): Roundtable {
  if (!roundtable.docked) return roundtable
  return { ...roundtable, docked: false }
}

/** 归位：浮动 → 停靠。参与者与几何都保留，几何留着下次拖出用。 */
export function dockRoundtable(roundtable: Roundtable): Roundtable {
  if (roundtable.docked) return roundtable
  return { ...roundtable, docked: true }
}
