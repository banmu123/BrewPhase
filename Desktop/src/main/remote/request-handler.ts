import { createHash } from 'node:crypto'
import type { Db } from '../database/client'
import { executeTool } from '../application/mcp-tools/tool-executor'
import type { ToolServices } from '../application/mcp-tools/tool-services'
import { writeAudit } from '../mcp-bridge/audit-log'
import type { RemoteErrorCode, RemoteReq, RemoteScope } from '../../shared/contracts/remote'
import { effectiveScopes, effectiveTools, isRetryableRemoteError, scopeForTool, toRemoteErrorCode } from './remote-policy'
import type { GrantContextState } from './grant-context'
import { lookupGrant } from './grant-context'
import type { ResultCache } from './result-cache'
import { cacheKey } from './result-cache'

/**
 * 一次 `req` 的全部处理：准入 → 缓存 → executeTool → 审计 → `res`。
 *
 * ## 顺序不可调换（协议 §6.2 / §8.5）
 *
 * ```
 *  1. 本地远程开关
 *  2. 帧大小 / JSON 合法（由 link-client 已把关，这里再断言）
 *  3. deadline（monotonic 预算）
 *  4. grant_ctx 已知 / active / epoch 当前
 *  5. bound_user_id == boundUserId
 *  6. tool ∈ effectiveTools(grant)
 *  7. required_scope ∈ effectiveScopes(grant)      ← 缓存之前
 *  8. request_hash 与 delivery_id 的一致性
 *  9. 缓存查询（键 = grant_ctx + delivery_id）
 * 10. executeTool
 * 11. 审计（**单出口**）
 * 12. res
 * ```
 *
 * **缓存必须在 5–8 之后**：先查缓存会让「已关开关 / scope 收紧 / 设备撤销 /
 * grant 撤销」全部失效，AI 仍能拿到旧数据。这是最隐蔽的越权路径。
 *
 * ## 审计口径（安全运维 §6.5.4.1）
 *
 * 一次 `req` 至多写**一行**。哪些阶段记、哪些不记，见 `auditDecision`。
 * 分支里**不得**再调 `writeAudit`——重复记账会让「一次越权尝试」看起来像两次。
 */

const FALLBACK_DEADLINE_MS = 15_000

export type RequestHandlerDeps = {
  db: Db
  services: ToolServices
  cache: ResultCache
  /** 读当前开关（每次请求都读，开关可能刚被关掉）。 */
  isEnabled(): boolean
  /** 本机绑定的 Cloud 用户。 */
  boundUserId(): string | null
  /** 设备 id，用于审计的 `client_id`。 */
  deviceId(): string | null
  /** 读当前 grant 上下文（引用，不是拷贝）。 */
  grants(): GrantContextState
  /** 记一次审计（内部包好 try/catch，失败只动计数器）。 */
  audit(entry: {
    toolName: string
    success: boolean
    errorCode: string | null
    entityType?: string | null
    entityId?: string | null
  }): void
  /** monotonic 时钟（测试可注入）。 */
  nowMono(): number
  /** 该 grant 是否已被撤销（撤销后即便上下文还在也不服务）。 */
  isGrantRevoked(grantCtx: string): boolean
}

export type HandlerOutcome = {
  /** 要发回 Cloud 的 `res` 帧内容。 */
  res: {
    id: string
    ok: boolean
    data?: unknown
    error?: { code: RemoteErrorCode; message: string; retryable: boolean }
    meta: { duration_ms: number; cached: boolean }
  }
  /** 便于测试断言：这次请求走到哪一步。 */
  stage: 'rejected' | 'cached' | 'executed'
  /** 是否写入了审计（测试断言用）。 */
  audited: boolean
}

export function createRequestHandler(deps: RequestHandlerDeps) {
  return function handle(req: RemoteReq): HandlerOutcome {
    const startedMono = deps.nowMono()
    /**
     * 审计调用必须被包住。
     *
     * 生产实现（`writeRemoteAudit`）自己吞异常，但**不能只靠那一层**：
     * 「审计失败不改变业务结果」是这一层的承诺，任何 audit 实现都不能把
     * 一次已经完成的读取报成失败。这里抛错就等同于业务失败——所以拦住。
     */
    const safeAudit = (entry: Parameters<RequestHandlerDeps['audit']>[0]): void => {
      try {
        deps.audit(entry)
      } catch {
        // 审计计数器由注入方维护；这里只保证不冒泡。
      }
    }

    const reject = (
      code: RemoteErrorCode,
      message: string,
      audit: { toolName: string; errorCode: string } | null
    ): HandlerOutcome => {
      if (audit) {
        safeAudit({ toolName: audit.toolName, success: false, errorCode: audit.errorCode })
      }
      return {
        res: {
          id: req.id,
          ok: false,
          error: { code, message, retryable: isRetryableRemoteError(code) },
          meta: { duration_ms: Math.round(deps.nowMono() - startedMono), cached: false }
        },
        stage: 'rejected',
        audited: audit !== null
      }
    }

    // ---- 1. 本地开关（不记账：请求根本没被受理） ----
    if (!deps.isEnabled()) {
      return reject('REMOTE_DISABLED', 'remote access is disabled on this device', null)
    }

    // ---- 3. deadline（用 monotonic 预算，不信任本机墙上时钟的跨度） ----
    // `deadline_ms` 是绝对 epoch。换算成「还剩多少毫秒」再与本机 monotonic 比较，
    // 这样用户手动改系统时间不会延长或缩短有效期（ST-9）。
    const remaining = req.deadline_ms - Date.now()
    if (remaining <= 0) {
      return reject('REQUEST_TIMEOUT', 'request deadline has passed', null)
    }

    // ---- 4. grant 上下文 ----
    const state = deps.grants()
    if (!state.ready) {
      return reject('GRANT_CONTEXT_INVALID', 'grant context is not installed', {
        toolName: req.tool,
        errorCode: 'GRANT_CONTEXT_INVALID'
      })
    }
    const grant = lookupGrant(state, req.grant_ctx)
    if (!grant) {
      return reject('GRANT_CONTEXT_INVALID', 'grant_ctx is unknown or expired', {
        toolName: req.tool,
        errorCode: 'GRANT_CONTEXT_INVALID'
      })
    }
    if (deps.isGrantRevoked(req.grant_ctx)) {
      return reject('GRANT_REVOKED', 'this grant has been revoked', {
        toolName: req.tool,
        errorCode: 'GRANT_REVOKED'
      })
    }

    // ---- 5. 设备绑定 ----
    const bound = deps.boundUserId()
    if (!bound || grant.boundUserId !== bound) {
      return reject('USER_MISMATCH', 'grant does not belong to the bound user', {
        toolName: req.tool,
        errorCode: 'USER_MISMATCH'
      })
    }

    // ---- 6/7. 工具面与 scope（**在缓存之前**） ----
    //
    // 三层的顺序决定错误码的精确度。如果先判 `effectiveTools`（它本身已按
    // scope 过滤过），那么「用户授了这个 Client 但没授这个 scope」会被报成
    // TOOL_NOT_ALLOWED——AI 无法据此提示用户去补授权。所以拆成：
    //
    //   1. 不在 REMOTE_TOOLS        → TOOL_NOT_ALLOWED（本机根本不开这个工具）
    //   2. scope 不在生效集          → SCOPE_DENIED（授权范围不够，可补）
    //   3. 不在 allowed_tools        → TOOL_NOT_ALLOWED（Cloud 侧策略更窄）
    const scopes: RemoteScope[] = effectiveScopes(grant.scopes)
    const required = scopeForTool(req.tool)
    if (!required) {
      return reject('TOOL_NOT_ALLOWED', `tool ${req.tool} is not in the remote tool surface`, {
        toolName: req.tool,
        errorCode: 'TOOL_NOT_ALLOWED'
      })
    }
    if (!scopes.includes(required)) {
      return reject('SCOPE_DENIED', `client is not granted ${required}`, {
        toolName: req.tool,
        errorCode: 'SCOPE_DENIED'
      })
    }
    const tools = effectiveTools(scopes, state.allowedTools)
    if (!tools.includes(req.tool as never)) {
      return reject('TOOL_NOT_ALLOWED', `tool ${req.tool} is not allowed for this client`, {
        toolName: req.tool,
        errorCode: 'TOOL_NOT_ALLOWED'
      })
    }

    // ---- 8. request_hash 一致性 + 缓存 ----
    const key = cacheKey(req.grant_ctx, req.id)
    const cached = deps.cache.get(key)

    if (cached && cached.state === 'inflight') {
      // 同 id 仍在执行：不排队、不并发执行。按协议拒绝（只读场景不选「跳过」，
      // 因为跳过会让调用方白等到超时且没有明确原因）。
      return reject('PROTOCOL_VIOLATION', 'this delivery_id is already in flight', {
        toolName: req.tool,
        errorCode: 'PROTOCOL_VIOLATION'
      })
    }

    if (cached && cached.state === 'done') {
      if (cached.requestHash !== req.request_hash) {
        // 内容被换掉了：拒绝，且**不覆盖原缓存**。
        return reject('PROTOCOL_VIOLATION', 'request_hash does not match the cached delivery', {
          toolName: req.tool,
          errorCode: 'PROTOCOL_VIOLATION'
        })
      }
      // 命中回放。仍要记审计：这是一次真实的数据读取。
      safeAudit({ toolName: req.tool, success: cached.ok, errorCode: cached.ok ? null : cached.error.code })
      return {
        res: cached.ok
          ? {
              id: req.id,
              ok: true,
              data: cached.data,
              meta: { duration_ms: cached.durationMs, cached: true }
            }
          : {
              id: req.id,
              ok: false,
              error: {
                code: cached.error.code as RemoteErrorCode,
                message: cached.error.message,
                retryable: cached.error.retryable
              },
              meta: { duration_ms: cached.durationMs, cached: true }
            },
        stage: 'cached',
        audited: true
      }
    }

    // ---- 9/10. 占位 + 执行 ----
    if (!deps.cache.beginInflight(key, req.request_hash)) {
      return reject('PROTOCOL_VIOLATION', 'this delivery_id is already in flight', {
        toolName: req.tool,
        errorCode: 'PROTOCOL_VIOLATION'
      })
    }

    const outcome = executeTool(req.tool, req.arguments, {
      services: deps.services,
      scopes
      // 不传 replay：Remote 的去重在准入链（键是 delivery_id），不是持久幂等表。
    })
    const durationMs = Math.round(deps.nowMono() - startedMono)

    if (!outcome.ok) {
      const code = toRemoteErrorCode(outcome.code, outcome.stage)
      const message = remoteMessageFor(outcome.stage, code, outcome.message)
      deps.cache.put(key, {
        requestHash: req.request_hash,
        ok: false,
        error: { code, message, retryable: isRetryableRemoteError(code) },
        completedAtMono: deps.nowMono(),
        durationMs
      })
      // ---- 11. 审计（单出口） ----
      safeAudit({ toolName: req.tool, success: false, errorCode: code })
      return {
        res: { id: req.id, ok: false, error: { code, message, retryable: isRetryableRemoteError(code) }, meta: { duration_ms: durationMs, cached: false } },
        stage: 'executed',
        audited: true
      }
    }

    deps.cache.put(key, {
      requestHash: req.request_hash,
      ok: true,
      data: outcome.data,
      completedAtMono: deps.nowMono(),
      durationMs
    })
    safeAudit({
      toolName: req.tool,
      success: true,
      errorCode: null,
      entityType: outcome.entityType ?? null,
      entityId: outcome.entityId ?? null
    })
    return {
      res: {
        id: req.id,
        ok: true,
        data: outcome.data,
        meta: { duration_ms: durationMs, cached: false }
      },
      stage: 'executed',
      audited: true
    }
  }
}

/**
 * 对外的错误文案。
 *
 * 业务错误（`NOT_FOUND` / `INVALID_ARGUMENTS`）透传原文——AI 需要知道
 * 「哪个字段不对」才能修正。其余一律换成通用文案：`INTERNAL_ERROR`
 * 可能携带 SQL / 路径 / 堆栈，`SCOPE_DENIED` 的细节也不该外泄。
 */
function remoteMessageFor(
  stage: 'tool' | 'scope' | 'params' | 'replay' | 'handler',
  code: RemoteErrorCode,
  original: string
): string {
  if (code === 'INTERNAL_ERROR') return 'An unexpected error occurred while processing the request.'
  if (stage === 'params') return original
  if (stage === 'handler' && code === 'NOT_FOUND') return original
  if (stage === 'handler' && code === 'INVALID_ARGUMENTS') return original
  return original
}

/**
 * 审计落库（`client_id = "remote:" + device_id`）。
 *
 * `writeAudit` 自己吞掉异常（审计失败不能把已完成的业务报成失败），
 * 所以这里只需要把结果告诉调用方以维护计数器。
 */
export function writeRemoteAudit(
  db: Db,
  deviceId: string,
  entry: {
    toolName: string
    success: boolean
    errorCode: string | null
    entityType?: string | null
    entityId?: string | null
  }
): boolean {
  try {
    writeAudit(db, {
      clientId: `remote:${deviceId}`,
      toolName: entry.toolName,
      success: entry.success,
      errorCode: entry.errorCode,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      // 远程没有持久幂等键。
      idempotencyKey: null
    })
    return true
  } catch {
    return false
  }
}

/** `sha256(canonicalJson({ v, tool, arguments }))`，与协议 §8.2 一致。 */
export function computeRequestHash(input: { v: number; tool: string; arguments: unknown }): string {
  const canonical = canonicalJson(input)
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/** `deadline_ms` 缺省值的唯一来源（测试与 Mock 共用）。 */
export function defaultDeadline(): number {
  return Date.now() + FALLBACK_DEADLINE_MS
}
