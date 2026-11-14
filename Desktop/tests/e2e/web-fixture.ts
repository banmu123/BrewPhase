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

/** AI 夹具（Phase 4.1 E2E）：真实链路用的平台仿真页与宿主地址。 */
export type AIFixture = {
  /** 形如 `127.0.0.1:<port>`——BREWPHASE_AI_TEST_HOST 接缝要的就是这个。 */
  host: string
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

/* ============================================================
 * AI 平台夹具（Phase 4.1 E2E）。
 *
 * 通过 BREWPHASE_AI_TEST_HOST 接缝，ChatGPT / Claude 的 Adapter 会在
 * 这两个页面上跑**真实的** probe → submit → poll 链路：
 * - DOM 结构按平台当前已知选择器仿真（#prompt-textarea / ProseMirror…）；
 * - 点发送后先显示「停止生成」按钮（生成中），随后追加一条助手消息；
 * - 助手消息带 Markdown（标题 + 列表），正文回显真实输入——证明
 *   文本确实经 Adapter 写进了编辑器，而不是页面自己编的数据；
 * - Claude 刻意慢 4 秒：验证「先完成者先显示」与取消同步。
 * ============================================================ */

const GPT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT fixture</title></head>
<body>
<div id="prompt-textarea" contenteditable="true" style="width:480px;height:64px;border:1px solid #999"></div>
<button data-testid="send-button" onclick="__bpFixtureSend()">Send</button>
<script>
function __bpEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function __bpFixtureSend() {
  var input = document.getElementById('prompt-textarea')
  var text = (input.innerText || '').trim()
  window.__lastPrompt = text
  var stop = document.createElement('button')
  stop.setAttribute('data-testid', 'stop-button')
  document.body.appendChild(stop)
  setTimeout(function () {
    stop.remove()
    var answer = document.createElement('div')
    answer.setAttribute('data-message-author-role', 'assistant')
    // 平台真实回答是富文本渲染：<br> 才能让 innerText 提取出换行
    // （textContent 里的 \\n 会被 white-space:normal 折叠成空格）。
    answer.innerHTML = '## GPT 观点<br><br>- 收到的问题：' + __bpEscape(text) + '<br>- 来自 GPT-FIXTURE 的并行回答'
    document.body.appendChild(answer)
  }, 300)
}
</script></body></html>`

const CLAUDE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Claude fixture</title></head>
<body>
<div id="stream" data-is-streaming="false">
  <div class="ProseMirror" contenteditable="true" style="width:480px;height:64px;border:1px solid #999"></div>
  <button aria-label="Send message" onclick="__bpFixtureSend()">Send</button>
</div>
<script>
function __bpEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function __bpFixtureSend() {
  var input = document.querySelector('.ProseMirror')
  var text = (input.innerText || '').trim()
  window.__lastPrompt = text
  var stream = document.getElementById('stream')
  stream.setAttribute('data-is-streaming', 'true')
  // 刻意比 ChatGPT 夹具慢得多：先完成者先显示、取消同步都要这个时间窗。
  setTimeout(function () {
    stream.removeAttribute('data-is-streaming')
    var answer = document.createElement('div')
    answer.setAttribute('data-testid', 'assistant-message')
    answer.innerHTML = '## Claude 观点<br><br>- 收到的问题：' + __bpEscape(text) + '<br>- 来自 CLAUDE-FIXTURE 的并行回答'
    document.body.appendChild(answer)
  }, 4000)
}
</script></body></html>`

export async function startAIFixture(): Promise<AIFixture> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (path.startsWith('/chatgpt')) response.end(GPT_PAGE)
    else if (path.startsWith('/claude')) response.end(CLAUDE_PAGE)
    else response.end('<!doctype html><html><body><main>ai fixture root</main></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    host: `127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}
