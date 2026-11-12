import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ChromeHostInstaller,
  normalizePathForCompare,
  parseRegistryQueryPath
} from '../../src/main/integrations/chrome/chrome-host-installer'

/**
 * Native Host 状态检测。
 *
 * 之前只比较 `reg query` 的字符串包含关系：大小写、斜杠方向、空格或编码
 * 一变就误报「未安装」，即使扩展实际能连上。这里把路径归一与注册表解析
 * 单独立出来测，并覆盖「文件齐全 / manifest 失效 / 注册状态未知」三种状态。
 */

describe('注册表输出解析', () => {
  it('识别标准 reg query 输出', () => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.brewphase.chrome',
      '    (默认)    REG_SZ    C:\\Users\\czk\\AppData\\Local\\BrewPhase\\ChromeCompanion\\com.brewphase.chrome.json',
      ''
    ].join('\r\n')
    expect(parseRegistryQueryPath(output)).toBe(
      'C:\\Users\\czk\\AppData\\Local\\BrewPhase\\ChromeCompanion\\com.brewphase.chrome.json'
    )
  })

  it('带空格的路径完整保留', () => {
    const output =
      '(默认)    REG_SZ    C:\\Program Files\\BrewPhase\\ChromeCompanion\\com.brewphase.chrome.json'
    expect(parseRegistryQueryPath(output)).toBe(
      'C:\\Program Files\\BrewPhase\\ChromeCompanion\\com.brewphase.chrome.json'
    )
  })

  it('没有路径时返回 null', () => {
    expect(parseRegistryQueryPath('ERROR: The system was unable to find the specified registry key')).toBeNull()
    expect(parseRegistryQueryPath('')).toBeNull()
  })
})

describe('路径归一比较', () => {
  it('忽略大小写与斜杠方向', () => {
    expect(normalizePathForCompare('C:\\Users\\CZK\\BrewPhase\\x.json')).toBe(
      normalizePathForCompare('c:/users/czk/BrewPhase/x.json')
    )
  })

  it('解析 .. 后再比较', () => {
    expect(
      normalizePathForCompare('C:\\Users\\czk\\AppData\\Local\\BrewPhase\\..\\BrewPhase\\x.json')
    ).toBe(normalizePathForCompare('C:\\Users\\czk\\AppData\\Local\\BrewPhase\\x.json'))
  })
})

describe('ChromeHostInstaller.status', () => {
  let root = ''
  let hostDir = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bp-host-status-'))
    hostDir = join(root, 'host')
    mkdirSync(hostDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function installer(): ChromeHostInstaller {
    return new ChromeHostInstaller({
      appVersion: '0.1.1-test',
      // 用真实的 Desktop 目录，才能读到仓库里的 ChromeExtension/extension-id.json。
      appPath: process.cwd(),
      resourcesPath: join(process.cwd(), 'resources'),
      isPackaged: false,
      hostDirOverride: hostDir
    })
  }

  function writeHostFiles(): void {
    const target = installer()
    writeFileSync(target.hostPath(), 'fake-host')
    /*
     * 必须补可执行位：status() 用 `X_OK` 判断 binary 是否存在，
     * Windows 上 X_OK 等于「文件存在即可」，macOS/Linux 上不可执行的文件
     * 会被判成不存在——而安装流程自己也会 chmod 0o755。
     */
    chmodSync(target.hostPath(), 0o755)
    writeFileSync(target.configPath(), JSON.stringify({ version: 1 }))
    writeFileSync(
      target.manifestFilePath(),
      JSON.stringify({
        name: 'com.brewphase.chrome',
        path: target.hostPath(),
        type: 'stdio',
        allowed_origins: [`chrome-extension://${target.extensionId()}/`]
      })
    )
  }

  it('文件齐全且 manifest 指向 Host 时为已安装', async () => {
    writeHostFiles()
    const state = await installer().status()
    expect(state.binaryExists).toBe(true)
    expect(state.configExists).toBe(true)
    expect(state.manifestExists).toBe(true)
    expect(state.manifestValid).toBe(true)
    expect(state.installationValid).toBe(true)
  })

  it('extensions id 不匹配时 manifest 无效', async () => {
    const target = installer()
    writeFileSync(target.hostPath(), 'fake-host')
    writeFileSync(target.configPath(), '{}')
    writeFileSync(
      target.manifestFilePath(),
      JSON.stringify({
        path: target.hostPath(),
        allowed_origins: ['chrome-extension://someone-else/']
      })
    )
    const state = await target.status()
    expect(state.manifestValid).toBe(false)
    expect(state.installationValid).toBe(false)
  })

  it('缺 binary 时未安装', async () => {
    const target = installer()
    writeFileSync(target.configPath(), '{}')
    const state = await target.status()
    expect(state.binaryExists).toBe(false)
    expect(state.installationValid).toBe(false)
  })
})
