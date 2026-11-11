import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../../src/main/database/migrations'
import { schema } from '../../src/main/database/schema'
import type { Db } from '../../src/main/database/client'
import { BrowserManager } from '../../src/main/browser/browser-manager'
import { recordBrowserVisit } from '../../src/main/browser/history-store'

/**
 * BrowserManager 的恢复语义。
 *
 * 这里用 Electron 替身而不是真窗口：要验证的不是 Chromium 怎么渲染，而是
 * **恢复操作有没有再次触发导航**。替身把 `loadURL` 的调用记成数组，`showCurrentPage`
 * 之后长度不变就是「没有重新加载」的直接证据；`webContents.id` 不变则说明
 * 容器没有被销毁重建。
 */

const fake = vi.hoisted(() => {
  const views: Array<{
    webContents: FakeWebContents
    visible: boolean
    bounds: unknown
    setBackgroundColor: () => void
    setBounds: (bounds: unknown) => void
    setBorderRadius: () => void
    setVisible: (value: boolean) => void
  }> = []
  const loadCalls: string[] = []
  let nextId = 0

  const session = {
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    on: () => undefined
  }

  class FakeWebContents {
    readonly id: number
    destroyed = false
    loading = false
    url = ''
    title = ''
    session = session
    navigationHistory = { getActiveIndex: () => 0, getAllEntries: () => [] as unknown[] }
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor() {
      this.id = ++nextId
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }

    loadURL(url: string): Promise<void> {
      loadCalls.push(url)
      this.url = url
      this.loading = true
      // 只到「开始加载」：`did-navigate` 由具体用例按需触发，否则测不出加载中。
      this.emit('did-start-loading')
      return Promise.resolve()
    }

    isLoading(): boolean {
      return this.loading
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    getTitle(): string {
      return this.title
    }

    stop(): void {
      this.loading = false
    }

    close(): void {
      this.destroyed = true
    }

    reload(): void {
      loadCalls.push(this.url)
    }

    setWindowOpenHandler(): void {
      // no-op
    }

    executeJavaScript(): Promise<unknown> {
      return Promise.resolve(undefined)
    }
  }

  class FakeView {
    webContents = new FakeWebContents()
    visible = false
    bounds: unknown = null

    constructor() {
      views.push(this)
    }

    setBackgroundColor(): void {
      // no-op
    }

    setBounds(bounds: unknown): void {
      this.bounds = bounds
    }

    setBorderRadius(): void {
      // no-op
    }

    setVisible(value: boolean): void {
      this.visible = value
    }
  }

  const window = {
    id: 1,
    isDestroyed: () => false,
    getContentSize: (): [number, number] => [1280, 800],
    contentView: { addChildView: () => undefined },
    webContents: { send: () => undefined }
  }

  return {
    views,
    loadCalls,
    session,
    window,
    WebContentsView: FakeView,
    reset: () => {
      views.length = 0
      loadCalls.length = 0
    }
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => fake.session },
  shell: { openExternal: () => undefined },
  WebContentsView: fake.WebContentsView
}))

describe('BrowserManager 起始页与恢复', () => {
  let dir = ''
  let sqlite: Database.Database
  let db: Db
  let manager: InstanceType<typeof BrowserManager>

  beforeEach(() => {
    fake.reset()
    dir = mkdtempSync(join(tmpdir(), 'bp-browser-manager-'))
    sqlite = new Database(join(dir, 'brewphase.db'))
    sqlite.pragma('foreign_keys = ON')
    migrate(sqlite)
    db = drizzle(sqlite, { schema })
    manager = new BrowserManager({
      db,
      getWindow: () => fake.window as never
    })
  })

  afterEach(() => {
    manager.dispose()
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('场景 A：从起始页恢复同一个 WebContentsView，URL 不变', () => {
    // 渲染层打开浮窗后会把 stage 的矩形报上来；没有有效矩形时原生层不绘制。
    manager.setBounds({ x: 40, y: 40, width: 900, height: 600 })
    const opened = manager.navigate('https://a.example/')
    expect(opened.startPage).toBe(false)
    expect(fake.views).toHaveLength(1)
    const view = fake.views[0]!
    expect(view.visible).toBe(true)

    const start = manager.showStart()
    expect(start.startPage).toBe(true)
    expect(view.visible).toBe(false)

    const restored = manager.showCurrentPage()
    expect(restored.startPage).toBe(false)
    expect(restored.url).toBe('https://a.example/')
    expect(view.visible).toBe(true)
    expect(fake.views).toHaveLength(1)
  })

  it('场景 B：恢复不触发 loadURL / 不产生新的容器', () => {
    manager.navigate('https://a.example/')
    expect(fake.loadCalls).toEqual(['https://a.example/'])
    const id = fake.views[0]!.webContents.id

    manager.showStart()
    manager.showCurrentPage()
    manager.showStart()
    manager.showCurrentPage()

    // 只有最初那一次导航；恢复多少次都不会再调 loadURL。
    expect(fake.loadCalls).toEqual(['https://a.example/'])
    expect(fake.views).toHaveLength(1)
    expect(fake.views[0]!.webContents.id).toBe(id)
  })

  it('场景 C：没有网页时恢复是安全的空操作', () => {
    const before = fake.views.length
    const state = manager.showCurrentPage()

    expect(state.startPage).toBe(true)
    expect(state.url).toBe('')
    expect(fake.views).toHaveLength(before)
    expect(fake.loadCalls).toEqual([])
  })

  it('场景 D：加载中回起始页再恢复，加载态反映真实状态且不重复加载', () => {
    manager.navigate('https://slow.example/')
    const view = fake.views[0]!
    // 起始页期间网页仍在加载：事件照常到达主进程。
    manager.showStart()
    expect(manager.state().loading).toBe(true)

    const restored = manager.showCurrentPage()
    expect(restored.loading).toBe(true)
    expect(restored.progress).toBeLessThan(1)

    // 后台加载完成 → 恢复后状态是「已完成」。
    view.webContents.loading = false
    view.webContents.emit('did-stop-loading')
    manager.showStart()
    const done = manager.showCurrentPage()
    expect(done.loading).toBe(false)
    expect(done.progress).toBe(1)
    expect(fake.loadCalls).toEqual(['https://slow.example/'])
  })

  it('起始页不清错误：加载失败后回起始页，恢复仍显示错误', () => {
    manager.navigate('https://missing.example/')
    const view = fake.views[0]!
    view.webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://missing.example/', true)

    const start = manager.showStart()
    expect(start.startPage).toBe(true)
    expect(start.error).not.toBeNull()

    const restored = manager.showCurrentPage()
    expect(restored.startPage).toBe(false)
    expect(restored.error).not.toBeNull()
    // 错误页由 React 画，原生层必须让开。
    expect(view.visible).toBe(false)
  })

  it('view 被销毁后恢复不会重建，也不会导航', () => {
    manager.navigate('https://a.example/')
    const view = fake.views[0]!
    view.webContents.close()

    const restored = manager.showCurrentPage()
    expect(restored.startPage).toBe(true)
    expect(fake.views).toHaveLength(1)
    expect(fake.loadCalls).toEqual(['https://a.example/'])
  })

  it('打开浮窗不自动跳上次访问：直接停在起始页（书签可见）', () => {
    recordBrowserVisit(db, 'https://last.example/', '上次的网页')
    // recent 在构造时读入，重建一次才能拿到刚写进去的那条。
    manager.dispose()
    manager = new BrowserManager({ db, getWindow: () => fake.window as never })

    const opened = manager.open()

    expect(opened.startPage).toBe(true)
    expect(opened.url).toBe('')
    // 起始页完全由 React 画：不建容器、不发导航。
    expect(fake.views).toHaveLength(0)
    expect(fake.loadCalls).toEqual([])
    // 上次地址仍在，供起始页的「继续上次访问」使用。
    expect(opened.lastVisit?.url).toBe('https://last.example/')
  })

  it('关闭后重开停在起始页，不重新加载上次地址', () => {
    manager.navigate('https://a.example/')
    manager.close()

    const reopened = manager.open()

    expect(reopened.startPage).toBe(true)
    expect(reopened.url).toBe('')
    expect(fake.loadCalls).toEqual(['https://a.example/'])
    expect(fake.views[0]!.visible).toBe(false)
  })

  it('隐藏后重新打开恢复当前网页，不重新加载也不换容器', () => {
    manager.setBounds({ x: 40, y: 40, width: 900, height: 600 })
    manager.navigate('https://keep.example/')
    const view = fake.views[0]!
    const id = view.webContents.id

    manager.hide()
    expect(view.visible).toBe(false)

    const reopened = manager.open()

    expect(reopened.startPage).toBe(false)
    expect(reopened.url).toBe('https://keep.example/')
    expect(view.visible).toBe(true)
    expect(fake.views).toHaveLength(1)
    expect(fake.views[0]!.webContents.id).toBe(id)
    expect(fake.loadCalls).toEqual(['https://keep.example/'])
  })
})
