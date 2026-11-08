import { describe, expect, it } from 'vitest'
import { EMBED_FRAME_ORIGINS, embedURL, isEmbedFrameURL } from '../../src/shared/link-embed'

/**
 * 播放地址只由内容 ID 拼出，所以这里的重点是**拒绝**：
 * 任何不合平台格式的字符串都必须得到 null，绝不能带着它去拼 URL。
 */
describe('embedURL', () => {
  it('YouTube：11 位 ID 拼出官方 embed 地址', () => {
    expect(embedURL('youtube', 'dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1'
    )
    expect(embedURL('youtube', '_-aB3dE7fGh')).toBe(
      'https://www.youtube.com/embed/_-aB3dE7fGh?rel=0&playsinline=1'
    )
  })

  it('YouTube：长度不对或含非法字符时不构造地址', () => {
    expect(embedURL('youtube', 'dQw4w9WgXc')).toBeNull() // 10 位
    expect(embedURL('youtube', 'dQw4w9WgXcQQ')).toBeNull() // 12 位
    expect(embedURL('youtube', 'dQw4w9WgXc?')).toBeNull()
    expect(embedURL('youtube', '../../etc/passwd')).toBeNull()
    expect(embedURL('youtube', 'dQw4w9WgXcQ&autoplay=1')).toBeNull()
    expect(embedURL('youtube', '')).toBeNull()
    expect(embedURL('youtube', null)).toBeNull()
  })

  it('Bilibili：BV 号与 av 号分别走 bvid / aid', () => {
    expect(embedURL('bilibili', 'BV1xx411c7mD')).toBe(
      'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&page=1&high_quality=1&danmaku=0'
    )
    expect(embedURL('bilibili', 'av170001')).toBe(
      'https://player.bilibili.com/player.html?aid=170001&page=1&high_quality=1&danmaku=0'
    )
  })

  it('Bilibili：只有 BV/av 能播，专栏与异常串都不行', () => {
    expect(embedURL('bilibili', 'cv123456')).toBeNull()
    expect(embedURL('bilibili', 'BV1xx411c7m')).toBeNull() // 少一位
    expect(embedURL('bilibili', 'av')).toBeNull()
    expect(embedURL('bilibili', 'av1234567890123')).toBeNull() // 超过 12 位
    expect(embedURL('bilibili', 'BV1xx411c7mD&autoplay=1')).toBeNull()
  })

  it('其它平台不内嵌', () => {
    expect(embedURL('x', '123')).toBeNull()
    expect(embedURL('github', 'banmu123/BrewPhase')).toBeNull()
    expect(embedURL('generic', 'anything')).toBeNull()
  })
})

describe('isEmbedFrameURL', () => {
  it('只放行白名单里的播放器域名（含子域）', () => {
    expect(isEmbedFrameURL('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(true)
    expect(isEmbedFrameURL('https://youtube.com/embed/dQw4w9WgXcQ')).toBe(true)
    expect(isEmbedFrameURL('https://player.bilibili.com/player.html?bvid=BV1xx411c7mD')).toBe(true)
  })

  it('相似域名、非 https、脚本协议一律拒绝', () => {
    expect(isEmbedFrameURL('https://notyoutube.com/embed/x')).toBe(false)
    expect(isEmbedFrameURL('https://youtube.com.evil.test/')).toBe(false)
    expect(isEmbedFrameURL('http://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(false)
    expect(isEmbedFrameURL('javascript:alert(1)')).toBe(false)
    expect(isEmbedFrameURL('file:///etc/passwd')).toBe(false)
    expect(isEmbedFrameURL('https://evil.test/')).toBe(false)
  })

  it('白名单里的每一项都能构造出合法 origin', () => {
    for (const origin of EMBED_FRAME_ORIGINS) {
      expect(new URL(origin).protocol).toBe('https:')
    }
  })
})
