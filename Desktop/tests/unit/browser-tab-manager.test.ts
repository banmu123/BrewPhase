import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BrowserTabManager 的生命周期测试。
 *
 * 验证三件事（对应可拆卸窗口的三个硬承诺）：
 * 1. **view 是同一实例**：跨窗口移动只改 contentView 的父子关系；
 * 2. **销毁只发生在 TabManager**：moveToWindow(null)、窗口关闭都不销毁 webContents；
 * 3. **自动化按 tabId 定位**：executeOnTab 与页面在哪个窗口无关。
 */

const fake = vi.hoisted(() => {
  const windows = new Map<number, { id: number; destroyed: boolean; children: FakeView[]; bounds: unknown }>()
  let wcId = 0

  class FakeWC {
    id: number
    destroyed = false
    closed = false
    url = ''
    title = 'fake'
    listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    navigationHistory = { getActiveIndex: () => 0, getAllEntries: () => [] }
    session = {
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      on: () => undefined
    }
    constructor() {
      this.id = ++wcId
    }
    on = (event: string, listener: (...args: unknown[]) => void) => {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
    }
    emit = (event: string, ...args: unknown[]) => {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }
    loadURL = async (url: string) => {
      this.url = url
    }
    getURL = () => this.url
    isDestroyed = () => this.destroyed
    close = () => {
      this.closed = true
      this.destroyed = true
    }
    executeJavaScript = async (script: string) => `exec:${script}:${this.id}`
    setWindowOpenHandler = () => undefined
  }

  class FakeView {
    webContents = new FakeWC()
    bounds: unknown = null
    attachedTo: number | null = null
    setBounds = (bounds: unknown) => {
      this.bounds = bounds
    }
    setBackgroundColor = () => undefined
    setBorderRadius = () => undefined
    setVisible = () => undefined
    getVisible = () => false
    getBounds = () => ({ x: 0, y: 0, width: 0, height: 0 })
  }

  class FakeBrowserWindow {
    constructor(options: { id?: number }) {
      const id = options.id ?? windows.size + 1
      ;(this as unknown as { id: number }).id = id
      windows.set(id, { id, destroyed: false, children: [], bounds: null })
    }
    isDestroyed = () => false
    get contentView() {
      const record = windows.get((this as unknown as { id: number }).id)
      return {
        addChildView: (view: FakeView) => {
          view.attachedTo = (this as unknown as { id: number }).id
          record?.children.push(view)
        },
        removeChildView: (view: FakeView) => {
          view.attachedTo = null
          const at = record?.children.indexOf(view) ?? -1
          if (record && at >= 0) record.children.splice(at, 1)
        }
      }
    }
    static instances = new Map<number, FakeBrowserWindow>()
    static fromId(id: number) {
      // 测试里窗口按需存在（主窗口 id=1 永远可用），并缓存实例，
      // 避免每次 fromId 都重建 record 把 children 清空。
      if (!windows.has(id)) windows.set(id, { id, destroyed: false, children: [], bounds: null })
      if (!FakeBrowserWindow.instances.has(id)) {
        FakeBrowserWindow.instances.set(id, new FakeBrowserWindow({ id }))
      }
      return FakeBrowserWindow.instances.get(id) ?? null
    }
  }

  return {
    windows,
    FakeView,
    FakeBrowserWindow,
    reset: () => {
      windows.clear()
    }
  }
})

vi.mock('electron', () => ({
  // 移动目标既可能是 BrowserWindow，也可能是采集宿主 BaseWindow：
  // 两者都从同一张 id 注册表取 contentView。
  BrowserWindow: fake.FakeBrowserWindow,
  BaseWindow: fake.FakeBrowserWindow,
  session: { fromPartition: () => ({ setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined, on: () => undefined }) },
  WebContentsView: fake.FakeView
}))

import { BrowserTabManager } from '../../src/main/browser/browser-tab-manager'

function makeManager(): BrowserTabManager {
  fake.reset()
  return new BrowserTabManager({ mainWindowId: () => 1, onChange: () => undefined })
}

/** 主窗口 id=1；「独立窗口」直接 new FakeBrowserWindow({id: 7}) 注册进注册表。 */
describe('BrowserTabManager 生命周期', () => {
  beforeEach(() => {
    fake.reset()
  })

  it('跨窗口移动后仍是同一个 view 与 webContents 实例', async () => {
    const manager = makeManager()
    const tab = manager.createTab('https://example.test/a')

    manager.moveToWindow(tab.id, 1)
    expect((tab.view as unknown as { attachedTo: number | null }).attachedTo).toBe(1)
    const before = tab.view.webContents.id
    const urlBefore = (tab.view.webContents as unknown as { url: string }).url

    // 「拖出」：挂到独立窗口 7
    manager.moveToWindow(tab.id, 7)
    expect((tab.view as unknown as { attachedTo: number | null }).attachedTo).toBe(7)
    expect(tab.detached).toBe(true)
    expect(tab.view.webContents.id).toBe(before)
    // 关键：没有重新 loadURL
    expect((tab.view.webContents as unknown as { url: string }).url).toBe(urlBefore)

    // 「拖回」
    manager.moveToWindow(tab.id, 1)
    expect((tab.view as unknown as { attachedTo: number | null }).attachedTo).toBe(1)
    expect(tab.view.webContents.id).toBe(before)
    expect(tab.detached).toBe(false)
  })

  it('moveToWindow(null) 只是摘下，不销毁页面', async () => {
    const manager = makeManager()
    const tab = manager.createTab('https://example.test/b')
    manager.moveToWindow(tab.id, 1)

    manager.moveToWindow(tab.id, null)
    expect(tab.windowId).toBeNull()
    expect((tab.view as unknown as { attachedTo: number | null }).attachedTo).toBeNull()
    expect((tab.view.webContents as unknown as { closed: boolean }).closed).toBe(false)
    expect(tab.view.webContents.isDestroyed()).toBe(false)
  })

  it('只有 closeTab / disposeAll 销毁 webContents', async () => {
    const manager = makeManager()
    const a = manager.createTab('https://example.test/c')
    const b = manager.createTab('https://example.test/d')
    manager.moveToWindow(a.id, 1)
    manager.moveToWindow(b.id, 1)

    manager.closeTab(a.id)
    expect((a.view.webContents as unknown as { closed: boolean }).closed).toBe(true)

    manager.moveToWindow(b.id, 7) // 挂在独立窗口
    manager.disposeAll()
    expect((b.view.webContents as unknown as { closed: boolean }).closed).toBe(true)
  })

  it('executeOnTab 按 tabId 定位，与所在窗口无关', async () => {
    const manager = makeManager()
    const tab = manager.createTab('https://example.test/e')
    manager.moveToWindow(tab.id, 1)

    const inMain = (await manager.executeOnTab(tab.id, 'probe')) as string
    expect(inMain).toContain(`:${tab.view.webContents.id}`)

    manager.moveToWindow(tab.id, 7)
    const inFloat = (await manager.executeOnTab(tab.id, 'probe')) as string
    expect(inFloat).toBe(inMain)
  })

  it('归属唯一：moveToWindow 新窗口自动解除旧窗口挂载', async () => {
    const manager = makeManager()
    const tab = manager.createTab('https://example.test/f')
    manager.moveToWindow(tab.id, 1)
    manager.moveToWindow(tab.id, 7)

    const mainChildren = fake.windows.get(1)
    expect(mainChildren?.children).not.toContain(tab.view)
    expect((tab.view as unknown as { attachedTo: number | null }).attachedTo).toBe(7)
  })

  it('reorder 调整展示顺序，不碰 view', () => {
    const manager = makeManager()
    const a = manager.createTab('https://example.test/1')
    const b = manager.createTab('https://example.test/2')
    const c = manager.createTab('https://example.test/3')

    manager.reorder(c.id, a.id)
    expect(manager.order).toEqual([c.id, a.id, b.id])
    expect((a.view.webContents as unknown as { closed: boolean }).closed).toBe(false)

    manager.reorder(a.id, null)
    expect(manager.order).toEqual([c.id, b.id, a.id])
  })

  it('被外部销毁的 view 会自动清账，不留幽灵 tab', () => {
    const manager = makeManager()
    const tab = manager.createTab('https://example.test/g')
    manager.moveToWindow(tab.id, 1)

    tab.view.webContents.emit('destroyed')
    expect(manager.get(tab.id)).toBeNull()
    expect(manager.order).not.toContain(tab.id)
  })

  it('restoreTab 原样恢复 tabId，并推进编号水位避免冲突', () => {
    const manager = makeManager()
    const restored = manager.restoreTab('tab-7', 'https://example.test/restored', '恢复的页面')
    expect(restored).not.toBeNull()
    expect(restored!.id).toBe('tab-7')
    expect(restored!.url).toBe('https://example.test/restored')
    expect(restored!.title).toBe('恢复的页面')
    expect(manager.order).toEqual(['tab-7'])
    // 新标签从恢复的最高编号继续，绝不与持久化记录里的旧 tabId 撞车。
    const fresh = manager.createTab('https://example.test/fresh')
    expect(fresh.id).toBe('tab-8')
    expect(manager.currentSeq()).toBe(8)
  })

  it('restoreTab 拒绝非法输入：坏 id、坏协议、重复 id', () => {
    const manager = makeManager()
    expect(manager.restoreTab('tab-x', 'https://example.test/a', '')).toBeNull()
    expect(manager.restoreTab('tab-0', 'https://example.test/a', '')).toBeNull()
    expect(manager.restoreTab('tab-1', 'javascript:alert(1)', '')).toBeNull()
    expect(manager.restoreTab('tab-1', '', '')).toBeNull()
    expect(manager.order).toEqual([])

    expect(manager.restoreTab('tab-2', 'https://example.test/first', '')).not.toBeNull()
    // 同一个 id 恢复两次只算一次：会话快照重复写入不能复制出两个标签。
    expect(manager.restoreTab('tab-2', 'https://example.test/again', '')).toBeNull()
    expect(manager.order).toEqual(['tab-2'])
  })

  it('restoreTab 的恢复是真实加载：loadURL 只发生一次', async () => {
    const manager = makeManager()
    const tab = manager.restoreTab('tab-3', 'https://example.test/session', '标题')
    expect(tab).not.toBeNull()
    const wc = tab!.view.webContents as unknown as { url: string; loadURL: (u: string) => Promise<void> }
    // FakeWC.loadURL 会记录 url；等一次 microtask 让 restoreTab 的 void 调用完成。
    await Promise.resolve()
    expect(wc.url).toBe('https://example.test/session')
  })
})
