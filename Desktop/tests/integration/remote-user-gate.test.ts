import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  deviceStorePaths,
  encodeRawPublicKey,
  generateDeviceKeyPair,
  readRemoteState,
  writeRemoteState,
  type RemoteSecretBox
} from '../../src/main/remote/device-identity'
import type { WebSocketFactory } from '../../src/main/remote/link-client'
import { startMockGateway, MOCK_DEVICE_TOKEN, type MockGateway } from '../helpers/mock-gateway'
import { testWebSocketFactory } from '../helpers/ws-client'
import { REMOTE_PROTOCOL_VERSION } from '../../src/shared/contracts/remote'

/**
 * 连接前安全门（Phase 1.1B.1 / P0-2）。
 *
 * 要证明的是**一个否定命题**：无论从哪条路径触发连接，只要
 * `boundUserId !== currentUserId`，就一次 socket 都不能建。
 *
 * 否定命题不能用「跑一遍主流程，没炸」来证明，所以这里对每条路径分别下断言，
 * 并且用「WebSocketFactory 调用次数」而不是「状态字段」作为判据——
 * 状态可以骗人，工厂被调用就说明真的往外连了。
 */

const USER_A = 'user-a'
const USER_B = 'user-b'

let dir = ''
let handle: DatabaseHandle
let services: ToolServices
let gateway: MockGateway | null = null
let gatewayUrl = ''
let service: RemoteService | null = null
let currentUserId: string | null = USER_A
let factoryCalls = 0

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

/** 计数工厂：既真的建连接，也把「尝试次数」记下来。 */
const countingFactory: WebSocketFactory = (url, options) => {
  factoryCalls += 1
  return testWebSocketFactory(url, options)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-remote-gate-'))
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
  gatewayUrl = ''
  service = null
  factoryCalls = 0
})

afterEach(async () => {
  await service?.stop()
  service = null
  await gateway?.stop()
  gateway = null
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

async function seedDevice(boundUserId = USER_A): Promise<void> {
  const paths = deviceStorePaths(dir)
  const store = createDeviceStore(paths, memoryBox())
  const { privateKey, publicKey } = generateDeviceKeyPair()
  const saved = await store.save({
    deviceId: 'dev-1',
    boundUserId,
    cloudOrigin: gatewayUrl,
    deviceToken: MOCK_DEVICE_TOKEN,
    privateKey,
    registeredAt: Date.now()
  })
  expect(saved.ok).toBe(true)
  gateway?.trustDevicePublicKey(publicKey)
}

function enableSwitch(enabled: boolean, origin = gatewayUrl): void {
  writeRemoteState(deviceStorePaths(dir), {
    version: 1,
    enabled,
    cloudOrigin: origin
  })
}

function makeService(): RemoteService {
  return createRemoteService({
    db: handle.db,
    services,
    currentUserId: () => currentUserId,
    baseDir: dir,
    cloudOrigin: gatewayUrl,
    secretBox: memoryBox(),
    webSocketFactory: countingFactory,
    clientVersion: '0.1.5-test',
    onChanged: () => undefined,
    log: () => undefined
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('主场景：A 绑定、开关关闭退出，B 登录后启动并 enable', () => {
  it('零 socket、零工厂调用，开关被改回 false，状态是 blocked', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url

    // 「上一次运行」：A 已配对，但开关是关的。
    await seedDevice(USER_A)
    enableSwitch(false)

    // 重启：新的 service 实例。此时是 B 在登录。
    currentUserId = USER_B
    service = makeService()
    await service.start()

    // 用户进设置页点开启。
    const status = await service.enable()

    expect(status.boundUserId).toBe(USER_A)
    expect(status.enabled).toBe(false)
    expect(status.linkState).toBe('blocked')
    expect(status.needsReauth).toBe(true)
    expect(status.blockedReason).toContain('differs')

    // 最硬的判据：一次都没有尝试建连接。
    expect(factoryCalls).toBe(0)
    expect(gateway.connections).toBe(0)
    // 落盘也必须是关着的：进程重启后不会「又开着」。
    expect(readRemoteState(deviceStorePaths(dir)).enabled).toBe(false)
  })
})

describe('其它入口同样不能绕过', () => {
  it('resume（睡眠唤醒）时账户已变 → 零连接', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    await seedDevice(USER_A)
    enableSwitch(true)

    currentUserId = USER_A
    service = makeService()
    await service.start()
    await waitFor(() => gateway!.connections === 1)
    const callsWhileOnline = factoryCalls

    // 睡眠中换了账户，然后唤醒。
    currentUserId = USER_B
    await service.resume()

    expect(factoryCalls).toBe(callsWhileOnline)
    expect(service.status().linkState).toBe('blocked')
    expect(service.status().needsReauth).toBe(true)
  })

  it('重连定时器到点时账户已变 → 不重连', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    await seedDevice(USER_A)
    enableSwitch(true)

    currentUserId = USER_A
    service = makeService()
    await service.start()
    await waitFor(() => gateway!.connections === 1)
    const callsWhileOnline = factoryCalls

    // 服务端断开 → 进入退避（首次 500–1000ms）。
    gateway.close(1001, 'restart')
    await waitFor(() => service!.status().linkState === 'backoff')

    // 退避还没到点，账户变了。
    currentUserId = USER_B
    await service.reconcile()

    // 等到原本该重连的时刻过去。
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(factoryCalls).toBe(callsWhileOnline)
    expect(gateway.connections).toBe(1)
    expect(service.status().linkState).toBe('blocked')
  })

  it('启动时没有用户登录 → 零连接、idle', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    await seedDevice(USER_A)
    enableSwitch(true)

    currentUserId = null
    service = makeService()
    await service.start()

    expect(factoryCalls).toBe(0)
    expect(gateway.connections).toBe(0)
    expect(service.status().linkState).toBe('idle')
  })

  it('A 登出后 B 登录：不自动把设备重新绑定给 B', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    await seedDevice(USER_A)
    enableSwitch(true)

    currentUserId = USER_A
    service = makeService()
    await service.start()
    await waitFor(() => gateway!.connections === 1)

    // A 登出。
    currentUserId = null
    await service.reconcile()
    expect(service.status().linkState).toBe('blocked')

    const callsAfterLogout = factoryCalls

    // B 登录。
    currentUserId = USER_B
    await service.reconcile()

    expect(service.status().boundUserId).toBe(USER_A)
    expect(service.status().linkState).toBe('blocked')
    expect(factoryCalls).toBe(callsAfterLogout)
  })

  it('登录校验尚未完成（currentUserId 从 null 变成 B）→ 期间零连接', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    await seedDevice(USER_A)
    enableSwitch(true)

    // 账户恢复还没跑完。
    currentUserId = null
    service = makeService()
    await service.start()
    expect(factoryCalls).toBe(0)

    // 恢复结果是 B，而不是 A。
    currentUserId = USER_B
    await service.reconcile()
    expect(factoryCalls).toBe(0)
    expect(service.status().linkState).toBe('blocked')
  })

  it('enable 与 reconcile 同时触发也只收敛到 blocked', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    await seedDevice(USER_A)
    enableSwitch(false)

    currentUserId = USER_B
    service = makeService()
    await service.start()

    await Promise.all([service.enable(), service.reconcile(), service.enable()])

    expect(factoryCalls).toBe(0)
    expect(gateway.connections).toBe(0)
    expect(service.status().linkState).toBe('blocked')
    expect(service.status().enabled).toBe(false)
  })

  it('关闭后立刻重新开启：只建立一条连接，状态收敛到 online', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    await seedDevice(USER_A)
    enableSwitch(true)

    currentUserId = USER_A
    service = makeService()
    await service.start()
    await waitFor(() => gateway!.connections === 1)

    await service.disable()
    const status = await service.enable()

    await waitFor(() => service!.status().linkState === 'online')
    expect(status.enabled).toBe(true)
    // 第二次连接建立了（connections=2），但绝不能留下两条同时活着的。
    expect(gateway.connections).toBe(2)
    expect(service.diagnose().socketOpen).toBe(true)
  })
})

describe('hello 的 serviceable 由 Desktop 独占', () => {
  it('hello 携带 serviceable，hello_ok 不携带（方向不可反）', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    await seedDevice(USER_A)
    enableSwitch(true)

    currentUserId = USER_A
    service = makeService()
    await service.start()
    await waitFor(() => gateway!.connections === 1)

    const hello = await gateway.waitFor((frame) => frame.type === 'hello')
    expect(hello.v).toBe(REMOTE_PROTOCOL_VERSION)
    expect(hello.serviceable).toBe(true)
    expect(hello.min_version).toBe(1)
    expect(hello.max_version).toBe(1)
    expect(hello.platform).toBe(process.platform)
    expect(Array.isArray(hello.capabilities)).toBe(true)
    // 握手帧里绝不含 token。
    expect(JSON.stringify(hello)).not.toContain('bp_dev_')
    // 注意：`gateway.received` 只记录 **Desktop 发来的**帧，hello_ok 是服务端
    // 发出的，不在这里。它的形状由 remote-handshake.test.ts 里的裸客户端断言
    // （那里能直接读到服务端回的第一帧）。
    expect(gateway.received.map((frame) => frame.type)).toEqual(['hello', 'status'])
  })

  it('开关被关掉后上报 serviceable=false', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    await seedDevice(USER_A)
    enableSwitch(true)

    currentUserId = USER_A
    service = makeService()
    await service.start()
    await waitFor(() => gateway!.connections === 1)

    await service.disable()
    const statusFrame = await gateway.waitFor(
      (frame) => frame.type === 'status' && frame.serviceable === false
    )
    expect(statusFrame.reason).toBe('remote_disabled')
  })
})

describe('设备注册（RemoteService 门面）', () => {
  it('未接入 Cloud 时明确报错，不伪造成功', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    service = makeService()
    await service.start()

    await expect(service.register()).rejects.toThrow(/not wired to Cloud yet/)
  })

  it('注入 registrar 后：confirmCode 给 Renderer，claim_secret 不出主进程，token 落盘', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url

    const { createHttpDeviceRegistrar } = await import('../../src/main/remote/registration')
    const registrar = createHttpDeviceRegistrar({
      origin: gatewayUrl,
      userAccessToken: 'test-bearer'
    })

    currentUserId = USER_A
    enableSwitch(false)
    service = createRemoteService({
      db: handle.db,
      services,
      currentUserId: () => currentUserId,
      baseDir: dir,
      cloudOrigin: gatewayUrl,
      secretBox: memoryBox(),
      webSocketFactory: countingFactory,
      clientVersion: '0.1.5-test',
      registrar: () => registrar,
      onChanged: () => undefined,
      log: () => undefined
    })
    await service.start()

    const ticket = await service.register()
    // 返回值只有三样：设备 id、确认码、过期时间。
    expect(Object.keys(ticket).sort()).toEqual(['confirmCode', 'deviceId', 'expiresAt'])
    expect(ticket.confirmCode).toMatch(/^\d{6}$/)

    // 用户在 Web 端确认。
    expect(gateway.confirmDevice(ticket.deviceId, ticket.confirmCode)).toBe(true)

    // 轮询拿到 token 之后，状态里应出现 deviceId 与绑定用户。
    await waitFor(() => service!.status().deviceId !== null, 6_000)
    const status = service.status()
    expect(status.deviceId).toBe(ticket.deviceId)
    expect(status.boundUserId).toBe(USER_A)
    expect(status.needsReauth).toBe(false)

    // 凭据真的落盘了（safeStorage 密文，明文 token 不在文件里）。
    const store = createDeviceStore(deviceStorePaths(dir), memoryBox())
    const loaded = await store.load()
    expect(loaded.status).toBe('ok')
    if (loaded.status === 'ok') {
      expect(loaded.identity.deviceToken).toMatch(/^bp_dev_/)
      expect(loaded.identity.deviceId).toBe(ticket.deviceId)
    }
  })

  it('注册期间忘掉设备 → 领取结果被丢弃，旧凭据不复活', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const { createHttpDeviceRegistrar } = await import('../../src/main/remote/registration')
    const registrar = createHttpDeviceRegistrar({
      origin: gatewayUrl,
      userAccessToken: 'test-bearer'
    })

    currentUserId = USER_A
    enableSwitch(false)
    service = createRemoteService({
      db: handle.db,
      services,
      currentUserId: () => currentUserId,
      baseDir: dir,
      cloudOrigin: gatewayUrl,
      secretBox: memoryBox(),
      webSocketFactory: countingFactory,
      clientVersion: '0.1.5-test',
      registrar: () => registrar,
      onChanged: () => undefined,
      log: () => undefined
    })
    await service.start()

    const ticket = await service.register()
    // 还没确认就先忘记设备（用户改主意了）。
    await service.forget()
    gateway.confirmDevice(ticket.deviceId, ticket.confirmCode)

    await new Promise((resolve) => setTimeout(resolve, 1_800))
    expect(service.status().deviceId).toBeNull()
    const store = createDeviceStore(deviceStorePaths(dir), memoryBox())
    expect((await store.load()).status).toBe('empty')
  })
})

describe('编码：公钥必须是裸 32 字节的 base64url', () => {
  it('encodeRawPublicKey 输出 43 字符', () => {
    const { publicKey } = generateDeviceKeyPair()
    const encoded = encodeRawPublicKey(publicKey)
    expect(encoded).toHaveLength(43)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
