import { describe, expect, it } from 'vitest'
import {
  UPDATE_RELEASES_PAGE,
  assetCandidates,
  compareVersions,
  isAllowedReleaseUrl,
  isPublishedStable,
  normalizeVersion,
  parseDesktopVersion,
  parseReleaseTag,
  pickAssetUrl,
  selectUpdate,
  type ReleaseAsset,
  type ReleaseEntry
} from '../../src/shared/contracts/update'

/**
 * 更新检查的三条历史事实（都用真实 Release 的形状）：
 * - `desktop-v0.1.0` … `desktop-v0.1.4`：Prerelease，tag 带 desktop- 前缀；
 * - `v0.2.0`：唯一一次用普通 v* 发布的**正式** Desktop Release，资产名仍是
 *   `BrewPhase-0.2.0-*`；
 * - iOS 也用 `v*`，所以「v* 是不是 Desktop」只能看 Release 里有没有本平台安装包。
 */

const DOWNLOAD_BASE = 'https://github.com/banmu123/BrewPhase/releases/download'

function asset(version: string, suffix: string): ReleaseAsset {
  const name = `BrewPhase-${version}-${suffix}`
  return { name, browser_download_url: `${DOWNLOAD_BASE}/release/${name}` }
}

function macAssets(version: string): ReleaseAsset[] {
  return [asset(version, 'mac-arm64.dmg'), asset(version, 'mac-arm64.zip')]
}

function winAssets(version: string): ReleaseAsset[] {
  return [asset(version, 'win-x64.exe')]
}

function desktopRelease(version: string, overrides: Partial<ReleaseEntry> = {}): ReleaseEntry {
  return {
    tag_name: `desktop-v${version}`,
    html_url: `https://github.com/banmu123/BrewPhase/releases/tag/desktop-v${version}`,
    published_at: '2026-11-20T08:00:00Z',
    // 正式发布的 Release：两个布尔值必须显式为 false（Stable 渠道的准入条件）。
    draft: false,
    prerelease: false,
    assets: [...macAssets(version), ...winAssets(version)],
    ...overrides
  }
}

/** v0.2.0 的真实形状：非 draft、非 prerelease、tag 不带 desktop- 前缀。 */
const STABLE_V020: ReleaseEntry = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/banmu123/BrewPhase/releases/tag/v0.2.0',
  published_at: '2026-11-26T13:49:48Z',
  draft: false,
  prerelease: false,
  assets: [
    asset('0.2.0', 'mac-arm64.dmg'),
    asset('0.2.0', 'mac-arm64.dmg.blockmap'),
    asset('0.2.0', 'mac-arm64.zip'),
    asset('0.2.0', 'mac-arm64.zip.blockmap'),
    asset('0.2.0', 'win-x64.exe'),
    asset('0.2.0', 'win-x64.exe.blockmap'),
    asset('0.2.0', 'win-x64.exe.sha256')
  ]
}

/** v0.1.4 的真实形状：Prerelease。 */
function prereleaseV014(): ReleaseEntry {
  return {
    tag_name: 'desktop-v0.1.4',
    html_url: 'https://github.com/banmu123/BrewPhase/releases/tag/desktop-v0.1.4',
    published_at: '2026-11-16T03:30:57Z',
    draft: false,
    prerelease: true,
    assets: [...macAssets('0.1.4'), ...winAssets('0.1.4')]
  }
}

/** 去掉 draft / prerelease 字段：模拟数据来源不完整（缓存 / 代理 / 手写响应）。 */
function withoutFlags(entry: ReleaseEntry): ReleaseEntry {
  const copy = { ...entry }
  delete copy.draft
  delete copy.prerelease
  return copy
}

describe('parseReleaseTag', () => {
  it('识别旧的 desktop-vX.Y.Z', () => {
    expect(parseReleaseTag('desktop-v0.1.4')).toEqual({ version: '0.1.4', kind: 'desktop' })
    expect(parseReleaseTag(' desktop-v1.10.0 ')).toEqual({ version: '1.10.0', kind: 'desktop' })
  })

  it('识别 0.2.0 用的普通 vX.Y.Z', () => {
    expect(parseReleaseTag('v0.2.0')).toEqual({ version: '0.2.0', kind: 'generic' })
    expect(parseReleaseTag('v2')).toEqual({ version: '2', kind: 'generic' })
  })

  it('识别下一次正式版的 desktop-v0.2.1', () => {
    expect(parseReleaseTag('desktop-v0.2.1')).toEqual({ version: '0.2.1', kind: 'desktop' })
  })

  it('忽略预发布后缀与无关 tag', () => {
    expect(parseReleaseTag('desktop-v0.1.2-beta')).toBeNull()
    expect(parseReleaseTag('v1.1.0-rc.1')).toBeNull()
    expect(parseReleaseTag('desktop-v')).toBeNull()
    expect(parseReleaseTag('v')).toBeNull()
    expect(parseReleaseTag('ios-v1.1')).toBeNull()
    expect(parseReleaseTag('release-notes')).toBeNull()
    expect(parseReleaseTag('')).toBeNull()
  })
})

describe('parseDesktopVersion', () => {
  it('两种 tag 都返回版本号（旧名字保留，调用方不必改）', () => {
    expect(parseDesktopVersion('desktop-v0.1.4')).toBe('0.1.4')
    expect(parseDesktopVersion('v0.2.0')).toBe('0.2.0')
    expect(parseDesktopVersion('desktop-v0.2.1')).toBe('0.2.1')
    expect(parseDesktopVersion('v1.1.0-rc.1')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('按数字段比较，不按字符串比较', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1)
    expect(compareVersions('0.2.9', '0.2.10')).toBe(-1)
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
    expect(compareVersions('0.2', '0.10')).toBe(-1)
  })

  it('缺位按 0，相等返回 0', () => {
    expect(compareVersions('0.1.2', '0.1.2')).toBe(0)
    expect(compareVersions('1', '1.0.0')).toBe(0)
  })
})

describe('normalizeVersion', () => {
  it('去掉前导 v、空白与预发布后缀', () => {
    expect(normalizeVersion(' v0.2.0 ')).toBe('0.2.0')
    expect(normalizeVersion('0.2.0-beta.1')).toBe('0.2.0')
    expect(normalizeVersion('0.2.0+build5')).toBe('0.2.0')
  })
})

describe('isPublishedStable', () => {
  const base = { tag_name: 'v0.2.0', html_url: '' }

  it('只有显式 draft=false 且 prerelease=false 才算正式发布', () => {
    expect(isPublishedStable({ ...base, draft: false, prerelease: false })).toBe(true)
  })

  it('Draft / Prerelease 都拒绝', () => {
    expect(isPublishedStable({ ...base, draft: true, prerelease: false })).toBe(false)
    expect(isPublishedStable({ ...base, draft: false, prerelease: true })).toBe(false)
    expect(isPublishedStable({ ...base, draft: true, prerelease: true })).toBe(false)
  })

  it('字段缺失一律不当成正式发布', () => {
    expect(isPublishedStable(base)).toBe(false)
    expect(isPublishedStable({ ...base, draft: false })).toBe(false)
    expect(isPublishedStable({ ...base, prerelease: false })).toBe(false)
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

describe('assetCandidates', () => {
  it('按平台与架构给出安装包文件名', () => {
    expect(assetCandidates('0.2.0', 'darwin', 'arm64')).toEqual([
      'BrewPhase-0.2.0-mac-arm64.dmg',
      'BrewPhase-0.2.0-mac-arm64.zip'
    ])
    expect(assetCandidates('0.2.0', 'win32', 'x64')).toEqual(['BrewPhase-0.2.0-win-x64.exe'])
    expect(assetCandidates('0.2.0', 'linux', 'x64')).toEqual([])
    expect(assetCandidates('0.2.0', 'win32', 'arm64')).toEqual([])
    expect(assetCandidates('0.2.0', 'darwin', 'ia32')).toEqual([])
  })
})

describe('pickAssetUrl', () => {
  it('macOS 优先 dmg，只有 zip 时退回 zip', () => {
    expect(pickAssetUrl(STABLE_V020, 'darwin', 'arm64')).toContain('BrewPhase-0.2.0-mac-arm64.dmg')
    const zipOnly: ReleaseEntry = { ...STABLE_V020, assets: [asset('0.2.0', 'mac-arm64.zip')] }
    expect(pickAssetUrl(zipOnly, 'darwin', 'arm64')).toContain('.zip')
  })

  it('Windows 拿 NSIS exe；其它平台没有包', () => {
    expect(pickAssetUrl(STABLE_V020, 'win32', 'x64')).toContain('BrewPhase-0.2.0-win-x64.exe')
    expect(pickAssetUrl(STABLE_V020, 'linux', 'x64')).toBeNull()
    expect(pickAssetUrl(STABLE_V020, 'darwin', 'x64')).toBeNull()
  })

  it('资产版本号必须与 tag 版本一致', () => {
    const mismatched: ReleaseEntry = { ...desktopRelease('0.3.0'), assets: macAssets('0.2.0') }
    expect(pickAssetUrl(mismatched, 'darwin', 'arm64')).toBeNull()
  })

  it('远端 URL 不在白名单时拒绝，且不会悄悄换成另一个文件', () => {
    const evil = {
      ...STABLE_V020,
      assets: [
        { name: 'BrewPhase-0.2.0-mac-arm64.dmg', browser_download_url: 'https://evil.example.com/x.dmg' },
        asset('0.2.0', 'mac-arm64.zip')
      ]
    }
    expect(pickAssetUrl(evil, 'darwin', 'arm64')).toBeNull()
  })

  it('assets 缺失或不是数组时返回 null', () => {
    expect(pickAssetUrl({ ...STABLE_V020, assets: undefined }, 'darwin', 'arm64')).toBeNull()
  })
})

describe('selectUpdate', () => {
  it('0.1.4 的 Prerelease 不会被当成新版本（Stable 渠道）', () => {
    expect(selectUpdate([prereleaseV014()], '0.1.3', 'darwin', 'arm64')).toBeNull()
  })

  it('Draft 不参与检查', () => {
    expect(selectUpdate([desktopRelease('0.2.0', { draft: true })], '0.1.4', 'darwin', 'arm64')).toBeNull()
  })

  it('缺少 draft / prerelease 字段的 Release 不参与 Stable 比较', () => {
    expect(selectUpdate([withoutFlags(desktopRelease('0.2.1'))], '0.2.0', 'darwin', 'arm64')).toBeNull()
    expect(selectUpdate([withoutFlags(desktopRelease('0.2.1'))], '0.2.0', 'win32', 'x64')).toBeNull()
  })

  it('v0.2.0 兼容：正式 Release 能被 0.1.4 看见', () => {
    const result = selectUpdate([prereleaseV014(), STABLE_V020], '0.1.4', 'darwin', 'arm64')
    expect(result).toEqual({
      version: '0.2.0',
      releaseUrl: 'https://github.com/banmu123/BrewPhase/releases/tag/v0.2.0',
      downloadUrl: `${DOWNLOAD_BASE}/release/BrewPhase-0.2.0-mac-arm64.dmg`,
      publishedAt: '2026-11-26T13:49:48Z'
    })
    expect(selectUpdate([prereleaseV014(), STABLE_V020], '0.1.4', 'win32', 'x64')?.downloadUrl).toContain(
      'win-x64.exe'
    )
  })

  it('当前已是 0.2.0 时不再提示 0.2.0', () => {
    expect(selectUpdate([STABLE_V020], '0.2.0', 'darwin', 'arm64')).toBeNull()
    // desktop-v 写法同理：等于当前版本也不提示。
    expect(selectUpdate([desktopRelease('0.2.0')], '0.2.0', 'darwin', 'arm64')).toBeNull()
  })

  it('后续 desktop-v0.2.1 能被 0.2.0 看见', () => {
    const result = selectUpdate([STABLE_V020, desktopRelease('0.2.1')], '0.2.0', 'darwin', 'arm64')
    expect(result?.version).toBe('0.2.1')
    expect(result?.downloadUrl).toContain('BrewPhase-0.2.1-mac-arm64.dmg')
  })

  it('纯 iOS Release（v1.1.0，只有 ipa）不会被误判为 Desktop 更新', () => {
    const ios: ReleaseEntry = {
      tag_name: 'v1.1.0',
      html_url: 'https://github.com/banmu123/BrewPhase/releases/tag/v1.1.0',
      published_at: '2026-11-25T00:00:00Z',
      draft: false,
      prerelease: false,
      assets: [
        { name: 'BrewPhase.ipa', browser_download_url: `${DOWNLOAD_BASE}/v1.1.0/BrewPhase.ipa` },
        { name: 'BrewPhase-1.1.0-ios.ipa', browser_download_url: `${DOWNLOAD_BASE}/v1.1.0/BrewPhase-1.1.0-ios.ipa` }
      ]
    }
    expect(selectUpdate([ios], '0.2.0', 'darwin', 'arm64')).toBeNull()
    expect(selectUpdate([ios], '0.2.0', 'win32', 'x64')).toBeNull()
  })

  it('0.2.10 比 0.2.9 新（数字段比较，与数组顺序无关）', () => {
    const older = desktopRelease('0.2.9')
    const newer = desktopRelease('0.2.10')
    expect(selectUpdate([newer, older], '0.2.8', 'darwin', 'arm64')?.version).toBe('0.2.10')
    expect(selectUpdate([older, newer], '0.2.8', 'darwin', 'arm64')?.version).toBe('0.2.10')
  })

  it('没有本平台安装包的 Release 不显示为可更新', () => {
    const macOnly = desktopRelease('0.2.1', { assets: macAssets('0.2.1') })
    expect(selectUpdate([macOnly], '0.2.0', 'win32', 'x64')).toBeNull()
    expect(selectUpdate([macOnly], '0.2.0', 'darwin', 'arm64')?.version).toBe('0.2.1')
  })

  it('资产地址不在白名单时不提示更新', () => {
    const hijacked: ReleaseEntry = {
      ...desktopRelease('0.2.1'),
      assets: [
        { name: 'BrewPhase-0.2.1-mac-arm64.dmg', browser_download_url: 'https://evil.example.com/a.dmg' }
      ]
    }
    expect(selectUpdate([hijacked], '0.2.0', 'darwin', 'arm64')).toBeNull()
  })

  it('html_url 不在白名单时退回 Releases 页', () => {
    const suspicious: ReleaseEntry = { ...desktopRelease('0.2.1'), html_url: 'https://evil.example.com/r' }
    expect(selectUpdate([suspicious], '0.2.0', 'darwin', 'arm64')?.releaseUrl).toBe(
      UPDATE_RELEASES_PAGE
    )
  })

  it('响应结构异常时返回 null，不抛异常', () => {
    expect(selectUpdate({ message: 'Bad credentials' }, '0.2.0', 'darwin', 'arm64')).toBeNull()
    expect(selectUpdate(null, '0.2.0', 'darwin', 'arm64')).toBeNull()
    expect(selectUpdate([null, 42, 'x'], '0.2.0', 'darwin', 'arm64')).toBeNull()
  })

  it('当前版本带 v 前缀或预发布后缀时也能正确比较', () => {
    expect(selectUpdate([STABLE_V020], 'v0.1.4', 'darwin', 'arm64')?.version).toBe('0.2.0')
    expect(selectUpdate([STABLE_V020], '0.2.0-beta.1', 'darwin', 'arm64')).toBeNull()
  })
})
