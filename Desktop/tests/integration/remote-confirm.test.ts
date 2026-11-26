import { mkdtempSync, existsSync, rmSync } from 'node:fs'
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
import { AgentJourneyService } from '../../src/main/application/agent-journey/agent-journey-service'
import type { ToolServices } from '../../src/main/application/mcp-tools/tool-services'
import { createRemoteService, type RemoteService } from '../../src/main/remote/remote-service'
import {
  deviceStorePaths,
  writeRemoteState,
  type RemoteSecretBox
} from '../../src/main/remote/device-identity'
import {
  createHttpDeviceRegistrar,
  type DeviceRegistrar,
  type DeviceRegistrarFactory
} from '../../src/main/remote/registration'
import type { WebSocketFactory } from '../../src/main/remote/link-client'
import { startMockGateway, type MockGateway } from '../helpers/mock-gateway'
import { testWebSocketFactory } from '../helpers/ws-client'

/**
 * 首次配对闭环（R5-R3.4）：注册 → 确认 → 领取 → 落盘。
 *
 * 这一组只测 Desktop 的状态机；Cloud 端的端点语义（错误码、并发、跨用户）
 * 由 `cloud/tests/mcp-devices/*` 覆盖。
 *
 * 四条必须成立的不变量：
 * 1. **注册不会自动确认，也不会自动领取**——不能因为一次 register 成功就把
 *    一台设备悄悄变成 active；
 * 2. **确认成功后才领凭据**，且只领一次（确认本身会立刻触发一次 claim）；
 * 3. **确认/领取期间换账户，凭据不落盘**（否则新账户会看到一台属于别人的设备）；
 * 4. **开关关闭时配对成功也不建连**——配对与「允许出站」是两个决定。
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

const wsFactory: WebSocketFactory = (url, options) => testWebSocketFactory(url, options)

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-confirm-'))
  handle = openDatabase(join(dir, 'test.db'))
  const events = new ApplicationEvents()
  services = {
    records: new RecordService(handle.db, handle.deviceId, events, () => undefined),
    coffee: new CoffeeService(handle.db),
    canvas: new CanvasService(handle.db, handle.deviceId, events),
    workContexts: new WorkContextService(handle.db, events),
    personalDirection: new PersonalDirectionService(handle.db, events),
    agentJourneys: new AgentJourneyService(handle.db, events),
  }
  currentUserId = USER_A
  gateway = null
  gatewayUrl = ''
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

async function waitFor(predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeService(registrar: DeviceRegistrarFactory): RemoteService {
  writeRemoteState(deviceStorePaths(dir), { version: 1, enabled: false, cloudOrigin: gatewayUrl })
  return createRemoteService({
    db: handle.db,
    services,
    currentUserId: () => currentUserId,
    currentUserLabel: () => 'tester@example.com',
    baseDir: dir,
    cloudOrigin: gatewayUrl,
    secretBox: memoryBox(),
    webSocketFactory: wsFactory,
    clientVersion: '0.1.5-test',
    registrar,
    onChanged: () => undefined,
    log: () => undefined
  })
}

function realRegistrar(): DeviceRegistrar {
  return createHttpDeviceRegistrar({
    origin: gatewayUrl,
    accessToken: async () => 'user-token'
  })
}

describe('注册 → 确认 → 领取', () => {
  it('注册后是 pending：确认码可见、设备未落盘、不会被自动确认', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    service = makeService(() => realRegistrar())
    await service.start()

    const ticket = await service.register()

    // 展示信息齐全，且账户标签来自注入的 provider
    expect(ticket.confirmCode).toMatch(/^\d{6}$/)
    expect(ticket.deviceName).toBeTruthy()
    expect(ticket.platform).toBe(process.platform)
    expect(ticket.accountLabel).toBe('tester@example.com')

    const status = service.status()
    expect(status.pendingRegistration?.deviceId).toBe(ticket.deviceId)
    expect(status.pendingRegistration?.confirmCode).toBe(ticket.confirmCode)
    // 没确认 → 没凭据 → 状态里没有 deviceId
    expect(status.deviceId).toBeNull()

    // 轮询会去领（拿 202），但绝不能因此落盘
    await sleep(1_200)
    expect(service.status().deviceId).toBeNull()
    expect(gateway!.devices.get(ticket.deviceId)?.status).toBe('pending')
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
  })

  it('确认成功后立刻领取并落盘，pending 清空', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    service = makeService(() => realRegistrar())
    await service.start()

    const ticket = await service.register()
    const result = await service.confirmRegistration()

    expect(result.ok).toBe(true)
    expect(result.status.pendingRegistration).toBeNull()
    expect(result.status.deviceId).toBe(ticket.deviceId)
    expect(result.status.boundUserId).toBe(USER_A)
    expect(gateway!.devices.get(ticket.deviceId)?.status).toBe('active')
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(true)
  })

  it('确认只领一次：确认后不再有新的 claim 请求', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    service = makeService(() => realRegistrar())
    await service.start()

    await service.register()
    await service.confirmRegistration()

    const after = gateway.claimAttempts
    await sleep(1_500)
    // 确认后 pendingRegistration 置空，轮询链自然停止。
    expect(gateway.claimAttempts).toBe(after)
  })

  it('开关关闭时配对成功也不建连', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    service = makeService(() => realRegistrar())
    await service.start()

    await service.register()
    await service.confirmRegistration()

    const status = service.status()
    expect(status.deviceId).not.toBeNull()
    // enabled 仍为 false（配对不改开关）
    expect(status.enabled).toBe(false)
    expect(status.linkState).toBe('idle')
    expect(gateway.connections).toBe(0)
  })

  it('配对完成后用户打开开关 → 用刚拿到的凭据完成 WSS 握手', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    service = makeService(() => realRegistrar())
    await service.start()

    const ticket = await service.register()
    const confirmed = await service.confirmRegistration()
    expect(confirmed.ok).toBe(true)

    // 用户显式打开开关：配对本身不改它。
    await service.enable()

    await waitFor(() => service!.status().linkState === 'online')
    const status = service.status()
    expect(status.deviceId).toBe(ticket.deviceId)
    expect(gateway.connections).toBe(1)
    // hello 通过验签：说明用的是注册时那对密钥，而不是预置凭据。
    expect(gateway.helloVerified).toBe(true)
  })
})

describe('确认失败与账户变化', () => {
  it('确认码错 → invalid_code，保留现场可重试，不落盘', async () => {
    const factory: DeviceRegistrarFactory = () => ({
      register: async () => ({
        ok: true,
        deviceId: 'dev_fixed',
        confirmCode: '123456',
        claimSecret: 'x'.repeat(32),
        expiresAt: Date.now() + 300_000
      }),
      claim: async () => ({ ok: false, reason: 'pending', retryable: true }),
      confirm: async () => ({ ok: false, reason: 'invalid_code' }),
      revoke: async () => ({ ok: true }),
      rotate: async () => ({ ok: false, reason: 'invalid_response' })
    })

    service = makeService(factory)
    await service.start()
    await service.register()

    const result = await service.confirmRegistration()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid_code')
    // 码错不该丢掉这次注册：用户还能再抄一次
    expect(result.status.pendingRegistration).not.toBeNull()
    expect(result.status.deviceId).toBeNull()
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
  })

  it('确认期间切换账户 → account_changed，且凭据不落盘', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const factory: DeviceRegistrarFactory = () => ({
      register: async () => ({
        ok: true,
        deviceId: 'dev_slow',
        confirmCode: '654321',
        claimSecret: 'y'.repeat(32),
        expiresAt: Date.now() + 300_000
      }),
      claim: async () => ({
        ok: true as const,
        deviceToken: 'bp_dev_slow_token_00000001',
        expiresAt: Date.now() + 86_400_000
      }),
      confirm: async () => {
        await gate
        return { ok: true as const }
      },
      revoke: async () => ({ ok: true }),
      rotate: async () => ({ ok: false, reason: 'invalid_response' })
    })

    service = makeService(factory)
    await service.start()
    await service.register()

    const pending = service.confirmRegistration()
    // 在 confirm 的 HTTP 窗口里切账户
    currentUserId = USER_B
    release!()

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('account_changed')
    expect(result.status.deviceId).toBeNull()
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
  })

  it('确认窗口已过 → expired，并丢弃这次注册', async () => {
    const factory: DeviceRegistrarFactory = () => ({
      register: async () => ({
        ok: true,
        deviceId: 'dev_expiring',
        confirmCode: '111222',
        claimSecret: 'z'.repeat(32),
        // 10ms 后过期：确认前就会被本地判掉
        expiresAt: Date.now() + 10
      }),
      claim: async () => ({ ok: false, reason: 'pending', retryable: true }),
      confirm: async () => ({ ok: true }),
      revoke: async () => ({ ok: true }),
      rotate: async () => ({ ok: false, reason: 'invalid_response' })
    })

    service = makeService(factory)
    await service.start()
    await service.register()
    await sleep(30)

    const result = await service.confirmRegistration()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('expired')
    expect(result.status.pendingRegistration).toBeNull()
  })
})

describe('取消配对', () => {
  it('取消后本地清空，并撤销云端 pending 设备', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    service = makeService(() => realRegistrar())
    await service.start()

    const ticket = await service.register()
    const result = await service.cancelRegistrationNow()

    expect(result.revoked).toBe(true)
    expect(result.status.pendingRegistration).toBeNull()
    expect(gateway.devices.get(ticket.deviceId)?.status).toBe('revoked')

    // 取消之后不该再领取
    const after = gateway.claimAttempts
    await sleep(1_200)
    expect(gateway.claimAttempts).toBe(after)
    expect(service.status().deviceId).toBeNull()
  })

  it('云端不可达时如实返回 revoked=false（本地仍然清空）', async () => {
    const factory: DeviceRegistrarFactory = () => ({
      register: async () => ({
        ok: true,
        deviceId: 'dev_offline',
        confirmCode: '333444',
        claimSecret: 'w'.repeat(32),
        expiresAt: Date.now() + 300_000
      }),
      claim: async () => ({ ok: false, reason: 'pending', retryable: true }),
      confirm: async () => ({ ok: true }),
      revoke: async () => ({ ok: false, reason: 'network' }),
      rotate: async () => ({ ok: false, reason: 'invalid_response' })
    })

    service = makeService(factory)
    await service.start()
    await service.register()

    const result = await service.cancelRegistrationNow()
    expect(result.revoked).toBe(false)
    expect(result.status.pendingRegistration).toBeNull()
  })
})
