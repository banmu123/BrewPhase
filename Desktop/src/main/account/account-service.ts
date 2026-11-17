import { createHash, randomBytes } from 'node:crypto'
import type {
  AccountNotice,
  AccountNoticeCode,
  AccountProvider,
  AccountSnapshot,
  AccountUser
} from '../../shared/contracts/account'
import { CloudError, type CloudClient, type CloudSession } from './cloud-client'
import type { CredentialStore, StoredAccount } from './credentials'
import type { OAuthCallbackOutcome } from './oauth-callback-server'

/**
 * Cloud Account 服务（主进程唯一状态）。
 *
 * 生命周期只有三步：**登录 → 恢复 → 退出**。这一阶段不做后台定时刷新，
 * 也不碰任何本地记录：账户是「另一层身份」，与 brewphase.db 里的豆子、
 * 记录、画布没有任何外键关系，退出登录只删凭据文件。
 *
 * 关键设计：
 * - Renderer 只拿 `AccountSnapshot`（无 Token）。登录由主进程开系统浏览器、
 *   起本机回调、兑换授权码，Render 层只传一个 provider 名字；
 * - **state / PKCE verifier 全程不落盘、不出进程**。verifier 只在这个函数栈里，
 *   回调校验通过后立刻用掉；
 * - Refresh Token Rotation 的结果必须立刻替换本地旧 token（旧的在服务端已失效），
 *   否则下次启动就掉线；
 * - 所有失败都归一成 `notice`（稳定 code），界面自己翻译；服务端原文不上界面；
 * - 网络失败**绝不**清凭据（离线仍算已登录），只有服务端明确 401 才判定会话失效。
 */

export interface CallbackHandle {
  redirectUri: string
  result: Promise<OAuthCallbackOutcome>
  cancel: () => void
}

export interface AccountServiceDeps {
  cloud: CloudClient
  store: CredentialStore
  /** 打开系统浏览器（只传主进程构造的授权地址）。 */
  openExternal: (url: string) => Promise<void>
  /** 启动本机回调服务器；单测注入假实现，不需要真实监听。 */
  startCallback: (params: { clientState: string; timeoutMs: number }) => Promise<CallbackHandle>
  broadcast?: (snapshot: AccountSnapshot) => void
  now?: () => number
  log?: (message: string) => void
  /** 与服务端 OAuth transaction TTL（默认 300s）对齐。 */
  loginTimeoutMs?: number
}

export class AccountServiceError extends Error {
  constructor(readonly code: 'signed-out' | 'login-in-progress') {
    super(`account: ${code}`)
    this.name = 'AccountServiceError'
  }
}

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000

/** 提前 60 秒续期：避免请求在途中过期。 */
const ACCESS_TOKEN_SKEW_MS = 60_000

export class AccountService {
  private credentials: StoredAccount | null = null
  private access: { token: string; expiresAt: number } | null = null
  private pendingRun: {
    provider: AccountProvider
    startedAt: number
    expiresAt: number
    handle: CallbackHandle
  } | null = null
  private refreshInFlight: Promise<CloudSession> | null = null
  private checking = false
  private verifiedAt: number | null = null
  private notice: AccountNotice | null = null
  /** 会话代次：异步结果回来时用它判断「这期间是否换了号 / 退出了」。 */
  private generation = 0
  private current: AccountSnapshot

  constructor(private readonly deps: AccountServiceDeps) {
    this.current = this.build()
  }

  snapshot(): AccountSnapshot {
    return { ...this.current }
  }

  /** 应用启动时调用一次。读盘失败/解密失败都只是「未登录」，不阻塞启动。 */
  restore(): AccountSnapshot {
    const loaded = this.deps.store.load()
    if (loaded.status === 'ok') {
      this.credentials = loaded.account
      this.notice = null
      this.publish()
      // 校验在后台跑：离线时启动依然完成，界面先显示缓存资料。
      // 先广播再启动校验，是因为 verify() 会在第一个 await 之前同步把
      // `checking` 置真——返回的快照要能反映「正在确认」。
      void this.verify()
      return this.snapshot()
    }
    if (loaded.status === 'unavailable') {
      this.notice = this.makeNotice('storage-unavailable', 'safeStorage unavailable')
    } else if (loaded.status === 'failed') {
      // 解密失败 = 系统密钥变了或被篡改：按未登录处理，绝不尝试明文兜底。
      this.notice = this.makeNotice('storage-failed', loaded.reason)
    }
    return this.publish()
  }

  /**
   * 发起登录：起回调 → 开浏览器 → 等回调 → 换授权码 → 存凭据。
   *
   * 不抛业务异常：所有失败都写进快照的 `notice`，调用方（IPC）统一返回快照。
   * 中间状态靠 `account:changed` 广播，界面不必依赖这个 Promise 的时序。
   */
  async login(provider: AccountProvider): Promise<AccountSnapshot> {
    if (this.pendingRun) {
      this.notice = this.makeNotice('login-in-progress')
      return this.publish()
    }
    if (this.credentials) {
      // 已登录时不静默换号：先退出，再登录——避免两份会话并存。
      return this.snapshot()
    }

    const clientState = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
    const timeoutMs = this.deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS

    let handle: CallbackHandle
    try {
      handle = await this.deps.startCallback({ clientState, timeoutMs })
    } catch (error) {
      this.log(`callback server failed to start: ${describe(error)}`)
      this.notice = this.makeNotice('unknown', 'callback-listen')
      return this.publish()
    }

    const authorizeUrl = this.deps.cloud.authorizeUrl({
      provider,
      clientState,
      codeChallenge,
      redirectUri: handle.redirectUri
    })

    try {
      await this.deps.openExternal(authorizeUrl)
    } catch (error) {
      handle.cancel()
      this.log(`could not open the system browser: ${describe(error)}`)
      this.notice = this.makeNotice('browser-open-failed')
      return this.publish()
    }

    const startedAt = this.now()
    this.pendingRun = { provider, startedAt, expiresAt: startedAt + timeoutMs, handle }
    this.notice = null
    this.publish()

    const outcome = await handle.result
    // 取消/超时可能已经被 cancelLogin 处理过：句柄身份是唯一的判据。
    const stillCurrent = this.pendingRun?.handle === handle
    if (stillCurrent) this.pendingRun = null

    if (outcome.status === 'cancelled') {
      if (stillCurrent) this.notice = this.makeNotice('cancelled')
      return this.publish()
    }
    if (outcome.status === 'timeout') {
      if (stillCurrent) this.notice = this.makeNotice('timeout')
      return this.publish()
    }
    if (outcome.status === 'error') {
      this.notice = this.makeNotice(
        outcome.error === 'access_denied' ? 'provider-denied' : 'exchange-failed',
        outcome.error
      )
      return this.publish()
    }

    const generation = this.generation
    let step: 'exchange' | 'profile' = 'exchange'
    try {
      const session = await this.deps.cloud.exchangeAuthorizationCode({
        code: outcome.code,
        codeVerifier,
        redirectUri: handle.redirectUri
      })
      if (generation !== this.generation) return this.snapshot()

      step = 'profile'
      const user = await this.deps.cloud.me(session.accessToken)
      if (generation !== this.generation) return this.snapshot()

      this.access = {
        token: session.accessToken,
        expiresAt: this.now() + session.expiresInSeconds * 1000
      }
      this.credentials = {
        provider,
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
        refreshToken: session.refreshToken
      }
      this.generation += 1
      this.verifiedAt = this.now()
      this.notice = null
      this.persist()
      return this.publish()
    } catch (error) {
      if (generation !== this.generation) return this.snapshot()
      this.access = null
      this.credentials = null
      // `me` 失败时授权码已经用掉：不保存半套会话，让用户重新走一次授权。
      this.notice = this.noticeFor(error, 'exchange-failed')
      this.log(`${step === 'exchange' ? 'code exchange' : 'profile lookup'} failed: ${describe(error)}`)
      return this.publish()
    }
  }

  /**
   * 手动重新校验会话（设置页「刷新状态」）。
   *
   * 只做一次：离线时不起作用，也不会把已登录改成未登录——
   * 「网络失败」与「服务端拒绝」的判定仍然只在 `verify()` 里。
   */
  async refresh(): Promise<AccountSnapshot> {
    await this.verify()
    return this.snapshot()
  }

  /** 用户取消登录（关设置页、点取消、应用退出）：关端口并回到未登录。 */
  cancelLogin(): AccountSnapshot {
    const run = this.pendingRun
    if (!run) return this.snapshot()
    run.handle.cancel()
    this.pendingRun = null
    this.notice = this.makeNotice('cancelled')
    return this.publish()
  }

  /**
   * 退出登录：**先清本地**（界面立刻回未登录），再尽力撤销服务端会话。
   * 服务端不可达时本地照样退出——否则「网络挂了就退不出去」。
   * 只删凭据文件；豆子、记录、画布、媒体一个都不动。
   */
  async signOut(): Promise<AccountSnapshot> {
    this.cancelPendingQuietly()
    const refreshToken = this.credentials?.refreshToken ?? null

    this.credentials = null
    this.access = null
    this.verifiedAt = null
    this.notice = null
    this.generation += 1
    this.deps.store.clear()
    const snapshot = this.publish()

    if (refreshToken) {
      try {
        await this.deps.cloud.logout(refreshToken)
      } catch (error) {
        // 只记结果，不记 token。本地已经退了，服务端这条会话会自然过期。
        this.log(`server-side session revoke failed: ${describe(error)}`)
      }
    }
    return snapshot
  }

  /** 应用退出：确保回调端口被关掉，不留悬挂监听。 */
  dispose(): void {
    this.cancelPendingQuietly()
  }

  /**
   * 取一个可用的 Access Token（未来云 API 调用的统一入口）。
   * 这一阶段只有 `verify()` 用它；不暴露给 IPC。
   */
  async accessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!this.credentials) throw new AccountServiceError('signed-out')
    const now = this.now()
    if (!options.forceRefresh && this.access && this.access.expiresAt - ACCESS_TOKEN_SKEW_MS > now) {
      return this.access.token
    }
    const session = await this.refreshSession()
    return session.accessToken
  }

  /** 向服务端确认会话：成功则刷新资料；401 判定失效；网络错误保持登录。 */
  private async verify(): Promise<void> {
    if (this.checking || !this.credentials) return
    this.checking = true
    this.publish()

    const generation = this.generation
    try {
      const token = await this.accessToken({ forceRefresh: true })
      const user = await this.deps.cloud.me(token)
      if (generation !== this.generation || !this.credentials) return
      this.credentials = {
        ...this.credentials,
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt
      }
      this.verifiedAt = this.now()
      this.notice = null
      this.persist()
    } catch (error) {
      if (generation !== this.generation) return
      if (isUnauthorized(error)) {
        // 服务端明确说这个会话不认了：清凭据、回未登录。本地数据不受影响。
        this.credentials = null
        this.access = null
        this.generation += 1
        this.deps.store.clear()
        this.notice = this.makeNotice('session-expired', error.serverCode ?? undefined)
      } else {
        // 离线 / 超时 / 5xx：保持已登录，只是标记「暂未校验」。
        this.notice = this.noticeFor(error, 'cloud-unreachable')
      }
      this.log(`session verification failed: ${describe(error)}`)
    } finally {
      this.checking = false
      this.publish()
    }
  }

  /**
   * Refresh Token Rotation（单飞）。
   *
   * 并发的两次刷新拿同一个旧 token 时，服务端在宽限窗口内只拒绝后来者、
   * 不撤销整族；客户端这边再收口一次，避免自己制造「并发重放」。
   */
  private refreshSession(): Promise<CloudSession> {
    if (this.refreshInFlight) return this.refreshInFlight
    const owner = this.credentials
    if (!owner) return Promise.reject(new AccountServiceError('signed-out'))
    const generation = this.generation

    const run = this.deps.cloud
      .refresh(owner.refreshToken)
      .then((session) => {
        // 旧 refresh token 在服务端已经失效：新的必须立刻落盘，否则重启即掉线。
        if (generation === this.generation && this.credentials) {
          this.credentials = { ...this.credentials, refreshToken: session.refreshToken }
          this.access = {
            token: session.accessToken,
            expiresAt: this.now() + session.expiresInSeconds * 1000
          }
          this.persist()
        }
        return session
      })
      .finally(() => {
        this.refreshInFlight = null
      })
    this.refreshInFlight = run
    return run
  }

  private persist(): void {
    if (!this.credentials) return
    const result = this.deps.store.save(this.credentials)
    if (result.ok) return
    this.notice = this.makeNotice(
      result.reason === 'unavailable' ? 'storage-unavailable' : 'storage-failed',
      result.reason
    )
  }

  private cancelPendingQuietly(): void {
    const run = this.pendingRun
    this.pendingRun = null
    run?.handle.cancel()
  }

  private build(): AccountSnapshot {
    const pending = this.pendingRun
    return {
      state: pending ? 'pending' : this.credentials ? 'signed-in' : 'signed-out',
      provider: pending?.provider ?? this.credentials?.provider ?? null,
      user: this.credentials ? toUser(this.credentials) : null,
      storage: this.deps.store.canPersist ? 'encrypted' : 'unavailable',
      cloudBaseUrl: this.deps.cloud.origin,
      pending: pending
        ? { provider: pending.provider, startedAt: pending.startedAt, expiresAt: pending.expiresAt }
        : null,
      notice: this.notice,
      checking: this.checking,
      verifiedAt: this.verifiedAt
    }
  }

  private publish(): AccountSnapshot {
    this.current = this.build()
    this.deps.broadcast?.(this.current)
    return this.current
  }

  private makeNotice(code: AccountNoticeCode, detail?: string): AccountNotice {
    return { code, ...(detail ? { detail } : {}), at: this.now() }
  }

  /** Cloud 错误 → 界面 notice。只保留分类与服务端错误码，不带响应体。 */
  private noticeFor(error: unknown, fallback: AccountNoticeCode): AccountNotice {
    if (error instanceof CloudError) {
      if (error.kind === 'timeout') return this.makeNotice('cloud-timeout', error.serverCode ?? undefined)
      if (error.kind === 'network') return this.makeNotice('cloud-unreachable', 'network')
      if (error.kind === 'malformed') return this.makeNotice(fallback, 'malformed')
      return this.makeNotice(
        error.status !== null && error.status >= 500 ? 'cloud-unreachable' : fallback,
        error.serverCode ?? (error.status !== null ? `http-${error.status}` : undefined)
      )
    }
    return this.makeNotice(fallback)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(message: string): void {
    const sink = this.deps.log ?? ((text: string) => console.warn(text))
    sink(`[account] ${message}`)
  }
}

function toUser(account: StoredAccount): AccountUser {
  return {
    id: account.userId,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    createdAt: account.createdAt
  }
}

/** 只有服务端明确「这个 token 不认」才判定会话失效；网络错误不算。 */
function isUnauthorized(error: unknown): error is CloudError {
  if (!(error instanceof CloudError)) return false
  if (error.kind !== 'http') return false
  return (
    error.status === 401 ||
    error.serverCode === 'invalid_token' ||
    error.serverCode === 'invalid_grant'
  )
}

/** 只用于日志：错误名 + 分类，绝不带请求/响应体（里面可能有 token）。 */
function describe(error: unknown): string {
  if (error instanceof CloudError) {
    return `${error.kind}${error.status ? `:${error.status}` : ''}${error.serverCode ? `:${error.serverCode}` : ''}`
  }
  if (error instanceof Error) return error.name
  return typeof error
}
