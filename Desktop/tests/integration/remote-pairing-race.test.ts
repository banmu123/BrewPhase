import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
  writeRemoteState,
  type RemoteSecretBox
} from '../../src/main/remote/device-identity'
import type {
  DeviceClaimResult,
  DeviceConfirmResult,
  DeviceRegistrar,
  DeviceRevokeResult
} from '../../src/main/remote/registration'
import type { WebSocketFactory } from '../../src/main/remote/link-client'
import { testWebSocketFactory } from '../helpers/ws-client'

/**
 * 配对领取的并发与失败语义（Phase R5-R3.4.1）。
 *
 * 这一组只测 Desktop 的状态机，用**注入的假 registrar / 假 safeStorage**——
 * 要覆盖「两条路径同时领」「落盘途中点取消」这些时序，真实网关得先被改造成
 * 能任意卡住与放行，反而更不可信。Cloud 端点的语义由
 * `cloud/tests/mcp-devices/*` 覆盖。
 *
 * 五条必须成立的不变量：
 * 1. **同一时刻最多一个 claim 在飞**——Cloud 的领取是一次性的，并发两个只有
 *    一个能拿到明文 Token，另一个拿 409 并去撤销设备；
 * 2. **`ok: true` 只在凭据已写进安全存储之后出现**——「Cloud confirm 通过」
 *    永远不等于「配对完成」；
 * 3. **一次性 claim 失败后不重试**，并且会撤销 Cloud 上那台设备；
 * 4. **取消/顶替之后，旧的异步收尾不许再动状态**（不清新注册、不打 blocked、
 *    不把已经写进去的凭据留在磁盘上）；
 * 5. **不删另一个有效设备的凭据**。
 */

const USER_A = 'user-a'
const USER_B = 'user-b'
/** 没有真实网关时的占位 origin（这些用例全程不发 HTTP）。 */
const SCRIPT_ORIGIN = 'http://127.0.0.1:3999'

let dir = ''
let handle: DatabaseHandle
let services: ToolServices
let service: RemoteService | null = null
let currentUserId: string | null = USER_A
let gatewayUrl = ''

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
  dir = mkdtempSync(join(tmpdir(), 'brewphase-pairing-race-'))
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
  gatewayUrl = ''
  service = null
})

afterEach(async () => {
  await service?.stop()
  service = null
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

function makeService(
  registrarFactory: Parameters<typeof createRemoteService>[0]['registrar'],
  secretBox: RemoteSecretBox = memoryBox()
): RemoteService {
  const origin = gatewayUrl || SCRIPT_ORIGIN
  writeRemoteState(deviceStorePaths(dir), { version: 1, enabled: false, cloudOrigin: origin })
  service = createRemoteService({
    db: handle.db,
    services,
    currentUserId: () => currentUserId,
    currentUserLabel: () => 'tester@example.com',
    baseDir: dir,
    cloudOrigin: origin,
    secretBox,
    webSocketFactory: wsFactory,
    clientVersion: '0.1.5-test',
    registrar: registrarFactory,
    onChanged: () => undefined,
    log: () => undefined
  })
  return service
}

// MARK: - 可编排的假 registrar

type RegistrarHooks = {
  register?: (attempt: number) => { deviceId: string }
  claim?: (attempt: number) => Promise<DeviceClaimResult> | DeviceClaimResult
  confirm?: (attempt: number) => Promise<DeviceConfirmResult> | DeviceConfirmResult
  revoke?: (attempt: number) => Promise<DeviceRevokeResult> | DeviceRevokeResult
}

/**
 * 计数器以** getter** 暴露：直接 spread 会把值复制一份，之后读到的永远是
 * 初始的 0——那正是「断言通过但什么都没测到」的经典来源。
 */
type RegistrarScript = {
  factory: (origin: string) => DeviceRegistrar
  readonly claims: number
  readonly confirms: number
  readonly revokes: number
  /** 同时在飞的 claim 数量的最大值——单飞不变量直接断言它。 */
  readonly maxConcurrentClaims: number
}

/**
 * 造一个按脚本应答的 registrar。
 *
 * 默认：claim 永远回 `pending`（等价于「用户还没点确认」），confirm 成功、
 * revoke 成功——这样每个用例只编排自己关心的那一条路径。
 */
function scriptedRegistrar(hooks: RegistrarHooks = {}): RegistrarScript {
  const state = { registers: 0, claims: 0, confirms: 0, revokes: 0, inFlight: 0, maxConcurrentClaims: 0 }

  const factory = (): DeviceRegistrar => ({
    async register() {
      state.registers += 1
      const override = hooks.register?.(state.registers)
      return {
        ok: true as const,
        deviceId: override?.deviceId ?? `dev_script_${state.registers}`,
        confirmCode: '123456',
        claimSecret: 'claim_secret_script_0000000000',
        expiresAt: Date.now() + 300_000
      }
    },
    async claim() {
      state.claims += 1
      const attempt = state.claims
      state.inFlight += 1
      state.maxConcurrentClaims = Math.max(state.maxConcurrentClaims, state.inFlight)
      try {
        return await (hooks.claim?.(attempt) ?? {
          ok: false as const,
          reason: 'pending' as const,
          retryable: true
        })
      } finally {
        state.inFlight -= 1
      }
    },
    async confirm() {
      state.confirms += 1
      return await (hooks.confirm?.(state.confirms) ?? ({ ok: true } as const))
    },
    async revoke() {
      state.revokes += 1
      return await (hooks.revoke?.(state.revokes) ?? ({ ok: true } as const))
    },
    async rotate() {
      return { ok: false as const, reason: 'invalid_response' as const }
    }
  })

  return {
    factory,
    get claims() {
      return state.claims
    },
    get confirms() {
      return state.confirms
    },
    get revokes() {
      return state.revokes
    },
    get maxConcurrentClaims() {
      return state.maxConcurrentClaims
    }
  }
}

/** 一个可以被外部「卡住 / 放行」的闸门，用来把异步窗口拉到可断言的长度。 */
function makeGate(): { promise: Promise<void>; release: () => void }
function makeGate<T>(): { promise: Promise<T>; release: (value: T) => void }
function makeGate<T = void>(): { promise: Promise<T>; release: (value: T) => void } {
  let release: ((value: T) => void) | null = null
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release: release as unknown as (value: T) => void }
}

const OK_CLAIM: DeviceClaimResult = {
  ok: true,
  deviceToken: 'bp_dev_script_token_00000001',
  expiresAt: Date.now() + 86_400_000
}

// MARK: - 单飞与并发

describe('领取单飞：两条路径绝不同时抢一次性 Token', () => {
  it('定时领取与手动确认同时发生 → 同一时刻最多一个 claim 在飞', async () => {
    // 轮询那次 claim 被卡住，就在这个窗口里点确认。
    const held = makeGate<DeviceClaimResult>()
    const script = scriptedRegistrar({
      claim: (attempt) => (attempt === 1 ? held.promise : OK_CLAIM)
    })
    service = makeService(script.factory)
    await service.start()

    await service.register()
    await waitFor(() => script.claims >= 1, 5_000)

    const confirming = service.confirmRegistration()
    // 确认必须先等在途的那次领取落定：否则两条路径会同时打 /credentials。
    await sleep(150)
    expect(script.confirms).toBe(0)

    held.release({ ok: false, reason: 'pending', retryable: true })
    const result = await confirming

    expect(result.ok).toBe(true)
    expect(script.confirms).toBe(1)
    // 轮询 1 次 + 确认 1 次，且**从不并发**。
    expect(script.claims).toBe(2)
    expect(script.maxConcurrentClaims).toBe(1)
    expect(service.status().deviceId).not.toBeNull()
  })

  it('两个 confirmRegistration 同时发生 → 只打一次 confirm 与一次 claim', async () => {
    const script = scriptedRegistrar({ claim: () => OK_CLAIM })
    service = makeService(script.factory)
    await service.start()

    await service.register()

    const [first, second] = await Promise.all([
      service.confirmRegistration(),
      service.confirmRegistration()
    ])

    expect(script.confirms).toBe(1)
    expect(script.claims).toBe(1)
    expect(script.maxConcurrentClaims).toBe(1)
    // 两次调用拿到的是**同一个**结果（单飞句柄），不是两次独立执行。
    expect(first).toBe(second)
    expect(first.ok).toBe(true)
    expect(service.status().deviceId).not.toBeNull()
  })

  it('后台 claim 已成功落盘后，手动确认不再发起第二次领取', async () => {
    // 轮询那次 claim 卡住 → 放行时直接给成功（等价于「用户在网页上点了确认」）。
    const held = makeGate<DeviceClaimResult>()
    const script = scriptedRegistrar({
      claim: (attempt) => (attempt === 1 ? held.promise : OK_CLAIM)
    })
    service = makeService(script.factory)
    await service.start()

    await service.register()
    await waitFor(() => script.claims >= 1, 5_000)

    const confirming = service.confirmRegistration()
    held.release(OK_CLAIM)
    const result = await confirming

    // 凭据已经到手 → 直接算配对完成，**绝不再领一次**（再领会拿 409 并撤销设备）。
    expect(result.ok).toBe(true)
    expect(script.claims).toBe(1)
    expect(script.confirms).toBe(0)
    expect(script.revokes).toBe(0)
    expect(service.status().deviceId).not.toBeNull()
  })

  it('确认期间轮询让路：不会在确认之后又冒出第三次领取', async () => {
    const script = scriptedRegistrar({ claim: () => OK_CLAIM })
    service = makeService(script.factory)
    await service.start()

    await service.register()
    const result = await service.confirmRegistration()
    expect(result.ok).toBe(true)

    const after = script.claims
    // pendingRegistration 已清，轮询链自然停止。
    await sleep(1_500)
    expect(script.claims).toBe(after)
    expect(script.maxConcurrentClaims).toBe(1)
  })
})

// MARK: - 领取结果 → 确认结果

describe('confirm 成功之后的每一种领取结局', () => {
  it('confirm 成功 + claim 成功 + safeStorage 成功 → ok，phase 归零，凭据落盘', async () => {
    const script = scriptedRegistrar({ claim: () => OK_CLAIM })
    service = makeService(script.factory)
    await service.start()

    const ticket = await service.register()
    expect(service.status().pairingPhase).toBe('awaiting_confirm')

    const result = await service.confirmRegistration()
    expect(result.ok).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.status.pendingRegistration).toBeNull()
    expect(result.status.pairingPhase).toBe('idle')
    expect(result.status.deviceId).toBe(ticket.deviceId)
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(true)
  })

  it('confirm 成功 + claim 返回 202 → 不算配对完成，注册保留，不落盘', async () => {
    const script = scriptedRegistrar({
      claim: () => ({ ok: false, reason: 'pending', retryable: true })
    })
    service = makeService(script.factory)
    await service.start()

    const ticket = await service.register()
    const result = await service.confirmRegistration()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('claim_pending')
    // 注册还在（可以再点一次），但**绝不**显示成配对完成。
    expect(result.status.pendingRegistration?.deviceId).toBe(ticket.deviceId)
    expect(result.status.pairingPhase).toBe('claim_incomplete')
    expect(result.status.deviceId).toBeNull()
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
    expect(service.status().linkState).not.toBe('online')
  })

  it('confirm 成功 + claim 网络异常 → 不算配对完成，注册保留，可重试', async () => {
    const script = scriptedRegistrar({
      claim: () => ({ ok: false, reason: 'network', retryable: true })
    })
    service = makeService(script.factory)
    await service.start()

    const ticket = await service.register()
    const result = await service.confirmRegistration()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('claim_network')
    expect(result.status.pendingRegistration?.deviceId).toBe(ticket.deviceId)
    expect(result.status.pairingPhase).toBe('claim_incomplete')
    expect(result.status.deviceId).toBeNull()
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
    // 网络失败不能把链路打进 blocked（那会让用户以为要重新配对）。
    expect(result.status.blockedReason).toBeNull()
  })

  it('confirm 成功 + claim 409（已签发）→ 撤销设备、清现场、提示重新配对', async () => {
    const script = scriptedRegistrar({
      claim: () => ({ ok: false, reason: 'credentials_already_issued', retryable: false }),
      revoke: () => ({ ok: true })
    })
    service = makeService(script.factory)
    await service.start()

    const ticket = await service.register()
    const result = await service.confirmRegistration()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('credentials_already_issued')
    // 一次性不可重试：立刻撤销，避免 Cloud 上留下一台谁也用不了的 active 设备。
    expect(script.revokes).toBe(1)
    expect(script.claims).toBe(1)
    expect(result.status.pendingRegistration).toBeNull()
    expect(result.status.deviceId).toBeNull()
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
    expect(result.status.needsReauth).toBe(true)
  })

  it('claim 409 且撤销也失败 → 如实报「需要人工处理」，不谎称已清理', async () => {
    const script = scriptedRegistrar({
      claim: () => ({ ok: false, reason: 'credentials_already_issued', retryable: false }),
      revoke: () => ({ ok: false, reason: 'network' })
    })
    service = makeService(script.factory)
    await service.start()

    await service.register()
    const result = await service.confirmRegistration()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('credential_cleanup_failed')
    expect(script.revokes).toBe(1)
    expect(result.status.deviceId).toBeNull()
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
  })

  it('claim 成功 + safeStorage 不可用 → 撤销设备、不落盘、不算配对完成', async () => {
    const script = scriptedRegistrar({ claim: () => OK_CLAIM })
    const box: RemoteSecretBox = { ...memoryBox(), available: () => false }
    service = makeService(script.factory, box)
    await service.start()

    await service.register()
    const result = await service.confirmRegistration()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('credential_save_failed')
    expect(script.revokes).toBe(1)
    expect(result.status.deviceId).toBeNull()
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
    expect(result.status.pendingRegistration).toBeNull()
    expect(result.status.needsReauth).toBe(true)
  })

  it('claim 成功 + safeStorage 写入抛错 → 同上', async () => {
    const script = scriptedRegistrar({ claim: () => OK_CLAIM })
    const box: RemoteSecretBox = {
      ...memoryBox(),
      async encrypt() {
        throw new Error('keychain is locked')
      }
    }
    service = makeService(script.factory, box)
    await service.start()

    await service.register()
    const result = await service.confirmRegistration()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('credential_save_failed')
    expect(script.revokes).toBe(1)
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
    expect(result.status.deviceId).toBeNull()
  })

  it('凭据没存下且撤销失败 → credential_cleanup_failed', async () => {
    const script = scriptedRegistrar({
      claim: () => OK_CLAIM,
      revoke: () => ({ ok: false, reason: 'unauthorized' })
    })
    const box: RemoteSecretBox = { ...memoryBox(), available: () => false }
    service = makeService(script.factory, box)
    await service.start()

    await service.register()
    const result = await service.confirmRegistration()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('credential_cleanup_failed')
    expect(script.revokes).toBe(1)
  })
})

// MARK: - 取消 / forget 与落盘的竞争

describe('取消与异步落盘竞争（§9）', () => {
  it('safeStorage 正在写入时点取消 → 旧操作不得把状态改成成功，磁盘不留凭据', async () => {
    const encryptGate = makeGate()
    let encryptCalls = 0
    const box: RemoteSecretBox = {
      ...memoryBox(),
      async encrypt(plain) {
        encryptCalls += 1
        await encryptGate.promise
        return Buffer.from(`ENC:${plain}`, 'utf8')
      }
    }
    const script = scriptedRegistrar({ claim: () => OK_CLAIM })
    service = makeService(script.factory, box)
    await service.start()

    await service.register()
    const confirming = service.confirmRegistration()
    // 等到真的进入落盘（claim 已回、encrypt 卡住）。
    await waitFor(() => encryptCalls >= 1, 5_000)

    // 用户同时点取消。
    const cancelling = service.cancelRegistrationNow()
    encryptGate.release()

    const [confirmResult, cancelResult] = await Promise.all([confirming, cancelling])

    // 1. 旧操作不能把状态设置成成功
    expect(confirmResult.ok).toBe(false)
    expect(confirmResult.reason).toBe('superseded')
    // 2. 不能重新开启 WSS（deviceId 从未被采纳）
    expect(confirmResult.status.deviceId).toBeNull()
    expect(cancelResult.revoked).toBe(true)
    // 3. 磁盘上不能留凭据（已写进去的那次被代际号 +1 撤掉了）
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
    expect(createDeviceStore(deviceStorePaths(dir), box).currentGeneration()).toBeGreaterThan(0)
    const status = service.status()
    expect(status.deviceId).toBeNull()
    expect(status.pendingRegistration).toBeNull()
    expect(status.pairingPhase).toBe('idle')
    expect(status.linkState).not.toBe('online')
  })

  it('claim 在途时取消 → 旧 claim 返回成功也不得覆盖取消结果', async () => {
    const held = makeGate<DeviceClaimResult>()
    const script = scriptedRegistrar({ claim: () => held.promise })
    service = makeService(script.factory)
    await service.start()

    await service.register()
    await waitFor(() => script.claims >= 1, 5_000)

    const cancelling = service.cancelRegistrationNow()
    // 取消之后才放行一个**成功**的领取结果。
    held.release(OK_CLAIM)
    const cancelResult = await cancelling

    expect(cancelResult.revoked).toBe(true)
    const status = service.status()
    expect(status.deviceId).toBeNull()
    expect(status.pendingRegistration).toBeNull()
    expect(status.pairingPhase).toBe('idle')
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)

    // 之后也没有任何补救式的落盘。
    await sleep(300)
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
    expect(status.deviceId).toBeNull()
  })

  it('claim 在途时 forget → 结果被丢弃，代际号被推进，凭据不存在', async () => {
    const held = makeGate<DeviceClaimResult>()
    const script = scriptedRegistrar({ claim: () => held.promise })
    const box = memoryBox()
    service = makeService(script.factory, box)
    await service.start()

    await service.register()
    await waitFor(() => script.claims >= 1, 5_000)

    const forgetting = service.forget()
    held.release(OK_CLAIM)
    await forgetting

    const store = createDeviceStore(deviceStorePaths(dir), box)
    expect((await store.load()).status).toBe('empty')
    expect(store.currentGeneration()).toBeGreaterThan(0)
    expect(service.status().deviceId).toBeNull()
    expect(service.status().pendingRegistration).toBeNull()
  })

  it('claim 在途时切换账户 → 结果被丢弃，不落盘', async () => {
    const held = makeGate<DeviceClaimResult>()
    const script = scriptedRegistrar({ claim: () => held.promise })
    service = makeService(script.factory)
    await service.start()

    await service.register()
    await waitFor(() => script.claims >= 1, 5_000)

    currentUserId = USER_B
    held.release(OK_CLAIM)
    await sleep(300)

    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
    expect(service.status().deviceId).toBeNull()
    expect(service.status().pendingRegistration).toBeNull()
  })

  it('safeStorage 写入期间切换账户 → 凭据属于上一个人，绝不落盘', async () => {
    const encryptGate = makeGate()
    let encryptCalls = 0
    const box: RemoteSecretBox = {
      ...memoryBox(),
      async encrypt(plain) {
        encryptCalls += 1
        await encryptGate.promise
        return Buffer.from(`ENC:${plain}`, 'utf8')
      }
    }
    const script = scriptedRegistrar({ claim: () => OK_CLAIM })
    service = makeService(script.factory, box)
    await service.start()

    await service.register()
    const confirming = service.confirmRegistration()
    await waitFor(() => encryptCalls >= 1, 5_000)

    currentUserId = USER_B
    encryptGate.release()
    const result = await confirming

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('superseded')
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
    expect(service.status().deviceId).toBeNull()
  })

  it('撤销要走一次网络往返，期间被顶替 → 旧失败不清新注册、不打 blocked', async () => {
    // claim 终态失败后，撤销被卡住——就在这段窗口里取消并重新注册。
    const revokeGate = makeGate()
    const script = scriptedRegistrar({
      claim: () => ({ ok: false, reason: 'credentials_already_issued', retryable: false }),
      revoke: () => revokeGate.promise.then(() => ({ ok: true }) as DeviceRevokeResult)
    })
    service = makeService(script.factory)
    await service.start()

    await service.register()
    const confirming = service.confirmRegistration()
    // 等到 claim 已回、正卡在 revoke 上。
    await waitFor(() => script.revokes >= 1, 5_000)

    const cancelling = service.cancelRegistrationNow()
    revokeGate.release()
    await Promise.all([confirming, cancelling])

    // 旧请求的终态失败被判定为 superseded：没有 needsReauth、没有 blocked。
    const afterCancel = service.status()
    expect(afterCancel.pendingRegistration).toBeNull()
    expect(afterCancel.needsReauth).toBe(false)
    expect(afterCancel.blockedReason).toBeNull()

    // 新注册完好无损。
    const second = await service.register()
    const status = service.status()
    expect(status.pendingRegistration?.deviceId).toBe(second.deviceId)
    expect(status.pairingPhase).toBe('awaiting_confirm')
    expect(status.needsReauth).toBe(false)
    expect(status.blockedReason).toBeNull()
    expect(status.deviceId).toBeNull()
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(false)
  })
})
