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
  DeviceRegisterResult,
  DeviceRevokeResult
} from '../../src/main/remote/registration'
import type { RemoteStatus } from '../../src/shared/contracts/remote'
import type { WebSocketFactory } from '../../src/main/remote/link-client'
import { testWebSocketFactory } from '../helpers/ws-client'

/**
 * 配对生命周期的**确定性**竞态测试（Phase R5-R3.4.2 §四）。
 *
 * ## 为什么单独一个文件
 *
 * `remote-pairing-race.test.ts` 用的是「可编排的假 registrar」——它只回话、
 * 不记账。这一组要断言的是**最终一致性**：Cloud 设备状态、本地安全存储、
 * 用户身份、异步操作四者必须同时对得上，所以假实现得是一台有状态的
 * **Fake Cloud**（register → pending、confirm → active、claim 一次性签发、
 * revoke → revoked），并且要记下每次请求用的是哪个账户的身份。
 *
 * ## 时序怎么控制
 *
 * 全部用 **Deferred + Promise gate**：测试自己决定什么时候放行，
 * 不用 `setTimeout` 去「猜」竞态发生在哪一毫秒。每个用例的因果链是
 * 「发出请求 → 等到请求**真的在飞**（信号）→ 做那个会破坏一致性的动作 →
 * 放行 → 断言」。等待用的是 `signals.*`（请求入口处 resolve），不是轮询。
 *
 * ## 五条不变量
 *
 * 1. 同一 userData 同一时刻只有**一次** Cloud 注册；
 * 2. 作废之后，迟到的响应**不能**重建任何本地状态；
 * 3. Cloud 已签发的凭据必须被收敛（撤销），不能留下无法解释的孤儿；
 * 4. **绝不跨账户**写入或撤销；
 * 5. 旧操作**绝不**删除另一台有效设备的凭据。
 */

const USER_A = 'user-a'
const USER_B = 'user-b'
const SCRIPT_ORIGIN = 'http://127.0.0.1:3999'

let dir = ''
let handle: DatabaseHandle
let services: ToolServices
let service: RemoteService | null = null
let currentUserId: string | null = USER_A
let logs: string[] = []
/** 每一次 `publish()` 的快照——用来区分「取消中」与「取消完成」。 */
let published: RemoteStatus[] = []
/** 未处理的 Promise rejection——每条用例结束时必须为空。 */
let unhandled: unknown[] = []

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

/** 可外部放行的 Deferred——测试时序的唯一驱动源。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const wsFactory: WebSocketFactory = (url, options) => testWebSocketFactory(url, options)

function onUnhandled(reason: unknown): void {
  unhandled.push(reason)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-lifecycle-'))
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
  logs = []
  published = []
  unhandled = []
  service = null
  process.on('unhandledRejection', onUnhandled)
})

afterEach(async () => {
  process.off('unhandledRejection', onUnhandled)
  try {
    await service?.stop()
  } catch {
    /* 部分用例已经 stop 过 */
  }
  service = null
  handle.close()
  rmSync(dir, { recursive: true, force: true })
  // 先让微任务队列跑完再断言——「未处理」是相对最终状态说的。
  await new Promise((resolve) => setImmediate(resolve))
  expect(unhandled, '出现了未处理的 Promise rejection').toEqual([])
})

// MARK: - Fake Cloud

type FakeDevice = {
  deviceId: string
  owner: string
  status: 'pending' | 'active' | 'revoked'
  /** 一次性领取是否已经消费（Cloud 的 `token_issued_at IS NOT NULL`）。 */
  tokenIssued: boolean
}

type Gates = {
  /** 在真正处理请求之前 await 它；由测试持有并放行。 */
  register?: Promise<void>
  claim?: Promise<void>
  revoke?: Promise<void>
}

type FakeCloud = {
  factory: (origin: string) => DeviceRegistrar
  readonly devices: Map<string, FakeDevice>
  readonly registerCalls: number
  readonly claimCalls: number
  readonly revokeCalls: number
  readonly registerOwners: string[]
  readonly revokeOwners: string[]
  readonly revokeDeviceIds: string[]
  /** 请求**真正发出**的信号：用它代替「sleep 一下应该差不多了」。 */
  readonly signals: {
    registerStarted: Promise<void>
    claimStarted: Promise<void>
    revokeStarted: Promise<void>
  }
  gates: Gates
  /** 让下一次 revoke 失败（模拟网络不可达）。 */
  failNextRevoke: boolean
  deviceOf: (deviceId: string) => FakeDevice | undefined
}

/**
 * 一台按协议语义记账的假 Cloud。
 *
 * 关键语义与 `cloud/src/mcp-devices/claim.ts` 对齐：
 * - `pending` 时 claim → 202；
 * - `tokenIssued` 之后 claim → 409 `credentials_already_issued`（**不补发**）；
 * - `revoke` 对不存在/已撤销的设备也返回成功（幂等），但**会记下身份**。
 *
 * 身份（`owner` / `revokeOwners`）是这一组测试的核心：它让「有没有跨账户
 * 撤销」变成一条可断言的事实，而不是靠读代码推断。
 */
function fakeCloud(currentUserId: () => string | null): FakeCloud {
  const devices = new Map<string, FakeDevice>()
  const state = { registerCalls: 0, claimCalls: 0, revokeCalls: 0 }
  const registerOwners: string[] = []
  const revokeOwners: string[] = []
  const revokeDeviceIds: string[] = []
  const gates: Gates = {}
  const signalDefs = {
    registerStarted: deferred<void>(),
    claimStarted: deferred<void>(),
    revokeStarted: deferred<void>()
  }
  // 对外只暴露 Promise：测试 `await cloud.signals.x`，resolve 手柄留在内部。
  const signals = {
    registerStarted: signalDefs.registerStarted.promise,
    claimStarted: signalDefs.claimStarted.promise,
    revokeStarted: signalDefs.revokeStarted.promise
  }
  let seq = 0
  let failNextRevoke = false

  return {
    factory: () => ({
      async register(): Promise<DeviceRegisterResult> {
        state.registerCalls += 1
        const owner = currentUserId()
        registerOwners.push(owner ?? '')
        signalDefs.registerStarted.resolve()
        if (gates.register) await gates.register
        if (owner === null) return { ok: false, reason: 'unauthorized' }
        seq += 1
        const deviceId = `dev_cloud_${seq}`
        devices.set(deviceId, { deviceId, owner, status: 'pending', tokenIssued: false })
        return {
          ok: true,
          deviceId,
          confirmCode: '123456',
          claimSecret: `claim_secret_${seq}`.padEnd(32, '0'),
          expiresAt: Date.now() + 300_000
        }
      },

      async confirm(input: { deviceId: string }): Promise<DeviceConfirmResult> {
        const device = devices.get(input.deviceId)
        if (!device) return { ok: false, reason: 'not_found' }
        // 已 active 时幂等返回 200（与 Cloud 一致）。
        if (device.status === 'pending') device.status = 'active'
        return { ok: true }
      },

      async claim(input: { deviceId: string }): Promise<DeviceClaimResult> {
        state.claimCalls += 1
        signalDefs.claimStarted.resolve()
        if (gates.claim) await gates.claim
        const device = devices.get(input.deviceId)
        if (!device) return { ok: false, reason: 'claim_rejected', retryable: false }
        if (device.status === 'pending') return { ok: false, reason: 'pending', retryable: true }
        if (device.status === 'revoked') return { ok: false, reason: 'claim_rejected', retryable: false }
        if (device.tokenIssued) {
          return { ok: false, reason: 'credentials_already_issued', retryable: false }
        }
        device.tokenIssued = true
        return {
          ok: true,
          deviceToken: `bp_dev_fake_${device.deviceId}_token`,
          expiresAt: Date.now() + 86_400_000
        }
      },

      async revoke(input: { deviceId: string }): Promise<DeviceRevokeResult> {
        state.revokeCalls += 1
        revokeOwners.push(currentUserId() ?? '')
        revokeDeviceIds.push(input.deviceId)
        signalDefs.revokeStarted.resolve()
        if (gates.revoke) await gates.revoke
        if (failNextRevoke) {
          failNextRevoke = false
          return { ok: false, reason: 'network' }
        }
        const device = devices.get(input.deviceId)
        // 不存在 / 已撤销都算成功（幂等），与 Cloud 的 404 → 200 一致。
        if (device) device.status = 'revoked'
        return { ok: true }
      },

      async rotate() {
        return { ok: false as const, reason: 'invalid_response' as const }
      }
    }),
    devices,
    get registerCalls() {
      return state.registerCalls
    },
    get claimCalls() {
      return state.claimCalls
    },
    get revokeCalls() {
      return state.revokeCalls
    },
    registerOwners,
    revokeOwners,
    revokeDeviceIds,
    signals,
    gates,
    get failNextRevoke() {
      return failNextRevoke
    },
    set failNextRevoke(value: boolean) {
      failNextRevoke = value
    },
    deviceOf: (deviceId) => devices.get(deviceId)
  }
}

function makeService(
  registrarFactory: Parameters<typeof createRemoteService>[0]['registrar'],
  secretBox: RemoteSecretBox = memoryBox()
): RemoteService {
  writeRemoteState(deviceStorePaths(dir), { version: 1, enabled: false, cloudOrigin: SCRIPT_ORIGIN })
  service = createRemoteService({
    db: handle.db,
    services,
    currentUserId: () => currentUserId,
    currentUserLabel: () => 'tester@example.com',
    baseDir: dir,
    cloudOrigin: SCRIPT_ORIGIN,
    secretBox,
    webSocketFactory: wsFactory,
    clientVersion: '0.1.5-test',
    registrar: registrarFactory,
    onChanged: (status) => published.push(status),
    log: (line) => logs.push(line)
  })
  return service
}

const deviceFile = (): string => deviceStorePaths(dir).devicePath

/** 每条用例都该成立的本地不变量。 */
function expectNoLocalCredential(svc: RemoteService): void {
  expect(existsSync(deviceFile()), '磁盘上不该留有凭据').toBe(false)
  expect(svc.status().deviceId).toBeNull()
  expect(svc.status().boundUserId).toBeNull()
  expect(svc.status().pendingRegistration).toBeNull()
  expect(svc.status().pairingPhase).toBe('idle')
}

/** 日志里绝不能出现确认码 / claim_secret / Token / 私钥（§五.5）。 */
function expectNoSecretInLogs(): void {
  const blob = logs.join('\n')
  for (const forbidden of ['123456', 'claim_secret', 'bp_dev_', 'device_token', 'PRIVATE KEY']) {
    expect(blob, `日志里出现了 ${forbidden}`).not.toContain(forbidden)
  }
}

/** 注册 + 确认，直到 claim 请求**真的在飞**（由调用方持有的 gate 挡住）。 */
async function startPairingUntilClaimInFlight(
  cloud: FakeCloud,
  svc: RemoteService,
  claimGate: Promise<void>
): Promise<{ ticket: { deviceId: string }; confirming: Promise<{ ok: boolean; reason: string | null }> }> {
  cloud.gates.claim = claimGate
  const ticket = await svc.register()
  const confirming = svc.confirmRegistration()
  await cloud.signals.claimStarted
  return { ticket, confirming: confirming as Promise<{ ok: boolean; reason: string | null }> }
}

// MARK: - 任务 A：register 单飞

describe('A. register 单飞与迟到响应', () => {
  it('1. 两个 register 同时调用 → 只产生一次 Cloud 注册，拿到同一张 ticket', async () => {
    const gate = deferred<void>()
    const cloud = fakeCloud(() => currentUserId)
    cloud.gates.register = gate.promise
    const svc = makeService(cloud.factory)
    await svc.start()

    const first = svc.register()
    const second = svc.register()
    await cloud.signals.registerStarted
    gate.resolve()

    const [ticketA, ticketB] = await Promise.all([first, second])

    expect(cloud.registerCalls, 'Cloud 只该被请求一次').toBe(1)
    expect(ticketA).toBe(ticketB)
    expect(cloud.devices.size).toBe(1)
    const status = svc.status()
    expect(status.pendingRegistration?.deviceId).toBe(ticketA.deviceId)
    expect(status.pairingPhase).toBe('awaiting_confirm')
    expect(cloud.deviceOf(ticketA.deviceId)?.status).toBe('pending')
    expect(cloud.registerOwners).toEqual([USER_A])
    expectNoSecretInLogs()
  })

  it('2. register 期间 forget → 迟到响应不能恢复 pending，Cloud 设备被撤销', async () => {
    const gate = deferred<void>()
    const cloud = fakeCloud(() => currentUserId)
    cloud.gates.register = gate.promise
    const svc = makeService(cloud.factory)
    await svc.start()

    const registering = svc.register()
    await cloud.signals.registerStarted
    // forget 是「先失效、再等待」，所以它要等注册响应落定才返回。
    const forgetting = svc.forget()
    gate.resolve()

    await forgetting
    await expect(registering).rejects.toThrow(/interrupted/)

    expectNoLocalCredential(svc)
    expect(cloud.registerCalls).toBe(1)
    const device = [...cloud.devices.values()][0]!
    expect(device.status, '迟到响应建出来的设备必须被撤销').toBe('revoked')
    expect(cloud.revokeOwners).toEqual([USER_A])
    expect(svc.status().lastError).toBeNull()
    expectNoSecretInLogs()
  })

  it('3. register 期间 sign out → 不留下旧账户设备', async () => {
    const gate = deferred<void>()
    const cloud = fakeCloud(() => currentUserId)
    cloud.gates.register = gate.promise
    const svc = makeService(cloud.factory)
    await svc.start()

    const registering = svc.register()
    await cloud.signals.registerStarted
    const signingOut = svc.prepareForSignOut()
    gate.resolve()

    await signingOut
    await expect(registering).rejects.toThrow(/interrupted/)

    expectNoLocalCredential(svc)
    const device = [...cloud.devices.values()][0]!
    expect(device.owner).toBe(USER_A)
    expect(device.status).toBe('revoked')
    // 撤销用的是**发起注册时**的身份。
    expect(cloud.revokeOwners).toEqual([USER_A])
    expectNoSecretInLogs()
  })

  it('4. register 期间账户切换 → 不能绑定错误账户，也不跨账户撤销', async () => {
    const gate = deferred<void>()
    const cloud = fakeCloud(() => currentUserId)
    cloud.gates.register = gate.promise
    const svc = makeService(cloud.factory)
    await svc.start()

    const registering = svc.register()
    await cloud.signals.registerStarted
    currentUserId = USER_B
    gate.resolve()

    await expect(registering).rejects.toThrow(/account change/)

    // 关键：**一次撤销都不发**（新账户的 Bearer 动不了旧账户的设备），
    // 并且必须如实留下「需要手动清理」的痕迹。
    expect(cloud.revokeCalls, '跨账户撤销必须被拒绝').toBe(0)
    expectNoLocalCredential(svc)
    expect(svc.status().boundUserId).toBeNull()
    expect(svc.status().lastError).toMatch(/cleanup pending/)
    expect(svc.status().lastError).toMatch(/cloud device list/)
    expectNoSecretInLogs()
  })

  it('5. register 期间 stop → 迟到响应不能恢复操作，之后拒绝新注册', async () => {
    const gate = deferred<void>()
    const cloud = fakeCloud(() => currentUserId)
    cloud.gates.register = gate.promise
    const svc = makeService(cloud.factory)
    await svc.start()

    const registering = svc.register()
    await cloud.signals.registerStarted
    const stopping = svc.stop()
    gate.resolve()

    await stopping
    await expect(registering).rejects.toThrow(/interrupted/)

    expectNoLocalCredential(svc)
    expect([...cloud.devices.values()][0]!.status).toBe('revoked')
    await expect(svc.register()).rejects.toThrow(/stopping/)
    expectNoSecretInLogs()
  })
})

// MARK: - 任务 B：claim / 保存期间的取消收敛

describe('B. 领取与保存期间的取消收敛', () => {
  it('6. claim 期间 disable → 不残留本地有效凭据，Cloud 设备被撤销', async () => {
    const claimGate = deferred<void>()
    const cloud = fakeCloud(() => currentUserId)
    const svc = makeService(cloud.factory)
    await svc.start()

    const { confirming } = await startPairingUntilClaimInFlight(cloud, svc, claimGate.promise)
    const disabling = svc.disable()
    claimGate.resolve()

    const status = await disabling
    const result = await confirming

    expect(status.deviceId).toBeNull()
    expect(result.ok, '凭据没落盘就不该显示配对完成').toBe(false)
    expect(result.reason).toBe('superseded')
    expectNoLocalCredential(svc)
    expect([...cloud.devices.values()][0]!.status).toBe('revoked')
    expect(cloud.revokeOwners).toEqual([USER_A])
    expectNoSecretInLogs()
  })

  it('7. claim 期间 forget → 不留下未处理的 Cloud 激活设备', async () => {
    const claimGate = deferred<void>()
    const cloud = fakeCloud(() => currentUserId)
    const svc = makeService(cloud.factory)
    await svc.start()

    const { ticket, confirming } = await startPairingUntilClaimInFlight(cloud, svc, claimGate.promise)
    const forgetting = svc.forget()
    claimGate.resolve()

    await forgetting
    const result = await confirming

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('superseded')
    // 本地没了，**Cloud 也不能留 active 孤儿**——这是 R5-R3.4.2 §三的核心。
    expect(existsSync(deviceFile())).toBe(false)
    const device = cloud.deviceOf(ticket.deviceId)!
    expect(device.status).toBe('revoked')
    expect(device.tokenIssued, 'Token 确实被签发过（所以必须撤销）').toBe(true)
    expect(cloud.revokeOwners).toEqual([USER_A])
    expectNoSecretInLogs()
  })

  it('8. claim 期间 sign out → 不跨账户写入，也不跨账户撤销', async () => {
    const claimGate = deferred<void>()
    const cloud = fakeCloud(() => currentUserId)
    const svc = makeService(cloud.factory)
    await svc.start()

    const { ticket, confirming } = await startPairingUntilClaimInFlight(cloud, svc, claimGate.promise)
    const signingOut = svc.prepareForSignOut()
    // 账户凭据已被清掉：`accessToken()` 不再可用。
    currentUserId = null
    claimGate.resolve()

    await signingOut
    const result = await confirming

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('superseded')
    expect(existsSync(deviceFile()), '不能跨账户写入凭据').toBe(false)
    expect(svc.status().boundUserId).toBeNull()
    // 关键：**一次撤销都不发**，并且如实留痕（不能谎报「已清理」）。
    expect(cloud.revokeCalls, '身份已失效，撤销必须被拒绝').toBe(0)
    expect(svc.status().lastError).toMatch(/cleanup pending/)
    expect(cloud.deviceOf(ticket.deviceId)!.status, '孤儿必须被点名').toBe('active')
    expectNoSecretInLogs()
  })

  it('9. safeStorage 保存期间取消 → 磁盘不残留旧凭据，Cloud 侧同步收敛', async () => {
    const encryptStarted = deferred<void>()
    const encryptGate = deferred<void>()
    const box: RemoteSecretBox = {
      ...memoryBox(),
      async encrypt(plain) {
        encryptStarted.resolve()
        await encryptGate.promise
        return Buffer.from(`ENC:${plain}`, 'utf8')
      }
    }
    const cloud = fakeCloud(() => currentUserId)
    const svc = makeService(cloud.factory, box)
    await svc.start()

    const ticket = await svc.register()
    const confirming = svc.confirmRegistration()
    await encryptStarted.promise

    const cancelling = svc.cancelRegistrationNow()
    encryptGate.resolve()

    const [cancelResult, confirmResult] = await Promise.all([cancelling, confirming])

    expect(confirmResult.ok).toBe(false)
    expect(confirmResult.reason).toBe('superseded')
    expect(cancelResult.revoked, '取消必须如实反映 Cloud 侧结果').toBe(true)
    expect(existsSync(deviceFile()), '磁盘上不能残留旧凭据').toBe(false)
    expect(createDeviceStore(deviceStorePaths(dir), box).currentGeneration()).toBeGreaterThan(0)
    expectNoLocalCredential(svc)
    expect(cloud.deviceOf(ticket.deviceId)!.status).toBe('revoked')
    // 撤销可能被触发两次（claim 收尾 + 取消本身），但**身份与目标必须始终一致**。
    expect(cloud.revokeOwners.length).toBeGreaterThan(0)
    expect(cloud.revokeOwners.every((owner) => owner === USER_A)).toBe(true)
    expect(cloud.revokeDeviceIds.every((id) => id === ticket.deviceId)).toBe(true)
    expectNoSecretInLogs()
  })

  it('10. 连续两次 cancel → 不重复清理、不覆盖状态', async () => {
    const cloud = fakeCloud(() => currentUserId)
    const box = memoryBox()
    const svc = makeService(cloud.factory, box)
    await svc.start()

    const ticket = await svc.register()
    const [first, second] = await Promise.all([
      svc.cancelRegistrationNow(),
      svc.cancelRegistrationNow()
    ])

    // 两次都如实反映「Cloud 上那台设备已经不在了」，但只发一次撤销请求。
    expect(first.revoked).toBe(true)
    expect(second.revoked).toBe(true)
    expect(cloud.revokeCalls, '不该重复撤销').toBe(1)
    expect(cloud.devices.size).toBe(1)
    expect(cloud.deviceOf(ticket.deviceId)!.status).toBe('revoked')

    expectNoLocalCredential(svc)
    // 没有落盘就没有代际推进：连续取消不能把 generation 抬成 2。
    expect(createDeviceStore(deviceStorePaths(dir), box).currentGeneration()).toBe(0)

    // 第三次（已完成之后）同样是无操作，不产生额外请求。
    const third = await svc.cancelRegistrationNow()
    expect(third.revoked).toBe(true)
    expect(cloud.revokeCalls).toBe(1)
    expectNoSecretInLogs()
  })

  it('11. 旧设备清理期间新注册 → 旧操作不能清除新状态', async () => {
    const claimGate = deferred<void>()
    const revokeGate = deferred<void>()
    const cloud = fakeCloud(() => currentUserId)
    const svc = makeService(cloud.factory)
    await svc.start()

    const { ticket: oldTicket, confirming } = await startPairingUntilClaimInFlight(
      cloud,
      svc,
      claimGate.promise
    )

    // 让「撤销」这一步也卡住，把清理窗口拉到可以插进新注册。
    cloud.gates.revoke = revokeGate.promise
    const cancelling = svc.cancelRegistrationNow()
    claimGate.resolve()
    await cloud.signals.revokeStarted

    // 旧清理还在进行时发起新注册：它必须等旧的落定，然后**不被旧清理清掉**。
    const registering = svc.register()
    revokeGate.resolve()

    const [cancelResult, ticket] = await Promise.all([cancelling, registering])
    await confirming

    expect(cancelResult.revoked).toBe(true)
    expect(ticket.deviceId, '新注册必须成立').not.toBe(oldTicket.deviceId)

    const status = svc.status()
    expect(status.pendingRegistration?.deviceId, '旧清理不能清除新注册').toBe(ticket.deviceId)
    expect(status.pairingPhase).toBe('awaiting_confirm')
    expect(status.deviceId).toBeNull()
    expect(status.boundUserId).toBeNull()
    expect(existsSync(deviceFile())).toBe(false)

    // 两台设备各自收敛：旧的被撤销，新的仍是 pending（等用户确认）。
    expect(cloud.deviceOf(oldTicket.deviceId)!.status).toBe('revoked')
    expect(cloud.deviceOf(ticket.deviceId)!.status).toBe('pending')
    expect(cloud.revokeDeviceIds.every((id) => id === oldTicket.deviceId)).toBe(true)
    expectNoSecretInLogs()
  })

  it('12. 已正式配对的有效设备不会被旧注册的清理逻辑误删', async () => {
    const cloud = fakeCloud(() => currentUserId)
    const svc = makeService(cloud.factory)
    await svc.start()

    const ticket = await svc.register()
    const paired = await svc.confirmRegistration()
    expect(paired.ok).toBe(true)
    expect(existsSync(deviceFile()), '正式配对后必须有 device.json').toBe(true)
    expect(svc.status().deviceId).toBe(ticket.deviceId)
    expect(svc.status().boundUserId).toBe(USER_A)
    const generationAfterPairing = createDeviceStore(deviceStorePaths(dir), memoryBox()).currentGeneration()

    // 这些路径都会调 `cancelRegistration`，但**都不能碰正式配对的凭据**，
    // 也绝不能去撤销 Cloud 上那台正在用的设备。
    const cancelled = await svc.cancelRegistrationNow()
    expect(cancelled.revoked).toBe(true)
    expect(cloud.revokeCalls, '取消一个不存在的配对不该动正式设备').toBe(0)
    expect(existsSync(deviceFile())).toBe(true)
    expect(svc.status().deviceId).toBe(ticket.deviceId)

    // 而且新注册必须被拒绝——这正是「不覆盖另一台有效设备」的第一道守卫。
    // （放在 stop 之前：之后会被 `shuttingDown` 先拦住，测的就不是这条了。）
    await expect(svc.register()).rejects.toThrow(/already paired/)
    expect(existsSync(deviceFile())).toBe(true)
    expect(svc.status().deviceId).toBe(ticket.deviceId)

    await svc.disable()
    expect(existsSync(deviceFile())).toBe(true)
    expect(svc.status().boundUserId).toBe(USER_A)

    await svc.stop()
    expect(existsSync(deviceFile())).toBe(true)

    expect(svc.status().deviceId).toBe(ticket.deviceId)
    expect(svc.status().boundUserId).toBe(USER_A)
    expect(
      createDeviceStore(deviceStorePaths(dir), memoryBox()).currentGeneration(),
      '取消/关闭/停止都不该推进代际（那会删掉凭据）'
    ).toBe(generationAfterPairing)
    expectNoSecretInLogs()
  })
})

// MARK: - 任务 D：状态与安全边界

describe('D. 状态与安全边界', () => {
  it('账户变化后，状态不会把旧账户设备显示成「当前用户已配对」', async () => {
    const cloud = fakeCloud(() => currentUserId)
    const svc = makeService(cloud.factory)
    await svc.start()

    await svc.register()
    const paired = await svc.confirmRegistration()
    expect(paired.ok).toBe(true)

    currentUserId = USER_B
    await svc.reconcile()

    const status = svc.status()
    // 凭据保留（按约定），但必须明确标注「绑定的是谁」+ 需要重新认证，
    // 而不是让界面读成「当前用户已配对」。
    expect(status.deviceId).not.toBeNull()
    expect(status.boundUserId).toBe(USER_A)
    expect(status.boundUserId).not.toBe(currentUserId)
    expect(status.needsReauth).toBe(true)
    expect(status.blockedReason).toMatch(/bound user/)
    expect(status.pendingRegistration).toBeNull()
  })

  it('取消中与取消完成是两件事：完成前不广播新状态', async () => {
    const cloud = fakeCloud(() => currentUserId)
    const svc = makeService(cloud.factory)
    await svc.start()

    await svc.register()
    const before = published.length

    const cancelling = svc.cancelRegistrationNow()
    // 同步段只做「失效」，**不 publish**：界面在这段窗口里仍然显示
    // 待确认卡片 + 「正在取消…」按钮，而不是看起来已经取消完了。
    expect(published.length, '取消进行中不该广播新状态').toBe(before)

    const result = await cancelling
    expect(published.length, '取消完成后才广播').toBeGreaterThan(before)
    expect(result.status.pendingRegistration).toBeNull()
    expect(result.status.pairingPhase).toBe('idle')
    expect(result.revoked).toBe(true)
  })

  it('revoke 失败时必须如实报 false，不能展示成成功', async () => {
    const cloud = fakeCloud(() => currentUserId)
    const svc = makeService(cloud.factory)
    await svc.start()

    await svc.register()
    cloud.failNextRevoke = true

    const result = await svc.cancelRegistrationNow()

    expect(result.revoked, '撤销失败绝不能报成功').toBe(false)
    expect(cloud.revokeCalls).toBe(1)
    expect(svc.status().lastError).toMatch(/cleanup pending/)
    expectNoSecretInLogs()
  })

  it('日志不出现确认码、claim_secret、Token 或私钥', async () => {
    const cloud = fakeCloud(() => currentUserId)
    const svc = makeService(cloud.factory)
    await svc.start()

    const ticket = await svc.register()
    const paired = await svc.confirmRegistration()
    expect(paired.ok).toBe(true)
    // 再跑一遍取消，把失败/清理分支的日志也覆盖到。
    await svc.cancelRegistrationNow().catch(() => undefined)

    const blob = logs.join('\n')
    expect(blob).not.toContain(ticket.confirmCode)
    expect(blob).not.toContain('claim_secret')
    expect(blob).not.toContain('bp_dev_')
    expect(blob).not.toContain('PRIVATE KEY')
    expect(blob).not.toContain('device_token')
    expectNoSecretInLogs()
  })
})
