import { createHash, randomBytes } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import type { WebSocketFactory } from '../../src/main/remote/link-client'

/**
 * 测试用的最小 WebSocket 客户端。
 *
 * ## 为什么需要它
 *
 * 被测代码用 Electron 的 `net.WebSocket`（协议 §4.1 要求带
 * `Authorization` 头）。但 vitest 跑在 Node 里，没有 `electron.net`；
 * Node 自带的全局 `WebSocket` 是标准 API，**不能设置自定义 header**。
 *
 * 于是有两个坏选择：
 *
 * 1. 让生产代码「没有 net 就退回全局 WebSocket」并**静默丢掉 header**
 *    —— 那样设备认证在测试里等于没做，测试全绿也证明不了任何事。
 * 2. 在测试里继续用全局 WebSocket，Mock 也不查 header —— 同上。
 *
 * 所以生产代码选择 fail-closed（有 header 却拿不到 net 就直接抛错），
 * 测试则用这个文件里的客户端：它真的把 header 发出去、真的按 RFC 6455
 * 掩码、真的做关闭握手。这样 Mock 的接入校验才是被真实驱动过的。
 *
 * **它只用于测试**：没有扩展、没有二进制帧、没有分段。
 */

export type TestWebSocketOptions = {
  headers?: Record<string, string>
  protocols?: string[]
}

export type TestWebSocket = {
  readyState: number
  protocol: string
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null
}

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

export function createTestWebSocket(url: string, options: TestWebSocketOptions = {}): TestWebSocket {
  const ws: TestWebSocket = {
    readyState: CONNECTING,
    protocol: '',
    send: () => undefined,
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null
  }

  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:') {
    // wss 需要证书，测试里不覆盖；显式失败而不是静默降级。
    queueMicrotask(() => {
      ws.onerror?.({})
      finish(1006, 'only ws:// is supported by the test client')
    })
    return ws
  }

  const host = parsed.hostname
  const port = Number(parsed.port || 80)
  const path = `${parsed.pathname}${parsed.search}`

  let socket: Socket | null = null
  let buffer: Buffer = Buffer.alloc(0)
  let handshakeDone = false
  /** 握手用的 Sec-WebSocket-Key；响应里要拿它校验 accept。 */
  let handshakeKey = ''
  let closeSent = false
  let closeReceived = false

  const finish = (code: number, reason: string): void => {
    if (ws.readyState === CLOSED) return
    ws.readyState = CLOSED
    ws.onclose?.({ code, reason, wasClean: code !== 1006 })
    socket?.destroy()
    socket = null
  }

  const sendFrame = (opcode: number, payload: Buffer): void => {
    if (!socket || socket.destroyed) return
    const mask = randomBytes(4)
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
    const len = masked.length
    let head: Buffer
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, 0x80 | len])
    } else if (len < 65_536) {
      head = Buffer.alloc(4)
      head[0] = 0x80 | opcode
      head[1] = 0x80 | 126
      head.writeUInt16BE(len, 2)
    } else {
      head = Buffer.alloc(10)
      head[0] = 0x80 | opcode
      head[1] = 0x80 | 127
      head.writeBigUInt64BE(BigInt(len), 2)
    }
    socket.write(Buffer.concat([head, mask, masked]))
  }

  const buildClosePayload = (code: number, reason: string): Buffer => {
    const text = Buffer.from(reason, 'utf8')
    const payload = Buffer.alloc(2 + text.length)
    payload.writeUInt16BE(code, 0)
    text.copy(payload, 2)
    return payload
  }

  const handleCloseFrame = (payload: Buffer): void => {
    closeReceived = true
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
    const reason = payload.length > 2 ? payload.slice(2).toString('utf8') : ''
    if (!closeSent) {
      closeSent = true
      sendFrame(0x8, buildClosePayload(code, ''))
    }
    finish(code, reason)
  }

  const parseFrames = (): void => {
    for (;;) {
      if (buffer.length < 2) return
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let len = buffer[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (buffer.length < 4) return
        len = buffer.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buffer.length < 10) return
        len = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      let mask: Buffer | null = null
      if (masked) {
        if (buffer.length < offset + 4) return
        mask = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + len) return
      const payload = Buffer.from(buffer.subarray(offset, offset + len))
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
      buffer = buffer.subarray(offset + len)

      if (opcode === 0x1) {
        ws.onmessage?.({ data: payload.toString('utf8') })
      } else if (opcode === 0x8) {
        handleCloseFrame(payload)
        return
      } else if (opcode === 0x9) {
        // ping → pong（服务端可能用协议级 ping，虽然本协议用 JSON 帧）
        sendFrame(0xa, payload)
      }
      // 0x0 / 0x2 / 0xa 一律忽略：本协议的测试不需要它们。
    }
  }

  socket = netConnect({ host, port }, () => {
    handshakeKey = randomBytes(16).toString('base64')
    const key = handshakeKey
    const headers: string[] = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13'
    ]
    if (options.protocols?.length) headers.push(`Sec-WebSocket-Protocol: ${options.protocols.join(', ')}`)
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.push(`${name}: ${value}`)
    }
    socket?.write(`${headers.join('\r\n')}\r\n\r\n`)
  })

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])

    if (!handshakeDone) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      const head = buffer.subarray(0, end).toString('utf8')
      buffer = buffer.subarray(end + 4)
      const lines = head.split('\r\n')
      const status = Number(lines[0]?.split(' ')[1] ?? 0)
      if (status !== 101) {
        ws.onerror?.({})
        finish(1006, `HTTP ${status}`)
        return
      }
      const expected = createHash('sha1')
        .update(`${handshakeKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1]
      if (accept !== expected) {
        ws.onerror?.({})
        finish(1006, 'bad accept header')
        return
      }
      const protocolLine = /sec-websocket-protocol:\s*(\S+)/i.exec(head)?.[1]
      ws.protocol = protocolLine ?? ''
      handshakeDone = true
      ws.readyState = OPEN
      ws.onopen?.({})
    }

    parseFrames()
  })

  socket.on('error', () => {
    ws.onerror?.({})
    finish(1006, 'socket error')
  })

  socket.on('close', () => {
    if (!closeReceived) finish(1006, 'connection closed')
  })

  ws.send = (data: string) => {
    if (ws.readyState !== OPEN) return
    sendFrame(0x1, Buffer.from(data, 'utf8'))
  }

  ws.close = (code = 1000, reason = '') => {
    if (ws.readyState === CLOSED || ws.readyState === CLOSING) return
    ws.readyState = CLOSING
    closeSent = true
    sendFrame(0x8, buildClosePayload(code, reason))
    // 等对端回 close；超时就自己收尾。
    setTimeout(() => {
      if (ws.readyState !== CLOSED) finish(1005, '')
    }, 500)
  }

  return ws
}

/**
 * 供 `createRemoteService({ webSocketFactory })` 注入。
 *
 * 生产用 `net.WebSocket`（能带 header）；测试用这个客户端（也能带 header）。
 * 两者都在**同一个接口**下，所以被测的 `link-client` 不需要知道区别。
 */
export const testWebSocketFactory: WebSocketFactory = (url, options) =>
  createTestWebSocket(url, options)
