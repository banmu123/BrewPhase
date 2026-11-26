import { remoteGrantSchema, type RemoteGrant, type RemoteGrantUpdate, type RemoteHelloOk } from '../../shared/contracts/remote'

/**
 * Grant 授权上下文表（内存）。
 *
 * ## 为什么需要它
 *
 * Grant 是 **MCP Client 级**授权，WSS 是**设备级**连接。没有这张表时，
 * 「ChatGPT 的请求」与「另一个 AI 客户端的请求」在 Desktop 看来完全一样：
 * 无法逐 Client 校验 scope，也无法在撤销其中一个后阻止它的缓存被回放。
 *
 * ## 两个 epoch 不是同一个东西
 *
 * | 字段 | 层级 | 用途 |
 * |---|---|---|
 * | `grantEpoch` | **设备级**（帧字段） | 帧的新旧门槛：`<= 当前` 即丢弃，抵御重复/乱序/回放 |
 * | `grant.epoch` | **单个 Grant** | 该 grant 自身的版本：内容变更时 +1；准入时校验「引用的是不是当前版本」 |
 *
 * ## 三条硬规则
 *
 * 1. **只在内存**：连接建立时安装，断开即丢弃。这消除了「重启后读到陈旧授权」
 *    的整类问题，代价是每次重连都要全量快照。
 * 2. **来源唯一**：`hello_ok.grants`（全量）与 `grant_update`（增量）。二者之外
 *    没有第三条路径——尤其**不从 `req` 里读** grant / scope / user。
 * 3. **原子替换**：`install` 必须整体成功或整体不变。校验失败时**不得部分修改**。
 */

export type InstalledGrant = {
  grantCtx: string
  grantId: string
  clientId: string
  clientName: string
  scopes: RemoteGrant['scopes']
  boundUserId: string
  epoch: number
}

export type GrantContextState = {
  /** 设备级代数；`hello_ok.grant_epoch` 或 `grant_update.grant_epoch`。 */
  epoch: number
  /** grantCtx → 上下文。 */
  grants: Map<string, InstalledGrant>
  /** Cloud 下发的工具白名单（只做交集，不能扩张）。 */
  allowedTools: readonly string[] | null
  /** 快照是否已安装（未安装前不接受 req）。 */
  ready: boolean
}

export function emptyGrantContext(): GrantContextState {
  return { epoch: -1, grants: new Map(), allowedTools: null, ready: false }
}

export type GrantApplyResult =
  | { ok: true; changed: boolean; revokedContexts: string[] }
  | { ok: false; code: 'PROTOCOL_VIOLATION' | 'STALE_EPOCH'; message: string }

/**
 * 安装 `hello_ok.grants` 全量快照。
 *
 * 语义：**整体替换**（原地修改，与 `applyGrantUpdate` / `resetGrantContext` 一致——
 * 调用方持有一个引用，三个函数都不得换对象，否则引用会指向旧状态）。
 * 不在快照里的旧 `grant_ctx` 立即失效（返回它们的 ctx 供清缓存）。
 * `ready` 只有在成功安装后才为 true。
 */
export function applyHelloOk(
  state: GrantContextState,
  helloOk: RemoteHelloOk
): { revokedContexts: string[] } {
  const next = new Map<string, InstalledGrant>()
  for (const grant of helloOk.grants) {
    next.set(grant.grant_ctx, {
      grantCtx: grant.grant_ctx,
      grantId: grant.grant_id,
      clientId: grant.client_id,
      clientName: grant.client_name,
      scopes: grant.scopes,
      boundUserId: grant.bound_user_id,
      epoch: grant.epoch
    })
  }
  const revoked = [...state.grants.keys()].filter((ctx) => !next.has(ctx))
  state.epoch = helloOk.grant_epoch
  state.grants = next
  state.allowedTools = helloOk.allowed_tools
  state.ready = true
  return { revokedContexts: revoked }
}

/**
 * 应用一条 `grant_update`。
 *
 * 幂等规则（协议 §6.5.2）：
 * - `grant_epoch <= 当前` → 丢弃且状态不变（重复/乱序/回放）。
 * - `install` 换掉同 ctx 的旧版本；`revoke` 删除。
 * - 任一字段不合法 → `PROTOCOL_VIOLATION`，**状态一点都不改**。
 */
export function applyGrantUpdate(state: GrantContextState, frame: RemoteGrantUpdate): GrantApplyResult {
  if (frame.grant_epoch <= state.epoch) {
    return { ok: true, changed: false, revokedContexts: [] }
  }

  if (frame.op === 'install') {
    if (!frame.grant) {
      return { ok: false, code: 'PROTOCOL_VIOLATION', message: 'install requires grant' }
    }
    // 闭合键集已在 schema 层校验（`.strict()`）；这里再做一次独立校验，
    // 防止调用方绕过 schema 直接传对象。
    const parsed = remoteGrantSchema.safeParse(frame.grant)
    if (!parsed.success) {
      return { ok: false, code: 'PROTOCOL_VIOLATION', message: 'grant shape is invalid' }
    }
    const next = new Map(state.grants)
    next.set(parsed.data.grant_ctx, {
      grantCtx: parsed.data.grant_ctx,
      grantId: parsed.data.grant_id,
      clientId: parsed.data.client_id,
      clientName: parsed.data.client_name,
      scopes: parsed.data.scopes,
      boundUserId: parsed.data.bound_user_id,
      epoch: parsed.data.epoch
    })
    state.grants = next
    state.epoch = frame.grant_epoch
    return { ok: true, changed: true, revokedContexts: [] }
  }

  const ctx = frame.grant_ctx
  if (!ctx) {
    return { ok: false, code: 'PROTOCOL_VIOLATION', message: 'revoke requires grant_ctx' }
  }
  const wasPresent = state.grants.has(ctx)
  const next = new Map(state.grants)
  next.delete(ctx)
  state.grants = next
  state.epoch = frame.grant_epoch
  // 即使原本不存在也要清缓存：那可能是「撤销到达前先跑完的请求」留下的条目。
  return { ok: true, changed: true, revokedContexts: [ctx] }
}

/** 查上下文。找不到或版本不符都算无效引用。 */
export function lookupGrant(state: GrantContextState, ctx: string): InstalledGrant | null {
  return state.grants.get(ctx) ?? null
}

/** 清除全部上下文（断线、关闭开关、用户切换）。 */
export function resetGrantContext(state: GrantContextState): void {
  state.grants = new Map()
  state.epoch = -1
  state.allowedTools = null
  state.ready = false
}

/**
 * 闭合键集校验的入口（`hello_ok.grants[]` / `grant_update` / `req`）。
 *
 * 返回违规的键名列表；空数组表示通过。**只用于诊断与测试**——
 * 真正的拒绝发生在 `zod .strict()` 与 `applyGrantUpdate` 里。
 */
export function unknownKeys(schemaShapeKeys: readonly string[], value: Record<string, unknown>): string[] {
  const allowed = new Set(schemaShapeKeys)
  return Object.keys(value).filter((key) => !allowed.has(key))
}
