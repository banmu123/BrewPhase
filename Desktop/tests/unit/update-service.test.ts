import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdaterAdapter, UpdaterHandlers, UpdaterProgress } from '../../src/main/update/updater'

/**
 * 状态机的单元测试：用一个假 adapter 完整走「检查 → 下载 → 进度 → 安装」。
 *
 * 真实安装（Squirrel / NSIS）没法在单测里跑，也不该跑——这里验证的是
 * **调用顺序与状态收敛**：检查不会下载、重复点击不会重复下载、安装前一定
 * 先做完收尾、失败停在可重试的位置。
 */

vi.mock('electron', () => ({
  app: { getVersion: () => '0.2.0' },
  net: {
    fetch: async () => {
      throw new Error('net.fetch should not be called in unit tests')
    }
  }
}))

const { UpdateService, createReleaseDiscovery } = await import(
  '../../src/main/update/update-service'
)
type UpdateDiscoveryResult = import('../../src/main/update/update-service').UpdateDiscoveryResult

type FakeMode = 'available' | 'up-to-date' | 'throw' | 'error-event'

function createFakeAdapter(options: { supported?: boolean; mode?: FakeMode } = {}) {
  let handlers: UpdaterHandlers | null = null
  const calls = { check: 0, download: 0, install: 0 }
  const adapter: UpdaterAdapter = {
    supported: options.supported ?? true,
    bind(next) {
      handlers = next
    },
    async check() {
      calls.check += 1
      if (!handlers) throw new Error('adapter not bound')
      switch (options.mode ?? 'available') {
        case 'available':
          handlers.available({ version: '0.2.1' })
          break
        case 'up-to-date':
          handlers.notAvailable()
          break
        case 'error-event':
          handlers.error(new Error('latest-mac.yml not found'))
          break
        case 'throw':
          throw new Error('app-update.yml missing')
      }
    },
    async download() {
      calls.download += 1
    },
    quitAndInstall() {
      calls.install += 1
    }
  }
  const emit = {
    progress(progress: UpdaterProgress) {
      handlers?.progress(progress)
    },
    downloaded(version = '0.2.1') {
      handlers?.downloaded({ version })
    },
    error(message = 'download failed') {
      handlers?.error(new Error(message))
    },
    available(version = '0.2.1') {
      handlers?.available({ version })
    }
  }
  return { adapter, calls, emit }
}

const UP_TO_DATE: UpdateDiscoveryResult = { status: 'up-to-date' }
const MANUAL_AVAILABLE: UpdateDiscoveryResult = {
  status: 'available',
  version: '0.2.1',
  downloadUrl:
    'https://github.com/banmu123/BrewPhase/releases/download/desktop-v0.2.1/BrewPhase-0.2.1-mac-arm64.dmg',
  releaseUrl: 'https://github.com/banmu123/BrewPhase/releases/tag/desktop-v0.2.1'
}

function createService(
  options: {
    supported?: boolean
    mode?: FakeMode
    discover?: () => Promise<UpdateDiscoveryResult>
  } = {}
) {
  const fake = createFakeAdapter(options)
  const service = new UpdateService({
    currentVersion: '0.2.0',
    adapter: fake.adapter,
    discover: options.discover ?? (async () => UP_TO_DATE)
  })
  return { service, fake }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('UpdateService：检查', () => {
  it('打包版用 electron-updater 检查，available 后不会自动下载', async () => {
    const { service, fake } = createService()
    const state = await service.check()
    expect(fake.calls.check).toBe(1)
    expect(state.phase).toBe('available')
    expect(state.latestVersion).toBe('0.2.1')
    expect(state.autoUpdate).toBe(true)
    // 关键：检查阶段绝不下载。
    expect(fake.calls.download).toBe(0)
    expect(fake.calls.install).toBe(0)
  })

  it('没有新版本时落成 up-to-date', async () => {
    const { service } = createService({ mode: 'up-to-date' })
    expect((await service.check()).phase).toBe('up-to-date')
  })

  it('24 小时内复用结果，force 才重新检查（手动按钮）', async () => {
    const { service, fake } = createService()
    await service.check()
    await service.check()
    expect(fake.calls.check).toBe(1)
    await service.check({ force: true })
    expect(fake.calls.check).toBe(2)
  })

  it('检查失败后 5 分钟自动重试（不再等 24 小时整点）', async () => {
    vi.useFakeTimers()
    try {
      // error-event 模式 + 兜底发现也失败（GitHub API 也挂）→ fail('check')。
      // 真实世界对应：网络抖动让两条通道同时失败——修复前要等 24h 才重试。
      const { service, fake } = createService({
        mode: 'error-event',
        discover: async () => ({ status: 'error', reason: 'HTTP 403' })
      })
      service.startAutoCheck()
      // 启动延迟 8s：第一次自动检查失败
      await vi.advanceTimersByTimeAsync(8_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(service.snapshot.phase).toBe('error')
      const failedCalls = fake.calls.check

      // 快进 4 分钟：不应重试（间隔是 5 分钟）
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      expect(fake.calls.check).toBe(failedCalls)

      // 快进到 5 分钟：自动重试发生（adapter.check 再被调用）
      await vi.advanceTimersByTimeAsync(1 * 60_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.calls.check).toBeGreaterThan(failedCalls)
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it('下载进行中不接受新的检查', async () => {
    const { service, fake } = createService()
    await service.check()
    await service.download()
    await service.check({ force: true })
    expect(fake.calls.check).toBe(1)
    expect(service.snapshot.phase).toBe('downloading')
  })

  it('electron-updater 报错（元数据缺失）时用 GitHub API 兜底成「可手动下载」', async () => {
    const fake = createFakeAdapter({ mode: 'error-event' })
    const service = new UpdateService({
      currentVersion: '0.2.0',
      adapter: fake.adapter,
      discover: async () => MANUAL_AVAILABLE
    })
    const state = await service.check()
    expect(state.phase).toBe('available')
    expect(state.autoUpdate).toBe(false)
    expect(state.downloadUrl).toContain('BrewPhase-0.2.1-mac-arm64.dmg')
    // 不能自动更新的构建里，download() 不会触发真实下载。
    await service.download()
    expect(fake.calls.download).toBe(0)
  })

  it('不支持自动更新的构建（开发态）走发现逻辑；发现失败则停在 error', async () => {
    const available = new UpdateService({
      currentVersion: '0.2.0',
      adapter: createFakeAdapter({ supported: false }).adapter,
      discover: async () => MANUAL_AVAILABLE
    })
    const state = await available.check()
    expect(state.autoUpdate).toBe(false)
    expect(state.phase).toBe('available')

    const failing = new UpdateService({
      currentVersion: '0.2.0',
      adapter: createFakeAdapter({ supported: false }).adapter,
      discover: async () => ({ status: 'error', reason: 'HTTP 403' })
    })
    const failed = await failing.check()
    expect(failed.phase).toBe('error')
    expect(failed.failedAt).toBe('check')
    expect(failed.error).toBe('HTTP 403')
  })

  it('当前版本始终取自运行时并规范化', async () => {
    const service = new UpdateService({
      currentVersion: ' v0.2.0 ',
      adapter: createFakeAdapter({ mode: 'up-to-date' }).adapter
    })
    expect((await service.check()).currentVersion).toBe('0.2.0')
  })
})

describe('UpdateService：下载与安装', () => {
  it('点「立即更新」才下载；进度只来自真实事件', async () => {
    const { service, fake } = createService()
    await service.check()
    const pending = service.download()
    expect(service.snapshot.phase).toBe('downloading')
    expect(service.snapshot.percent).toBe(0)

    fake.emit.progress({ percent: 42.6, transferred: 4_200_000, total: 10_000_000 })
    expect(service.snapshot.percent).toBe(43)
    expect(service.snapshot.transferred).toBe(4_200_000)
    expect(service.snapshot.total).toBe(10_000_000)

    await pending
    expect(fake.calls.download).toBe(1)
  })

  it('重复点击不会重复下载（同一时间只有一个任务）', async () => {
    const { service, fake } = createService()
    await service.check()
    const first = service.download()
    await service.download()
    await service.download()
    await first
    expect(fake.calls.download).toBe(1)
  })

  it('下载完成后先收尾再安装（顺序固定）', async () => {
    const order: string[] = []
    const fake = createFakeAdapter()
    const service = new UpdateService({
      currentVersion: '0.2.0',
      adapter: fake.adapter,
      installDelayMs: 1,
      prepareForInstall: async () => {
        order.push('flush-db')
        await Promise.resolve()
        order.push('db-closed')
      }
    })
    await service.check()
    await service.download()
    fake.emit.downloaded('0.2.1')
    expect(service.snapshot.phase).toBe('downloaded')

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['flush-db', 'db-closed'])
    expect(fake.calls.install).toBe(1)
    expect(service.snapshot.phase).toBe('installing')
  })

  it('收尾失败时不安装，停在可重试的错误上', async () => {
    const fake = createFakeAdapter()
    const service = new UpdateService({
      currentVersion: '0.2.0',
      adapter: fake.adapter,
      installDelayMs: 1,
      prepareForInstall: () => {
        throw new Error('db busy')
      }
    })
    await service.check()
    await service.download()
    fake.emit.downloaded('0.2.1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.calls.install).toBe(0)
    expect(service.snapshot.phase).toBe('error')
    expect(service.snapshot.failedAt).toBe('download')
    expect(service.snapshot.error).toBe('db busy')
  })

  it('下载失败保留版本号，可以重试', async () => {
    const { service, fake } = createService()
    await service.check()
    await service.download()
    fake.emit.error('socket hang up')
    expect(service.snapshot.phase).toBe('error')
    expect(service.snapshot.failedAt).toBe('download')
    expect(service.snapshot.latestVersion).toBe('0.2.1')

    await service.download()
    expect(fake.calls.download).toBe(2)
    expect(service.snapshot.phase).toBe('downloading')
  })

  it('下载失败不影响当前版本', async () => {
    const { service, fake } = createService()
    await service.check()
    await service.download()
    fake.emit.error('disk full')
    expect(service.snapshot.currentVersion).toBe('0.2.0')
    expect(service.snapshot.phase).toBe('error')
  })

  it('每次状态变化都广播，最后一条与 snapshot 一致', async () => {
    const broadcast = vi.fn()
    const fake = createFakeAdapter()
    const service = new UpdateService({ currentVersion: '0.2.0', adapter: fake.adapter, broadcast })
    await service.check()
    await service.download()
    fake.emit.progress({ percent: 10, transferred: 1, total: 10 })
    expect(broadcast.mock.calls.at(-1)?.[0]).toEqual(service.snapshot)
    expect(broadcast.mock.calls.length).toBeGreaterThanOrEqual(4)
  })
})

describe('createReleaseDiscovery', () => {
  it('HTTP 错误与异常都归成 error（不抛出）', async () => {
    const failing = createReleaseDiscovery({
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
    })
    expect(await failing()).toEqual({ status: 'error', reason: 'HTTP 503' })

    const throwing = createReleaseDiscovery({
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: async () => {
        throw new Error('offline')
      }
    })
    expect(await throwing()).toEqual({ status: 'error', reason: 'offline' })
  })

  it('没有可更新版本时返回 up-to-date', async () => {
    const discover = createReleaseDiscovery({
      currentVersion: '0.2.0',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] })
    })
    expect(await discover()).toEqual({ status: 'up-to-date' })
  })
})
