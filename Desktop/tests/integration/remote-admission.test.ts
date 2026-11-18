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
import { createRequestHandler, computeRequestHash, type RequestHandlerDeps } from '../../src/main/remote/request-handler'
import { cacheKey, createResultCache } from '../../src/main/remote/result-cache'
import { applyGrantUpdate, applyHelloOk, emptyGrantContext, resetGrantContext, type GrantContextState } from '../../src/main/remote/grant-context'
import { writeRemoteAudit } from '../../src/main/remote/request-handler'
import { noteAuditFailure, noteAuditSuccess, createAuditStatus } from '../../src/main/remote/link-state'
import { makeHelloOk } from '../helpers/mock-gateway'
import type { RemoteGrant, RemoteReq } from '../../src/shared/contracts/remote'

/**
 * Remote 准入链（Phase 1.1B）。
 *
 * 这里的断言刻意不只检查错误码——每个用例都同时断言
 * **业务 Service 被调用的次数**、**审计行数**、**缓存状态**，
 * 因为「返回了正确错误码但已经读过数据」才是真正的越权。
 */

let dir: string
let handle: DatabaseHandle
let services: ToolServices
let grantState: GrantContextState
let cache: ReturnType<typeof createResultCache>
let auditStatus: ReturnType<typeof createAuditStatus>
let enabled: boolean
let currentBoundUserId: string | null
let revoked: Set<string>
/** 记录 `searchForMcp` 被调用几次，用来证明「没进业务层」。 */
let serviceCalls: number

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-remote-admission-'))
  handle = openDatabase(join(dir, 'test.db'))
  const events = new ApplicationEvents()
  const records = new RecordService(handle.db, handle.deviceId, events, () => undefined)
  const originalSearch = records.searchForMcp.bind(records)
  records.searchForMcp = ((input) => {
    serviceCalls += 1
    return originalSearch(input)
  }) as typeof records.searchForMcp

  services = {
    records,
    coffee: new CoffeeService(handle.db),
    canvas: new CanvasService(handle.db, handle.deviceId, events),
    workContexts: new WorkContextService(handle.db, events),
    personalDirection: new PersonalDirectionService(handle.db, events)
  }
  grantState = emptyGrantContext()
  cache = createResultCache()
  auditStatus = createAuditStatus()
  enabled = true
  currentBoundUserId = USER
  revoked = new Set()
  serviceCalls = 0
  // 这些是模块级的可注入状态，必须逐用例复位；否则前一个用例把 draining
  // 设成 true，后面所有用例都会走「draining 拒绝」分支。
  draining = false
  monoNow = () => performance.now()
  epochNow = () => Date.now()

  // 一个标准的「ChatGPT 有 records:read」快照
  applyHelloOk(
    grantState,
    makeHelloOk({
      grant_epoch: 5,
      allowed_tools: ALL_TOOLS,
      grants: [grant()]
    })
  )
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

function grant(overrides: Partial<RemoteGrant> = {}): RemoteGrant {
  return {
    grant_ctx: 'gc_a',
    grant_id: 'grt_a',
    client_id: 'chatgpt',
    client_name: 'ChatGPT',
    scopes: ['records:read', 'tags:read', 'coffee:read', 'canvas:read'],
    bound_user_id: USER,
    epoch: 1,
    ...overrides
  }
}

/**
 * 可注入的两个时钟。
 *
 * `monoNow` 是进程内计时（deadline 判断只看它）；`epochNow` 只用于把
 * `deadline_ms` 换算成 monotonic 预算这一件事。分开之后，
 * 「把系统时间往前跳 1 小时」这类测试不需要真的等，也不需要改系统时钟。
 */
let monoNow = () => performance.now()
let epochNow = () => Date.now()
let draining = false

function deps(overrides: Partial<RequestHandlerDeps> = {}): RequestHandlerDeps {
  const base: RequestHandlerDeps = {
    db: handle.db,
    services,
    cache,
    isEnabled: () => enabled,
    isDraining: () => draining,
    boundUserId: () => currentBoundUserId,
    deviceId: () => 'dev-1',
    grants: () => grantState,
    nowMono: () => monoNow(),
    nowEpoch: () => epochNow(),
    isGrantRevoked: (ctx) => revoked.has(ctx),
    audit: (entry) => {
      const ok = writeRemoteAudit(handle.db, 'dev-1', entry)
      if (ok) noteAuditSuccess(auditStatus)
      else noteAuditFailure(auditStatus, Date.now())
    }
  }
  return { ...base, ...overrides }
}

function req(overrides: Partial<RemoteReq> = {}): RemoteReq {
  const args = overrides.arguments ?? { search: 'x' }
  return {
    v: 1,
    type: 'req',
    id: 'req-1',
    ts: Date.now(),
    tool: 'search_records',
    arguments: args,
    request_hash: computeRequestHash({ v: 1, tool: overrides.tool ?? 'search_records', arguments: args }),
    deadline_ms: Date.now() + 10_000,
    grant_ctx: 'gc_a',
    ...overrides
  }
}

function auditRows() {
  return handle.db.select().from(mcpOperationLog).all()
}

describe('本地开关（ST-5）', () => {
  it('开关关闭 → REMOTE_DISABLED，零业务调用、零审计', () => {
    enabled = false
    const outcome = createRequestHandler(deps())(req())
    expect(outcome.res.ok).toBe(false)
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('REMOTE_DISABLED')
    expect(serviceCalls).toBe(0)
    expect(auditRows()).toHaveLength(0)
    expect(cache.snapshot().entries).toBe(0)
  })

  it('开关关闭时即使缓存里有旧结果也不回放（缓存不得早于开关）', () => {
    // 先正常跑一次，让缓存里有值
    createRequestHandler(deps())(req())
    expect(cache.snapshot().entries).toBe(1)

    enabled = false
    const callsBefore = serviceCalls
    const outcome = createRequestHandler(deps())(req())
    expect(outcome.stage).toBe('rejected')
    expect(cache.snapshot().entries).toBe(1) // 缓存没被读也没被删

    // 关键：重开之后仍然要重新走准入，且不能拿到「关闭期间」的授权判断。
    enabled = true
    createRequestHandler(deps())(req())
    // 缓存命中（同 id 同 hash），serviceCalls 不增加。
    expect(serviceCalls).toBe(callsBefore)
  })
})

describe('deadline（ST-9）', () => {
  it('已过期 → REQUEST_TIMEOUT，不进入业务层、不审计', () => {
    serviceCalls = 0
    const outcome = createRequestHandler(deps())(req({ deadline_ms: Date.now() - 1 }))
    expect(outcome.res.ok).toBe(false)
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('REQUEST_TIMEOUT')
    expect(serviceCalls).toBe(0)
    expect(auditRows()).toHaveLength(0)
  })

  it('缓存命中也要过 deadline（过期投递不该有结果）', () => {
    createRequestHandler(deps())(req())
    expect(cache.snapshot().entries).toBe(1)
    const outcome = createRequestHandler(deps())(req({ deadline_ms: Date.now() - 1 }))
    expect(outcome.res.ok).toBe(false)
    expect(outcome.stage).toBe('rejected')
  })
})

describe('Grant 上下文（ST-18 / ST-19 / ST-21）', () => {
  it('grant_ctx 未知 → GRANT_CONTEXT_INVALID，且不查缓存（ST-18）', () => {
    const outcome = createRequestHandler(deps())(req({ grant_ctx: 'gc_unknown' }))
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('GRANT_CONTEXT_INVALID')
    expect(serviceCalls).toBe(0)
    // 授权异常要留痕
    expect(auditRows()).toHaveLength(1)
  })

  it('上下文未安装 → GRANT_CONTEXT_INVALID', () => {
    resetGrantContext(grantState)
    const outcome = createRequestHandler(deps())(req())
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('GRANT_CONTEXT_INVALID')
    expect(serviceCalls).toBe(0)
  })

  it('bound_user_id 不匹配 → USER_MISMATCH（ST-19）', () => {
    currentBoundUserId = 'user-2'
    const outcome = createRequestHandler(deps())(req())
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('USER_MISMATCH')
    expect(serviceCalls).toBe(0)
    expect(auditRows()).toHaveLength(1)
  })

  it('grant 的 bound_user_id 不是本机用户 → USER_MISMATCH', () => {
    applyHelloOk(grantState, makeHelloOk({ grant_epoch: 6, grants: [grant({ bound_user_id: 'user-9' })] }))
    const outcome = createRequestHandler(deps())(req())
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('USER_MISMATCH')
    expect(serviceCalls).toBe(0)
  })

  it('已撤销的 grant → GRANT_REVOKED，且撤销前的缓存不回放（ST-21）', () => {
    // 先成功一次，缓存有值
    createRequestHandler(deps())(req())
    expect(cache.snapshot().entries).toBe(1)

    // 撤销：清该 ctx 缓存 + 标记 revoked（模拟 handleGrantUpdate 的行为）
    cache.dropGrantContext('gc_a')
    revoked.add('gc_a')
    const callsBefore = serviceCalls

    const outcome = createRequestHandler(deps())(req())
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('GRANT_REVOKED')
    // 不回放：业务没被调用（被撤销拦下），也没拿到旧数据
    expect(serviceCalls).toBe(callsBefore)
  })
})

describe('工具面与 scope（ST-20）', () => {
  it('未授权的工具 → TOOL_NOT_ALLOWED，零业务调用', () => {
    const outcome = createRequestHandler(deps())(req({ tool: 'create_record', arguments: {} }))
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('TOOL_NOT_ALLOWED')
    expect(serviceCalls).toBe(0)
    expect(auditRows()).toHaveLength(1)
  })

  it('scope 不足 → SCOPE_DENIED（同设备另一 grant 有，本 grant 没有）', () => {
    // 只有 tags:read 的 grant，却调用 search_records（需要 records:read）
    applyHelloOk(
      grantState,
      makeHelloOk({
        grant_epoch: 6,
        allowed_tools: ALL_TOOLS,
        grants: [
          grant({ grant_ctx: 'gc_tags', scopes: ['tags:read'] }),
          grant({ grant_ctx: 'gc_records', client_id: 'cursor', scopes: ['records:read'] })
        ]
      })
    )

    const denied = createRequestHandler(deps())(req({ grant_ctx: 'gc_tags' }))
    if (!denied.res.ok) expect(denied.res.error?.code).toBe('SCOPE_DENIED')
    expect(serviceCalls).toBe(0)

    // 同一个 delivery_id 换到有权限的 grant 上应该成功——证明 scope 是逐 grant 的。
    const allowed = createRequestHandler(deps())(req({ grant_ctx: 'gc_records' }))
    expect(allowed.res.ok).toBe(true)
  })

  it('两个 grant 的缓存互不命中（ST-20 的缓存半）', () => {
    applyHelloOk(
      grantState,
      makeHelloOk({
        grant_epoch: 6,
        allowed_tools: ALL_TOOLS,
        grants: [
          grant({ grant_ctx: 'gc_a', scopes: ['records:read'] }),
          grant({ grant_ctx: 'gc_b', client_id: 'cursor', scopes: ['records:read'] })
        ]
      })
    )
    createRequestHandler(deps())(req({ grant_ctx: 'gc_a' }))
    const callsAfterA = serviceCalls

    // 同 id 同 hash，但换 grant：必须重新执行，不能命中 A 的缓存。
    const outcome = createRequestHandler(deps())(req({ grant_ctx: 'gc_b' }))
    expect(outcome.res.ok).toBe(true)
    if (outcome.res.ok) expect(outcome.res.meta.cached).toBe(false)
    expect(serviceCalls).toBe(callsAfterA + 1)
  })

  it('Cloud 的 allowed_tools 更窄时按它收窄', () => {
    applyHelloOk(
      grantState,
      makeHelloOk({ grant_epoch: 6, allowed_tools: ['get_record'], grants: [grant()] })
    )
    const outcome = createRequestHandler(deps())(req({ tool: 'search_records' }))
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('TOOL_NOT_ALLOWED')
    expect(serviceCalls).toBe(0)
  })
})

describe('request_hash 与重复投递（ST-6 / ST-7 / ST-8）', () => {
  it('同 id 不同 hash → PROTOCOL_VIOLATION，且不覆盖原缓存（ST-6）', () => {
    createRequestHandler(deps())(req({ arguments: { search: 'original' } }))
    const before = cache.get('gc_a\u0000req-1')
    expect(before?.state).toBe('done')

    const outcome = createRequestHandler(deps())(
      req({ arguments: { search: 'tampered' }, request_hash: computeRequestHash({ v: 1, tool: 'search_records', arguments: { search: 'tampered' } }) })
    )
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('PROTOCOL_VIOLATION')

    // 原缓存内容没被改写
    const after = cache.get('gc_a\u0000req-1')
    expect(after?.state).toBe('done')
    if (after?.state === 'done' && after.ok) {
      // 原来的 data 还在（不是 tampered 的结果）
      expect(JSON.stringify(after.data)).not.toContain('tampered')
    }
  })

  it('同 id 同 hash 重投 → 回放，业务只执行一次（ST-7）', () => {
    const handler = createRequestHandler(deps())
    const first = handler(req())
    expect(first.res.ok).toBe(true)
    const callsAfterFirst = serviceCalls

    const second = handler(req())
    expect(second.res.ok).toBe(true)
    if (second.res.ok) expect(second.res.meta.cached).toBe(true)
    expect(serviceCalls).toBe(callsAfterFirst)
  })

  it('不同 id 相同参数 → 各自执行一次（ST-8）', () => {
    const handler = createRequestHandler(deps())
    handler(req({ id: 'req-a' }))
    handler(req({ id: 'req-b' }))
    expect(serviceCalls).toBe(2)
  })

  it('同 id 仍在 inflight → 拒绝，不并发执行（ST-30）', () => {
    const key = 'gc_a\u0000req-1'
    cache.beginInflight(key, req().request_hash)
    serviceCalls = 0

    const outcome = createRequestHandler(deps())(req())
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('PROTOCOL_VIOLATION')
    expect(serviceCalls).toBe(0)
  })
})

describe('审计口径（ST-10 与安全运维 §6.5.4.1）', () => {
  it('成功调用写 1 行，client_id 以 remote: 开头', () => {
    createRequestHandler(deps())(req())
    const rows = auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].clientId).toBe('remote:dev-1')
    expect(rows[0].toolName).toBe('search_records')
    expect(rows[0].success).toBe(true)
  })

  it('只读工具也记（与 Local 只记写工具不同）', () => {
    createRequestHandler(deps())(req({ tool: 'list_beans', arguments: {} }))
    expect(auditRows()).toHaveLength(1)
  })

  it('一次失败只写一行（不重复记账）', () => {
    const outcome = createRequestHandler(deps())(req({ tool: 'create_record', arguments: {} }))
    expect(outcome.audited).toBe(true)
    expect(auditRows()).toHaveLength(1)
  })

  it('准入阶段（开关/deadline）不写审计', () => {
    enabled = false
    createRequestHandler(deps())(req())
    expect(auditRows()).toHaveLength(0)
  })

  it('缓存命中也要写审计（也是一次真实读取）', () => {
    const handler = createRequestHandler(deps())
    handler(req())
    handler(req())
    expect(auditRows()).toHaveLength(2)
  })

  it('审计失败时业务结果仍正确（ST-10 的核心）', () => {
    // 注入一个总是失败的审计
    const failing = deps({
      audit: () => {
        throw new Error('disk full')
      }
    })
    let outcome
    try {
      outcome = createRequestHandler(failing)(req())
    } catch {
      outcome = null
    }
    // 审计抛错不应该让 handler 崩掉，更不该被当成业务失败
    expect(outcome).not.toBeNull()
    expect(outcome!.res.ok).toBe(true)
  })

  it('审计内容不含参数与结果', () => {
    createRequestHandler(deps())(
      req({ arguments: { search: 'SENTINEL-7f3a9c' } })
    )
    const json = JSON.stringify(auditRows())
    expect(json).not.toContain('SENTINEL')
    // 也不含 token 与私钥
    expect(json).not.toContain('bp_dev_')
    expect(json).not.toContain('bp_mcp_')
  })
})

describe('业务错误的映射（不泄漏内部语义）', () => {
  it('NOT_FOUND 透传原文（AI 需要知道哪条不存在）', () => {
    const outcome = createRequestHandler(deps())(
      req({
        tool: 'get_record',
        arguments: { record_id: '00000000-0000-4000-8000-000000000000' },
        request_hash: computeRequestHash({
          v: 1,
          tool: 'get_record',
          arguments: { record_id: '00000000-0000-4000-8000-000000000000' }
        })
      })
    )
    expect(outcome.res.ok).toBe(false)
    if (!outcome.res.ok) {
      expect(outcome.res.error?.code).toBe('NOT_FOUND')
      expect(outcome.res.error?.message).toContain('not found')
      expect(outcome.res.error?.retryable).toBe(false)
    }
  })

  it('参数错误 → INVALID_ARGUMENTS', () => {
    const outcome = createRequestHandler(deps())(
      req({ arguments: { limit: 9999 }, request_hash: computeRequestHash({ v: 1, tool: 'search_records', arguments: { limit: 9999 } }) })
    )
    expect(outcome.res.ok).toBe(false)
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('INVALID_ARGUMENTS')
    expect(serviceCalls).toBe(0)
  })

  it('未知异常 → INTERNAL_ERROR + 通用文案（不含 SQL / 路径）', () => {
    const original = services.coffee.listTastingsForMcp
    services.coffee.listTastingsForMcp = (() => {
      throw new Error("SQLITE_ERROR: no such table: tastings — /Users/x/brewphase.db")
    }) as typeof services.coffee.listTastingsForMcp
    try {
      const outcome = createRequestHandler(deps())(
        req({
          tool: 'list_tastings',
          arguments: {},
          request_hash: computeRequestHash({ v: 1, tool: 'list_tastings', arguments: {} })
        })
      )
      expect(outcome.res.ok).toBe(false)
      if (!outcome.res.ok) {
        expect(outcome.res.error?.code).toBe('INTERNAL_ERROR')
        expect(outcome.res.error?.message).not.toContain('SQLITE')
        expect(outcome.res.error?.message).not.toContain('/Users')
        expect(outcome.res.error?.message).toMatch(/unexpected error/i)
      }
    } finally {
      services.coffee.listTastingsForMcp = original
    }
  })
})

describe('grant_update 撤销后的缓存清理（ST-21 / ST-22 的底座）', () => {
  it('撤销时清掉该 ctx 的缓存，其它 grant 不受影响', () => {
    applyHelloOk(
      grantState,
      makeHelloOk({
        grant_epoch: 6,
        allowed_tools: ALL_TOOLS,
        grants: [
          grant({ grant_ctx: 'gc_a', scopes: ['records:read'] }),
          grant({ grant_ctx: 'gc_b', client_id: 'cursor', scopes: ['records:read'] })
        ]
      })
    )
    const handler = createRequestHandler(deps())
    handler(req({ grant_ctx: 'gc_a' }))
    handler(req({ grant_ctx: 'gc_b' }))
    expect(cache.snapshot().entries).toBe(2)

    // 撤销 A
    const applied = applyGrantUpdate(grantState, {
      v: 1,
      type: 'grant_update',
      ts: Date.now(),
      grant_epoch: 7,
      op: 'revoke',
      grant_ctx: 'gc_a'
    })
    expect(applied.ok).toBe(true)
    if (applied.ok) for (const ctx of applied.revokedContexts) cache.dropGrantContext(ctx)

    expect(cache.snapshot().entries).toBe(1)
    expect(cache.get('gc_b\u0000req-1')?.state).toBe('done')
    expect(cache.get('gc_a\u0000req-1')).toBeUndefined()
  })
})

describe('关闭开关后的重投（ST-16）', () => {
  it('执行中关开关 → 同 delivery_id 重投必须重新走完整准入', () => {
    const handler = createRequestHandler(deps())
    // 先让一次请求执行完成（缓存有值）
    handler(req())
    expect(serviceCalls).toBe(1)

    // 关闭开关：调用方（RemoteService.disable）会同时清缓存；
    // 这里模拟同样的顺序，验证「即使缓存还在也不该回放」。
    enabled = false
    const during = handler(req())
    expect(during.res.ok).toBe(false)
    if (!during.res.ok) expect(during.res.error?.code).toBe('REMOTE_DISABLED')
    // 关键：没有因为缓存命中而回放
    expect(during.stage).toBe('rejected')
    expect(during.res.ok === false && during.res.meta.cached).toBe(false)

    // 重开并清缓存后当成新请求执行一次
    enabled = true
    cache.clear()
    const after = handler(req())
    expect(after.res.ok).toBe(true)
    expect(after.stage).toBe('executed')
    expect(serviceCalls).toBe(2)
  })

  it('关闭时就清缓存，重开后不会回到关闭前的数据', () => {
    const handler = createRequestHandler(deps())
    handler(req())
    expect(cache.snapshot().entries).toBe(1)

    enabled = false
    cache.clear() // disable() 里就是这么做的
    enabled = true

    handler(req())
    // 缓存被清 → 重新执行
    expect(serviceCalls).toBe(2)
  })
})

describe('request_hash：首次投递也要验（协议 §8.2）', () => {
  it('第一次就带错误 hash → PROTOCOL_VIOLATION，不执行、不写缓存', () => {
    const handler = createRequestHandler(deps())
    const bad = req({ request_hash: `sha256:${'0'.repeat(64)}` })

    const outcome = handler(bad)
    expect(outcome.res.ok).toBe(false)
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('PROTOCOL_VIOLATION')
    // 关键：一个字节的业务代码都没跑，缓存也没被污染。
    expect(serviceCalls).toBe(0)
    expect(cache.snapshot().entries).toBe(0)
    // 这是一次安全事件，要留痕。
    expect(auditRows().filter((row) => row.errorCode === 'PROTOCOL_VIOLATION')).toHaveLength(1)
  })

  it('hash 正确才执行', () => {
    const handler = createRequestHandler(deps())
    const outcome = handler(req())
    expect(outcome.res.ok).toBe(true)
    expect(serviceCalls).toBe(1)
  })

  it('hash 只覆盖 v/tool/arguments：换 tool 而不换 hash 会被拒', () => {
    const handler = createRequestHandler(deps())
    // 用 search_records 的 hash，但实际请求 get_record。
    // 注意 `req()` 会按 overrides.tool 重算 hash，所以这里必须显式覆盖。
    const forged = req({
      tool: 'get_record',
      arguments: { id: 'r1' },
      request_hash: computeRequestHash({ v: 1, tool: 'search_records', arguments: { id: 'r1' } })
    })
    const outcome = handler(forged)
    expect(outcome.res.ok).toBe(false)
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('PROTOCOL_VIOLATION')
    expect(serviceCalls).toBe(0)
  })
})

describe('deadline：epoch 只换算一次，之后只看 monotonic（ST-9）', () => {
  it('整个过程只读一次 epoch 时钟', () => {
    let epochCalls = 0
    monoNow = () => 1_000
    epochNow = () => {
      epochCalls += 1
      return 1_000_000
    }

    const outcome = createRequestHandler(deps())(req({ deadline_ms: 1_006_000 }))
    expect(outcome.res.ok).toBe(true)
    // 「不允许每次比较都重新调用 Date.now」的结构性证明：
    // 第二次读就会让这个断言变成 2。
    expect(epochCalls).toBe(1)
  })

  it('收到时就已过期 → REQUEST_TIMEOUT，零业务调用', () => {
    monoNow = () => 1_000
    epochNow = () => 1_000_000
    const outcome = createRequestHandler(deps())(req({ deadline_ms: 999_999 }))
    expect(outcome.res.ok).toBe(false)
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('REQUEST_TIMEOUT')
    expect(serviceCalls).toBe(0)
    expect(auditRows()).toHaveLength(0)
  })

  it('执行完成时已过 deadline → 不发 res、不落成功缓存、审计记超时', () => {
    // 让「业务执行」把 monotonic 推过期限：这才是真实的长耗时工具。
    const base = 10_000
    let mono = base
    monoNow = () => mono
    epochNow = () => 1_000_000

    const before = serviceCalls
    const original = services.records.searchForMcp
    services.records.searchForMcp = ((input) => {
      const result = original(input)
      // 业务真的跑了 9 秒：这才是「执行完成时已过 deadline」的真实成因。
      mono = base + 9_000
      return result
    }) as typeof services.records.searchForMcp

    const outcome = createRequestHandler(deps())(req({ deadline_ms: 1_000_000 + 1_000 }))
    // 结果被丢弃：协议 §7.4 第三条（Cloud 早已超时，不能补发一个迟到的成功）。
    expect(outcome.deliver).toBe(false)
    expect(outcome.stage).toBe('expired')
    expect(serviceCalls - before).toBe(1)
    expect(cache.snapshot().entries).toBe(0)
    const rows = auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].success).toBe(false)
    expect(rows[0].errorCode).toBe('REQUEST_TIMEOUT')
  })

  it('系统时间被改也影响不了已经确定的期限（monotonic 决定）', () => {
    let mono = 1_000
    let epoch = 1_000_000
    monoNow = () => mono
    epochNow = () => epoch

    // 期限 = 收到时刻 + 5s（用 monotonic 表达是 6000）。
    const deadline = epoch + 5_000
    // 执行期间系统时间**往回**跳 1 小时：若实现用 Date.now() 比较，会以为还剩 1 小时。
    epoch -= 3_600_000
    mono = 5_000

    const outcome = createRequestHandler(deps())(req({ deadline_ms: deadline }))
    // 仍然在期限内：monotonic 只走了 4s。
    expect(outcome.res.ok).toBe(true)
    expect(outcome.deliver).toBe(true)
  })
})

describe('draining（协议 §4.5 / §11）', () => {
  it('draining 期间拒绝新请求，零业务调用、零审计', () => {
    draining = true
    const outcome = createRequestHandler(deps())(req())
    expect(outcome.res.ok).toBe(false)
    if (!outcome.res.ok) {
      expect(outcome.res.error?.code).toBe('DEVICE_BUSY')
      expect(outcome.res.error?.retryable).toBe(true)
    }
    expect(serviceCalls).toBe(0)
    expect(auditRows()).toHaveLength(0)
  })
})

describe('inflight 占位（v1：拒绝，不排队）', () => {
  it('同 delivery_id 仍在执行 → PROTOCOL_VIOLATION，只执行一次', () => {
    const handler = createRequestHandler(deps())
    const first = req()
    // 手工制造「执行中」状态（同步 handler 在真实时序里不可观测，
    // 但占位表的存在必须可断言——它是「绝不重复执行」的结构保证）。
    expect(cache.beginInflight(cacheKey('gc_a', 'req-1'), first.request_hash)).toBe(true)

    const outcome = handler(first)
    expect(outcome.res.ok).toBe(false)
    if (!outcome.res.ok) expect(outcome.res.error?.code).toBe('PROTOCOL_VIOLATION')
    expect(serviceCalls).toBe(0)
  })

  it('不同 delivery_id + 相同参数 → 各执行一次', () => {
    const handler = createRequestHandler(deps())
    handler(req({ id: 'req-1' }))
    handler(req({ id: 'req-2' }))
    expect(serviceCalls).toBe(2)
    expect(cache.snapshot().entries).toBe(2)
  })
})
