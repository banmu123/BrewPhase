import { createServer } from 'node:http'
import type { Server } from 'node:http'

/**
 * 本地网页夹具（Phase 2 E2E 用）。
 *
 * 为什么必须用本地服务：这一阶段的核心验收是「卡片显示真实网页截图」。
 * 用 chatgpt.com 之类的外网站会让测试依赖网络、登录与地区，失败原因无法
 * 归因；本地页面同样经过真实的 Chromium 导航、布局与绘制，截图链路一致。
 */

export type WebFixture = {
  url: (path: string) => string
  close: () => Promise<void>
}

const PAGE_STYLE = `
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,'Segoe UI',sans-serif;background:linear-gradient(135deg,#f6f1e7,#e8ddc9);color:#3d2b1f}
  main{padding:48px 56px}
  h1{font-size:54px;margin:0 0 10px;letter-spacing:-.02em}
  p{font-size:22px;color:#7a5c46;margin:0 0 8px}
  .swatches{display:flex;gap:12px;margin-top:28px}
  .swatches i{width:88px;height:88px;border-radius:14px;display:block}
`

export async function startWebFixture(): Promise<WebFixture> {
  const hits = new Map<string, number>()
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/'
    const seen = (hits.get(path) ?? 0) + 1
    hits.set(path, seen)
    if (path === '/slow') {
      setTimeout(() => {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(render(path, seen))
      }, 2_500)
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(render(path, seen))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

function render(path: string, seen: number): string {
  const label = path.replace(/^\//, '') || 'home'
  return `<!doctype html><html><head><meta charset="utf-8">
<title>fixture ${label}</title>
<style>${PAGE_STYLE}</style></head>
<body><main>
  <h1>fixture ${label}</h1>
  <p>real chromium page · visit ${seen}</p>
  <div class="swatches">
    <i style="background:#6f7f5c"></i><i style="background:#b07a4a"></i>
    <i style="background:#3d2b1f"></i><i style="background:#d9c9ae"></i>
  </div>
</main>
<script>
  window.__born = performance.timeOrigin
  window.__path = ${JSON.stringify(path)}
  window.__ticks = 0
  setInterval(() => { window.__ticks++ }, 200)
</script></body></html>`
}
