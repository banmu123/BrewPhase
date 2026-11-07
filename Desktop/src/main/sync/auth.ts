import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * 请求鉴权原语。设计沿用 BrewPing `PairingStore` 的已验证经验：
 * - Bearer token 做设备身份，服务端只存 sha256(token)；
 * - 写操作要求 timestamp + nonce 防重放（GET 豁免，重放无害）；
 * - 恒定时间比较，避免按字节提前返回泄露前缀；
 * - nonce 记忆有界（2048，过期清理 + 淘汰最旧一半）。
 *
 * 相对 BrewPing 的增强：写操作额外要求 HMAC-SHA256 签名
 * （token 作为密钥，覆盖 timestamp/nonce/bodyHash），防止同网段只读
 * 嗅探后重放写请求。TLS 是下一跳（协议字段已预留，见 SYNC_PROTOCOL.md）。
 */

export const REPLAY_WINDOW_MS = 120_000
const MAX_NONCES = 2048

/** 32 字节系统随机数 → 64 位 hex。与 BrewPing 同一量级。 */
export function randomToken(): string {
  return randomBytes(32).toString('hex')
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 恒定时间比较；长度不同直接 false（长度本身不是秘密）。 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/**
 * 写请求签名：`HMAC_SHA256(key = token, message = timestamp \n nonce \n bodyHash)`。
 * iOS 侧 `SyncNetworkClient` 用同一公式。
 */
export function expectedSignature(token: string, timestamp: string, nonce: string, bodyHash: string): string {
  return createHmac('sha256', token).update(`${timestamp}\n${nonce}\n${bodyHash}`).digest('hex')
}

/** 有界 nonce 记忆。 */
export class NonceStore {
  private readonly seen = new Map<string, number>()
  private readonly windowMs: number

  constructor(windowMs = REPLAY_WINDOW_MS) {
    this.windowMs = windowMs
  }

  /** 记录并判断是否重放。重放的 nonce 不会被二次记录。 */
  checkAndRecord(nonce: string, now = Date.now()): boolean {
    this.prune(now)
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, now)
    return true
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    for (const [nonce, at] of this.seen) {
      if (at <= cutoff) this.seen.delete(nonce)
    }
    if (this.seen.size <= MAX_NONCES) return
    const ordered = [...this.seen.entries()].sort((a, b) => a[1] - b[1])
    for (const [nonce] of ordered.slice(0, Math.floor(ordered.length / 2))) {
      this.seen.delete(nonce)
    }
  }
}

export type AuthInput = {
  method: string
  token: string | null
  timestamp: string | null
  nonce: string | null
  signature: string | null
  body: Buffer
  nonceStore: NonceStore
  now?: number
}

export type AuthResult = { ok: true; token: string } | { ok: false; status: number; error: string }

/**
 * 校验一个已匹配到设备的请求。`expectedToken` 是**明文 token**（内存中校验后
 * 立即丢弃）；持久化层永远只有它的哈希。
 */
export function verifyRequest(input: AuthInput, expectedToken: string): AuthResult {
  const { method, token, timestamp, nonce, signature, body, nonceStore } = input
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' }
  if (!constantTimeEquals(token, expectedToken)) {
    return { ok: false, status: 401, error: 'invalid token' }
  }
  if (method === 'GET') return { ok: true, token } // 只读：重放无害

  const now = input.now ?? Date.now()
  if (!timestamp || !nonce || !signature) {
    return { ok: false, status: 401, error: 'missing timestamp/nonce/signature' }
  }
  const issued = Number(timestamp)
  if (!Number.isFinite(issued) || Math.abs(now - issued) > REPLAY_WINDOW_MS) {
    return { ok: false, status: 401, error: 'stale request' }
  }
  if (!nonceStore.checkAndRecord(nonce, now)) {
    return { ok: false, status: 401, error: 'replayed nonce' }
  }
  const expected = expectedSignature(expectedToken, timestamp, nonce, sha256(body))
  if (!constantTimeEquals(signature, expected)) {
    return { ok: false, status: 401, error: 'invalid signature' }
  }
  return { ok: true, token }
}
