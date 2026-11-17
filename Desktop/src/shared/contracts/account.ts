import { z } from 'zod'

/**
 * Cloud Account（Phase 1.2）：**Renderer 只能看到这里的 DTO**。
 *
 * 这个文件里刻意没有任何 Token 字段：Access Token / Refresh Token / PKCE
 * verifier 只存在于主进程（内存 + safeStorage 密文），连类型都不给渲染层，
 * 也就不存在「某个组件顺手把 token 放进 props / localStorage」的路径。
 *
 * 账户状态与局域网同步（`sync`）完全无关：同步用的是本机配对 token，
 * 与 Cloud Account 是两套独立的认证，互不复用、互不覆盖。
 */

export const ACCOUNT_PROVIDERS = ['google', 'github'] as const
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number]

export const accountProviderSchema = z.enum(ACCOUNT_PROVIDERS)

/** 账户资料：服务端 `GET /auth/me` 的安全子集，不含任何凭据。 */
export interface AccountUser {
  id: string
  displayName: string | null
  avatarUrl: string | null
  /** 服务端 `created_at`（ISO 8601）。 */
  createdAt: string
}

/**
 * 凭据持久化能力：
 * - `encrypted`：safeStorage 可用，Refresh Token 以密文落盘，重启后可恢复会话；
 * - `unavailable`：系统安全存储不可用（例如 Linux 没有 keyring）。**拒绝明文
 *   落盘**，本次登录只活到进程结束，界面需要如实说明。
 */
export type AccountStorageMode = 'encrypted' | 'unavailable'

export type AccountState = 'signed-out' | 'pending' | 'signed-in'

/**
 * 失败原因。文案由渲染层按语言映射——主进程只给稳定 code，
 * 不把服务端原文直接铺到界面上。
 */
export type AccountNoticeCode =
  | 'cancelled'
  | 'timeout'
  | 'provider-denied'
  | 'invalid-state'
  | 'exchange-failed'
  | 'cloud-unreachable'
  | 'cloud-timeout'
  | 'session-expired'
  | 'storage-unavailable'
  | 'storage-failed'
  | 'login-in-progress'
  | 'browser-open-failed'
  | 'unknown'

export interface AccountNotice {
  code: AccountNoticeCode
  /** 排障用的补充信息（服务端错误码等）；不含任何凭据，也不参与翻译。 */
  detail?: string
  at: number
}

export interface AccountPendingLogin {
  provider: AccountProvider
  startedAt: number
  /** 回调服务器超时时刻：过了这个点还没回来就当失败。 */
  expiresAt: number
}

/**
 * 账户快照：主进程唯一状态，两个 Renderer 窗口订阅同一份。
 * 所有字段都可以安全地跨 IPC。
 */
export interface AccountSnapshot {
  state: AccountState
  provider: AccountProvider | null
  user: AccountUser | null
  storage: AccountStorageMode
  /** 主进程实际请求的 Cloud 基地址（诊断用：切换部署时一眼看出打到哪里）。 */
  cloudBaseUrl: string
  pending: AccountPendingLogin | null
  notice: AccountNotice | null
  /** 正在向服务端校验会话。离线时仍保持 signed-in，只是暂未校验。 */
  checking: boolean
  /** 最近一次成功向服务端确认会话的时间；null = 本次启动还没确认过。 */
  verifiedAt: number | null
}

export const ACCOUNT_CHANGED_CHANNEL = 'account:changed'
