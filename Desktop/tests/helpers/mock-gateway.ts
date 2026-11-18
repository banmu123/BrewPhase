import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createPublicKey, type KeyObject } from 'node:crypto'
import { verifyHello } from '../../src/main/remote/device-identity'
import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteGrant,
  type RemoteHelloOk
} from '../../src/shared/contracts/remote'

/**
 * Mock Gateway：**只用于 Phase 1.1B 的测试**。
 *
 * 它**不是** Cloud 的替代品，也不伪装成真实集成：这里没有 OAuth、没有设备
 * 注册后端、没有数据库。它只做一件事——在本地充当「已认证的 WSS 对端」，
 * 让 Desktop 的 RemoteService 有东西可连，从而能测「收到帧之后怎么办」。
 *
 * 实现方式是「够用的 WebSocket」：握手 + 文本帧 + close 帧，不掩码服务端→客户端
 * 的帧（RFC 6455 要求客户端掩码、服务端不掩码），足够驱动被测代码。
 * 需要真实协议栈时用生产 Cloud，不要把这个文件当成合规实现。
 */

function serverFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  let head: Buffer
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len])
  } else if (len < 65_536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

function textFrame(text: string): Buffer {
  return serverFrame(0x1, Buffer.from(text, 'utf8'))
}

function closeFrame(code: number, reason = ''): Buffer {
  const r = Buffer.from(reason, 'utf8')
  const payload = Buffer.alloc(2 + r.length)
  payload.writeUInt16BE(code, 0)
  r.copy(payload, 2)
  return serverFrame(0x8, payload)
}

/** 解析客户端发来的帧（客户端必须掩码）。 */
function parseClientFrames(buffer: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer<ArrayBufferLike> } {
  const frames: Array<{ opcode: number; payload: Buffer }> = []
  let offset = 0
  for (;;) {
    if (buffer.length - offset < 2) break
    const opcode = buffer[offset] & 0x0f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    let len = buffer[offset + 1] & 0x7f
    let cursor = offset + 2
    if (len === 126) {
      if (buffer.length - cursor < 2) break
      len = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (len === 127) {
      if (buffer.length - cursor < 8) break
      len = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let mask: Buffer | null = null
    if (masked) {
      if (buffer.length - cursor < 4) break
      mask = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (buffer.length - cursor < len) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + len))
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    frames.push({ opcode, payload })
    offset = cursor + len
  }
  return { frames, rest: buffer.subarray(offset) as Buffer<ArrayBufferLike> }
}

export type MockGatewayGrant = {
  grantCtx: string
  grantId: string
  clientId: string
  clientName: string
  scopes: RemoteGrant['scopes']
  boundUserId: string
  epoch: number
}

export type MockGatewayOptions = {
  /** 设备公钥（Desktop 侧生成的 SPKI DER）。 */
  devicePublicKey?: KeyObject
  /** 期望的 boundUserId（写进 grants）。 */
  boundUserId?: string
  /** 初始 grants。 */
  grants?: MockGatewayGrant[]
  grantEpoch?: number
  allowedTools?: string[]
  /** 握手时用的协议版本（用于版本协商负例）。 */
  protocolVersion?: number
  /** 握手后立刻用某个 close code 断开。 */
  closeAfterHello?: number
  heartbeatMs?: number
  idleTimeoutMs?: number
  maxInflight?: number
}

export type MockGateway = {
  url: string
  /** 收到的全部帧（按序，已 JSON 解析）。 */
  received: Array<Record<string, unknown>>
  /** 收到的原始文本帧（含非 JSON）。 */
  rawReceived: string[]
  /** 握手是否通过验签。 */
  helloVerified: boolean
  /** 已建立的连接数。 */
  connections: number
  /** 发出一个帧。 */
  send(frame: unknown): void
  /** 发一个 `req`。 */
  sendReq(input: {
    id: string
    tool: string
    args: unknown
    grantCtx: string
    requestHash: string
    deadlineMs?: number
  }): void
  /** 发一个 `ping`。 */
  sendPing(seq?: number): void
  /** 发 `grant_update`。 */
  sendGrantUpdate(input: {
    grantEpoch: number
    op: 'install' | 'revoke'
    grant?: MockGatewayGrant
    grantCtx?: string
  }): void
  /** 发 `cancel`。 */
  sendCancel(id: string): void
  /** 发 `drain`。 */
  sendDrain(graceMs?: number): void
  /** 主动断开（指定 close code）。 */
  close(code: number, reason?: string): void
  /** 等到收到某类帧（或超时）。 */
  waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>
  /** 等到 res 里 id 匹配。 */
  waitForRes(id: string, timeoutMs?: number): Promise<Record<string, unknown>>
  stop(): Promise<void>
}

export async function startMockGateway(options: MockGatewayOptions = {}): Promise<MockGateway> {
  const grants: MockGatewayGrant[] = options.grants ?? []
  let grantEpoch = options.grantEpoch ?? 0
  const allowedTools = options.allowedTools ?? [
    'search_records',
    'get_record',
    'list_record_tags',
    'list_beans',
    'list_brews',
    'list_tastings',
    'list_canvases',
    'get_canvas'
  ]

  const received: Array<Record<string, unknown>> = []
  const rawReceived: string[] = []
  const waiters: Array<{ predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }> = []

  let socket: import('node:stream').Duplex | null = null
  let connections = 0
  let helloVerified = false
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  const server: Server = createServer((_req, res) => {
    res.writeHead(200)
    res.end('mock gateway')
  })

  const dispatch = (frame: Record<string, unknown>): void => {
    received.push(frame)
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(frame)
      }
    }
  }

  const sendRaw = (text: string): void => {
    if (!socket || socket.destroyed) return
    socket.write(textFrame(text))
  }

  const buildHelloOk = (): RemoteHelloOk => ({
    v: 1,
    type: 'hello_ok',
    ts: Date.now(),
    connection_id: `conn_${randomBytes(6).toString('hex')}`,
    instance_id: 'mock-gw',
    server_time: Date.now(),
    heartbeat_ms: options.heartbeatMs ?? 20_000,
    idle_timeout_ms: options.idleTimeoutMs ?? 60_000,
    max_inflight: options.maxInflight ?? 2,
    max_frame_bytes: 1024 * 1024,
    allowed_tools: allowedTools,
    grant_epoch: grantEpoch,
    grants: grants.map((grant) => ({
      grant_ctx: grant.grantCtx,
      grant_id: grant.grantId,
      client_id: grant.clientId,
      client_name: grant.clientName,
      scopes: grant.scopes,
      bound_user_id: grant.boundUserId,
      epoch: grant.epoch
    }))
  })

  server.on('upgrade', (req, netSocket) => {
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      netSocket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    netSocket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    socket = netSocket
    connections += 1
    buffer = Buffer.alloc(0)

    netSocket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]) as Buffer<ArrayBufferLike>
      const parsed = parseClientFrames(buffer)
      buffer = parsed.rest
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          netSocket.end()
          continue
        }
        if (frame.opcode !== 0x1) continue
        const text = frame.payload.toString('utf8')
        rawReceived.push(text)

        let json: Record<string, unknown>
        try {
          json = JSON.parse(text) as Record<string, unknown>
        } catch {
          continue
        }

        if (json.type === 'hello') {
          // 验签：Mock 用真实 Ed25519 验，不跳过。
          if (options.devicePublicKey) {
            helloVerified = verifyHello(
              options.devicePublicKey,
              {
                v: Number(json.v),
                type: String(json.type),
                device_id: String(json.device_id),
                nonce: String(json.nonce),
                ts: Number(json.ts)
              },
              String(json.sig)
            )
          } else {
            helloVerified = true
          }
          dispatch(json)
          if (options.protocolVersion !== undefined && options.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
            netSocket.write(closeFrame(4002, 'version unsupported'))
            return
          }
          if (options.closeAfterHello !== undefined) {
            netSocket.write(closeFrame(options.closeAfterHello, 'mock close'))
            return
          }
          sendRaw(JSON.stringify(buildHelloOk()))
          return
        }
        dispatch(json)
      }
    })

    netSocket.on('close', () => {
      if (socket === netSocket) socket = null
    })
    netSocket.on('error', () => {
      if (socket === netSocket) socket = null
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const gateway: MockGateway = {
    url: `ws://127.0.0.1:${port}`,
    received,
    rawReceived,
    get helloVerified() {
      return helloVerified
    },
    get connections() {
      return connections
    },
    send(frame) {
      sendRaw(JSON.stringify(frame))
    },
    sendReq(input) {
      sendRaw(
        JSON.stringify({
          v: 1,
          type: 'req',
          id: input.id,
          ts: Date.now(),
          tool: input.tool,
          arguments: input.args,
          request_hash: input.requestHash,
          deadline_ms: input.deadlineMs ?? Date.now() + 15_000,
          grant_ctx: input.grantCtx
        })
      )
    },
    sendPing(seq = 1) {
      sendRaw(JSON.stringify({ v: 1, type: 'ping', ts: Date.now(), seq }))
    },
    sendGrantUpdate(input) {
      grantEpoch = input.grantEpoch
      if (input.op === 'install' && input.grant) {
        const index = grants.findIndex((g) => g.grantCtx === input.grant!.grantCtx)
        const next = { ...input.grant }
        if (index === -1) grants.push(next)
        else grants[index] = next
      }
      if (input.op === 'revoke' && input.grantCtx) {
        const index = grants.findIndex((g) => g.grantCtx === input.grantCtx)
        if (index !== -1) grants.splice(index, 1)
      }
      sendRaw(
        JSON.stringify({
          v: 1,
          type: 'grant_update',
          ts: Date.now(),
          grant_epoch: input.grantEpoch,
          op: input.op,
          ...(input.grant
            ? {
                grant: {
                  grant_ctx: input.grant.grantCtx,
                  grant_id: input.grant.grantId,
                  client_id: input.grant.clientId,
                  client_name: input.grant.clientName,
                  scopes: input.grant.scopes,
                  bound_user_id: input.grant.boundUserId,
                  epoch: input.grant.epoch
                }
              }
            : {}),
          ...(input.grantCtx ? { grant_ctx: input.grantCtx } : {})
        })
      )
    },
    sendCancel(id) {
      sendRaw(JSON.stringify({ v: 1, type: 'cancel', ts: Date.now(), id }))
    },
    sendDrain(graceMs = 1000) {
      sendRaw(JSON.stringify({ v: 1, type: 'drain', ts: Date.now(), grace_ms: graceMs }))
    },
    close(code, reason = '') {
      if (!socket) return
      socket.write(closeFrame(code, reason))
      setTimeout(() => socket?.end(), 50)
    },
    waitFor(predicate, timeoutMs = 4_000) {
      const existing = received.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((w) => w.resolve === wrapped)
          if (index !== -1) waiters.splice(index, 1)
          reject(new Error('timeout waiting for frame'))
        }, timeoutMs)
        const wrapped = (frame: Record<string, unknown>): void => {
          clearTimeout(timer)
          resolve(frame)
        }
        waiters.push({ predicate, resolve: wrapped })
      })
    },
    waitForRes(id, timeoutMs = 4_000) {
      return gateway.waitFor((frame) => frame.type === 'res' && frame.id === id, timeoutMs)
    },
    async stop() {
      try {
        socket?.destroy()
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  return gateway
}

/** 供测试直接构造 `hello_ok`（覆盖负例）。 */
export function makeHelloOk(overrides: Partial<RemoteHelloOk> = {}): RemoteHelloOk {
  return {
    v: 1,
    type: 'hello_ok',
    ts: Date.now(),
    connection_id: 'conn_test',
    instance_id: 'mock-gw',
    server_time: Date.now(),
    heartbeat_ms: 20_000,
    idle_timeout_ms: 60_000,
    max_inflight: 2,
    max_frame_bytes: 1024 * 1024,
    allowed_tools: [],
    grant_epoch: 0,
    grants: [],
    ...overrides
  }
}

/** 从 PKCS8 私钥导出 SPKI 公钥（Mock 验签用）。 */
export function publicKeyOf(privateKey: import('node:crypto').KeyObject): KeyObject {
  return createPublicKey(privateKey)
}
