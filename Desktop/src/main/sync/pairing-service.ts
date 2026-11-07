import { randomBytes, randomInt } from 'node:crypto'
import { sha256, constantTimeEquals, randomToken } from './auth'
import type { Database } from 'better-sqlite3'

/**
 * 配对服务：一次性高熵配对码（2 分钟），换每设备独立 Token。
 *
 * 安全策略沿用 BrewPing `PairingStore`（实际设备验证过）：
 * - 码**只存哈希**，内存里不保留明文；比较恒定时间；
 * - 「无码可兑」不计入失败（猜一个不存在的码不该把合法用户锁在门外）；
 * - 双维限速：单来源 + 全局，来源有界（256，LRU）；
 * - 配对成功立即消费配对码、清该来源失败记录，并签发独立 token（只落哈希）。
 */
export const PAIRING_TTL_MS = 120_000

export type PairingPayload = { code: string; expiresAt: number }

/** 12 位高熵码：比 6 位数字强 400 万倍以上，扫码场景不需要人手输入。 */
function randomPairingCode(): string {
  return randomBytes(9).toString('base64url').slice(0, 12)
}

type FailureRecord = { failures: number[]; blockedUntil: number; lastSeen: number }

export class PairingService {
  private codeHash: string | null = null
  private issuedAt = 0
  private readonly failuresBySource = new Map<string, FailureRecord>()
  private globalFailures: number[] = []
  private globalBlockedUntil = 0

  private readonly windowMs = 300_000
  private readonly maxPerSource = 5
  private readonly maxGlobal = 30
  private readonly cooldownMs = 60_000
  private readonly maxSources = 256

  /** 生成（或复用未过期的）配对码。 */
  issue(): PairingPayload {
    const now = Date.now()
    if (this.codeHash && now - this.issuedAt < PAIRING_TTL_MS) {
      return { code: this.currentCode, expiresAt: this.issuedAt + PAIRING_TTL_MS }
    }
    const code = randomPairingCode()
    this.currentCode = code
    this.codeHash = sha256(code)
    this.issuedAt = now
    return { code, expiresAt: now + PAIRING_TTL_MS }
  }

  private currentCode = ''

  /** 作废当前码并换新的（用户怀疑泄露时一键换）。 */
  rotate(): PairingPayload {
    this.codeHash = null
    return this.issue()
  }

  private cooldownRemaining(source: string, now: number): number | null {
    if (this.globalBlockedUntil > now) return this.globalBlockedUntil - now
    const record = this.failuresBySource.get(source)
    if (!record || record.blockedUntil <= now) return null
    return record.blockedUntil - now
  }

  private recordFailure(source: string, now: number): void {
    const cutoff = now - this.windowMs
    const record = this.failuresBySource.get(source) ?? { failures: [], blockedUntil: 0, lastSeen: now }
    record.failures = record.failures.filter((at) => at > cutoff)
    record.failures.push(now)
    record.lastSeen = now
    if (record.failures.length >= this.maxPerSource) {
      record.blockedUntil = now + this.cooldownMs
      record.failures = []
    }
    this.failuresBySource.set(source, record)

    this.globalFailures = this.globalFailures.filter((at) => at > cutoff)
    this.globalFailures.push(now)
    if (this.globalFailures.length >= this.maxGlobal) {
      this.globalBlockedUntil = now + this.cooldownMs
      this.globalFailures = []
    }
    this.prune(now)
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    for (const [key, record] of this.failuresBySource) {
      if (record.blockedUntil <= now && record.failures.every((at) => at <= cutoff)) {
        this.failuresBySource.delete(key)
      }
    }
    if (this.failuresBySource.size <= this.maxSources) return
    const ordered = [...this.failuresBySource.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    for (const [key] of ordered.slice(0, this.failuresBySource.size - this.maxSources)) {
      this.failuresBySource.delete(key)
    }
  }

  /**
   * 用配对码换 Token。`source` 是对端地址（限速分桶，nil 归 "unknown" 桶，
   * 不给「没地址就不限速」留缺口）。
   */
  exchange(
    code: string,
    source: string | null,
    deviceName: string,
    sqlite: Database,
    now = Date.now()
  ): { ok: true; token: string; deviceId: string } | { ok: false; status: number; error: string } {
    const sourceKey = source && source.length > 0 ? source : 'unknown'
    const cooldown = this.cooldownRemaining(sourceKey, now)
    if (cooldown !== null) {
      return { ok: false, status: 429, error: `rate limited, retry in ${Math.ceil(cooldown / 1000)}s` }
    }
    if (!this.codeHash || now - this.issuedAt >= PAIRING_TTL_MS) {
      return { ok: false, status: 401, error: 'invalid pairing code' }
    }
    const trimmed = code.trim()
    if (!constantTimeEquals(sha256(trimmed), this.codeHash)) {
      this.recordFailure(sourceKey, now)
      return { ok: false, status: 401, error: 'invalid pairing code' }
    }

    // 成功：码立即作废，签发这台设备专属 token（库里只存哈希）。
    this.codeHash = null
    this.currentCode = ''
    this.failuresBySource.delete(sourceKey)

    const token = randomToken()
    const deviceId = `bp_ios_${randomBytes(6).toString('hex')}`
    sqlite
      .prepare(
        `insert into devices (id, name, kind, token_hash, paired_at) values (?, ?, 'ios', ?, ?)`
      )
      .run(deviceId, sanitizeDeviceName(deviceName), sha256(token), now)
    return { ok: true, token, deviceId }
  }
}

function sanitizeDeviceName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : ''
  return (value.length > 0 ? value : 'iPhone').slice(0, 64)
}

/** 测试辅助：六位数字码（仅单测使用，运行时走高熵码）。 */
export function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}
