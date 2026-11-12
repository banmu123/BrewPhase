/** 设置 / Settings：页面骨架、二级导航、常规页。 */
export const settings = {
  title: '设置',
  subtitle: '管理应用、数据与连接',
  nav: {
    general: '常规',
    sync: '设备同步',
    browser: '浏览器',
    chrome: 'Chrome 扩展',
    mcp: 'AI 连接'
  },
  general: {
    title: '常规设置',
    subtitle: '语言、应用与本地数据',
    language: '语言',
    languageHint: '切换后整个应用立即更新，并会记住你的选择。',
    languageName: {
      'zh-CN': '简体中文',
      'en-US': 'English'
    },
    appInfo: '应用信息',
    version: '版本',
    schemaVersion: '数据库 Schema',
    syncProtocol: '同步协议',
    platform: '平台',
    localData: '本地数据',
    localDataNote: '全部数据存在本机的 SQLite 与 media 目录里，不上传、不登录、不需要网络。',
    dataDir: '数据目录',
    dataDirHint: '数据库与媒体文件都在这里；缓存、语言偏好与登录状态不在这个目录。',
    dataDirChange: '更改位置…',
    dataDirMoving: '正在迁移…',
    dataDirReset: '使用默认位置',
    dataDirChangeTitle: '更改数据存储位置？',
    dataDirChangeBody:
      '会把数据库与媒体复制到你选择的空文件夹，然后重启 BrewPhase。未保存的输入会丢失；原目录的数据不会删除。',
    dataDirResetTitle: '恢复默认位置？',
    dataDirResetBody:
      '会切回默认数据目录。自定义目录里的数据不会移动或删除，之后仍可以手动清理。',
    dataDirRestarting: '已迁移，正在重启 BrewPhase…',
    dataDirRestartNow: '立即重启',
    dataDirFailed: '迁移没有完成',
    about: '关于 BrewPhase',
    aboutText:
      '本地优先的咖啡记录与风味分析应用：记录每一包豆，看到风味怎么变化。阶段判断、冲煮记录、个人规律都在你的设备上，不联网也能完整使用。',
    notDone: '这一版明确没有做',
    notDoneItems: [
      'Bonjour 自动发现（二维码直连已可用）',
      'TLS 传输加密（当前同步是局域网 HTTP + token/签名）',
      '双向同步（现为移动设备 → 电脑单向）',
      'Windows 上的 MCP Bridge（Named Pipe 权限未验证）',
      '代码签名 / 公证 / 自动更新'
    ]
  },
  /** 设置 → 浏览器：Chrome 书签导入向导。 */
  browser: {
    title: '浏览器',
    lead: '把本机 Chrome 的书签导入 BrewPhase，在内置浏览器里继续访问。',
    privacy:
      '只读取 Chrome 的 Bookmarks 与 Local State：不读取 Cookie、密码、扩展与浏览历史，不修改 Chrome 文件，也不上传任何数据。',
    detect: {
      title: 'Chrome',
      checking: '正在检测 Chrome…',
      found: (profiles: number) => `已检测到 Chrome · ${profiles} 个配置`,
      notInstalled: '没有找到 Google Chrome。安装后回来重新检测即可。',
      noProfiles: 'Chrome 已安装，但没有找到可用的配置。',
      rescan: '重新检测',
      profile: '配置',
      bookmarksPresent: '有书签文件',
      bookmarksMissing: '没有书签文件',
      choose: '选择',
      chosen: '已选择'
    },
    preview: {
      title: '预览',
      description: (name: string) => `将导入「${name}」里的书签，文件夹层级会一起保留。`,
      bookmarks: '书签',
      folders: '文件夹',
      rootCount: (bookmarks: number, folders: number) =>
        `${bookmarks} 条书签${folders > 0 ? ` · ${folders} 个文件夹` : ''}`,
      skipped: '无法导入',
      skippedCount: (count: number) => `${count} 条`,
      skippedHint: '只导入 http 与 https 地址；javascript:、file:、chrome: 等会跳过。',
      empty: '这个配置里没有可导入的书签。',
      action: '预览书签',
      cancel: '取消',
      confirm: '导入这些书签'
    },
    result: {
      title: '导入完成',
      added: (count: number) => `新增 ${count} 条`,
      updated: (count: number) => `更新 ${count} 条`,
      skipped: (count: number) => `跳过 ${count} 条`,
      total: (count: number) => `现在共有 ${count} 条书签`,
      again: '再导入一次',
      open: '在浏览器中查看'
    },
    error: {
      title: '导入没有完成',
      'profile-not-found': '找不到这个 Chrome 配置，可能已经被删除。',
      'bookmarks-missing': '这个配置里没有 Bookmarks 文件。',
      unreadable: '读取 Bookmarks 失败。如果 Chrome 正在运行，请退出 Chrome 后重试。',
      corrupt: 'Bookmarks 不是有效的 JSON，可能正在被 Chrome 写入。请退出 Chrome 后重试。'
    }
  },
  chrome: {
    title: 'Chrome 扩展',
    subtitle: '在 Chrome 里浏览，把有用的页面带回来',
    lead: '继续用已经登录的 Chrome 浏览网页。点一下扩展，就能把当前页面和选中的文字保存到 Records——不用退出登录，也不用换浏览器。',
    status: {
      title: '连接状态',
      bridge: 'BrewPhase 本地服务',
      running: '运行中',
      stopped: '未运行',
      host: 'Native Host',
      installed: '已安装',
      missing: '未安装',
      connected: '已连接',
      connection: '扩展连接',
      installedIdle: '已安装，等待连接',
      invalid: '安装异常',
      unknown: '状态未知',
      lastSeen: (time: string) => `最近通信：${time}`,
      never: '最近通信：还没收到 Chrome 的请求',
      registeredUnknown: '注册状态读不到（系统策略限制），以实际连接状态为准。',
      selfTest: '测试本地服务',
      selfTesting: '正在测试…',
      selfTestOk: '本地服务正常',
      selfTestFailed: (message: string) => `本地服务异常：${message}`,
      extensionId: '扩展 ID',
      extensionMissing: '尚未生成',
      extensionHint:
        'Desktop 读不到 Chrome 的已加载扩展列表；请在 chrome://extensions 确认卡片上的 ID 与上面一致。',
      appVersion: '宿主版本'
    },
    actions: {
      install: '安装 / 修复',
      recheck: '重新检测',
      uninstall: '移除集成',
      installing: '正在安装…',
      uninstalling: '正在移除…'
    },
    result: {
      installed: 'Native Host 已注册，可以到 Chrome 加载扩展了。',
      installedPartial:
        'Host 文件与 manifest 已就位；系统策略拦截了注册表写入，实际连接状态以“已连接”为准。',
      removed: '已移除注册信息与本地 Host。',
      failed: (message: string) => `操作没有完成：${message}`
    },
    steps: {
      title: '在 Chrome 里加载扩展',
      open: '打开 chrome://extensions',
      devMode: '右上角开启「开发者模式」',
      load: '点「加载已解压的扩展程序」，选择这个目录：',
      pin: '把 BrewPhase 固定到工具栏。打开任意网页，点扩展图标即可保存。',
      directory: '扩展目录',
      notBuilt: '扩展还没有构建。先在 ChromeExtension 目录运行 pnpm build。',
      reload: '改过扩展代码后，回到 chrome://extensions 点刷新。'
    },
    security: {
      title: '权限与数据边界',
      body: '扩展只在点击时读取当前标签页的标题、地址、选中文字与页面描述；不读取 Cookie、密码或其他标签页，也不会上传任何内容。'
    }
  }
}
