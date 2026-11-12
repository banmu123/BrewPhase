import { Menu } from 'electron'

/**
 * 应用菜单：一条声明式模板，三个平台共用。
 *
 * - **功能全靠 role**：撤销/重做/剪切/复制/粘贴/全选/缩放/全屏等都是
 *   Electron 内建 role，快捷键（Ctrl+C/V/Z/A、Ctrl+=/-/0、F11…）随 role
 *   自带，不需要在 Renderer 里另接键盘监听；
 * - **视觉上不可见**：Windows/Linux 用 `autoHideMenuBar` 收起传统菜单栏
 *   （Alt 可唤出），Renderer 顶栏里的轻量按钮通过 IPC
 *   `Menu.getApplicationMenu().popup()` 把这份菜单当 popup 弹出来——
 *   入口变轻了，功能与快捷键一份不少；
 * - macOS 必须有 application menu（系统菜单栏依赖它），照平台习惯组装。
 */
export function installApplicationMenu(): void {
  const mac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = mac
    ? [
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' }
      ]
    : [
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' }
          ]
        },
        {
          label: 'View',
          submenu: [
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' }
          ]
        }
      ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
