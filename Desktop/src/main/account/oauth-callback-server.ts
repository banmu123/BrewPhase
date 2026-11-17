import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'

/**
 * OAuth 本机回调服务器（Desktop 侧）。
 *
 * 服务端契约（cloud/src/oauth/authorization.ts + security/crypto.ts）只接受
 * `http://127.0.0.1:<port>/callback` 这一种 redirect_uri：没有深链、没有自定义
 * 协议。因此这里必须起一个**只监听回环地址**的一次性 HTTP 服务。
 *
 * 边界（每一条都是攻击面）：
 * - 只 bind `127.0.0.1`，端口由系统分配（0），再把真实端口写进 redirect_uri；
 * - 只接受 `GET /callback`，其它方法 / 路径一律 404/405，且不改变任何状态；
 * - 校验 `Host` 头必须是 `127.0.0.1:<port>`（防 DNS rebinding）；
 * - `state` 必须与本地生成的值常量时间相等；不等就当没收到，继续等；
 * - **只接受一次回调**：成功/失败后服务器立即关闭，重复请求得到 409，
 *   授权码不会被兑换两次（服务端也是一次性码，这里是第一道闸）；
 * - 超时（默认 5 分钟，等于服务端 transaction TTL）与取消都要真正关掉端口；
 * - 响应页是写死的静态 HTML：不回显任何查询参数，避免把攻击者可控内容
 *   反射进浏览器。
 *
 * 这个文件不 import electron，端口行为可以在单测里用真实 HTTP 请求验证。
 */

export type OAuthCallbackOutcome =
  | { status: 'code'; code: string }
  | { status: 'error'; error: string; description: string | null }
  | { status: 'cancelled' }
  | { status: 'timeout' }

export interface OAuthCallbackServer {
  /** 交给 Cloud 的 `redirect_uri`，形如 `http://127.0.0.1:51234/callback`。 */
  readonly redirectUri: string
  readonly port: number
  /** 只 resolve 一次：code / error / cancelled / timeout。 */
  readonly result: Promise<OAuthCallbackOutcome>
  /** 用户取消（关设置页、点取消、应用退出）：关端口并 resolve cancelled。 */
  cancel(): void
}

export class OAuthCallbackError extends Error {
  constructor(readonly reason: 'listen-failed' | 'no-port') {
    super(`oauth callback server failed: ${reason}`)
    this.name = 'OAuthCallbackError'
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000

export async function startOAuthCallbackServer(params: {
  clientState: string
  timeoutMs?: number
}): Promise<OAuthCallbackServer> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const expectedState = params.clientState

  let settle: (outcome: OAuthCallbackOutcome) => void = () => {}
  const result = new Promise<OAuthCallbackOutcome>((resolve) => {
    settle = resolve
  })

  const server = createServer((request, response) => {
    const port = address?.port ?? 0

    if (request.method !== 'GET') {
      respond(response, 405, page('Method not allowed', 'This endpoint only accepts GET.'))
      return
    }

    // DNS rebinding 防线：浏览器把攻击者域名解析到 127.0.0.1 时，Host 头仍是
    // 攻击者的域名。OAuth 回调只可能来自用户浏览器跳转到我们注册过的地址。
    const host = (request.headers.host ?? '').toLowerCase()
    if (port === 0 || host !== `127.0.0.1:${port}`) {
      respond(response, 421, page('Unexpected host', 'Close this tab and try signing in again.'))
      return
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      respond(response, 404, page('Not found', 'This address is not an OAuth callback.'))
      return
    }

    if (settled) {
      // 重复回调：授权码已经用掉了，再兑换只会失败。明确拒绝。
      respond(
        response,
        409,
        page('Already handled', 'This sign-in link was already used. You can close this tab.')
      )
      return
    }

    const state = url.searchParams.get('state')
    if (!state || !safeEqual(state, expectedState)) {
      // state 不匹配：可能是伪造请求或旧链接。不结束流程，继续等真正的回调。
      respond(
        response,
        400,
        page('Sign-in link is not valid', 'Close this tab and start signing in again from BrewPhase.')
      )
      return
    }

    const providerError = url.searchParams.get('error')
    if (providerError) {
      respond(response, 200, failurePage())
      finish({
        status: 'error',
        error: providerError,
        description: url.searchParams.get('error_description')
      })
      return
    }

    const code = url.searchParams.get('code')
    if (!code) {
      respond(response, 400, page('Missing authorization code', 'Start signing in again from BrewPhase.'))
      finish({ status: 'error', error: 'invalid_request', description: null })
      return
    }

    respond(response, 200, successPage())
    finish({ status: 'code', code })
  })

  const listen = new Promise<{ port: number }>((resolve, reject) => {
    server.once('error', () => reject(new OAuthCallbackError('listen-failed')))
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new OAuthCallbackError('no-port'))
        return
      }
      resolve({ port: address.port })
    })
  })

  let address: { port: number } | null = null
  try {
    address = await listen
  } catch (error) {
    closeServer()
    throw error
  }

  let settled = false
  const timer = setTimeout(() => finish({ status: 'timeout' }), Math.max(50, timeoutMs))
  timer.unref?.()

  function finish(outcome: OAuthCallbackOutcome): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    settle(outcome)
    // 先让响应体写完再关；`closeAllConnections` 保证 keep-alive 连接不吊住端口。
    setTimeout(closeServer, 0)
  }

  function closeServer(): void {
    try {
      server.close()
      const withConnections = server as unknown as {
        closeIdleConnections?: () => void
        closeAllConnections?: () => void
      }
      withConnections.closeIdleConnections?.()
      // 兜底强断：延迟一会儿，避免把刚 writeHead 的响应体剪断（用户会看到半张页）。
      const force = setTimeout(() => withConnections.closeAllConnections?.(), 200)
      force.unref?.()
    } catch {
      // 已经关过：幂等处理。
    }
  }

  return {
    get redirectUri(): string {
      return `http://127.0.0.1:${address?.port ?? 0}/callback`
    },
    get port(): number {
      return address?.port ?? 0
    },
    result,
    cancel: () => finish({ status: 'cancelled' })
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) {
    // 长度不同也走一次比较，避免「长度不一致就早退」的时序差异。
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // 一次性页面：响应写完就断开，`server.close()` 不必等 keep-alive 超时。
    Connection: 'close',
    // 响应页不加载任何外部资源，也不执行脚本。
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
  })
  response.end(body)
}

/**
 * 响应页是**静态**的：所有文案写死，绝不插入查询参数。
 * 回调 URL 里带着一次性授权码，把任何参数回显到 HTML 都等于给它加了一条泄漏路径。
 */
function page(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BrewPhase</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif;
         background: #f6f2ec; color: #2c2420; }
  main { max-width: 26rem; padding: 2.5rem 2rem; text-align: center; }
  h1 { margin: 0 0 0.6rem; font-size: 1.15rem; font-weight: 600; }
  p { margin: 0; color: #6b5f57; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1815; color: #efe8e1; }
    p { color: #b3a79c; }
  }
</style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>`
}

function successPage(): string {
  return page('Signed in to BrewPhase', 'You can close this tab and return to the app.')
}

function failurePage(): string {
  return page(
    'Sign-in was not completed',
    'BrewPhase could not finish signing you in. Close this tab and try again from the app.'
  )
}

/** 单测与诊断用：生成一个 32 字节 base64url 随机 state（与服务端模式一致）。 */
export function createClientState(): string {
  return randomBytes(32).toString('base64url')
}
