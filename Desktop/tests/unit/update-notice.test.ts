import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../../src/shared/contracts'
import {
  UPDATE_DISMISSED_KEY,
  readDismissedUpdateVersion,
  rememberDismissedUpdateVersion,
  shouldAnnounceUpdate,
  shouldShowUpdateBanner
} from '../../src/renderer/src/features/update/update-notice'

/**
 * 提醒判定是纯函数：广播与启动 Promise 给的是同一份状态，所以「不重复提醒」
 * 靠的是「没有第二份状态」，而不是一个「弹过没有」的计数器。
 */

function state(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: 'available',
    currentVersion: '0.2.0',
    latestVersion: '0.2.1',
    percent: null,
    transferred: null,
    total: null,
    error: null,
    failedAt: null,
    autoUpdate: true,
    downloadUrl: null,
    releaseUrl: 'https://github.com/banmu123/BrewPhase/releases',
    checkedAt: 1_800_000_000_000,
    ...overrides
  }
}

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    }
  }
}

const throwingStorage: StorageLike = {
  getItem: () => {
    throw new Error('storage disabled')
  },
  setItem: () => {
    throw new Error('storage disabled')
  }
}

describe('shouldAnnounceUpdate', () => {
  it('能自动更新时，available 就提醒', () => {
    expect(shouldAnnounceUpdate(state(), null)).toBe(true)
  })

  it('不能自动更新但有手动下载地址时也提醒（开发态 / 元数据缺失的兜底）', () => {
    expect(
      shouldAnnounceUpdate(
        state({ autoUpdate: false, downloadUrl: 'https://github.com/banmu123/BrewPhase/releases' }),
        null
      )
    ).toBe(true)
  })

  it('既不能自动更新又没有下载地址时不提醒', () => {
    expect(shouldAnnounceUpdate(state({ autoUpdate: false, downloadUrl: null }), null)).toBe(false)
  })

  it('没有更新 / 检查失败 / 还没查过 / 下载中都不主动提醒', () => {
    expect(shouldAnnounceUpdate(state({ phase: 'up-to-date', latestVersion: null }), null)).toBe(false)
    expect(
      shouldAnnounceUpdate(
        state({ phase: 'error', failedAt: 'check', latestVersion: null, error: 'offline' }),
        null
      )
    ).toBe(false)
    expect(shouldAnnounceUpdate(null, null)).toBe(false)
    expect(shouldAnnounceUpdate(state({ phase: 'downloading' }), null)).toBe(false)
  })

  it('缺少版本号时不提醒', () => {
    expect(shouldAnnounceUpdate(state({ latestVersion: null }), null)).toBe(false)
  })

  it('暂缓过的相同版本不再提醒', () => {
    expect(shouldAnnounceUpdate(state(), '0.2.1')).toBe(false)
  })

  it('暂缓 0.2.0 后，0.2.1 仍然提醒', () => {
    expect(shouldAnnounceUpdate(state(), '0.2.0')).toBe(true)
  })

  it('已暂缓更高版本时，较低版本不回头打扰（0.2.10 > 0.2.9）', () => {
    expect(shouldAnnounceUpdate(state({ latestVersion: '0.2.9' }), '0.2.10')).toBe(false)
    expect(shouldAnnounceUpdate(state({ latestVersion: '0.2.10' }), '0.2.9')).toBe(true)
  })

  it('暂缓值带空白也能正确比较', () => {
    expect(shouldAnnounceUpdate(state(), ' 0.2.1 ')).toBe(false)
  })

  it('同一份状态连续判定两次都成立：去重靠单一状态，不靠内部计数', () => {
    const value = state()
    expect(shouldAnnounceUpdate(value, null)).toBe(true)
    expect(shouldAnnounceUpdate(value, null)).toBe(true)
  })
})

describe('shouldShowUpdateBanner', () => {
  it('提示阶段受「稍后提醒」控制', () => {
    expect(shouldShowUpdateBanner(state(), null)).toBe(true)
    expect(shouldShowUpdateBanner(state(), '0.2.1')).toBe(false)
  })

  it('下载 / 安装阶段必须继续展示进度，哪怕这个版本被暂缓过', () => {
    for (const phase of ['downloading', 'downloaded', 'installing'] as const) {
      expect(shouldShowUpdateBanner(state({ phase }), '0.2.1')).toBe(true)
    }
  })

  it('只有「下载失败」才留在横幅上；检查失败不弹', () => {
    expect(shouldShowUpdateBanner(state({ phase: 'error', failedAt: 'download' }), null)).toBe(true)
    expect(shouldShowUpdateBanner(state({ phase: 'error', failedAt: 'check' }), null)).toBe(false)
  })

  it('没有状态 / 已是最新 / 还没查过时都不显示', () => {
    expect(shouldShowUpdateBanner(null, null)).toBe(false)
    expect(shouldShowUpdateBanner(state({ phase: 'up-to-date' }), null)).toBe(false)
    expect(shouldShowUpdateBanner(state({ phase: 'idle' }), null)).toBe(false)
  })
})

describe('暂缓版本持久化', () => {
  it('写入后能读回，且只存版本号这一个键', () => {
    const store = fakeStorage()
    rememberDismissedUpdateVersion('0.2.1', store)
    expect(store.data.get(UPDATE_DISMISSED_KEY)).toBe('0.2.1')
    expect(store.data.size).toBe(1)
    expect(readDismissedUpdateVersion(store)).toBe('0.2.1')
  })

  it('写入前去掉空白；空串不写入', () => {
    const store = fakeStorage()
    rememberDismissedUpdateVersion(' 0.2.1 ', store)
    expect(readDismissedUpdateVersion(store)).toBe('0.2.1')

    const untouched = fakeStorage()
    rememberDismissedUpdateVersion('   ', untouched)
    expect(untouched.data.size).toBe(0)
  })

  it('没有存储 / 存储不可用时静默降级，不抛错', () => {
    expect(readDismissedUpdateVersion(null)).toBeNull()
    expect(() => rememberDismissedUpdateVersion('0.2.1', null)).not.toThrow()
    expect(readDismissedUpdateVersion(throwingStorage)).toBeNull()
    expect(() => rememberDismissedUpdateVersion('0.2.1', throwingStorage)).not.toThrow()
  })

  it('读到的值直接喂给判定即可生效（记忆与判定同一份语义）', () => {
    const store = fakeStorage()
    rememberDismissedUpdateVersion('0.2.1', store)
    const dismissed = readDismissedUpdateVersion(store)
    expect(shouldAnnounceUpdate(state(), dismissed)).toBe(false)
    expect(shouldAnnounceUpdate(state({ latestVersion: '0.2.2' }), dismissed)).toBe(true)
  })
})
