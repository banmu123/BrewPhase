/**
 * 首次启动引导。
 *
 * 两部分：统一入口（连接 AI / 配对 iPhone / 先进入）与 AI 接入流程。
 * 语气要求：两条路径都是可选的，不催促、不暗示「不连就落后」。
 */
export const onboarding = {
  overline: 'BREWPHASE / DESKTOP',
  title: '把你的个人空间，延伸到桌面',
  lead: 'BrewPhase Desktop 是移动设备上 BrewPhase 的桌面工作台：豆子、冲煮、品鉴、收藏记录与画布，都从移动设备经局域网同步过来；桌面端本身不预置任何数据。配对只需三步：',
  step1: '在移动设备上打开 BrewPhase，找到「桌面同步」入口（iOS：更多 → 数据 → 桌面同步）。',
  step2: '回到桌面端，打开「设置 → 设备同步」，启用同步并生成配对二维码。',
  step3: '用移动设备扫描二维码完成配对，数据会自动同步到桌面。',
  openSettings: '打开设备同步设置',
  later: '先逛逛',
  privacyNote: '数据只在本机与移动设备之间经局域网传输——没有云端，没有账号。',

  // MARK: - 统一入口

  welcome: {
    title: '你的个人空间，也可以连接你信任的 AI 工具。',
    lead: 'BrewPhase 把你的数据保存在本机。你可以选择连接 AI Agent，让它在明确授权的范围内读取和协助整理你的个人资料。',
    connectAgent: '连接 AI Agent',
    pairPhone: '配对 iPhone',
    skip: '暂时跳过，先进入 BrewPhase',
    note: '两条路径都是可选的，之后随时可以在设置里配置。'
  },

  // MARK: - AI 接入

  agent: {
    title: '连接 AI Agent',
    lead: '选一个 Agent，BrewPhase 会为它单独创建一个客户端，只授予你勾选的权限。',
    back: '返回',
    kindTitle: '用哪个 Agent',
    kinds: {
      workbuddy: 'WorkBuddy',
      codex: 'Codex',
      other: '其他 MCP 客户端'
    },
    kindHints: {
      workbuddy: '配置写进 ~/.workbuddy/mcp.json',
      codex: '配置写进 ~/.codex/config.toml',
      other: '通用 JSON，字段按客户端文档调整'
    },
    unsupportedTitle: '这台机器暂时无法连接',
    unsupportedBody:
      '本地 Bridge 在当前平台不可用，Agent 无法连上 BrewPhase。你仍然可以正常使用应用。',
    scopeTitle: '授予的权限',
    presets: {
      personalGrowth: '个人成长（推荐）',
      personalGrowthCollab: '个人成长协作',
      recordsOnly: '只看记录'
    },
    presetHints: {
      personalGrowth: '读取现状、方向、阶段、工作上下文与记录。不含任何写权限。',
      personalGrowthCollab: '在推荐基础上，允许 Agent 写待你确认的草稿——确认仍然只能由你在应用内完成。',
      recordsOnly: '只读你的记录。'
    },
    scopeLabel: {
      'direction:read': '读取你确认过的现状、方向和阶段',
      'work_context:read': '读取持续工作上下文',
      'records:read': '读取你保存的记录',
      'direction:propose': '创建待你确认的方向草稿（不能确认）'
    },
    custom: '自定义权限',
    create: '创建客户端',
    creating: '正在创建…',

    created: (name: string) => `「${name}」已创建`,
    tokenOnce: 'Token 只显示这一次，请先复制保存。',
    copyToken: '复制 Token',
    copyConfig: '复制配置',
    configHint: {
      workbuddy: '打开 WorkBuddy 的 MCP 配置（通常是 ~/.workbuddy/mcp.json），把这段合并进 mcpServers，保存后重启 WorkBuddy。',
      codex: '打开 ~/.codex/config.toml，把这段追加进去，保存后重启 Codex。',
      other: '按你的客户端文档，把这段合并进它的 MCP 配置，保存后重启客户端。'
    },

    verifyTitle: '确认真的连上了',
    verifyHint: '复制配置不等于连上。在 Agent 里发这句话，让它实际读一次：',
    verifyPrompt: '请读取我的 BrewPhase 当前方向和阶段，并简要告诉我读取到的信息。',
    verifyWaiting: '正在等待第一次调用…',
    verifySuccess: '已连接——Agent 刚刚成功调用了 BrewPhase。',
    verifyTimeout:
      '还没检测到调用。请确认：配置已保存、Agent 已重启、BrewPhase 仍开着。',
    verifyRetry: '再检测一次',
    revokeHint: '这个客户端随时可以在 设置 → AI 连接 里撤销。',
    done: '完成'
  }
}
