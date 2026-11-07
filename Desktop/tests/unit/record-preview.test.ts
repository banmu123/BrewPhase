import { describe, expect, it } from 'vitest'
import type { RecordItem } from '@shared/contracts'
import { detectPlatform } from '../../src/renderer/src/features/records/preview/platform'
import { buildPreview, formatCount, isSafeRemoteImage } from '../../src/renderer/src/features/records/preview/preview-model'

/** 与 contracts/recordSchema 同形的工厂（测试只关注平台预览相关字段）。 */
function record(overrides: Partial<RecordItem> = {}): RecordItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    carrier: 'link',
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
    createdAt: 1_782_000_000_000,
    updatedAt: 1_782_000_000_000,
    tagIds: [],
    ...overrides
  }
}

describe('平台识别（hostname 精确匹配，拒绝字符串包含）', () => {
  it('provider 是权威来源：generic 才走 URL 现认', () => {
    const item = record({ provider: 'youtube', urlString: 'https://notyoutube.com/watch' })
    expect(detectPlatform(item).platform).toBe('youtube')
  })

  it('裸域与子域命中，相似域名不误配', () => {
    const ok = record({ urlString: 'https://www.github.com/banmu123/BrewPhase' })
    expect(detectPlatform(ok).platform).toBe('github')
    const sub = record({ urlString: 'https://gist.github.com/x/1' })
    expect(detectPlatform(sub).platform).toBe('github')
    const evil = record({ urlString: 'https://notgithub.com/banmu123/BrewPhase' })
    expect(detectPlatform(evil).platform).toBe('web')
  })

  it('短链与多平台域：youtu.be / b23.tv / twitter.com', () => {
    expect(detectPlatform(record({ urlString: 'https://youtu.be/dQw4w9WgXcQ' })).platform).toBe('youtube')
    expect(detectPlatform(record({ urlString: 'https://b23.tv/BV1xx411c7mD' })).platform).toBe('bilibili')
    expect(detectPlatform(record({ urlString: 'https://twitter.com/user/status/1' })).platform).toBe('x')
  })

  it('非 http(s) 协议与坏 URL 不误认，退回 web', () => {
    expect(detectPlatform(record({ urlString: 'javascript:alert(1)' })).platform).toBe('web')
    expect(detectPlatform(record({ urlString: 'not a url' })).platform).toBe('web')
  })

  it('网页角标是去 www 的域名；无地址退「网页」', () => {
    expect(detectPlatform(record({ urlString: 'https://blog.example.com/post/1' })).label).toBe('blog.example.com')
    expect(detectPlatform(record({ carrier: 'link', urlString: '' })).label).toBe('网页')
  })
})

describe('isSafeRemoteImage：只放 https，防 data:/file:/http 注入', () => {
  it('https 放行，其余拒绝', () => {
    expect(isSafeRemoteImage('https://img.example.com/a.jpg')).toBeTruthy()
    expect(isSafeRemoteImage('http://img.example.com/a.jpg')).toBeNull()
    expect(isSafeRemoteImage('data:image/png;base64,AAAA')).toBeNull()
    expect(isSafeRemoteImage('file:///etc/passwd.jpg')).toBeNull()
    expect(isSafeRemoteImage('javascript:alert(1)')).toBeNull()
    expect(isSafeRemoteImage(null)).toBeNull()
  })
})

describe('buildPreview：平台卡片视图归一', () => {
  const mediaUrl = (name: string) => `bpmedia://media/${name}`

  it('GitHub：platformContentID 拆仓库、og 图优先、无图走仓库信息卡', () => {
    const item = record({
      provider: 'github',
      platformContentID: 'banmu123/BrewPhase',
      title: 'banmu123/BrewPhase: Personal coffee studio',
      repositoryStars: 12,
      repositoryForks: 3,
      repositoryLanguage: 'Swift'
    })
    const preview = buildPreview(item, mediaUrl)
    expect(preview.platform.platform).toBe('github')
    expect(preview.repositoryName).toBe('banmu123/BrewPhase')
    expect(preview.title).toBe('Personal coffee studio')
    expect(preview.kind).toBe('repo-card')
    expect(preview.stars).toBe(12)
    expect(preview.remoteImage).toBeNull()

    const withImage = buildPreview(record({ ...item, thumbnailURLString: 'https://opengraph.githubassets.com/1' }), mediaUrl)
    expect(withImage.kind).toBe('remote-image')
  })

  it('YouTube：无 og 图时用官方缩略图构造；坏地址不采用', () => {
    const item = record({ provider: 'youtube', platformContentID: 'dQw4w9WgXcQ' })
    const preview = buildPreview(item, mediaUrl)
    expect(preview.kind).toBe('remote-image')
    expect(preview.remoteImage).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
    expect(preview.playable).toBe(true)
    const bad = buildPreview(record({ ...item, thumbnailURLString: 'http://insecure/p.jpg' }), mediaUrl)
    expect(bad.remoteImage).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  })

  it('Bilibili：没有可靠缩略图就落平台卡，不伪造', () => {
    const preview = buildPreview(record({ provider: 'bilibili', platformContentID: 'BV1xx411c7mD' }), mediaUrl)
    expect(preview.platform.platform).toBe('bilibili')
    expect(preview.kind).toBe('platform-card')
    expect(preview.remoteImage).toBeNull()
    expect(preview.playable).toBe(true)
  })

  it('X：正文以 summary 承载，作者行取 authorName；无媒体时文本是主角', () => {
    const preview = buildPreview(
      record({ provider: 'x', authorName: '@banmu', summary: '刚烘焙完一壶耶加。', title: '' }),
      mediaUrl
    )
    expect(preview.kind).toBe('text')
    expect(preview.body).toBe('刚烘焙完一壶耶加。')
    expect(preview.author).toBe('@banmu')
    const withMedia = buildPreview(record({ provider: 'x', summary: '带图', thumbnailURLString: 'https://pbs.twimg.com/1.jpg' }), mediaUrl)
    expect(withMedia.kind).toBe('remote-image')
  })

  it('本地图片/视频走 bpmedia，视频带播放语义；文字以 note 为主体', () => {
    const image = buildPreview(record({ carrier: 'image', mediaPath: 'a.jpg', previewPath: 'a_thumb.jpg' }), mediaUrl)
    expect(image.kind).toBe('local-media')
    expect(image.localMedia).toBe('a_thumb.jpg')
    expect(image.playable).toBe(false)
    const video = buildPreview(record({ carrier: 'video', mediaPath: 'b.mov', previewPath: 'b_thumb.jpg' }), mediaUrl)
    expect(video.playable).toBe(true)
    const text = buildPreview(record({ carrier: 'text', note: '一段随记' }), mediaUrl)
    expect(text.kind).toBe('text')
    expect(text.body).toBe('一段随记')
  })

  it('网页：og 图优先；无图时平台 fallback，域名进 meta', () => {
    const preview = buildPreview(record({ urlString: 'https://blog.example.com/post/1' }), mediaUrl)
    expect(preview.kind).toBe('platform-card')
    expect(preview.meta).toBe('blog.example.com')
  })
})

describe('formatCount：与 iOS Fmt.starCount 同量级，不伪造精度', () => {
  it('千以下原样，千/百万缩写', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1_200)).toBe('1.2k')
    expect(formatCount(12_300)).toBe('12.3k')
    expect(formatCount(123_400)).toBe('123.4k')
    expect(formatCount(1_234_567)).toBe('1.2m')
  })
})
