import { app } from 'electron'
import { hostname } from 'node:os'
import type { Db } from '../database/client'
import type { ToolServices } from '../application/mcp-tools/tool-services'
import {
  REMOTE_HELLO_CAPABILITIES,
  REMOTE_PROTOCOL_VERSION,
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
  writeRemoteState,
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
import type { DeviceRegistrar } from './registration'

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

export type RemoteServiceDeps = {
  db: Db
  services: ToolServices
  /** 当前登录的 Cloud 用户 id（没有则 null）。 */
  currentUserId(): string | null
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
   * 设备注册客户端。
   *
   * **生产环境默认没有**：真实 Cloud 的注册端点要求用户 Bearer，而 Remote
   * 拿不到用户 token（凭据域分离）。Phase 1.2 才把它接到 AccountService 上。
   * 在此之前 `register()` 会明确抛错，而不是伪造一个假成功。
   */
  registrar?: DeviceRegistrar
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
  let reauthAttempts = 0
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
  let pendingRegistration: {
    deviceId: string
    claimSecret: string
    privateKey: import('node:crypto').KeyObject
    userId: string
    expiresAt: number
    cancelled: boolean
    timer: NodeJS.Timeout | null
  } | null = null

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

  const publish = (): void => {
    deps.onChanged?.(service())
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
      // 4010：换凭证重连**一次**，避免死循环。
      reauthAttempts += 1
      if (reauthAttempts > 1) {
        transition(link, 'blocked', 'reauthentication required')
        needsReauth = true
        log('[remote] closed 4010 after reauth attempt; blocking')
        publish()
        return
      }
      needsReauth = true
      log('[remote] closed 4010; reauth required')
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
      reauthAttempts = 0
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
    log(`[remote] registration cancelled (${reason})`)
  }

  const scheduleClaimPoll = (): void => {
    const pending = pendingRegistration
    if (!pending || pending.cancelled) return
    if (Date.now() >= pending.expiresAt) {
      cancelRegistration('expired')
      needsReauth = true
      link.lastError = 'device registration expired'
      if (link.state !== 'blocked') transition(link, 'blocked', 'device registration expired')
      publish()
      return
    }
    pending.timer = setTimeout(() => {
      if (pendingRegistration === pending) void claimOnce()
    }, REGISTRATION_POLL_MS)
  }

  const claimOnce = async (): Promise<void> => {
    const pending = pendingRegistration
    if (!pending || pending.cancelled) return
    const registrar = deps.registrar
    if (!registrar) return

    // 注册期间用户换了账户：这次注册的绑定对象已经不存在了。
    if (deps.currentUserId() !== pending.userId) {
      cancelRegistration('account changed')
      return
    }

    const result = await registrar.claim({ deviceId: pending.deviceId, claimSecret: pending.claimSecret })
    // await 期间可能被 forget / 新注册 / 登出取代——引用相等是判据。
    if (pendingRegistration !== pending || pending.cancelled) return

    if (!result.ok) {
      if (result.retryable) {
        scheduleClaimPoll()
        return
      }
      cancelRegistration(result.reason)
      needsReauth = true
      link.lastError = `device registration failed: ${result.reason}`
      if (link.state !== 'blocked') transition(link, 'blocked', `registration ${result.reason}`)
      publish()
      return
    }

    // 落盘（safeStorage 密文）。save 内部会比对代际号，forget 之后这里会失败。
    const saved = await store.save({
      deviceId: pending.deviceId,
      boundUserId: pending.userId,
      cloudOrigin: configuredOrigin,
      deviceToken: result.deviceToken,
      privateKey: pending.privateKey,
      registeredAt: Date.now()
    })
    if (pendingRegistration !== pending) return

    pendingRegistration = null
    if (!saved.ok) {
      needsReauth = true
      link.lastError = `device credential save failed: ${saved.reason}`
      if (link.state !== 'blocked') transition(link, 'blocked', 'device credential save failed')
      log('[remote] failed to persist the new device credential')
      publish()
      return
    }

    deviceId = pending.deviceId
    boundUserId = pending.userId
    deviceToken = result.deviceToken
    privateKey = pending.privateKey
    deviceOrigin = configuredOrigin
    needsReauth = false
    if (link.state === 'blocked') transition(link, 'idle')
    log('[remote] device credential acquired and stored')
    publish()
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
            link.lastError = message
            log(`[remote] socket error: ${message}`)
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
      await connect()
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
      const registrar = deps.registrar
      if (!registrar) {
        // 诚实失败：Phase 1.1B.1 还没有把注册接到真实 Cloud（缺用户 Bearer 的
        // 合法来源）。伪造一个「已注册」比报错更糟——用户会以为配对完成了。
        throw new Error('device registration is not wired to Cloud yet')
      }
      const userId = deps.currentUserId()
      if (!userId) throw new Error('sign in before registering a device')

      cancelRegistration('superseded')
      // 新密钥只存在内存里，领取成功后才会连 device_token 一起加密落盘。
      const { privateKey: newKey, publicKey } = generateDeviceKeyPair()

      const result = await registrar.register({
        name: deps.deviceName ?? hostname(),
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
        cancelled: false,
        timer: null
      }
      log('[remote] registration pending; waiting for the user to confirm')
      publish()
      scheduleClaimPoll()
      return { deviceId: result.deviceId, confirmCode: result.confirmCode, expiresAt: result.expiresAt }
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
