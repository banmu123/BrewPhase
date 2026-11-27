import { autoUpdater } from 'electron-updater'

/**
 * electron-updater 的薄适配层。
 *
 * 为什么要有这一层：
 * - `UpdateService` 的状态机可以用假适配器完整单测（下载进度、失败重试、
 *   安装前清理顺序），不必真的启动安装器；
 * - electron-updater 是单例、事件式、还带全局开关，把它的初始化收在一个地方，
 *   就不会出现「两个地方各改一次 autoDownload」。
 *
 * 安全边界：更新源来自打包时写入的 `app-update.yml`（publish 配置生成），
 * Renderer 传不进 URL、路径或 channel。
 */

export type UpdaterReleaseInfo = {
  version: string
  releaseName?: string | null
}

export type UpdaterProgress = {
  /** 0–100，electron-updater 的真实计算结果。 */
  percent: number
  transferred: number
  total: number
}

export type UpdaterHandlers = {
  checking: () => void
  available: (info: UpdaterReleaseInfo) => void
  notAvailable: () => void
  progress: (progress: UpdaterProgress) => void
  downloaded: (info: UpdaterReleaseInfo) => void
  error: (error: Error) => void
}

export type UpdaterAdapter = {
  /** 当前构建是否具备自动更新能力（打包 + 有安装器的平台）。 */
  readonly supported: boolean
  bind: (handlers: UpdaterHandlers) => void
  check: () => Promise<void>
  download: () => Promise<void>
  /** 退出并安装。macOS 交给 Squirrel.Mac，Windows 交给 NSIS（静默 + 重启）。 */
  quitAndInstall: () => void
}

const noop = (): void => undefined

const unsupportedAdapter: UpdaterAdapter = {
  supported: false,
  bind: noop,
  check: async () => undefined,
  download: async () => undefined,
  quitAndInstall: noop
}

/**
 * 只有「打包版 + 有安装器产物的平台」才启用。
 *
 * 开发态（`pnpm dev` / e2e 的 `electron .`）没有 `app-update.yml`，
 * electron-updater 一调用就抛错；更重要的是绝不能让它去替换开发机上的应用。
 */
export function createElectronUpdaterAdapter(options: {
  packaged: boolean
  platform?: NodeJS.Platform
}): UpdaterAdapter {
  const platform = options.platform ?? process.platform
  const supported = options.packaged && (platform === 'darwin' || platform === 'win32')
  if (!supported) return unsupportedAdapter

  // 只检查不下载：下载必须由用户在界面上点「立即更新」触发。
  autoUpdater.autoDownload = false
  // 退出时自动装会在「用户只是关个窗口」时也装——不做隐式安装。
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  // 日志走主进程自己的错误处理，避免 electron-updater 往 stdout 刷整段堆栈。
  autoUpdater.logger = null

  return {
    supported: true,
    bind(handlers) {
      autoUpdater.on('checking-for-update', () => handlers.checking())
      autoUpdater.on('update-available', (info) =>
        handlers.available({ version: info.version, releaseName: info.releaseName ?? null })
      )
      autoUpdater.on('update-not-available', () => handlers.notAvailable())
      autoUpdater.on('download-progress', (progress) =>
        handlers.progress({
          percent: Math.max(0, Math.min(100, progress.percent)),
          transferred: progress.transferred,
          total: progress.total
        })
      )
      autoUpdater.on('update-downloaded', (info) =>
        handlers.downloaded({ version: info.version, releaseName: info.releaseName ?? null })
      )
      autoUpdater.on('error', (error) =>
        handlers.error(error instanceof Error ? error : new Error(String(error)))
      )
    },
    async check() {
      await autoUpdater.checkForUpdates()
    },
    async download() {
      await autoUpdater.downloadUpdate()
    },
    quitAndInstall() {
      // 静默安装 + 安装完自动启动：用户点过一次「立即更新」之后不再需要第二次操作。
      autoUpdater.quitAndInstall(true, true)
    }
  }
}
