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
import { startMockGateway, publicKeyOf, MOCK_DEVICE_TOKEN, type MockGateway } from '../helpers/mock-gateway'
import { testWebSocketFactory, type TestWebSocket } from '../helpers/ws-client'
import type { WebSocketFactory } from '../../src/main/remote/link-client'
import { buildStatus, createLinkState } from '../../src/main/remote/link-state'
import { REMOTE_CHANNELS, type RemoteGrant } from '../../src/shared/contracts/remote'

/**
 * RemoteService 端到端（Phase 1.1B）。
 *
 * 用**真实 WSS**（`tests/helpers/ws-client.ts` 提供的最小客户端：真发
 * `Authorization` 头、真掩码、真关闭握手）连本地 Mock Gateway，验证：
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

/** 一个标准的「ChatGPT 有 records:read」授权，多个用例共用。 */
const GRANT_A = {
  grantCtx: 'gc_a',
  grantId: 'grt_a',
  clientId: 'chatgpt',
  clientName: 'ChatGPT',
  scopes: ['records:read'] as RemoteGrant['scopes'],
  boundUserId: USER,
  epoch: 1
}

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
    deviceToken: MOCK_DEVICE_TOKEN,
    privateKey,
    registeredAt: Date.now()
  })
  expect(saved.ok).toBe(true)
  const publicKey = publicKeyOf(privateKey)
  // Mock 侧要拿到公钥才能验签（等价于 Cloud 注册时存下 public_key）。
  gateway?.trustDevicePublicKey(publicKey)
  return { privateKey, publicKey, paths }
}

/** 等 diagnose() 的某个字段满足条件（`lastCloseCode` 不在 status 里）。 */
async function waitForDiagnosis(
  target: RemoteService,
  predicate: (diagnosis: ReturnType<RemoteService['diagnose']>) => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate(target.diagnose())) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for diagnosis; last=${JSON.stringify(target.diagnose())}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
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
  /**
   * 覆盖 WebSocket 工厂（Phase 1.3.3-A-R1）。
   *
   * `lastError` 的来源之一是 `onError`，而它只能由真实的 socket 事件驱动。
   * 注入一个「先失败、后成功」的工厂，才能在同一个 service 实例上验证
   * 「错误被保留 → 握手成功后被清除」这条完整链路，而不是靠两个实例各自
   * 起始为 null 来假装测过。
   */
  webSocketFactory?: WebSocketFactory
} = {}): RemoteService {
  return createRemoteService({
    db: handle.db,
    services,
    currentUserId: () => currentUserId,
    baseDir: overrides.baseDir ?? dir,
    cloudOrigin: overrides.cloudOrigin ?? gatewayUrl,
    secretBox: memoryBox(),
    // 测试环境没有 electron.net，而带 Authorization 头的连接必须有人真的把头发出去。
    // 这个工厂是一个最小 WS 客户端（真发头、真掩码、真关闭握手）。
    webSocketFactory: overrides.webSocketFactory ?? testWebSocketFactory,
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
      deviceToken: MOCK_DEVICE_TOKEN,
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

describe('心跳看门狗（不能等第一条 ping）', () => {
  it('握手成功但 Cloud 从不发 ping → 到 idle_timeout 主动关闭 4008', async () => {
    // idle_timeout 设得很小；看门狗本身最快 1s 检查一次。
    gateway = await startMockGateway({
      allowedTools: ALL_TOOLS,
      grantEpoch: 1,
      heartbeatMs: 200,
      idleTimeoutMs: 150
    })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()

    await waitForStatus(service, (s) => s.linkState === 'online')
    // 一次 ping 都不发（模拟 NAT 半开 / LB 掉表）。
    // 注意 lastCloseCode / lastCloseReason 只在 diagnose() 里，status() 不含它们。
    await waitForDiagnosis(service, (d) => d.lastCloseCode === 4008, 6_000)
    expect(service.diagnose().lastCloseReason).toContain('heartbeat')
  })

  it('收到 ping 就会续命（不会误判超时）', async () => {
    gateway = await startMockGateway({
      allowedTools: ALL_TOOLS,
      grantEpoch: 1,
      heartbeatMs: 200,
      idleTimeoutMs: 400
    })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    for (let i = 0; i < 5; i += 1) {
      gateway.sendPing(i + 1)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    // 5 × 300ms > 400ms 的 idle_timeout，一直有 ping 就不该断。
    expect(service.diagnose().lastCloseCode).toBeNull()
    expect(service.status().linkState).toBe('online')
  })
})

describe('draining', () => {
  it('收到 drain 后拒绝新 req（DEVICE_BUSY），且不执行、不审计', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1 })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    let calls = 0
    const original = services.records.searchForMcp
    services.records.searchForMcp = ((input) => {
      calls += 1
      return original(input)
    }) as typeof services.records.searchForMcp
    try {
      gateway.sendDrain(0)
      await waitForStatus(service, (s) => s.linkState === 'draining')

      const args = {}
      gateway.sendReq({
        id: 'req-drain',
        tool: 'search_records',
        args,
        grantCtx: 'gc_a',
        requestHash: computeRequestHash({ v: 1, tool: 'search_records', arguments: args })
      })
      const res = await gateway.waitForRes('req-drain')
      expect(res.ok).toBe(false)
      expect((res.error as { code: string }).code).toBe('DEVICE_BUSY')
      expect(calls).toBe(0)
    } finally {
      services.records.searchForMcp = original
    }
  })
})

describe('连接尝试的代际隔离', () => {
  it('快速 disable → enable 只保留一条连接，且状态收敛到 online', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1 })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    // 连开三次又关：每次都会让上一次的握手尝试失效。
    await service.disable()
    const p1 = service.enable()
    await service.disable()
    const p2 = service.enable()
    await Promise.all([p1, p2])

    await waitForStatus(service, (s) => s.linkState === 'online')
    expect(service.diagnose().socketOpen).toBe(true)
    // 只有最后一次尝试留下了连接；旧尝试既没发 hello，也没把新 socket 关掉。
    const hellos = gateway.received.filter((frame) => frame.type === 'hello')
    expect(hellos.length).toBe(gateway.connections)
  })
})

describe('帧上限协商（Cloud 只能收紧）', () => {
  it('超过 Cloud 下发的 max_frame_bytes → close 4009，且不进业务层', async () => {
    gateway = await startMockGateway({
      allowedTools: ALL_TOOLS,
      grantEpoch: 1,
      // 让 Cloud 声明一个很小的上限，验证它真的生效。
      maxFrameBytes: 512
    })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    // 一条 1 KiB 的帧（远超 512）——用未知 type，确保「即使认识也不会执行」。
    gateway.send({ v: 1, type: 'noise', blob: 'a'.repeat(1024) })
    await waitForDiagnosis(service, (d) => d.lastCloseCode === 4009, 5_000)
    expect(service.diagnose().lastCloseReason).toContain('frame too large')
  })
})

describe('畸形帧：协议 §2.2 要求「必须回话」', () => {
  it('req 带未知键 → PROTOCOL_VIOLATION，不执行、不写缓存、不改授权状态', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1, grants: [GRANT_A] })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    let calls = 0
    const original = services.records.searchForMcp
    services.records.searchForMcp = ((input) => {
      calls += 1
      return original(input)
    }) as typeof services.records.searchForMcp
    try {
      // 未知键 `surprise`：闭合键集必须拒绝。
      gateway.send({
        v: 1,
        type: 'req',
        id: 'req-bad-key',
        ts: Date.now(),
        tool: 'search_records',
        arguments: {},
        request_hash: computeRequestHash({ v: 1, tool: 'search_records', arguments: {} }),
        deadline_ms: Date.now() + 10_000,
        grant_ctx: 'gc_a',
        surprise: true
      })

      const res = await gateway.waitForRes('req-bad-key')
      expect(res.ok).toBe(false)
      expect((res.error as { code: string }).code).toBe('PROTOCOL_VIOLATION')
      expect((res.error as { retryable: boolean }).retryable).toBe(false)
      // 一个字节的业务代码都没跑，缓存也没被污染。
      expect(calls).toBe(0)
      expect(service.diagnose().cacheEntries).toBe(0)
      // 授权状态原封不动，连接还活着。
      expect(service.status().grants).toHaveLength(1)
      expect(service.status().linkState).toBe('online')
      // 这是一次「篡改载荷」形态的安全事件，要留一行审计（工具名可信时才记）。
      const rows = handle.db.select().from(mcpOperationLog).all()
      expect(rows).toHaveLength(1)
      expect(rows[0].toolName).toBe('search_records')
      expect(rows[0].success).toBe(false)
      expect(rows[0].errorCode).toBe('PROTOCOL_VIOLATION')
    } finally {
      services.records.searchForMcp = original
    }
  })

  it('非 JSON 帧但能从原文提取 id → 也回 PROTOCOL_VIOLATION（不静默丢弃）', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1, grants: [GRANT_A] })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    // 故意截断 JSON：id 可读，但整段不是合法 JSON。
    gateway.sendText('{"v":1,"type":"req","id":"req-truncated","tool":"search_records","arguments":{"a":')
    const res = await gateway.waitForRes('req-truncated')
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('PROTOCOL_VIOLATION')
    // 回话而不是断连：Cloud 能立刻知道「帧坏了」，不用等到 deadline。
    expect(service.status().linkState).toBe('online')
    // 这条路径连 tool 都没解析出来（原文不可信），所以不写审计——
    // 宁可少一行，也不用不可信的工具名污染审计表。
    expect(handle.db.select().from(mcpOperationLog).all()).toHaveLength(0)
  })

  it('业务参数里恰好有 id 字段时，不会被当成投递 id（不误回话）', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1, grants: [GRANT_A] })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')

    // 这段文本的 type 不是 req（是 noise），且 id 在 arguments 之后。
    // 两重判据都要求它「看起来不是 req」→ 不回话，按无法识别处理。
    gateway.sendText('{"v":1,"type":"noise","arguments":{"id":"should-not-be-used"}}')
    // 等一小会儿，确认没有 res 发出。
    await new Promise((resolve) => setTimeout(resolve, 300))
    const res = gateway.received.filter((frame) => frame.type === 'res')
    expect(res).toHaveLength(0)
  })

  it('grant_update 带未知键 → ack applied=false，且不触发 Cloud 的 ack 超时', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1, grants: [GRANT_A] })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()
    await waitForStatus(service, (s) => s.linkState === 'online')
    // 先制造一条缓存，用来验证「被拒绝的 revoke 不会误清别人的缓存」。
    const cachedArgs = {}
    gateway.sendReq({
      id: 'req-cache',
      tool: 'search_records',
      args: cachedArgs,
      grantCtx: 'gc_a',
      requestHash: computeRequestHash({ v: 1, tool: 'search_records', arguments: cachedArgs })
    })
    await gateway.waitForRes('req-cache')
    expect(service.diagnose().cacheEntries).toBe(1)

    const before = service.status().grantEpoch

    gateway.send({
      v: 1,
      type: 'grant_update',
      ts: Date.now(),
      grant_epoch: 9,
      op: 'revoke',
      grant_ctx: 'gc_a',
      unexpected: 'boom'
    })

    const ack = await gateway.waitFor((frame) => frame.type === 'grant_update_ack')
    expect(ack.applied).toBe(false)
    expect(ack.reason).toBe('protocol_violation')
    expect(ack.grant_epoch).toBe(9)

    // 状态一点没变：epoch 不动、grant 还在。
    expect(service.status().grantEpoch).toBe(before)
    expect(service.status().grants).toHaveLength(1)
    // 而且**这个 grant 的缓存不能被清**：它宣称是 revoke，但我们拒绝了。
    // 若误清，下一次同 id 重投会重新执行一次（只读无害但属白做），
    // 更重要的是这说明「拒绝」与「执行」被混在了一起。
    expect(service.diagnose().cacheEntries).toBe(1)
  })

  it('hello_ok 形状非法 → close 4009（不是 4002）', async () => {
    // 让 Mock 回一个缺字段的 hello_ok。
    gateway = await startMockGateway({
      allowedTools: ALL_TOOLS,
      grantEpoch: 1,
      malformedHelloOk: true
    })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)
    service = makeService()
    await service.start()

    await waitForDiagnosis(service, (d) => d.lastCloseCode === 4009, 5_000)
    expect(service.diagnose().lastCloseReason).toContain('shape invalid')
    expect(service.status().linkState).not.toBe('online')
  })
})

// MARK: - lastError 生命周期（Phase 1.3.3-A-R1）

/**
 * 造一个「立刻失败」的 socket 替身。
 *
 * 真实的连接失败在 Electron `net.WebSocket` 上表现为 `onerror` + `onclose(1006)`；
 * 这里复刻这个顺序，而不是只调 `onerror`——只调 `onerror` 会漏掉
 * `onClose → scheduleReconnect` 这条真正决定「还会不会重试」的路径，
 * 于是测出来的行为与真实断连不一致。
 */
function makeFailingSocket(reason: string): TestWebSocket {
  const socket: TestWebSocket = {
    readyState: 0,
    protocol: '',
    send: () => undefined,
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null
  }
  queueMicrotask(() => {
    socket.onerror?.({})
    socket.readyState = 3
    socket.onclose?.({ code: 1006, reason, wasClean: false })
  })
  return socket
}

/** 前 `failCount` 次连接失败，之后委托给真实测试客户端。 */
function flakyFactory(failCount: number, reason: string): WebSocketFactory {
  let attempts = 0
  return (url, options) => {
    attempts += 1
    if (attempts <= failCount) return makeFailingSocket(reason)
    return testWebSocketFactory(url, options)
  }
}

describe('lastError 生命周期（R1 可观测性）', () => {
  it('onError 后 lastError 进入 RemoteStatus，并经 onChanged 广播给渲染进程', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1 })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)

    // 永远失败：错误必须**停在**状态里，不会被随后的成功握手清掉。
    const broadcast: Array<{ lastError: string | null; linkState: string }> = []
    service = makeService({
      webSocketFactory: () => makeFailingSocket('connection refused'),
      onChanged: (s) => {
        const status = s as { lastError: string | null; linkState: string }
        broadcast.push({ lastError: status.lastError, linkState: status.linkState })
      }
    })
    await service.start()

    const status = await waitForStatus(service, (s) => s.lastError !== null)
    // 这是 transport 的固定文案（link-client.ts 的 `events.onError('websocket error')`）。
    expect(status.lastError).toBe('websocket error')

    // 必须真的广播出去了：只写进主进程状态、不 publish 的话，设置页永远看不到。
    expect(broadcast.some((b) => b.lastError === 'websocket error')).toBe(true)

    // 错误不是只出现一瞬：退避期间仍然可读（用户正是在这个窗口里需要看到它）。
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(service.status().lastError).toBe('websocket error')
    expect(service.diagnose().lastError).toBe('websocket error')

    await service.stop()
  })

  it('先失败后成功：错误被保留，握手成功后被清空', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1 })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)

    service = makeService({ webSocketFactory: flakyFactory(1, 'flaky first attempt') })
    await service.start()

    // 1) 第一次连接失败 → 错误可见
    const failed = await waitForStatus(service, (s) => s.lastError !== null)
    expect(failed.lastError).toBe('websocket error')
    expect(failed.linkState).not.toBe('online')

    // 2) 退避（首档 500–1000ms）后重连成功 → 错误必须被 hello_ok 清掉
    const recovered = await waitForStatus(
      service,
      (s) => s.linkState === 'online' && s.lastError === null,
      8_000
    )
    expect(recovered.lastError).toBeNull()
    expect(recovered.linkState).toBe('online')

    // 诊断页同步（不是只有 status 清了、diagnosis 还留着旧值）
    expect(service.diagnose().lastError).toBeNull()

    await service.stop()
  })

  it('旧 socket 迟到的 onerror 不会覆盖新连接的状态', async () => {
    gateway = await startMockGateway({ allowedTools: ALL_TOOLS, grantEpoch: 1 })
    gatewayUrl = gateway.url
    const { paths } = await seedDevice()
    await enableSwitch(paths)

    // 第一次失败、第二次成功；失败的 onerror 必须因代际不符被丢弃，
    // 否则它会把已经 online 的新连接状态盖成「有错」。
    service = makeService({ webSocketFactory: flakyFactory(1, 'stale socket') })
    await service.start()

    const online = await waitForStatus(
      service,
      (s) => s.linkState === 'online' && s.lastError === null,
      8_000
    )
    expect(online.linkState).toBe('online')

    // 再等一个退避窗口，确认没有迟到的错误把状态改回去。
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const settled = service.status()
    expect(settled.linkState).toBe('online')
    expect(settled.lastError).toBeNull()

    await service.stop()
  })

  it('buildStatus 把 link.lastError 原样带进 RemoteStatus（不加工、不截断）', () => {
    const link = createLinkState()
    link.lastError = 'websocket error'
    const status = buildStatus({
      link,
      enabled: true,
      deviceId: 'dev-1',
      boundUserId: USER,
      needsReauth: false,
      cloudOrigin: 'http://127.0.0.1:3000',
      verdict: { serviceable: true, reason: null },
      grants: [],
      grantEpoch: 0,
      audit: { consecutiveFailures: 0, totalFailures: 0, lastFailureAt: null }
    })
    expect(status.lastError).toBe('websocket error')

    link.lastError = null
    expect(
      buildStatus({
        link,
        enabled: true,
        deviceId: 'dev-1',
        boundUserId: USER,
        needsReauth: false,
        cloudOrigin: 'http://127.0.0.1:3000',
        verdict: { serviceable: true, reason: null },
        grants: [],
        grantEpoch: 0,
        audit: { consecutiveFailures: 0, totalFailures: 0, lastFailureAt: null }
      }).lastError
    ).toBeNull()
  })
})
