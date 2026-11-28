import { Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 系统托盘（Windows 常驻）：关闭主窗口 = **隐藏到托盘**，应用继续在后台运行
 * （同步、提醒、自动更新都不停）；托盘点击恢复窗口，菜单提供「打开 / 退出」。
 *
 * 2026-11-28 用户需求：关闭窗口直接退出让 LAN 同步、更新检查全部失效；
 * 改为托盘常驻后，「关闭」只是收进后台，真正的退出走托盘菜单（会走
 * before-quit 的完整收尾链）。
 *
 * 生命周期约定：
 * - `onRequestShow`：托盘被点击 / 菜单「打开」时调用——恢复或重建主窗口；
 * - `isQuitting()`：真退出的判定（before-quit 置位后窗口的 close 才放行销毁）；
 * - macOS 上用户还能从 Dock 恢复（`activate` 事件），行为兼容。
 */
export class TrayService {
  private tray: Tray | null = null

  constructor(
    private readonly params: {
      iconPath: string | null
      isQuitting: () => boolean
      onRequestShow: () => void
      /** 用户点托盘「退出」：index 层先置位退出请求再 app.quit()。 */
      onRequestQuit: () => void
      label: string
    }
  ) {}

  start(): void {
    if (this.tray) return
    const iconPath = this.params.iconPath
    if (!iconPath || !existsSync(iconPath)) {
      console.error('[tray] icon not found, tray disabled:', iconPath)
      return
    }
    // Windows 托盘用小图；macOS 菜单栏会自动做模板化处理（无需 resize 也可）。
    const icon = nativeImage.createFromPath(iconPath)
    this.tray = new Tray(icon)
    this.tray.setToolTip(this.params.label)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: this.params.label,
          click: () => this.params.onRequestShow()
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => this.params.onRequestQuit()
        }
      ])
    )
    // 左键点击托盘 = 打开窗口（Windows 习惯；macOS 上同样有效）。
    this.tray.on('click', () => this.params.onRequestShow())
  }

  stop(): void {
    this.tray?.destroy()
    this.tray = null
  }

  /**
   * 主窗口关闭请求的统一处理：后台常驻模式且**不是真退出**时，隐藏窗口。
   * 返回 true 表示已拦截（调用方应 preventDefault）。
   */
  interceptClose(window: BrowserWindow): boolean {
    if (this.params.isQuitting() || !this.tray) return false
    window.hide()
    return true
  }
}
