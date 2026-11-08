import type { LinkProvider } from './contracts'

/**
 * 内嵌播放器的地址构造（纯函数，main 与 renderer 共用同一份规则）。
 *
 * 三条硬约束：
 * 1. 地址**只由内容 ID 拼出**，绝不读记录里的 `urlString` / `canonicalURL`。
 *    用户粘一个「播放器地址」进来，不会让它进 iframe——与 iOS 侧
 *    `LinkEmbed` 同一条规矩。
 * 2. 内容 ID 必须过平台自己的格式校验，不合格就当不能播，卡片退回
 *    「浏览器打开」，绝不带着可疑字符串去拼 URL。
 * 3. CSP 的 `frame-src` 与主进程的 iframe 导航拦截都读这里：两处各写一份
 *    白名单迟早会漂移，漂移的那一天就是安全边界破的那一天。
 */

/** 允许被嵌入 iframe 的播放器来源。只有这里列出的域名能进 frame。 */
export const EMBED_FRAME_ORIGINS = [
  'https://www.youtube.com',
  'https://player.bilibili.com'
] as const

/**
 * 导航白名单按**注册域**匹配（裸域与任意子域），比 CSP 的精确 origin 宽一档：
 * CSP 只管第一次加载，之后播放器自己内部的跳转由主进程判断，多放行
 * `youtube.com` 自己的子域是合理的，`notyoutube.com` 这类依赖后缀仍会被拒。
 */
const EMBED_FRAME_HOSTS = ['youtube.com', 'player.bilibili.com'] as const

/** YouTube 视频 ID 恒为 11 位 base64url，与 iOS `YouTubeAdapter.isVideoID` 一致。 */
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
/** B 站 BV 号：BV + 10 位 base58。 */
const BILIBILI_BVID = /^BV[0-9A-Za-z]{10}$/
/** B 站老 av 号：纯数字，最多 12 位。 */
const BILIBILI_AID = /^av(\d{1,12})$/i

/**
 * 记录 → 播放器地址。不能播返回 null（调用方据此不渲染播放器）。
 *
 * 只有 YouTube 与 B 站有稳定的官方嵌入页；X 需要引入 widgets.js 并放宽
 * `script-src`，代价大于收益，仍走浏览器打开。
 */
export function embedURL(
  provider: LinkProvider | string,
  contentId: string | null | undefined
): string | null {
  const id = (contentId ?? '').trim()
  if (!id) return null

  if (provider === 'youtube') {
    if (!YOUTUBE_VIDEO_ID.test(id)) return null
    return `https://www.youtube.com/embed/${id}?rel=0&playsinline=1`
  }

  if (provider === 'bilibili') {
    if (BILIBILI_BVID.test(id)) {
      return `https://player.bilibili.com/player.html?bvid=${id}&page=1&high_quality=1&danmaku=0`
    }
    const aid = id.match(BILIBILI_AID)?.[1]
    if (aid) {
      return `https://player.bilibili.com/player.html?aid=${aid}&page=1&high_quality=1&danmaku=0`
    }
    return null
  }

  return null
}

/**
 * 这个地址是否属于允许的播放器来源（含其子域）。
 * 主进程用它拦 iframe 内部导航：播放器自己跳自己的域名可以，跳去别处不行。
 */
export function isEmbedFrameURL(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return EMBED_FRAME_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  )
}
