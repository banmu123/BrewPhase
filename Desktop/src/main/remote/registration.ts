import {
  remoteDeviceCredentialsResponseSchema,
  remoteDeviceRegisterResponseSchema,
  type RemoteRegistrationFailure
} from '../../shared/contracts/remote'

/**
 * 设备注册客户端（协议 §3，**HTTPS，不是 WSS**）。
 *
 * 注册不能走 WSS：设备还没有身份，而 WSS 的认证恰恰依赖注册的结果。
 *
 * ## 这一层为什么做成可注入的接口
 *
 * 真实 Cloud 的 `/mcp-devices/register` 要求 **用户 Bearer**（`verifyAccessToken`）。
 * Desktop 的用户 access token 在 `account/credentials.ts` 里，而 Remote 刻意
 * **拿不到**它（凭据域分离，安全 §2.6）。所以「谁来出示用户 Bearer」是一个
 * 必须由上层决定的问题，Phase 1.2 会把它接到 AccountService 上。
 *
 * 在 Phase 1.1B.1 里：
 * - 生产环境**没有**默认实现 → `register()` 明确报「尚未接入」，不假装成功；
 * - 测试注入 `createHttpDeviceRegistrar()` 打到 Mock Gateway 的本地端点。
 *
 * 这样既不把假 Cloud 塞进生产代码，又能把「密钥 → 确认码 → claim → token →
 * 落盘」这条链路真跑一遍。
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

export type DeviceRegistrar = {
  register(input: DeviceRegisterInput): Promise<DeviceRegisterResult>
  /**
   * 领取 `device_token`。
   *
   * `claimSecret` 必须走**请求体**，不得进 URL——URL 会进反向代理的 access log
   * （协议 §3.4 的四条传输纪律）。
   */
  claim(input: { deviceId: string; claimSecret: string }): Promise<DeviceClaimResult>
}

/** 只声明用到的部分，便于测试注入假实现。 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export type HttpDeviceRegistrarOptions = {
  /** Cloud origin（`https://…` 或测试用的 `http://127.0.0.1:port`）。 */
  origin: string
  /** 用户 Bearer。Phase 1.1B.1 的 Mock 不接受也不需要它。 */
  userAccessToken?: string
  fetchImpl?: FetchLike
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number
}

export function createHttpDeviceRegistrar(options: HttpDeviceRegistrarOptions): DeviceRegistrar {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const timeoutMs = options.timeoutMs ?? 10_000

  const call = async (path: string, body: unknown): Promise<{ status: number; json: unknown }> => {
    if (!fetchImpl) throw new Error('fetch is not available')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (options.userAccessToken) headers.authorization = `Bearer ${options.userAccessToken}`
      const res = await (fetchImpl as unknown as (
        url: string,
        init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
      ) => ReturnType<FetchLike>)(`${httpOrigin(options.origin)}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      })
      // 解析失败要当成 invalid_response，而不是抛出去——上层只认枚举。
      let json: unknown = null
      try {
        json = await res.json()
      } catch {
        json = null
      }
      return { status: res.status, json }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async register(input) {
      let res: { status: number; json: unknown }
      try {
        res = await call('/mcp-devices/register', {
          name: input.name,
          platform: input.platform,
          public_key: input.publicKey,
          app_version: input.appVersion
        })
      } catch {
        return { ok: false, reason: 'network' }
      }
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' }
      if (res.status === 429) return { ok: false, reason: 'device_limit' }
      if (res.status === 409) return { ok: false, reason: 'device_exists' }
      if (res.status === 400) return { ok: false, reason: 'invalid_public_key' }
      if (res.status !== 200 && res.status !== 201) return { ok: false, reason: 'invalid_response' }

      const parsed = remoteDeviceRegisterResponseSchema.safeParse(res.json)
      if (!parsed.success) return { ok: false, reason: 'invalid_response' }
      return {
        ok: true,
        deviceId: parsed.data.device_id,
        confirmCode: parsed.data.confirm_code,
        claimSecret: parsed.data.claim_secret,
        expiresAt: Date.now() + parsed.data.expires_in * 1000
      }
    },

    async claim(input) {
      let res: { status: number; json: unknown }
      try {
        res = await call(`/mcp-devices/${encodeURIComponent(input.deviceId)}/credentials`, {
          claim_secret: input.claimSecret
        })
      } catch {
        // 网络失败可重试：轮询期间断一下不代表注册失败。
        return { ok: false, reason: 'network', retryable: true }
      }
      // 202 = 用户还没确认完；继续轮询。
      if (res.status === 202 || res.status === 425) {
        return { ok: false, reason: 'pending', retryable: true }
      }
      if (res.status === 410) return { ok: false, reason: 'expired', retryable: false }
      if (res.status === 403 || res.status === 404 || res.status === 409) {
        return { ok: false, reason: 'claim_rejected', retryable: false }
      }
      if (res.status !== 200) return { ok: false, reason: 'invalid_response', retryable: false }

      const parsed = remoteDeviceCredentialsResponseSchema.safeParse(res.json)
      if (!parsed.success) return { ok: false, reason: 'invalid_response', retryable: false }
      return { ok: true, deviceToken: parsed.data.device_token, expiresAt: parsed.data.expires_at }
    }
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
