import { describe, expect, it } from 'vitest'
import {
  UPDATE_RELEASES_PAGE,
  compareVersions,
  isAllowedReleaseUrl,
  parseDesktopVersion,
  pickAssetUrl,
  selectUpdate,
  type ReleaseEntry
} from '../../src/shared/contracts/update'

describe('parseDesktopVersion', () => {
  it('只接受 desktop-vX.Y.Z', () => {
    expect(parseDesktopVersion('desktop-v0.1.2')).toBe('0.1.2')
    expect(parseDesktopVersion('desktop-v1.10.0')).toBe('1.10.0')
    expect(parseDesktopVersion(' desktop-v2.0 ')).toBe('2.0')
  })

  it('忽略其它 tag 与预发布后缀', () => {
    expect(parseDesktopVersion('v0.1.2')).toBeNull()
    expect(parseDesktopVersion('desktop-v0.1.2-beta')).toBeNull()
    expect(parseDesktopVersion('desktop-v')).toBeNull()
    expect(parseDesktopVersion('ios-v1.1')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('按数字段比较，不按字符串比较', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1)
    expect(compareVersions('0.2', '0.10')).toBe(-1)
  })

  it('缺位按 0，相等返回 0', () => {
    expect(compareVersions('0.1.2', '0.1.2')).toBe(0)
    expect(compareVersions('1', '1.0.0')).toBe(0)
  })
})

describe('isAllowedReleaseUrl', () => {
  it('只放行 GitHub 的 https 发布域', () => {
    expect(isAllowedReleaseUrl('https://github.com/banmu123/BrewPhase/releases')).toBe(true)
    expect(
      isAllowedReleaseUrl('https://release-assets.githubusercontent.com/asset.dmg?sig=x')
    ).toBe(true)
    expect(isAllowedReleaseUrl('http://github.com/x')).toBe(false)
    expect(isAllowedReleaseUrl('https://evil.example.com/x')).toBe(false)
    expect(isAllowedReleaseUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedReleaseUrl('not a url')).toBe(false)
  })
})

const release = (overrides: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  tag_name: 'desktop-v0.2.0',
  html_url: 'https://github.com/banmu123/BrewPhase/releases/tag/desktop-v0.2.0',
  published_at: '2026-11-20T08:00:00Z',
  assets: [
    {
      name: 'BrewPhase-0.2.0-mac-arm64.dmg',
      browser_download_url:
        'https://github.com/banmu123/BrewPhase/releases/download/desktop-v0.2.0/BrewPhase-0.2.0-mac-arm64.dmg'
    },
    {
      name: 'BrewPhase-0.2.0-win-x64.exe',
      browser_download_url:
        'https://github.com/banmu123/BrewPhase/releases/download/desktop-v0.2.0/BrewPhase-0.2.0-win-x64.exe'
    }
  ],
  ...overrides
})

describe('pickAssetUrl', () => {
  it('按平台挑对应安装包', () => {
    expect(pickAssetUrl(release(), 'darwin', 'arm64')).toContain('mac-arm64.dmg')
    expect(pickAssetUrl(release(), 'win32', 'x64')).toContain('win-x64.exe')
    expect(pickAssetUrl(release(), 'linux', 'x64')).toBeNull()
    expect(pickAssetUrl(release(), 'darwin', 'x64')).toBeNull()
  })

  it('远端 URL 不在白名单时拒绝', () => {
    const evil = release({
      assets: [
        {
          name: 'BrewPhase-0.2.0-mac-arm64.dmg',
          browser_download_url: 'https://evil.example.com/BrewPhase.dmg'
        }
      ]
    })
    expect(pickAssetUrl(evil, 'darwin', 'arm64')).toBeNull()
  })
})

describe('selectUpdate', () => {
  it('草稿、旧版本、无关 tag 都不算更新', () => {
    expect(
      selectUpdate([release({ draft: true })], '0.1.2', 'darwin', 'arm64')
    ).toBeNull()
    expect(
      selectUpdate([release({ tag_name: 'desktop-v0.1.1' })], '0.1.2', 'darwin', 'arm64')
    ).toBeNull()
    expect(
      selectUpdate([release({ tag_name: 'desktop-v0.1.2' })], '0.1.2', 'darwin', 'arm64')
    ).toBeNull()
    expect(
      selectUpdate([release({ tag_name: 'v9.9.9' })], '0.1.2', 'darwin', 'arm64')
    ).toBeNull()
  })

  it('返回版本号最大的一条，并带上平台资产', () => {
    const result = selectUpdate(
      [release({ tag_name: 'desktop-v0.2.0' }), release({ tag_name: 'desktop-v0.3.0' })],
      '0.1.2',
      'darwin',
      'arm64'
    )
    expect(result?.version).toBe('0.3.0')
    // 资产名按 tag 版本推导，0.3.0 的 tag 配 0.2.0 的资产名 → 不匹配，安全降级。
    expect(result?.downloadUrl).toBeNull()
    expect(result?.publishedAt).toBe('2026-11-20T08:00:00Z')
  })

  it('html_url 不在白名单时退回 Releases 页', () => {
    const result = selectUpdate(
      [release({ html_url: 'https://evil.example.com/release' })],
      '0.1.2',
      'darwin',
      'arm64'
    )
    expect(result?.releaseUrl).toBe(UPDATE_RELEASES_PAGE)
  })

  it('响应不是数组时返回 null，不抛异常', () => {
    expect(selectUpdate({ message: 'Bad credentials' }, '0.1.2', 'darwin', 'arm64')).toBeNull()
    expect(selectUpdate(null, '0.1.2', 'darwin', 'arm64')).toBeNull()
  })
})
