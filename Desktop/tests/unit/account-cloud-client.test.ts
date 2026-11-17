import { describe, expect, it, vi } from 'vitest'

import {
  CloudClient,
  CloudError,
  DEFAULT_CLOUD_BASE_URL,
  resolveCloudBaseUrl,
  type FetchInit,
  type FetchLike
} from '../../src/main/account/cloud-client'

/**
 * Cloud API 客户端测试：成功响应、401、403、500、超时、网络断开。
 *
 * 全部用注入式 FetchLike，不需要真实 Cloud、更不需要 Google/GitHub 凭据；
 * 同时断言请求形状（JSON、表单字段名、Authorization）与「日志里没有 Token」。
 */

const BASE = 'https://cloud.example.test'
const REFRESH_TOKEN = 'refresh-secret-9f8e7d'
const ACCESS_TOKEN = 'access-secret-1a2b3c'

type Scripted = { status: number; body: string }

function fetcher(responses: Scripted[], calls: Array<{ url: string; init: FetchInit }>): FetchLike {
  let index = 0
  return async (url, init) => {
    calls.push({ url, init })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    return { status: next.status, text: async () => next.body }
  }
}

function tokenBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: ACCESS_TOKEN,
    token_type: 'Bearer',
    expires_in: 900,
    refresh_token: REFRESH_TOKEN,
    ...overrides
  })
}

describe('resolveCloudBaseUrl', () => {
  it('未配置时用本地 cloud/ 的默认端口', () => {
    expect(resolveCloudBaseUrl(undefined)).toBe(DEFAULT_CLOUD_BASE_URL)
    expect(resolveCloudBaseUrl('')).toBe(DEFAULT_CLOUD_BASE_URL)
  })

  it('https 原样保留，去掉末尾斜杠', () => {
    expect(resolveCloudBaseUrl('https://cloud.example.test///')).toBe('https://cloud.example.test')
  })

  it('http 只允许回环（本地开发）', () => {
    expect(resolveCloudBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(resolveCloudBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000')
  })

  it('远程 http 被拒绝（授权码与 Token 不能明文过网）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveCloudBaseUrl('http://cloud.example.test')).toBe(DEFAULT_CLOUD_BASE_URL)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('不是 URL 时回退默认值而不是崩在启动阶段', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveCloudBaseUrl('not a url')).toBe(DEFAULT_CLOUD_BASE_URL)
    warn.mockRestore()
  })
})

describe('CloudClient.authorizeUrl', () => {
  it('参数名与服务端一致（provider / state / code_challenge / redirect_uri）', () => {
    const client = new CloudClient({ baseUrl: BASE })
    const url = new URL(
      client.authorizeUrl({
        provider: 'github',
        clientState: 'state-value',
        codeChallenge: 'challenge-value',
        redirectUri: 'http://127.0.0.1:51234/callback'
      })
    )
    expect(url.origin + url.pathname).toBe(`${BASE}/oauth/authorize`)
    expect(url.searchParams.get('provider')).toBe('github')
    expect(url.searchParams.get('state')).toBe('state-value')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51234/callback')
  })
})

describe('CloudClient 请求', () => {
  it('授权码兑换：POST JSON，字段是 code / code_verifier / redirect_uri', async () => {
    const calls: Array<{ url: string; init: FetchInit }> = []
    const client = new CloudClient({
      baseUrl: BASE,
      fetchImpl: fetcher([{ status: 200, body: tokenBody() }], calls)
    })

    const session = await client.exchangeAuthorizationCode({
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: 'http://127.0.0.1:51234/callback'
    })

    expect(session).toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresInSeconds: 900
    })
    const call = calls[0]
    expect(call?.url).toBe(`${BASE}/oauth/token`)
    expect(call?.init.method).toBe('POST')
    // 兑换接口不带 Authorization：凭据是授权码本身。
    expect(call?.init.headers.Authorization).toBeUndefined()
    expect(JSON.parse(call?.init.body ?? '{}')).toEqual({
      code: 'the-code',
      code_verifier: 'the-verifier',
      redirect_uri: 'http://127.0.0.1:51234/callback'
    })
  })

  it('401 invalid_grant → CloudError(http, 401)，消息里没有 token', async () => {
    const client = new CloudClient({
      baseUrl: BASE,
      fetchImpl: fetcher(
        [{ status: 401, body: JSON.stringify({ error: 'invalid_grant', error_description: 'nope' }) }],
        []
      )
    })

    const error = await client.refresh(REFRESH_TOKEN).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(CloudError)
    const cloudError = error as CloudError
    expect(cloudError.kind).toBe('http')
    expect(cloudError.status).toBe(401)
    expect(cloudError.serverCode).toBe('invalid_grant')
    expect(cloudError.message).not.toContain(REFRESH_TOKEN)
  })

  it('403 → CloudError(http, 403)，保留服务端错误码', async () => {
    const client = new CloudClient({
      baseUrl: BASE,
      fetchImpl: fetcher([{ status: 403, body: JSON.stringify({ error: 'account_suspended' }) }], [])
    })

    const error = (await client.me(ACCESS_TOKEN).catch((cause: unknown) => cause)) as CloudError
    expect(error.kind).toBe('http')
    expect(error.status).toBe(403)
    expect(error.serverCode).toBe('account_suspended')
  })

  it('500 → CloudError(http, 500)', async () => {
    const client = new CloudClient({
      baseUrl: BASE,
      fetchImpl: fetcher([{ status: 500, body: JSON.stringify({ error: 'server_error' }) }], [])
    })

    const error = (await client.logout(REFRESH_TOKEN).catch((cause: unknown) => cause)) as CloudError
    expect(error.kind).toBe('http')
    expect(error.status).toBe(500)
  })

  it('超时 → CloudError(timeout)', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const abort = new Error('aborted')
          abort.name = 'AbortError'
          reject(abort)
        })
      })
    const client = new CloudClient({ baseUrl: BASE, fetchImpl: hanging, timeoutMs: 25 })

    const error = (await client.refresh(REFRESH_TOKEN).catch((cause: unknown) => cause)) as CloudError
    expect(error.kind).toBe('timeout')
    expect(error.message).not.toContain(REFRESH_TOKEN)
  })

  it('网络断开 → CloudError(network)', async () => {
    const client = new CloudClient({
      baseUrl: BASE,
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      }
    })

    const error = (await client.me(ACCESS_TOKEN).catch((cause: unknown) => cause)) as CloudError
    expect(error.kind).toBe('network')
  })

  it('200 但不是 JSON → CloudError(malformed)', async () => {
    const client = new CloudClient({
      baseUrl: BASE,
      fetchImpl: fetcher([{ status: 200, body: '<html>oops</html>' }], [])
    })

    const error = (await client.refresh(REFRESH_TOKEN).catch((cause: unknown) => cause)) as CloudError
    expect(error.kind).toBe('malformed')
  })

  it('200 但字段缺失 → CloudError(malformed)，不会拿半套会话继续', async () => {
    const client = new CloudClient({
      baseUrl: BASE,
      fetchImpl: fetcher([{ status: 200, body: JSON.stringify({ access_token: ACCESS_TOKEN }) }], [])
    })

    const error = (await client.refresh(REFRESH_TOKEN).catch((cause: unknown) => cause)) as CloudError
    expect(error.kind).toBe('malformed')
  })

  it('me()：Bearer 头 + snake_case → AccountUser', async () => {
    const calls: Array<{ url: string; init: FetchInit }> = []
    const client = new CloudClient({
      baseUrl: BASE,
      fetchImpl: fetcher(
        [
          {
            status: 200,
            body: JSON.stringify({
              id: 'user_1',
              status: 'active',
              display_name: '半木',
              avatar_url: null,
              created_at: '2026-01-02T03:04:05.000Z'
            })
          }
        ],
        calls
      )
    })

    expect(await client.me(ACCESS_TOKEN)).toEqual({
      id: 'user_1',
      displayName: '半木',
      avatarUrl: null,
      createdAt: '2026-01-02T03:04:05.000Z'
    })
    expect(calls[0]?.init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(calls[0]?.init.method).toBe('GET')
  })

  it('logout()：把 refresh_token 交给服务端撤销', async () => {
    const calls: Array<{ url: string; init: FetchInit }> = []
    const client = new CloudClient({
      baseUrl: BASE,
      fetchImpl: fetcher([{ status: 200, body: JSON.stringify({ ok: true }) }], calls)
    })

    await client.logout(REFRESH_TOKEN)
    expect(calls[0]?.url).toBe(`${BASE}/auth/logout`)
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ refresh_token: REFRESH_TOKEN })
  })
})
