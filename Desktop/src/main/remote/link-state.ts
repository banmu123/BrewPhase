import type {
  RemoteLinkState,
  RemoteStatus,
  RemoteUnserviceableReason
} from '../../shared/contracts/remote'

/**
 * 连接状态机（唯一状态源）。
 *
 * ## 三个概念必须分开
 *
 * | 概念 | 谁判定 | 含义 |
 * |---|---|---|
 * | `connected` | 双方各自 | WSS 已建立并通过握手 |
 * | `authorized` | Desktop | `bound_user_id` 匹配、`grant_ctx` 有效、`epoch` 当前 |
 * | `serviceable` | **Desktop 独占** | 本地具备执行条件 |
 *
 * 「连上了」不等于「能干活的」。参考实现曾按「连接在线」派发，而设备本地
 * 执行器已死，导致整批调用被拒且没有一次成功。
 *
 * **`serviceable` 只能由 Desktop 上报（`hello.serviceable` + `status` 帧），
 * Cloud 不得设置它**；同样，Cloud 也不得因为收到过 `true` 就跳过自己的校验，
 * Desktop 也不得因为上报过 `true` 就跳过逐请求的本地校验。
 */

export type ServiceableInputs = {
  /** 用户开关（持久化在 `remote/state.json`）。 */
  enabled: boolean
  /** 本机绑定的 Cloud 用户；`null` 表示尚未配对。 */
  boundUserId: string | null
  /** 当前登录的 Cloud 用户；`null` 表示未登录。 */
  currentUserId: string | null
  /** 业务数据库已打开且可用。 */
  dbReady: boolean
  /** 五个业务 Service 已装配。 */
  servicesReady: boolean
  /** 是否正在关闭。 */
  shuttingDown: boolean
  /**
   * 连接是否已进入 `blocked` 终态（被撤销 / 需重新配对 / 用户不匹配）。
   *
   * 这是 Phase 1.1B.1 补的：`blocked` 的设备**本地就不具备执行条件**，
   * 不上报就等于对 Cloud 撒谎说「我还能干活」。
   */
  blocked?: boolean
}

export type ServiceableVerdict = {
  serviceable: boolean
  reason: RemoteUnserviceableReason | null
}

/**
 * `serviceable` 的判定。顺序即优先级：越靠前越「根本」。
 *
 * 刻意**不**把 `linkState` 纳入判据：连接状态与执行能力是两件事，
 * 混在一起会出现「因为断线所以 serviceable=false，重连后又不知道要改回来」
 * 这类回路。
 */
export function judgeServiceable(input: ServiceableInputs): ServiceableVerdict {
  if (input.shuttingDown) return { serviceable: false, reason: 'shutting_down' }
  if (!input.enabled) return { serviceable: false, reason: 'remote_disabled' }
  // blocked 是终态：本地没有执行条件，必须如实上报（不能只说「在线」）。
  if (input.blocked) return { serviceable: false, reason: 'blocked' }

  // 未配对：这是「还没准备好」，不是「用户不匹配」。
  if (input.boundUserId === null) return { serviceable: false, reason: 'user_mismatch' }
  if (input.currentUserId === null) return { serviceable: false, reason: 'user_mismatch' }
  if (input.boundUserId !== input.currentUserId) {
    return { serviceable: false, reason: 'user_mismatch' }
  }

  if (!input.dbReady) return { serviceable: false, reason: 'db_unavailable' }
  if (!input.servicesReady) return { serviceable: false, reason: 'services_unavailable' }
  return { serviceable: true, reason: null }
}

/** 状态机的可变部分。所有字段都在主进程内存里。 */
export type LinkState = {
  state: RemoteLinkState
  /** `blocked` 的原因，展示给用户；`null` 表示不处于 blocked。 */
  blockedReason: string | null
  /** 最近一次 pong 的 monotonic 时间。 */
  lastPongAtMono: number | null
  lastPongAt: number | null
  lastError: string | null
  reconnectAttempt: number
  /** 连接建立（hello_ok 安装完成）的 monotonic 时间；用于稳定期重置。 */
  connectedAtMono: number | null
  lastCloseCode: number | null
  lastCloseReason: string | null
  /** 最近一次上报给 Cloud 的 serviceable 值（用于「只在变化时发 status」）。 */
  reportedServiceable: boolean | null
}

export function createLinkState(): LinkState {
  return {
    state: 'idle',
    blockedReason: null,
    lastPongAtMono: null,
    lastPongAt: null,
    lastError: null,
    reconnectAttempt: 0,
    connectedAtMono: null,
    lastCloseCode: null,
    lastCloseReason: null,
    reportedServiceable: null
  }
}

/** 允许的状态迁移（防止实现里出现莫名其妙的跳转）。 */
const ALLOWED: Record<RemoteLinkState, readonly RemoteLinkState[]> = {
  idle: ['connecting', 'blocked', 'idle'],
  connecting: ['handshaking', 'backoff', 'blocked', 'idle'],
  handshaking: ['online', 'backoff', 'blocked', 'idle'],
  online: ['draining', 'backoff', 'blocked', 'idle'],
  draining: ['idle', 'backoff', 'blocked'],
  backoff: ['connecting', 'blocked', 'idle'],
  blocked: ['idle']
}

export function canTransition(from: RemoteLinkState, to: RemoteLinkState): boolean {
  return ALLOWED[from].includes(to)
}

export function transition(link: LinkState, to: RemoteLinkState, reason?: string): boolean {
  if (!canTransition(link.state, to)) return false
  link.state = to
  if (to === 'blocked') {
    link.blockedReason = reason ?? 'blocked'
    // blocked 是终态：清掉重连计数，避免「恢复后仍从第 N 档退避开始」。
    link.reconnectAttempt = 0
    link.connectedAtMono = null
  } else if (to === 'online') {
    link.blockedReason = null
  } else if (to === 'idle') {
    link.blockedReason = null
    link.connectedAtMono = null
  }
  return true
}

/** 构造设置页可见的状态。**不含任何凭据**。 */
export function buildStatus(input: {
  link: LinkState
  enabled: boolean
  deviceId: string | null
  boundUserId: string | null
  needsReauth: boolean
  cloudOrigin: string | null
  verdict: ServiceableVerdict
  grants: RemoteStatus['grants']
  grantEpoch: number
  audit: RemoteStatus['auditStatus']
  /** 有进行中的配对时由 RemoteService 传入；默认没有。 */
  pendingRegistration?: RemoteStatus['pendingRegistration']
}): RemoteStatus {
  return {
    enabled: input.enabled,
    linkState: input.link.state,
    deviceId: input.deviceId,
    boundUserId: input.boundUserId,
    pendingRegistration: input.pendingRegistration ?? null,
    needsReauth: input.needsReauth,
    blockedReason: input.link.blockedReason,
    serviceable: input.verdict.serviceable,
    unserviceableReason: input.verdict.reason,
    cloudOrigin: input.cloudOrigin,
    lastPongAt: input.link.lastPongAt,
    lastError: input.link.lastError,
    reconnectAttempt: input.link.reconnectAttempt,
    grants: input.grants,
    grantEpoch: input.grantEpoch,
    auditStatus: input.audit
  }
}

/** 审计故障计数：**纯进程内状态**，重启归零，不落盘、不补写历史。 */
export type AuditStatus = {
  consecutiveFailures: number
  totalFailures: number
  lastFailureAt: number | null
}

export function createAuditStatus(): AuditStatus {
  return { consecutiveFailures: 0, totalFailures: 0, lastFailureAt: null }
}

export function noteAuditSuccess(status: AuditStatus): void {
  status.consecutiveFailures = 0
  // lastFailureAt 保留：本次进程内「最近一次失败是什么时候」仍然有意义。
}

export function noteAuditFailure(status: AuditStatus, now: number): void {
  status.consecutiveFailures += 1
  status.totalFailures += 1
  status.lastFailureAt = now
}
