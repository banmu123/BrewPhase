import type { RecordItem } from '@shared/contracts'
import { detectPlatform, type PlatformView } from './platform'

/**
 * 平台预览视图模型：把记录库内**已有的**同步元数据（provider/thumbnail/
 * platformContentID/repository*）归一成各平台卡片要渲染的形状。
 *
 * 原则（§统一预览数据模型）：
 * - 原始记录是权威数据，这里只是**展示视图**，不回写、不缓存；
 * - 缺什么就缺什么——绝不伪造 stars/时长/作者/正文；
 * - 远程图一律过 `isSafeRemoteImage`（只放 https，防 data:/file: 注入）；
 *   加载失败由组件落到平台 fallback，不影响记录本身。
 */

export type RecordPreview = {
  platform: PlatformView
  title: string
  /** 卡片媒体区的渲染形态 */
  kind: 'remote-image' | 'local-media' | 'repo-card' | 'platform-card' | 'text'
  /** 已校验的 https 远程图（og:image / 官方缩略图） */
  remoteImage: string | null
  /** 本地媒体文件名（配合 mediaUrl 转 bpmedia://） */
  localMedia: string | null
  /** 本地媒体是否带播放语义（video 载体） */
  playable: boolean
  /** GitHub：owner/repository */
  repositoryName: string | null
  language: string | null
  stars: number | null
  forks: number | null
  /** 视频平台：能可靠构造缩略图时的视频 id（YouTube） */
  videoId: string | null
  /** 作者行（频道 / UP 主 / @handle） */
  author: string | null
  /** X 动态正文（summary 承载） */
  body: string | null
  /** 元信息行（域名等） */
  meta: string | null
  detailUrl: string | null
}

/** 只接受 https 的远程图片地址；其余（data:/file:/http:）一律拒绝。 */
export function isSafeRemoteImage(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

/** GitHub og:title 通常是 "owner/repo: description"；platformContentID 是 "owner/repo"。 */
function splitRepository(item: RecordItem): { name: string; description: string } {
  const identity = (item.platformContentID ?? '').trim()
  if (identity.includes('/')) {
    const description = item.title.startsWith(identity)
      ? item.title.slice(identity.length).replace(/^[:：\s-]+/, '')
      : item.summary || item.title
    return { name: identity, description }
  }
  const title = item.title.trim()
  const match = title.match(/^([\w.-]+\/[\w.-]+)[:：\s]\s*(.+)$/u)
  if (match) return { name: match[1], description: match[2] }
  return { name: title, description: item.summary }
}

/** 数字格式化：1_234 → 1.2k；与 iOS Fmt.starCount 同量级，不伪造精度。 */
export function formatCount(value: number): string {
  if (value < 0) return '0'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${Math.round((value / 1000) * 10) / 10}k`
  return `${Math.round((value / 1_000_000) * 10) / 10}m`
}

/** 记录 → 平台预览视图。mediaUrl 由调用方注入（bpmedia:// 文件名转换）。 */
export function buildPreview(item: RecordItem, mediaUrl: (name: string) => string): RecordPreview {
  const platform = detectPlatform(item)
  const title = item.title.trim() || item.summary.trim().split('\n')[0] || platform.label
  const author = item.authorName.trim() || null
  const detailUrl = item.canonicalURL || item.urlString || null

  // 本地媒体与文字：不需要平台识别。
  if (item.carrier === 'image' || item.carrier === 'video') {
    const media = item.previewPath ?? item.mediaPath
    return {
      platform: { platform: 'web', label: platform.label, accent: platform.accent },
      title,
      kind: media ? 'local-media' : 'platform-card',
      remoteImage: null,
      localMedia: media,
      playable: item.carrier === 'video',
      repositoryName: null,
      language: null,
      stars: null,
      forks: null,
      videoId: null,
      author,
      body: null,
      meta: item.sourceName || null,
      detailUrl: null
    }
  }
  if (item.carrier === 'text') {
    return {
      platform: { platform: 'web', label: platform.label, accent: platform.accent },
      title,
      kind: 'text',
      remoteImage: null,
      localMedia: null,
      playable: false,
      repositoryName: null,
      language: null,
      stars: null,
      forks: null,
      videoId: null,
      author,
      body: item.note || null,
      meta: null,
      detailUrl: null
    }
  }

  // 链接：按平台归一。
  const remoteImage = isSafeRemoteImage(item.thumbnailURLString)
  const base: RecordPreview = {
    platform,
    title,
    remoteImage,
    localMedia: null,
    playable: false,
    repositoryName: null,
    language: null,
    stars: null,
    forks: null,
    videoId: null,
    author,
    body: null,
    meta: platform.label,
    detailUrl,
    kind: 'platform-card'
  }

  switch (platform.platform) {
    case 'github': {
      const repo = splitRepository(item)
      return {
        ...base,
        kind: remoteImage ? 'remote-image' : 'repo-card',
        repositoryName: repo.name || null,
        language: item.repositoryLanguage,
        stars: item.repositoryStars,
        forks: item.repositoryForks,
        videoId: null,
        title: repo.description || item.summary || repo.name,
        body: null
      }
    }
    case 'youtube': {
      const videoId = (item.platformContentID ?? '').trim() || null
      const thumbnail = remoteImage ?? (videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : null)
      return {
        ...base,
        kind: thumbnail ? 'remote-image' : 'platform-card',
        remoteImage: thumbnail,
        videoId,
        playable: true
      }
    }
    case 'bilibili': {
      return {
        ...base,
        kind: remoteImage ? 'remote-image' : 'platform-card',
        videoId: (item.platformContentID ?? '').trim() || null,
        playable: true
      }
    }
    case 'x': {
      return {
        ...base,
        kind: remoteImage ? 'remote-image' : 'text',
        videoId: null,
        body: item.summary.trim() || item.note.trim() || null,
        title: item.title.trim() || (item.summary.trim() ? '' : '社交动态'),
        meta: author ? `X · ${author}` : 'X'
      }
    }
    default: {
      const host = hostOf(detailUrl)
      return {
        ...base,
        kind: remoteImage ? 'remote-image' : 'platform-card',
        videoId: null,
        meta: host ?? platform.label,
        author: item.sourceName || author
      }
    }
  }
}

function hostOf(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
