import {
  REMOTE_CACHE_MAX_BYTES,
  REMOTE_CACHE_MAX_ENTRIES,
  REMOTE_CACHE_TTL_MS
} from '../../shared/contracts/remote'

/**
 * 结果缓存：键 = `(grant_ctx, delivery_id)`。
 *
 * ## 为什么键里必须有 grant_ctx
 *
 * 分键解决的是「A 的结果不被 B 命中」。只按 `delivery_id` 分键时，同一设备上
 * 两个 MCP Client 的同名 id 会互相命中——其中一方拿到的是**另一个授权主体**
 * 才能读的数据。
 *
 * ## 为什么缓存必须在准入之后
 *
 * 先查缓存直接回放，会让「已关开关 / scope 已收紧 / 设备已撤销 / grant 已撤销」
 * 全部失效——AI 仍能拿到关开关之前的旧数据。这是最隐蔽的越权路径，
 * 所以查询入口由 `request-handler` 放在准入链第 9 步，本文件只负责存取。
 *
 * ## 存什么
 *
 * 命中回放必须与首次发送的帧**逐字节等价**，所以存的是完整 `data` / `error`，
 * 外加 `requestHash`（判断同 id 是否被换了内容）。
 *
 * 错误也缓存：判据不是「成功 vs 失败」，而是「我们是否真的发出了这个 `res`」。
 * 唯一不缓存的是「已过 deadline 因而根本没发」的情况——那里没有可回放的帧。
 */

export type CachedResult =
  | { state: 'done'; requestHash: string; ok: true; data: unknown; completedAtMono: number; durationMs: number; bytes: number }
  | { state: 'done'; requestHash: string; ok: false; error: { code: string; message: string; retryable: boolean }; completedAtMono: number; durationMs: number; bytes: number }
  | { state: 'inflight'; requestHash: string; startedAtMono: number }

export type CacheSnapshot = {
  entries: number
  bytes: number
  inflight: number
}

/** 落缓存时传入的结果（`bytes` 由缓存自己算）。 */
export type CachePutValue =
  | { requestHash: string; ok: true; data: unknown; completedAtMono: number; durationMs: number }
  | {
      requestHash: string
      ok: false
      error: { code: string; message: string; retryable: boolean }
      completedAtMono: number
      durationMs: number
    }

export type ResultCache = {
  /** 只读查询；**调用方必须先完成全部准入检查**。 */
  get(key: string): CachedResult | undefined
  /** 占位。返回 false 表示同键已有 inflight——调用方按协议拒绝该次投递。 */
  beginInflight(key: string, requestHash: string): boolean
  /** 落结果（成功或失败都落）。会替换 inflight 占位。 */
  put(key: string, result: CachePutValue): void
  /** 撤销/更新某个 grant 时清掉它的全部条目；返回清除数。 */
  dropGrantContext(grantCtx: string): number
  /** 关闭开关、断线、用户切换：整体清空（含 inflight 占位）。 */
  clear(): void
  /** 惰性淘汰：按 TTL 与双上限。 */
  sweep(nowMono: number): void
  snapshot(): CacheSnapshot
}

/** 键的构造必须集中在一处，避免实现里出现第二种拼法。 */
export function cacheKey(grantCtx: string, deliveryId: string): string {
  return `${grantCtx}\u0000${deliveryId}`
}

function grantCtxOf(key: string): string {
  const index = key.indexOf('\u0000')
  return index === -1 ? key : key.slice(0, index)
}

/** 粗估字节数：只用于上限判断，不要求精确。 */
function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return 1024
  }
}

export function createResultCache(options?: {
  maxEntries?: number
  maxBytes?: number
  ttlMs?: number
}): ResultCache {
  const maxEntries = options?.maxEntries ?? REMOTE_CACHE_MAX_ENTRIES
  const maxBytes = options?.maxBytes ?? REMOTE_CACHE_MAX_BYTES
  const ttlMs = options?.ttlMs ?? REMOTE_CACHE_TTL_MS

  /** Map 的插入顺序即 LRU 顺序：命中时 delete + set 会移到末尾。 */
  const entries = new Map<string, CachedResult>()
  let totalBytes = 0

  const remove = (key: string): void => {
    const existing = entries.get(key)
    if (existing && existing.state === 'done') totalBytes -= existing.bytes
    entries.delete(key)
  }

  const evict = (): void => {
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      remove(oldest)
    }
  }

  return {
    get(key) {
      const found = entries.get(key)
      if (!found) return undefined
      // 命中即刷新 LRU 位置（inflight 不参与字节统计，但也要保序）。
      entries.delete(key)
      entries.set(key, found)
      return found
    },

    beginInflight(key, requestHash) {
      const existing = entries.get(key)
      if (existing && existing.state === 'inflight') return false
      if (existing) remove(key)
      entries.set(key, { state: 'inflight', requestHash, startedAtMono: performance.now() })
      evict()
      return true
    },

    put(key, result) {
      remove(key)
      if (result.ok) {
        const bytes = estimateBytes(result.data)
        entries.set(key, { ...result, state: 'done', bytes })
        totalBytes += bytes
      } else {
        const bytes = estimateBytes(result.error)
        entries.set(key, { ...result, state: 'done', bytes })
        totalBytes += bytes
      }
      evict()
    },

    dropGrantContext(grantCtx) {
      let dropped = 0
      for (const key of [...entries.keys()]) {
        if (grantCtxOf(key) === grantCtx) {
          remove(key)
          dropped += 1
        }
      }
      return dropped
    },

    clear() {
      entries.clear()
      totalBytes = 0
    },

    sweep(nowMono) {
      for (const [key, value] of [...entries]) {
        const startedAt = value.state === 'done' ? value.completedAtMono : value.startedAtMono
        if (nowMono - startedAt > ttlMs) remove(key)
      }
      evict()
    },

    snapshot() {
      let inflight = 0
      for (const value of entries.values()) if (value.state === 'inflight') inflight += 1
      return { entries: entries.size, bytes: totalBytes, inflight }
    }
  }
}
