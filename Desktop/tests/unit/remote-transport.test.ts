import { describe, expect, it } from 'vitest'
import {
  createLinkTransport,
  type LinkTransportEvents,
  type WebSocketConnectOptions,
  type WebSocketFactory
} from '../../src/main/remote/link-client'
import { REMOTE_MAX_FRAME_BYTES } from '../../src/shared/contracts/remote'

/**
 * 传输层的单元测试：**不需要真实 socket**。
 *
 * 这一层最容易出「看起来没事」的错：
 * - 帧大小用 `length` 而不是 UTF-8 字节数（中文会少算 2/3）；
 * - `close(code, reason)` 把参数吞掉（协议 §9.2 的业务语义全丢）；
 * - 旧连接的 `onopen` 回调给新连接发帧。
 *
 * 用假 socket 能精确地按下这些键，比走真实网络更可靠。
 */

type FakeSocket = {
  readyState: number
  sent: string[]
  closeCalls: Array<{ code?: number; reason?: string }>
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null
}

function makeHarness() {
  const sockets: FakeSocket[] = []
  const connectCalls: Array<{ url: string; options: WebSocketConnectOptions }> = []

  const factory: WebSocketFactory = (url, options) => {
    connectCalls.push({ url, options })
    const socket: FakeSocket = {
      readyState: 0,
      sent: [],
      closeCalls: [],
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null
    }
    sockets.push(socket)
    return {
      get readyState() {
        return socket.readyState
      },
      send(data: string) {
        socket.sent.push(data)
      },
      close(code?: number, reason?: string) {
        socket.readyState = 3
        socket.closeCalls.push({ code, reason })
      },
      get onopen() {
        return socket.onopen
      },
      set onopen(handler) {
        socket.onopen = handler
      },
      get onmessage() {
        return socket.onmessage
      },
      set onmessage(handler) {
        socket.onmessage = handler
      },
      get onerror() {
        return socket.onerror
      },
      set onerror(handler) {
        socket.onerror = handler
      },
      get onclose() {
        return socket.onclose
      },
      set onclose(handler) {
        socket.onclose = handler
      }
    }
  }

  const events = {
    opens: 0,
    frames: [] as string[],
    errors: [] as string[],
    oversized: [] as number[],
    closes: [] as Array<{ code: number; reason: string }>
  }
  const listener: LinkTransportEvents = {
    onOpen: () => {
      events.opens += 1
    },
    onFrame: (raw) => {
      events.frames.push(raw)
    },
    onError: (message) => {
      events.errors.push(message)
    },
    onOversizedFrame: (bytes) => {
      events.oversized.push(bytes)
    },
    onClose: (code, reason) => {
      events.closes.push({ code, reason })
    }
  }

  return { factory, sockets, connectCalls, events, listener }
}

function open(socket: FakeSocket): void {
  socket.readyState = 1
  socket.onopen?.({})
}

describe('帧大小：UTF-8 字节，不是字符数', () => {
  it('纯 ASCII 恰好等于上限时放行', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    open(h.sockets[0])

    const exact = 'a'.repeat(REMOTE_MAX_FRAME_BYTES)
    h.sockets[0].onmessage?.({ data: exact })
    expect(h.events.frames).toHaveLength(1)
  })

  it('纯 ASCII 超过上限 1 字节就丢弃', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    open(h.sockets[0])

    h.sockets[0].onmessage?.({ data: 'a'.repeat(REMOTE_MAX_FRAME_BYTES + 1) })
    expect(h.events.frames).toHaveLength(0)
    // 走的是专门的「超限帧」事件，而不是通用 socket 错误：
    // 前者要 close 4009（协议 §2.2），后者不该断连。
    expect(h.events.oversized).toHaveLength(1)
    expect(h.events.errors).toHaveLength(0)
  })

  it('中文按字节算：字符数远小于上限、字节数已超', () => {
    // 「汉」是 3 字节。取 (上限/3 + 10) 个字符：字符数 ≈ 349k 看着远小于 1 MiB，
    // 字节数却已经超过 1 MiB。用 data.length 判定的实现会在这里放行。
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    open(h.sockets[0])

    const text = '汉'.repeat(Math.floor(REMOTE_MAX_FRAME_BYTES / 3) + 10)
    expect(text.length).toBeLessThan(REMOTE_MAX_FRAME_BYTES)
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(REMOTE_MAX_FRAME_BYTES)

    h.sockets[0].onmessage?.({ data: text })
    expect(h.events.frames).toHaveLength(0)
    expect(h.events.oversized).toHaveLength(1)
  })

  it('中文恰好等于上限时放行', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    open(h.sockets[0])

    // 1 MiB 不能被 3 整除，所以用一个能被 3 整除的上限来测「恰好等于」。
    transport.setMaxFrameBytes(3_000)
    const text = '汉'.repeat(1_000)
    expect(Buffer.byteLength(text, 'utf8')).toBe(3_000)
    h.sockets[0].onmessage?.({ data: text })
    h.sockets[0].onmessage?.({ data: `${text}汉` })
    expect(h.events.frames).toHaveLength(1)
    expect(h.events.oversized).toHaveLength(1)
  })

  it('Cloud 下发的更小上限生效', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    open(h.sockets[0])

    transport.setMaxFrameBytes(16)
    h.sockets[0].onmessage?.({ data: 'a'.repeat(16) })
    h.sockets[0].onmessage?.({ data: 'a'.repeat(17) })
    expect(h.events.frames).toHaveLength(1)
    expect(h.events.oversized).toHaveLength(1)
  })

  it('Cloud 想放大上限也没用（本机上限是内存保护）', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    open(h.sockets[0])

    transport.setMaxFrameBytes(REMOTE_MAX_FRAME_BYTES * 100)
    h.sockets[0].onmessage?.({ data: 'a'.repeat(REMOTE_MAX_FRAME_BYTES + 1) })
    expect(h.events.frames).toHaveLength(0)
  })
})

describe('close(code, reason) 必须传到底层 socket', () => {
  const codes = [1000, 1001, 4001, 4002, 4003, 4005, 4006, 4008, 4009, 4010, 4011]

  for (const code of codes) {
    it(`${code} 与 reason 精确传递`, () => {
      const h = makeHarness()
      const transport = createLinkTransport(h.listener, h.factory)
      transport.connect('ws://x/device-link')
      open(h.sockets[0])

      transport.close(code, `r${code}`)
      expect(h.sockets[0].closeCalls).toEqual([{ code, reason: `r${code}` }])
    })
  }

  it('不带参数时用 1000', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    open(h.sockets[0])
    transport.close()
    expect(h.sockets[0].closeCalls[0].code).toBe(1000)
  })
})

describe('连接代际：旧连接的异步回调不能影响新连接', () => {
  it('旧 socket 的 onopen 不会触发新连接的 onOpen', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    const first = h.sockets[0]
    transport.connect('ws://x/device-link')
    const second = h.sockets[1]

    // 旧连接迟到地 open
    open(first)
    expect(h.events.opens).toBe(0)

    open(second)
    expect(h.events.opens).toBe(1)
  })

  it('旧 socket 的 onclose 不会关掉新连接的状态', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    const first = h.sockets[0]
    transport.connect('ws://x/device-link')
    open(h.sockets[1])

    first.onclose?.({ code: 1006, reason: 'late', wasClean: false })
    expect(h.events.closes).toHaveLength(0)
    expect(transport.isOpen()).toBe(true)
  })

  it('旧 socket 的 onmessage 不会把帧交给上层', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    const first = h.sockets[0]
    transport.connect('ws://x/device-link')
    open(h.sockets[1])

    first.onmessage?.({ data: '{"v":1,"type":"req"}' })
    expect(h.events.frames).toHaveLength(0)
  })

  it('主动 close 之后不再上报 onClose（那是本地意志，不是故障）', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    transport.connect('ws://x/device-link')
    open(h.sockets[0])
    const socket = h.sockets[0]
    transport.close(1000, 'shutdown')
    socket.onclose?.({ code: 1000, reason: 'shutdown', wasClean: true })
    expect(h.events.closes).toHaveLength(0)
  })
})

describe('握手选项必须真的传到工厂', () => {
  it('Authorization 与子协议都传下去了，且 token 不在 URL 里', () => {
    const h = makeHarness()
    const transport = createLinkTransport(h.listener, h.factory)
    const token = 'bp_dev_abcdefghijklmnop'
    transport.connect('wss://cloud.example/device-link', {
      headers: { Authorization: `Bearer ${token}` },
      protocols: ['brewphase.remote.v1']
    })

    const call = h.connectCalls[0]
    expect(call.options.headers?.Authorization).toBe(`Bearer ${token}`)
    expect(call.options.protocols).toEqual(['brewphase.remote.v1'])
    // 反向断言：token 绝不出现在 URL 里（URL 会进反向代理 access log）。
    expect(call.url).not.toContain(token)
    expect(call.url).not.toContain('bp_dev')
  })
})
