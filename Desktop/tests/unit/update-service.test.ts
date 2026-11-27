import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_AUTO_CHECK_DELAY_MS,
  UPDATE_RELEASES_API,
  type ReleaseAsset,
  type ReleaseEntry
} from '../../src/shared/contracts/update'

/**
 * UpdateService 的默认版本来源必须是 Electron 的 `app.getVersion()`——
 * 它读的是 package.json（打包后是 Info.plist），不是任何硬编码副本。
 * 这里把 electron 换成假的，顺便证明：构造服务不联网、失败不抛给界面。
 */

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(() => '0.2.0')
}))

vi.mock('electron', () => ({
  app: { getVersion: mocks.getVersion },
  net: {
    fetch: async () => {
      throw new Error('net.fetch should not be used in tests')
    }
  }
}))

const { UpdateService } = await import('../../src/main/update/update-service')

type FetchParams = { headers: Record<string, string>; signal: AbortSignal }
type FetchResult = { ok: boolean; status: number; json: () => Promise<unknown> }

function respond(payload: unknown, init: { ok?: boolean; status?: number } = {}): FetchResult {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => payload
  }
}

const DOWNLOAD_BASE = 'https://github.com/banmu123/BrewPhase/releases/download/release'

function asset(version: string, suffix: string): ReleaseAsset {
  const name = `BrewPhase-${version}-${suffix}`
  return { name, browser_download_url: `${DOWNLOAD_BASE}/${name}` }
}

function release(version: string, overrides: Partial<ReleaseEntry> = {}): ReleaseEntry {
  return {
    tag_name: `desktop-v${version}`,
    html_url: `https://github.com/banmu123/BrewPhase/releases/tag/desktop-v${version}`,
    published_at: '2026-11-26T13:49:48Z',
    // 已正式发布：Stable 渠道要求这两个字段显式为 false。
    draft: false,
    prerelease: false,
    assets: [asset(version, 'mac-arm64.dmg'), asset(version, 'win-x64.exe')],
    ...overrides
  }
}

const V020: ReleaseEntry = release('0.2.0', { tag_name: 'v0.2.0' })

afterEach(() => {
  mocks.getVersion.mockReturnValue('0.2.0')
  vi.useRealTimers()
})

describe('UpdateService 版本来源', () => {
  it('未注入时使用 app.getVersion()，并以此版本去查/报', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: FetchParams) => respond([V020]))
    const service = new UpdateService({ fetchImpl })

    const result = await service.check()

    expect(mocks.getVersion).toHaveBeenCalled()
    expect(result.currentVersion).toBe('0.2.0')
    // 当前就是 0.2.0：同一个版本不能再次提示更新。
    expect(result.status).toBe('up-to-date')
    expect(result.latestVersion).toBeNull()
    expect(fetchImpl.mock.calls[0][0]).toBe(UPDATE_RELEASES_API)
    expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toBe('BrewPhase/0.2.0')
  })

  it('注入版本优先（测试/便携），空串视为未注入', async () => {
    const injected = new UpdateService({
      currentVersion: '0.1.4',
      fetchImpl: async () => respond([V020])
    })
    expect((await injected.check()).currentVersion).toBe('0.1.4')

    const blank = new UpdateService({ currentVersion: '  ', fetchImpl: async () => respond([V020]) })
    expect((await blank.check()).currentVersion).toBe('0.2.0')
  })
})

describe('UpdateService 检查结果', () => {
  it('0.1.4 能看到 v0.2.0 的正式版，并带上本平台安装包', async () => {
    const service = new UpdateService({
      currentVersion: '0.1.4',
      fetchImpl: async () => respond([V020])
    })
    const result = await service.check()
    expect(result.status).toBe('available')
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.downloadUrl).toContain('BrewPhase-0.2.0-')
    expect(result.releaseUrl).toContain('github.com')
    expect(result.checkedAt).toBeGreaterThan(0)
  })

  it('网络异常降级为 unavailable：不抛错，应用照常可用', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const service = new UpdateService({ currentVersion: '0.2.0', fetchImpl })

    // 构造服务本身不发起任何请求：启动路径不被联网阻塞。
    expect(fetchImpl).not.toHaveBeenCalled()

    const result = await service.check()
    expect(result.status).toBe('unavailable')
    expect(result.reason).toBe('network down')
    expect(result.latestVersion).toBeNull()
    expect(service.cached).toEqual(result)
    expect(service.lastCheckedAt).toBe(result.checkedAt)

    // 失败结果可以再次查询（设置页强制刷新），仍然不抛。
    await expect(service.check({ force: true })).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('HTTP 错误与损坏的 JSON 都只影响检查结果', async () => {
    const badStatus = new UpdateService({
      currentVersion: '0.2.0',
      fetchImpl: async () => respond(null, { ok: false, status: 500 })
    })
    expect((await badStatus.check()).reason).toBe('HTTP 500')

    const brokenBody = new UpdateService({
      currentVersion: '0.2.0',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('invalid json')
        }
      })
    })
    const result = await brokenBody.check()
    expect(result.status).toBe('unavailable')
    expect(result.reason).toBe('invalid json')
  })

  it('24 小时内复用缓存，force 才重新请求（设置页按钮）', async () => {
    let payload: ReleaseEntry[] = [V020]
    const fetchImpl = vi.fn(async () => respond(payload))
    const service = new UpdateService({ currentVersion: '0.2.0', fetchImpl })

    expect((await service.check()).status).toBe('up-to-date')
    expect((await service.check()).status).toBe('up-to-date')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    payload = [V020, release('0.2.1')]
    expect((await service.check({ force: true })).status).toBe('available')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('UpdateService 自动检查', () => {
  it('启动后延迟一次，重复调用不会叠加定时器', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async () => respond([V020]))
    const service = new UpdateService({ currentVersion: '0.2.0', fetchImpl })

    service.startAutoCheck()
    service.startAutoCheck()
    expect(fetchImpl).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(UPDATE_AUTO_CHECK_DELAY_MS)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    service.stopAutoCheck()
  })

  it('检查失败不会让定时器抛出未处理的拒绝', async () => {
    vi.useFakeTimers()
    const service = new UpdateService({
      currentVersion: '0.2.0',
      fetchImpl: async () => {
        throw new Error('offline')
      },
      broadcast: () => undefined
    })
    service.startAutoCheck()
    await vi.advanceTimersByTimeAsync(UPDATE_AUTO_CHECK_DELAY_MS)
    expect(service.cached?.status).toBe('unavailable')
    service.stopAutoCheck()
  })
})
