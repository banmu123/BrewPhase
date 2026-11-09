/** 更多 / Settings：页面骨架、二级导航、常规页。 */
export const settings = {
  title: '更多',
  subtitle: '管理应用、数据与连接',
  nav: {
    general: '常规',
    sync: '设备同步',
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
    about: '关于 BrewPhase',
    aboutText:
      '本地优先的咖啡记录与风味分析应用：记录每一包豆，看到风味怎么变化。阶段判断、冲煮记录、个人规律都在你的设备上，不联网也能完整使用。',
    notDone: '这一版明确没有做',
    notDoneItems: [
      'Bonjour 自动发现（二维码直连已可用）',
      'TLS 传输加密（当前同步是局域网 HTTP + token/签名）',
      '双向同步（现为 iPhone → 电脑单向）',
      'Windows 上的 MCP Bridge（Named Pipe 权限未验证）',
      '代码签名 / 公证 / 自动更新'
    ]
  }
}
