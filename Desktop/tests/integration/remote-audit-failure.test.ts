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
  generateDeviceKeyPair,
  writeRemoteState,
  type RemoteSecretBox
} from '../../src/main/remote/device-identity'
import { computeRequestHash, writeRemoteAudit } from '../../src/main/remote/request-handler'
import { startMockGateway, MOCK_DEVICE_TOKEN, type MockGateway } from '../helpers/mock-gateway'
import { testWebSocketFactory } from '../helpers/ws-client'
import type { Db } from '../../src/main/database/client'

/**
 * Remote 审计的**真实失败**路径（P1）。
 *
 * 旧实现里 `writeAudit()` 自己 catch 掉数据库异常，于是 `writeRemoteAudit()`
 * 永远返回成功，`consecutiveFailures` 永远是 0——设置页那条「最近 N 次未能写入
 * 审计」的告警是个摆设。
 *
 * 所以这里不注入「抛异常的假 audit 回调」（那只测了调用方的 try/catch），
 * 而是**真的把表删掉**，让 SQLite 报错，再看：
 *
 * 1. 业务结果是否仍然正确（`res.ok === true`）；
 * 2. 计数器是否真的涨了；
 * 3. 日志里有没有泄漏数据库路径、SQL、参数。
 */

const USER = 'user-a'
const SENTINEL = 'sentinel-title-should-never-be-logged'

let dir = ''
let handle: DatabaseHandle
let services: ToolServices
let gateway: MockGateway | null = null
let gatewayUrl = ''
let service: RemoteService | null = null
let logs: string[] = []

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
  dir = mkdtempSync(join(tmpdir(), 'brewphase-remote-audit-'))
  handle = openDatabase(join(dir, 'test.db'))
  const events = new ApplicationEvents()
  services = {
    records: new RecordService(handle.db, handle.deviceId, events, () => undefined),
    coffee: new CoffeeService(handle.db),
    canvas: new CanvasService(handle.db, handle.deviceId, events),
    workContexts: new WorkContextService(handle.db, events),
    personalDirection: new PersonalDirectionService(handle.db, events)
  }
  logs = []
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

async function boot(): Promise<void> {
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
    allowedTools: ['search_records'],
    grantEpoch: 5
  })
  gatewayUrl = gateway.url

  const paths = deviceStorePaths(dir)
  const store = createDeviceStore(paths, memoryBox())
  const { privateKey, publicKey } = generateDeviceKeyPair()
  await store.save({
    deviceId: 'dev-1',
    boundUserId: USER,
    cloudOrigin: gatewayUrl,
    deviceToken: MOCK_DEVICE_TOKEN,
    privateKey,
    registeredAt: Date.now()
  })
  gateway.trustDevicePublicKey(publicKey)
  writeRemoteState(paths, { version: 1, enabled: true, cloudOrigin: gatewayUrl })

  service = createRemoteService({
    db: handle.db,
    services,
    currentUserId: () => USER,
    baseDir: dir,
    cloudOrigin: gatewayUrl,
    secretBox: memoryBox(),
    webSocketFactory: testWebSocketFactory,
    clientVersion: '0.1.5-test',
    onChanged: () => undefined,
    log: (line) => logs.push(line)
  })
  await service.start()
  await waitFor(() => service!.status().linkState === 'online')
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function requestArguments(): Record<string, unknown> {
  return { query: SENTINEL }
}

describe('真实数据库写入失败', () => {
  it('审计表被删：业务仍成功、res.ok 为 true、失败计数增加、日志不泄漏', async () => {
    await boot()

    // 真的让写入失败：把审计表删掉（等价于磁盘/权限/损坏导致的 SQLITE_ERROR）。
    handle.sqlite.exec('DROP TABLE mcp_operation_log')

    const args = requestArguments()
    gateway!.sendReq({
      id: 'req-1',
      tool: 'search_records',
      args,
      grantCtx: 'gc_a',
      requestHash: computeRequestHash({ v: 1, tool: 'search_records', arguments: args })
    })

    const res = await gateway!.waitForRes('req-1')
    // 业务结果不受影响。
    expect(res.ok).toBe(true)

    const status = service!.status()
    expect(status.auditStatus.consecutiveFailures).toBe(1)
    expect(status.auditStatus.totalFailures).toBe(1)
    expect(status.auditStatus.lastFailureAt).not.toBeNull()

    const joined = logs.join('\n')
    // 只报「失败了几次」，不报 SQL、路径、堆栈、参数。
    expect(joined).toContain('audit write failed')
    expect(joined).not.toContain('mcp_operation_log')
    expect(joined).not.toContain('SQLITE')
    expect(joined).not.toContain('.db')
    expect(joined).not.toContain(SENTINEL)
    expect(joined).not.toContain('bp_dev_')
  })

  it('第二次仍然失败时 consecutiveFailures 继续累加', async () => {
    await boot()
    handle.sqlite.exec('DROP TABLE mcp_operation_log')

    for (const id of ['req-a', 'req-b']) {
      const args = { query: 'q' }
      gateway!.sendReq({
        id,
        tool: 'search_records',
        args,
        grantCtx: 'gc_a',
        requestHash: computeRequestHash({ v: 1, tool: 'search_records', arguments: args })
      })
      await gateway!.waitForRes(id)
    }

    expect(service!.status().auditStatus.consecutiveFailures).toBe(2)
    expect(service!.status().auditStatus.totalFailures).toBe(2)
  })
})

describe('底层写入函数区分成功与失败', () => {
  it('表存在 → true；表被删 → false（不抛错）', () => {
    const db = handle.db
    const entry = { toolName: 'search_records', success: true, errorCode: null }
    expect(writeRemoteAudit(db, 'dev-1', entry)).toBe(true)

    handle.sqlite.exec('DROP TABLE mcp_operation_log')
    expect(writeRemoteAudit(db, 'dev-1', entry)).toBe(false)
  })

  it('一次成功会把 consecutiveFailures 归零', () => {
    // 用代理 db 精确控制「先失败一次、再成功一次」，避免依赖建/删表的时序。
    let failNext = 1
    const flaky = {
      insert: (...args: unknown[]) => {
        if (failNext-- > 0) throw new Error('SQLITE_IOERR: disk I/O error at /Users/x/brewphase.db')
        return (handle.db.insert as unknown as (...inner: unknown[]) => unknown)(...args)
      }
    } as unknown as Db

    const entry = { toolName: 'search_records', success: true, errorCode: null }
    expect(writeRemoteAudit(flaky, 'dev-1', entry)).toBe(false)
    expect(writeRemoteAudit(flaky, 'dev-1', entry)).toBe(true)
  })
})
