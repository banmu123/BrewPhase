import { describe, expect, it } from 'vitest'
import type { UpdateCheckResult } from '../../src/shared/contracts'
import {
  UPDATE_DISMISSED_KEY,
  readDismissedUpdateVersion,
  rememberDismissedUpdateVersion,
  shouldAnnounceUpdate
} from '../../src/renderer/src/features/update/update-notice'

/**
 * 提醒判定是纯函数：广播与启动 Promise 给的是同一份结果，所以「不重复提醒」
 * 靠的是「没有第二份状态」，而不是一个「弹过没有」的计数器。
 */

function result(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    status: 'available',
    currentVersion: '0.2.0',
    latestVersion: '0.2.1',
    releaseUrl: 'https://github.com/banmu123/BrewPhase/releases/tag/desktop-v0.2.1',
    downloadUrl:
      'https://github.com/banmu123/BrewPhase/releases/download/desktop-v0.2.1/BrewPhase-0.2.1-mac-arm64.dmg',
    publishedAt: '2026-11-27T00:00:00Z',
    checkedAt: 1_800_000_000_000,
    reason: null,
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
  it('有新版本、有本平台安装包时提醒', () => {
    expect(shouldAnnounceUpdate(result(), null)).toBe(true)
  })

  it('没有更新 / 检查失败 / 还没查过都不提醒', () => {
    expect(shouldAnnounceUpdate(result({ status: 'up-to-date', latestVersion: null, downloadUrl: null }), null)).toBe(false)
    expect(shouldAnnounceUpdate(result({ status: 'unavailable', latestVersion: null, downloadUrl: null, reason: 'offline' }), null)).toBe(false)
    expect(shouldAnnounceUpdate(null, null)).toBe(false)
  })

  it('缺少版本号或本平台资产时不提醒（不给出点了也下不了的入口）', () => {
    expect(shouldAnnounceUpdate(result({ latestVersion: null }), null)).toBe(false)
    expect(shouldAnnounceUpdate(result({ downloadUrl: null }), null)).toBe(false)
  })

  it('暂缓过的相同版本不再提醒', () => {
    expect(shouldAnnounceUpdate(result(), '0.2.1')).toBe(false)
  })

  it('暂缓 0.2.0 后，0.2.1 仍然提醒', () => {
    expect(shouldAnnounceUpdate(result(), '0.2.0')).toBe(true)
  })

  it('已暂缓更高版本时，较低版本不回头打扰（0.2.10 > 0.2.9）', () => {
    expect(shouldAnnounceUpdate(result({ latestVersion: '0.2.9' }), '0.2.10')).toBe(false)
    expect(shouldAnnounceUpdate(result({ latestVersion: '0.2.10' }), '0.2.9')).toBe(true)
  })

  it('暂缓值带空白也能正确比较', () => {
    expect(shouldAnnounceUpdate(result(), ' 0.2.1 ')).toBe(false)
  })

  it('同一份结果连续判定两次都成立：去重靠单一状态，不靠内部计数', () => {
    const value = result()
    expect(shouldAnnounceUpdate(value, null)).toBe(true)
    expect(shouldAnnounceUpdate(value, null)).toBe(true)
  })

  it('最小可提醒结果不需要 releaseUrl 之外的东西（判定只看四项）', () => {
    const minimal = result({ releaseUrl: 'https://github.com/banmu123/BrewPhase/releases' })
    expect(shouldAnnounceUpdate(minimal, null)).toBe(true)
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

  it('键只放版本号，不掺业务数据', () => {
    const store = fakeStorage()
    rememberDismissedUpdateVersion('0.2.1', store)
    expect(UPDATE_DISMISSED_KEY).toBe('brewphase.desktop.update.dismissedVersion')
    expect(readDismissedUpdateVersion(store)).not.toMatch(/[{}[\]]/)
  })

  it('读到的值直接喂给判定即可生效（记忆与判定同一份语义）', () => {
    const store = fakeStorage()
    rememberDismissedUpdateVersion('0.2.1', store)
    const dismissed = readDismissedUpdateVersion(store)
    expect(shouldAnnounceUpdate(result(), dismissed)).toBe(false)
    expect(shouldAnnounceUpdate(result({ latestVersion: '0.2.2' }), dismissed)).toBe(true)
  })
})
