import { describe, expect, it } from 'vitest'
import type { RecordItem } from '@shared/contracts'
import {
  deckCard,
  DECK_LIMIT,
  DECK_REST,
  DECK_SPREAD,
  deckCardStyle,
  deckLinkHost,
  deckTextBody
} from '../../src/renderer/src/features/studio/deck-model'

/**
 * Records Deck 布局模型：姿态数组、数量上限、文案与来源提取。
 * 这些纯函数决定首页那叠卡的视觉秩序——固定值、渲染稳定是硬约定。
 */

function record(overrides: Partial<RecordItem>): RecordItem {
  return {
    id: '11111111-1111-4111-8111-000000000001',
    carrier: 'text',
    title: '',
    note: '',
    urlString: '',
    canonicalURL: null,
    provider: 'generic',
    platformContentID: null,
    sourceName: '',
    authorName: '',
    summary: '',
    mediaPath: null,
    previewPath: null,
    thumbnailURLString: null,
    metadataStatus: 'idle',
    repositoryStars: null,
    repositoryForks: null,
    repositoryLanguage: null,
    metadata: null,
    createdAt: 0,
    updatedAt: 0,
    tagIds: [],
    ...overrides
  }
}

describe('Deck 姿态数组', () => {
  it('覆盖 DECK_LIMIT 张卡，展开姿态数量与之一致', () => {
    expect(DECK_REST.length).toBeGreaterThanOrEqual(DECK_LIMIT)
    expect(DECK_SPREAD.length).toBeGreaterThanOrEqual(DECK_LIMIT)
  })

  it('每张卡姿态各不相同（完全重叠的卡读不出叠放层次）', () => {
    const keys = DECK_REST.slice(0, DECK_LIMIT).map((p) => `${p.x},${p.y},${p.r}`)
    expect(new Set(keys).size).toBe(DECK_LIMIT)
    const spreadKeys = DECK_SPREAD.slice(0, DECK_LIMIT).map((p) => `${p.x},${p.y},${p.r}`)
    expect(new Set(spreadKeys).size).toBe(DECK_LIMIT)
  })

  it('旋转克制（±5deg 内），是随手摆上去不是哗啦散开', () => {
    for (const pose of [...DECK_REST, ...DECK_SPREAD]) {
      expect(Math.abs(pose.r)).toBeLessThanOrEqual(5)
    }
  })

  it('展开时后方卡片位移不小于紧凑时（展开比叠放更开）', () => {
    for (let i = 1; i < DECK_LIMIT; i++) {
      const restSpread = Math.hypot(DECK_REST[i].x - DECK_REST[0].x, DECK_REST[i].y - DECK_REST[0].y)
      const openSpread = Math.hypot(DECK_SPREAD[i].x - DECK_SPREAD[0].x, DECK_SPREAD[i].y - DECK_SPREAD[0].y)
      expect(openSpread).toBeGreaterThan(restSpread)
    }
  })

  it('deckCardStyle 是确定性输出：同一索引渲染永远同一姿态', () => {
    expect(deckCardStyle(0)).toEqual(deckCardStyle(0))
    expect(deckCardStyle(2)).toEqual(deckCardStyle(2))
    expect(deckCardStyle(0)).not.toEqual(deckCardStyle(2))
  })
})

describe('Deck 卡内容提取（只用记录里的真实数据）', () => {
  it('文字卡正文：note 优先、summary 补空，换行压平', () => {
    expect(deckTextBody(record({ note: '第一行\n第二行', summary: '摘要' }))).toBe('第一行 第二行')
    expect(deckTextBody(record({ note: '', summary: '只有摘要' }))).toBe('只有摘要')
  })

  it('文字卡正文超长被裁剪并带省略号', () => {
    const body = deckTextBody(record({ note: '长'.repeat(200) }), 20)
    expect(body.length).toBeLessThanOrEqual(21)
    expect(body.endsWith('…')).toBe(true)
  })

  it('链接域名来自 canonicalURL / urlString，拒绝非 http 协议', () => {
    expect(deckLinkHost(record({ urlString: 'https://www.example.com/a', canonicalURL: null }))).toBe('example.com')
    expect(deckLinkHost(record({ urlString: 'javascript:alert(1)', canonicalURL: null }))).toBe('')
    expect(
      deckLinkHost(record({ urlString: 'https://x.com/a', canonicalURL: 'https://blog.example.com/b' }))
    ).toBe('blog.example.com')
  })

  it('deckCard：图片卡走本地媒体地址，远程缩略图必须 https', () => {
    const mediaUrl = (name: string) => `bpmedia://media/${name}`
    const local = deckCard(record({ carrier: 'image', mediaPath: 'a.jpg', previewPath: 'a_thumb.jpg' }), 0, mediaUrl)
    expect(local.image).toContain('a_thumb.jpg')
    const remote = deckCard(record({ carrier: 'link', thumbnailURLString: 'https://cdn.example.com/og.png' }), 0, mediaUrl)
    expect(remote.image).toBe('https://cdn.example.com/og.png')
    const unsafe = deckCard(record({ carrier: 'link', thumbnailURLString: 'data:image/png;base64,xx' }), 0, mediaUrl)
    expect(unsafe.image).toBeNull()
  })

  it('deckCard：标题走 recordDisplayTitle 语义（用户标题优先），来源行不暴露 provider', () => {
    const card = deckCard(
      record({ carrier: 'link', title: '我的收藏', sourceName: 'GitHub', provider: 'generic' }),
      0,
      (name) => name
    )
    expect(card.title).toBe('我的收藏')
    expect(card.source).toBe('GitHub')
  })
})
