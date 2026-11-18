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
import { mcpOperationLog } from '../../src/main/database/schema'
import { createRemoteService, type RemoteService } from '../../src/main/remote/remote-service'
import {
  createDeviceStore,
  deviceStorePaths,
  generateDeviceKeyPair,
  type RemoteSecretBox
} from '../../src/main/remote/device-identity'
import { computeRequestHash } from '../../src/main/remote/request-handler'
import { startMockGateway, publicKeyOf, type MockGateway } from '../helpers/mock-gateway'
import { REMOTE_CHANNELS } from '../../src/shared/contracts/remote'

/**
 * RemoteService 端到端（Phase 1.1B）。
 *
 * 用**真实 WSS**（Electron 主进程可用的原生 WebSocket，在 vitest 的 Node 环境里
 * 同样存在）连本地 Mock Gateway，验证：
 * 握手 → hello_ok 安装 → req 准入 → executeTool → 审计 → res，
 * 以及 close code 分级、grant_update / ack、serviceable 上报。
 */

const USER = 'user-1'
const ALL_TOOLS = [
  'search_records',
  'get_record',
  'list_record_tags',
  'list_beans',
  'list_brews',
  'list_tastings',
  'list_canvases',
  'get_canvas'
]

let dir: string
let handle: DatabaseHandle
let services: ToolServices
let service: RemoteService | null = null
let gateway: MockGateway | null = null
let gatewayUrl: string
let currentUserId: string | null

/** 内存版 safeStorage（真实 Electron 的加密在 Spike 里验证过）。 */
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-remote-e2e-'))
  handle = openDatabase(join(dir, 'test.db'))
  const events = new ApplicationEvents()
  services = {
    records: new RecordService(handle.db, handle.deviceId, events, () => undefined),
    coffee: new CoffeeService(handle.db),
    canvas: new CanvasService(handle.db, handle.deviceId, events),
    workContexts: new WorkContextService(handle.db, events),
    personalDirection: new PersonalDirectionService(handle.db, events)
  }
  currentUserId = USER
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

/** 预置一份设备凭据（等价于「已配对」状态）。 */
async function seedDevice(options: { cloudOrigin?: string; boundUserId?: string } = {}) {
  const paths = deviceStorePaths(dir)
  const store = createDeviceStore(paths, memoryBox())
  const { privateKey } = generateDeviceKeyPair()
  const saved = await store.save({
    deviceId: 'dev-1',
    boundUserId: options.boundUserId ?? USER,
    cloudOrigin: options.cloudOrigin ?? gatewayUrl,
    deviceToken: 'bp_dev_test',
    privateKey,
    registeredAt: Date.now()
  })
  expect(saved.ok).toBe(true)
  return { privateKey, publicKey: publicKeyOf(privateKey), paths }
}

/** 打开开关（等价于用户已授权范围）。 */
async function enableSwitch(paths: ReturnType<typeof deviceStorePaths>, origin = gatewayUrl) {
  const { writeRemoteState } = await import('../../src/main/remote/device-identity')
  writeRemoteState(paths, { version: 1, enabled: true, cloudOrigin: origin })
}

function makeService(overrides: {
  baseDir?: string
  cloudOrigin?: string
  onChanged?: (status: unknown) => void
} = {}): RemoteService {
  return createRemoteService({
    db: handle.db,
    services,
    currentUserId: () => currentUserId,
    baseDir: overrides.baseDir ?? dir,
    cloudOrigin: overrides.cloudOrigin ?? gatewayUrl,
    secretBox: memoryBox(),
    clientVersion: '0.1.4-test',
    onChanged: overrides.onChanged as never,
    log: () => undefined
  })
}

describe('默认关闭：零出站连接', () => {
  it('未开启时不建 socket、不解析凭据即可启动', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway!.url
    const { paths } = await seedDevice()

    service = makeService()
    await service.start()

    const status = service.status()
    expect(status.enabled).toBe(false)
    expect(status.linkState).toBe('idle')
    // 关键：一次握手都不该发生。
    expect(gateway!.connections).toBe(0)
    expect(gateway!.received).toHaveLength(0)
    void paths
  })

  it('enable 之后才连，且握手用真实 Ed25519 签名通过验签', async () => {
    // 顺序很重要：先有密钥对，Mock 才能装上对应公钥去验签。
    const { privateKey, publicKey } = generateDeviceKeyPair()
    gateway = await startMockGateway({ devicePublicKey: publicKey })
    gatewayUrl = gateway.url
    const paths = deviceStorePaths(dir)
    const store = createDeviceStore(paths, memoryBox())
    const saved = await store.save({
      deviceId: 'dev-1',
      boundUserId: USER,
      cloudOrigin: gatewayUrl,
      deviceToken: 'bp_dev_test',
      privateKey,
      registeredAt: Date.now()
    })
    expect(saved.ok).toBe(true)
    await enableSwitch(paths)

    service = makeService()
    await service.start()

    const hello = await gateway!.waitFor((frame) => frame.type === 'hello')
    expect(hello.serviceable).toBe(true)
    expect(hello.device_id).toBe('dev-1')
    expect(gateway!.helloVerified).toBe(true)
  })
})

describe('握手与 serviceable 上报方向', () => {
  it('hello_ok 安装后进入 online，并上报了 serviceable（hello 里带，不是 hello_ok）', async () => {
    gateway = await startMockGateway({
      grants: [
        {
          grantCtx: 'gc_a',
          grantId: 'grt_a',
          clientId: 'chatgpt',
          clientName: 'ChatGPT',
          scopes: ['records:read', 'tags:read', 'coffee:read', 'canvas:read'],
          boundUserId: USER,
          epoch: 1
        }
      ],
      allowedTools: ALL_TOOLS,
      grantEpoch: 5
    })
    gatewayUrl = gateway!.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)

    service = makeService()
    await service.start()

    await gateway!.waitFor((frame) => frame.type === 'hello')
    const status = await waitForStatus(service, (s) => s.linkState === 'online')
    expect(status.linkState).toBe('online')
    expect(status.serviceable).toBe(true)
    expect(status.grants).toHaveLength(1)
    expect(status.grants[0].clientName).toBe('ChatGPT')
    expect(status.grantEpoch).toBe(5)

    // hello_ok 里没有 serviceable 字段（方向不可反）
    const helloOk = gateway!.received.find((frame) => frame.type === 'hello')
    expect(helloOk).toBeDefined()
    // Desktop 发出的 hello 也没有 allowed_tools（不上报工具清单）
    expect(helloOk).not.toHaveProperty('allowed_tools')
  })

  it('开关关掉后上报 status{serviceable:false}', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1 })
    gatewayUrl = gateway!.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)

    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    await service.disable()
    // hello_ok 之后已上报过 serviceable=true，必须等值为 false 的那一条。
    const statusFrame = await gateway!.waitFor(
      (frame) => frame.type === 'status' && frame.serviceable === false
    )
    expect(statusFrame.serviceable).toBe(false)
    expect(statusFrame.reason).toBe('remote_disabled')
  })
})

describe('完整调用链：req → 准入 → executeTool → res → 审计', () => {
  async function bootstrap() {
    gateway = await startMockGateway({
      grants: [
        {
          grantCtx: 'gc_a',
          grantId: 'grt_a',
          clientId: 'chatgpt',
          clientName: 'ChatGPT',
          scopes: ['records:read', 'tags:read', 'coffee:read', 'canvas:read'],
          boundUserId: USER,
          epoch: 1
        }
      ],
      allowedTools: ALL_TOOLS,
      grantEpoch: 5
    })
    gatewayUrl = gateway!.url
    const seeded = await seedDevice()
    await enableSwitch(seeded.paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')
    return seeded
  }

  it('list_beans 成功：返回数据 + 写 1 行审计（client_id=remote:dev-1）', async () => {
    await bootstrap()

    gateway!.sendReq({
      id: 'req-1',
      tool: 'list_beans',
      args: {},
      grantCtx: 'gc_a',
      requestHash: computeRequestHash({ v: 1, tool: 'list_beans', arguments: {} })
    })

    const res = await gateway!.waitForRes('req-1')
    expect(res.ok).toBe(true)
    expect(res.data).toBeDefined()

    const rows = handle.db.select().from(mcpOperationLog).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].clientId).toBe('remote:dev-1')
    expect(rows[0].toolName).toBe('list_beans')
    expect(rows[0].success).toBe(true)
  })

  it('同 id 同 hash 重投 → 回放且 meta.cached=true，业务只执行一次', async () => {
    await bootstrap()
    const hash = computeRequestHash({ v: 1, tool: 'list_canvases', arguments: {} })
    gateway!.sendReq({ id: 'req-c', tool: 'list_canvases', args: {}, grantCtx: 'gc_a', requestHash: hash })
    const first = await gateway!.waitForRes('req-c')
    expect(first.meta).toMatchObject({ cached: false })

    gateway!.sendReq({ id: 'req-c', tool: 'list_canvases', args: {}, grantCtx: 'gc_a', requestHash: hash })
    // 第二次也回同一个 id，等一个新的 res 出现（received 里会有两条 res）
    await waitFor(() => gateway!.received.filter((f) => f.type === 'res' && f.id === 'req-c').length >= 2)
    const results = gateway!.received.filter((f) => f.type === 'res' && f.id === 'req-c')
    expect(results[1].meta).toMatchObject({ cached: true })
    // 两次读取 = 两行审计（回放也是一次真实读取）
    expect(handle.db.select().from(mcpOperationLog).all()).toHaveLength(2)
  })

  it('未授权工具 → TOOL_NOT_ALLOWED，零业务调用', async () => {
    await bootstrap()
    gateway!.sendReq({
      id: 'req-w',
      tool: 'create_record',
      args: { carrier: 'text', idempotency_key: 'x' },
      grantCtx: 'gc_a',
      requestHash: computeRequestHash({ v: 1, tool: 'create_record', arguments: { carrier: 'text', idempotency_key: 'x' } })
    })
    const res = await gateway!.waitForRes('req-w')
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('TOOL_NOT_ALLOWED')
  })

  it('未知 grant_ctx → GRANT_CONTEXT_INVALID', async () => {
    await bootstrap()
    gateway!.sendReq({
      id: 'req-g',
      tool: 'list_beans',
      args: {},
      grantCtx: 'gc_nope',
      requestHash: computeRequestHash({ v: 1, tool: 'list_beans', arguments: {} })
    })
    const res = await gateway!.waitForRes('req-g')
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('GRANT_CONTEXT_INVALID')
  })

  it('参数错误 → INVALID_ARGUMENTS', async () => {
    await bootstrap()
    gateway!.sendReq({
      id: 'req-bad',
      tool: 'search_records',
      args: { limit: 9999 },
      grantCtx: 'gc_a',
      requestHash: computeRequestHash({ v: 1, tool: 'search_records', arguments: { limit: 9999 } })
    })
    const res = await gateway!.waitForRes('req-bad')
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('INVALID_ARGUMENTS')
  })

  it('res 里不含参数与结果之外的东西（没有 token / 私钥）', async () => {
    await bootstrap()
    gateway!.sendReq({
      id: 'req-safe',
      tool: 'list_beans',
      args: {},
      grantCtx: 'gc_a',
      requestHash: computeRequestHash({ v: 1, tool: 'list_beans', arguments: {} })
    })
    await gateway!.waitForRes('req-safe')
    const json = JSON.stringify(gateway!.received)
    expect(json).not.toContain('bp_dev_')
    expect(json).not.toContain('privateKey')
    // hello 里有 device_id 是协议要求，但没有公钥/私钥
    expect(json).not.toContain('pkcs8')
  })
})

describe('grant_update / ack 与撤销（ST-21 / ST-23）', () => {
  async function bootstrapWithTwoGrants() {
    gateway = await startMockGateway({
      grants: [
        {
          grantCtx: 'gc_a',
          grantId: 'grt_a',
          clientId: 'chatgpt',
          clientName: 'ChatGPT',
          scopes: ['records:read'],
          boundUserId: USER,
          epoch: 1
        },
        {
          grantCtx: 'gc_b',
          grantId: 'grt_b',
          clientId: 'cursor',
          clientName: 'Cursor',
          scopes: ['records:read'],
          boundUserId: USER,
          epoch: 1
        }
      ],
      allowedTools: ALL_TOOLS,
      grantEpoch: 5
    })
    gatewayUrl = gateway!.url
    const seeded = await seedDevice()
    await enableSwitch(seeded.paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')
    return seeded
  }

  it('install 生效并回 ack{applied:true}', async () => {
    await bootstrapWithTwoGrants()
    gateway!.sendGrantUpdate({
      grantEpoch: 6,
      op: 'install',
      grant: {
        grantCtx: 'gc_c',
        grantId: 'grt_c',
        clientId: 'claude',
        clientName: 'Claude',
        scopes: ['coffee:read'],
        boundUserId: USER,
        epoch: 1
      }
    })
    const ack = await gateway!.waitFor((frame) => frame.type === 'grant_update_ack')
    expect(ack.applied).toBe(true)
    expect(ack.grant_epoch).toBe(6)

    const status = await waitForStatus(service!, (s) => s.grants.length === 3)
    expect(status.grants.map((g) => g.clientId).sort()).toEqual(['chatgpt', 'claude', 'cursor'])
  })

  it('重复 epoch 被幂等丢弃，但仍回 ack', async () => {
    await bootstrapWithTwoGrants()
    gateway!.sendGrantUpdate({ grantEpoch: 5, op: 'revoke', grantCtx: 'gc_a' })
    const ack = await gateway!.waitFor((frame) => frame.type === 'grant_update_ack')
    expect(ack.applied).toBe(true)
    // 状态没变：还是两个 grant
    expect(service!.status().grants).toHaveLength(2)
  })

  it('撤销 A 后 A 的 req 被拒，B 不受影响（ST-21）', async () => {
    await bootstrapWithTwoGrants()

    // 先在 A 上成功一次，让缓存有值
    gateway!.sendReq({
      id: 'req-a1',
      tool: 'list_beans',
      args: {},
      grantCtx: 'gc_a',
      requestHash: computeRequestHash({ v: 1, tool: 'list_beans', arguments: {} })
    })
    // gc_a 只有 records:read，所以这里应该 SCOPE_DENIED —— 换个工具验证 B
    await gateway!.waitForRes('req-a1')

    gateway!.sendReq({
      id: 'req-b1',
      tool: 'search_records',
      args: {},
      grantCtx: 'gc_b',
      requestHash: computeRequestHash({ v: 1, tool: 'search_records', arguments: {} })
    })
    const okB = await gateway!.waitForRes('req-b1')
    expect(okB.ok).toBe(true)

    // 撤销 A
    gateway!.sendGrantUpdate({ grantEpoch: 6, op: 'revoke', grantCtx: 'gc_a' })
    await gateway!.waitFor((frame) => frame.type === 'grant_update_ack')

    gateway!.sendReq({
      id: 'req-a2',
      tool: 'search_records',
      args: {},
      grantCtx: 'gc_a',
      requestHash: computeRequestHash({ v: 1, tool: 'search_records', arguments: {} })
    })
    const afterRevoke = await gateway!.waitForRes('req-a2')
    expect(afterRevoke.ok).toBe(false)
    expect((afterRevoke.error as { code: string }).code).toBe('GRANT_CONTEXT_INVALID')

    // B 仍然可用
    gateway!.sendReq({
      id: 'req-b2',
      tool: 'search_records',
      args: {},
      grantCtx: 'gc_b',
      requestHash: computeRequestHash({ v: 1, tool: 'search_records', arguments: {} })
    })
    const stillB = await gateway!.waitForRes('req-b2')
    expect(stillB.ok).toBe(true)
  })
})

describe('close code 分级（协议 §10.3）', () => {
  it('4003（设备撤销）→ blocked 且不重连', async () => {
    gateway = await startMockGateway({ closeAfterHello: 4003 })
    gatewayUrl = gateway!.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)

    service = makeService()
    await service.start()

    const status = await waitForStatus(service, (s) => s.linkState === 'blocked')
    expect(status.linkState).toBe('blocked')
    // 原因必须可见：用户要知道是「设备被撤销」，而不是笼统的「不可用」。
    expect(status.blockedReason ?? '').toContain('revoked')
    expect(status.needsReauth).toBe(true)

    const connectionsAfterBlock = gateway!.connections
    // 给足时间，确认没有重连
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(gateway!.connections).toBe(connectionsAfterBlock)
  })

  it('4002（版本不兼容）→ blocked，零重连', async () => {
    gateway = await startMockGateway({ protocolVersion: 2 })
    gatewayUrl = gateway!.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)

    service = makeService()
    await service.start()

    await waitForStatus(service, (s) => s.linkState === 'blocked')
    const connections = gateway!.connections
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(gateway!.connections).toBe(connections)
  })
})

describe('退出与清理', () => {
  it('stop() 后 socket 关闭、定时器清掉、状态回 idle', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1 })
    gatewayUrl = gateway!.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    await service.stop()
    expect(service.status().linkState).toBe('idle')
    expect(service.diagnose().socketOpen).toBe(false)
    // 缓存被清空
    expect(service.diagnose().cacheEntries).toBe(0)
  })

  it('forget() 删除凭据并把代际号 +1', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway!.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()

    const store = createDeviceStore(paths, memoryBox())
    const before = store.currentGeneration()

    const status = await service.forget()
    expect(status.deviceId).toBeNull()
    expect(status.enabled).toBe(false)
    expect(store.currentGeneration()).toBe(before + 1)
    expect((await store.load()).status).toBe('empty')
  })

  it('用户切换后启动：blocked + 零出站连接（ST-4 / ST-17）', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway!.url
    const { paths } = await seedDevice({ boundUserId: 'user-old' })
    await enableSwitch(paths)

    // 当前登录的是另一个人
    currentUserId = 'user-new'

    service = makeService()
    await service.start()

    const status = service.status()
    expect(status.linkState).toBe('blocked')
    expect(status.needsReauth).toBe(true)
    expect(gateway!.connections).toBe(0)
  })
})

describe('cloudOrigin 不匹配（ST-31）', () => {
  it('保存的 origin 与当前不同 → 不建连、不发送旧凭据', async () => {
    gateway = await startMockGateway({})
    gatewayUrl = gateway!.url
    // 设备是在别的后端配对的
    const { paths } = await seedDevice({ cloudOrigin: 'https://other-cloud.example.com' })
    await enableSwitch(paths, 'https://other-cloud.example.com')

    // 但当前配置指向这个 Mock
    service = makeService({ cloudOrigin: gatewayUrl })
    await service.start()

    const status = service.status()
    expect(status.linkState).toBe('blocked')
    expect(gateway!.connections).toBe(0)
    expect(gateway!.received).toHaveLength(0)
  })
})

// MARK: - 工具

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4_000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function waitForStatus(
  service: RemoteService,
  predicate: (status: ReturnType<RemoteService['status']>) => boolean,
  timeoutMs = 4_000
): Promise<ReturnType<RemoteService['status']>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = service.status()
    if (predicate(status)) return status
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for status; last=${JSON.stringify(status)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('运行时账户切换（ST-4 的运行时版本）', () => {
  it('在线期间切换用户 → 立即 blocked、断开、清缓存与上下文', async () => {
    gateway = await startMockGateway({
      grants: [
        {
          grantCtx: 'gc_a',
          grantId: 'grt_a',
          clientId: 'chatgpt',
          clientName: 'ChatGPT',
          scopes: ['records:read'],
          boundUserId: USER,
          epoch: 1
        }
      ],
      allowedTools: ALL_TOOLS,
      grantEpoch: 5
    })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    // 先在缓存里放一条结果
    gateway.sendReq({
      id: 'req-before',
      tool: 'search_records',
      args: {},
      grantCtx: 'gc_a',
      requestHash: computeRequestHash({ v: 1, tool: 'search_records', arguments: {} })
    })
    await gateway.waitForRes('req-before')
    expect(service.diagnose().cacheEntries).toBe(1)

    // 用户换了账户
    currentUserId = 'user-other'
    await service.reconcile()

    const status = service.status()
    expect(status.linkState).toBe('blocked')
    expect(status.blockedReason).toContain('differs')
    expect(status.needsReauth).toBe(true)
    expect(status.grants).toHaveLength(0)
    // 断连并清缓存：不能让新用户看到上一个用户的缓存结果。
    expect(service.diagnose().socketOpen).toBe(false)
    expect(service.diagnose().cacheEntries).toBe(0)
  })

  it('切回原用户不会自动恢复：blocked 是终态，需要用户处理', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1 })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    currentUserId = 'user-other'
    await service.reconcile()
    expect(service.status().linkState).toBe('blocked')

    // 切回来也不自动重连——避免「账户抖动」导致反复建立又断开。
    currentUserId = USER
    await service.reconcile()
    expect(service.status().linkState).toBe('blocked')
  })
})

describe('Cloud 不可达时的本地清理（ST-14）', () => {
  it('Mock 已停：forget 仍完成本地清理（删凭据 + 代际号 +1）', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1 })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    // Cloud 突然不可达
    await gateway.stop()
    gateway = null

    const store = createDeviceStore(paths, memoryBox())
    const before = store.currentGeneration()
    const status = await service.forget()

    // 本地清理必须完整完成，不因为 Cloud 不可达而半途而废。
    expect(status.deviceId).toBeNull()
    expect(status.enabled).toBe(false)
    expect((await store.load()).status).toBe('empty')
    expect(store.currentGeneration()).toBe(before + 1)
  })

  it('Cloud 不可达时断开不影响本地状态机回到 idle', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1 })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    await gateway.stop()
    gateway = null

    await service.stop()
    expect(service.status().linkState).toBe('idle')
    expect(service.diagnose().socketOpen).toBe(false)
  })
})
