import {
  REMOTE_DEVICE_TOKEN_PATTERN,
  remoteDeviceCredentialsResponseSchema,
  remoteDeviceRegisterResponseSchema,
  remoteDeviceRotateResponseSchema,
  type RemoteRegistrationFailure,
  type RemoteRotationFailure
} from '../../shared/contracts/remote'

/**
 * 设备注册客户端（协议 §3，**HTTPS，不是 WSS**）。
 *
 * 注册不能走 WSS：设备还没有身份，而 WSS 的认证恰恰依赖注册的结果。
 *
 * ## 用户 Access Token 只在这里被"借一次"
 *
 * 真实 Cloud 的 `/mcp-devices/register` 要求**用户 Bearer**。那个 token 在
 * `account/credentials.ts` 里，而 Remote 刻意**拿不到**它——凭据域分离
 * （安全 §2.6）。所以这一层不读文件、不持有 refresh token，只通过注入的
 * `accessToken()` 回调**每次请求前**要一个当前有效的 access token：
 *
 * ```
 * AccountService ──(临时 access token)──▶ DeviceRegistrar ──▶ RemoteService
 * ```
 *
 * 三个后果，都是刻意的：
 * - 过期由 AccountService 负责刷新（它已经这么做了），这里**不缓存** token，
 *   所以不存在"拿着一个已过期的 token 反复重试"的路径；
 * - 登出后 `accessToken()` 抛错 → 这里归一成 `unauthorized`（**不可重试**），
 *   轮询立刻停止，而不是拿着旧身份继续敲；
 * - refresh token 从不流经这一层，即使某天这里被日志淹没也泄漏不到它。
 *
 * ## 与 `account/cloud-client.ts` 的关系
 *
 * 那套 `CloudClient.request` 是私有的、且与账号端点的 schema 绑死；把它改成
 * 通用请求器属于**重构账号模块**，超出本阶段边界。所以这里保留自己的最小
 * 请求器，但遵守同一套纪律：AbortController 超时、`redirect: 'manual'`、
 * 错误信息只含 `kind`，不含 URL / 请求体 / 响应体 / 任何 token。
 */

export type DeviceRegisterInput = {
  /** 展示给用户的设备名。 */
  name: string
  platform: string
  /** **裸 32 字节公钥**的 base64url（43 字符），不是 SPKI DER。 */
  publicKey: string
  appVersion: string
}

export type DeviceRegisterResult =
  | { ok: true; deviceId: string; confirmCode: string; claimSecret: string; expiresAt: number }
  | { ok: false; reason: RemoteRegistrationFailure }

export type DeviceClaimResult =
  | { ok: true; deviceToken: string; expiresAt: number }
  | { ok: false; reason: RemoteRegistrationFailure; retryable: boolean }

/**
 * 取一个**当前有效**的 user access token。
 *
 * 实现方是 `AccountService.accessToken()`：它会在临近过期时先刷新，
 * 未登录时抛错。这里不做任何缓存——缓存一份已过期的 token 是本阶段
 * 明令禁止的。
 */
export type AccessTokenProvider = () => Promise<string>

/**
 * 用实际使用的 Cloud origin 构造 registrar。
 *
 * 见 `RemoteServiceDeps.registrar` 的注释：origin 只由 RemoteService 解析一次，
 * 然后交进来，避免两处各配一份。
 */
export type DeviceRegistrarFactory = (origin: string) => DeviceRegistrar

export type DeviceRegistrar = {
  register(input: DeviceRegisterInput): Promise<DeviceRegisterResult>
  /**
   * 领取 `device_token`。
   *
   * `claimSecret` 必须走**请求体**，不得进 URL——URL 会进反向代理的 access log
   * （协议 §3.4 的四条传输纪律）。
   */
  claim(input: { deviceId: string; claimSecret: string }): Promise<DeviceClaimResult>
  /**
   * 轮换凭据（协议 §3.5）。
   *
   * 与上面两个的**关键差别**：这里的认证是 `Bearer <旧 device_token>`，
   * **不是**用户 access token。轮换要证明的是「我还持有这台设备的旧私钥 +
   * 旧 token」，而不是「我还登录着」——所以这条路完全不碰 `accessToken()`,
   * 也就不会因为用户 access token 过期而失败。
   */
  rotate(input: DeviceRotateInput): Promise<DeviceRotateResult>
}

export type DeviceRotateInput = {
  deviceId: string
  /** **旧** device_token（本次请求的 Bearer，请求成功后立即失效）。 */
  oldDeviceToken: string
  /** 裸 32 字节新公钥的 base64url（43 字符）。 */
  newPublicKey: string
  ts: number
  /** 旧私钥对 `brewphase.remote.rotate.v1\n<id>\n<key>\n<ts>` 的签名。 */
  signature: string
}

export type DeviceRotateResult =
  | { ok: true; deviceToken: string; expiresAt: number }
  | { ok: false; reason: RemoteRotationFailure }

/**
 * 只声明用到的部分，便于测试注入假实现。
 *
 * 刻意与 `account/cloud-client.ts` 的 `FetchLike` 形状一致（`text()` 而不是
 * `json()`）：两处用同一种响应形状，测试里的假 fetch 才能同时喂给两边。
 */
export type DeviceFetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
    redirect: 'manual'
  }
) => Promise<{ status: number; text(): Promise<string> }>

export type HttpDeviceRegistrarOptions = {
  /** Cloud origin（`https://…` 或测试用的 `http://127.0.0.1:port`）。 */
  origin: string
  /**
   * 每次请求前取有效 access token（**生产路径**）。
   *
   * 与 `userAccessToken` 二选一；两者都给时 `accessToken` 优先。
   */
  accessToken?: AccessTokenProvider
  /** 静态 token，仅用于测试与一次性诊断脚本。 */
  userAccessToken?: string
  fetchImpl?: DeviceFetchLike
  /**
   * 单次请求超时。
   *
   * 比账号客户端的 15s 短：注册与领取是轮询链路的一环，一次卡 15 秒会让
   * 整个 300 秒窗口少掉好几次尝试。10s 足够覆盖跨洋 RTT + 服务端写入。
   */
  timeoutMs?: number
}

/** token 拿不到（未登录 / 已登出）时内部抛这个，外层归一成 `unauthorized`。 */
class AccessTokenUnavailableError extends Error {
  constructor() {
    super('access token unavailable')
    this.name = 'AccessTokenUnavailableError'
  }
}

export function createHttpDeviceRegistrar(options: HttpDeviceRegistrarOptions): DeviceRegistrar {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as DeviceFetchLike)
  const timeoutMs = options.timeoutMs ?? 10_000

  /**
   * 发一次 JSON 请求。
   *
   * 返回 `{ status, body }`，**不抛**任何带请求内容的错误：调用方只按
   * 状态码归类。解析失败得到 `body = null`，由 schema 判成 `invalid_response`。
   *
   * `bearer` 参数是 1.2B.2.1 加的：轮换用的是**设备** token，与注册/领取用的
   * **用户** token 是两个凭据域。把它做成参数而不是分支，是为了让「这个请求
   * 用哪个身份」在调用点就可见——混用两个域的代价是「用户登出后设备再也
   * 轮换不了」，而那种 bug 只在用户登出时出现。
   */
  const callWithBearer = async (
    path: string,
    body: unknown,
    bearer: { kind: 'user' } | { kind: 'device'; token: string },
  ): Promise<{ status: number; body: unknown }> => {
    if (!fetchImpl) throw new Error('fetch is not available')

    let token: string
    if (bearer.kind === 'device') {
      token = bearer.token
    } else if (options.accessToken) {
      // **每次请求前**取 token：不缓存、不传递 refresh token。
      try {
        token = await options.accessToken()
      } catch {
        // 未登录 / 已登出：这不是网络错误，重试一万次也不会好。
        throw new AccessTokenUnavailableError()
      }
    } else {
      token = options.userAccessToken ?? ''
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json'
      }
      // 没有 token 时不发空的 `Bearer `——服务端会把它当成畸形头。
      if (token) headers.authorization = `Bearer ${token}`

      const res = await fetchImpl(`${httpOrigin(options.origin)}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        // 不跟随重定向：302 会把请求体（含 claim_secret / 签名）带到别的主机去。
        redirect: 'manual'
      })
      let text = ''
      try {
        text = await res.text()
      } catch {
        return { status: res.status, body: null }
      }
      return { status: res.status, body: parseJson(text) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 用户凭据域的调用（注册 / 领取）。 */
  const call = (path: string, body: unknown) => callWithBearer(path, body, { kind: 'user' })

  return {
    async register(input) {
      let res: { status: number; body: unknown }
      try {
        res = await call('/mcp-devices/register', {
          name: input.name,
          platform: input.platform,
          public_key: input.publicKey,
          app_version: input.appVersion
        })
      } catch (error) {
        if (error instanceof AccessTokenUnavailableError) return { ok: false, reason: 'unauthorized' }
        return { ok: false, reason: 'network' }
      }
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' }
      if (res.status === 429) return { ok: false, reason: 'device_limit' }
      if (res.status === 409) return { ok: false, reason: 'device_exists' }
      if (res.status === 400) return { ok: false, reason: 'invalid_public_key' }
      if (res.status !== 200 && res.status !== 201) return { ok: false, reason: 'invalid_response' }

      const parsed = remoteDeviceRegisterResponseSchema.safeParse(res.body)
      if (!parsed.success) return { ok: false, reason: 'invalid_response' }
      return {
        ok: true,
        deviceId: parsed.data.device_id,
        confirmCode: parsed.data.confirm_code,
        claimSecret: parsed.data.claim_secret,
        // 用 expires_in 而不是服务端时间：Desktop 与服务端的时钟可能有偏差，
        // 而「还剩多久」是相对量，不受偏差影响。
        expiresAt: Date.now() + parsed.data.expires_in * 1000
      }
    },

    async claim(input) {
      let res: { status: number; body: unknown }
      try {
        res = await call(`/mcp-devices/${encodeURIComponent(input.deviceId)}/credentials`, {
          claim_secret: input.claimSecret
        })
      } catch (error) {
        if (error instanceof AccessTokenUnavailableError) {
          return { ok: false, reason: 'unauthorized', retryable: false }
        }
        // 网络失败可重试：轮询期间断一下不代表注册失败。
        return { ok: false, reason: 'network', retryable: true }
      }

      // 202 = 用户还没确认完，继续轮询。**不能**把它归成错误：
      // 那条路径上「等用户点确认」才是常态。
      if (res.status === 202) return { ok: false, reason: 'pending', retryable: true }
      if (res.status === 410) return { ok: false, reason: 'expired', retryable: false }
      if (res.status === 403 || res.status === 404 || res.status === 409) {
        return { ok: false, reason: 'claim_rejected', retryable: false }
      }
      if (res.status === 401) return { ok: false, reason: 'unauthorized', retryable: false }
      if (res.status !== 200) return { ok: false, reason: 'invalid_response', retryable: false }

      const parsed = remoteDeviceCredentialsResponseSchema.safeParse(res.body)
      if (!parsed.success) return { ok: false, reason: 'invalid_response', retryable: false }
      // 形态兜底：schema 已经用共享正则校验过，这里再断言一次是为了让
      // 「Cloud 发了奇怪的东西」在类型层也停住（Desktop 的握手只认这个前缀）。
      if (!REMOTE_DEVICE_TOKEN_PATTERN.test(parsed.data.device_token)) {
        return { ok: false, reason: 'invalid_response', retryable: false }
      }
      return { ok: true, deviceToken: parsed.data.device_token, expiresAt: parsed.data.expires_at }
    },

    /**
     * 轮换（协议 §3.5）。
     *
     * 三条纪律与 register/claim 一致：AbortController 超时、`redirect: 'manual'`、
     * 错误只按状态码归类且**不带任何请求内容**。
     *
     * 状态码映射刻意比 claim 更细：轮换失败时 Desktop 要决定「blocked 并重新
     * 配对」还是「提示用户开开关」，把 401/409/404 混成一个 `rejected` 会让那个
     * 决定失去依据。
     */
    async rotate(input) {
      let res: { status: number; body: unknown }
      try {
        res = await callWithBearer(
          `/mcp-devices/${encodeURIComponent(input.deviceId)}/rotate`,
          {
            new_public_key: input.newPublicKey,
            ts: input.ts,
            sig: input.signature
          },
          // **设备**凭据域：这里绝不能用用户 access token。
          { kind: 'device', token: input.oldDeviceToken }
        )
      } catch {
        // 网络失败：结果**未知**（Cloud 可能已经提交）。
        // 这个区分是整条轮换链路最重要的一个：调用方必须据此进入 blocked，
        // 而不是拿旧 token 再试一次。
        return { ok: false, reason: 'network' }
      }

      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' }
      if (res.status === 404) return { ok: false, reason: 'not_found' }
      if (res.status === 409) return { ok: false, reason: 'device_state' }
      if (res.status === 429) return { ok: false, reason: 'rate_limited' }
      if (res.status === 400) return { ok: false, reason: 'invalid_public_key' }
      if (res.status !== 200) return { ok: false, reason: 'invalid_response' }

      const parsed = remoteDeviceRotateResponseSchema.safeParse(res.body)
      if (!parsed.success) return { ok: false, reason: 'invalid_response' }
      if (!REMOTE_DEVICE_TOKEN_PATTERN.test(parsed.data.device_token)) {
        return { ok: false, reason: 'invalid_response' }
      }
      return { ok: true, deviceToken: parsed.data.device_token, expiresAt: parsed.data.expires_at }
    }
  }
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** `https://host` → `https://host`；`wss://host` → `https://host`。测试用 http。 */
function httpOrigin(origin: string): string {
  try {
    const url = new URL(origin)
    if (url.protocol === 'wss:') url.protocol = 'https:'
    if (url.protocol === 'ws:') url.protocol = 'http:'
    return url.origin
  } catch {
    return origin
  }
}
