import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyInitialTheme,
  applyTheme,
  isThemePreference,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  subscribeSystemTheme,
  systemPrefersDark,
  THEME_STORAGE_KEY,
  type ThemePreference
} from '../../src/renderer/src/shared/theme'

/**
 * 外观解析与持久化。
 *
 * 这里的每一条都对着一个会「让用户觉得设置没生效」的具体场景：
 * 存进去读不出来、选了深色却被系统改回去、非法值把界面卡成黑白。
 */

type FakeRoot = {
  dataset: Record<string, string>
  style: Record<string, string>
}

type FakeWindow = {
  matchMedia?: (query: string) => {
    matches: boolean
    addEventListener?: (type: string, listener: (event: { matches: boolean }) => void) => void
    removeEventListener?: (type: string, listener: (event: { matches: boolean }) => void) => void
    addListener?: (listener: (event: { matches: boolean }) => void) => void
    removeListener?: (listener: (event: { matches: boolean }) => void) => void
  }
}

function installDom(): { root: FakeRoot } {
  const root: FakeRoot = { dataset: {}, style: {} }
  const globals = globalThis as unknown as { document?: unknown }
  globals.document = { documentElement: root }
  return { root }
}

function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial))
  ;(globalThis as unknown as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  }
  return store
}

/** 系统外观的打桩：返回一个能手动触发的 matchMedia。 */
function installSystemTheme(matches: boolean): { emit: (dark: boolean) => void } {
  const listeners = new Set<(event: { matches: boolean }) => void>()
  const fakeWindow: FakeWindow = {
    matchMedia: () => ({
      matches,
      addEventListener: (type, listener) => {
        if (type === 'change') listeners.add(listener)
      },
      removeEventListener: (type, listener) => {
        if (type === 'change') listeners.delete(listener)
      }
    })
  }
  ;(globalThis as unknown as { window?: unknown }).window = fakeWindow
  return { emit: (dark) => listeners.forEach((listener) => listener({ matches: dark })) }
}

const originalDocument = (globalThis as unknown as { document?: unknown }).document
const originalWindow = (globalThis as unknown as { window?: unknown }).window
const originalStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage

beforeEach(() => {
  installDom()
  installStorage()
})

afterEach(() => {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.document = originalDocument
  globals.window = originalWindow
  globals.localStorage = originalStorage
  vi.restoreAllMocks()
})

describe('isThemePreference', () => {
  it('只认三个已定义的档位', () => {
    for (const value of ['system', 'light', 'dark']) {
      expect(isThemePreference(value)).toBe(true)
    }
    for (const value of ['', 'Dark', 'auto', null, 1, undefined]) {
      expect(isThemePreference(value)).toBe(false)
    }
  })
})

describe('resolveTheme', () => {
  it('手动选浅色/深色时不看系统', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('跟随系统时按系统解析', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('持久化', () => {
  it('存进去能读回来', () => {
    storeTheme('dark')
    expect(readStoredTheme()).toBe('dark')
    expect(readStoredTheme()).not.toBe('system')
  })

  it('存储里是脏值时按「没选过」处理，退回系统', () => {
    installStorage({ [THEME_STORAGE_KEY]: 'neon' })
    expect(readStoredTheme()).toBeNull()
  })

  it('localStorage 抛错时不影响当前会话', () => {
    ;(globalThis as unknown as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    expect(readStoredTheme()).toBeNull()
    expect(() => storeTheme('dark')).not.toThrow()
  })
})

describe('applyTheme', () => {
  it('把解析结果写到根元素，并带上 color-scheme', () => {
    const { root } = installDom()
    applyTheme('dark')
    expect(root.dataset.theme).toBe('dark')
    // color-scheme 决定原生滚动条与输入框，漏了它深色界面里会插进一条亮条。
    expect(root.style.colorScheme).toBe('dark')
  })
})

describe('applyInitialTheme', () => {
  it('没存过时跟随系统', () => {
    installSystemTheme(true)
    const result = applyInitialTheme()
    expect(result.preference).toBe('system')
    expect(result.theme).toBe('dark')
  })

  it('存过就以用户选择为准，哪怕系统相反', () => {
    installSystemTheme(true)
    storeTheme('light')
    const result = applyInitialTheme()
    expect(result.preference).toBe<ThemePreference>('light')
    expect(result.theme).toBe('light')
  })
})

describe('系统外观', () => {
  it('没有 matchMedia 的环境按浅色处理，不抛错', () => {
    ;(globalThis as unknown as { window?: unknown }).window = {}
    expect(systemPrefersDark()).toBe(false)
    expect(typeof subscribeSystemTheme(() => {})).toBe('function')
  })

  it('系统变化时通知订阅者，取消后不再通知', () => {
    const system = installSystemTheme(false)
    const seen: boolean[] = []
    const unsubscribe = subscribeSystemTheme((dark) => seen.push(dark))

    system.emit(true)
    expect(seen).toEqual([true])

    unsubscribe()
    system.emit(false)
    expect(seen).toEqual([true])
  })
})
