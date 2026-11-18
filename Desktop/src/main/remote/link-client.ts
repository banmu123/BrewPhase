import {
  NO_RECONNECT_CLOSE_CODES,
  REMOTE_CLOSE_CODES,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_PROTOCOL_VERSION,
  REAUTH_CLOSE_CODE,
  remoteHelloOkSchema,
  type RemoteHelloOk,
  type RemoteUnserviceableReason
} from '../../shared/contracts/remote'

/**
 * WSS 客户端：只负责「把帧送出去、把帧收回来」，不含任何业务判断。
 *
 * 依赖 Electron 主进程的原生 `WebSocket`（Spike S1 在 Electron 45.2.3 实测：
 * 存在、可连本机 Mock、文本帧收发正常、close/error 事件触发、
 * **自定义 4xxx close code 与 reason 能精确到达**）。因此不引入 `ws` 依赖。
 *
 * 分工：
 * - 本文件：连接、收发、心跳计时、close code 分类、把收帧交给回调。
 * - `link-state.ts`：状态机与 `serviceable` 判定。
 * - `remote-service.ts`：何时连、何时断、重连退避。
 * - `request-handler.ts`：收到 `req` 之后的一切。
 */

export type LinkTransportEvents = {
  onOpen(): void
  onFrame(raw: string): void
  onClose(code: number, reason: string): void
  onError(message: string): void
}

export type LinkTransport = {
  /** 建立连接。已连接时先关旧的。 */
  connect(url: string, headers?: Record<string, string>): void
  send(raw: string): boolean
  close(code?: number, reason?: string): void
  isOpen(): boolean
  /** 不重连的 close code 判定。 */
  classifyClose(code: number): 'no-reconnect' | 'reauth' | 'retry'
}

/** 原生 WebSocket 的最小结构（只声明用到的部分，便于测试替身）。 */
type NativeWebSocket = {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null
}

export type WebSocketFactory = (url: string) => NativeWebSocket

const OPEN = 1

export function nativeWebSocketFactory(url: string): NativeWebSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => NativeWebSocket }).WebSocket
  if (!Ctor) {
    // 结构化失败：不要静默降级成轮询或 HTTP。
    throw new Error('WebSocket is not available in this runtime')
  }
  return new Ctor(url)
}

export function createLinkTransport(
  events: LinkTransportEvents,
  factory: WebSocketFactory = nativeWebSocketFactory
): LinkTransport {
  let socket: NativeWebSocket | null = null
  /** 关闭序号：防止旧 socket 的 onclose 覆盖新 socket 的状态。 */
  let generation = 0

  const dispose = (): void => {
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close()
    } catch {
      /* 已经断了 */
    }
    socket = null
  }

  return {
    connect(url) {
      dispose()
      const current = ++generation
      const next = factory(url)
      socket = next

      next.onopen = () => {
        if (current !== generation) return
        events.onOpen()
      }

      next.onmessage = (event) => {
        if (current !== generation) return
        const data = event.data
        if (typeof data !== 'string') {
          // 协议只走文本帧。二进制帧按畸形处理，不尝试解码。
          events.onError('received a non-text frame')
          return
        }
        if (data.length > REMOTE_MAX_FRAME_BYTES) {
          events.onError(`frame exceeds ${REMOTE_MAX_FRAME_BYTES} bytes`)
          return
        }
        events.onFrame(data)
      }

      next.onerror = () => {
        if (current !== generation) return
        // 原生 Event 不携带可用信息；具体原因由随后的 onclose 给出。
        events.onError('websocket error')
      }

      next.onclose = (event) => {
        if (current !== generation) return
        socket = null
        events.onClose(event.code, event.reason ?? '')
      }
    },

    send(raw) {
      if (!socket || socket.readyState !== OPEN) return false
      try {
        socket.send(raw)
        return true
      } catch {
        return false
      }
    },

    close(code = REMOTE_CLOSE_CODES.NORMAL, reason = '') {
      // 先递增 generation，让这次 close 的回调被忽略（主动关闭不算异常）。
      generation += 1
      dispose()
    },

    isOpen() {
      return socket !== null && socket.readyState === OPEN
    },

    classifyClose(code) {
      if (NO_RECONNECT_CLOSE_CODES.has(code)) return 'no-reconnect'
      if (code === REAUTH_CLOSE_CODE) return 'reauth'
      return 'retry'
    }
  }
}

/** 解析 `hello_ok`：闭合键集 + 类型校验。失败返回原因，不改任何状态。 */
export function parseHelloOk(raw: string): { ok: true; value: RemoteHelloOk } | { ok: false; message: string } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, message: 'hello_ok is not valid JSON' }
  }
  // 版本不兼容要报得更准确（Cloud 可能用更高版本、不同帧形状）。
  if (json && typeof json === 'object' && (json as { type?: unknown }).type === 'hello_ok') {
    const v = (json as { v?: unknown }).v
    if (typeof v === 'number' && v !== REMOTE_PROTOCOL_VERSION) {
      return { ok: false, message: `unsupported protocol version: ${v}` }
    }
  }
  const parsed = remoteHelloOkSchema.safeParse(json)
  if (!parsed.success) {
    return { ok: false, message: `hello_ok shape invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}` }
  }
  return { ok: true, value: parsed.data }
}

/** 构造 `hello` 帧（签名由调用方提供——它需要私钥）。 */
export function buildHelloFrame(input: {
  deviceId: string
  nonce: string
  ts: number
  sig: string
  serviceable: boolean
  clientVersion: string
}): string {
  return JSON.stringify({
    v: REMOTE_PROTOCOL_VERSION,
    type: 'hello',
    ts: input.ts,
    device_id: input.deviceId,
    nonce: input.nonce,
    sig: input.sig,
    serviceable: input.serviceable,
    client_version: input.clientVersion
  })
}

export function buildStatusFrame(input: {
  serviceable: boolean
  reason: RemoteUnserviceableReason | null
  ts: number
}): string {
  const frame: Record<string, unknown> = {
    v: REMOTE_PROTOCOL_VERSION,
    type: 'status',
    ts: input.ts,
    serviceable: input.serviceable
  }
  if (!input.serviceable && input.reason) frame.reason = input.reason
  return JSON.stringify(frame)
}

export function buildPongFrame(seq: number, inflight: number, ts: number): string {
  return JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, type: 'pong', ts, seq, inflight })
}

export function buildGrantAck(epoch: number, applied: boolean, reason: string, ts: number): string {
  return JSON.stringify({
    v: REMOTE_PROTOCOL_VERSION,
    type: 'grant_update_ack',
    ts,
    grant_epoch: epoch,
    applied,
    reason
  })
}

export function buildResFrame(input: {
  id: string
  ok: true
  data: unknown
  meta: { duration_ms: number; cached: boolean }
} | {
  id: string
  ok: false
  error: { code: string; message: string; retryable: boolean }
  meta: { duration_ms: number; cached: boolean }
}): string {
  const base = {
    v: REMOTE_PROTOCOL_VERSION,
    type: 'res',
    ts: Date.now(),
    id: input.id,
    ok: input.ok,
    meta: input.meta
  }
  return JSON.stringify(
    input.ok ? { ...base, data: input.data } : { ...base, error: input.error }
  )
}

export function buildByeFrame(reason: string, ts: number): string {
  return JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, type: 'bye', ts, reason })
}
