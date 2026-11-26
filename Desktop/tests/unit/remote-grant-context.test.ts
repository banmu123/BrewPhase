import { describe, expect, it } from 'vitest'
import {
  applyGrantUpdate,
  applyHelloOk,
  emptyGrantContext,
  lookupGrant,
  resetGrantContext,
  type GrantContextState
} from '../../src/main/remote/grant-context'
import { makeHelloOk } from '../helpers/mock-gateway'
import type { RemoteGrant, RemoteGrantUpdate } from '../../src/shared/contracts/remote'

/**
 * Grant 上下文表（Phase 1.1B）：安装、隔离、撤销、epoch、闭合键集。
 *
 * 覆盖安全矩阵 ST-18 ~ ST-24 的「上下文侧」。
 */

function grant(overrides: Partial<RemoteGrant> = {}): RemoteGrant {
  return {
    grant_ctx: 'gc_a',
    grant_id: 'grt_a',
    client_id: 'chatgpt',
    client_name: 'ChatGPT',
    scopes: ['records:read'],
    bound_user_id: 'user-1',
    epoch: 1,
    ...overrides
  }
}

function installUpdate(overrides: Partial<RemoteGrantUpdate> = {}): RemoteGrantUpdate {
  return {
    v: 1,
    type: 'grant_update',
    ts: Date.now(),
    grant_epoch: 2,
    op: 'install',
    grant: grant(),
    ...overrides
  }
}

describe('hello_ok 全量快照（ST-24）', () => {
  it('安装后 ready，并逐 grant 建表', () => {
    const state = emptyGrantContext()
    const applied = applyHelloOk(
      state,
      makeHelloOk({
        grant_epoch: 5,
        grants: [grant({ grant_ctx: 'gc_a' }), grant({ grant_ctx: 'gc_b', client_id: 'cursor', scopes: ['coffee:read'] })]
      })
    )
    expect(state.ready).toBe(true)
    expect(state.epoch).toBe(5)
    expect(state.grants.size).toBe(2)
    expect(applied.revokedContexts).toEqual([])
    // 两个 grant 各自的 scope 独立
    expect(lookupGrant(state, 'gc_a')?.scopes).toEqual(['records:read'])
    expect(lookupGrant(state, 'gc_b')?.scopes).toEqual(['coffee:read'])
  })

  it('重连后的快照整体替换：不在新快照里的旧 ctx 立即失效', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 5, grants: [grant({ grant_ctx: 'gc_a' }), grant({ grant_ctx: 'gc_old' })] }))
    expect(state.grants.size).toBe(2)

    const applied = applyHelloOk(state, makeHelloOk({ grant_epoch: 6, grants: [grant({ grant_ctx: 'gc_a' })] }))
    expect(state.grants.size).toBe(1)
    expect(lookupGrant(state, 'gc_old')).toBeNull()
    // 返回被移除的 ctx，调用方据此清缓存。
    expect(applied.revokedContexts).toEqual(['gc_old'])
  })

  it('空快照：保持连接但 ready（无可用授权）', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 0, grants: [] }))
    expect(state.ready).toBe(true)
    expect(state.grants.size).toBe(0)
    expect(lookupGrant(state, 'anything')).toBeNull()
  })

  it('allowed_tools 随快照更新', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ allowed_tools: ['search_records'] }))
    expect(state.allowedTools).toEqual(['search_records'])
  })
})

describe('grant_update 的幂等与 epoch（ST-23）', () => {
  it('install 生效并推进 epoch', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 1 }))
    const result = applyGrantUpdate(state, installUpdate({ grant_epoch: 2 }))
    expect(result.ok).toBe(true)
    expect(state.epoch).toBe(2)
    expect(lookupGrant(state, 'gc_a')?.clientName).toBe('ChatGPT')
  })

  it('重复（同 epoch）被丢弃且状态不变', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 5 }))
    const before = snapshotOf(state)
    const result = applyGrantUpdate(state, installUpdate({ grant_epoch: 5 }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.changed).toBe(false)
    expect(snapshotOf(state)).toBe(before)
    expect(state.grants.size).toBe(0)
  })

  it('回退（更小 epoch）被丢弃', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 10, grants: [grant()] }))
    const result = applyGrantUpdate(state, installUpdate({ grant_epoch: 9, grant: grant({ client_name: '旧' }) }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.changed).toBe(false)
    expect(lookupGrant(state, 'gc_a')?.clientName).toBe('ChatGPT')
  })

  it('revoke 移除并返回该 ctx（供清缓存）', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 1, grants: [grant({ grant_ctx: 'gc_a' }), grant({ grant_ctx: 'gc_b' })] }))
    const result = applyGrantUpdate(state, {
      v: 1,
      type: 'grant_update',
      ts: Date.now(),
      grant_epoch: 2,
      op: 'revoke',
      grant_ctx: 'gc_a'
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.revokedContexts).toEqual(['gc_a'])
    expect(lookupGrant(state, 'gc_a')).toBeNull()
    // ST-21 的另一半：撤销 A 不影响 B。
    expect(lookupGrant(state, 'gc_b')).not.toBeNull()
  })

  it('撤销一个不存在的 ctx 也算成功（可能来自先跑完的请求）', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 1 }))
    const result = applyGrantUpdate(state, {
      v: 1,
      type: 'grant_update',
      ts: Date.now(),
      grant_epoch: 2,
      op: 'revoke',
      grant_ctx: 'gc_ghost'
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.revokedContexts).toEqual(['gc_ghost'])
  })
})

describe('闭合键集（ST-28）', () => {
  it('grant 多一个未知键 → PROTOCOL_VIOLATION，且状态不变', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 5 }))
    const before = state.epoch

    const result = applyGrantUpdate(
      state,
      installUpdate({
        grant_epoch: 6,
        grant: { ...grant(), extra_field: 'should be rejected' } as unknown as RemoteGrant
      })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PROTOCOL_VIOLATION')
    // 关键：一点都没改。
    expect(state.epoch).toBe(before)
    expect(state.grants.size).toBe(0)
  })

  it('grant 缺必需键 → PROTOCOL_VIOLATION', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 5 }))
    const incomplete = { grant_ctx: 'gc_x' } as unknown as RemoteGrant
    const result = applyGrantUpdate(state, installUpdate({ grant_epoch: 6, grant: incomplete }))
    expect(result.ok).toBe(false)
    expect(state.grants.size).toBe(0)
  })

  it('grant 的 scope 不在 REMOTE_SCOPES 内 → 拒绝', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 5 }))
    const result = applyGrantUpdate(
      state,
      installUpdate({ grant_epoch: 6, grant: grant({ scopes: ['records:create' as never] }) })
    )
    expect(result.ok).toBe(false)
    expect(state.grants.size).toBe(0)
  })
})

describe('resetGrantContext', () => {
  it('清空全部并回到未就绪', () => {
    const state = emptyGrantContext()
    applyHelloOk(state, makeHelloOk({ grant_epoch: 7, grants: [grant()] }))
    resetGrantContext(state)
    expect(state.ready).toBe(false)
    expect(state.epoch).toBe(-1)
    expect(state.grants.size).toBe(0)
    expect(state.allowedTools).toBeNull()
  })
})

function snapshotOf(state: GrantContextState): string {
  return JSON.stringify([state.epoch, [...state.grants.keys()], state.ready])
}
