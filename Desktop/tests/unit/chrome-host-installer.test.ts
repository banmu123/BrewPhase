import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ChromeHostInstaller } from '../../src/main/integrations/chrome/chrome-host-installer'

/**
 * 安装器的路径与身份。
 *
 * 这条测试守护一个真实踩过的坑：Windows 上 manifest 必须放在 **Host 同目录**
 * （HKCU 注册表指向它），不能落到 Linux 的 `~/.config/google-chrome/...`，
 * 否则注册表写了、Chrome 也读不到 manifest。
 */

const identity = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../ChromeExtension/extension-id.json', import.meta.url)), 'utf8')
) as { id: string; key: string }

function installer(hostDirOverride?: string): ChromeHostInstaller {
  return new ChromeHostInstaller({
    appVersion: '0.1.1-test',
    appPath: process.cwd(),
    resourcesPath: process.cwd(),
    isPackaged: false,
    hostDirOverride
  })
}

const binaryName = process.platform === 'win32' ? 'brewphase-chrome-host.exe' : 'brewphase-chrome-host'

describe('ChromeHostInstaller', () => {
  it('Windows 的 manifest 与 Host 同目录（注册表指向这里）', () => {
    const target = installer()
    if (process.platform === 'win32') {
      expect(target.manifestFilePath()).toBe(join(target.hostDir(), 'com.brewphase.chrome.json'))
    } else {
      expect(target.manifestFilePath()).toContain('NativeMessagingHosts')
    }
  })

  it('隔离目录只写自己的文件，不碰系统 NativeMessagingHosts', () => {
    const dir = join(process.cwd(), 'tmp-installer-dir')
    const target = installer(dir)

    expect(target.hostDir()).toBe(dir)
    expect(target.manifestFilePath()).toBe(join(dir, 'com.brewphase.chrome.json'))
    expect(target.configPath()).toBe(join(dir, 'host-config.json'))
    expect(target.hostPath()).toBe(join(dir, binaryName))
  })

  it('extensionId 从仓库 extension-id.json 读取，与固定 ID 一致', () => {
    const target = installer()
    expect(target.extensionId()).toBe(identity.id)
    expect(identity.id).toBe('fohjelihijmiefmjadckiajickopdojn')
  })

  it('打包态使用注入的固定 ID，且 Host 源路径来自 resources', () => {
    const resources = join('C:', 'Program Files', 'BrewPhase', 'resources')
    const packaged = new ChromeHostInstaller({
      appVersion: '1.0.0',
      appPath: join(resources, 'app.asar'),
      resourcesPath: resources,
      isPackaged: true,
      productionExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    })

    expect(packaged.extensionId()).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(packaged.sourceHostPath()).toBe(join(resources, 'native-host', binaryName))
    // 打包态不读源码目录
    expect(installer().sourceHostPath()).toContain('resources')
  })
})
