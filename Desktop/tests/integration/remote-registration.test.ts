import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
  readRemoteState,
  writeRemoteState,
  type RemoteSecretBox
} from '../../src/main/remote/device-identity'
import { createHttpDeviceRegistrar, type DeviceFetchLike } from '../../src/main/remote/registration'
import type { WebSocketFactory } from '../../src/main/remote/link-client'
import {
  remoteDiagnosisSchema,
  remotePendingRegistrationSchema,
  remoteStatusSchema
} from '../../src/shared/contracts/remote'
import { startMockGateway, MOCK_DEVICE_TOKEN, type MockGateway } from '../helpers/mock-gateway'
import { testWebSocketFactory } from '../helpers/ws-client'

/**
 * Desktop 设备注册接入（Phase 1.2A）。
 *
 * 这一组不测 Cloud 的端点语义（那在 cloud/tests 里），只测 Desktop 这一侧
 * 三条容易写错、且后果严重的边界：
 *
 * 1. **token 每次请求前现取**，不缓存过期的那一份；
 * 2. **账户切换 / 登出会让进行中的注册立刻失效**，且结果不落盘；
 * 3. **claim_secret 与 device_token 都不出现在 IPC 返回值与磁盘明文里**。
 *
 * 第 2 条尤其值得盯：`claimOnce` 是异步的（要等网络 + safeStorage 加密），
 * 而「切换账户」是同步发生的。两者之间那个窗口如果没锁住，旧账户的凭据会
 * 落进新账户的设备目录——用户会看到一台属于别人的设备。
 */

/** 去掉行注释与块注释（保留字符串字面量里的内容不做特殊处理）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

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

const noopFactory: WebSocketFactory = (url, options) => testWebSocketFactory(url, options)

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-registrar-'))
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

function makeService(registrarFactory: Parameters<typeof createRemoteService>[0]['registrar']): RemoteService {
  writeRemoteState(deviceStorePaths(dir), { version: 1, enabled: false, cloudOrigin: gatewayUrl })
  return createRemoteService({
    db: handle.db,
    services,
    currentUserId: () => currentUserId,
    baseDir: dir,
    cloudOrigin: gatewayUrl,
    secretBox: memoryBox(),
    webSocketFactory: noopFactory,
    clientVersion: '0.1.5-test',
    registrar: registrarFactory,
    onChanged: () => undefined,
    log: () => undefined
  })
}

/** 指向当前 Mock 网关的真实 HTTP registrar：走完整 register → confirm → claim 链路。 */
function realRegistrar(): ReturnType<typeof createHttpDeviceRegistrar> {
  return createHttpDeviceRegistrar({ origin: gatewayUrl, accessToken: async () => 'user-token' })
}

describe('Access token 必须每次现取', () => {
  it('register 与每次 claim 轮询都重新调用 provider（不复用旧 token）', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url

    let tokenCalls = 0
    const tokens: string[] = []
    const registrar = createHttpDeviceRegistrar({
      origin: gatewayUrl,
      // 每次返回不同的值：如果实现缓存了第一次的 token，服务端会看到重复值。
      accessToken: async () => {
        tokenCalls += 1
        const value = `token-${tokenCalls}`
        tokens.push(value)
        return value
      }
    })

    const registered = await registrar.register({
      name: 'mac',
      platform: 'darwin',
      publicKey: Buffer.alloc(32, 5).toString('base64url'),
      appVersion: '0.1.5'
    })
    expect(registered.ok).toBe(true)
    if (!registered.ok) return
    expect(tokenCalls).toBe(1)

    // 未确认前轮询两次 → 每次都应当重新取 token
    await registrar.claim({ deviceId: registered.deviceId, claimSecret: registered.claimSecret })
    await registrar.claim({ deviceId: registered.deviceId, claimSecret: registered.claimSecret })
    expect(tokenCalls).toBe(3)
    expect(new Set(tokens).size).toBe(3)
  })

  it('provider 抛错（未登录）→ unauthorized，且**不可重试**', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const registrar = createHttpDeviceRegistrar({
      origin: gatewayUrl,
      accessToken: async () => {
        throw new Error('signed-out')
      }
    })

    const registered = await registrar.register({
      name: 'mac',
      platform: 'darwin',
      publicKey: Buffer.alloc(32, 5).toString('base64url'),
      appVersion: '0.1.5'
    })
    expect(registered).toEqual({ ok: false, reason: 'unauthorized' })

    const claimed = await registrar.claim({ deviceId: 'dev_x', claimSecret: 'x'.repeat(32) })
    expect(claimed).toEqual({ ok: false, reason: 'unauthorized', retryable: false })
  })

  it('网络失败 → network 且可重试（轮询不该因此停掉）', async () => {
    const registrar = createHttpDeviceRegistrar({
      origin: 'http://127.0.0.1:1',
      accessToken: async () => 'token',
      timeoutMs: 200,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as DeviceFetchLike
    })
    const claimed = await registrar.claim({ deviceId: 'dev_x', claimSecret: 'y'.repeat(32) })
    expect(claimed).toEqual({ ok: false, reason: 'network', retryable: true })
  })

  it('202 → pending 且可重试；409 → claim_rejected 且不可重试', async () => {
    const statuses = [202, 409]
    let index = 0
    const registrar = createHttpDeviceRegistrar({
      origin: 'http://127.0.0.1:9',
      accessToken: async () => 'token',
      fetchImpl: (async () => {
        const status = statuses[index] ?? 409
        index += 1
        return { status, text: async () => '{}' }
      }) as unknown as DeviceFetchLike
    })

    expect(await registrar.claim({ deviceId: 'd', claimSecret: 'z'.repeat(32) })).toEqual({
      ok: false,
      reason: 'pending',
      retryable: true
    })
    expect(await registrar.claim({ deviceId: 'd', claimSecret: 'z'.repeat(32) })).toEqual({
      ok: false,
      reason: 'claim_rejected',
      retryable: false
    })
  })

  it('不跟随重定向（302 不会把 claim_secret 带到别的主机）', async () => {
    let sawRedirect = ''
    const registrar = createHttpDeviceRegistrar({
      origin: 'http://127.0.0.1:9',
      accessToken: async () => 'token',
      fetchImpl: (async (_url: string, init: { redirect: string }) => {
        sawRedirect = init.redirect
        return { status: 302, text: async () => '' }
      }) as unknown as DeviceFetchLike
    })
    await registrar.claim({ deviceId: 'd', claimSecret: 'q'.repeat(32) })
    expect(sawRedirect).toBe('manual')
  })
})

describe('账户切换 / 登出会让进行中的注册失效', () => {
  /**
   * 造一个「卡住不返回」的 claim：用它把 `claimOnce` 卡在 await 上，
   * 然后在窗口里切换账户，再放行。这样才能真的测到那个竞态。
   */
  function hangingRegistrar(): {
    factory: (origin: string) => ReturnType<typeof createHttpDeviceRegistrar>
    release: () => void
    claimCalls: () => number
  } {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const factory = () => ({
      async register(input: { publicKey: string }) {
        return {
          ok: true as const,
          deviceId: 'dev-held',
          // 固定 6 位，便于后面在确认流程里用
          confirmCode: '123456',
          claimSecret: 'claim_secret_for_hanging_test_0001',
          expiresAt: Date.now() + 300_000
        }
        void input
      },
      async claim() {
        calls += 1
        await gate
        return { ok: true as const, deviceToken: 'bp_dev_held_token_00000001', expiresAt: Date.now() + 86_400_000 }
      },
      // 这个假实现只服务于「claim 在途」的场景；rotate 走真实 HTTP 客户端
      // 在 remote-rotation.test.ts 里测，这里给一个明确的未实现标记。
      async rotate() {
        return { ok: false as const, reason: 'invalid_response' as const }
      },
      // 确认与撤销由 remote-confirm.test.ts 专门覆盖；这里只保证接口完整。
      async confirm() {
        return { ok: true as const }
      },
      async revoke() {
        return { ok: true as const }
      }
    })
    return {
      factory,
      release: () => release?.(),
      claimCalls: () => calls
    }
  }

  it('claim 在途时切换账户 → 结果被丢弃，不落盘', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url

    const hanging = hangingRegistrar()
    service = makeService(hanging.factory)
    await service.start()

    const ticket = await service.register()
    expect(ticket.deviceId).toBe('dev-held')

    // 等轮询真的发起（默认 1s 后第一次）
    await waitFor(() => hanging.claimCalls() >= 1, 5_000)

    // 在 await 期间切换账户，然后放行网络响应
    currentUserId = USER_B
    hanging.release()

    await new Promise((resolve) => setTimeout(resolve, 300))

    // 什么都没落盘：那台设备属于 A，不能出现在 B 的目录里
    const store = createDeviceStore(deviceStorePaths(dir), memoryBox())
    expect((await store.load()).status).toBe('empty')
    expect(service.status().deviceId).toBeNull()
  })

  it('claim 在途时登出（prepareForSignOut）→ 结果被丢弃', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url

    const hanging = hangingRegistrar()
    service = makeService(hanging.factory)
    await service.start()

    await service.register()
    await waitFor(() => hanging.claimCalls() >= 1, 5_000)

    await service.prepareForSignOut()
    hanging.release()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const store = createDeviceStore(deviceStorePaths(dir), memoryBox())
    expect((await store.load()).status).toBe('empty')
  })

  it('pending 期间再次 register 必须被拒绝，不能静默顶替上一次', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url

    const hanging = hangingRegistrar()
    service = makeService(hanging.factory)
    await service.start()

    const first = await service.register()
    await waitFor(() => hanging.claimCalls() >= 1, 5_000)
    const callsBefore = hanging.claimCalls()

    // 再点一次「配对新设备」→ 必须拒绝。旧实现是 `cancelRegistration('superseded')`：
    // Cloud 上那台 pending 设备与用户手上的确认码会被一起丢掉，
    // 而界面已经换成了新的一台——用户对着旧确认码点确认，只会 404。
    await expect(service.register()).rejects.toThrow(/already in progress/)

    // 第一次注册仍然是当前那次：deviceId 与确认码都没被换掉
    const still = service.status().pendingRegistration
    expect(still?.deviceId).toBe(first.deviceId)
    expect(still?.confirmCode).toBe(first.confirmCode)
    expect(service.status().pairingPhase).toBe('awaiting_confirm')

    hanging.release()
    await new Promise((resolve) => setTimeout(resolve, 1_400))
    // 没有第二条领取路径被造出来（仍然只有同一条在跑）
    expect(hanging.claimCalls()).toBeLessThanOrEqual(callsBefore + 1)
  })

  it('已有 deviceId 时再次 register 必须被拒绝（不覆盖 device.json）', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    service = makeService(() => realRegistrar())
    await service.start()

    const ticket = await service.register()
    const paired = await service.confirmRegistration()
    expect(paired.ok).toBe(true)

    // 每个 userData 目录只保存一份设备身份：再注册会把可用凭据顶掉，
    // 用户会在毫无提示的情况下掉线。必须先走「忘记此设备」。
    await expect(service.register()).rejects.toThrow(/already paired/)
    expect(service.status().deviceId).toBe(ticket.deviceId)
    expect(existsSync(deviceStorePaths(dir).devicePath)).toBe(true)
  })
})

describe('凭证边界', () => {
  it('register 的返回值只有展示信息：confirmCode / deviceId / deviceName / platform / expiresAt / accountLabel', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const registrar = createHttpDeviceRegistrar({
      origin: gatewayUrl,
      accessToken: async () => 'token'
    })
    service = makeService(() => registrar)
    await service.start()

    const ticket = await service.register()
    // 一个多余字段都可能变成 Renderer 的泄漏面：这里锁死键集。
    // 新增的 deviceName / platform / accountLabel 都是「确认前给你看清绑到谁」
    // 所需的展示信息，不含任何可换 token 的材料。
    expect(Object.keys(ticket).sort()).toEqual([
      'accountLabel',
      'confirmCode',
      'deviceId',
      'deviceName',
      'expiresAt',
      'platform'
    ])
    // claim_secret 绝不出现在返回对象里
    expect(JSON.stringify(ticket)).not.toContain('claim_secret')
    expect(JSON.stringify(ticket)).not.toContain('claimSecret')
  })

  it('claim_secret 不落盘：设备目录里只有 state.json 与（领取后的）device.json', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway.url
    const registrar = createHttpDeviceRegistrar({
      origin: gatewayUrl,
      accessToken: async () => 'token'
    })
    service = makeService(() => registrar)
    await service.start()
    await service.register()

    const files = readdirSync(deviceStorePaths(dir).dir)
    // 注册阶段不落任何凭据文件：claim_secret 只活在内存里
    expect(files.sort()).toEqual(['state.json'])

    const raw = readFileSync(deviceStorePaths(dir).statePath, 'utf8')
    expect(raw).not.toContain('claim')
    expect(raw).not.toContain('bp_dev_')
  })

  it('device.json 里没有明文 device_token（只有密文载荷）', async () => {
    // 用一个直接成功的 registrar，把流程推到落盘之后
    const paths = deviceStorePaths(dir)
    writeRemoteState(paths, { version: 1, enabled: false, cloudOrigin: 'http://127.0.0.1:9' })
    const store = createDeviceStore(paths, memoryBox())
    const { generateDeviceKeyPair } = await import('../../src/main/remote/device-identity')
    const { privateKey } = generateDeviceKeyPair()
    await store.save({
      deviceId: 'dev-1',
      boundUserId: USER_A,
      cloudOrigin: 'http://127.0.0.1:9',
      deviceToken: MOCK_DEVICE_TOKEN,
      privateKey,
      registeredAt: Date.now()
    })

    const raw = readFileSync(paths.devicePath, 'utf8')
    expect(raw).not.toContain(MOCK_DEVICE_TOKEN)
    expect(raw).not.toContain('bp_dev_')
    // 外层只有版本/算法/代际/密文
    const envelope = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(envelope).sort()).toEqual(['alg', 'generation', 'payload', 'version'])
  })

  it('RemoteService 不读账户凭据文件（源码级约束）', () => {
    // 结构断言：`src/main/remote/**` 不得出现账户凭据模块的导入或文件名。
    //
    // 必须先剥掉注释：`device-identity.ts` 的**文档**里正好写着
    // 「与 account/credentials.ts 的分工（不许合并）」——那是解释，不是依赖。
    // 不剥注释的检查会把这条正确的注释判成违规（本用例第一次就是这么红的）。
    const remoteDir = join(process.cwd(), 'src/main/remote')
    for (const name of readdirSync(remoteDir).filter((file) => file.endsWith('.ts'))) {
      const source = stripComments(readFileSync(join(remoteDir, name), 'utf8'))
      expect(source, `${name} 不得导入 account/credentials`).not.toMatch(
        /from ['"]\.\.?\/.*account\/(credentials|account-service)['"]/
      )
      expect(source, `${name} 不得读取 credentials.json`).not.toContain('credentials.json')
      expect(source, `${name} 不得触碰 refresh token`).not.toContain('refreshToken')
    }
  })
})

describe('Renderer 拿不到任何用户凭证', () => {
  /**
   * 这条是「Access Token 只在 Main 里」的**结构证明**。
   *
   * 功能测试证明不了它：只要有一天有人加了个 `account:access-token` 通道，
   * 所有现有用例都会继续通过，而 Renderer 已经能读到用户的 token 了。
   * 所以直接断言源码层面不存在这条通路。
   */
  it('preload 暴露的 API 里没有 accessToken / refreshToken', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const source = stripComments(preload)
    expect(source).not.toContain('accessToken')
    expect(source).not.toContain('refreshToken')
  })

  it('IPC 通道表与入参 schema 里没有取 token 的通道', () => {
    for (const file of ['src/shared/contracts/validation/ipc.ts', 'src/shared/contracts/index.ts']) {
      const source = stripComments(readFileSync(join(process.cwd(), file), 'utf8'))
      expect(source, `${file} 不应出现 token 通道`).not.toContain('accessToken')
      expect(source, `${file} 不应出现 refreshToken`).not.toContain('refreshToken')
    }
  })

  it('状态与诊断的返回 schema 只有白名单字段（无任何凭据）', () => {
    // 不用源码切片：`RemoteStatusFrame` 会误匹配 `RemoteStatus` 前缀，
    // 而字符串匹配对注释、换行、重排都敏感。直接检查 schema 的**字段集**，
    // 这才是 Renderer 实际能看到的形状。
    const statusKeys = Object.keys(remoteStatusSchema.shape)
    const diagnosisKeys = Object.keys(remoteDiagnosisSchema.shape)

    const allowed = new Set([
      'enabled',
      'linkState',
      'deviceId',
      'boundUserId',
      'needsReauth',
      'blockedReason',
      'serviceable',
      'unserviceableReason',
      'cloudOrigin',
      'lastPongAt',
      'lastError',
      'reconnectAttempt',
      'grants',
      'grantEpoch',
      'pendingRegistration',
      'pairingPhase',
      'auditStatus'
    ])

    for (const key of statusKeys) {
      expect(allowed.has(key), `状态契约多出字段：${key}`).toBe(true)
    }
    for (const key of diagnosisKeys) {
      // 诊断只允许多几个连接细节，且仍然不含凭据
      if (!allowed.has(key)) {
        expect(['socketOpen', 'inflight', 'cacheEntries', 'cacheBytes', 'lastCloseCode', 'lastCloseReason']).toContain(key)
      }
    }

    // 显式反向断言：任何凭据字段名都不应在字段集里
    for (const forbidden of ['device_token', 'deviceToken', 'claim_secret', 'claimSecret', 'privateKey', 'token']) {
      expect(statusKeys).not.toContain(forbidden)
      expect(diagnosisKeys).not.toContain(forbidden)
    }

    // 待确认信息同样只有展示字段：确认码是给人抄的六位数字，不是凭据
    // （它换不出 token）；claim_secret 与私钥不在其中。
    const pendingKeys = Object.keys(remotePendingRegistrationSchema.shape).sort()
    expect(pendingKeys).toEqual([
      'accountLabel',
      'confirmCode',
      'deviceId',
      'deviceName',
      'expiresAt',
      'platform'
    ])
  })

})
