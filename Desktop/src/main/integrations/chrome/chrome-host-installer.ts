import { execFile } from 'node:child_process'
import { constants, existsSync, readFileSync } from 'node:fs'
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_HOST_NAME,
  CHROME_HOST_VERSION,
  type ChromeHostConfig
} from '../../../shared/contracts/chrome-bridge'

const execFileAsync = promisify(execFile)

/**
 * Chrome Native Messaging Host 的安装与注册。
 *
 * 设计要点：
 * - Host 二进制**复制到用户目录**再注册：安装位置不随应用升级目录变化，
 *   Chrome 里存的 manifest 路径长期稳定；应用升级后下一次启动会覆盖新版本。
 * - `host-config.json` 与 Host 放在同一目录，Host 读自身目录即可找到 Desktop
 *   的本地端点与本次启动的 token，不需要知道 userData 在哪。
 * - Windows 只写 `HKCU`（当前用户），不碰 HKLM；卸载只删自己的键与目录。
 * - macOS / Linux 写 Chrome 的 `NativeMessagingHosts` 目录，同样只删自己的文件。
 */

export type ChromeHostInstallState = {
  hostInstalled: boolean
  hostPath: string | null
  manifestPath: string | null
  hostVersion: string | null
  extensionId: string | null
  extensionDir: string | null
  lastError: string | null
}

export class ChromeHostInstaller {
  private lastError: string | null = null

  constructor(
    private readonly options: {
      appVersion: string
      /** 开发态 app.getAppPath()，打包态 process.resourcesPath 由 isPackaged 区分。 */
      appPath: string
      resourcesPath: string
      isPackaged: boolean
      /** 生产发布时写死；开发态优先读仓库里的 extension-id.json。 */
      productionExtensionId?: string
      /** 测试 / 便携场景：把 Host 安装到指定目录，不碰真实用户目录。 */
      hostDirOverride?: string
    }
  ) {}

  /** Host 安装目录：按平台放用户数据区，权限随用户目录。 */
  hostDir(): string {
    if (this.options.hostDirOverride) return this.options.hostDirOverride
    if (process.platform === 'win32') {
      const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
      return join(base, 'BrewPhase', 'ChromeCompanion')
    }
    if (process.platform === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'BrewPhase', 'ChromeCompanion')
    }
    const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
    return join(base, 'brewphase', 'chrome-companion')
  }

  hostBinaryName(): string {
    return process.platform === 'win32' ? 'brewphase-chrome-host.exe' : 'brewphase-chrome-host'
  }

  hostPath(): string {
    return join(this.hostDir(), this.hostBinaryName())
  }

  configPath(): string {
    return join(this.hostDir(), 'host-config.json')
  }

  /** Host 源文件位置：开发态在 Desktop/resources/native-host/<platform>/。 */
  sourceHostPath(): string {
    const platformKey =
      process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
    if (this.options.isPackaged) {
      return join(this.options.resourcesPath, 'native-host', this.hostBinaryName())
    }
    return join(this.options.appPath, 'resources', 'native-host', platformKey, this.hostBinaryName())
  }

  /** Chrome 读取 manifest 的位置（macOS / Linux）；Windows 走注册表。 */
  manifestFilePath(): string {
    // Windows 的 manifest 固定放在 Host 同目录，由 HKCU 注册表指向它。
    // 测试 / 便携：同样放进隔离目录，绝不写系统位置。
    if (process.platform === 'win32' || this.options.hostDirOverride) {
      return this.manifestFilePathInHostDir()
    }
    if (process.platform === 'darwin') {
      return join(
        homedir(),
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'NativeMessagingHosts',
        `${CHROME_HOST_NAME}.json`
      )
    }
    return join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', `${CHROME_HOST_NAME}.json`)
  }

  windowsRegistryKey(): string {
    return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${CHROME_HOST_NAME}`
  }

  /** 扩展在仓库里的目录（开发态可直接「加载已解压」）。只认构建产物。 */
  extensionDir(): string | null {
    if (this.options.isPackaged) return null
    const candidate = join(this.options.appPath, '..', 'ChromeExtension', 'dist')
    // 必须真的有 manifest.json：源码目录没有（manifest 在 public/ 下），
    // 让用户去 chrome://extensions 选它会直接报错。
    return existsSync(join(candidate, 'manifest.json')) ? candidate : null
  }

  /** 固定扩展 ID：开发读仓库里的 extension-id.json，生产用注入值。 */
  extensionId(): string | null {
    if (this.options.productionExtensionId) return this.options.productionExtensionId
    if (this.options.isPackaged) return null
    // 注意：ID 文件在 ChromeExtension 根目录，不在 dist（dist 是可加载产物）。
    const identity = join(this.options.appPath, '..', 'ChromeExtension', 'extension-id.json')
    try {
      const raw = readFileSync(identity, 'utf8')
      const parsed = JSON.parse(raw) as { id?: string }
      return typeof parsed.id === 'string' && parsed.id ? parsed.id : null
    } catch {
      return null
    }
  }

  async status(): Promise<ChromeHostInstallState> {
    const hostPath = this.hostPath()
    const configPath = this.configPath()
    let hostInstalled = false
    let registered = false

    try {
      await access(hostPath, constants.X_OK)
      await access(configPath, constants.R_OK)
      hostInstalled = true
    } catch {
      hostInstalled = false
    }

    if (hostInstalled) {
      registered = await this.isRegistered()
    }

    const extensionId = this.extensionId()
    return {
      hostInstalled: hostInstalled && registered,
      hostPath: hostInstalled ? hostPath : null,
      manifestPath: registered ? this.manifestLocation() : null,
      hostVersion: hostInstalled ? CHROME_HOST_VERSION : null,
      extensionId,
      extensionDir: this.extensionDir(),
      lastError: this.lastError
    }
  }

  /**
   * 安装（幂等）：
   * 1. 复制 Host 二进制；
   * 2. 写 `host-config.json`（token 由 Desktop 每次启动轮换）；
   * 3. 写 Native Messaging manifest（Windows 同时写 HKCU 注册表）。
   */
  async install(config: ChromeHostConfig): Promise<ChromeHostInstallState> {
    this.lastError = null
    try {
      const extensionId = this.extensionId()
      if (!extensionId) {
        throw new Error('Chrome extension id is not available; build ChromeExtension first')
      }

      const source = this.sourceHostPath()
      await access(source, constants.R_OK)
      await mkdir(this.hostDir(), { recursive: true, mode: 0o755 })
      await copyFile(source, this.hostPath())
      if (process.platform !== 'win32') await chmod(this.hostPath(), 0o755)

      await this.writeConfig(config)
      await this.writeManifest(extensionId)
      await this.registerManifest()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'install failed'
      console.error('[chrome] host install failed', this.lastError)
    }
    return this.status()
  }

  /** 已安装时只刷新 config（token 每次启动变化），不重复复制二进制。 */
  async refreshConfig(config: ChromeHostConfig): Promise<void> {
    try {
      await access(this.hostPath(), constants.R_OK)
      await this.writeConfig(config)
    } catch {
      // 未安装：不主动安装，尊重用户选择；设置页会显示「未安装」。
    }
  }

  async uninstall(): Promise<ChromeHostInstallState> {
    this.lastError = null
    try {
      await this.unregisterManifest()
      if (process.platform !== 'win32') {
        await rm(this.manifestFilePath(), { force: true })
      }
      await rm(this.hostDir(), { recursive: true, force: true })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'uninstall failed'
      console.error('[chrome] host uninstall failed', this.lastError)
    }
    return this.status()
  }

  private manifestLocation(): string {
    return this.manifestFilePath()
  }

  private manifestFilePathInHostDir(): string {
    return join(this.hostDir(), `${CHROME_HOST_NAME}.json`)
  }

  private async writeConfig(config: ChromeHostConfig): Promise<void> {
    const body = `${JSON.stringify(
      { ...config, version: CHROME_BRIDGE_PROTOCOL_VERSION },
      null,
      2
    )}\n`
    await writeFile(this.configPath(), body, { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(this.configPath(), 0o600)
  }

  private async writeManifest(extensionId: string): Promise<void> {
    const manifest = {
      name: CHROME_HOST_NAME,
      description: 'BrewPhase Chrome Companion',
      path: this.hostPath(),
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`]
    }
    const target = this.manifestFilePath()
    await mkdir(dirname(target), { recursive: true, mode: 0o755 })
    await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  }

  private async registerManifest(): Promise<void> {
    // 隔离目录只给测试 / 便携用：不写 HKCU，也不写系统 NativeMessagingHosts。
    if (this.options.hostDirOverride) return
    if (process.platform !== 'win32') return
    await execFileAsync('reg', [
      'add',
      this.windowsRegistryKey(),
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      this.manifestFilePathInHostDir(),
      '/f'
    ])
  }

  private async unregisterManifest(): Promise<void> {
    if (this.options.hostDirOverride) return
    if (process.platform !== 'win32') return
    await execFileAsync('reg', ['delete', this.windowsRegistryKey(), '/f']).catch(() => undefined)
  }

  private async isRegistered(): Promise<boolean> {
    if (this.options.hostDirOverride || process.platform !== 'win32') {
      try {
        const manifest = JSON.parse(await readFile(this.manifestFilePath(), 'utf8')) as {
          path?: string
        }
        return manifest.path === this.hostPath()
      } catch {
        return false
      }
    }
    try {
      const { stdout } = await execFileAsync('reg', ['query', this.windowsRegistryKey(), '/ve'])
      return stdout.includes(this.manifestFilePathInHostDir())
    } catch {
      return false
    }
  }
}
