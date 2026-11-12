import { connect } from 'node:net'
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
import { ChromeImageReceiver } from './chrome-image-receiver'

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
  private readonly images: ChromeImageReceiver
  private bridge: ChromeBridgeServer | null = null
  private startError: string | null = null
  private lastHandshakeAt: number | null = null
  private lastRequestAt: number | null = null

  constructor(
    private readonly options: {
      userDataDir: string
      /** 业务数据目录（db/media），图片临时文件也放在这里。 */
      dataDir: string
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
    this.images = new ChromeImageReceiver(options.dataDir, options.records)
    this.handler = new ChromeMessageHandler(
      options.records,
      options.appVersion,
      this.images,
      () => {
        this.lastRequestAt = Date.now()
      }
    )
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
      this.options.appVersion,
      {
        onHandshake: () => {
          this.lastHandshakeAt = Date.now()
        }
      }
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
    // 退出/迁移时丢掉未完成的图片传输，避免临时文件无限增长。
    await this.images.dispose()
  }

  async status(): Promise<ChromeCompanionStatus> {
    const install = await this.installer.status()
    // 本次运行真的握手过：注册表查询不可靠时也以此为准。
    const connected = this.lastHandshakeAt !== null || this.lastRequestAt !== null
    const installationValid = install.installationValid || connected
    const connectionState: ChromeCompanionStatus['connectionState'] = connected
      ? 'connected'
      : installationValid
        ? install.registered === false
          ? 'invalid'
          : 'installed'
        : install.binaryExists || install.configExists || install.manifestExists
          ? 'invalid'
          : 'not-installed'

    return {
      bridgeRunning: this.bridge?.isRunning() ?? false,
      endpoint: this.bridge?.endpoint() ?? null,
      hostInstalled: installationValid,
      binaryExists: install.binaryExists,
      configExists: install.configExists,
      manifestExists: install.manifestExists,
      manifestValid: install.manifestValid,
      registered: install.registered,
      installationValid,
      connectionState,
      lastHandshakeAt: this.lastHandshakeAt,
      lastRequestAt: this.lastRequestAt,
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

  /**
   * 本地服务自检：连自己的 IPC，走一遍 hello + PING。
   *
   * 它证明「Desktop 的桥接能接受 Native Host 的连接」，不证明 Chrome 扩展
   * 已经加载；后者用 `lastRequestAt` 判断。
   */
  async selfTest(): Promise<{
    ok: boolean
    code: string
    message?: string
    appVersion?: string
  }> {
    const bridge = this.bridge
    if (!bridge?.isRunning()) {
      return { ok: false, code: 'APP_NOT_RUNNING', message: 'local bridge is not running' }
    }

    const token = bridge.authToken()
    const endpoint = bridge.endpoint()

    return new Promise((resolve) => {
      const socket = connect(endpoint)
      let buffer = ''
      let settled = false

      const finish = (result: { ok: boolean; code: string; message?: string; appVersion?: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        resolve(result)
      }
      const timer = setTimeout(
        () => finish({ ok: false, code: 'INTERNAL_ERROR', message: 'self test timed out' }),
        3_000
      )

      socket.setEncoding('utf8')
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ type: 'hello', token, version: 1 })}\n`)
      })
      socket.on('data', (chunk: string) => {
        buffer += chunk
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline === -1) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line.trim()) continue

          let message: Record<string, unknown>
          try {
            message = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (message.type === 'hello') {
            if (message.ok !== true) {
              finish({ ok: false, code: 'INTERNAL_ERROR', message: 'handshake rejected' })
              return
            }
            socket.write(
              `${JSON.stringify({ version: 1, requestId: `selftest-${Date.now()}`, type: 'PING' })}\n`
            )
            continue
          }
          if (message.code === 'OK') {
            const data = (message.data ?? {}) as { appVersion?: string }
            finish({ ok: true, code: 'OK', appVersion: data.appVersion })
          }
        }
      })
      socket.once('error', (error) => {
        finish({ ok: false, code: 'APP_NOT_RUNNING', message: error.message })
      })
    })
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
      ok: state.installationValid && state.lastError === null,
      status: await this.status(),
      message: state.lastError
    }
  }

  async uninstall(): Promise<ChromeCompanionInstallResult> {
    const state = await this.installer.uninstall()
    return {
      ok: !state.installationValid && state.lastError === null,
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
