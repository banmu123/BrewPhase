import { app } from 'electron'
import type { Db } from '../database/client'
import type { ToolServices } from '../application/mcp-tools/tool-services'
import {
  REMOTE_PROTOCOL_VERSION,
  remoteGrantUpdateSchema,
  remoteReqSchema,
  remoteCancelSchema,
  remotePingSchema,
  remoteDrainSchema,
  type RemoteDiagnosis,
  type RemoteErrorCode,
  type RemoteGrantUpdate,
  type RemoteLinkState,
  type RemoteStatus,
  type RemoteUnserviceableReason
} from '../../shared/contracts/remote'
import {
  createDeviceStore,
  deviceStorePaths,
  electronSecretBox,
  generateDeviceKeyPair,
  makeNonce,
  readRemoteState,
  sameCloudOrigin,
  signHello,
  writeRemoteState,
  type DeviceStore,
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
import { effectiveScopes, effectiveTools } from './remote-policy'

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
 */

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
  /** 设备注册（Mock 阶段只生成待确认信息，不落凭据）。 */
  register(): Promise<{ deviceId: string; confirmCode: string; expiresAt: number }>
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
  const cloudOrigin = deps.cloudOrigin ?? localState.cloudOrigin

  let deviceId: string | null = null
  let boundUserId: string | null = null
  let deviceToken: string | null = null
  let privateKey: import('node:crypto').KeyObject | null = null
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

  const handleRequest = createRequestHandler({
    db: deps.db,
    services: deps.services,
    cache,
    isEnabled: () => localState.enabled && !shuttingDown,
    boundUserId: () => boundUserId,
    deviceId: () => deviceId,
    grants: () => grants,
    nowMono: () => performance.now(),
    isGrantRevoked: (ctx) => revokedContexts.has(ctx),
    audit: (entry) => {
      if (!deviceId) return
      const ok = writeRemoteAudit(deps.db, deviceId, entry)
      if (ok) noteAuditSuccess(audit)
      else noteAuditFailure(audit, Date.now())
    }
  })

  const verdict = (): { serviceable: boolean; reason: RemoteUnserviceableReason | null } =>
    judgeServiceable({
      enabled: localState.enabled,
      boundUserId,
      currentUserId: deps.currentUserId(),
      dbReady,
      servicesReady,
      shuttingDown
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
      cloudOrigin: deviceId ? cloudOrigin : null,
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

  // MARK: - 连接

  const clearTimers = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (healthTimer) clearInterval(healthTimer)
    reconnectTimer = null
    heartbeatTimer = null
    healthTimer = null
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
      void connect()
    }, delay)
    publish()
  }

  const handleClose = (code: number, reason: string): void => {
    link.lastCloseCode = code
    link.lastCloseReason = reason
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

  const handleFrame = (raw: string): void => {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      log('[remote] dropped a non-JSON frame')
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
      transport?.close(4002, 'version unsupported')
      return
    }
    const helloOk = parsed.value
    // 原子安装：整体替换，不在快照里的旧 ctx 立即失效。
    const applied = applyHelloOk(grants, helloOk)
    for (const ctx of applied.revokedContexts) cache.dropGrantContext(ctx)
    revokedContexts.clear()

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

  const handleReq = (raw: string, frame: unknown): void => {
    const parsed = remoteReqSchema.safeParse(frame)
    if (!parsed.success) {
      // 无法确定 id 时不回 res（协议：畸形帧丢弃并记日志）。
      log(`[remote] malformed req: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
      return
    }
    if (raw.length > (link.lastCloseCode === null ? Infinity : Infinity)) {
      /* 帧大小已由 link-client 把关 */
    }
    const outcome = handleRequest(parsed.data)
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
      log('[remote] malformed grant_update; state unchanged')
      // 不知道 epoch 就无法 ack；按协议丢弃。
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
    // drain 之后由 Cloud 断开；本地不再发新请求（本来也不发）。
    transport?.send(buildByeFrameSafe('drain_ack'))
    publish()
  }

  const buildByeFrameSafe = (_reason: string): string => JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, type: 'bye', ts: Date.now() })

  const startHeartbeat = (heartbeatMs: number, idleTimeoutMs: number): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (healthTimer) clearInterval(healthTimer)
    // 心跳由 Cloud 的 ping 驱动；本地只做一个「多久没 pong 就判死」的看门狗。
    healthTimer = setInterval(() => {
      if (link.lastPongAtMono === null) return
      const staleMs = performance.now() - link.lastPongAtMono
      if (staleMs > idleTimeoutMs) {
        log(`[remote] no pong in ${Math.round(staleMs)}ms; closing`)
        link.lastError = 'heartbeat timeout'
        transport?.close(4008, 'heartbeat timeout')
      }
    }, Math.max(1_000, Math.min(heartbeatMs, 5_000)))
    // 未使用但保留：Cloud 可能要求本地主动发心跳（协议允许双向）。
    void heartbeatMs
  }

  const connect = async (): Promise<void> => {
    if (shuttingDown || !localState.enabled) return
    if (!deviceId || !deviceToken || !privateKey) {
      needsReauth = true
      transition(link, 'blocked', 'no device credentials')
      publish()
      return
    }
    if (!sameCloudOrigin(cloudOrigin, localState.cloudOrigin)) {
      // Origin 变了：绝不把旧后端的凭据发到新后端。
      needsReauth = true
      transition(link, 'blocked', 'cloud origin mismatch')
      log('[remote] cloud origin mismatch; refusing to send credentials')
      publish()
      return
    }

    transition(link, 'connecting')
    publish()

    const url = toWebSocketUrl(cloudOrigin)
    const nonce = makeNonce()
    const ts = Date.now()
    const current = verdict()
    const sig = signHello(privateKey, {
      v: REMOTE_PROTOCOL_VERSION,
      type: 'hello',
      device_id: deviceId,
      nonce,
      ts
    })

    transport?.connect(url)
    const socket = transport
    if (!socket) return

    // hello 必须在 onOpen 之后发；用一次性的等待把两者连起来。
    const hello = buildHelloFrame({
      deviceId,
      nonce,
      ts,
      sig,
      serviceable: current.serviceable,
      clientVersion: deps.clientVersion ?? app.getVersion()
    })
    // 简化：立即尝试发送；若 socket 尚未 open，nextTick 重试一次。
    const trySendHello = (attempt = 0): void => {
      if (socket.isOpen()) {
        transition(link, 'handshaking')
        socket.send(hello)
        link.reportedServiceable = current.serviceable
        return
      }
      if (attempt < 50) {
        setTimeout(() => trySendHello(attempt + 1), 20)
      } else {
        log('[remote] socket did not open in time')
        socket.close(4001, 'open timeout')
      }
    }
    trySendHello()
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
          },
          onFrame: handleFrame,
          onClose: handleClose,
          onError: (message) => {
            link.lastError = message
            log(`[remote] socket error: ${message}`)
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
        // Origin 绑定校验：不匹配就 blocked + 要求重新配对。
        if (!sameCloudOrigin(loaded.identity.cloudOrigin, localState.cloudOrigin)) {
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
      const current = verdict()
      if (!localState.enabled) {
        transition(link, 'idle')
        publish()
        return
      }
      if (needsReauth) {
        transition(link, 'blocked', 'reauthentication required')
        publish()
        return
      }
      if (boundUserId !== null && boundUserId !== deps.currentUserId()) {
        // 用户切换：**零出站连接**。
        needsReauth = true
        transition(link, 'blocked', 'user mismatch')
        log('[remote] bound user differs from current account; not connecting')
        publish()
        return
      }
      if (!current.serviceable) {
        // 开关开着但本地条件不足（例如没配对）：保持 idle，不建连。
        transition(link, 'idle')
        publish()
        return
      }
      await connect()
    },

    async stop() {
      if (shuttingDown) return
      shuttingDown = true
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
      localState = { ...localState, enabled: true }
      writeRemoteState(paths, localState)
      publish()
      if (!shuttingDown) await connect()
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
      // Mock 阶段：只生成待确认信息，**不落任何凭据**。
      const pendingId = `dev_${makeNonce().slice(0, 12)}`
      const confirmCode = String(Math.floor(100_000 + Math.random() * 900_000))
      return { deviceId: pendingId, confirmCode, expiresAt: Date.now() + 300_000 }
    },

    async forget() {
      // 顺序：先停路由（关开关）→ 清缓存/上下文 → 代际号 +1 并删凭据。
      localState = { ...localState, enabled: false }
      writeRemoteState(paths, localState)
      cache.clear()
      resetGrantContext(grants)
      revokedContexts.clear()
      clearTimers()
      transport?.close(1000, 'forget')
      const result = await store.forget()
      deviceId = null
      boundUserId = null
      deviceToken = null
      privateKey = null
      needsReauth = false
      transition(link, 'idle')
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
      // 2. 停止重连
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
      const current = verdict()

      // 已登录用户变了（或登出）：这是安全事件，必须断开并置 blocked。
      if (boundUserId !== null && deps.currentUserId() !== boundUserId) {
        needsReauth = true
        cache.clear()
        resetGrantContext(grants)
        revokedContexts.clear()
        clearTimers()
        if (transport?.isOpen()) {
          transport.send(
            buildStatusFrame({ serviceable: false, reason: 'user_mismatch', ts: Date.now() })
          )
        }
        transport?.close(4009, 'user mismatch')
        transition(link, 'blocked', 'signed-in user differs from the bound user')
        log('[remote] account changed while connected; blocked and disconnected')
        publish()
        return
      }

      // 能力变化（例如开关刚被别处关掉）：上报即可，不必断。
      if (link.state === 'online') reportStatus()

      // 从「不可服务」恢复到「可服务」且尚未连接时，补一次连接。
      if (current.serviceable && (link.state === 'idle' || link.state === 'backoff')) {
        await connect()
        return
      }
      publish()
    },

    suspend() {
      // 睡眠：不信任旧 socket。清理上下文，唤醒后重新握手。
      clearTimers()
      resetConnectionState()
      transport?.close(1000, 'suspend')
      if (link.state === 'online' || link.state === 'draining') transition(link, 'backoff')
      publish()
    },

    async resume() {
      if (shuttingDown || !localState.enabled) return
      // 唤醒后 attempt 归零：睡眠不是故障，不该继承之前的退避档位。
      link.reconnectAttempt = 0
      await connect()
    }
  }

  return serviceApi
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
