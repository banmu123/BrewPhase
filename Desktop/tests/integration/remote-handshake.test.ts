import { describe, expect, it, afterEach } from 'vitest'
import { startMockGateway, MOCK_DEVICE_TOKEN, type MockGateway } from '../helpers/mock-gateway'
import { createTestWebSocket } from '../helpers/ws-client'
import { buildHelloFrame, parseHelloOk } from '../../src/main/remote/link-client'
import {
  generateDeviceKeyPair,
  helloSigningPayload,
  signHello,
  encodeRawPublicKey,
  type HelloSigningInput
} from '../../src/main/remote/device-identity'
import { REMOTE_PROTOCOL_VERSION, REMOTE_WS_SUBPROTOCOL } from '../../src/shared/contracts/remote'

/**
 * 握手与接入认证（协议 §4.1 / §4.2 / §4.3）。
 *
 * 这一组用例的存在理由：Phase 1.1B 的实现**根本没有把 device_token 发出去**，
 * 而当时所有测试都是绿的——因为 Mock 无条件返回 101。所以这里从两个方向夹住：
 *
 * 1. Mock 侧：错误 token / 缺 token / 错子协议 / 错 path 必须被拒；
 * 2. 客户端侧：连接时真的带了 header（用 `lastUpgradeHeaders` 断言）。
 *
 * 另外把 hello 的**字段集**与**签名覆盖面**做成结构断言：两边一旦漂移就红。
 */

let gateway: MockGateway | null = null

afterEach(async () => {
  await gateway?.stop()
  gateway = null
})

/** 直接建一条 WS，返回收到的第一帧或关闭原因。 */
async function rawConnect(
  url: string,
  options: { headers?: Record<string, string>; protocols?: string[] },
  hello?: string
): Promise<{ opened: boolean; protocol: string; frame: Record<string, unknown> | null; close: { code: number; reason: string } | null }> {
  const ws = createTestWebSocket(`${url}/device-link`, options)
  return new Promise((resolve) => {
    let opened = false
    let protocol = ''
    const timer = setTimeout(() => resolve({ opened, protocol, frame: null, close: null }), 3_000)
    ws.onopen = () => {
      opened = true
      protocol = ws.protocol
      if (hello) ws.send(hello)
    }
    ws.onmessage = (event) => {
      clearTimeout(timer)
      resolve({ opened, protocol, frame: JSON.parse(String(event.data)) as Record<string, unknown>, close: null })
    }
    ws.onclose = (event) => {
      clearTimeout(timer)
      resolve({ opened, protocol, frame: null, close: { code: event.code, reason: event.reason } })
    }
    ws.onerror = () => {
      /* 随后会有 onclose */
    }
  })
}

function helloFor(
  input: Partial<HelloSigningInput> & { device_id: string },
  privateKey: import('node:crypto').KeyObject
): { input: HelloSigningInput; frame: string } {
  const base: HelloSigningInput = {
    v: REMOTE_PROTOCOL_VERSION,
    type: 'hello',
    ts: Date.now(),
    nonce: 'nonce_0123456789abcdefgh',
    min_version: 1,
    max_version: 1,
    app_version: '0.1.5-test',
    platform: 'darwin',
    capabilities: ['tools.call', 'cancel', 'drain'],
    serviceable: true,
    ...input
  }
  const sig = signHello(privateKey, base)
  return {
    input: base,
    frame: buildHelloFrame({
      ts: base.ts,
      deviceId: base.device_id,
      nonce: base.nonce,
      minVersion: base.min_version,
      maxVersion: base.max_version,
      appVersion: base.app_version,
      platform: base.platform,
      capabilities: base.capabilities,
      serviceable: base.serviceable,
      sig
    })
  }
}

describe('接入认证：Mock 不再无条件 101', () => {
  it('正确 token + 正确子协议 + 正确签名 → 101 并收到 hello_ok', async () => {
    const { privateKey, publicKey } = generateDeviceKeyPair()
    gateway = await startMockGateway({ devicePublicKey: publicKey })
    gateway.trustDevicePublicKey(publicKey)

    const { frame } = await rawConnect(
      gateway.url,
      { headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` }, protocols: [REMOTE_WS_SUBPROTOCOL] },
      helloFor({ device_id: 'dev-1' }, privateKey).frame
    )

    expect(frame?.type).toBe('hello_ok')
    expect(gateway.connections).toBe(1)
    expect(gateway.helloVerified).toBe(true)
    // 服务端确实看到了 Bearer，且完整。
    expect(gateway.lastUpgradeHeaders?.authorization).toBe(`Bearer ${MOCK_DEVICE_TOKEN}`)
    expect(gateway.lastUpgradeHeaders?.['sec-websocket-protocol']).toBe(REMOTE_WS_SUBPROTOCOL)
  })

  it('没有 Authorization → 拒绝 Upgrade', async () => {
    gateway = await startMockGateway({})
    const result = await rawConnect(gateway.url, { protocols: [REMOTE_WS_SUBPROTOCOL] })
    expect(result.opened).toBe(false)
    expect(gateway.connections).toBe(0)
    expect(gateway.lastRejectReason).toBe('unauthorized')
  })

  it('伪造 token → 拒绝', async () => {
    gateway = await startMockGateway({})
    const result = await rawConnect(gateway.url, {
      headers: { Authorization: 'Bearer bp_dev_forged_token_000000' },
      protocols: [REMOTE_WS_SUBPROTOCOL]
    })
    expect(result.opened).toBe(false)
    expect(gateway.connections).toBe(0)
    expect(gateway.lastRejectReason).toBe('unauthorized')
  })

  it('形态不对的凭据（用户 token / bp_mcp_）→ 在格式这一步就被拒', async () => {
    gateway = await startMockGateway({})
    for (const wrong of ['bp_mcp_abcdefghijklmnop', 'user-access-token-123456', 'bp_dev_short']) {
      const result = await rawConnect(gateway.url, {
        headers: { Authorization: `Bearer ${wrong}` },
        protocols: [REMOTE_WS_SUBPROTOCOL]
      })
      expect(result.opened).toBe(false)
    }
    expect(gateway.connections).toBe(0)
  })

  it('revoked 设备 → 拒绝', async () => {
    gateway = await startMockGateway({
      devices: [{ deviceId: 'dev-1', token: MOCK_DEVICE_TOKEN, status: 'revoked' }]
    })
    const result = await rawConnect(gateway.url, {
      headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` },
      protocols: [REMOTE_WS_SUBPROTOCOL]
    })
    expect(result.opened).toBe(false)
    expect(gateway.connections).toBe(0)
    expect(gateway.lastRejectReason).toBe('device_not_active')
  })

  it('suspended 设备 → 拒绝', async () => {
    gateway = await startMockGateway({
      devices: [{ deviceId: 'dev-1', token: MOCK_DEVICE_TOKEN, status: 'suspended' }]
    })
    const result = await rawConnect(gateway.url, {
      headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` },
      protocols: [REMOTE_WS_SUBPROTOCOL]
    })
    expect(result.opened).toBe(false)
    expect(gateway.lastRejectReason).toBe('device_suspended')
  })

  it('缺子协议 → 拒绝', async () => {
    gateway = await startMockGateway({})
    const result = await rawConnect(gateway.url, {
      headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` }
    })
    expect(result.opened).toBe(false)
    expect(gateway.lastRejectReason).toBe('subprotocol_required')
  })

  it('错误子协议 → 拒绝', async () => {
    gateway = await startMockGateway({})
    const result = await rawConnect(gateway.url, {
      headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` },
      protocols: ['brewphase.remote.v2']
    })
    expect(result.opened).toBe(false)
    expect(gateway.lastRejectReason).toBe('subprotocol_required')
  })

  it('错误 path → 拒绝', async () => {
    gateway = await startMockGateway({})
    const ws = createTestWebSocket(`${gateway.url}/wrong-path`, {
      headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` },
      protocols: [REMOTE_WS_SUBPROTOCOL]
    })
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true)
      ws.onclose = () => resolve(false)
      ws.onerror = () => resolve(false)
    })
    expect(opened).toBe(false)
    expect(gateway.lastRejectReason).toBe('not_found')
  })

  it('token 只出现在 header：URL、hello 帧、日志里都没有', async () => {
    const { privateKey, publicKey } = generateDeviceKeyPair()
    gateway = await startMockGateway({ devicePublicKey: publicKey })
    gateway.trustDevicePublicKey(publicKey)

    const logs: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    const originalErr = process.stderr.write.bind(process.stderr)
    const capture = (chunk: unknown): boolean => {
      logs.push(String(chunk))
      return true
    }
    process.stdout.write = capture as never
    process.stderr.write = capture as never
    try {
      const hello = helloFor({ device_id: 'dev-1' }, privateKey).frame
      const { frame } = await rawConnect(
        gateway.url,
        { headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` }, protocols: [REMOTE_WS_SUBPROTOCOL] },
        hello
      )
      expect(frame?.type).toBe('hello_ok')

      // hello 帧里没有 token（协议 §4.2 的硬要求）。
      expect(hello).not.toContain(MOCK_DEVICE_TOKEN)
      expect(hello).not.toContain('bp_dev_')
      // 请求行/URL 里也没有。
      expect(gateway.lastUpgradeHeaders?.authorization).toContain(MOCK_DEVICE_TOKEN)
    } finally {
      process.stdout.write = originalWrite
      process.stderr.write = originalErr
    }
    expect(logs.join('\n')).not.toContain(MOCK_DEVICE_TOKEN)
  })
})

describe('hello 契约：字段集 = 签名覆盖面', () => {
  it('规范串覆盖 hello 的每个字段（除 sig）', () => {
    const { privateKey } = generateDeviceKeyPair()
    const { input, frame } = helloFor({ device_id: 'dev-1' }, privateKey)
    const parsed = JSON.parse(frame) as Record<string, unknown>

    const canonical = helloSigningPayload(input).toString('utf8')
    const lines = canonical.split('\n')
    // 首行是域分隔，其余是 key=value。
    expect(lines[0]).toBe('brewphase.remote.hello.v1')
    const signedKeys = lines.slice(1).map((line) => line.slice(0, line.indexOf('=')))

    const frameKeys = Object.keys(parsed).filter((key) => key !== 'sig')
    expect([...signedKeys].sort()).toEqual([...frameKeys].sort())
    // 逐项对齐，避免「键集相同但顺序不同」这种假通过。
    expect(signedKeys).toEqual([
      'v',
      'type',
      'ts',
      'device_id',
      'nonce',
      'min_version',
      'max_version',
      'app_version',
      'platform',
      'capabilities',
      'serviceable'
    ])
  })

  it('capabilities 排序后进签名（同集合不同顺序签名相同）', () => {
    const { privateKey } = generateDeviceKeyPair()
    const a = helloSigningPayload({
      v: 1,
      type: 'hello',
      ts: 1,
      device_id: 'd',
      nonce: 'n',
      min_version: 1,
      max_version: 1,
      app_version: 'v',
      platform: 'darwin',
      capabilities: ['drain', 'cancel'],
      serviceable: true
    }).toString('utf8')
    const b = helloSigningPayload({
      v: 1,
      type: 'hello',
      ts: 1,
      device_id: 'd',
      nonce: 'n',
      min_version: 1,
      max_version: 1,
      app_version: 'v',
      platform: 'darwin',
      capabilities: ['cancel', 'drain'],
      serviceable: true
    }).toString('utf8')
    expect(a).toBe(b)
    void privateKey
  })

  it('字段值里带换行会被拒绝（防止规范串歧义）', () => {
    expect(() =>
      helloSigningPayload({
        v: 1,
        type: 'hello',
        ts: 1,
        device_id: 'dev\n1',
        nonce: 'n',
        min_version: 1,
        max_version: 1,
        app_version: 'v',
        platform: 'darwin',
        capabilities: [],
        serviceable: true
      })
    ).toThrow(/line breaks/)
  })

  it('篡改任一手握字段 → Mock 验签失败并 close 4001', async () => {
    const { privateKey, publicKey } = generateDeviceKeyPair()
    gateway = await startMockGateway({ devicePublicKey: publicKey })
    gateway.trustDevicePublicKey(publicKey)

    const { frame } = helloFor({ device_id: 'dev-1' }, privateKey)
    const tampered = { ...(JSON.parse(frame) as Record<string, unknown>), serviceable: false }

    const result = await rawConnect(
      gateway.url,
      { headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` }, protocols: [REMOTE_WS_SUBPROTOCOL] },
      JSON.stringify(tampered)
    )
    expect(result.close?.code).toBe(4001)
    expect(gateway.helloVerified).toBe(false)
  })

  it('device_id 与 token 对应的设备不符 → 拒绝', async () => {
    const { privateKey, publicKey } = generateDeviceKeyPair()
    gateway = await startMockGateway({ devicePublicKey: publicKey })
    gateway.trustDevicePublicKey(publicKey)

    const result = await rawConnect(
      gateway.url,
      { headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` }, protocols: [REMOTE_WS_SUBPROTOCOL] },
      helloFor({ device_id: 'dev-other' }, privateKey).frame
    )
    expect(result.close?.code).toBe(4001)
    expect(gateway.lastRejectReason).toBe('device_id_mismatch')
  })

  it('min_version > max_version → 4002（区间无交集）', async () => {
    const { privateKey, publicKey } = generateDeviceKeyPair()
    gateway = await startMockGateway({ devicePublicKey: publicKey })
    gateway.trustDevicePublicKey(publicKey)

    const result = await rawConnect(
      gateway.url,
      { headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` }, protocols: [REMOTE_WS_SUBPROTOCOL] },
      helloFor({ device_id: 'dev-1', min_version: 2, max_version: 1 }, privateKey).frame
    )
    expect(result.close?.code).toBe(4002)
  })

  it('版本区间不含 1 → 4002', async () => {
    const { privateKey, publicKey } = generateDeviceKeyPair()
    gateway = await startMockGateway({ devicePublicKey: publicKey })
    gateway.trustDevicePublicKey(publicKey)

    const result = await rawConnect(
      gateway.url,
      { headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` }, protocols: [REMOTE_WS_SUBPROTOCOL] },
      helloFor({ device_id: 'dev-1', min_version: 2, max_version: 3 }, privateKey).frame
    )
    expect(result.close?.code).toBe(4002)
  })

  it('hello_ok 不含 serviceable（方向不可反）', async () => {
    const { privateKey, publicKey } = generateDeviceKeyPair()
    gateway = await startMockGateway({ devicePublicKey: publicKey })
    gateway.trustDevicePublicKey(publicKey)

    const { frame } = await rawConnect(
      gateway.url,
      { headers: { Authorization: `Bearer ${MOCK_DEVICE_TOKEN}` }, protocols: [REMOTE_WS_SUBPROTOCOL] },
      helloFor({ device_id: 'dev-1' }, privateKey).frame
    )
    expect(frame).not.toBeNull()
    const parsed = parseHelloOk(JSON.stringify(frame))
    expect(parsed.ok).toBe(true)
    expect(Object.keys(frame as Record<string, unknown>)).not.toContain('serviceable')
  })
})

describe('设备注册闭环（协议 §3，Mock 端点）', () => {
  it('register → 未确认时轮询得到 pending → 确认 → 领取 → 二次领取被拒', async () => {
    gateway = await startMockGateway({})
    const { createHttpDeviceRegistrar } = await import('../../src/main/remote/registration')
    const registrar = createHttpDeviceRegistrar({ origin: gateway.url, userAccessToken: 'test-bearer' })
    const { privateKey, publicKey } = generateDeviceKeyPair()

    const registered = await registrar.register({
      name: 'test-mac',
      platform: 'darwin',
      publicKey: encodeRawPublicKey(publicKey),
      appVersion: '0.1.5-test'
    })
    expect(registered.ok).toBe(true)
    if (!registered.ok) return

    // 还没确认：轮询应该是「可重试的 pending」，不是终态失败。
    const early = await registrar.claim({
      deviceId: registered.deviceId,
      claimSecret: registered.claimSecret
    })
    expect(early.ok).toBe(false)
    if (!early.ok) {
      expect(early.reason).toBe('pending')
      expect(early.retryable).toBe(true)
    }

    // 模拟用户在 Web 端输入确认码。
    expect(gateway.confirmDevice(registered.deviceId, registered.confirmCode)).toBe(true)

    const claimed = await registrar.claim({
      deviceId: registered.deviceId,
      claimSecret: registered.claimSecret
    })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(claimed.deviceToken).toMatch(/^bp_dev_/)

    // 一次性：第二次必须是终态失败，不能补发。
    const again = await registrar.claim({
      deviceId: registered.deviceId,
      claimSecret: registered.claimSecret
    })
    expect(again.ok).toBe(false)
    // Cloud 回的是 `credentials_already_issued`（409 + 错误码），比笼统的
    // `claim_rejected` 更有用：调用方据此知道「Token 已签发但这一方没拿到」
    // ——那是一次性不可重试，必须撤销后重新配对，而不是继续轮询。
    if (!again.ok) expect(again.reason).toBe('credentials_already_issued')
    if (!again.ok) expect(again.retryable).toBe(false)

    // 拿到的 token 能真的用于 WSS 握手。
    gateway.trustDevicePublicKey(publicKey)
    const hello = helloFor({ device_id: registered.deviceId }, privateKey).frame
    const result = await rawConnect(
      gateway.url,
      { headers: { Authorization: `Bearer ${claimed.deviceToken}` }, protocols: [REMOTE_WS_SUBPROTOCOL] },
      hello
    )
    expect(result.frame?.type).toBe('hello_ok')
  })

  it('错误的 claim_secret → claim_rejected', async () => {
    gateway = await startMockGateway({})
    const { createHttpDeviceRegistrar } = await import('../../src/main/remote/registration')
    const registrar = createHttpDeviceRegistrar({ origin: gateway.url, userAccessToken: 'test-bearer' })
    const { publicKey } = generateDeviceKeyPair()

    const registered = await registrar.register({
      name: 'test-mac',
      platform: 'darwin',
      publicKey: encodeRawPublicKey(publicKey),
      appVersion: '0.1.5-test'
    })
    expect(registered.ok).toBe(true)
    if (!registered.ok) return
    gateway.confirmDevice(registered.deviceId, registered.confirmCode)

    const bad = await registrar.claim({
      deviceId: registered.deviceId,
      claimSecret: 'wrong_secret_000000000000'
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe('claim_rejected')
  })

  it('claim_secret 不得出现在 URL 里', async () => {
    gateway = await startMockGateway({})
    const { createHttpDeviceRegistrar } = await import('../../src/main/remote/registration')
    const urls: string[] = []
    const registrar = createHttpDeviceRegistrar({
      origin: gateway.url,
      userAccessToken: 'test-bearer',
      fetchImpl: (url, init) => {
        // 记录真实请求的 URL —— claim_secret 一旦出现在 query 里，这条断言会红。
        urls.push(url)
        return fetch(url, init as RequestInit) as unknown as ReturnType<NonNullable<Parameters<typeof createHttpDeviceRegistrar>[0]['fetchImpl']>>
      }
    })
    const { publicKey } = generateDeviceKeyPair()
    const registered = await registrar.register({
      name: 'test-mac',
      platform: 'darwin',
      publicKey: encodeRawPublicKey(publicKey),
      appVersion: '0.1.5-test'
    })
    expect(registered.ok).toBe(true)
    if (!registered.ok) return
    gateway.confirmDevice(registered.deviceId, registered.confirmCode)
    await registrar.claim({ deviceId: registered.deviceId, claimSecret: registered.claimSecret })

    for (const url of urls) {
      expect(url).not.toContain(registered.claimSecret)
      expect(url).not.toContain('claim')
    }
  })
})
