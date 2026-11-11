import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  type ChromeCompanionInstallResult,
  type ChromeCompanionStatus,
  type ChromeHostConfig
} from '../../../shared/contracts/chrome-bridge'
import type { RecordService } from '../../application/records/record-service'
import { ChromeBridgeServer, chromeBridgePaths } from './chrome-bridge-server'
import { ChromeHostInstaller } from './chrome-host-installer'
import { ChromeMessageHandler } from './chrome-message-handler'

/**
 * Chrome Companion 的主进程编排：本地 IPC + Host 安装。
 *
 * 启动顺序（在 main bootstrap 里调用）：
 * 1. 先起本地 IPC —— 它不依赖 Host 是否安装；
 * 2. 若 Host 曾经安装过，刷新 `host-config.json`（token 每次启动轮换）；
 * 3. 未安装时什么都不做，设置页负责引导用户点「安装」。
 *
 * 关闭：`stop()` 释放 socket / named pipe；Host 进程由 Chrome 管理，Chrome
 * 关闭 popup 就会断开，Desktop 退出不会影响 Chrome 浏览。
 */
export class ChromeService {
  private readonly handler: ChromeMessageHandler
  private readonly installer: ChromeHostInstaller
  private bridge: ChromeBridgeServer | null = null
  private startError: string | null = null

  constructor(
    private readonly options: {
      userDataDir: string
      appVersion: string
      appPath: string
      resourcesPath: string
      isPackaged: boolean
      productionExtensionId?: string
      records: RecordService
      /** 测试 / 便携：覆盖 Host 安装目录。 */
      hostDirOverride?: string
    }
  ) {
    this.handler = new ChromeMessageHandler(options.records, options.appVersion)
    this.installer = new ChromeHostInstaller({
      appVersion: options.appVersion,
      appPath: options.appPath,
      resourcesPath: options.resourcesPath,
      isPackaged: options.isPackaged,
      productionExtensionId: options.productionExtensionId,
      hostDirOverride: options.hostDirOverride
    })
  }

  async start(): Promise<void> {
    if (this.bridge) return
    const server = new ChromeBridgeServer(
      chromeBridgePaths(this.options.userDataDir),
      (request) => this.handler.handle(request),
      this.options.appVersion
    )
    try {
      await server.start()
      this.bridge = server
      this.startError = null
      // 已安装过：把新的 endpoint / token 推到 Host 目录，旧 token 立即作废。
      await this.installer.refreshConfig(this.hostConfig(server))
    } catch (error) {
      this.startError = error instanceof Error ? error.message : 'failed to start'
      console.error('[chrome] bridge start failed', this.startError)
    }
  }

  async stop(): Promise<void> {
    const bridge = this.bridge
    this.bridge = null
    await bridge?.stop()
  }

  async status(): Promise<ChromeCompanionStatus> {
    const install = await this.installer.status()
    return {
      bridgeRunning: this.bridge?.isRunning() ?? false,
      endpoint: this.bridge?.endpoint() ?? null,
      hostInstalled: install.hostInstalled,
      hostVersion: install.hostVersion,
      hostPath: install.hostPath,
      manifestPath: install.manifestPath,
      extensionId: install.extensionId,
      extensionDir: install.extensionDir,
      appVersion: this.options.appVersion,
      platformSupported: true,
      lastError: install.lastError ?? this.startError
    }
  }

  async install(): Promise<ChromeCompanionInstallResult> {
    if (!this.bridge) await this.start()
    if (!this.bridge) {
      return {
        ok: false,
        status: await this.status(),
        message: this.startError ?? 'local bridge is not running'
      }
    }
    const state = await this.installer.install(this.hostConfig(this.bridge))
    return {
      ok: state.hostInstalled && state.lastError === null,
      status: await this.status(),
      message: state.lastError
    }
  }

  async uninstall(): Promise<ChromeCompanionInstallResult> {
    const state = await this.installer.uninstall()
    return {
      ok: !state.hostInstalled && state.lastError === null,
      status: await this.status(),
      message: state.lastError
    }
  }

  /** 供 E2E / 诊断读取：host-config 的实际路径（不通过 Renderer 暴露）。 */
  hostConfigPath(): string {
    return this.installer.configPath()
  }

  private hostConfig(server: ChromeBridgeServer): ChromeHostConfig {
    return {
      version: CHROME_BRIDGE_PROTOCOL_VERSION,
      endpoint: server.endpoint(),
      token: server.authToken(),
      appVersion: this.options.appVersion,
      installedAt: Date.now()
    }
  }
}
