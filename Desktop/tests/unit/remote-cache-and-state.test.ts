import { describe, expect, it } from 'vitest'
import { backoffDelayMs, shouldResetBackoff, FIRST_RETRY_RANGE_MS } from '../../src/main/remote/reconnect'
import {
  buildStatus,
  canTransition,
  createAuditStatus,
  createLinkState,
  judgeServiceable,
  noteAuditFailure,
  noteAuditSuccess,
  transition
} from '../../src/main/remote/link-state'
import { cacheKey, createResultCache } from '../../src/main/remote/result-cache'
import { REMOTE_BACKOFF_RESET_MS } from '../../src/shared/contracts/remote'

/**
 * 缓存 / 退避 / 状态机 / serviceable。
 *
 * 这三块共同决定「会不会越权」与「会不会把连不上当成能干活的」，
 * 所以断言的是状态与计数，不只是返回值。
 */

describe('结果缓存：键与隔离', () => {
  it('键含 grant_ctx：同 delivery_id 不同 grant 不互相命中（ST-20）', () => {
    const cache = createResultCache()
    const keyA = cacheKey('gc_a', 'req-1')
    const keyB = cacheKey('gc_b', 'req-1')
    expect(keyA).not.toBe(keyB)

    cache.beginInflight(keyA, 'sha256:aa')
    cache.put(keyA, { requestHash: 'sha256:aa', ok: true, data: { secret: 'A' }, completedAtMono: 0, durationMs: 1 })

    expect(cache.get(keyA)?.state).toBe('done')
    // B 完全看不到 A 的结果。
    expect(cache.get(keyB)).toBeUndefined()
  })

  it('同 grant 同 delivery_id 才命中', () => {
    const cache = createResultCache()
    const key = cacheKey('gc_a', 'req-1')
    cache.beginInflight(key, 'sha256:aa')
    cache.put(key, { requestHash: 'sha256:aa', ok: true, data: { v: 1 }, completedAtMono: 0, durationMs: 5 })
    const hit = cache.get(key)
    expect(hit?.state).toBe('done')
    if (hit?.state === 'done' && hit.ok) expect(hit.data).toEqual({ v: 1 })
  })

  it('错误结果也缓存（已发出的帧必须可回放）', () => {
    const cache = createResultCache()
    const key = cacheKey('gc_a', 'req-1')
    cache.beginInflight(key, 'sha256:aa')
    cache.put(key, {
      requestHash: 'sha256:aa',
      ok: false,
      error: { code: 'NOT_FOUND', message: 'record x not found', retryable: false },
      completedAtMono: 0,
      durationMs: 2
    })
    const hit = cache.get(key)
    expect(hit?.state).toBe('done')
    if (hit?.state === 'done' && !hit.ok) expect(hit.error.code).toBe('NOT_FOUND')
  })
})

describe('结果缓存：inflight 占位（ST-7 / ST-30）', () => {
  it('第二次 beginInflight 返回 false（同 id 并发必须被拒）', () => {
    const cache = createResultCache()
    const key = cacheKey('gc_a', 'req-1')
    expect(cache.beginInflight(key, 'sha256:aa')).toBe(true)
    expect(cache.beginInflight(key, 'sha256:aa')).toBe(false)
  })

  it('占位可被读到，调用方据此拒绝重投', () => {
    const cache = createResultCache()
    const key = cacheKey('gc_a', 'req-1')
    cache.beginInflight(key, 'sha256:aa')
    const hit = cache.get(key)
    expect(hit?.state).toBe('inflight')
  })

  it('完成后占位被结果替换', () => {
    const cache = createResultCache()
    const key = cacheKey('gc_a', 'req-1')
    cache.beginInflight(key, 'sha256:aa')
    cache.put(key, { requestHash: 'sha256:aa', ok: true, data: 1, completedAtMono: 0, durationMs: 1 })
    expect(cache.get(key)?.state).toBe('done')
    expect(cache.snapshot().inflight).toBe(0)
  })
})

describe('结果缓存：清理时机', () => {
  it('撤销某个 grant → 只清它的条目', () => {
    const cache = createResultCache()
    const a = cacheKey('gc_a', 'r1')
    const b = cacheKey('gc_b', 'r1')
    cache.put(a, { requestHash: 'h', ok: true, data: 1, completedAtMono: 0, durationMs: 1 })
    cache.put(b, { requestHash: 'h', ok: true, data: 2, completedAtMono: 0, durationMs: 1 })

    expect(cache.dropGrantContext('gc_a')).toBe(1)
    expect(cache.get(a)).toBeUndefined()
    expect(cache.get(b)?.state).toBe('done')
  })

  it('撤销也清 inflight 占位', () => {
    const cache = createResultCache()
    const a = cacheKey('gc_a', 'r1')
    cache.beginInflight(a, 'h')
    cache.dropGrantContext('gc_a')
    expect(cache.get(a)).toBeUndefined()
    expect(cache.snapshot().inflight).toBe(0)
  })

  it('clear() 整体清空（关开关 / 断线 / 用户切换）', () => {
    const cache = createResultCache()
    cache.put(cacheKey('gc_a', 'r1'), { requestHash: 'h', ok: true, data: 1, completedAtMono: 0, durationMs: 1 })
    cache.beginInflight(cacheKey('gc_a', 'r2'), 'h')
    expect(cache.snapshot().entries).toBe(2)
    cache.clear()
    expect(cache.snapshot()).toEqual({ entries: 0, bytes: 0, inflight: 0 })
  })

  it('条数上限：超限淘汰最旧', () => {
    const cache = createResultCache({ maxEntries: 3 })
    for (const id of ['r1', 'r2', 'r3', 'r4']) {
      cache.put(cacheKey('gc_a', id), { requestHash: 'h', ok: true, data: id, completedAtMono: 0, durationMs: 1 })
    }
    expect(cache.snapshot().entries).toBe(3)
    expect(cache.get(cacheKey('gc_a', 'r1'))).toBeUndefined()
    expect(cache.get(cacheKey('gc_a', 'r4'))?.state).toBe('done')
  })

  it('字节上限：大结果也会被淘汰（双上限，缺一不可）', () => {
    const cache = createResultCache({ maxEntries: 100, maxBytes: 200 })
    cache.put(cacheKey('gc_a', 'big'), {
      requestHash: 'h',
      ok: true,
      data: 'x'.repeat(1000),
      completedAtMono: 0,
      durationMs: 1
    })
    // 单个超限：进去后立刻被淘汰，不会把内存撑爆。
    expect(cache.snapshot().bytes).toBeLessThanOrEqual(200)
  })

  it('TTL 过期被清掉', () => {
    const cache = createResultCache({ ttlMs: 100 })
    cache.put(cacheKey('gc_a', 'r1'), { requestHash: 'h', ok: true, data: 1, completedAtMono: 0, durationMs: 1 })
    cache.sweep(1000)
    expect(cache.get(cacheKey('gc_a', 'r1'))).toBeUndefined()
  })

  it('未过期的不被清', () => {
    const cache = createResultCache({ ttlMs: 10_000 })
    cache.put(cacheKey('gc_a', 'r1'), { requestHash: 'h', ok: true, data: 1, completedAtMono: 0, durationMs: 1 })
    cache.sweep(50)
    expect(cache.get(cacheKey('gc_a', 'r1'))?.state).toBe('done')
  })
})

describe('退避（协议 §10.1）', () => {
  it('首次重连延迟落在 [500, 1000] ms 区间（抖动后）', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = backoffDelayMs(1, () => r)
      expect(delay).toBeGreaterThanOrEqual(FIRST_RETRY_RANGE_MS[0] * 0.8)
      expect(delay).toBeLessThanOrEqual(FIRST_RETRY_RANGE_MS[1])
    }
  })

  it('attempt 越大延迟越大，最终封顶', () => {
    const d1 = backoffDelayMs(1, () => 0.5)
    const d3 = backoffDelayMs(3, () => 0.5)
    const d20 = backoffDelayMs(20, () => 0.5)
    expect(d3).toBeGreaterThan(d1)
    expect(d20).toBeLessThanOrEqual(60_000)
    expect(d20).toBeGreaterThanOrEqual(48_000)
  })

  it('抖动是确定的 ±20%，且永不为 0', () => {
    expect(backoffDelayMs(1, () => 0)).toBeGreaterThan(0)
    expect(backoffDelayMs(5, () => 0)).toBeLessThan(backoffDelayMs(5, () => 1))
  })

  it('attempt 0 / 负数按第 1 档处理（不产生 NaN）', () => {
    expect(Number.isFinite(backoffDelayMs(0, () => 0.5))).toBe(true)
    expect(Number.isFinite(backoffDelayMs(-3, () => 0.5))).toBe(true)
  })
})

describe('稳定期重置退避', () => {
  const base = { connectedAtMono: 1_000 }

  it('存活 ≥60s 且收到过 pong → 重置', () => {
    expect(
      shouldResetBackoff({
        connectedAtMono: base.connectedAtMono,
        lastPongAtMono: base.connectedAtMono + 100,
        nowMono: base.connectedAtMono + REMOTE_BACKOFF_RESET_MS
      })
    ).toBe(true)
  })

  it('存活够久但从未 pong → 不重置（半开连接不算稳定）', () => {
    expect(
      shouldResetBackoff({
        connectedAtMono: base.connectedAtMono,
        lastPongAtMono: null,
        nowMono: base.connectedAtMono + REMOTE_BACKOFF_RESET_MS * 2
      })
    ).toBe(false)
  })

  it('pong 早于本次连接（上一条连接的）→ 不重置', () => {
    expect(
      shouldResetBackoff({
        connectedAtMono: 10_000,
        lastPongAtMono: 5_000,
        nowMono: 10_000 + REMOTE_BACKOFF_RESET_MS
      })
    ).toBe(false)
  })

  it('存活不足 60s → 不重置', () => {
    expect(
      shouldResetBackoff({
        connectedAtMono: base.connectedAtMono,
        lastPongAtMono: base.connectedAtMono + 100,
        nowMono: base.connectedAtMono + 59_000
      })
    ).toBe(false)
  })
})

describe('serviceable 判定（三个概念分离）', () => {
  const base = {
    enabled: true,
    boundUserId: 'user-1',
    currentUserId: 'user-1',
    dbReady: true,
    servicesReady: true,
    shuttingDown: false
  }

  it('全部满足才 serviceable', () => {
    expect(judgeServiceable(base)).toEqual({ serviceable: true, reason: null })
  })

  it('开关关 → remote_disabled', () => {
    expect(judgeServiceable({ ...base, enabled: false })).toEqual({
      serviceable: false,
      reason: 'remote_disabled'
    })
  })

  it('用户不匹配 → user_mismatch（ST-4 的底座）', () => {
    expect(judgeServiceable({ ...base, currentUserId: 'user-2' })).toEqual({
      serviceable: false,
      reason: 'user_mismatch'
    })
  })

  it('未登录 / 未配对 → user_mismatch（不是「可服务」）', () => {
    expect(judgeServiceable({ ...base, currentUserId: null }).serviceable).toBe(false)
    expect(judgeServiceable({ ...base, boundUserId: null }).serviceable).toBe(false)
  })

  it('库没就绪 → db_unavailable', () => {
    expect(judgeServiceable({ ...base, dbReady: false })).toEqual({
      serviceable: false,
      reason: 'db_unavailable'
    })
  })

  it('服务没装配 → services_unavailable', () => {
    expect(judgeServiceable({ ...base, servicesReady: false }).reason).toBe('services_unavailable')
  })

  it('正在关闭优先于其它原因', () => {
    expect(judgeServiceable({ ...base, shuttingDown: true }).reason).toBe('shutting_down')
  })
})

describe('状态机', () => {
  it('允许的迁移按文档走', () => {
    expect(canTransition('idle', 'connecting')).toBe(true)
    expect(canTransition('connecting', 'handshaking')).toBe(true)
    expect(canTransition('handshaking', 'online')).toBe(true)
    expect(canTransition('online', 'backoff')).toBe(true)
    expect(canTransition('backoff', 'connecting')).toBe(true)
    expect(canTransition('blocked', 'idle')).toBe(true)
  })

  it('禁止的迁移被拒（不静默跳转）', () => {
    expect(canTransition('idle', 'online')).toBe(false)
    expect(canTransition('online', 'connecting')).toBe(false)
    expect(canTransition('blocked', 'connecting')).toBe(false)
    expect(transition(createLinkState(), 'online')).toBe(false)
  })

  it('blocked 是终态：清掉重连计数', () => {
    const link = createLinkState()
    link.reconnectAttempt = 7
    transition(link, 'blocked', 'user mismatch')
    expect(link.state).toBe('blocked')
    expect(link.blockedReason).toBe('user mismatch')
    expect(link.reconnectAttempt).toBe(0)
  })

  it('回到 online 会清掉 blockedReason', () => {
    const link = createLinkState()
    transition(link, 'connecting')
    transition(link, 'handshaking')
    transition(link, 'online')
    expect(link.blockedReason).toBeNull()
  })
})

describe('审计计数器（进程内状态）', () => {
  it('失败递增、成功清零但保留 lastFailureAt', () => {
    const audit = createAuditStatus()
    expect(audit).toEqual({ consecutiveFailures: 0, totalFailures: 0, lastFailureAt: null })

    noteAuditFailure(audit, 1000)
    noteAuditFailure(audit, 2000)
    expect(audit.consecutiveFailures).toBe(2)
    expect(audit.totalFailures).toBe(2)
    expect(audit.lastFailureAt).toBe(2000)

    noteAuditSuccess(audit)
    expect(audit.consecutiveFailures).toBe(0)
    // 累计失败与最近失败时间都保留：本次进程内的历史仍然可见。
    expect(audit.totalFailures).toBe(2)
    expect(audit.lastFailureAt).toBe(2000)
  })
})

describe('buildStatus 不含凭据', () => {
  it('序列化后没有 token / 私钥 / 参数', () => {
    const link = createLinkState()
    const status = buildStatus({
      link,
      enabled: false,
      deviceId: 'dev-1',
      boundUserId: 'user-1',
      needsReauth: false,
      cloudOrigin: 'https://cloud.example.com',
      verdict: { serviceable: false, reason: 'remote_disabled' },
      grants: [
        {
          grantCtx: 'gc_a',
          clientId: 'chatgpt',
          clientName: 'ChatGPT',
          scopes: ['records:read'],
          epoch: 1
        }
      ],
      grantEpoch: 3,
      audit: { consecutiveFailures: 0, totalFailures: 0, lastFailureAt: null }
    })
    const json = JSON.stringify(status)
    expect(json).not.toContain('bp_dev_')
    expect(json).not.toContain('privateKey')
    expect(json).not.toContain('deviceToken')
    expect(json).not.toContain('claim_secret')
    // 展示层需要的东西都在
    expect(status.grants[0].clientName).toBe('ChatGPT')
    expect(status.deviceId).toBe('dev-1')
  })
})
