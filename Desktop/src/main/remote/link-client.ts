import {
  NO_RECONNECT_CLOSE_CODES,
  REMOTE_CLOSE_CODES,
  REMOTE_HELLO_CAPABILITIES,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_PROTOCOL_VERSION,
  REAUTH_CLOSE_CODE,
  remoteHelloOkSchema,
  type RemoteHello,
  type RemoteHelloOk,
  type RemoteUnserviceableReason
} from '../../shared/contracts/remote'

/**
 * WSS 客户端：只负责「把帧送出去、把帧收回来」，不含任何业务判断。
 *
 * ## 为什么用 Electron 的 `net.WebSocket` 而不是全局 `WebSocket`
 *
 * 协议 §4.1 要求握手带 `Authorization: Bearer bp_dev_…`。Spike（Electron 45.2.3
 * 真实主进程）实测：
 *
 * | 能力 | `net.WebSocket` | 全局 `WebSocket` |
 * |---|---|---|
 * | 自定义 header | ✅ 服务端收到完整 Bearer | ❌ 标准 API 没有这个能力 |
 * | 子协议 | ✅ `Sec-WebSocket-Protocol` 正确送达 | ✅ |
 * | 服务端发起的 4xxx close code | ✅ 精确到达（需完整关闭握手） | ✅ |
 *
 * 所以**必须**用 `net.WebSocket`。全局 `WebSocket` 只在「不需要任何自定义头」
 * 时才是合法回退——带 header 却静默丢掉，等于认证实际没做而测试全绿，
 * 这正是本阶段要消灭的那类问题，所以那种情况直接抛错。
 *
 * 另一个 Spike 结论：TLS 失败时服务端**连 header 都收不到**
 * （`net::ERR_INSECURE_RESPONSE`），所以不存在「明文把 token 送给中间人」的窗口。
 *
 * 分工：
 * - 本文件：连接、收发、帧大小、close code 分类、把收帧交给回调。
 * - `link-state.ts`：状态机与 `serviceable` 判定。
 * - `remote-service.ts`：何时连、何时断、重连退避、握手计时。
 * - `request-handler.ts`：收到 `req` 之后的一切。
 */

export type LinkTransportEvents = {
  onOpen(): void
  onFrame(raw: string): void
  onClose(code: number, reason: string): void
  onError(message: string): void
  /**
   * 收到超过 `maxFrameBytes` 的帧。
   *
   * 单独一个事件而不是走 `onError`：协议 §2.2 要求这种情况 **close 4009**，
   * 而「socket 报了个错」不需要断连。两者混在一起，实现里就只能靠匹配错误
   * 文案来决定要不要关，那是典型的脆弱写法。
   */
  onOversizedFrame(bytes: number): void
}

/** 建立连接所需的全部选项。**headers 必须能真正到达底层**。 */
export type WebSocketConnectOptions = {
  headers?: Record<string, string>
  protocols?: string[]
}

export type LinkTransport = {
  /** 建立连接。已连接时先关旧的。 */
  connect(url: string, options?: WebSocketConnectOptions): void
  send(raw: string): boolean
  /** close code / reason 必须原样传到 socket（协议 §9.2 的业务语义靠它）。 */
  close(code?: number, reason?: string): void
  isOpen(): boolean
  /** 不重连的 close code 判定。 */
  classifyClose(code: number): 'no-reconnect' | 'reauth' | 'retry'
  /**
   * 收紧入站帧上限。
   *
   * 取 `min(本机 REMOTE_MAX_FRAME_BYTES, hello_ok.max_frame_bytes)`：
   * Cloud 说可以更小就必须更小（它更了解自己的转发链路），
   * 但**不能更大**——本机上限是内存保护，不该被对端协商掉。
   */
  setMaxFrameBytes(bytes: number): void
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

export type WebSocketFactory = (url: string, options: WebSocketConnectOptions) => NativeWebSocket

const OPEN = 1

/**
 * 生产工厂：Electron 主进程的 `net.WebSocket`。
 *
 * 用惰性 `require` 而不是顶层 `import`，原因与 `remote-service.ts` 一致：
 * 单元测试（node 环境）不加载 electron 时也不会在 import 期就炸。
 */
export function netWebSocketFactory(url: string, options: WebSocketConnectOptions = {}): NativeWebSocket {
  const net = loadElectronNet()
  if (net) {
    return new net.WebSocket(url, {
      headers: options.headers,
      protocols: options.protocols
    })
  }

  // 没有 electron.net：只有在「完全不需要自定义头」时才允许退回全局 WebSocket。
  const headerCount = Object.keys(options.headers ?? {}).length
  if (headerCount > 0) {
    throw new Error('custom WebSocket headers require Electron net.WebSocket')
  }
  const Ctor = (globalThis as { WebSocket?: new (url: string, protocols?: string[]) => NativeWebSocket })
    .WebSocket
  if (!Ctor) throw new Error('WebSocket is not available in this runtime')
  return options.protocols?.length ? new Ctor(url, options.protocols) : new Ctor(url)
}

type ElectronNetWebSocket = {
  new (url: string, options?: { headers?: Record<string, string>; protocols?: string[] }): NativeWebSocket
}

function loadElectronNet(): { WebSocket: ElectronNetWebSocket } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { net?: { WebSocket?: ElectronNetWebSocket } }
    const ctor = electron?.net?.WebSocket
    return typeof ctor === 'function' ? { WebSocket: ctor } : null
  } catch {
    return null
  }
}

export function createLinkTransport(
  events: LinkTransportEvents,
  factory: WebSocketFactory = netWebSocketFactory
): LinkTransport {
  let socket: NativeWebSocket | null = null
  /** 关闭序号：防止旧 socket 的 onclose 覆盖新 socket 的状态。 */
  let generation = 0
  let maxFrameBytes = REMOTE_MAX_FRAME_BYTES

  const dispose = (code?: number, reason?: string): void => {
    if (!socket) return
    const closing = socket
    socket = null
    closing.onopen = null
    closing.onmessage = null
    closing.onerror = null
    closing.onclose = null
    try {
      // code / reason 必须继续往下传：Cloud 侧据此区分「正常关闭」与「设备主动下线」。
      if (code === undefined) closing.close()
      else closing.close(code, reason ?? '')
    } catch {
      /* 已经断了 */
    }
  }

  return {
    connect(url, options) {
      dispose()
      const current = ++generation
      const next = factory(url, options ?? {})
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
        // **UTF-8 字节数**，不是字符数。`data.length` 对中文会少算 2/3，
        // 一个 700 KB 的中文帧会被当成 350 KB 放过（协议 §2.2 的上限是字节）。
        const bytes = Buffer.byteLength(data, 'utf8')
        if (bytes > maxFrameBytes) {
          // 不回显原始帧内容：它可能整段是业务数据。
          events.onOversizedFrame(bytes)
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
      dispose(code, reason)
    },

    isOpen() {
      return socket !== null && socket.readyState === OPEN
    },

    classifyClose(code) {
      if (NO_RECONNECT_CLOSE_CODES.has(code)) return 'no-reconnect'
      if (code === REAUTH_CLOSE_CODE) return 'reauth'
      return 'retry'
    },

    setMaxFrameBytes(bytes) {
      maxFrameBytes = Math.min(REMOTE_MAX_FRAME_BYTES, Math.max(1, Math.floor(bytes)))
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

/**
 * 构造 `hello` 帧（签名由调用方提供——它需要私钥）。
 *
 * 字段集合与 `helloSigningPayload` **必须同步**：签名覆盖不到的字段，
 * 等于允许对端篡改。两处的键集由测试逐项比对（`remote-transport.test.ts`）。
 */
export function buildHelloFrame(input: {
  ts: number
  deviceId: string
  nonce: string
  minVersion: number
  maxVersion: number
  appVersion: string
  platform: string
  capabilities?: readonly string[]
  serviceable: boolean
  sig: string
}): string {
  const frame: RemoteHello = {
    v: REMOTE_PROTOCOL_VERSION,
    type: 'hello',
    ts: input.ts,
    device_id: input.deviceId,
    nonce: input.nonce,
    min_version: input.minVersion,
    max_version: input.maxVersion,
    app_version: input.appVersion,
    platform: input.platform,
    capabilities: [...(input.capabilities ?? REMOTE_HELLO_CAPABILITIES)],
    serviceable: input.serviceable,
    sig: input.sig
  }
  return JSON.stringify(frame)
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
