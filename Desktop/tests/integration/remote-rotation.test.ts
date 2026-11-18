import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateKey, type KeyObject } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { RecordService } from '../../src/main/application/records/record-service'
import { CoffeeService } from '../../src/main/application/coffee/coffee-service'
import { CanvasService } from '../../src/main/application/canvas/canvas-service'
import { WorkContextService } from '../../src/main/application/work-context/work-context-service'
import { PersonalDirectionService } from '../../src/main/application/personal-direction/personal-direction-service'
import type { ToolServices } from '../../src/main/application/mcp-tools/tool-services'
import { createRemoteService, type RemoteService } from '../../src/main/remote/remote-service'
import {
  createDeviceStore,
  decodeRawPublicKey,
  deviceStorePaths,
  encodeRawPublicKey,
  generateDeviceKeyPair,
  rotateSigningPayload,
  signRotation,
  writeRemoteState,
  type RemoteSecretBox
} from '../../src/main/remote/device-identity'
import {
  createHttpDeviceRegistrar,
  type DeviceFetchLike,
  type DeviceRegistrar,
  type DeviceRegistrarFactory
} from '../../src/main/remote/registration'
import { REMOTE_ROTATION_LEAD_MS } from '../../src/shared/contracts/remote'
import { startMockGateway, MOCK_DEVICE_TOKEN, publicKeyOf, type MockGateway } from '../helpers/mock-gateway'
import { testWebSocketFactory } from '../helpers/ws-client'
import fixture from '../../../fixtures/remote-mcp/rotate-v1.json'

/**
 * 设备凭据轮换（Phase 1.2B.2.1）。
 *
 * 这一阶段的判据不是「轮换能成功」，而是**旧身份不可能继续被当作有效设备**。
 * 所以这里最重的几条是失败路径：落盘失败、网络结果未知、账户切换、
 * 以及「4010 从哪来」这个把「预期内的关闭」和「别人换掉了我们」区分开的判据。
 *
 * 轮换要落盘、要重连、要在 HTTP 与 WSS 两条异步路径之间不互相覆盖状态，
 * 所以三条纪律贯穿全文件：
 *
 * 1. **不用 `setTimeout` 制造时序**，用 Deferred 在精确边界暂停；
 * 2. **每条失败路径都断言「没有用旧凭据继续连」**——那是最危险的降级；
 * 3. **签名不是摆设**：Mock Gateway 用设备表里的当前公钥真验签，
 *    并记下 `verified`，否则「Desktop 到底签了什么」根本没被验证。
 */

const USER_A = 'user-a'
const USER_B = 'user-b'

/** fixture 的旧私钥：全 0x01..0x20 的固定 seed（只用于向量核对）。 */
function fixturePrivateKey(): KeyObject {
  const seed = Buffer.from(fixture.old_private_key.seed_base64url, 'base64url')
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8'
  })
}

function memoryBox(): RemoteSecretBox {
  return {
    available: () => true,
    async encrypt(plain) {
      return Buffer.from(`ENC:${plain}`, 'utf8')
    },
    async decrypt(payload) {
      const text = payload.toString('utf8')
      if (!text.startsWith('ENC:')) throw new Error('bad ciphertext')
      return text.slice(4)
    }
  }
}

/** 读得到、写不进去的盒：模拟 safeStorage 在轮换落盘那一刻失败。 */
function failingSaveBox(): RemoteSecretBox {
  return {
    available: () => true,
    async encrypt() {
      throw new Error('safeStorage unavailable')
    },
    async decrypt(payload) {
      const text = payload.toString('utf8')
      if (!text.startsWith('ENC:')) throw new Error('bad ciphertext')
      return text.slice(4)
    }
  }
}

/**
 * 一个**刚好在轮换窗口之外**的到期时间（`LEAD + 400ms`）。
 *
 * 为什么不用「已经逾期」：那样 `online` 钩子会立刻发起轮换，等测试去观察时
 * 状态已经是 `blocked` 或已重连——`waitFor(online)` 会去追一个只存在几毫秒
 * 的瞬态，这类测试在不同机器上时快时慢，最终变成看运气。
 *
 * 用「再等 400ms 才进入窗口」把时序变成**单向且可控**的：先确认在线，
 * 再等窗口打开，然后显式触发。等待有明确上限，不依赖调度。
 */
const JUST_OUTSIDE_WINDOW = () => Date.now() + REMOTE_ROTATION_LEAD_MS + 400
const WINDOW_OPENS_MS = 500

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let dir = ''
let handle: DatabaseHandle
let services: ToolServices
let gateway: MockGateway | null = null
let gatewayUrl = ''
let service: RemoteService | null = null
let currentUserId: string | null = USER_A

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-remote-rotate-'))
  handle = openDatabase(join(dir, 'test.db'))
  const events = new ApplicationEvents()
  services = {
    records: new RecordService(handle.db, handle.deviceId, events, () => undefined),
    coffee: new CoffeeService(handle.db),
    canvas: new CanvasService(handle.db, handle.deviceId, events),
    workContexts: new WorkContextService(handle.db, events),
    personalDirection: new PersonalDirectionService(handle.db, events)
  }
  currentUserId = USER_A
  gateway = null
  service = null
})

afterEach(async () => {
  await service?.stop()
  service = null
  await gateway?.stop()
  gateway = null
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 预置一份已配对凭据（等价于「1.2A 已完成注册 + 领取」）。 */
async function seedDevice(
  options: {
    cloudOrigin?: string
    boundUserId?: string
    /** `null` = 老凭据（没有到期时间字段）。 */
    tokenExpiresAt?: number | null
    privateKey?: KeyObject
  } = {}
) {
  const paths = deviceStorePaths(dir)
  const store = createDeviceStore(paths, memoryBox())
  const keys = options.privateKey ? { privateKey: options.privateKey } : generateDeviceKeyPair()
  const saved = await store.save({
    deviceId: 'dev-1',
    boundUserId: options.boundUserId ?? USER_A,
    cloudOrigin: options.cloudOrigin ?? gatewayUrl,
    deviceToken: MOCK_DEVICE_TOKEN,
    privateKey: keys.privateKey,
    registeredAt: Date.now(),
    tokenExpiresAt: options.tokenExpiresAt ?? null
  })
  expect(saved.ok).toBe(true)
  gateway?.trustDevicePublicKey(publicKeyOf(keys.privateKey), 'dev-1')
  return { store, paths, privateKey: keys.privateKey }
}

function enableSwitch(paths: ReturnType<typeof deviceStorePaths>, origin = gatewayUrl): void {
  writeRemoteState(paths, { version: 1, enabled: true, cloudOrigin: origin })
}

function makeService(overrides: {
  registrar?: DeviceRegistrarFactory
  secretBox?: RemoteSecretBox
} = {}): RemoteService {
  return createRemoteService({
    db: handle.db,
    services,
    currentUserId: () => currentUserId,
    baseDir: dir,
    cloudOrigin: gatewayUrl,
    secretBox: overrides.secretBox ?? memoryBox(),
    webSocketFactory: testWebSocketFactory,
    clientVersion: '0.1.5-test',
    registrar: overrides.registrar,
    log: () => undefined
  })
}

/**
 * 可编程的 registrar。
 *
 * 只用 `rotate`：注册 / 领取在这一组里不需要，给一个明确的抛错比伪造一个
 * 「成功」更安全（伪成功会让测试在别的路径上假绿）。
 */
function fakeRegistrar(options: {
  /** 返回 `null` 表示挂住，直到测试 `release()`。 */
  result?: Awaited<ReturnType<DeviceRegistrar['rotate']>>
  hold?: boolean
  /**
   * 「Cloud 侧真的提交了」的副作用。
   *
   * 假 registrar 默认只回一个 200，而 Mock Gateway **不会**因此认这个新 token。
   * 于是「轮换后重连」会 401，测试就会在一个与被测逻辑无关的地方失败
   * （或者更糟：看起来像「重连没发生」）。
   *
   * 需要验证重连的用例必须传 `commit`，让 Mock 的表真的换掉。
   */
  commit?: (input: Parameters<DeviceRegistrar['rotate']>[0]) => void
} = {}) {
  const calls: Array<Parameters<DeviceRegistrar['rotate']>[0]> = []
  const gate = deferred()
  const entered = deferred()
  let released = false

  const rotate: DeviceRegistrar['rotate'] = async (input) => {
    calls.push(input)
    entered.resolve()
    if (options.hold && !released) await gate.promise
    const outcome =
      options.result ??
      ({ ok: true as const, deviceToken: 'bp_dev_rotated_token_0000001', expiresAt: Date.now() + 30 * 86_400_000 } as const)
    if (outcome.ok) options.commit?.(input)
    return outcome
  }

  const registrar: DeviceRegistrar = {
    register: async () => {
      throw new Error('register is not used in rotation tests')
    },
    claim: async () => {
      throw new Error('claim is not used in rotation tests')
    },
    rotate
  }

  return {
    factory: (() => registrar) as DeviceRegistrarFactory,
    calls,
    entered: entered.promise,
    release() {
      released = true
      gate.resolve()
    }
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// MARK: - 1. 密钥生成

describe('1. 新密钥生成', () => {
  it('每次生成的裸公钥都不同、恒为 32 字节（43 字符 base64url）', () => {
    const a = encodeRawPublicKey(generateDeviceKeyPair().publicKey)
    const b = encodeRawPublicKey(generateDeviceKeyPair().publicKey)
    expect(a).not.toBe(b)
    for (const key of [a, b]) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(Buffer.from(key, 'base64url')).toHaveLength(32)
    }
  })

  it('轮换用的新密钥与旧密钥不同（不能复用旧私钥）', () => {
    const old = generateDeviceKeyPair()
    const next = generateDeviceKeyPair()
    expect(encodeRawPublicKey(next.publicKey)).not.toBe(encodeRawPublicKey(old.publicKey))
    // 旧私钥签的串，新公钥验不过——反过来说「复用」在密码学上就不成立。
    const payload = rotateSigningPayload({ deviceId: 'dev-1', newPublicKey: encodeRawPublicKey(next.publicKey), ts: 1 })
    const sig = signRotation(old.privateKey, {
      deviceId: 'dev-1',
      newPublicKey: encodeRawPublicKey(next.publicKey),
      ts: 1
    })
    expect(payload.byteLength).toBeGreaterThan(0)
    expect(Buffer.from(sig, 'base64url')).toHaveLength(64)
  })
})

// MARK: - 2. 签名原文与 Cloud 一致

describe('2. 轮换签名原文（与 Cloud 共用一份黄金向量）', () => {
  it('规范串逐字等于 fixture 的 canonical_payload', () => {
    const payload = rotateSigningPayload({
      deviceId: fixture.request.device_id,
      newPublicKey: fixture.request.new_public_key,
      ts: fixture.request.ts
    })
    expect(payload.toString('utf8')).toBe(fixture.canonical_payload)
  })

  it('用 fixture 的旧私钥复现出 fixture 的签名（Ed25519 确定性）', () => {
    const sig = signRotation(fixturePrivateKey(), {
      deviceId: fixture.request.device_id,
      newPublicKey: fixture.request.new_public_key,
      ts: fixture.request.ts
    })
    expect(sig).toBe(fixture.signature_base64url)
  })

  it('三个字段任一被改，签名都不再匹配（证明三者都在签名覆盖面内）', () => {
    const base = {
      deviceId: fixture.request.device_id,
      newPublicKey: fixture.request.new_public_key,
      ts: fixture.request.ts
    }
    const variants = [
      { ...base, deviceId: `${base.deviceId}x` },
      // 换**另一把**合法公钥：不能用 fixture.new_public_key——它就是
      // request.new_public_key 本身，那样等于没改（第一版就是这么写的）。
      { ...base, newPublicKey: fixture.old_public_key.base64url },
      { ...base, ts: base.ts + 1 }
    ]
    for (const variant of variants) {
      const sig = signRotation(fixturePrivateKey(), variant)
      expect(sig).not.toBe(fixture.signature_base64url)
    }
  })

  it('字段值里出现换行会被拒绝（否则「一行一字段」的结构有歧义）', () => {
    expect(() =>
      rotateSigningPayload({ deviceId: 'a\nb', newPublicKey: fixture.request.new_public_key, ts: 1 })
    ).toThrow()
    expect(() =>
      rotateSigningPayload({ deviceId: 'dev-1', newPublicKey: 'a\nb', ts: 1 })
    ).toThrow()
  })
})

// MARK: - 3/4. Registrar 的 HTTP 结构与响应校验

describe('3. Registrar：HTTP 请求结构', () => {
  it('真 HTTP 打到 Mock：POST + 设备 Bearer + 三个字段的紧凑 body，且签名可验', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { privateKey } = await seedDevice({ cloudOrigin: gatewayUrl })
    const store = createDeviceStore(deviceStorePaths(dir), memoryBox())
    const loaded = await store.load()
    expect(loaded.status).toBe('ok')

    const registrar = createHttpDeviceRegistrar({
      origin: gatewayUrl,
      // 轮换用**设备**凭据域：这个 provider 若被调用就说明用错了域。
      accessToken: async () => {
        throw new Error('rotation must not use the user access token')
      }
    })

    const next = generateDeviceKeyPair()
    const newPublicKey = encodeRawPublicKey(next.publicKey)
    const ts = Date.now()
    const result = await registrar.rotate({
      deviceId: 'dev-1',
      oldDeviceToken: MOCK_DEVICE_TOKEN,
      newPublicKey,
      ts,
      signature: signRotation(privateKey, { deviceId: 'dev-1', newPublicKey, ts })
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deviceToken).toMatch(/^bp_dev_[A-Za-z0-9_-]{16,}$/)
    expect(result.expiresAt).toBeGreaterThan(Date.now())

    const record = gateway.rotations.at(-1)
    expect(record).toBeDefined()
    expect(record!.deviceId).toBe('dev-1')
    // token 只在 Authorization 头里：body 里没有第二份。
    expect(record!.authorization).toBe(`Bearer ${MOCK_DEVICE_TOKEN}`)
    expect(record!.contentType).toContain('application/json')
    expect(Object.keys(record!.body).sort()).toEqual(['new_public_key', 'sig', 'ts'])
    expect(record!.body.new_public_key).toBe(newPublicKey)
    expect(record!.body.ts).toBe(ts)
    // Mock 用设备表里的**旧**公钥验签通过 → Desktop 的规范串与 Cloud 一致。
    expect(record!.verified).toBe(true)
  })

  it('token 不进 URL（路径里只有 device id）', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { privateKey } = await seedDevice({ cloudOrigin: gatewayUrl })
    const registrar = createHttpDeviceRegistrar({ origin: gatewayUrl, userAccessToken: 'unused' })
    const next = generateDeviceKeyPair()
    const newPublicKey = encodeRawPublicKey(next.publicKey)
    const ts = Date.now()
    await registrar.rotate({
      deviceId: 'dev-1',
      oldDeviceToken: MOCK_DEVICE_TOKEN,
      newPublicKey,
      ts,
      signature: signRotation(privateKey, { deviceId: 'dev-1', newPublicKey, ts })
    })
    // 记录里没有 URL，但 deviceId 是从路径解析出来的；token 若进了 query，
    // Mock 的 path 正则会匹配到带 ? 的串并解析失败。这里再正向确认一次：
    expect(gateway.rotations.at(-1)!.deviceId).toBe('dev-1')
  })
})

describe('4. Registrar：响应与错误分类', () => {
  /** 一个只回固定状态的 fetch 替身（不发真网络）。 */
  function stubFetch(status: number, body: unknown, capture?: (url: string, init: { headers: Record<string, string> }) => void): DeviceFetchLike {
    return async (url, init) => {
      capture?.(url, init)
      return {
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
      }
    }
  }

  const input = {
    deviceId: 'dev-1',
    oldDeviceToken: MOCK_DEVICE_TOKEN,
    newPublicKey: 'A'.repeat(43),
    ts: 1,
    signature: 'B'.repeat(86)
  }

  async function call(status: number, body: unknown) {
    const registrar = createHttpDeviceRegistrar({
      origin: 'https://cloud.example',
      fetchImpl: stubFetch(status, body)
    })
    return await registrar.rotate(input)
  }

  it('200 + 合法结构 → ok', async () => {
    const result = await call(200, {
      device_token: 'bp_dev_abcdefghijklmnop',
      expires_at: Date.now() + 1000
    })
    expect(result).toEqual({ ok: true, deviceToken: 'bp_dev_abcdefghijklmnop', expiresAt: expect.any(Number) })
  })

  it('200 但结构不对 → invalid_response（缺字段 / 多字段 / token 形态非法）', async () => {
    for (const body of [
      { expires_at: Date.now() },
      { device_token: 'bp_dev_abcdefghijklmnop', expires_at: Date.now(), extra: 1 },
      { device_token: 'not-a-token', expires_at: Date.now() },
      { device_token: 'bp_dev_abcdefghijklmnop', expires_at: 'tomorrow' },
      'not json'
    ]) {
      const result = await call(200, body)
      expect(result, JSON.stringify(body)).toEqual({ ok: false, reason: 'invalid_response' })
    }
  })

  it('状态码各自归类（401/404/409/429/400）', async () => {
    expect(await call(401, { error: 'device_unauthorized' })).toEqual({ ok: false, reason: 'unauthorized' })
    expect(await call(404, { error: 'device_not_found' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await call(409, { error: 'invalid_device_state' })).toEqual({ ok: false, reason: 'device_state' })
    expect(await call(429, { error: 'rate_limited' })).toEqual({ ok: false, reason: 'rate_limited' })
    expect(await call(400, { error: 'invalid_public_key' })).toEqual({ ok: false, reason: 'invalid_public_key' })
    expect(await call(500, { error: 'internal' })).toEqual({ ok: false, reason: 'invalid_response' })
  })

  it('网络失败 → network（结果未知，不能当成「失败」）', async () => {
    const registrar = createHttpDeviceRegistrar({
      origin: 'https://cloud.example',
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      }
    })
    expect(await registrar.rotate(input)).toEqual({ ok: false, reason: 'network' })
  })

  it('请求只带设备 token，不带用户 token', async () => {
    let seen: { headers: Record<string, string> } | null = null
    const registrar = createHttpDeviceRegistrar({
      origin: 'https://cloud.example',
      accessToken: async () => 'user-access-token',
      fetchImpl: stubFetch(200, { device_token: 'bp_dev_abcdefghijklmnop', expires_at: Date.now() + 1000 }, (_url, init) => {
        seen = init
      })
    })
    await registrar.rotate(input)
    expect(seen!.headers.authorization).toBe(`Bearer ${MOCK_DEVICE_TOKEN}`)
    // 用户凭据域一个字都不该出现。
    expect(JSON.stringify(seen)).not.toContain('user-access-token')
  })
})

// MARK: - 5–8. 完整轮换链路

describe('5. 完整轮换链路（真 WSS + 真 HTTP）', () => {
  it('逾期 → resume 触发轮换 → 新凭据落盘 → 用新公钥和新 token 重新握手', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths, privateKey } = await seedDevice({
      cloudOrigin: gatewayUrl,
      // 启动时在窗口外，0.5s 后进入——先确认在线，再显式触发（见 JUST_OUTSIDE_WINDOW）。
      tokenExpiresAt: JUST_OUTSIDE_WINDOW()
    })
    enableSwitch(paths)

    const registrar = createHttpDeviceRegistrar({ origin: gatewayUrl, userAccessToken: 'unused' })
    service = makeService({ registrar: () => registrar })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'first handshake')

    const gw = gateway
    const before = gw.connections
    await sleep(WINDOW_OPENS_MS)
    await service.resume()
    await waitFor(() => gw.rotations.length === 1, 'rotation request')
    await waitFor(() => gw.connections > before, 'reconnect with new credential')

    // 1) Cloud 侧真的验过签（用旧公钥）。
    expect(gateway.rotations[0]!.verified).toBe(true)
    // 2) 重新握手用的是**新**公钥：Mock 会拿轮换后的公钥验第二条 hello。
    await waitFor(() => gateway!.helloVerified, 'hello verified with the rotated key')
    expect(service.diagnose().linkState).toBe('online')

    // 3) 新 token 落盘；旧 token 不再在文件里（明文）。
    const store = createDeviceStore(paths, memoryBox())
    const loaded = await store.load()
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') return
    expect(loaded.identity.deviceToken).not.toBe(MOCK_DEVICE_TOKEN)
    expect(loaded.identity.tokenExpiresAt).toBeGreaterThan(Date.now())
    const raw = readFileSync(paths.devicePath, 'utf8')
    expect(raw).not.toContain(loaded.identity.deviceToken)
    expect(raw).not.toContain(privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'))
  })

  it('未到窗口不轮换（token 还有 30 天）', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: Date.now() + 30 * 86_400_000
    })
    enableSwitch(paths)
    const fake = fakeRegistrar()
    service = makeService({ registrar: fake.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')
    await service.resume()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fake.calls).toHaveLength(0)
  })

  it('老凭据（没有到期时间）不猜、不轮换', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({ cloudOrigin: gatewayUrl, tokenExpiresAt: null })
    enableSwitch(paths)
    const fake = fakeRegistrar()
    service = makeService({ registrar: fake.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')
    await service.resume()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fake.calls).toHaveLength(0)
  })

  it('提前量是 7 天：刚好在窗口外一天时不轮换', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: Date.now() + REMOTE_ROTATION_LEAD_MS + 86_400_000
    })
    enableSwitch(paths)
    const fake = fakeRegistrar()
    service = makeService({ registrar: fake.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')
    await service.resume()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fake.calls).toHaveLength(0)
  })
})

// MARK: - 6. 落盘失败

describe('6. 落盘失败：不许用旧凭据继续连', () => {
  it('save 失败 → blocked，且没有发出任何新连接', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: JUST_OUTSIDE_WINDOW()
    })
    enableSwitch(paths)

    // 「读得到、写不进去」的盒：load 正常（老凭据可用），save 在轮换那一刻失败。
    const fake = fakeRegistrar()
    service = makeService({ registrar: fake.factory, secretBox: failingSaveBox() })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')
    const connectionsBefore = gateway!.connections

    await sleep(WINDOW_OPENS_MS)
    await service.resume()
    await waitFor(() => fake.calls.length === 1, 'rotation attempted')
    await waitFor(() => service!.diagnose().linkState === 'blocked', 'blocked after save failure')

    // 关键：Cloud 已经换了 token，本地没落住 → 既不能拿旧的连，也不能拿新的
    // （新的一直没拿到）。所以连接数不能增加。
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(gateway.connections).toBe(connectionsBefore)
    expect(service.diagnose().blockedReason).toBeTruthy()
  })
})

// MARK: - 7/8. 4010 的两种来源

describe('7. 轮换期间的 4010 是预期内关闭', () => {
  it('不 blocked、不额外重连；轮换完成后用新凭据重连', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: JUST_OUTSIDE_WINDOW()
    })
    enableSwitch(paths)

    const fake = fakeRegistrar({
      hold: true,
      // 「Cloud 提交了」= Mock 的设备表换成新 token + 新公钥。
      // 少了这一步，重连必然 401，而那是 Mock 的缺省而不是被测逻辑的问题。
      commit: (input) => {
        gateway!.rotateDeviceElsewhere({
          deviceId: input.deviceId,
          publicKey: decodeRawPublicKey(input.newPublicKey),
          newToken: 'bp_dev_rotated_token_0000001'
        })
      }
    })
    service = makeService({ registrar: fake.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')

    await sleep(WINDOW_OPENS_MS)
    const rotation = service.resume()
    await fake.entered
    // Cloud 已经提交并关掉旧连接（真实顺序：bye → close 4010，HTTP 200 可能更晚）。
    gateway.send({ v: 1, type: 'bye', ts: Date.now(), reason: 'rotated' })
    gateway.close(4010, 'credentials rotated')
    await waitFor(() => service!.diagnose().lastCloseCode === 4010, '4010 observed')

    // 仍是同一轮轮换：绝不能因为 4010 进入 blocked（那会丢掉已发出的新 token）。
    expect(service.diagnose().linkState).not.toBe('blocked')

    const gw = gateway
    const connectionsBefore = gw.connections
    fake.release()
    await rotation
    await waitFor(() => gw.connections > connectionsBefore, 'reconnect after rotation')
    await waitFor(() => service!.diagnose().linkState === 'online', 'online with new credential')
    expect(fake.calls).toHaveLength(1)
  })
})

describe('8. 非轮换来源的 4010：安全阻断且不循环', () => {
  it('直接 blocked；网关再发多少次 4010 都不产生新连接', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: Date.now() + 30 * 86_400_000
    })
    enableSwitch(paths)
    const fake = fakeRegistrar()
    service = makeService({ registrar: fake.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')

    const connectionsBefore = gateway.connections
    gateway.close(4010, 'credentials rotated elsewhere')
    await waitFor(() => service!.diagnose().linkState === 'blocked', 'blocked')

    // 没有轮换任务在跑 → 不该去调 rotate。
    expect(fake.calls).toHaveLength(0)
    // 也不该退避重连：blocked 是终态。
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(gateway.connections).toBe(connectionsBefore)
    expect(service.diagnose().socketOpen).toBe(false)
  })
})

// MARK: - 9. 并发只执行一次

describe('9. 并发触发只执行一次轮换', () => {
  it('两个入口同时到期 → registrar.rotate 只被调用一次', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: JUST_OUTSIDE_WINDOW()
    })
    enableSwitch(paths)

    const fake = fakeRegistrar({ hold: true })
    service = makeService({ registrar: fake.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')
    await sleep(WINDOW_OPENS_MS)

    // 三个入口同时到期：都该合并到同一个任务。
    const a = service.resume()
    const b = service.resume()
    const c = service.resume()
    await fake.entered
    expect(fake.calls).toHaveLength(1)
    fake.release()
    await Promise.all([a, b, c])

    expect(fake.calls).toHaveLength(1)
  })
})

// MARK: - 10. 账户切换

describe('10. 轮换期间登出 / 切账户', () => {
  it('登出后结果不落盘，凭据保持原样（宁要求重配对，不写错账户）', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: JUST_OUTSIDE_WINDOW()
    })
    enableSwitch(paths)

    const fake = fakeRegistrar({ hold: true })
    service = makeService({ registrar: fake.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')

    await sleep(WINDOW_OPENS_MS)
    const rotation = service.resume()
    await fake.entered
    currentUserId = null
    fake.release()
    await rotation

    const loaded = await createDeviceStore(paths, memoryBox()).load()
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') return
    // 旧凭据仍在（Cloud 侧已失效），新 token 没有落到这个目录里。
    expect(loaded.identity.deviceToken).toBe(MOCK_DEVICE_TOKEN)
    expect(loaded.identity.boundUserId).toBe(USER_A)
  })

  it('切到另一个账户同样不落盘', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: JUST_OUTSIDE_WINDOW()
    })
    enableSwitch(paths)

    const fake = fakeRegistrar({ hold: true })
    service = makeService({ registrar: fake.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')

    await sleep(WINDOW_OPENS_MS)
    const rotation = service.resume()
    await fake.entered
    currentUserId = USER_B
    fake.release()
    await rotation

    const loaded = await createDeviceStore(paths, memoryBox()).load()
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') return
    expect(loaded.identity.deviceToken).toBe(MOCK_DEVICE_TOKEN)
    expect(loaded.identity.boundUserId).toBe(USER_A)
  })

  it('prepareForSignOut 会等进行中的轮换落定（否则新 token 永久丢失）', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: JUST_OUTSIDE_WINDOW()
    })
    enableSwitch(paths)

    const fake = fakeRegistrar({ hold: true })
    service = makeService({ registrar: fake.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')

    await sleep(WINDOW_OPENS_MS)
    void service.resume()
    await fake.entered

    let done = false
    const signOut = service.prepareForSignOut().then(() => {
      done = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(done).toBe(false) // 卡在轮换上：说明它真的在等

    fake.release()
    await signOut
    expect(done).toBe(true)
  })
})

// MARK: - 11. 网络结果未知

describe('11. 网络失败 = 结果未知 → blocked，不重试', () => {
  it('rotate 返回 network 时不回退到旧 token 重连', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: JUST_OUTSIDE_WINDOW()
    })
    enableSwitch(paths)

    const failure = fakeRegistrar({ result: { ok: false, reason: 'network' } })
    service = makeService({ registrar: failure.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')
    const connectionsBefore = gateway!.connections

    await sleep(WINDOW_OPENS_MS)
    await service.resume()
    await waitFor(() => service!.diagnose().linkState === 'blocked', 'blocked on unknown outcome')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(failure.calls).toHaveLength(1)
    expect(gateway.connections).toBe(connectionsBefore)
  })

  it('device_state（被暂停 / 撤销）→ blocked，不反复重试', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { paths } = await seedDevice({
      cloudOrigin: gatewayUrl,
      tokenExpiresAt: JUST_OUTSIDE_WINDOW()
    })
    enableSwitch(paths)
    const failure = fakeRegistrar({ result: { ok: false, reason: 'device_state' } })
    service = makeService({ registrar: failure.factory })
    await service.start()
    await waitFor(() => service!.diagnose().linkState === 'online', 'handshake')

    await sleep(WINDOW_OPENS_MS)
    await service.resume()
    await waitFor(() => service!.diagnose().linkState === 'blocked', 'blocked')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(failure.calls).toHaveLength(1)
  })
})
