import { z } from 'zod'
import type { AccountUser } from '../../shared/contracts/account'

/**
 * Cloud API 客户端（Desktop → BrewPhase Cloud）。
 *
 * 只做四件事：拼授权地址、用一次性授权码换会话、刷新会话、撤销会话，
 * 外加一个 `GET /auth/me` 用来确认会话归属。字段名严格照服务端实现
 * （cloud/src/routes/oauth.ts、routes/auth.ts），不做任何「猜」的映射。
 *
 * 纪律：
 * - **日志里永远没有 Token**：错误只带 `kind` / HTTP 状态 / 服务端错误码，
 *   不把响应体、Authorization 头或请求体带进异常消息；
 * - 每个请求都有超时（AbortController），网络异常归一成 CloudError；
 * - `FetchLike` 可注入：单测不需要真实网络，也不需要真实 Google/GitHub 凭据；
 * - 只有主进程会 import 这个文件。Renderer 侧没有任何直连认证接口的通道。
 */

export interface FetchResponse {
  status: number
  text(): Promise<string>
}

export interface FetchInit {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  /** 不自动跟随重定向：Token 请求被 302 转走时应当失败，而不是把 body 带过去。 */
  redirect?: 'follow' | 'manual' | 'error'
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>

export type CloudErrorKind = 'network' | 'timeout' | 'http' | 'malformed'

export class CloudError extends Error {
  readonly kind: CloudErrorKind
  readonly status: number | null
  /** 服务端 `{error}` 码（如 invalid_grant / rate_limited），仅用于分类。 */
  readonly serverCode: string | null

  constructor(kind: CloudErrorKind, options: { status?: number; serverCode?: string } = {}) {
    // 消息里刻意不含请求体与响应体：两者都可能带 Token。
    super(`cloud request failed: ${kind}${options.status ? ` (${options.status})` : ''}`)
    this.name = 'CloudError'
    this.kind = kind
    this.status = options.status ?? null
    this.serverCode = options.serverCode ?? null
  }
}

export interface CloudSession {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1)
})

const meResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  display_name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  created_at: z.string().min(1)
})

const logoutResponseSchema = z.object({ ok: z.boolean().optional() })

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 默认基地址 = 本地 cloud/ 的默认端口（见 cloud/.env.example 的 PORT=3000）。
 *
 * **没有编造生产域名**：这一阶段没有已部署的 Cloud，真实联调时必须用
 * `BREWPHASE_CLOUD_BASE_URL` 指定部署地址。设置页会把实际请求的地址显示出来，
 * 避免「以为连的是线上、其实连的是本机」这种最难查的错。
 */
export const DEFAULT_CLOUD_BASE_URL = 'http://127.0.0.1:3000'

/** http 只允许回环（本地开发）；远程一律必须 https，否则授权码与 Token 会明文过网。 */
export function resolveCloudBaseUrl(raw: string | undefined = process.env.BREWPHASE_CLOUD_BASE_URL): string {
  const value = (raw ?? '').trim()
  if (!value) return DEFAULT_CLOUD_BASE_URL
  const normalized = value.replace(/\/+$/, '')
  try {
    const url = new URL(normalized)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    if (url.protocol === 'https:') return normalized
    if (url.protocol === 'http:' && loopback) return normalized
    console.warn(
      `[account] refusing insecure BREWPHASE_CLOUD_BASE_URL (${url.protocol}//${url.host}); using ${DEFAULT_CLOUD_BASE_URL}`
    )
    return DEFAULT_CLOUD_BASE_URL
  } catch {
    console.warn(`[account] BREWPHASE_CLOUD_BASE_URL is not a URL; using ${DEFAULT_CLOUD_BASE_URL}`)
    return DEFAULT_CLOUD_BASE_URL
  }
}

export class CloudClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(
    params: {
      baseUrl?: string
      fetchImpl?: FetchLike
      timeoutMs?: number
    } = {}
  ) {
    this.baseUrl = (params.baseUrl ?? DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = params.fetchImpl ?? ((url, init) => fetch(url, init))
    this.timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get origin(): string {
    return this.baseUrl
  }

  /**
   * `/oauth/authorize` 地址。参数名与服务端 `authorizeQuerySchema` 完全一致；
   * `state` 是 Desktop 生成的 client state（服务端只存哈希并原样回传），
   * `code_challenge` 是 S256（43 字符 base64url）。
   */
  authorizeUrl(params: {
    provider: 'google' | 'github'
    clientState: string
    codeChallenge: string
    redirectUri: string
  }): string {
    const url = new URL(`${this.baseUrl}/oauth/authorize`)
    url.searchParams.set('provider', params.provider)
    url.searchParams.set('state', params.clientState)
    url.searchParams.set('code_challenge', params.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('redirect_uri', params.redirectUri)
    return url.toString()
  }

  /** 一次性授权码 → BrewPhase 会话。服务端会原子消费授权码并把旧 token family 记下来。 */
  async exchangeAuthorizationCode(input: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<CloudSession> {
    const body = await this.request('/oauth/token', tokenResponseSchema, {
      method: 'POST',
      json: {
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri
      }
    })
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in
    }
  }

  /** Refresh Token Rotation：返回的 refresh_token 是新的，旧的立即失效，必须落盘。 */
  async refresh(refreshToken: string): Promise<CloudSession> {
    const body = await this.request('/auth/refresh', tokenResponseSchema, {
      method: 'POST',
      json: { refresh_token: refreshToken }
    })
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in
    }
  }

  /** 撤销整个 token family。未知 token 服务端幂等返回 ok。 */
  async logout(refreshToken: string): Promise<void> {
    await this.request('/auth/logout', logoutResponseSchema, {
      method: 'POST',
      json: { refresh_token: refreshToken }
    })
  }

  /** 当前会话对应的账户资料（服务端 `/auth/me` 的安全子集）。 */
  async me(accessToken: string): Promise<AccountUser> {
    const body = await this.request('/auth/me', meResponseSchema, {
      method: 'GET',
      bearer: accessToken
    })
    return {
      id: body.id,
      displayName: body.display_name ?? null,
      avatarUrl: body.avatar_url ?? null,
      createdAt: body.created_at
    }
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { method: 'GET' | 'POST'; json?: unknown; bearer?: string }
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.json !== undefined) headers['Content-Type'] = 'application/json'
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()

    let response: FetchResponse
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        redirect: 'manual',
        ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
        signal: controller.signal
      })
    } catch (error) {
      throw new CloudError(isAbort(error) ? 'timeout' : 'network')
    } finally {
      clearTimeout(timer)
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      throw new CloudError('network', { status: response.status })
    }

    const parsed = parseJson(text)

    if (response.status < 200 || response.status >= 300) {
      throw new CloudError('http', { status: response.status, serverCode: errorCodeOf(parsed) })
    }

    const result = schema.safeParse(parsed)
    if (!result.success) throw new CloudError('malformed', { status: response.status })
    return result.data
  }
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function errorCodeOf(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'error' in value) {
    const code = (value as { error?: unknown }).error
    if (typeof code === 'string' && code.length <= 64) return code
  }
  return undefined
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
