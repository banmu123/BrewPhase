import type { CSSProperties } from 'react'
import type { RecordItem } from '@shared/contracts'
import { isSafeRemoteImage, recordDisplayTitle } from '../records/preview/preview-model'

/**
 * Records Deck 的布局模型：纯数据与纯函数，CSS 只消费变量。
 *
 * 叠放靠**固定姿态数组**而不是随机值——每次渲染、每次进首页，
 * 同一条记录永远在同一张位置上（§渲染顺序稳定）。数组覆盖
 * `DECK_LIMIT` 张；记录更少时取前 N 条，叠放关系天然成立。
 */

/** 首页一叠最多几张：收藏卡的「一叠」，不是完整列表。 */
export const DECK_LIMIT = 5

/** 一张卡的姿态：位移（px）与旋转（deg）。 */
export type DeckPose = { x: number; y: number; r: number }

/**
 * 紧凑叠放：后方卡片从右下探出（每张 22×16px，旋转不到 2 度），
 * 既能看见纸边，也能看见下一张的一角内容。
 */
export const DECK_REST: DeckPose[] = [
  { x: 0, y: 0, r: -1.4 },
  { x: 22, y: 16, r: 1.1 },
  { x: 44, y: 32, r: -0.9 },
  { x: 64, y: 48, r: 1.6 },
  { x: 84, y: 64, r: -1.2 }
]

/** Hover 展开：每张向自己的方向挪开，彼此都能看清内容。 */
export const DECK_SPREAD: DeckPose[] = [
  { x: -30, y: -16, r: -3.2 },
  { x: 4, y: -26, r: 2.4 },
  { x: 42, y: -14, r: -1.7 },
  { x: 80, y: 6, r: 2.9 },
  { x: 116, y: 30, r: -2.2 }
]

function poseStyle(pose: DeckPose, index: number): CSSProperties {
  return {
    '--deck-x': `${pose.x}px`,
    '--deck-y': `${pose.y}px`,
    '--deck-r': `${pose.r}deg`,
    '--deck-i': index
  } as CSSProperties
}

/** 一张卡的两个姿态（紧凑 / 展开），供组件合并成内联样式。 */
export function deckCardStyle(index: number): CSSProperties {
  const rest = DECK_REST[index % DECK_REST.length]
  const spread = DECK_SPREAD[index % DECK_SPREAD.length]
  return {
    ...poseStyle(rest, index),
    '--deck-x-spread': `${spread.x}px`,
    '--deck-y-spread': `${spread.y}px`,
    '--deck-r-spread': `${spread.r}deg`
  } as CSSProperties
}

/**
 * 文字卡正文：note 优先、summary 补空——两条都是记录里的真实内容，
 * 不伪造、不给所有卡片同一段占位文本。换行压成空格，裁到卡面长度。
 */
export function deckTextBody(item: RecordItem, max = 140): string {
  const body = (item.note.trim() || item.summary.trim()).replace(/\s*\n+\s*/g, ' ')
  return body.length > max ? `${body.slice(0, max)}…` : body
}

/** 链接域名：canonicalURL 优先、原始地址补空；解析不了就空（不硬凑）。 */
export function deckLinkHost(item: RecordItem): string {
  for (const raw of [item.canonicalURL, item.urlString]) {
    const text = (raw ?? '').trim()
    if (!text) continue
    try {
      const url = new URL(text)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.hostname.replace(/^www\./, '')
      }
    } catch {
      // 不是合法地址就试下一条来源。
    }
  }
  return ''
}

/** 来源行：人写的来源/作者优先，域名补空——provider 是内部字段不上界面。 */
export function deckSource(item: RecordItem): string {
  return item.sourceName || item.authorName || deckLinkHost(item)
}

/**
 * 一张 Deck 卡的展示输入：全部来自记录本身（§不虚构数据）。
 * `image` 已经过安全校验 / 已转成 bpmedia:// 地址，可直接进 `src`。
 */
export type DeckCard = {
  item: RecordItem
  index: number
  title: string
  source: string
  image: string | null
  body: string | null
}

/** 记录 → Deck 卡视图：本地媒体走 mediaUrl（注入，便于纯逻辑测试），远程缩略图只放行 https。 */
export function deckCard(item: RecordItem, index: number, mediaUrl: (name: string) => string): DeckCard {
  const local = item.previewPath ?? item.mediaPath
  const remote = isSafeRemoteImage(item.thumbnailURLString)
  return {
    item,
    index,
    title: recordDisplayTitle(item),
    source: deckSource(item),
    image: local ? mediaUrl(local) : remote,
    body: item.carrier === 'text' ? deckTextBody(item) : null
  }
}
