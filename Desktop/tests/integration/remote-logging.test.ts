import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { RecordService } from '../../src/main/application/records/record-service'
import { CoffeeService } from '../../src/main/application/coffee/coffee-service'
import { CanvasService } from '../../src/main/application/canvas/canvas-service'
import { WorkContextService } from '../../src/main/application/work-context/work-context-service'
import { PersonalDirectionService } from '../../src/main/application/personal-direction/personal-direction-service'
import { mcpOperationLog } from '../../src/main/database/schema'
import { createRequestHandler, computeRequestHash, writeRemoteAudit } from '../../src/main/remote/request-handler'
import { createResultCache } from '../../src/main/remote/result-cache'
import { applyHelloOk, emptyGrantContext } from '../../src/main/remote/grant-context'
import { makeHelloOk } from '../helpers/mock-gateway'
import type { RemoteReq } from '../../src/shared/contracts/remote'

/**
 * 日志与审计的哨兵测试（安全运维 §6.5.4.1 / ST-34 的 Remote 部分）。
 *
 * 参考实现在 `device.ts:749` / `:807` 直接把 `tool_args` 与 `result` 打到终端，
 * 这类行为**绝不能**复制过来。这里用哨兵字符串检查三个面：
 *
 * 1. `mcp_operation_log` 表
 * 2. stdout / stderr（console.*）
 * 3. 抛出的错误对象
 */

const SENTINEL = 'SENTINEL-7f3a9c-Remote'

let dir: string
let handle: DatabaseHandle

afterEach(() => {
  handle?.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function bootstrap() {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-remote-log-'))
  handle = openDatabase(join(dir, 'test.db'))
  const events = new ApplicationEvents()
  const services = {
    records: new RecordService(handle.db, handle.deviceId, events, () => undefined),
    coffee: new CoffeeService(handle.db),
    canvas: new CanvasService(handle.db, handle.deviceId, events),
    workContexts: new WorkContextService(handle.db, events),
    personalDirection: new PersonalDirectionService(handle.db, events)
  }
  const grantState = emptyGrantContext()
  applyHelloOk(grantState, makeHelloOk({ grant_epoch: 1, allowed_tools: ['search_records'], grants: [] }))
  return { services, grantState }
}

describe('审计与日志不含参数/结果/凭据', () => {
  it('业务参数与结果都不进审计表', () => {
    const { services, grantState } = bootstrap()
    // 先建一条含哨兵的记录，再通过工具读它
    const record = services.records.createForMcp({ carrier: 'text', title: SENTINEL, note: SENTINEL })
    const cache = createResultCache()

    const req: RemoteReq = {
      v: 1,
      type: 'req',
      id: 'req-1',
      ts: Date.now(),
      tool: 'get_record',
      arguments: { record_id: record.id },
      request_hash: computeRequestHash({ v: 1, tool: 'get_record', arguments: { record_id: record.id } }),
      deadline_ms: Date.now() + 10_000,
      grant_ctx: 'gc_a'
    }

    // 让 get_record 可用
    applyHelloOk(
      grantState,
      makeHelloOk({
        grant_epoch: 2,
        allowed_tools: ['get_record'],
        grants: [
          {
            grant_ctx: 'gc_a',
            grant_id: 'g',
            client_id: 'chatgpt',
            client_name: 'ChatGPT',
            scopes: ['records:read'],
            bound_user_id: 'user-1',
            epoch: 1
          }
        ]
      })
    )

    const handler = createRequestHandler({
      db: handle.db,
      services,
      cache,
      isEnabled: () => true,
      isDraining: () => false,
      boundUserId: () => 'user-1',
      deviceId: () => 'dev-1',
      grants: () => grantState,
      nowMono: () => performance.now(),
      nowEpoch: () => Date.now(),
      isGrantRevoked: () => false,
      audit: (entry) => {
        writeRemoteAudit(handle.db, 'dev-1', entry)
      }
    })

    const outcome = handler(req)
    expect(outcome.res.ok).toBe(true)
    // 结果里当然有哨兵（那是给 AI 的数据）
    expect(JSON.stringify(outcome.res.data)).toContain(SENTINEL)

    // 但审计表里不能有。
    const auditJson = JSON.stringify(handle.db.select().from(mcpOperationLog).all())
    expect(auditJson).not.toContain(SENTINEL)
    expect(auditJson).not.toContain('bp_dev_')
    expect(auditJson).not.toContain('bp_mcp_')
  })

  it('执行期间 console 输出不含参数与结果', () => {
    const { services, grantState } = bootstrap()
    const cache = createResultCache()

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    applyHelloOk(
      grantState,
      makeHelloOk({
        grant_epoch: 2,
        allowed_tools: ['search_records'],
        grants: [
          {
            grant_ctx: 'gc_a',
            grant_id: 'g',
            client_id: 'chatgpt',
            client_name: 'ChatGPT',
            scopes: ['records:read'],
            bound_user_id: 'user-1',
            epoch: 1
          }
        ]
      })
    )

    const handler = createRequestHandler({
      db: handle.db,
      services,
      cache,
      isEnabled: () => true,
      isDraining: () => false,
      boundUserId: () => 'user-1',
      deviceId: () => 'dev-1',
      grants: () => grantState,
      nowMono: () => performance.now(),
      nowEpoch: () => Date.now(),
      isGrantRevoked: () => false,
      audit: () => undefined
    })

    // 参数里带哨兵
    handler({
      v: 1,
      type: 'req',
      id: 'req-1',
      ts: Date.now(),
      tool: 'search_records',
      arguments: { search: SENTINEL },
      request_hash: computeRequestHash({ v: 1, tool: 'search_records', arguments: { search: SENTINEL } }),
      deadline_ms: Date.now() + 10_000,
      grant_ctx: 'gc_a'
    })

    const allOutput = [logSpy, warnSpy, errorSpy, debugSpy]
      .flatMap((spy) => spy.mock.calls)
      .map((call) => call.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
      .join('\n')

    expect(allOutput).not.toContain(SENTINEL)
  })

  it('错误信息不含参数（只有业务错误才透传 message）', () => {
    const { services, grantState } = bootstrap()
    const cache = createResultCache()
    applyHelloOk(
      grantState,
      makeHelloOk({
        grant_epoch: 2,
        allowed_tools: ['get_record'],
        grants: [
          {
            grant_ctx: 'gc_a',
            grant_id: 'g',
            client_id: 'chatgpt',
            client_name: 'ChatGPT',
            scopes: ['records:read'],
            bound_user_id: 'user-1',
            epoch: 1
          }
        ]
      })
    )

    const handler = createRequestHandler({
      db: handle.db,
      services,
      cache,
      isEnabled: () => true,
      isDraining: () => false,
      boundUserId: () => 'user-1',
      deviceId: () => 'dev-1',
      grants: () => grantState,
      nowMono: () => performance.now(),
      nowEpoch: () => Date.now(),
      isGrantRevoked: () => false,
      audit: () => undefined
    })

    // 非法 UUID：Zod 的 message 只描述字段，不回显原值以外的东西。
    const outcome = handler({
      v: 1,
      type: 'req',
      id: 'req-bad',
      ts: Date.now(),
      tool: 'get_record',
      arguments: { record_id: 'not-a-uuid' },
      request_hash: computeRequestHash({ v: 1, tool: 'get_record', arguments: { record_id: 'not-a-uuid' } }),
      deadline_ms: Date.now() + 10_000,
      grant_ctx: 'gc_a'
    })

    expect(outcome.res.ok).toBe(false)
    if (!outcome.res.ok) {
      // 不外泄堆栈 / 路径 / SQL
      expect(outcome.res.error?.message).not.toContain('/Users')
      expect(outcome.res.error?.message).not.toContain('.db')
      expect(outcome.res.error?.message).not.toContain('SELECT')
    }
  })
})
