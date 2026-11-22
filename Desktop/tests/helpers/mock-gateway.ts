import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import { decodeRawPublicKey, ed25519RawPublicKey, verifyHello } from '../../src/main/remote/device-identity'
import {
  REMOTE_DEVICE_TOKEN_PATTERN,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_WS_SUBPROTOCOL,
  negotiateProtocolVersion,
  remoteDeviceClaimRequestSchema,
  remoteDeviceRegisterRequestSchema,
  type RemoteGrant,
  type RemoteHelloOk
} from '../../src/shared/contracts/remote'

/**
 * Mock Gateway：**只用于 Remote 的测试**。
 *
 * 它**不是** Cloud 的替代品，也不伪装成真实集成：这里没有 OAuth、没有数据库。
 * 但 Phase 1.1B.1 之后它不再是「无条件 101」的玩具——它按协议 §4.1/§4.3 做
 * 真正的接入校验，否则「本地测试通过」不构成任何设备认证的证据：
 *
 * | 校验 | 依据 |
 * |---|---|
 * | path == `/device-link` | 协议 §4.1 |
 * | `Authorization: Bearer bp_dev_…` | 协议 §4.1 / §4.3 第 1–2 步 |
 * | token 的 sha256 命中设备表 | §4.3 第 2 步 |
 * | 设备状态为 `active` | §4.3 第 3 步 |
 * | `Sec-WebSocket-Protocol: brewphase.remote.v1` | §4.1 |
 * | Ed25519 验签覆盖全部握手字段 | §4.2 / §4.3 第 6 步 |
 * | 版本区间有交集 | §1.1 / §4.3 第 8 步 |
 *
 * 它**仍然**不做的事：不实现 nonce 去重（那是 Cloud 的有状态逻辑，
 * 且本文件无法证明其原子性）、不做多实例路由、不实现 OAuth。
 * 这些必须在 Phase 1.2 的真实 Cloud 上测。
 *
 * 实现方式是「够用的 WebSocket」：握手 + 文本帧 + close 帧，不掩码服务端→客户端
 * 的帧（RFC 6455 要求客户端掩码、服务端不掩码），足够驱动被测代码。
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

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 定长比较；长度不同直接 false（不泄露前缀信息之外的东西）。 */
function hashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** 缺省设备的 token：足够长，能通过 `REMOTE_DEVICE_TOKEN_PATTERN`。 */
export const MOCK_DEVICE_TOKEN = 'bp_dev_mock_token_00000001'

/**
 * 收到的轮换请求（断言「请求结构正确」用）。
 *
 * 存的是**原样**的 authorization 与 body：测试要能证明 token 只在 header 里、
 * body 里没有第二个副本——如果 Mock 先帮我们「整理」一遍，就什么也证明不了。
 */
export type MockRotateRecord = {
  deviceId: string
  authorization: string | null
  contentType: string | null
  body: Record<string, unknown>
  /** 验签是否通过（Mock 用设备表里的当前公钥验）。 */
  verified: boolean
  /** 拒绝原因（通过则为 null）。 */
  rejected: string | null
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

/** Mock 侧的一台设备（对应 Cloud 的 `mcp_devices` 一行）。 */
export type MockDevice = {
  deviceId: string
  /** 明文 token **只用于测试**：真实 Cloud 只存 sha256。 */
  token: string
  status: 'active' | 'pending' | 'suspended' | 'revoked'
  /** 裸 32 字节公钥的 base64url；缺省时用 `options.devicePublicKey`。 */
  publicKey?: string
}

export type MockRegistrationResult = {
  deviceId: string
  confirmCode: string
  claimSecret: string
}

export type MockGatewayOptions = {
  /** 设备公钥（Desktop 侧生成的 SPKI DER）。用于 hello 验签。 */
  devicePublicKey?: KeyObject
  /** 设备表。缺省为 `dev-1` + `bp_dev_test` + active（既有测试沿用的默认值）。 */
  devices?: MockDevice[]
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
  /** `hello_ok.max_frame_bytes`（用于帧上限协商测试）。 */
  maxFrameBytes?: number
  /** 注册端点的设备数上限（协议 §3.2：5）。 */
  deviceLimit?: number
  /** 是否要求注册端点带用户 Bearer（协议 §3.2 要求）。默认 true。 */
  requireBearerForRegister?: boolean
  /**
   * 回一个**缺字段**的 `hello_ok`（用于「形状非法必须 close 4009」的负例）。
   *
   * 缺的是 `max_frame_bytes`：一个真实 Cloud 在序列化 bug 下很容易漏掉它，
   * 而漏掉之后 Desktop 的帧上限就失去协商依据。
   */
  malformedHelloOk?: boolean
}

export type MockGateway = {
  url: string
  /** 收到的全部帧（按序，已 JSON 解析）。 */
  received: Array<Record<string, unknown>>
  /** 收到的原始文本帧（含非 JSON）。 */
  rawReceived: string[]
  /** 握手是否通过验签。 */
  helloVerified: boolean
  /** 成功建立的连接数（**只统计通过接入校验的**）。 */
  connections: number
  /** 被拒绝的 Upgrade 次数与最后原因（认证测试用）。 */
  rejectedUpgrades: number
  lastRejectReason: string | null
  /** 最近一次 Upgrade 请求的头部快照（断言 token 只出现在 header）。 */
  lastUpgradeHeaders: Record<string, string | string[] | undefined> | null
  /** claim 请求次数（验证「原子一次性领取」与轮询行为）。 */
  claimAttempts: number
  /** 注册过的设备（测试断言用）。 */
  devices: Map<string, { deviceId: string; status: string; token: string | null }>
  /**
   * 收到的轮换请求（按序）。
   *
   * 为什么 Mock 也要做真验签：如果它只回 200，那么「Desktop 用旧私钥签了
   * 什么」这件事完全没被验证——签名串写错、签错字段、encode 换行，测试全绿。
   */
  rotations: MockRotateRecord[]
  /** 轮换端点的失败注入：设置后**下一次**请求返回该状态码（用后即清）。 */
  failNextRotate(status: number, error: string): void;
  /**
   * 在「别处」轮换这台设备（换公钥 + 换 token，旧 token 立刻失效）。
   *
   * 用来构造「Desktop 手里的凭据已被别人换掉」这个前提，而不需要它自己发起轮换。
   */
  rotateDeviceElsewhere(input: { deviceId: string; publicKey: KeyObject; newToken: string }): void;
  /** 发出一个帧。 */
  send(frame: unknown): void
  /**
   * 发一段**原样文本**（故意不是 JSON）。
   *
   * 用来测协议 §2.2 的「无法解析但能从原文提取 id」这条路径——
   * `send()` 会先 JSON.stringify，永远产生合法 JSON，测不到那条分支。
   */
  sendText(text: string): void
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
  /** 主动断开（按 RFC 6455 完成关闭握手，客户端能拿到真实 code）。 */
  close(code: number, reason?: string): void
  /** 模拟用户在 Web 端输入确认码。 */
  confirmDevice(deviceId: string, confirmCode: string): boolean
  /**
   * 把某台设备的公钥告诉 Mock（等价于 Cloud 在注册时存下 `public_key`）。
   *
   * 测试里密钥对是「先起 Gateway、后生成」的，所以需要这一步。
   * 它只影响缺省设备；要测「A 的 token + B 的签名」请用 `devices` 显式给表。
   */
  trustDevicePublicKey(publicKey: KeyObject, deviceId?: string): void
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

  /**
   * 设备表：token → 设备。
   *
   * 缺省值刻意沿用既有测试的 `dev-1` / `bp_dev_test`，但**不是无条件放行**：
   * token 仍然要比对，状态仍然要是 active。想测「错误 token 被拒」就把
   * `devices` 换掉。
   */
  const devices: MockDevice[] =
    options.devices ??
    [
      {
        deviceId: 'dev-1',
        token: MOCK_DEVICE_TOKEN,
        status: 'active',
        publicKey: options.devicePublicKey ? rawPublicKeyOf(options.devicePublicKey) : undefined
      }
    ]

  const tokenIndex = new Map<string, MockDevice>()
  for (const device of devices) tokenIndex.set(sha256(device.token), device)

  /** 收到的轮换请求（含被拒的那些——拒绝原因本身就是要断言的对象）。 */
  const rotations: MockRotateRecord[] = []
  /** 下一次轮换的失败注入。只影响一次，避免测试之间互相污染。 */
  let nextRotateFailure: { status: number; error: string } | null = null

  /** 注册中的设备（pending → active → token 已领取）。只存在于本进程。 */
  const registrations = new Map<
    string,
    {
      deviceId: string
      publicKey: string
      status: 'pending' | 'active' | 'revoked'
      confirmCode: string
      claimSecretHash: string
      expiresAt: number
      token: string | null
    }
  >()

  const received: Array<Record<string, unknown>> = []
  const rawReceived: string[] = []
  const waiters: Array<{ predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }> = []

  let socket: import('node:stream').Duplex | null = null
  let connections = 0
  let helloVerified = false
  let rejectedUpgrades = 0
  let lastRejectReason: string | null = null
  let lastUpgradeHeaders: Record<string, string | string[] | undefined> | null = null
  let claimAttempts = 0
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  const rejectUpgrade = (
    netSocket: import('node:stream').Duplex,
    status: number,
    reason: string
  ): void => {
    rejectedUpgrades += 1
    lastRejectReason = reason
    // 用 HTTP 状态码拒绝：客户端会拿到 1006 + 一条 net:: 原因，而不是「连上了再断」。
    netSocket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    netSocket.destroy()
  }

  const server: Server = createServer((req, res) => {
    void handleHttp(req, res)
  })

  // MARK: - 注册端点（HTTPS 语义，测试里走 http）

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (status: number, body: unknown): void => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(text)
    }
    const fail = (status: number, code: string): void => json(status, { error: code })

    // 撤销（用户取消配对）：`DELETE /mcp-devices/:id`。
    // 必须在下面那条 405 之前：那条只放行 POST。
    if (req.method === 'DELETE') {
      const revokeMatch = /^\/mcp-devices\/([^/]+)$/.exec(url.pathname)
      if (!revokeMatch) return fail(404, 'not_found')
      const device = registrations.get(decodeURIComponent(revokeMatch[1]))
      if (!device) return fail(404, 'device_not_found')
      device.status = 'revoked'
      return json(200, { device_id: device.deviceId, status: 'revoked' })
    }
    if (req.method !== 'POST') return fail(405, 'method_not_allowed')

    // register：需要用户 Bearer（协议 §3.2）。Mock 不校验 token 内容，只校验存在。
    if (url.pathname === '/mcp-devices/register') {
      if (options.requireBearerForRegister !== false) {
        const auth = req.headers.authorization
        if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || auth.length < 10) {
          return fail(401, 'invalid_token')
        }
      }
      let parsed: { name: string; platform: string; public_key: string; app_version: string }
      try {
        const body = remoteDeviceRegisterRequestSchema.safeParse(JSON.parse(await readBody(req)))
        if (!body.success) return fail(400, 'invalid_public_key')
        parsed = body.data
      } catch {
        return fail(400, 'invalid_request')
      }
      const limit = options.deviceLimit ?? 5
      const active = [...registrations.values()].filter((d) => d.status !== 'revoked')
      if (active.length >= limit) return fail(429, 'device_limit')
      if (active.some((d) => d.publicKey === parsed.public_key)) return fail(409, 'device_exists')

      const deviceId = `dev_${randomBytes(8).toString('hex')}`
      const confirmCode = String(Math.floor(100_000 + Math.random() * 900_000))
      const claimSecret = randomBytes(32).toString('base64url')
      registrations.set(deviceId, {
        deviceId,
        publicKey: parsed.public_key,
        status: 'pending',
        confirmCode,
        // 与真实 Cloud 一致：只存 hash。
        claimSecretHash: sha256(claimSecret),
        expiresAt: Date.now() + 300_000,
        token: null
      })
      return json(200, {
        device_id: deviceId,
        confirm_code: confirmCode,
        claim_secret: claimSecret,
        expires_in: 300
      })
    }

    const confirmMatch = /^\/mcp-devices\/([^/]+)\/confirm$/.exec(url.pathname)
    if (confirmMatch) {
      const device = registrations.get(decodeURIComponent(confirmMatch[1]))
      if (!device) return fail(404, 'device_not_found')
      if (device.status === 'active') return json(200, { device_id: device.deviceId, status: 'active' })
      if (Date.now() >= device.expiresAt) return fail(410, 'confirm_expired')
      let code = ''
      try {
        const body = JSON.parse(await readBody(req)) as { confirm_code?: unknown }
        code = typeof body.confirm_code === 'string' ? body.confirm_code : ''
      } catch {
        return fail(400, 'invalid_confirm_code')
      }
      if (code !== device.confirmCode) return fail(400, 'invalid_confirm_code')
      device.status = 'active'
      return json(200, { device_id: device.deviceId, status: 'active' })
    }

    // ---- 轮换（协议 §3.5）：真验签、真换 token ----
    const rotateMatch = /^\/mcp-devices\/([^/]+)\/rotate$/.exec(url.pathname)
    if (rotateMatch) {
      const deviceId = decodeURIComponent(rotateMatch[1])
      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : null
      const record: MockRotateRecord = {
        deviceId,
        authorization: auth,
        contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
        body: {},
        verified: false,
        rejected: null
      }
      rotations.push(record)

      if (nextRotateFailure) {
        const injected = nextRotateFailure
        nextRotateFailure = null
        record.rejected = `injected:${injected.error}`
        return fail(injected.status, injected.error)
      }

      // 认证：只认 device_token，且必须是**这台**设备的。
      const presented = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : ''
      if (!REMOTE_DEVICE_TOKEN_PATTERN.test(presented)) {
        record.rejected = 'unauthorized'
        return fail(401, 'device_unauthorized')
      }
      const device = tokenIndex.get(sha256(presented))
      if (!device || device.deviceId !== deviceId) {
        record.rejected = 'unauthorized'
        return fail(401, 'device_unauthorized')
      }
      if (device.status !== 'active') {
        record.rejected = 'device_state'
        return fail(409, 'invalid_device_state')
      }

      let raw: unknown
      try {
        raw = JSON.parse(await readBody(req))
      } catch {
        record.rejected = 'invalid_request'
        return fail(400, 'invalid_request')
      }
      record.body = (raw ?? {}) as Record<string, unknown>
      const body = raw as { new_public_key?: unknown; ts?: unknown; sig?: unknown }
      if (
        typeof body?.new_public_key !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.new_public_key) ||
        typeof body.ts !== 'number' ||
        !Number.isInteger(body.ts) ||
        typeof body.sig !== 'string'
      ) {
        record.rejected = 'invalid_request'
        return fail(400, 'invalid_request')
      }
      // 时钟偏差：与 hello 同一条规则（±120s）。
      if (Math.abs(Date.now() - body.ts) > 120_000) {
        record.rejected = 'invalid_timestamp'
        return fail(400, 'invalid_timestamp')
      }

      const currentKey = resolveDeviceKey(device, options.devicePublicKey)
      const newKey = (() => {
        try {
          return decodeRawPublicKey(body.new_public_key as string)
        } catch {
          return null
        }
      })()
      if (!currentKey || !newKey) {
        record.rejected = 'invalid_public_key'
        return fail(400, 'invalid_public_key')
      }

      // 规范串与 Cloud 侧逐字一致：`prefix\ndevice_id\nnew_public_key\nts`。
      const payload = [
        'brewphase.remote.rotate.v1',
        deviceId,
        body.new_public_key as string,
        String(body.ts)
      ].join('\n')
      const sig = Buffer.from(body.sig as string, 'base64url')
      const verified = sig.length === 64 && cryptoVerify(null, Buffer.from(payload, 'utf8'), currentKey, sig)
      record.verified = verified
      if (!verified) {
        record.rejected = 'bad_signature'
        return fail(401, 'device_unauthorized')
      }

      // 原子换：旧 token 立刻从索引里消失（等价于 Cloud 覆盖 token_hash）。
      const newToken = `bp_dev_${randomBytes(24).toString('base64url')}`
      tokenIndex.delete(sha256(device.token))
      device.token = newToken
      device.publicKey = body.new_public_key as string
      tokenIndex.set(sha256(newToken), device)

      return json(200, { device_token: newToken, expires_at: Date.now() + 30 * 24 * 3600_000 })
    }

    const claimMatch = /^\/mcp-devices\/([^/]+)\/credentials$/.exec(url.pathname)
    if (claimMatch) {
      claimAttempts += 1
      const device = registrations.get(decodeURIComponent(claimMatch[1]))
      if (!device) return fail(404, 'device_not_found')

      // claim_secret 必须在请求体里，URL 里出现就等于泄漏（协议 §3.4）。
      if (url.searchParams.has('claim') || url.searchParams.has('claim_secret')) {
        return fail(400, 'claim_in_query')
      }
      let claim = ''
      try {
        const body = remoteDeviceClaimRequestSchema.safeParse(JSON.parse(await readBody(req)))
        if (!body.success) return fail(403, 'claim_mismatch')
        claim = body.data.claim_secret
      } catch {
        return fail(403, 'claim_mismatch')
      }

      if (!hashEquals(sha256(claim), device.claimSecretHash)) return fail(403, 'claim_mismatch')
      // 202 = 「还没好，继续轮询」。用 409 会把「等用户确认」误报成终态失败。
      if (device.status === 'pending') return fail(202, 'credentials_pending')
      if (device.status === 'revoked') return fail(404, 'device_not_found')
      // 原子领取：检查与写入在同一次同步执行里完成（Node 单线程即可保证）。
      if (device.token !== null) return fail(409, 'credentials_already_issued')

      const token = `bp_dev_${randomBytes(24).toString('base64url')}`
      device.token = token
      // 领取成功后该设备即可用于 WSS。
      tokenIndex.set(sha256(token), {
        deviceId: device.deviceId,
        token,
        status: 'active',
        publicKey: device.publicKey
      })
      return json(200, { device_token: token, expires_at: Date.now() + 30 * 24 * 3600_000 })
    }

    return fail(404, 'not_found')
  }

  // MARK: - WSS

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
    max_frame_bytes: options.maxFrameBytes ?? 1024 * 1024,
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
    lastUpgradeHeaders = { ...req.headers }

    // ---- 协议 §4.1：path ----
    if (req.url !== '/device-link' && !req.url?.startsWith('/device-link?')) {
      return rejectUpgrade(netSocket, 404, 'not_found')
    }

    // ---- §4.3 第 1 步：Authorization 存在且是 bp_dev_ ----
    const auth = req.headers.authorization
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      return rejectUpgrade(netSocket, 401, 'unauthorized')
    }
    const token = auth.slice('Bearer '.length).trim()
    if (!REMOTE_DEVICE_TOKEN_PATTERN.test(token)) {
      return rejectUpgrade(netSocket, 401, 'unauthorized')
    }

    // ---- §4.3 第 2–3 步：token hash 命中 + 状态 active ----
    const device = tokenIndex.get(sha256(token))
    if (!device) return rejectUpgrade(netSocket, 401, 'unauthorized')
    if (device.status !== 'active') {
      return device.status === 'suspended'
        ? rejectUpgrade(netSocket, 403, 'device_suspended')
        : rejectUpgrade(netSocket, 403, 'device_not_active')
    }

    // ---- §4.1：子协议 ----
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((part) => part.trim())
    if (!offered.includes(REMOTE_WS_SUBPROTOCOL)) {
      return rejectUpgrade(netSocket, 400, 'subprotocol_required')
    }

    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') return rejectUpgrade(netSocket, 400, 'bad_request')

    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    netSocket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        `Sec-WebSocket-Protocol: ${REMOTE_WS_SUBPROTOCOL}\r\n\r\n`
    )
    socket = netSocket
    connections += 1
    buffer = Buffer.alloc(0)

    /** 服务端设备公钥：优先设备表里的裸公钥，其次 options 的 SPKI。 */
    const deviceKey = resolveDeviceKey(device, options.devicePublicKey)

    netSocket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]) as Buffer<ArrayBufferLike>
      const parsed = parseClientFrames(buffer)
      buffer = parsed.rest
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          // 完整的关闭握手：收到对端的 close 帧之后才真正断开。
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
          // 验签：用**设备表里那台设备的**公钥，而不是「随便给一把」。
          // 这样「A 的 token + B 的签名」会被拒（ST-2）。
          helloVerified =
            deviceKey !== null &&
            verifyHello(
              deviceKey,
              {
                v: Number(json.v),
                type: String(json.type),
                ts: Number(json.ts),
                device_id: String(json.device_id),
                nonce: String(json.nonce),
                min_version: Number(json.min_version),
                max_version: Number(json.max_version),
                app_version: String(json.app_version),
                platform: String(json.platform),
                capabilities: Array.isArray(json.capabilities) ? json.capabilities.map(String) : [],
                serviceable: Boolean(json.serviceable)
              },
              String(json.sig)
            )
          // device_id 必须与 token 对应的设备一致：token 是「哪台设备」的唯一来源。
          const deviceIdMatches = json.device_id === device.deviceId
          dispatch(json)

          if (!helloVerified || !deviceIdMatches) {
            rejectedUpgrades += 1
            lastRejectReason = !deviceIdMatches ? 'device_id_mismatch' : 'bad_signature'
            netSocket.write(closeFrame(4001, 'device unauthorized'))
            return
          }
          // §4.3 第 8 步：版本区间协商。
          const negotiated = negotiateProtocolVersion(
            Number(json.min_version),
            Number(json.max_version),
            options.protocolVersion ?? REMOTE_PROTOCOL_VERSION,
            options.protocolVersion ?? REMOTE_PROTOCOL_VERSION
          )
          if (negotiated === null) {
            netSocket.write(closeFrame(4002, 'version unsupported'))
            return
          }
          if (options.closeAfterHello !== undefined) {
            netSocket.write(closeFrame(options.closeAfterHello, 'mock close'))
            return
          }
          if (options.malformedHelloOk) {
            const broken = buildHelloOk() as unknown as Record<string, unknown>
            delete broken.max_frame_bytes
            sendRaw(JSON.stringify(broken))
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
    rotations,
    failNextRotate(status, error) {
      nextRotateFailure = { status, error }
    },
    /** 实时视图：注册表变化后立刻可读（测试断言「只领取一次」用）。 */
    get devices() {
      const view = new Map<string, { deviceId: string; status: string; token: string | null }>()
      for (const [id, device] of registrations) {
        view.set(id, { deviceId: device.deviceId, status: device.status, token: device.token })
      }
      return view
    },
    get helloVerified() {
      return helloVerified
    },
    get connections() {
      return connections
    },
    get rejectedUpgrades() {
      return rejectedUpgrades
    },
    get lastRejectReason() {
      return lastRejectReason
    },
    get lastUpgradeHeaders() {
      return lastUpgradeHeaders
    },
    get claimAttempts() {
      return claimAttempts
    },
    send(frame) {
      sendRaw(JSON.stringify(frame))
    },
    sendText(text) {
      sendRaw(text)
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
      const target = socket
      if (!target) return
      target.write(closeFrame(code, reason))
      // 不立刻 end：等客户端回 close 帧（data 处理里会 end）。
      // 立刻 end 会让客户端只看到 1006（Spike 实测），业务 close code 就丢了。
      setTimeout(() => {
        if (!target.destroyed) target.destroy()
      }, 2_000)
    },
    trustDevicePublicKey(publicKey, deviceId) {
      const raw = rawPublicKeyOf(publicKey)
      for (const device of devices) {
        if (deviceId && device.deviceId !== deviceId) continue
        if (deviceId || device.deviceId === 'dev-1') device.publicKey = raw
      }
    },
    /**
     * 在「别处」轮换这台设备（模拟另一台机器 / 网页端换了凭据）。
     *
     * 与端点里的轮换等价，但**不经过 HTTP**：用来构造「Desktop 手里的 token
     * 已被别人换掉」这个前提到，而不需要它自己发起轮换。
     */
    rotateDeviceElsewhere({ deviceId, publicKey, newToken }) {
      const device = devices.find((entry) => entry.deviceId === deviceId)
      if (!device) return
      if (device.token) tokenIndex.delete(sha256(device.token))
      device.token = newToken
      device.publicKey = rawPublicKeyOf(publicKey)
      tokenIndex.set(sha256(newToken), device)
    },
    confirmDevice(deviceId, confirmCode) {
      const device = registrations.get(deviceId)
      if (!device || device.status !== 'pending') return false
      if (device.confirmCode !== confirmCode) return false
      device.status = 'active'
      return true
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

  // 对外暴露注册表（只读用途），便于断言「只领取一次」。
  return gateway
}

/** 设备公钥解析：优先设备表里的裸公钥（更接近真实 Cloud 的存储形态）。 */
function resolveDeviceKey(device: MockDevice, fallback?: KeyObject): KeyObject | null {
  if (device.publicKey) {
    try {
      return decodeRawPublicKey(device.publicKey)
    } catch {
      return null
    }
  }
  return fallback ?? null
}

/** 公钥或私钥 → 裸 32 字节公钥的 base64url（复用生产侧的精确长度断言）。 */
function rawPublicKeyOf(key: KeyObject): string {
  const publicKey = key.type === 'public' ? key : createPublicKey(key)
  return ed25519RawPublicKey(publicKey).toString('base64url')
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
