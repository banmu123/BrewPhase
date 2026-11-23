import { createHash } from 'node:crypto'
import type { Db } from '../database/client'
import { executeTool } from '../application/mcp-tools/tool-executor'
import type { ToolServices } from '../application/mcp-tools/tool-services'
import { writeAuditResult } from '../mcp-bridge/audit-log'
import type { RemoteErrorCode, RemoteReq, RemoteScope } from '../../shared/contracts/remote'
import type { ToolExecutionContext } from '../../shared/contracts/mcp'
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
 *  1. 本地远程开关 / draining
 *  2. 帧大小 / JSON 合法（由 link-client 已把关）
 *  3. deadline（epoch 一次换算成 monotonic）
 *  4. grant_ctx 已知 / active / epoch 当前
 *  5. bound_user_id == boundUserId
 *  6. tool ∈ REMOTE_TOOLS
 *  7. required_scope ∈ effectiveScopes(grant)
 *  8. tool ∈ allowed_tools ∩ toolsForScopes
 *  9. request_hash 与当前帧内容一致      ← **首次请求也要验**
 * 10. 缓存查询（键 = grant_ctx + delivery_id）
 * 11. executeTool
 * 12. 审计（**单出口**）
 * 13. res
 * ```
 *
 * **缓存必须在 6–9 之后**：先查缓存会让「已关开关 / scope 收紧 / 设备撤销 /
 * grant 撤销 / 请求内容被换掉」全部失效，AI 仍能拿到旧数据。这是最隐蔽的越权路径。
 *
 * ## 审计口径（安全运维 §6.5.4.1）
 *
 * 一次 `req` 至多写**一行**。哪些阶段记、哪些不记，见 `reject()` 的调用点。
 * 分支里**不得**再调审计——重复记账会让「一次越权尝试」看起来像两次。
 */

const FALLBACK_DEADLINE_MS = 15_000

export type RequestHandlerDeps = {
  db: Db
  services: ToolServices
  cache: ResultCache
  /** 读当前开关（每次请求都读，开关可能刚被关掉）。 */
  isEnabled(): boolean
  /**
   * 连接是否处于 `draining`。
   *
   * draining 期间仍可能收到 Cloud 已经排队的 `req`；本地必须拒绝而不是执行——
   * 进程马上要断，执行完的 `res` 多半发不出去，等于白做一次读取并留下一条
   * 「成功」审计。用 `DEVICE_BUSY`（可重试）：Cloud 在重连后重投即可。
   */
  isDraining(): boolean
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
  /** monotonic 时钟（进程内计时、deadline 判断；测试可注入）。 */
  nowMono(): number
  /** Unix epoch 时钟（**只**用于把 `deadline_ms` 换算成 monotonic 预算）。 */
  nowEpoch(): number
  /** 该 grant 是否已被撤销（撤销后即便上下文还在也不服务）。 */
  isGrantRevoked(grantCtx: string): boolean
}

export type HandlerOutcome = {
  /** 要发回 Cloud 的 `res` 帧内容（`deliver=false` 时仅用于测试与审计）。 */
  res: {
    id: string
    ok: boolean
    data?: unknown
    error?: { code: RemoteErrorCode; message: string; retryable: boolean }
    meta: { duration_ms: number; cached: boolean }
  }
  /**
   * `false` → **不要发送**这条 `res`。
   *
   * 唯一原因是执行完成时已过 deadline（协议 §7.4 第三条）：Cloud 早已返回超时，
   * 再补发一个「迟到的成功」会与它已经告诉 AI 的结果矛盾。宁可丢结果。
   */
  deliver: boolean
  /** 便于测试断言：这次请求走到哪一步。 */
  stage: 'rejected' | 'cached' | 'executed' | 'expired'
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
        deliver: true,
        stage: 'rejected',
        audited: audit !== null
      }
    }

    // ---- 1. 本地开关（不记账：请求根本没被受理） ----
    if (!deps.isEnabled()) {
      return reject('REMOTE_DISABLED', 'remote access is disabled on this device', null)
    }
    // ---- 1b. draining ----
    if (deps.isDraining()) {
      return reject('DEVICE_BUSY', 'device is draining; retry after reconnect', null)
    }

    // ---- 3. deadline：epoch 只用来算一次剩余预算 ----
    //
    // `deadline_ms` 是跨进程协议字段（epoch）。换算一次之后**只**用 monotonic：
    // 用户手动改系统时间，既不能延长也不能缩短这条已经确定的期限（ST-9）。
    const remaining = req.deadline_ms - deps.nowEpoch()
    if (remaining <= 0) {
      return reject('REQUEST_TIMEOUT', 'request deadline has passed', null)
    }
    /**
     * 到期点必须锚在**换算这一刻**的 monotonic，不能复用入口处的 `startedMono`。
     *
     * `startedMono` 是在函数第一行取的，而 `remaining` 是过了两条准入检查之后
     * 才取的——两者之间隔着若干次开关/draining 判断（以及未来可能加的任何前置
     * 工作）。用 `startedMono + remaining` 等于**悄悄扣掉那段时间**：
     *
     * - 期限被缩短，且缩短量与前置检查耗时成正比（不可预测）；
     * - 一旦前置检查真的变慢（例如将来加了一次 DB 读），预算就会莫名其妙缩水，
     *   而协议承诺的是「`deadline_ms` 之前的预算就是剩下的那段」。
     *
     * `startedMono` 仍然有用——它算 `duration_ms`，那是「这个请求处理了多久」，
     * 与「还剩多久可用」是两个不同的量，不能互相顶替。
     */
    const expiresAtMono = deps.nowMono() + remaining

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

    // ---- 6/7/8. 工具面与 scope（**在缓存之前**） ----
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

    // ---- 9. request_hash：**每次都要验，首次也是** ----
    //
    // 旧实现只在「缓存已有结果」时才比较，于是第一次投递带什么 hash 都照执行。
    // 那样 `request_hash` 就退化成「缓存键的一部分」，而不是协议 §8.2 所说的
    // 「内容指纹」——Cloud 侧一旦有 bug（复用 id 换内容），本地会照单执行。
    const expectedHash = computeRequestHash({ v: req.v, tool: req.tool, arguments: req.arguments })
    if (expectedHash !== req.request_hash) {
      return reject('PROTOCOL_VIOLATION', 'request_hash does not match the request content', {
        toolName: req.tool,
        errorCode: 'PROTOCOL_VIOLATION'
      })
    }

    // ---- 10. 缓存 ----
    const key = cacheKey(req.grant_ctx, req.id)
    const cached = deps.cache.get(key)

    if (cached && cached.state === 'inflight') {
      /**
       * 同 id 仍在执行。
       *
       * 协议 §8.3 第 1 条原本写「挂起并共用首次结果」，v1 **改成直接拒绝**，
       * 理由是那条路径在 v1 里结构性不可达：27 个 handler 全同步，
       * `handle()` 从 `beginInflight` 到 `put` 之间没有 `await`，单线程下
       * 第二次投递只可能在该函数**返回之后**到达——那时占位已被结果替换。
       *
       * 为一个不可达的路径实现 waiter，意味着写一段**永远测不到真实时序**的
       * 异步协调代码（取消、关开关、断线都要保证不泄漏结果）。那比一条明确的
       * 错误更危险。所以 v1 选择「拒绝」，并把占位保留下来作为
       * 「绝不重复执行」的结构性保证；异步工具落地时（v2）再实现 waiter。
       */
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
        deliver: true,
        stage: 'cached',
        audited: true
      }
    }

    // ---- 11. 占位 + 执行 ----
    if (!deps.cache.beginInflight(key, req.request_hash)) {
      return reject('PROTOCOL_VIOLATION', 'this delivery_id is already in flight', {
        toolName: req.tool,
        errorCode: 'PROTOCOL_VIOLATION'
      })
    }

    // 身份只来自**已经回查通过**的 grant（顺序契约：查询 → 撤销状态 → 用户
    // 绑定 → scope → 工具白名单，全部通过之后才走到这里）。
    // **绝不**从 `req.arguments` 构造 clientId——那是请求体，谁都能写。
    const context: ToolExecutionContext = {
      channel: 'remote',
      actor: { kind: 'remote_grant', clientId: grant.clientId, grantCtx: grant.grantCtx }
    }

    const outcome = executeTool(req.tool, req.arguments, {
      services: deps.services,
      scopes,
      context
      // 不传 replay：Remote 的去重在准入链（键是 delivery_id），不是持久幂等表。
    })
    const durationMs = Math.round(deps.nowMono() - startedMono)

    // ---- 11b. 执行完成时是否已过 deadline ----
    // 过了就丢弃结果、不写缓存、不发 res，只记一条超时审计（协议 §7.4）。
    if (deps.nowMono() >= expiresAtMono) {
      // 结果丢弃，**占位也要一起丢掉**：留着会让同一个 delivery_id 此后一直被
      // 当成「正在执行」而拒绝，直到断线才恢复（一个永不到来的 res 留下的坑）。
      deps.cache.drop(key)
      safeAudit({ toolName: req.tool, success: false, errorCode: 'REQUEST_TIMEOUT' })
      return {
        res: {
          id: req.id,
          ok: false,
          error: { code: 'REQUEST_TIMEOUT', message: 'request deadline passed during execution', retryable: true },
          meta: { duration_ms: durationMs, cached: false }
        },
        deliver: false,
        stage: 'expired',
        audited: true
      }
    }

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
      // ---- 12. 审计（单出口） ----
      safeAudit({ toolName: req.tool, success: false, errorCode: code })
      return {
        res: { id: req.id, ok: false, error: { code, message, retryable: isRetryableRemoteError(code) }, meta: { duration_ms: durationMs, cached: false } },
        deliver: true,
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
      deliver: true,
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
 * 走 `writeAuditResult` 而不是 `writeAudit`：后者会吞掉异常，于是调用方
 * 永远得到「成功」，`consecutiveFailures` 也就永远不会涨——设置页那个
 * 「最近 N 次远程访问未能写入审计」的告警会永远是 0。
 *
 * **不记录异常对象**：better-sqlite3 的报错里带 SQL 片段与数据库绝对路径，
 * 而这里拿到的是一条已经不该失败的业务路径。调用方只拿到 `false`，
 * 具体原因不进任何日志。
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
    return writeAuditResult(db, {
      clientId: `remote:${deviceId}`,
      toolName: entry.toolName,
      success: entry.success,
      errorCode: entry.errorCode,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      // 远程没有持久幂等键。
      idempotencyKey: null
    })
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
