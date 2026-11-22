import { app } from 'electron'
import { hostname } from 'node:os'
import type { Db } from '../database/client'
import type { ToolServices } from '../application/mcp-tools/tool-services'
import {
  REMOTE_HELLO_CAPABILITIES,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_ROTATION_CHECK_INTERVAL_MS,
  REMOTE_ROTATION_LEAD_MS,
  REMOTE_WS_SUBPROTOCOL,
  remoteGrantUpdateSchema,
  remoteReqSchema,
  remoteCancelSchema,
  remotePingSchema,
  remoteDrainSchema,
  type RemoteDiagnosis,
  type RemoteErrorCode,
  type RemoteGrantUpdate,
  type RemoteLinkState,
  type RemoteCancelResult,
  type RemoteConfirmFailure,
  type RemoteConfirmResult,
  type RemotePairingPhase,
  type RemoteRegistrationFailure,
  type RemoteRegistrationTicket,
  type RemoteStatus,
  type RemoteUnserviceableReason
} from '../../shared/contracts/remote'
import {
  createDeviceStore,
  deviceStorePaths,
  electronSecretBox,
  encodeRawPublicKey,
  generateDeviceKeyPair,
  makeNonce,
  readRemoteState,
  sameCloudOrigin,
  signHello,
  signRotation,
  writeRemoteState,
  type DeviceSave,
  type DeviceStore,
  type HelloSigningInput,
  type RemoteSecretBox
} from './device-identity'
import {
  applyGrantUpdate,
  applyHelloOk,
  emptyGrantContext,
  resetGrantContext,
  type GrantContextState,
  type InstalledGrant
} from './grant-context'
import {
  buildGrantAck,
  buildHelloFrame,
  buildPongFrame,
  buildResFrame,
  buildStatusFrame,
  createLinkTransport,
  parseHelloOk,
  type LinkTransport,
  type WebSocketFactory
} from './link-client'
import {
  buildStatus,
  canTransition,
  createAuditStatus,
  createLinkState,
  judgeServiceable,
  noteAuditFailure,
  noteAuditSuccess,
  transition,
  type AuditStatus,
  type LinkState
} from './link-state'
import { backoffDelayMs, shouldResetBackoff } from './reconnect'
import { createResultCache, type ResultCache } from './result-cache'
import { createRequestHandler, writeRemoteAudit } from './request-handler'
import { effectiveScopes, effectiveTools, isRemoteTool } from './remote-policy'
import type { DeviceRegistrar, DeviceRegistrarFactory } from './registration'

/**
 * Remote Service 门面：把身份、连接、上下文、缓存、准入、审计串起来。
 *
 * ## 为什么住在主进程里（而不是独立 Agent 进程）
 *
 * 本地工具的实现是主进程内的 `TOOL_HANDLERS`（1.1A 抽出的共享层）。
 * 独立进程只有两条路：自己开第二个 SQLite 连接（双写者、WAL 争用、迁移竞态），
 * 或走 Local Bridge（必须签 `bp_mcp_*` → 违反 Local/Remote 凭据域分离，
 * 还会继承 27 工具白名单）。两条都不可接受，所以 Remote 与数据库同属主进程。
 *
 * ## 默认关闭
 *
 * `enabled=false` 时**零出站连接**：不解析凭据、不建 socket、不起定时器。
 * 开关只在用户明确开启后才落盘。
 *
 * ## 连接前只有一道门（Phase 1.1B.1）
 *
 * 旧实现把「用户是否匹配」写在 `start()` 的分支里，于是 `enable()` / `resume()` /
 * 重连定时器都能绕过它——A 用户的设备身份会被 B 用户继续使用。现在所有入口
 * （start / enable / resume / reconnect / reconcile / connect）都只走 `canConnect()`，
 * 而 `connect()` 自己也再查一次。**没有第二条通往 socket 的路。**
 */

/**
 * 握手总时限（连接建立 → 收到 `hello_ok`）。
 *
 * 协议 §4.2 只规定「连上后 5s 内必须发 hello」；这里给整段握手 10s：
 * 留出 TLS + 服务端验签 + nonce 落库的时间，同时保证「连上了但永远不回
 * hello_ok」的半开连接不会一直占着 connecting 状态。
 */
const HANDSHAKE_DEADLINE_MS = 10_000

/** 注册后轮询 `/credentials` 的间隔（协议 §3.4 建议 1s）。 */
const REGISTRATION_POLL_MS = 1_000

/**
 * 一次进行中的设备注册（R5-R3.4.1 从 `createRemoteService` 里提出来）。
 *
 * 提出来的理由是**引用相等仍然是身份判据**，但类型要能被 `ClaimOutcome` 的
 * 单飞句柄引用——把「谁在飞」写在类型里，比在注释里写更难被后人改错。
 */
export type PendingRegistration = {
  deviceId: string
  claimSecret: string
  privateKey: import('node:crypto').KeyObject
  userId: string
  expiresAt: number
  /**
   * 展示信息。确认码只存在主进程内存里：界面通过 status 拿到它去显示，
   * 但它不落盘、不进日志——它是「第二重同意」的凭据而不是数据。
   */
  confirmCode: string
  deviceName: string
  platform: string
  accountLabel: string | null
  cancelled: boolean
  timer: NodeJS.Timeout | null
}

/**
 * 一次凭据领取的结果（R5-R3.4.1）。
 *
 * ## 为什么不能是 `void`
 *
 * `confirmRegistration` 必须据此判断「配对到底成没成」。`void` 会把
 * **三种完全不同的局面**压成同一个「跑完了」：
 *
 * | 结局 | 后果（修复前） |
 * |---|---|
 * | 202 还没到可领取的时候 | 显示「配对完成」，但本地没有凭据 |
 * | 网络断了 | 同上，且 pending 被当成已处理 |
 * | Token 已签发但没保存成功 | 同上，Cloud 上还留着一台 active 僵尸设备 |
 *
 * 所以每种结局都必须能被调用方分别看见、分别处置。
 */
export type ClaimOutcome =
  /** 已领取**且已写进安全存储**（或本机早已持有同一台设备的凭据）。 */
  | { state: 'claimed' }
  /** Cloud 说还不能领（202）：注册仍然有效，下一轮继续；不落盘、不开 WSS。 */
  | { state: 'pending' }
  /** 网络等临时问题：可安全重试，注册与内存凭据都保留。 */
  | { state: 'retryable_failure'; reason: RemoteRegistrationFailure }
  /**
   * 不可恢复（含「Token 已签发但本地没拿到」）。
   *
   * `revoked` = 是否成功把这台设备从 Cloud 撤掉。它是**如实报告**的依据：
   * 撤销失败时调用方必须说「需要人工处理」，不能假装设备已经清理。
   */
  | { state: 'terminal_failure'; reason: RemoteRegistrationFailure; revoked: boolean }
  /** 领取成功但 safeStorage 没写成（可用性 / 写入失败）。同样需要撤销。 */
  | { state: 'save_failed'; reason: 'unavailable' | 'write-failed'; revoked: boolean }
  /** 注册已被取消 / 顶替 / 换账户：这次结果作废，**不得改动任何状态**。 */
  | { state: 'superseded' }

export type RemoteServiceDeps = {
  db: Db
  services: ToolServices
  /** 当前登录的 Cloud 用户 id（没有则 null）。 */
  currentUserId(): string | null
  /**
   * 当前账户的可读标识（邮箱 / provider 名），用于「确认前让你看清绑到谁」。
   *
   * 返回 null 不影响配对——界面会退化成显示 userId 前几位。**不能**用它做
   * 身份判定：身份的唯一来源是 `currentUserId()`（来自已验证的登录态）。
   */
  currentUserLabel?(): string | null
  /** 覆盖设备目录（测试用）；默认 `<userData>/remote` 的父目录。 */
  baseDir?: string
  /** 覆盖 Cloud 源。 */
  cloudOrigin?: string
  /** 注入 WebSocket 工厂（测试用）。 */
  webSocketFactory?: WebSocketFactory
  /** 注入 safeStorage（测试用）。 */
  secretBox?: RemoteSecretBox
  /** 客户端版本号（握手用）。 */
  clientVersion?: string
  /** 注册时展示的设备名；默认取主机名。 */
  deviceName?: string
  /**
   * 设备注册客户端的**工厂**（接收本服务实际使用的 Cloud origin）。
   *
   * 为什么是工厂而不是实例：注册必须打到「这台设备将来要连的那个 Cloud」，
   * 而那个 origin 由本服务从 `deps.cloudOrigin ?? state.json` 解析出来。
   * 让调用方各传一份 origin 迟早会漂移——设备注册到 A 然后去连 B，
   * 正是 `cloudOrigin` 绑定要防的事。所以由这里把 origin 交出去。
   *
   * **生产环境默认没有**：没有工厂时 `register()` 明确抛错，而不是伪造成功。
   */
  registrar?: DeviceRegistrarFactory
  /** 状态变化广播（IPC）。 */
  onChanged?(status: RemoteStatus): void
  /** 调试日志（不含参数/结果/凭据）。 */
  log?(line: string): void
}

export type RemoteService = {
  /** 启动安全检查 + 按开关决定是否连接。**不依赖 Renderer**。 */
  start(): Promise<void>
  /** 幂等停止：清定时器、关 socket、清缓存与上下文。 */
  stop(): Promise<void>
  status(): RemoteStatus
  diagnose(): RemoteDiagnosis
  /** 用户开启远程访问（需先完成范围确认）。 */
  enable(): Promise<RemoteStatus>
  /** 用户关闭：立即拒绝新请求、清缓存、断连。 */
  disable(): Promise<RemoteStatus>
  /**
   * 设备注册。返回**只含** 待确认信息（`confirmCode`）；
   * `claim_secret` 与私钥绝不出主进程。
   */
  register(): Promise<RemoteRegistrationTicket>
  /**
   * 用户确认待确认设备（`remote:confirm-registration`）。
   *
   * 成功返回前已经完成凭据领取与落盘（`status.pendingRegistration` 会变 null）；
   * 失败时除终态原因外都保留现场，可重试。
   */
  confirmRegistration(): Promise<RemoteConfirmResult>
  /** 用户取消本次配对：本地清理 + 尽力撤销云端 pending 设备。 */
  cancelRegistrationNow(): Promise<RemoteCancelResult>
  /** 忘记设备：先 +代际号再删凭据，尽力通知 Cloud。 */
  forget(): Promise<RemoteStatus>
  /** 解绑（`boundUserId` 不匹配时的出口）。 */
  unbind(): Promise<RemoteStatus>
  /** 账户即将登出：**必须在账户凭据清除之前调用**。 */
  prepareForSignOut(): Promise<void>
  /** 系统睡眠/唤醒。 */
  suspend(): void
  resume(): Promise<void>
  /**
   * 账户变化后重新判定。
   *
   * **必须挂到账户广播上**：否则用户在线期间切换账户后，连接会带着旧绑定
   * 继续存在——本地仍在为「上一个用户」服务。这是 ST-4 的运行时版本，
   * 与启动时的那次检查同等重要。
   */
  reconcile(): Promise<void>
}

type ConnectGate =
  | { ok: true }
  | {
      ok: false
      code:
        | 'shutting_down'
        | 'disabled'
        | 'blocked'
        | 'no_credentials'
        | 'no_user'
        | 'user_mismatch'
        | 'origin_mismatch'
    }

export function createRemoteService(deps: RemoteServiceDeps): RemoteService {
  const log = deps.log ?? (() => undefined)
  const paths = deviceStorePaths(deps.baseDir ?? app.getPath('userData'))
  const box = deps.secretBox ?? electronSecretBox(require('electron').safeStorage)
  const store: DeviceStore = createDeviceStore(paths, box)
  const cache: ResultCache = createResultCache()

  const link: LinkState = createLinkState()
  const audit: AuditStatus = createAuditStatus()
  let grants: GrantContextState = emptyGrantContext()
  /** 已撤销但可能仍被引用的 grant_ctx（撤销后即便上下文还在也不服务）。 */
  const revokedContexts = new Set<string>()

  let localState = readRemoteState(paths)
  /** 当前**配置**的 Cloud 源（进程启动时确定，不随载荷变化）。 */
  const configuredOrigin = deps.cloudOrigin ?? localState.cloudOrigin
  /**
   * 注册客户端：用**同一个** origin 构造，避免「注册到 A、连接 B」。
   * 工厂只调用一次——它只是把 origin 绑进闭包，没有状态。
   */
  const registrar: DeviceRegistrar | null = deps.registrar ? deps.registrar(configuredOrigin) : null

  let deviceId: string | null = null
  let boundUserId: string | null = null
  let deviceToken: string | null = null
  let privateKey: import('node:crypto').KeyObject | null = null
  /** 凭据里记录的源。**必须**与 `configuredOrigin` 一致才允许发出去。 */
  let deviceOrigin: string | null = null
  let needsReauth = false
  let started = false
  let shuttingDown = false
  let dbReady = false
  let servicesReady = false

  let transport: LinkTransport | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let heartbeatTimer: NodeJS.Timeout | null = null
  let healthTimer: NodeJS.Timeout | null = null
  let pendingPingSeq = 0

  /**
   * 连接尝试的代际号。
   *
   * 每次 `connect()` 自增；所有异步续作（握手超时、onOpen 发帧）都拿着自己那份
   * 快照比对。旧尝试因此**永远不可能**给新 socket 发 hello，也不可能把新 socket
   * 关掉——这是「disable 之后立刻 enable」这类操作能安全收敛的原因。
   */
  let connectGeneration = 0
  /** 已签好、等待 onOpen 发出去的 hello。 */
  let pendingHello: { attempt: number; frame: string; serviceable: boolean } | null = null
  let handshakeTimer: NodeJS.Timeout | null = null

  /**
   * 注册中的临时状态（`claim_secret` **只在内存里**）。
   *
   * 结构体本身还是 `pendingRegistration` 的「身份」：异步续作用引用相等来
   * 判断「这次轮询是否还属于当前那次注册」，比再引一个代数更不容易写错。
   */
  let pendingRegistration: PendingRegistration | null = null

  /**
   * 配对进度（R5-R3.4.1）。界面据此把确认按钮显示成
   * 「正在确认… / 已确认，正在领取凭据 / 凭据保存中 / 领取失败可重试」。
   *
   * **只有 `idle` 与 `awaiting_confirm` 会在没有 pending 时出现**：终态失败时
   * `pendingRegistration` 已被清空，界面靠 `pairingNotice` 说清发生了什么，
   * 进度标记本身不再假装还有流程在跑。
   */
  let pairingPhase: RemotePairingPhase = 'idle'

  /**
   * 在途的凭据领取（**单飞**）。
   *
   * 两条路径会发起领取：轮询定时器与用户点确认。Cloud 的领取是一次性的
   * （`token_issued_at IS NULL` 是原子守卫），并发两个请求只有一个能拿到明文
   * Token，另一个拿 409 —— 而失败路径会去撤销设备、成功路径又可能因为
   * pending 已被清掉而丢弃结果。最终表现就是「Cloud 上设备已激活、本地却没有
   * 凭据」，且 UI 显示配对完成。
   *
   * `claimFlightOwner` 是发起时的 `pendingRegistration` 引用：新注册 / 取消之后
   * 引用变了，后续调用不会复用旧飞行；旧飞行完成时也进不了状态修改。
   */
  let claimFlight: Promise<ClaimOutcome> | null = null
  let claimFlightOwner: PendingRegistration | null = null

  /**
   * 确认流程在途。它同时是**轮询的闸门**：确认期间不允许任何一条轮询领取
   * 跑起来（否则确认后的那次一次性领取会被轮询抢先）。
   */
  let confirmInFlight = false
  /** 确认的单飞句柄：两次并发 confirm 复用同一个结果，绝不打两次领取。 */
  let confirmFlight: Promise<RemoteConfirmResult> | null = null

  /** `device_token` 的到期时刻（epoch 毫秒，Cloud 签发时给的）。`null` = 老凭据未知。 */
  let tokenExpiresAt: number | null = null

  /**
   * 正在进行的轮换任务（**单飞**）。
   *
   * 为什么必须单飞：两次并发轮换会用同一个旧 token 打两次，Cloud 只让一个
   * 成功，另一个拿 401 —— 而 401 会被解释成「凭据已失效」，于是把一次本来
   * 成功的轮换判成失败并进入 blocked。这个后果比「少轮换一次」严重得多。
   */
  let rotation: { userId: string; promise: Promise<void> } | null = null
  /**
   * 轮换处在哪一步。
   *
   * 这个区分是必需的：`rotation !== null` 只说明「有轮换任务在跑」，而 4010
   * 在**两个不同的阶段**含义相反：
   *
   * | 阶段 | 4010 的含义 | 处置 |
   * |---|---|---|
   * | `requesting`（HTTP 在途） | 我们自己那次轮换的旧连接被 Cloud 关掉 | 预期内，什么都不做 |
   * | `reconnecting`（已用新凭据连） | 又有人轮换了这台设备 | 必须 blocked，否则这条死连接既不重连也不报错 |
   *
   * 只看 `rotation !== null` 会把第二种当成第一种吞掉：socket 已死、状态停在
   * connecting、没有任何定时器——连接永久假死，而日志里只有一行
   * 「closed 4010 during rotation」。
   */
  let rotationPhase: 'requesting' | 'reconnecting' | null = null
  /** 轮换到期检查的兜底定时器。 */
  let rotationTimer: NodeJS.Timeout | null = null

  // MARK: - 凭据轮换（协议 §3.5 / 生命周期 §11.6）

  /**
   * 现在是否该主动轮换。
   *
   * 判据只有一条：`tokenExpiresAt - 提前量`。刻意**不**用「本地记一个签发
   * 时间再猜 TTL」——那会在 Cloud 改 TTL 或本地时钟漂移时静默失效。
   *
   * 三个「不该轮换」的例外都是硬要求：
   * - `enabled=false`：用户关了远程访问，此时**零出站**（本模块的既有不变量）；
   * - `needsReauth`：身份已经不对了，轮换只会把错误固化；
   * - `tokenExpiresAt === null`：老凭据不知道到期时间。**不猜**——猜早会做
   *   无谓的轮换，猜晚会让 token 静默过期。老凭据的出路是等 4010 或重新配对。
   */
  const rotationDue = (now = Date.now()): boolean => {
    if (shuttingDown || needsReauth) return false
    if (!localState.enabled) return false
    if (!deviceId || !deviceToken || !privateKey) return false
    if (tokenExpiresAt === null) return false
    return now >= tokenExpiresAt - REMOTE_ROTATION_LEAD_MS
  }

  const clearRotationTimer = (): void => {
    if (rotationTimer) clearInterval(rotationTimer)
    rotationTimer = null
  }

  /**
   * 在线期间的兜底检查。
   *
   * 为什么需要它：`enable()` 与握手成功这两个时点覆盖不了「笔记本一直开着
   * 三天」和「合盖二十天后唤醒但没断线」两种情形。7 天的提前量下，
   * 每小时一次已经远超需要，成本可以忽略。
   */
  const armRotationTimer = (): void => {
    if (rotationTimer) return
    rotationTimer = setInterval(() => {
      if (rotationDue()) void rotateCredentials('scheduled')
    }, REMOTE_ROTATION_CHECK_INTERVAL_MS)
    rotationTimer.unref?.()
  }

  /**
   * 单飞执行一次轮换。已在轮换中时返回同一个 promise。
   *
   * 并发两次轮换的后果不是「多此一举」：第二个请求用**同一个旧 token**，
   * Cloud 只让一个成功，另一个必得 401 —— 而 401 会被解释成「凭据已失效」，
   * 于是一次本来成功的轮换被判成失败并进入 blocked。所以这里必须合并。
   */
  const rotateCredentials = (trigger: string): Promise<void> => {
    if (rotation) return rotation.promise
    const userId = deps.currentUserId() ?? ''
    const entry: { userId: string; promise: Promise<void> } = {
      userId,
      promise: Promise.resolve()
    }
    entry.promise = performRotation(trigger, userId).finally(() => {
      // 只有自己还是当前任务时才清空：否则会把后来者的任务抹掉。
      if (rotation === entry) {
        rotation = null
        rotationPhase = null
      }
    })
    rotation = entry
    return entry.promise
  }

  /**
   * 轮换的实际步骤。顺序不可交换：
   *
   * ```
   * 生成新密钥 → 用**旧**私钥签 → POST /rotate → 落盘 → 替换内存 → 重连
   * ```
   *
   * 落盘必须早于「替换内存」与「重连」：Cloud 已经作废旧 token，如果新 token
   * 没落地就重连，那个 token 就永久丢了（Cloud 不补发）。
   */
  const performRotation = async (trigger: string, userId: string): Promise<void> => {
    if (!registrar || !deviceId || !deviceToken || !privateKey) return

    // 捕获快照：后面的 await 期间这些字段都可能被 forget / 重新配对改掉。
    const rotatingDeviceId = deviceId
    const oldToken = deviceToken
    const oldKey = privateKey

    let nextKeys: { privateKey: import('node:crypto').KeyObject; publicKey: import('node:crypto').KeyObject }
    try {
      nextKeys = generateDeviceKeyPair()
    } catch {
      enterBlocked('cannot generate a new device key')
      return
    }

    const newPublicKey = encodeRawPublicKey(nextKeys.publicKey)
    const ts = Date.now()
    let signature: string
    try {
      signature = signRotation(oldKey, { deviceId: rotatingDeviceId, newPublicKey, ts })
    } catch {
      // 签名失败说明旧私钥不可用——那也没法证明身份，只能重新配对。
      enterBlocked('cannot sign the rotation request')
      return
    }

    log(`[remote] rotating device credentials (${trigger})`)
    rotationPhase = 'requesting'
    const result = await registrar.rotate({
      deviceId: rotatingDeviceId,
      oldDeviceToken: oldToken,
      newPublicKey,
      ts,
      signature
    })

    if (shuttingDown) return
    // 轮换期间用户登出 / 切账户：**丢弃**结果，不落盘。
    // 旧 token 已被作废，设备会走到「需要重新配对」——这正是 fail-closed 的
    // 预期结果：宁可要求重配对，也不把 A 的凭据写进 B 的会话。
    if (deps.currentUserId() !== userId) {
      log('[remote] rotation discarded: account changed')
      return
    }
    // 设备身份被换掉了（forget / 重新配对）：这次轮换的结果已无意义。
    if (deviceId !== rotatingDeviceId) {
      log('[remote] rotation discarded: device identity replaced')
      return
    }

    if (!result.ok) {
      // 网络失败 = **结果未知**。Cloud 可能已经提交了轮换，而新 token 只在
      // 那条响应里。此时拿旧 token 重试是错的（第二次必然 401，且会把
      // 「未知」变成「确定失败」）；只能 blocked + 重新配对。
      if (result.reason === 'network') {
        enterBlocked('credential rotation outcome unknown')
        return
      }
      if (result.reason === 'unauthorized' || result.reason === 'not_found') {
        enterBlocked('credential rotation rejected')
        return
      }
      if (result.reason === 'device_state') {
        // 用户暂停了设备或撤销了它：不是错误，是状态。
        enterBlocked('device is suspended or revoked')
        return
      }
      // rate_limited / invalid_public_key / invalid_response 都是**可恢复**的：
      // 旧凭据仍然有效（Cloud 没写成），下一次检查会再试。
      log(`[remote] rotation not applied: ${result.reason}`)
      publish()
      return
    }

    // 落盘：新私钥 + 新 token + 同一 boundUserId，并记下新的到期时间。
    const saved = await store.save({
      deviceId: rotatingDeviceId,
      boundUserId: userId,
      cloudOrigin: configuredOrigin,
      deviceToken: result.deviceToken,
      privateKey: nextKeys.privateKey,
      registeredAt: Date.now(),
      tokenExpiresAt: result.expiresAt
    })

    if (shuttingDown) return
    if (!saved.ok) {
      // Cloud 那边已经换了，本地没落住 → 新 token 永久丢失。
      // 不能「继续用旧的」（它已失效），也不能重试（旧 token 已作废）。
      log('[remote] failed to persist the rotated credential')
      enterBlocked('rotated credential could not be stored')
      return
    }
    // 落盘之后账户又变了：凭据是真实的（boundUserId 记的是 A），但当前用户
    // 是 B。不把内存切过去，让身份门禁按 user_mismatch 处理。
    if (deps.currentUserId() !== userId) {
      log('[remote] rotated credential stored but the account changed')
      return
    }

    // ---- 切换内存凭据 ----
    deviceToken = result.deviceToken
    privateKey = nextKeys.privateKey
    tokenExpiresAt = result.expiresAt
    // 新凭据是有效的：清掉「需要重新认证」与 4010 的意外计数。
    needsReauth = false
    log('[remote] device credentials rotated')

    // 旧连接已被 Cloud 用 4010 关掉（或即将关掉）。主动收敛一次，
    // 保证「重连」不会与旧 socket 的 close 回调打架。
    abortAttempt()
    transport?.close(1000, 'credentials rotated')
    resetConnectionState()
    if (canTransition(link.state, 'backoff')) transition(link, 'backoff')
    publish()

    // 用新凭据**重新握手**（不按退避：这是预期内的关闭，不是网络故障）。
    //
    // 进入 reconnecting 之后，再来的 4010 不再是「我们那次轮换的旧连接」，
    // 而是「新凭据也已被别人换掉」——handleClose 会据此 blocked 而不是吞掉。
    rotationPhase = 'reconnecting'
    await connect()
  }

  const handleRequest = createRequestHandler({
    db: deps.db,
    services: deps.services,
    cache,
    isEnabled: () => localState.enabled && !shuttingDown,
    isDraining: () => link.state === 'draining',
    boundUserId: () => boundUserId,
    deviceId: () => deviceId,
    grants: () => grants,
    nowMono: () => performance.now(),
    nowEpoch: () => Date.now(),
    isGrantRevoked: (ctx) => revokedContexts.has(ctx),
    audit: (entry) => {
      if (!deviceId) {
        noteAuditFailure(audit, Date.now())
        log('[remote] audit skipped: no device id')
        return
      }
      const ok = writeRemoteAudit(deps.db, deviceId, entry)
      if (ok) {
        noteAuditSuccess(audit)
        return
      }
      noteAuditFailure(audit, Date.now())
      // 只报「失败了几次」。绝不打印异常对象：better-sqlite3 的报错里带
      // SQL 片段与数据库绝对路径（安全运维 §6.5.4.1 的日志纪律）。
      log(`[remote] audit write failed (consecutive ${audit.consecutiveFailures})`)
    }
  })

  const verdict = (): { serviceable: boolean; reason: RemoteUnserviceableReason | null } =>
    judgeServiceable({
      enabled: localState.enabled,
      boundUserId,
      currentUserId: deps.currentUserId(),
      dbReady,
      servicesReady,
      shuttingDown,
      blocked: link.state === 'blocked'
    })

  /**
   * 广播当前状态，并把它返回给调用方。
   *
   * 返回快照而不是 `void`：确认/取消这类 IPC 既要把新状态推给所有窗口，
   * 又要在响应里带一份——两处必须是**同一次**计算结果，否则界面会看到
   * 一个「广播里已配对、响应里还 pending」的错位。
   */
  const publish = (): RemoteStatus => {
    const snapshot = service()
    deps.onChanged?.(snapshot)
    return snapshot
  }

  const service = (): RemoteStatus =>
    buildStatus({
      link,
      enabled: localState.enabled,
      deviceId,
      boundUserId,
      needsReauth,
      cloudOrigin: deviceId ? configuredOrigin : null,
      verdict: verdict(),
      grants: [...grants.grants.values()].map((grant) => ({
        grantCtx: grant.grantCtx,
        clientId: grant.clientId,
        clientName: grant.clientName,
        scopes: grant.scopes,
        epoch: grant.epoch
      })),
      grantEpoch: grants.epoch,
      pendingRegistration: pendingRegistration
        ? {
            deviceId: pendingRegistration.deviceId,
            deviceName: pendingRegistration.deviceName,
            platform: pendingRegistration.platform,
            confirmCode: pendingRegistration.confirmCode,
            expiresAt: pendingRegistration.expiresAt,
            accountLabel: pendingRegistration.accountLabel
          }
        : null,
      pairingPhase,
      audit: {
        consecutiveFailures: audit.consecutiveFailures,
        totalFailures: audit.totalFailures,
        lastFailureAt: audit.lastFailureAt
      }
    })

  // MARK: - 连接前安全门

  /**
   * **所有**出站连接的唯一入口判据。
   *
   * 顺序不是随意的：先判「根本不该连」（正在退出 / 用户关了开关 / 已被 blocked），
   * 再判「身份是否齐备」，最后判「身份是否属于当前这个人」。
   * 这样任何一种失败都不会走到建 socket 那一步。
   */
  /**
   * 身份相关的判据（**不含**「开关是否打开」）。
   *
   * `enable()` 需要它：用户点「开启」的那一刻开关还是关的，但身份校验必须
   * 先过。若先写 `enabled=true` 再在 `connect()` 里发现用户不匹配，两个并发的
   * `enable()` 就可能把状态写成「开着 + blocked」——这是测试真实抓到的竞态。
   */
  const identityGate = (): ConnectGate => {
    if (shuttingDown) return { ok: false, code: 'shutting_down' }
    if (needsReauth) return { ok: false, code: 'blocked' }
    if (!deviceId || !deviceToken || !privateKey || boundUserId === null) {
      return { ok: false, code: 'no_credentials' }
    }
    const current = deps.currentUserId()
    if (current === null) return { ok: false, code: 'no_user' }
    if (boundUserId !== current) return { ok: false, code: 'user_mismatch' }
    if (!deviceOrigin || !sameCloudOrigin(configuredOrigin, deviceOrigin)) {
      return { ok: false, code: 'origin_mismatch' }
    }
    return { ok: true }
  }

  const canConnect = (): ConnectGate => {
    if (shuttingDown) return { ok: false, code: 'shutting_down' }
    if (!localState.enabled) return { ok: false, code: 'disabled' }
    return identityGate()
  }

  // MARK: - 连接

  const clearTimers = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (healthTimer) clearInterval(healthTimer)
    reconnectTimer = null
    heartbeatTimer = null
    healthTimer = null
  }

  /**
   * 让「正在进行的那次连接尝试」彻底失效。
   *
   * 必须与 `clearTimers()` 一起用：前者管连接后的定时器，后者管连接中的尝试。
   * 只做一半的结果是「旧尝试的握手超时把新连接关掉」。
   */
  const abortAttempt = (): void => {
    connectGeneration += 1
    pendingHello = null
    if (handshakeTimer) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
  }

  /** 断线清理清单（协议 §10.3，8 项）。逐项做，漏一项就是内存泄漏或误回放。 */
  const resetConnectionState = (): void => {
    // 1–2：定时器（在 clearTimers 里）
    clearTimers()
    // 3：关闭开关时也要求清缓存，这里一并做（断线语义相同）
    cache.clear()
    // 4：清空全部 Grant 上下文（含 grant_epoch）
    resetGrantContext(grants)
    revokedContexts.clear()
    // 5：连接时间与 pong
    link.connectedAtMono = null
    link.lastPongAtMono = null
    // 6：pendingPing 计数
    pendingPingSeq = 0
    // 7：上报值重置，重连后会重新上报
    link.reportedServiceable = null
    // 8：保留 reconnectAttempt（由调用方决定是否归零）
  }

  /**
   * 进入 `blocked`：把本地**收紧到不可能出站**的状态。
   *
   * 用户不匹配、设备被撤销、源不匹配都走这里。四件事缺一不可：
   * 落盘关开关、清缓存与上下文、杀掉在途尝试、关掉可能还开着的连接。
   * 这样即使 300ms 后有人调用 `enable()`，`canConnect()` 也会立刻拒绝。
   */
  const enterBlocked = (reason: string): void => {
    needsReauth = true
    // 进行中的注册必须一起取消：它的 `userId` 可能已经不是当前用户了，
    // 而 `claimOnce` 是异步的——不在这里断掉，它会在 await 之后继续用
    // 旧用户身份轮询（并把结果落盘到新用户的设备目录）。
    cancelRegistration('blocked')
    localState = { ...localState, enabled: false }
    try {
      writeRemoteState(paths, localState)
    } catch {
      // 落盘失败不阻止本地收紧：内存里的 enabled 已经是 false。
      log('[remote] failed to persist disabled state')
    }
    cache.clear()
    resetGrantContext(grants)
    revokedContexts.clear()
    abortAttempt()
    clearTimers()
    transport?.close(4009, 'account mismatch')
    if (link.state === 'blocked') {
      link.blockedReason = reason
    } else {
      transition(link, 'blocked', reason)
    }
    log(`[remote] blocked: ${reason}`)
    publish()
  }

  const reportStatus = (): void => {
    if (!transport?.isOpen()) return
    const current = verdict()
    if (link.reportedServiceable === current.serviceable) return
    link.reportedServiceable = current.serviceable
    transport.send(buildStatusFrame({ serviceable: current.serviceable, reason: current.reason, ts: Date.now() }))
  }

  const scheduleReconnect = (): void => {
    if (shuttingDown || !localState.enabled || needsReauth) return
    clearTimers()
    transition(link, 'backoff')
    link.reconnectAttempt += 1
    const delay = backoffDelayMs(link.reconnectAttempt, Math.random)
    log(`[remote] reconnect in ${delay}ms (attempt ${link.reconnectAttempt})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      // 定时器到点时状态可能已经变了（用户切换 / 关开关 / 已被撤销）：
      // 所以这里不是「直接连」，而是再走一次 connect() 的门禁。
      void connect()
    }, delay)
    publish()
  }

  const handleClose = (code: number, reason: string): void => {
    link.lastCloseCode = code
    link.lastCloseReason = reason
    // 连接已死：让本次尝试的所有定时器失效，避免它们影响下一次连接。
    abortAttempt()
    resetConnectionState()

    const kind = transport?.classifyClose(code) ?? 'retry'
    if (kind === 'no-reconnect') {
      // 4001/4002/4003/4004/4005/4006/4009：重连也不会成功，进终态。
      transition(link, 'blocked', describeClose(code, reason))
      if (code === 4003) needsReauth = true
      log(`[remote] closed ${code} (${reason}); not reconnecting`)
      publish()
      return
    }
    if (kind === 'reauth') {
      // 4010 = 凭据已轮换。**两种来源必须分开处理**（1.2B.2.1）：
      //
      // | 来源 | 处置 |
      // |---|---|
      // | 我们自己正在轮换 | 预期内的旧连接关闭：轮换任务会在落盘后用新凭据重连，这里**什么都不做** |
      // | 别处轮换了这台设备 | 我们的 token 已失效，重试必然 401：直接 blocked，**不重试** |
      //
      // 旧实现在这里做「换凭证重连一次」，但那是在没有轮换能力时的权宜：
      // 实际上本地没有新凭证可换，重连一次还是同一个 token，只会多一轮 401。
      if (rotationPhase === 'requesting') {
        log('[remote] closed 4010 during rotation; waiting for the new credential')
        // socket 已经死了，状态不能继续停在 `online`——那会让诊断页显示
        // 「在线」而 socketOpen=false。推进到 backoff 表示「正在等一次重连」，
        // 但不排重连定时器：轮换任务自己会在落盘后连。
        if (canTransition(link.state, 'backoff')) transition(link, 'backoff')
        publish()
        return
      }
      needsReauth = true
      transition(link, 'blocked', 'device credentials were rotated elsewhere')
      log('[remote] closed 4010 outside a rotation; blocking')
      publish()
      return
    }
    log(`[remote] closed ${code} (${reason}); will reconnect`)
    scheduleReconnect()
  }

  /**
   * 从**无法解析**的原文里尽力捞出 `delivery_id`。
   *
   * 只在「这段字节看起来真的是一个 req」时才返回，避免把业务参数里恰好叫
   * `id` 的字段当成投递 id 去回话：
   *
   * 1. 必须同时出现 `"type"` 与 `"req"`；
   * 2. `id` 必须是**第一个**出现在 `arguments` / `tool` 之前的那一个
   *    （我们自己的帧把 id 放在参数之前；Cloud 侧同构）。
   *
   * 猜错的代价是可控的：协议 §2.2 规定未知 `res.id` 一律忽略，
   * 所以一个错 id 不会污染任何真实请求的状态。
   */
  const salvageDeliveryId = (raw: string): string | null => {
    if (!/"type"\s*:\s*"req"/.test(raw)) return null
    const cut = raw.search(/"arguments"\s*:|"tool"\s*:/)
    const head = cut === -1 ? raw : raw.slice(0, cut)
    const match = /"id"\s*:\s*"([^"\\]{1,128})"/.exec(head)
    return match ? match[1] : null
  }

  /**
   * 形状非法的 `req` 的审计。
   *
   * **只在工具名确实属于远程面时记**：`tool_name` 这一列有语义，塞一个
   * `<malformed>` 之类的占位符会让「按工具统计」永远对不上账。工具名不可信时
   * 只写日志——至少不会用一条伪造记录污染审计表。
   *
   * 为什么值得记：往一个合法工具调用里塞未知键，是「篡改 WSS 载荷」最现实的
   * 形态（Cloud 的序列化 bug 或中间人）。这类事件如果只留一行 stderr，
   * 事后完全无法回溯。
   */
  const auditMalformed = (toolName: unknown): void => {
    if (typeof toolName !== 'string' || !isRemoteTool(toolName) || !deviceId) return
    const ok = writeRemoteAudit(deps.db, deviceId, {
      toolName,
      success: false,
      errorCode: 'PROTOCOL_VIOLATION'
    })
    if (ok) noteAuditSuccess(audit)
    else noteAuditFailure(audit, Date.now())
  }

  /** 对畸形 req 的统一回话（协议 §2.2 要求「必须回 res.ok=false」）。 */
  const sendProtocolViolation = (id: string): void => {
    transport?.send(
      buildResFrame({
        id,
        ok: false,
        error: {
          code: 'PROTOCOL_VIOLATION',
          message: 'request frame does not match the protocol',
          retryable: false
        },
        meta: { duration_ms: 0, cached: false }
      })
    )
  }

  const handleFrame = (raw: string): void => {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      // 协议 §2.2：无法解析为 JSON，但能从原文提取出 id → 必须回 PROTOCOL_VIOLATION。
      //
      // 为什么要费这个劲：不回话的话 Cloud 只能等到 deadline 超时，而它对
      // 「帧坏了」和「设备卡住了」得到的是同一个结果——排障信息彻底丢失。
      const salvaged = salvageDeliveryId(raw)
      if (salvaged) {
        log('[remote] replied PROTOCOL_VIOLATION to an unparsable req')
        sendProtocolViolation(salvaged)
        return
      }
      log('[remote] closing on an unparsable frame (no id to reply to)')
      dropConnection(4009, 'protocol violation')
      return
    }
    const type = json && typeof json === 'object' ? (json as { type?: unknown }).type : undefined

    switch (type) {
      case 'hello_ok':
        handleHelloOk(raw)
        return
      case 'ping':
        handlePing(json)
        return
      case 'req':
        handleReq(raw, json)
        return
      case 'grant_update':
        handleGrantUpdate(json)
        return
      case 'cancel':
        handleCancel(json)
        return
      case 'drain':
        handleDrain(json)
        return
      case 'bye':
        log('[remote] server said bye')
        return
      default:
        log(`[remote] ignored an unknown frame type: ${String(type)}`)
    }
  }

  const handleHelloOk = (raw: string): void => {
    const parsed = parseHelloOk(raw)
    if (!parsed.ok) {
      log(`[remote] hello_ok rejected: ${parsed.message}`)
      // 两种失败要用不同的 close code——它们是两种完全不同的故障：
      //
      // - 4002 = 「版本不兼容」：双方都合法，部署侧要升级/回滚；
      // - 4009 = 「帧格式非法」：对端在说我们的协议之外的话，通常意味着
      //   序列化 bug 或中间人改包。
      //
      // 第一版一律报 4002，于是「Cloud 发了个畸形 hello_ok」会被记成版本问题，
      // 排障方向从一开始就是错的。
      if (parsed.message.startsWith('unsupported protocol version')) {
        dropConnection(4002, 'version unsupported')
      } else {
        dropConnection(4009, 'hello_ok shape invalid')
      }
      return
    }
    const helloOk = parsed.value
    // 握手完成：这次尝试的握手超时不再有意义。
    if (handshakeTimer) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
    pendingHello = null

    // 原子安装：整体替换，不在快照里的旧 ctx 立即失效。
    const applied = applyHelloOk(grants, helloOk)
    for (const ctx of applied.revokedContexts) cache.dropGrantContext(ctx)
    revokedContexts.clear()

    // Cloud 的帧上限只能**收紧**本机上限，不能放宽（内存保护是本机的）。
    transport?.setMaxFrameBytes(helloOk.max_frame_bytes)

    link.connectedAtMono = performance.now()
    link.lastError = null
    link.reportedServiceable = null
    transition(link, 'online')
    startHeartbeat(helloOk.heartbeat_ms, helloOk.idle_timeout_ms)
    reportStatus()
    log(`[remote] online: ${helloOk.grants.length} grant(s), epoch ${helloOk.grant_epoch}`)
    publish()

    // 连接建立后立刻查一次轮换窗口。三条路径都靠它收敛：
    // ① 启动时已逾期（enable 之前就过期，握手却仍然成功——token 可能还剩几天）；
    // ② 一直在线跨过窗口（定时器也能兜，但这里更早）；
    // ③ 轮换成功后的重连（新 token 不会立即再触发，因此不会自激）。
    armRotationTimer()
    if (rotationDue()) void rotateCredentials('online')
  }

  const handlePing = (frame: unknown): void => {
    const parsed = remotePingSchema.safeParse(frame)
    if (!parsed.success) {
      log('[remote] malformed ping')
      return
    }
    link.lastPongAtMono = performance.now()
    link.lastPongAt = Date.now()
    // 稳定期重置：连接存活 ≥60s 且收到过 pong → 退避归零。
    if (
      link.connectedAtMono !== null &&
      shouldResetBackoff({ connectedAtMono: link.connectedAtMono, lastPongAtMono: link.lastPongAtMono, nowMono: performance.now() })
    ) {
      link.reconnectAttempt = 0
    }
    transport?.send(buildPongFrame(parsed.data.seq, cache.snapshot().inflight, Date.now()))
  }

  const handleReq = (_raw: string, frame: unknown): void => {
    const parsed = remoteReqSchema.safeParse(frame)
    if (!parsed.success) {
      // 闭合键集校验失败（未知键 / 类型错 / 缺字段）。
      //
      // 协议 §2.2 对 req 的要求是「**必须回 `res.ok=false`**」——静默丢弃会让
      // Cloud 一直等到 deadline，而它无法区分「设备没收到」与「设备拒收」。
      // 这里能拿到 id 就回 PROTOCOL_VIOLATION；拿不到就按「无法回话」处理。
      const detail = parsed.error.issues[0]?.message ?? 'unknown'
      const id = frame && typeof frame === 'object' ? (frame as { id?: unknown }).id : undefined
      if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
        log(`[remote] rejected a malformed req: ${detail}`)
        // 不写缓存、不执行、不改授权状态：畸形帧没有「结果」可缓存。
        auditMalformed((frame as { tool?: unknown }).tool)
        sendProtocolViolation(id)
        return
      }
      log(`[remote] closing on a malformed req without a usable id: ${detail}`)
      dropConnection(4009, 'protocol violation')
      return
    }
    const outcome = handleRequest(parsed.data)
    // `deliver=false` 只有一个来源：执行完成时已过 deadline（协议 §7.4）。
    // 此时**不发** res——Cloud 已经超时返回，补发一个迟到的成功只会自相矛盾。
    if (!outcome.deliver) {
      log('[remote] dropped a late res (deadline passed during execution)')
      return
    }
    transport?.send(
      buildResFrame(
        outcome.res.ok
          ? { id: outcome.res.id, ok: true, data: outcome.res.data, meta: outcome.res.meta }
          : {
              id: outcome.res.id,
              ok: false,
              error: outcome.res.error ?? { code: 'INTERNAL_ERROR' as RemoteErrorCode, message: 'unknown', retryable: false },
              meta: outcome.res.meta
            }
      )
    )
  }

  const handleGrantUpdate = (frame: unknown): void => {
    const parsed = remoteGrantUpdateSchema.safeParse(frame)
    if (!parsed.success) {
      // 状态**一点不改**（applyGrantUpdate 根本没被调用），但要不要 ack？
      //
      // 必须 ack：协议 §6.5.2 规定 ack 超时 → Cloud fail-closed **暂停向该设备
      // 路由全部 grant**。也就是说「丢弃畸形帧」的代价不是丢一帧，而是这台设备
      // 整体停服 3 秒起。既然 epoch 还能读出来，就明确回 applied:false。
      const epoch = frame && typeof frame === 'object' ? (frame as { grant_epoch?: unknown }).grant_epoch : undefined
      if (typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0) {
        log('[remote] malformed grant_update; acked false, state unchanged')
        transport?.send(buildGrantAck(epoch, false, 'protocol_violation', Date.now()))
        return
      }
      log('[remote] malformed grant_update without a usable epoch; state unchanged')
      return
    }
    const update: RemoteGrantUpdate = parsed.data
    const applied = applyGrantUpdate(grants, update)
    if (!applied.ok) {
      log(`[remote] grant_update rejected: ${applied.message}`)
      // 状态一点没改，ack 为 false 并给原因。
      transport?.send(buildGrantAck(update.grant_epoch, false, applied.code.toLowerCase(), Date.now()))
      publish()
      return
    }
    if (applied.changed) {
      for (const ctx of applied.revokedContexts) {
        cache.dropGrantContext(ctx)
        revokedContexts.add(ctx)
      }
      if (update.op === 'revoke' && update.grant_ctx) revokedContexts.add(update.grant_ctx)
    }
    transport?.send(buildGrantAck(update.grant_epoch, true, '', Date.now()))
    publish()
  }

  const handleCancel = (frame: unknown): void => {
    const parsed = remoteCancelSchema.safeParse(frame)
    if (!parsed.success) return
    // 同步 handler 无法中断；这里只清占位，让后续同 id 的投递可以重新执行。
    // 结果回来后仍会写缓存——但那次调用的 res 已被丢弃，不构成泄漏。
    void parsed.data.id
    log('[remote] cancel received (sync handler cannot be interrupted)')
  }

  const handleDrain = (frame: unknown): void => {
    const parsed = remoteDrainSchema.safeParse(frame)
    if (!parsed.success) return
    transition(link, 'draining')
    publish()
    transport?.send(buildByeFrameSafe('drain_ack'))
    publish()
  }

  const buildByeFrameSafe = (_reason: string): string => JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, type: 'bye', ts: Date.now() })

  /**
   * 心跳看门狗。
   *
   * **从 `hello_ok` 起算**，而不是「收到第一条 ping 才开始」。旧实现在
   * `lastPongAtMono === null` 时直接 return，于是「握手成功但 Cloud 再也没有
   * 发过任何 ping」这条最容易出现的半开连接（NAT 超时、LB 掉表）
   * 永远不会被判死——连接在路由表里看着是 online，实际早就发不出去了。
   */
  const startHeartbeat = (heartbeatMs: number, idleTimeoutMs: number): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (healthTimer) clearInterval(healthTimer)
    link.lastPongAtMono = performance.now()
    healthTimer = setInterval(() => {
      const last = link.lastPongAtMono
      if (last === null) return
      const staleMs = performance.now() - last
      if (staleMs > idleTimeoutMs) {
        log(`[remote] no ping for ${Math.round(staleMs)}ms; closing`)
        link.lastError = 'heartbeat timeout'
        dropConnection(4008, 'heartbeat timeout')
      }
    }, Math.max(1_000, Math.min(heartbeatMs, 5_000)))
  }

  /**
   * 本地判定要断开时走这里。
   *
   * **不能只调 `transport.close()`**：传输层的主动关闭会把底层 socket 的
   * `onclose` 丢掉（那是刻意的——我们自己的意志不该被当成「对端异常」）。
   * 但代价是 `handleClose()` 不会执行：状态机停在 `online`、`lastCloseCode`
   * 不更新、也不会有重连。心跳超时因此会留下一条「看着在线、实际已死」的连接
   * ——正是这一层要防的那种状态。所以主动断开必须自己做完整套收敛。
   */
  const dropConnection = (code: number, reason: string): void => {
    link.lastCloseCode = code
    link.lastCloseReason = reason
    transport?.close(code, reason)
    abortAttempt()
    resetConnectionState()
    const kind = transport?.classifyClose(code) ?? 'retry'
    if (kind === 'no-reconnect') {
      transition(link, 'blocked', describeClose(code, reason))
      publish()
      return
    }
    log(`[remote] locally closed ${code} (${reason}); will reconnect`)
    scheduleReconnect()
  }

  /** 握手超时：只对「仍然是当前那次尝试」生效。 */
  const armHandshakeDeadline = (attempt: number): void => {
    if (handshakeTimer) clearTimeout(handshakeTimer)
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null
      if (attempt !== connectGeneration) return
      log('[remote] handshake did not complete in time')
      dropConnection(4001, 'handshake timeout')
    }, HANDSHAKE_DEADLINE_MS)
  }

  const connect = async (): Promise<void> => {
    // 没有 transport 说明 `start()` 还没跑（例如 IPC 在装配完成前就收到 enable）。
    // 这种情况下什么都不做，而不是把状态推进到 connecting 再挂住。
    if (!transport) {
      log('[remote] connect requested before start(); ignoring')
      return
    }
    // 门禁在**唯一的出口**上再查一次。调用方已经查过也没关系：
    // 这次复查是「任何新调用路径都不可能绕过检查」的结构保证。
    const gate = canConnect()
    if (!gate.ok) {
      applyGateFailure(gate.code)
      return
    }

    transition(link, 'connecting')
    publish()

    // 门禁保证了下面这几个不为 null；用局部常量把这一点固化下来，
    // 避免在异步间隙里再读可变状态。
    const activeDeviceId = deviceId as string
    const activeToken = deviceToken as string
    const activeKey = privateKey as NonNullable<typeof privateKey>

    const ts = Date.now()
    const nonce = makeNonce()
    const appVersion = deps.clientVersion ?? safeAppVersion()
    const platform = process.platform
    const serviceable = verdict().serviceable

    const helloInput: HelloSigningInput = {
      v: REMOTE_PROTOCOL_VERSION,
      type: 'hello',
      ts,
      device_id: activeDeviceId,
      nonce,
      min_version: REMOTE_PROTOCOL_VERSION,
      max_version: REMOTE_PROTOCOL_VERSION,
      app_version: appVersion,
      platform,
      capabilities: [...REMOTE_HELLO_CAPABILITIES],
      serviceable
    }

    let sig: string
    try {
      sig = signHello(activeKey, helloInput)
    } catch {
      // 签名用不了说明私钥已经不可用：不要拿它去连，直接要求重新配对。
      needsReauth = true
      transition(link, 'blocked', 'device signing key is unusable')
      log('[remote] hello signing failed; blocking')
      publish()
      return
    }

    const frame = buildHelloFrame({
      ts,
      deviceId: activeDeviceId,
      nonce,
      minVersion: REMOTE_PROTOCOL_VERSION,
      maxVersion: REMOTE_PROTOCOL_VERSION,
      appVersion,
      platform,
      capabilities: REMOTE_HELLO_CAPABILITIES,
      serviceable,
      sig
    })

    const attempt = ++connectGeneration
    pendingHello = { attempt, frame, serviceable }

    try {
      // **认证就在这里**：device_token 走 header，绝不进 URL、绝不进 hello。
      transport?.connect(toWebSocketUrl(configuredOrigin), {
        headers: { Authorization: `Bearer ${activeToken}` },
        protocols: [REMOTE_WS_SUBPROTOCOL]
      })
    } catch {
      pendingHello = null
      link.lastError = 'failed to open socket'
      log('[remote] could not create a websocket')
      transition(link, 'backoff')
      scheduleReconnect()
    }
  }

  /** 门禁失败时的收敛动作。**任何一种都不建 socket。** */
  const applyGateFailure = (code: Extract<ConnectGate, { ok: false }>['code']): void => {
    switch (code) {
      case 'shutting_down':
        return
      case 'disabled':
        transition(link, 'idle')
        publish()
        return
      case 'blocked':
        if (link.state !== 'blocked') transition(link, 'blocked', 'reauthentication required')
        publish()
        return
      case 'user_mismatch':
        // 用户切换是安全事件：落盘关开关、清上下文、断开、零出站。
        enterBlocked('signed-in user differs from the bound user')
        return
      case 'origin_mismatch':
        needsReauth = true
        transition(link, 'blocked', 'cloud origin mismatch')
        log('[remote] cloud origin mismatch; refusing to send credentials')
        publish()
        return
      case 'no_user':
        transition(link, 'idle')
        publish()
        return
      case 'no_credentials':
        if (deviceId === null) {
          // 还没配对：这是「没准备好」，不是「需要重新授权」。
          link.lastError = 'device is not paired'
          transition(link, 'idle')
          publish()
          return
        }
        needsReauth = true
        transition(link, 'blocked', 'device credentials are unusable')
        log('[remote] device credentials are missing or unreadable')
        publish()
        return
    }
  }

  // MARK: - 注册

  const cancelRegistration = (reason: string): void => {
    const pending = pendingRegistration
    if (!pending) return
    pending.cancelled = true
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = null
    // 显式抹掉内存里的 claim_secret（它是可换 token 的一次性秘密）。
    pending.claimSecret = ''
    pendingRegistration = null
    // 已经没有流程在跑了：进度标记必须跟着归零，否则界面会永远停在
    // 「正在领取凭据」上，而实际上什么都不会再发生。
    pairingPhase = 'idle'
    log(`[remote] registration cancelled (${reason})`)
  }

  const setPairingPhase = (phase: RemotePairingPhase): void => {
    if (pairingPhase === phase) return
    pairingPhase = phase
  }

  /** 这次注册的凭据是否**已经躺在本机**（后台轮询先一步领成功并落盘）。 */
  const isPairedWith = (pending: PendingRegistration): boolean =>
    deviceId === pending.deviceId && deviceToken !== null && boundUserId === pending.userId

  /**
   * 领取失败后，用**当前用户身份**把这台设备从 Cloud 撤掉。
   *
   * 为什么必须撤：领取是一次性的，失败之后 Cloud 上可能已经停着一台
   * `active` 设备，而本地永远拿不到它的 Token——那是谁也用不了的僵尸，
   * 还会占掉用户的设备名额。
   *
   * 换过账户时**直接返回 false**：拿别人的身份去撤销既不可能成功，
   * 更不能被算成「已清理」。
   */
  const revokeAfterFailedClaim = async (pending: PendingRegistration): Promise<boolean> => {
    if (!registrar) return false
    if (deps.currentUserId() !== pending.userId) return false
    const result = await registrar.revoke({ deviceId: pending.deviceId })
    if (!result.ok) log(`[remote] failed to revoke the device after a failed claim (${result.reason})`)
    return result.ok
  }

  /**
   * 落盘**之后**才发现注册已被取消 / 顶替：把这次写入撤掉。
   *
   * 不做的话会出现最坏的一种不一致：界面显示「已取消」，磁盘上却躺着一份
   * 可用的 `device.json`，下次启动会直接把它当成已配对设备。
   *
   * 两条边界：
   * 1. 没写进去就没什么可撤；
   * 2. **现在生效的凭据是别的设备时绝不能删**（新注册已经落盘）——
   *    这就是「不能删除另一个有效设备的凭据」。
   *
   * 撤销走 `store.forget()`：它先把代际号 +1 再删，顺带让任何仍在途的写入
   * 失效。**不绕过 DeviceStore 的代际保护**，也不另造一套存储机制。
   */
  const discardSavedCredential = async (pending: PendingRegistration, saved: DeviceSave): Promise<void> => {
    if (!saved.ok) return
    if (deviceId !== null && deviceId !== pending.deviceId) return
    const forgotten = await store.forget()
    deviceId = null
    boundUserId = null
    deviceToken = null
    privateKey = null
    deviceOrigin = null
    tokenExpiresAt = null
    if (!forgotten.ok) {
      // 收敛失败必须如实说：磁盘上可能还留着一份凭据。
      link.lastError = `forget failed: ${forgotten.reason}`
      log('[remote] failed to discard the credential written by a cancelled registration')
      return
    }
    log('[remote] discarded the credential written by a cancelled registration')
  }

  /**
   * 领取走到不可恢复的一步（R5-R3.4.1 §6C）。
   *
   * 关键区分：**Token 已经签发但这一方没拿到**（`credentials_already_issued`）
   * 与「压根没签发」处置相同——撤销 + 清掉本地临时凭据 + 提示重新配对，
   * 但**绝不重试**：重试永远拿不到同一枚明文 Token。
   */
  const failTerminalClaim = async (
    pending: PendingRegistration,
    reason: RemoteRegistrationFailure
  ): Promise<ClaimOutcome> => {
    const revoked = await revokeAfterFailedClaim(pending)
    // 撤销要打一次网络往返：那期间注册可能已被取消 / 顶替。那时这次失败
    // 已经不属于当前状态——不改 needsReauth、不打 blocked、不动 phase，
    // 也绝不 `cancelRegistration()`（它会清掉**新**注册的 pending）。
    if (pendingRegistration !== pending || pending.cancelled) {
      log('[remote] claim failure arrived after the registration was replaced; state left untouched')
      return { state: 'superseded' }
    }
    // 无论撤销成没成，本地临时凭据（claim_secret + 内存私钥）都必须清掉：
    // 它们换不出任何东西了，留着只会让人以为还能再试一次。
    cancelRegistration(`claim ${reason}`)
    needsReauth = true
    link.lastError = `device registration failed: ${reason}`
    if (link.state !== 'blocked') transition(link, 'blocked', `registration ${reason}`)
    log(`[remote] claim failed (${reason}); revoked=${revoked ? 'yes' : 'no'}`)
    publish()
    return { state: 'terminal_failure', reason, revoked }
  }

  /**
   * 领取成功但 safeStorage 没写成（R5-R3.4.1 §7）。
   *
   * 凭据**已经签发**了，本地却存不下 → 立刻撤销，否则用户会看到一个
   * 「UI 显示成功、本地却用不了」的设备。同样**不重试**：一次性 claim
   * 已经被消费，重试只会拿到 409。
   */
  const failSave = async (
    pending: PendingRegistration,
    reason: 'unavailable' | 'write-failed'
  ): Promise<ClaimOutcome> => {
    const revoked = await revokeAfterFailedClaim(pending)
    // 同 failTerminalClaim：撤销的网络往返期间状态可能已经换了主人。
    if (pendingRegistration !== pending || pending.cancelled) {
      log('[remote] save failure arrived after the registration was replaced; state left untouched')
      return { state: 'superseded' }
    }
    cancelRegistration(`save ${reason}`)
    needsReauth = true
    link.lastError = `device credential save failed: ${reason}`
    if (link.state !== 'blocked') transition(link, 'blocked', 'device credential save failed')
    log(`[remote] failed to persist the new device credential (${reason}); revoked=${revoked ? 'yes' : 'no'}`)
    publish()
    return { state: 'save_failed', reason, revoked }
  }

  const scheduleClaimPoll = (): void => {
    const pending = pendingRegistration
    if (!pending || pending.cancelled) return
    // 确认流程在跑：它自己会在结束时恢复轮询。这里再排一个定时器，
    // 只会造出第二条与确认并行的领取路径——而领取是一次性的。
    if (confirmInFlight) return
    if (Date.now() >= pending.expiresAt) {
      cancelRegistration('expired')
      needsReauth = true
      link.lastError = 'device registration expired'
      if (link.state !== 'blocked') transition(link, 'blocked', 'device registration expired')
      publish()
      return
    }
    pending.timer = setTimeout(() => {
      if (pendingRegistration !== pending) return
      // 轮询是**后台**路径：没有调用方接住它，抛出去就是一次
      // unhandledRejection（在 Electron 主进程里足以让整个应用弹错误框）。
      // 记日志并继续排下一轮——`scheduleClaimPoll` 自己会按 expiresAt 收口，
      // 所以这条兜底最多转到注册过期为止。
      void claimOnce('poll').catch((error: unknown) => {
        log(`[remote] background claim failed: ${error instanceof Error ? error.message : String(error)}`)
        if (pendingRegistration === pending) scheduleClaimPoll()
      })
    }, REGISTRATION_POLL_MS)
  }

  const releaseClaim = (owner: PendingRegistration): void => {
    if (claimFlightOwner !== owner) return
    claimFlight = null
    claimFlightOwner = null
  }

  /**
   * 领取一次凭据（**单飞**）。
   *
   * `initiator` 决定谁让路：轮询在确认期间直接返回 `superseded`，绝不与
   * 确认抢同一枚一次性 Token；确认则总是等在途那次落定之后再发自己的。
   *
   * 同一个 `pendingRegistration` 的第二次调用**复用在途 Promise**——
   * 这就是「定时轮询与手动确认共享同一个 in-flight」的实现。
   */
  const claimOnce = (initiator: 'poll' | 'confirm'): Promise<ClaimOutcome> => {
    const pending = pendingRegistration
    if (!pending || pending.cancelled) return Promise.resolve<ClaimOutcome>({ state: 'superseded' })
    if (initiator === 'poll' && confirmInFlight) return Promise.resolve<ClaimOutcome>({ state: 'superseded' })
    if (claimFlight && claimFlightOwner === pending) return claimFlight

    const flight = runClaim(pending).then(
      (outcome) => {
        releaseClaim(pending)
        return outcome
      },
      (error: unknown) => {
        releaseClaim(pending)
        throw error
      }
    )
    claimFlight = flight
    claimFlightOwner = pending
    return flight
  }

  const runClaim = async (pending: PendingRegistration): Promise<ClaimOutcome> => {
    // 用闭包里的那个实例（由工厂按 configuredOrigin 构造）。
    if (!registrar) return { state: 'superseded' }
    if (pending.cancelled || pendingRegistration !== pending) return { state: 'superseded' }

    // 注册期间用户换了账户：这次注册的绑定对象已经不存在了。
    if (deps.currentUserId() !== pending.userId) {
      cancelRegistration('account changed')
      return { state: 'superseded' }
    }

    // 本机已经持有这台设备的凭据（后台轮询先一步领成功）：**绝不**再发
    // 第二次一次性领取——那只会拿到 409，然后把刚配好的设备撤销掉。
    if (isPairedWith(pending)) return { state: 'claimed' }

    const result = await registrar.claim({ deviceId: pending.deviceId, claimSecret: pending.claimSecret })
    // await 期间可能被 forget / 新注册 / 账户切换取代。三种都要拦：
    // 1. 引用变了（被 forget 或新注册顶替）
    // 2. 自己被标了 cancelled
    // 3. **登录用户变了**——引用可能还是同一个对象（没人动过它），
    //    但身份已经不是发起注册的那个人了
    if (pendingRegistration !== pending || pending.cancelled) return { state: 'superseded' }
    if (deps.currentUserId() !== pending.userId) {
      cancelRegistration('account changed')
      return { state: 'superseded' }
    }

    if (!result.ok) {
      if (result.retryable) {
        scheduleClaimPoll()
        // 202（还没到可领取的时候）与网络抖动都要继续轮询，但**结局不同**：
        // 前者是「流程正常、还没轮到」，后者是「这次没问到」。混成一个
        // `void` 会让确认按钮无法区分「稍后再试」与「网络断了」。
        return result.reason === 'pending'
          ? { state: 'pending' }
          : { state: 'retryable_failure', reason: result.reason }
      }
      return await failTerminalClaim(pending, result.reason)
    }

    // 最后一次身份确认：`store.save` 是异步的（要等 safeStorage 加密），
    // 期间切换账户的话，这份凭据属于「上一个人」，绝不能落盘。
    if (deps.currentUserId() !== pending.userId) {
      cancelRegistration('account changed before save')
      return { state: 'superseded' }
    }

    // 界面必须能看到「凭据保存中」：这正是 safeStorage 加密的窗口。
    setPairingPhase('saving')
    publish()

    // 落盘（safeStorage 密文）。save 内部会比对代际号，forget 之后这里会失败。
    const saved = await store.save({
      deviceId: pending.deviceId,
      boundUserId: pending.userId,
      cloudOrigin: configuredOrigin,
      deviceToken: result.deviceToken,
      privateKey: pending.privateKey,
      registeredAt: Date.now(),
      // Cloud 给的到期时间：主动轮换的唯一判据（协议 §3.4 的 expires_at）。
      tokenExpiresAt: result.expiresAt
    })

    // 落盘期间被取消 / 顶替 / 换账户：把这次写入撤掉（见 discardSavedCredential）。
    // **账户复核必须再做一次**：`store.save` 里的 encrypt 是异步的，
    // 上面那次身份检查之后到写盘之间足够用户切一次账户——那份凭据属于
    // 「上一个人」，绝不能留在他的目录里。
    const replaced = pendingRegistration !== pending || pending.cancelled
    const accountChanged = deps.currentUserId() !== pending.userId
    if (replaced || accountChanged) {
      await discardSavedCredential(pending, saved)
      if (accountChanged && !replaced) cancelRegistration('account changed after save')
      if (accountChanged) log('[remote] discarded a credential written for the previous account')
      return { state: 'superseded' }
    }

    if (!saved.ok) {
      // 代际号对不上 = 有人（forget / 下一轮配对）已经接管了存储，这次写入
      // 本来就被拒绝 → 归为 superseded，不要当成「保存失败」去撤销设备。
      if (saved.reason === 'stale-generation') {
        cancelRegistration('storage generation moved on')
        return { state: 'superseded' }
      }
      return await failSave(pending, saved.reason)
    }

    pendingRegistration = null
    // 这次注册已经收尾：把它自己排的轮询定时器撤掉，别留一个只会空转的回调。
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = null
    deviceId = pending.deviceId
    boundUserId = pending.userId
    deviceToken = result.deviceToken
    privateKey = pending.privateKey
    deviceOrigin = configuredOrigin
    tokenExpiresAt = result.expiresAt
    needsReauth = false
    // 上一次失败留下的错误必须在这里清掉，否则配对成功之后
    // 「最近错误」还挂着「凭据没领到」。
    link.lastError = null
    setPairingPhase('idle')
    if (link.state === 'blocked') transition(link, 'idle')
    log('[remote] device credential acquired and stored')
    publish()
    return { state: 'claimed' }
  }

  /** 构造一个失败结果。**不改 phase**：进度由真正改动状态的那一方负责。 */
  const confirmFailure = (reason: RemoteConfirmFailure): RemoteConfirmResult => ({
    ok: false,
    reason,
    status: publish()
  })

  /** `claim` 的失败原因 → 界面上的一句话（两者是不同的枚举，不能直接透传）。 */
  const claimFailureToConfirmFailure = (reason: RemoteRegistrationFailure): RemoteConfirmFailure => {
    switch (reason) {
      case 'pending':
        return 'claim_pending'
      case 'network':
        return 'claim_network'
      case 'credentials_already_issued':
        return 'credentials_already_issued'
      case 'expired':
        return 'expired'
      case 'unauthorized':
        return 'unauthorized'
      // `claim_rejected` 覆盖 403/404 与「状态不允许领取」：对用户来说都是
      // 「这台设备现在领不了，重新配对」，与 confirm 阶段的 `device_state`
      // 是同一句话。
      case 'claim_rejected':
        return 'device_state'
      // 下面几个只可能出现在 register 的结果里，claim 不会返回。
      // 兜底给 `invalid_response`：宁可说「对端返回了无法识别的响应」，
      // 也不能凭空编一个原因让用户照着做。
      default:
        return 'invalid_response'
    }
  }

  /**
   * 把领取结局翻译成界面能分别解释的确认结果。
   *
   * **`ok: true` 只在 `claimed` 出现**——也就是 `device_token` 已经写进安全
   * 存储之后。Cloud 的 confirm 通过本身**永远不构成**「配对完成」。
   */
  const mapClaimOutcome = (
    outcome: ClaimOutcome
  ): { ok: boolean; reason: RemoteConfirmFailure | null } => {
    switch (outcome.state) {
      case 'claimed':
        return { ok: true, reason: null }
      case 'pending':
        return { ok: false, reason: 'claim_pending' }
      case 'retryable_failure':
        return {
          ok: false,
          reason:
            outcome.reason === 'network'
              ? 'claim_network'
              : claimFailureToConfirmFailure(outcome.reason)
        }
      case 'save_failed':
        // 撤销也失败 → 必须让界面说「需要人工处理」，不能显示成「已清理」。
        return {
          ok: false,
          reason: outcome.revoked ? 'credential_save_failed' : 'credential_cleanup_failed'
        }
      case 'terminal_failure':
        if (outcome.reason === 'credentials_already_issued') {
          return {
            ok: false,
            reason: outcome.revoked ? 'credentials_already_issued' : 'credential_cleanup_failed'
          }
        }
        return { ok: false, reason: claimFailureToConfirmFailure(outcome.reason) }
      case 'superseded':
        return { ok: false, reason: 'superseded' }
    }
  }

  const finishConfirm = (pending: PendingRegistration, outcome: ClaimOutcome): RemoteConfirmResult => {
    const mapped = mapClaimOutcome(outcome)

    if (outcome.state === 'superseded') {
      // 取消 / 顶替 / 换账户发生在领取期间：这不是「这次确认失败」，而是
      // 「这次确认已经不属于当前状态」——进度由对方负责，这里别覆盖。
      return { ok: false, reason: mapped.reason, status: publish() }
    }

    if (mapped.ok) {
      setPairingPhase('idle')
      return { ok: true, reason: null, status: publish() }
    }

    // 领取失败之后、构造结果之前，注册可能已经**换成另一台**（用户重新配对）。
    // 那时进度与错误都归对方管。
    // 注意只判「换成了另一台」，不判 null：终态失败分支正是靠把自己这份
    // pending 清成 null 来收尾的，把 null 也当成被顶替会把真实原因吞掉。
    if (pendingRegistration !== null && pendingRegistration !== pending) {
      return { ok: false, reason: 'superseded', status: publish() }
    }

    if (mapped.reason === 'claim_pending' || mapped.reason === 'claim_network') {
      // 注册仍然有效：保留 pending 与内存凭据，**不落盘、不开 WSS**，
      // 下一次轮询或再次点确认都能接着领（§6A / §6B）。
      setPairingPhase('claim_incomplete')
      link.lastError =
        mapped.reason === 'claim_network'
          ? 'device credential claim failed: network'
          : 'device credentials are not claimable yet'
      log(`[remote] device confirmed but credentials not claimed (${mapped.reason})`)
      return { ok: false, reason: mapped.reason, status: publish() }
    }

    // 终态：runClaim 已经清掉本地临时凭据并（尽力）撤销了云端设备。
    setPairingPhase('failed')
    return { ok: false, reason: mapped.reason, status: publish() }
  }

  /**
   * 用户点「确认信任这台设备」的完整流程（单飞在 `confirmRegistration` 上）。
   *
   * 顺序是硬的：**先确认，再领取凭据**。不能反过来赌确认已经生效——
   * 那会把一个 202 当成「网络慢」反复重试，而用户其实还没点确认。
   *
   * 同样硬的是：**只有凭据真的落盘才返回 `ok: true`**。
   * `ok`曾经在 `await claimOnce()` 之后无条件返回 true，于是「确认成功」
   * 被当成了「配对完成」，而领取可能 202 / 断网 / 409 / 存储写失败。
   */
  const runConfirm = async (): Promise<RemoteConfirmResult> => {
    const pending = pendingRegistration
    if (!pending) return confirmFailure('expired')
    if (!registrar) return confirmFailure('invalid_response')

    // 账户在确认前被换掉：这次配对绑的是上一个人。
    if (deps.currentUserId() !== pending.userId) {
      cancelRegistration('account changed before confirm')
      return confirmFailure('account_changed')
    }
    if (Date.now() >= pending.expiresAt) {
      cancelRegistration('expired')
      return confirmFailure('expired')
    }

    // ---- 1. 关上轮询闸门，等在途的那次领取落定 ----
    // 不等它就直接 confirm 再领，会出现两条路径同时抢同一枚一次性 Token：
    // 一个拿到明文、另一个拿 409 并去撤销设备（R5-R3.4.1 问题 2）。
    confirmInFlight = true
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    try {
      if (claimFlight) await claimFlight.catch(() => undefined)

      // 等待期间可能被 forget / 新注册 / 账户切换取代。
      // **先判账户**：凭据属于谁是身份问题，比「这次注册还在不在」更优先。
      if (deps.currentUserId() !== pending.userId) {
        cancelRegistration('account changed during confirm')
        return confirmFailure('account_changed')
      }
      // 后台轮询已经把凭据领到手：Cloud 侧也已 active，直接算配对完成，
      // **不再发第二次领取**（那会拿到 409 并把刚配好的设备撤销掉）。
      // 这一条必须排在 `pendingRegistration !== pending` **之前**——领取成功
      // 正是靠把 pending 置 null 来收尾的，先判引用会把成功读成「被顶替」。
      if (isPairedWith(pending)) {
        pendingRegistration = null
        setPairingPhase('idle')
        log('[remote] credentials were already claimed by the background poll')
        return { ok: true, reason: null, status: publish() }
      }
      if (pendingRegistration !== pending || pending.cancelled) return confirmFailure('superseded')

      // ---- 2. 请求 Cloud confirm ----
      setPairingPhase('confirming')
      publish()
      const result = await registrar.confirm({
        deviceId: pending.deviceId,
        confirmCode: pending.confirmCode
      })

      if (pendingRegistration !== pending || pending.cancelled) return confirmFailure('superseded')
      if (deps.currentUserId() !== pending.userId) {
        cancelRegistration('account changed during confirm')
        return confirmFailure('account_changed')
      }

      if (!result.ok) {
        // 只有终态错误才丢弃这次注册；其余（码错、限流、网络）保留现场重试。
        if (result.reason === 'expired' || result.reason === 'not_found' || result.reason === 'device_state') {
          cancelRegistration(`confirm ${result.reason}`)
          needsReauth = result.reason === 'device_state'
          link.lastError = `device confirmation failed: ${result.reason}`
          publish()
        } else if (pendingRegistration) {
          // 现场还在：进度退回「等你确认」，按钮不能一直停在「正在确认…」。
          setPairingPhase('awaiting_confirm')
          publish()
        }
        return { ok: false, reason: result.reason, status: publish() }
      }

      // ---- 3. Cloud 已确认 → 这时才允许领取 ----
      log('[remote] device confirmed; claiming credentials')
      setPairingPhase('claiming')
      publish()
      const outcome = await claimOnce('confirm')
      return finishConfirm(pending, outcome)
    } finally {
      confirmInFlight = false
      // 现场还在就恢复轮询：上面任何一条失败分支都不该让轮询永久停摆。
      if (pendingRegistration) scheduleClaimPoll()
    }
  }

  // MARK: - 生命周期

  const serviceApi: RemoteService = {
    async start() {
      if (started) return
      started = true
      dbReady = true
      servicesReady = true

      transport = createLinkTransport(
        {
          onOpen: () => {
            log('[remote] socket open')
            const pending = pendingHello
            // 代际不符 = 这是上一次尝试的回调，绝不能给新 socket 发帧。
            if (!pending || pending.attempt !== connectGeneration) return
            transition(link, 'handshaking')
            const sent = transport?.send(pending.frame) ?? false
            if (!sent) {
              log('[remote] failed to send hello')
              transport?.close(4001, 'hello send failed')
              return
            }
            link.reportedServiceable = pending.serviceable
            armHandshakeDeadline(pending.attempt)
          },
          onFrame: handleFrame,
          onClose: handleClose,
          onError: (message) => {
            // 保留**最近一次**连接错误：这是设置页 `lastError` 的唯一来源，
            // 也是 R1 排障时区分「没连」与「连了被拒」的客户端侧证据。
            link.lastError = message
            log(`[remote] socket error: ${message}`)
            // 必须 publish：`onClose` 之后虽然会再 publish 一次，但「构造
            // 成功、握手前出错」这类路径不一定走到它——不发的话渲染进程
            // 会一直显示上一次的旧状态。
            publish()
          },
          onOversizedFrame: (bytes) => {
            // 协议 §2.2：单帧超过上限 → close 4009。不解析、不回显内容。
            log(`[remote] dropping an oversized frame (${bytes} bytes)`)
            dropConnection(4009, 'frame too large')
          }
        },
        deps.webSocketFactory
      )

      // 读凭据（开关 off 时也要读：状态页要显示绑定情况，但不建连）。
      const loaded = await store.load()
      if (loaded.status === 'ok') {
        deviceId = loaded.identity.deviceId
        boundUserId = loaded.identity.boundUserId
        deviceToken = loaded.identity.deviceToken
        privateKey = loaded.identity.privateKey
        deviceOrigin = loaded.identity.cloudOrigin
        tokenExpiresAt = loaded.identity.tokenExpiresAt
        // Origin 绑定校验：不匹配就 blocked + 要求重新配对。
        if (!sameCloudOrigin(configuredOrigin, loaded.identity.cloudOrigin)) {
          needsReauth = true
          transition(link, 'blocked', 'cloud origin mismatch')
          log('[remote] saved device belongs to another cloud origin')
        }
      } else if (loaded.status === 'failed') {
        needsReauth = true
        link.lastError = `device credentials ${loaded.reason}`
        log(`[remote] device credentials unusable: ${loaded.reason}`)
      } else if (loaded.status === 'unavailable') {
        link.lastError = 'secure storage unavailable'
        log('[remote] secure storage unavailable; remote stays off')
      }

      // 启动安全检查：不依赖 Renderer，不依赖用户打开设置页。
      // 全部收敛到 canConnect()，避免「开关 off 时提前 return 跳过用户校验」
      // 这类分支顺序造成的绕过。
      const gate = canConnect()
      if (!gate.ok) {
        applyGateFailure(gate.code)
        return
      }
      await connect()
    },

    async stop() {
      if (shuttingDown) return
      shuttingDown = true
      abortAttempt()
      cancelRegistration('shutdown')
      clearTimers()
      clearRotationTimer()
      resetConnectionState()
      transport?.close(1000, 'shutdown')
      transport = null
      transition(link, 'idle')
      publish()
    },

    status: service,

    diagnose(): RemoteDiagnosis {
      const snapshot = cache.snapshot()
      return {
        ...service(),
        socketOpen: transport?.isOpen() ?? false,
        inflight: snapshot.inflight,
        cacheEntries: snapshot.entries,
        cacheBytes: snapshot.bytes,
        lastCloseCode: link.lastCloseCode,
        lastCloseReason: link.lastCloseReason
      }
    },

    async enable() {
      // **先过身份门禁，再落盘**。
      //
      // 反过来的话（先写 enabled=true 再让 connect() 发现用户不匹配）会留下一个
      // 窗口：并发的第二次 enable() 把 enabled 又写成 true，而 enterBlocked 已经
      // 跑完，最终状态是「开着 + blocked」。测试抓到了这个序列。
      const gate = identityGate()
      if (!gate.ok) {
        applyGateFailure(gate.code)
        return service()
      }
      localState = { ...localState, enabled: true }
      writeRemoteState(paths, localState)
      publish()
      // 用户刚明确要求开启远程访问：此时出站是预期行为，可以补做逾期轮换。
      // 放在 connect() **之前**——否则会先用一个即将过期（或已过期）的 token
      // 去握手，白跑一次 4001 并让状态闪一下 blocked。
      if (rotationDue()) {
        await rotateCredentials('enable')
      } else {
        await connect()
      }
      return service()
    },

    async disable() {
      localState = { ...localState, enabled: false }
      // 顺序：先落盘（本机立即拒绝新请求），再清缓存（关闭前的数据不能回放），
      // 然后**告诉 Cloud 原因**，最后断连。
      //
      // 为什么不能「直接断」：裸 close 只让 Cloud 知道「掉了」，它会按临时故障
      // 处理（可能保留派发状态、等重连）。显式 `status{false, remote_disabled}`
      // + `bye` 才能让它立刻停止向本机路由。这也是协议 §4.4.1 存在的理由。
      writeRemoteState(paths, localState)
      cache.clear()
      resetGrantContext(grants)
      revokedContexts.clear()
      abortAttempt()
      cancelRegistration('disabled')
      clearTimers()

      if (transport?.isOpen()) {
        const current = verdict()
        transport.send(
          buildStatusFrame({ serviceable: false, reason: current.reason ?? 'remote_disabled', ts: Date.now() })
        )
        transport.send(
          JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, type: 'bye', ts: Date.now(), reason: 'disabled' })
        )
      }
      transport?.close(1000, 'disabled')
      link.reportedServiceable = null
      transition(link, 'idle')
      publish()
      return service()
    },

    async register() {
      if (shuttingDown) throw new Error('remote service is stopping')
      if (!registrar) {
        // 诚实失败：Phase 1.1B.1 还没有把注册接到真实 Cloud（缺用户 Bearer 的
        // 合法来源）。伪造一个「已注册」比报错更糟——用户会以为配对完成了。
        throw new Error('device registration is not wired to Cloud yet')
      }

      // ---- 不允许静默顶替（R5-R3.4.1 §9）----
      // 以前这里 `cancelRegistration('superseded')` 会把上一次配对直接扔掉：
      // 确认码还在用户手上、Cloud 上还有一台 pending 设备，而界面已经换成了
      // 新的一台。用户必须先完成当前配对，或明确走「取消 / 忘记设备」。
      if (pendingRegistration) {
        throw new Error('a device pairing is already in progress; confirm or cancel it first')
      }
      // 每个 userData 目录只保存**一份**设备身份：已有 device.json 时再注册
      // 会把可用凭据顶掉（用户会莫名其妙掉线）。必须先「忘记此设备」。
      if (deviceId !== null) {
        throw new Error('this device is already paired; forget it before pairing again')
      }

      const userId = deps.currentUserId()
      if (!userId) throw new Error('sign in before registering a device')

      // 让上一轮残留的领取先落定，避免旧注册的收尾去改动新注册的状态。
      // （上面的守卫已经保证没有进行中的配对，这里等的只是收尾。）
      if (claimFlight) await claimFlight.catch(() => undefined)
      // 等待期间状态可能又变了（例如等待期间被 forget 掉）。
      if (pendingRegistration) {
        throw new Error('a device pairing is already in progress; confirm or cancel it first')
      }
      if (deviceId !== null) {
        throw new Error('this device is already paired; forget it before pairing again')
      }

      // 新密钥只存在内存里，领取成功后才会连 device_token 一起加密落盘。
      const { privateKey: newKey, publicKey } = generateDeviceKeyPair()

      const deviceName = deps.deviceName ?? hostname()
      const result = await registrar.register({
        name: deviceName,
        platform: process.platform,
        publicKey: encodeRawPublicKey(publicKey),
        appVersion: deps.clientVersion ?? safeAppVersion()
      })
      if (!result.ok) throw new Error(`device registration failed: ${result.reason}`)

      pendingRegistration = {
        deviceId: result.deviceId,
        claimSecret: result.claimSecret,
        privateKey: newKey,
        userId,
        expiresAt: result.expiresAt,
        confirmCode: result.confirmCode,
        deviceName,
        platform: process.platform,
        accountLabel: deps.currentUserLabel ? deps.currentUserLabel() : null,
        cancelled: false,
        timer: null
      }
      setPairingPhase('awaiting_confirm')
      log('[remote] registration pending; waiting for the user to confirm')
      publish()
      // 轮询仍然保留：用户也可能在别处（以后的网页/手机端）确认，而 Desktop
      // 只负责把「确认已经生效」这件事收敛成凭据。本地点确认会更快一步。
      scheduleClaimPoll()
      return {
        deviceId: result.deviceId,
        deviceName,
        platform: process.platform,
        confirmCode: result.confirmCode,
        expiresAt: result.expiresAt,
        accountLabel: deps.currentUserLabel ? deps.currentUserLabel() : null
      }
    },

    /**
     * 用户点「确认信任这台设备」。
     *
     * **单飞**：两次并发调用复用同一个结果。第二个调用若各走各的，会在第一次
     * 已经领完之后**再领一次**——一次性领取拿到 409，失败路径随即把刚配好的
     * 设备撤销掉。
     *
     * `ok: true` 的唯一条件是 `device_token` 已经写进安全存储（见 `runConfirm`）。
     */
    async confirmRegistration() {
      if (confirmFlight) return confirmFlight
      const flight = runConfirm().then(
        (value) => {
          confirmFlight = null
          return value
        },
        (error: unknown) => {
          confirmFlight = null
          throw error
        }
      )
      confirmFlight = flight
      return flight
    },

    /**
     * 用户点「取消本次配对」。
     *
     * 本地一定清干净（停轮询、抹 claim_secret、清 pending）。云端撤销是尽力
     * 而为：撤不成也要如实告诉界面 `revoked: false`——那台设备会停在 pending
     * 直到 `expiresAt` 被服务端清扫，而不是「从未存在过」。
     *
     * **必须等在途的领取落定再返回**：领取可能正在 safeStorage 里加密写入，
     * 不等它就报「已取消」，界面会先说取消、几百毫秒后磁盘上又冒出一份凭据。
     * 等到之后由 `discardSavedCredential` 把那次写入撤掉（代际号 +1 再删）。
     */
    async cancelRegistrationNow() {
      const pending = pendingRegistration
      if (!pending) return { revoked: true, status: publish() }

      const deviceIdToRevoke = pending.deviceId
      // 1. 先标记取消：新的领取立刻被拒，轮询停摆，进度归零。
      cancelRegistration('user cancelled')
      // 2. 让在途的 claim/save 收尾（它会自己撤掉已经写进去的凭据）。
      if (claimFlight) await claimFlight.catch(() => undefined)
      // 3. 再撤销云端那台 pending 设备。
      let revoked = false
      if (registrar) {
        const result = await registrar.revoke({ deviceId: deviceIdToRevoke })
        revoked = result.ok
        if (!result.ok) {
          log(`[remote] failed to revoke the pending device (${result.reason})`)
          link.lastError = `device revoke failed: ${result.reason}`
        }
      }
      return { revoked, status: publish() }
    },

    async forget() {
      // 顺序：先停路由（关开关）→ 清缓存/上下文 → 代际号 +1 并删凭据。
      localState = { ...localState, enabled: false }
      writeRemoteState(paths, localState)
      cache.clear()
      resetGrantContext(grants)
      revokedContexts.clear()
      abortAttempt()
      cancelRegistration('forget')
      clearTimers()
      transport?.close(1000, 'forget')
      const result = await store.forget()
      deviceId = null
      boundUserId = null
      deviceToken = null
      privateKey = null
      deviceOrigin = null
      needsReauth = false
      if (link.state !== 'idle') transition(link, 'idle')
      if (!result.ok) link.lastError = `forget failed: ${result.reason}`
      publish()
      return service()
    },

    async unbind() {
      // 解绑 = 忘记设备 + 清 needsReauth。设备身份不能跨用户复用。
      return serviceApi.forget()
    },

    async prepareForSignOut() {
      // 轮换可能正卡在 HTTP 上。**等它落定**再让账户侧清凭据：
      // 中途放手会让新 token（Cloud 已下发、只出现一次）永久丢失，
      // 而这台设备下次启动就会带着已作废的旧 token 撞 401。
      if (rotation) {
        await rotation.promise.catch(() => undefined)
      }
      // **必须在账户凭据清除之前调用**：那时 device_token 仍然有效。
      localState = { ...localState, enabled: false }
      writeRemoteState(paths, localState)
      // 1. 本地立即拒绝新请求（isEnabled 已为 false）
      // 2. 停止重连与在途尝试
      abortAttempt()
      cancelRegistration('sign out')
      clearTimers()
      // 3. 尽力告知 Cloud 并断开
      if (transport?.isOpen()) {
        transport.send(JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, type: 'bye', ts: Date.now(), reason: 'sign_out' }))
      }
      // 4. 清缓存与上下文（设备凭据按约定保留，用户可再登录后继续用）
      cache.clear()
      resetGrantContext(grants)
      revokedContexts.clear()
      transport?.close(1000, 'sign_out')
      transition(link, 'idle')
      publish()
    },

    async reconcile() {
      if (shuttingDown) return

      // 已登录用户变了（或登出）：这是安全事件，必须断开并置 blocked。
      if (boundUserId !== null && deps.currentUserId() !== boundUserId) {
        enterBlocked('signed-in user differs from the bound user')
        return
      }

      // 能力变化（例如开关刚被别处关掉）：上报即可，不必断。
      if (link.state === 'online') reportStatus()

      const gate = canConnect()
      if (!gate.ok) {
        // 从「已连上」变成「开关被关掉」时要收敛到 idle，否则会留着一个
        // 谁也不会去关的 socket。但 **blocked 不能碰**：它是需要用户处理的
        // 终态，把它降级成 idle 会让界面看起来「没事了」，而 needsReauth 还是 true。
        const live = link.state === 'online' || link.state === 'draining' || link.state === 'connecting' || link.state === 'handshaking'
        if (gate.code === 'disabled' && live) applyGateFailure(gate.code)
        publish()
        return
      }

      // 从「不可服务」恢复到「可服务」且尚未连接时，补一次连接。
      if (link.state === 'idle' || link.state === 'backoff') {
        await connect()
        return
      }
      publish()
    },

    suspend() {
      // 睡眠：不信任旧 socket。清理上下文，唤醒后重新握手。
      abortAttempt()
      clearTimers()
      resetConnectionState()
      transport?.close(1000, 'suspend')
      if (link.state === 'online' || link.state === 'draining') transition(link, 'backoff')
      publish()
    },

    async resume() {
      // 唤醒后 attempt 归零：睡眠不是故障，不该继承之前的退避档位。
      abortAttempt()
      link.reconnectAttempt = 0
      // 睡眠期间可能整段跨过了轮换窗口（笔记本合盖两周是常态）。
      // 先轮换再连：轮换成功会用新凭据自己重连，失败则走 blocked。
      if (rotationDue()) {
        await rotateCredentials('resume')
        return
      }
      await connect()
    }
  }

  return serviceApi
}

function safeAppVersion(): string {
  try {
    const version = app?.getVersion?.()
    return typeof version === 'string' && version ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function toWebSocketUrl(origin: string): string {
  try {
    const url = new URL(origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/device-link'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return origin
  }
}

function describeClose(code: number, reason: string): string {
  const label = CLOSE_LABELS[code]
  const base = label ? `${label} (${code})` : `closed ${code}`
  return reason ? `${base}: ${reason}` : base
}

const CLOSE_LABELS: Record<number, string> = {
  4001: 'device unauthorized',
  4002: 'protocol version unsupported',
  4003: 'device revoked',
  4004: 'handshake rejected',
  4005: 'device suspended',
  4006: 'superseded by another connection',
  4009: 'session ended',
  4010: 'reauth required'
}

export type { InstalledGrant, RemoteLinkState }
