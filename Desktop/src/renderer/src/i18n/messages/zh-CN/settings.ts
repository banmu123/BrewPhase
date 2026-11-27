
/**
 * 远程访问（Remote MCP）。措辞刻意保守：不承诺「绝不会被攻破」，
 * 只说明「本地最终否决」与「审计是 best-effort」这两件确实成立的事。
 */
export const remote = {
  title: '远程访问',
  lead: '让云端 AI（如 ChatGPT）通过 BrewPhase Cloud 读这台电脑上的记录、豆子与画布。默认关闭；关闭时不建立任何连接。',
  toggle: '允许远程访问',
  toggleOnHint: '已开启。云端 AI 只能调用 8 个只读工具。',
  toggleOffHint: '关闭中。不建立任何出站连接。',
  enable: '开启…',
  disable: '关闭',
  confirmTitle: '开启前确认授权范围',
  confirmBody: '开启后，你在 Cloud 上授权过的 AI 客户端可以读取以下范围的数据：',
  confirmReadonly: '只能读。远程不提供任何写入、删除、执行命令或读取文件的能力，也不会把数据复制到云端。',
  confirm: '确认开启',
  cancel: '取消',
  state: '连接状态',
  states: {
    idle: '未连接',
    connecting: '连接中',
    handshaking: '握手中',
    online: '已连接',
    draining: '正在排空',
    backoff: '等待重连',
    blocked: '已阻断（需处理）'
  },
  device: '设备',
  notPaired: '尚未配对',
  boundUser: '绑定用户',
  noUser: '未绑定',
  serviceable: '可服务',
  yes: '是',
  no: '否',
  reasons: {
    remote_disabled: '开关已关闭',
    user_mismatch: '当前账户与绑定用户不一致',
    db_unavailable: '本地数据库未就绪',
    services_unavailable: '本地服务未就绪',
    shutting_down: '正在退出',
    blocked: '设备处于阻断状态（需重新配对或切换账户）'
  },
  lastActive: '最后活跃',
  never: '—',
  blockedTitle: '远程访问已被阻断',
  unbind: '解除绑定并重新配对',
  grants: '已授权的客户端',
  noGrants: '当前没有 AI 客户端获得授权。',
  noScopes: '无可用范围',
  auditWarning: '最近 {count} 次远程访问未能写入审计记录',
  auditWarningBody: '业务调用本身仍然正常返回。',
  auditLastFailure: '最近一次失败：',
  auditHonesty: '计数只在本次运行内有效，重启会归零；此前未写成的记录不会被补写。',
  register: '配对新设备',
  diagnose: '诊断信息',
  forget: '忘记此设备',
  pendingTitle: '待确认设备',
  pendingLead: '这是这台电脑第一次连接 BrewPhase Cloud。确认之后，它才会绑定到下面的账号。',
  pendingDevice: '设备',
  pendingPlatform: '平台',
  pendingCode: '确认码',
  pendingExpires: '有效至',
  pendingAccount: '将绑定到',
  pendingAccountUnknown: '当前登录账户',
  pendingCodeHint:
    '确认码只用于这一步人工确认：不写入磁盘、不上传，也不会出现在日志里。',
  pendingTrustHint: '如果不是你本人发起的配对，点「取消本次配对」。',
  confirmDevice: '确认信任这台设备',
  cancelPairing: '取消本次配对',
  confirmingDevice: '正在确认…',
  claimingCredentials: '已确认，正在领取凭据…',
  savingCredential: '凭据保存中…',
  retryClaim: '重试领取凭据',
  cancellingPairing: '正在取消…',
  pairingDone: '配对完成，设备凭据已加密保存。',
  pairingRevoked: '已取消本次配对，云端设备已撤销。',
  pairingRevokePending: '本地已取消；云端设备未能撤销，它会在有效期结束后自动过期。',
  /** 已有配对在跑 / 已有设备时，「配对新设备」必须先被禁用（不能静默顶替）。 */
  pairingInProgress: '已有一台设备正在配对，请先确认或取消它。',
  alreadyPaired: '这台电脑已经配对过设备。要重新配对，请先「忘记此设备」。',
  confirmFailures: {
    unauthorized: '登录状态已失效，请重新登录 Cloud 账户后再试。',
    invalid_code: '确认码不正确。请核对后重试（连续错误会使设备作废）。',
    expired: '本次配对已过期，请重新「配对新设备」。',
    not_found: '这台设备不存在或不属于当前账户。请确认登录的是同一个账号。',
    device_state: '设备状态不允许确认（可能已被撤销），请重新配对。',
    rate_limited: '操作太频繁，请稍后再试。',
    account_changed: '确认过程中账户发生了变化，本次配对已作废。',
    network: '网络不可用，请检查连接后重试。设备仍在等待确认。',
    invalid_response: '服务端返回了无法识别的响应，请稍后重试。',
    claim_pending: '设备已确认，但凭据尚未领取完成。请稍后重试——配对仍然有效。',
    claim_network: '设备已确认，但领取凭据时网络异常。请检查连接后重试——配对仍然有效。',
    credentials_already_issued:
      '凭据已在云端签发，但本机没有拿到（领取只能进行一次）。为避免留下无法使用的设备，已尝试撤销它——请重新「配对新设备」。',
    credential_save_failed:
      '系统安全存储写入失败，凭据无法保存。为避免留下无法使用的设备，已尝试撤销它——请检查系统钥匙串/密钥环后重新配对。',
    credential_cleanup_failed:
      '这台设备的凭据没能安全保存，且云端设备也未能撤销。请到 Cloud 设备列表手动删除这台设备后重新配对。',
    superseded: '这次配对已被取消、顶替或因账户变化作废。'
  },
  socket: 'Socket',
  inflight: '在途请求',
  cache: '结果缓存',
  lastClose: '最近关闭',
  lastError: '最近错误',
  noError: '无',
  reconnectAttempt: '重连次数',
  lastErrorHint: '最近一次连接尝试的失败原因；成功握手后会清空。',
  scopeLabels: {
    records: '记录与笔记',
    tags: '标签',
    coffee: '豆子、冲煮与品鉴',
    canvas: '画布与便签'
  }
}

/** 设置 / Settings：页面骨架、二级导航、常规页。 */
export const settings = {
  title: '设置',
  subtitle: '管理应用、数据与连接',
  nav: {
    general: '常规',
    account: '云账户',
    sync: '设备同步',
    browser: '浏览器',
    chrome: 'Chrome 扩展',
    mcp: 'AI 连接',
    workspace: '本地工作区'
  },
  general: {
    title: '常规设置',
    subtitle: '外观、语言、应用与本地数据',
    appearance: '外观',
    appearanceHint: '「跟随系统」会随 macOS / Windows 的外观自动切换；选了浅色或深色就固定下来。',
    appearanceName: {
      system: '跟随系统',
      light: '浅色',
      dark: '深色'
    },
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
    ],
    update: {
      title: '应用更新',
      hint: '启动后自动检查一次，之后每 24 小时查一次；也可以随时手动检查。下载与安装只会在你点击「立即更新」之后发生。',
      check: '检查更新',
      checking: '正在检查…',
      idle: '还没有检查过更新',
      upToDate: (version: string) => `已是最新版本 ${version}`,
      available: (version: string) => `发现新版本 ${version}`,
      checkFailed: '检查更新失败，请稍后重试',
      unsupported: '当前构建不支持应用内自动更新，可前往下载页手动安装。',
      download: '立即更新',
      downloading: (percent: number) => `正在下载更新… ${percent}%`,
      downloaded: '下载完成，正在准备安装…',
      installing: '正在安装并重启…',
      downloadFailed: '更新下载失败',
      retry: '重试',
      autoRestart: '更新完成后应用会自动重启，请先保存正在编辑的内容。',
      open: '前往下载',
      lastChecked: (time: string) => `上次检查：${time}`,
      badge: '有新版本可用'
    }
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
  },

  workspace: {
    title: '本地工作区',
    subtitle: '登记 AI 卡片可以浏览（只读）的本地项目文件夹',
    add: '添加本地项目文件夹',
    addHint: '在系统对话框里选择文件夹；只登记授权，不会改动里面的任何文件。',
    empty: '还没有登记任何本地工作区。先添加一个，然后在任意 AI 卡片的 BrewPhase 按钮里绑定它。',
    pathLabel: '路径',
    statusLabel: '状态',
    available: '可用',
    missing: '文件夹缺失',
    rename: '重命名',
    renamePrompt: '新的显示名称',
    remove: '移除授权',
    removeConfirmTitle: '移除这个工作区授权？',
    removeConfirmBody: (name: string) => `只删除登记——文件夹「${name}」与其中的文件不会被改动。`,
    boundCards: (n: number) => `${n} 张卡片绑定`,
    addFailed: '无法添加这个文件夹'
  },

  account: {
    title: '云账户',
    subtitle: '登录 BrewPhase Cloud，用于跨设备的云端身份',
    lead: '登录只建立云端身份。豆子、冲煮、品鉴、记录与画布仍然只存在这台电脑上，不会自动上传。',
    signedOut: '未登录',
    signedOutHint: '不登录也能完整使用所有本地功能；云服务不可用时应用照常启动。',
    loginWith: (provider: string) => `使用 ${provider} 登录`,
    pending: '等待浏览器授权…',
    pendingHint: '授权完成后会自动回到这里，可以关掉浏览器那个标签页。',
    pendingExpires: (text: string) => `本次授权在 ${text} 前有效`,
    cancel: '取消登录',
    cancelling: '正在取消…',
    signedIn: '已登录',
    displayName: '名称',
    provider: '登录方式',
    providerName: {
      google: 'Google',
      github: 'GitHub'
    },
    accountId: '账户 ID',
    memberSince: '注册时间',
    displayNameFallback: '（未提供显示名称）',
    signOut: '退出登录',
    signOutTitle: '退出云账户？',
    signOutBody: '只清除这台电脑上的登录凭据。豆子、记录、画布与媒体不会被删除，局域网同步也不受影响。',
    checking: '正在向服务端确认会话…',
    verifiedAt: (text: string) => `上次确认：${text}`,
    notVerified: '本次启动尚未与服务端确认（离线时仍算已登录）',
    storageEncrypted: '登录状态以系统安全存储（safeStorage）加密保存在本机，明文不会落盘。',
    storageUnavailable: '系统安全存储不可用：本次登录只保留在内存里，重启后需要重新登录。',
    cloudBase: '服务地址',
    localDataNote: '云账户与设备同步是两套独立认证：在这里登录不会改动局域网配对，也不会替换同步 token。',
    refresh: '刷新状态',
    noticeTitle: '上次操作没有完成',
    notice: {
      cancelled: '已取消登录。',
      timeout: '等待授权超时，请重新发起登录。',
      'provider-denied': '你在授权页拒绝了访问。',
      'invalid-state': '回调校验失败（state 不匹配），本次登录已作废。',
      'exchange-failed': '授权码兑换失败，请重新登录。',
      'cloud-unreachable': '无法连接云服务，请检查网络或服务地址。',
      'cloud-timeout': '云服务响应超时。',
      'session-expired': '登录已过期，请重新登录。本地数据不受影响。',
      'storage-unavailable': '系统安全存储不可用，登录状态无法保存到本机。',
      'storage-failed': '本机登录凭据读取失败，已按未登录处理。',
      'login-in-progress': '已有一次登录在等待授权，请先完成或取消。',
      'browser-open-failed': '无法打开系统浏览器，请检查默认浏览器设置。',
      unknown: '登录未能完成，请重试。'
    }
  },
  remote
}
