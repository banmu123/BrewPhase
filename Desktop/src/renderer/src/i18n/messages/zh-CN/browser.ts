/**
 * 内置浏览器。中文是类型基准，en-US 必须逐一对应。
 *
 * 注意「起始页」与「错误页」是两种不同状态：起始页是**没有地址**时的欢迎页，
 * 错误页是**有地址但没打开**时的失败页。两者都有输入框，但语义不同，
 * 文案不能复用。
 */
export const browser = {
  /** 浮窗标题栏与顶栏按钮共用。 */
  label: '浏览器',
  open: '打开浏览器',
  close: '关闭浏览器',
  hide: '收起浏览器',
  titlebarHint: '拖动标题栏移动浮窗',
  resizeHint: '拖动边缘或四角调整大小',
  toolbar: {
    start: '起始页',
    back: '后退',
    forward: '前进',
    reload: '刷新',
    stop: '停止加载',
    openExternal: '在系统浏览器中打开',
    address: '输入网址或搜索关键词',
    go: '前往'
  },
  start: {
    title: '想去哪里？',
    hint: '浏览、发现、收藏 —— 都在同一个地方。',
    placeholder: '输入网址，或直接搜索',
    recent: '最近访问',
    resume: '继续上次访问',
    returnCurrent: '返回当前页面',
    empty: '还没有访问记录。',
    shortcut: '搜索'
  },
  /** 从 Chrome 导入的书签（起始页展示，设置页导入向导共用）。 */
  bookmarks: {
    roots: {
      bookmarkBar: '书签栏',
      other: '其他书签',
      synced: '移动设备书签'
    },
    emptyTitle: '把 Chrome 的收藏夹带过来',
    emptyHint: '在设置 → 浏览器里导入书签栏、其他书签与文件夹，原有层级会一起保留。',
    import: '去导入书签',
    untitled: '未命名书签'
  },
  status: {
    loading: '正在加载…',
    untitled: '未命名页面',
    ready: '就绪'
  },
  error: {
    title: '这一页没有打开',
    blockedScheme: '内置浏览器只打开 http 与 https 地址。',
    emptyInput: '先输入一个网址或关键词。',
    malformed: '这个地址看起来不完整。',
    notFound: '找不到这个网站，检查一下拼写。',
    offline: '网络似乎断开了。',
    timeout: '连接超时，稍后再试。',
    refused: '对方拒绝连接。',
    certificate: '这个网站的安全证书有问题，已停止加载。',
    crashed: '页面停止响应了。',
    generic: '加载失败。',
    retry: '重试',
    backToStart: '回到起始页',
    detail: (description: string) => `技术信息：${description}`
  },
  /** Records 链接记录的上下文入口。 */
  records: {
    openInside: '在 BrewPhase 中打开',
    openOutside: '在系统浏览器中打开'
  }
}
