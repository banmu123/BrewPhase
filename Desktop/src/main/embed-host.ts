import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { YOUTUBE_VIDEO_ID } from '../shared/link-embed'

/**
 * 内嵌播放器的**回环包装页主机**（YouTube 错误 153 的修复）。
 *
 * 背景（2026 年起 YouTube 收紧嵌入策略）：打包版桌面应用的渲染进程是
 * `file://` 页面，origin 为 null——YouTube 要求嵌入它的页面有 http(s) origin，
 * 且与播放器 URL 的 `origin` 参数匹配，否则直接报
 * 「视频播放器配置错误（153）」。Referer 注入在现代 Electron 上不可行
 * （webRequest 对 Referer 的改写被静默丢弃，electron/electron#21374）。
 *
 * 方案：主进程在 **127.0.0.1 随机端口** 上起一台极小 HTTP 主机，为每个视频
 * 提供一张包装页（iframe 指向 youtube-nocookie 并带 `origin` 参数）。渲染
 * 进程仍然留在 file://——它的 origin、localStorage、设置、后端连接统统
 * 不动，只有这张包装页获得 http origin。
 *
 * 收口（与正式发版安全审计同一条标准）：
 * - 只回答 `/youtube/<videoId>` 一种路径，videoId 过 11 位 base64url 白名单；
 * - 只接受数值型 `start` 参数，非数字直接丢弃；
 * - **只响应 Host 头等于自身 origin 的请求**——别的页面就算通过 DNS
 *   rebinding 把域名指到这个端口，也拿不到任何东西；
 * - 响应带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`，
 *   以及一条**只放行 YouTube 播放器**的 CSP：
 *   `default-src 'none'; frame-src https://www.youtube-nocookie.com; style-src 'unsafe-inline'`。
 */

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
} as const

const WRAPPER_CSP = "default-src 'none'; frame-src https://www.youtube-nocookie.com; style-src 'unsafe-inline'"

export class EmbedHost {
  private server: Server | null = null
  private port: number | null = null

  /** 启动（幂等）：绑定 127.0.0.1:0（内核分配端口），返回包装页 origin。 */
  start(): Promise<string> {
    if (this.server && this.port) return Promise.resolve(this.origin())
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response)
      })
      server.on('error', (error) => {
        if (this.server !== server) return
        this.server = null
        this.port = null
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        if (!port) {
          server.close()
          reject(new Error('embed host 分配端口失败'))
          return
        }
        this.server = server
        this.port = port
        resolve(this.origin())
      })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = null
  }

  origin(): string {
    return `http://127.0.0.1:${this.port ?? 0}`
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: string, extraHeaders: Record<string, string> = {}): void => {
      response.writeHead(status, {
        ...NO_STORE_HEADERS,
        ...extraHeaders,
        'Content-Type': 'text/html; charset=utf-8'
      })
      response.end(body)
    }
    try {
      const url = new URL(request.url ?? '/', this.origin())
      // DNS rebinding 防御：只认自己的 Host。
      const host = (request.headers.host ?? '').toLowerCase()
      if (host !== `127.0.0.1:${this.port}`) {
        send(403, 'forbidden')
        return
      }
      if (request.method !== 'GET') {
        send(405, 'method not allowed')
        return
      }
      // `/youtube`（无 ID）与其它路径一样 404；只有 `/youtube/<id>` 有意义。
      if (url.pathname !== '/youtube/' && !url.pathname.startsWith('/youtube/')) {
        send(404, 'not found', { 'Content-Security-Policy': WRAPPER_CSP })
        return
      }
      const videoId = decodeURIComponent(url.pathname.slice('/youtube/'.length))
      if (!YOUTUBE_VIDEO_ID.test(videoId)) {
        send(400, 'bad video id', { 'Content-Security-Policy': WRAPPER_CSP })
        return
      }
      // 只透传数值型 start（断点续播；非数字一律丢弃）。
      const startRaw = url.searchParams.get('start') ?? ''
      const start = /^\d{1,6}$/.test(startRaw) ? `&start=${startRaw}` : ''
      const selfOrigin = this.origin()
      const playerUrl =
        `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&playsinline=1` +
        `&origin=${encodeURIComponent(selfOrigin)}${start}`
      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>BrewPhase</title>
<style>html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style>
</head>
<body>
<iframe src="${playerUrl}"
  title="YouTube player"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
  allowfullscreen></iframe>
</body>
</html>`
      send(200, html, { 'Content-Security-Policy': WRAPPER_CSP })
    } catch {
      try {
        send(500, 'error')
      } catch {
        // socket 已断
      }
    }
  }
}
