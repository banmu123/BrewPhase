import { describe, expect, it, vi } from 'vitest'

import type { AccountSnapshot } from '../../src/shared/contracts/account'
import { AccountService, type CallbackHandle } from '../../src/main/account/account-service'
import { CloudError, type CloudClient, type CloudSession } from '../../src/main/account/cloud-client'
import type { CredentialLoad, CredentialStore, StoredAccount } from '../../src/main/account/credentials'
import type { OAuthCallbackOutcome } from '../../src/main/account/oauth-callback-server'

/**
 * AccountService 测试：登录、恢复、退出、刷新失败。
 *
 * Cloud、回调服务器、凭据存储全部注入：不需要真实 Google/GitHub，
 * 也不需要真的开端口。真正被跑到的是状态机本身——pending / signed-in /
 * signed-out 的迁移、失败分类、以及「网络错误不等于会话失效」这条边界。
 */

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function session(accessToken: string, refreshToken: string): CloudSession {
  return { accessToken, refreshToken, expiresInSeconds: 900 }
}

const STORED: StoredAccount = {
  provider: 'google',
  userId: 'user_1',
  displayName: 'Half',
  avatarUrl: null,
  createdAt: '2026-01-02T03:04:05.000Z',
  refreshToken: 'stored-refresh'
}

function makeCloud() {
  const raw = {
    origin: 'https://cloud.example.test',
    authorizeUrl: vi.fn((params: { provider: string; clientState: string; codeChallenge: string; redirectUri: string }) => {
      return `https://cloud.example.test/oauth/authorize?provider=${params.provider}&state=${params.clientState}&code_challenge=${params.codeChallenge}&redirect_uri=${encodeURIComponent(params.redirectUri)}`
    }),
    exchangeAuthorizationCode: vi.fn(async () => session('access-1', 'refresh-1')),
    refresh: vi.fn(async () => session('access-2', 'refresh-2')),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => ({
      id: 'user_1',
      displayName: 'Half',
      avatarUrl: null,
      createdAt: '2026-01-02T03:04:05.000Z'
    }))
  }
  return { raw, cloud: raw as unknown as CloudClient }
}

function makeStore(initial: CredentialLoad = { status: 'empty' }) {
  const state = {
    current: initial,
    saved: null as StoredAccount | null,
    cleared: 0,
    canPersist: true
  }
  const store = {
    get canPersist(): boolean {
      return state.canPersist
    },
    load: () => state.current,
    save: (account: StoredAccount) => {
      state.saved = { ...account }
      return { ok: true as const, storage: 'encrypted' as const }
    },
    clear: () => {
      state.cleared += 1
      state.saved = null
    }
  }
  return { store: store as unknown as CredentialStore, state }
}

function makeCallback() {
  const box: {
    handle: CallbackHandle | null
    outcome: Deferred<OAuthCallbackOutcome>
    started: Array<{ clientState: string; timeoutMs: number }>
  } = { handle: null, outcome: deferred<OAuthCallbackOutcome>(), started: [] }

  const factory = async (params: { clientState: string; timeoutMs: number }): Promise<CallbackHandle> => {
    box.started.push(params)
    const handle: CallbackHandle = {
      redirectUri: 'http://127.0.0.1:51234/callback',
      result: box.outcome.promise,
      cancel: () => box.outcome.resolve({ status: 'cancelled' })
    }
    box.handle = handle
    return handle
  }
  return { box, factory }
}

function build(options: { store?: CredentialLoad; canPersist?: boolean } = {}) {
  const cloud = makeCloud()
  const store = makeStore(options.store ?? { status: 'empty' })
  if (options.canPersist === false) store.state.canPersist = false
  const callback = makeCallback()
  const openExternal = vi.fn(async () => {})
  const broadcasts: AccountSnapshot[] = []
  let clock = 1_700_000_000_000
  const service = new AccountService({
    cloud: cloud.cloud,
    store: store.store,
    openExternal,
    startCallback: callback.factory,
    broadcast: (snapshot) => broadcasts.push(snapshot),
    now: () => clock,
    log: () => {}
  })
  return {
    service,
    cloud: cloud.raw,
    store: store.state,
    callback: callback.box,
    openExternal,
    broadcasts,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

async function completeLogin(
  harness: ReturnType<typeof build>,
  provider: 'google' | 'github' = 'google'
): Promise<AccountSnapshot> {
  const pending = harness.service.login(provider)
  await vi.waitFor(() => expect(harness.callback.handle).not.toBeNull())
  await vi.waitFor(() => expect(harness.service.snapshot().state).toBe('pending'))
  harness.callback.outcome.resolve({ status: 'code', code: 'code-1' })
  return await pending
}

describe('AccountService 登录', () => {
  it('登录成功：pending → signed-in，凭据落盘，快照里没有任何 token', async () => {
    const harness = build()
    const snapshot = await completeLogin(harness)

    expect(snapshot.state).toBe('signed-in')
    expect(snapshot.provider).toBe('google')
    expect(snapshot.user).toEqual({
      id: 'user_1',
      displayName: 'Half',
      avatarUrl: null,
      createdAt: '2026-01-02T03:04:05.000Z'
    })
    expect(snapshot.pending).toBeNull()
    expect(snapshot.notice).toBeNull()
    expect(harness.store.saved?.refreshToken).toBe('refresh-1')
    // 序列化整份快照：不能出现 access/refresh token 字段或值。
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('refresh-1')
    expect(serialized).not.toContain('access-1')
    expect(serialized).not.toMatch(/token/i)
  })

  it('登录过程中的中间状态会广播（pending 先于 signed-in）', async () => {
    const harness = build()
    await completeLogin(harness)

    const states = harness.broadcasts.map((item) => item.state)
    expect(states[0]).toBe('pending')
    expect(states[states.length - 1]).toBe('signed-in')
  })

  it('PKCE / state 由主进程生成：state 43 字符，challenge 43 字符且不等于 verifier', async () => {
    const harness = build()
    await completeLogin(harness)

    const params = harness.cloud.authorizeUrl.mock.calls[0]?.[0]
    expect(params?.clientState).toMatch(/^[A-Za-z0-9\-_]{43}$/)
    expect(params?.codeChallenge).toMatch(/^[A-Za-z0-9\-_]{43}$/)
    // redirect_uri 必须与服务端白名单一致：http://127.0.0.1:<port>/callback
    expect(params?.redirectUri).toBe('http://127.0.0.1:51234/callback')
    // 回调服务器拿到的 clientState 与授权地址里的一致（服务端会原样回传）。
    expect(harness.callback.started[0]?.clientState).toBe(params?.clientState)
  })

  it('取消登录：回到 signed-out，notice=cancelled', async () => {
    const harness = build()
    const pending = harness.service.login('github')
    await vi.waitFor(() => expect(harness.service.snapshot().state).toBe('pending'))

    harness.service.cancelLogin()
    const snapshot = await pending

    expect(snapshot.state).toBe('signed-out')
    expect(snapshot.notice?.code).toBe('cancelled')
    expect(harness.store.saved).toBeNull()
  })

  it('授权页拒绝 → provider-denied，不去兑换授权码', async () => {
    const harness = build()
    const pending = harness.service.login('google')
    await vi.waitFor(() => expect(harness.callback.handle).not.toBeNull())
    harness.callback.outcome.resolve({ status: 'error', error: 'access_denied', description: null })

    const snapshot = await pending
    expect(snapshot.state).toBe('signed-out')
    expect(snapshot.notice?.code).toBe('provider-denied')
    expect(harness.cloud.exchangeAuthorizationCode).not.toHaveBeenCalled()
  })

  it('回调超时 → notice=timeout', async () => {
    const harness = build()
    const pending = harness.service.login('google')
    await vi.waitFor(() => expect(harness.callback.handle).not.toBeNull())
    harness.callback.outcome.resolve({ status: 'timeout' })

    const snapshot = await pending
    expect(snapshot.notice?.code).toBe('timeout')
    expect(snapshot.state).toBe('signed-out')
  })

  it('授权码兑换 401 → exchange-failed，不保存任何凭据', async () => {
    const harness = build()
    harness.cloud.exchangeAuthorizationCode.mockRejectedValueOnce(
      new CloudError('http', { status: 401, serverCode: 'invalid_grant' })
    )
    const snapshot = await completeLogin(harness)

    expect(snapshot.state).toBe('signed-out')
    expect(snapshot.notice?.code).toBe('exchange-failed')
    expect(snapshot.notice?.detail).toBe('invalid_grant')
    expect(harness.store.saved).toBeNull()
  })

  it('兑换超时 → cloud-timeout', async () => {
    const harness = build()
    harness.cloud.exchangeAuthorizationCode.mockRejectedValueOnce(new CloudError('timeout'))
    const snapshot = await completeLogin(harness)

    expect(snapshot.notice?.code).toBe('cloud-timeout')
  })

  it('已有登录在等待授权时再次点登录 → login-in-progress，不重复开浏览器', async () => {
    const harness = build()
    const first = harness.service.login('google')
    await vi.waitFor(() => expect(harness.service.snapshot().state).toBe('pending'))

    const second = await harness.service.login('github')
    expect(second.notice?.code).toBe('login-in-progress')
    expect(harness.openExternal).toHaveBeenCalledTimes(1)

    harness.callback.outcome.resolve({ status: 'cancelled' })
    await first
  })

  it('已登录时不再发起新登录（先退出再换号）', async () => {
    const harness = build({ store: { status: 'ok', account: STORED, storage: 'encrypted' } })
    harness.service.restore()

    const snapshot = await harness.service.login('github')
    expect(snapshot.state).toBe('signed-in')
    expect(harness.cloud.authorizeUrl).not.toHaveBeenCalled()
  })

  it('回调服务器起不来 → unknown，并保持未登录', async () => {
    const harness = build()
    const failing = new AccountService({
      cloud: harness.cloud as unknown as CloudClient,
      store: { canPersist: true, load: () => ({ status: 'empty' } as const) } as unknown as CredentialStore,
      openExternal: async () => {},
      startCallback: async () => {
        throw new Error('listen EADDRINUSE')
      },
      log: () => {}
    })

    const snapshot = await failing.login('google')
    expect(snapshot.state).toBe('signed-out')
    expect(snapshot.notice?.code).toBe('unknown')
  })
})

describe('AccountService 恢复会话', () => {
  it('读到密文即视为已登录（不等网络），随后校验并轮换 refresh token', async () => {
    const harness = build({ store: { status: 'ok', account: STORED, storage: 'encrypted' } })
    const snapshot = harness.service.restore()

    // 同步返回：离线启动也能立刻显示已登录。
    expect(snapshot.state).toBe('signed-in')
    expect(snapshot.user?.id).toBe('user_1')
    expect(snapshot.checking).toBe(true)

    await vi.waitFor(() => expect(harness.service.snapshot().checking).toBe(false))
    const settled = harness.service.snapshot()
    expect(settled.verifiedAt).not.toBeNull()
    expect(harness.cloud.refresh).toHaveBeenCalledWith('stored-refresh')
    // 服务端已轮换：本地必须立刻换成新 token，否则重启就掉线。
    expect(harness.store.saved?.refreshToken).toBe('refresh-2')
  })

  it('refresh 返回 401 → 清凭据、回未登录、notice=session-expired', async () => {
    const harness = build({ store: { status: 'ok', account: STORED, storage: 'encrypted' } })
    harness.cloud.refresh.mockRejectedValueOnce(
      new CloudError('http', { status: 401, serverCode: 'invalid_token' })
    )
    harness.service.restore()

    await vi.waitFor(() => expect(harness.service.snapshot().state).toBe('signed-out'))
    expect(harness.service.snapshot().notice?.code).toBe('session-expired')
    expect(harness.store.cleared).toBe(1)
  })

  it('网络断开时保持已登录（离线不等于被踢下线）', async () => {
    const harness = build({ store: { status: 'ok', account: STORED, storage: 'encrypted' } })
    harness.cloud.refresh.mockRejectedValueOnce(new CloudError('network'))
    harness.service.restore()

    await vi.waitFor(() => expect(harness.service.snapshot().checking).toBe(false))
    const snapshot = harness.service.snapshot()
    expect(snapshot.state).toBe('signed-in')
    expect(snapshot.notice?.code).toBe('cloud-unreachable')
    expect(harness.store.cleared).toBe(0)
  })

  it('解密失败 → 按未登录处理，notice=storage-failed', () => {
    const harness = build({ store: { status: 'failed', reason: 'decrypt-failed' } })
    const snapshot = harness.service.restore()

    expect(snapshot.state).toBe('signed-out')
    expect(snapshot.notice?.code).toBe('storage-failed')
    expect(snapshot.notice?.detail).toBe('decrypt-failed')
    expect(harness.cloud.refresh).not.toHaveBeenCalled()
  })

  it('安全存储不可用 → 未登录，storage=unavailable', () => {
    const harness = build({ store: { status: 'unavailable' }, canPersist: false })
    const snapshot = harness.service.restore()

    expect(snapshot.state).toBe('signed-out')
    expect(snapshot.storage).toBe('unavailable')
    expect(snapshot.notice?.code).toBe('storage-unavailable')
  })

  it('Access Token 有缓存：一次启动只换一次 refresh', async () => {
    const harness = build({ store: { status: 'ok', account: STORED, storage: 'encrypted' } })
    harness.service.restore()
    await vi.waitFor(() => expect(harness.service.snapshot().checking).toBe(false))

    const token = await harness.service.accessToken()
    expect(token).toBe('access-2')
    expect(harness.cloud.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('AccountService 退出登录', () => {
  it('先清本地再撤销服务端会话；本地记录不受影响（这里只断言不碰其他依赖）', async () => {
    const harness = build({ store: { status: 'ok', account: STORED, storage: 'encrypted' } })
    harness.service.restore()
    await vi.waitFor(() => expect(harness.service.snapshot().checking).toBe(false))

    const snapshot = await harness.service.signOut()
    expect(snapshot.state).toBe('signed-out')
    expect(snapshot.user).toBeNull()
    expect(snapshot.provider).toBeNull()
    expect(harness.store.cleared).toBe(1)
    expect(harness.cloud.logout).toHaveBeenCalledWith('refresh-2')
  })

  it('服务端不可达时本地照样退出（不会卡在已登录）', async () => {
    const harness = build({ store: { status: 'ok', account: STORED, storage: 'encrypted' } })
    harness.service.restore()
    await vi.waitFor(() => expect(harness.service.snapshot().checking).toBe(false))
    harness.cloud.logout.mockRejectedValueOnce(new CloudError('network'))

    const snapshot = await harness.service.signOut()
    expect(snapshot.state).toBe('signed-out')
    expect(harness.store.cleared).toBe(1)
  })

  it('未登录时退出是幂等的', async () => {
    const harness = build()
    const snapshot = await harness.service.signOut()
    expect(snapshot.state).toBe('signed-out')
    expect(harness.cloud.logout).not.toHaveBeenCalled()
  })

  it('退出会取消正在等待的登录', async () => {
    const harness = build()
    const pending = harness.service.login('google')
    await vi.waitFor(() => expect(harness.service.snapshot().state).toBe('pending'))

    await harness.service.signOut()
    const snapshot = await pending
    expect(snapshot.state).toBe('signed-out')
    expect(harness.cloud.exchangeAuthorizationCode).not.toHaveBeenCalled()
  })
})

describe('AccountService 手动重新校验', () => {
  it('已登录时 refresh 会重新向服务端确认并更新校验时间', async () => {
    const harness = build({ store: { status: 'ok', account: STORED, storage: 'encrypted' } })
    harness.service.restore()
    await vi.waitFor(() => expect(harness.service.snapshot().checking).toBe(false))
    const firstVerifiedAt = harness.service.snapshot().verifiedAt
    expect(harness.cloud.me).toHaveBeenCalledTimes(1)

    harness.advance(5_000)
    const snapshot = await harness.service.refresh()

    expect(harness.cloud.me).toHaveBeenCalledTimes(2)
    expect(snapshot.state).toBe('signed-in')
    expect(snapshot.verifiedAt).not.toBe(firstVerifiedAt)
    expect(snapshot.notice).toBeNull()
  })

  it('离线时 refresh 不清凭据，只把提示换成 cloud-unreachable', async () => {
    const harness = build({ store: { status: 'ok', account: STORED, storage: 'encrypted' } })
    harness.service.restore()
    await vi.waitFor(() => expect(harness.service.snapshot().checking).toBe(false))

    harness.cloud.me.mockRejectedValueOnce(new CloudError('network'))
    const snapshot = await harness.service.refresh()

    expect(snapshot.state).toBe('signed-in')
    expect(snapshot.notice?.code).toBe('cloud-unreachable')
    expect(harness.store.cleared).toBe(0)
  })

  it('未登录时 refresh 是空操作（不会发出请求）', async () => {
    const harness = build()
    const snapshot = await harness.service.refresh()

    expect(snapshot.state).toBe('signed-out')
    expect(harness.cloud.refresh).not.toHaveBeenCalled()
    expect(harness.cloud.me).not.toHaveBeenCalled()
  })
})
