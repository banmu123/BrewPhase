/** AI 连接（MCP 客户端授权、Token、配置复制、Bridge 状态）。 */
export const mcp = {
  overline: 'AI 连接',
  headline: '让 Codex、WorkBuddy 这类 Agent 读写你的 BrewPhase。',
  intro:
    '每个客户端单独授权、单独撤销；权限检查在桌面端主进程完成，Agent 拿不到数据库，也没有删除权限。写入只落在这台 Mac 上（不会自动同步回移动设备）。',
  bridge: {
    running: (socket: string) => `Bridge：运行中 · ${socket}`,
    stopped: 'Bridge：未运行',
    unsupported: '（当前平台 V1 不支持本地 Bridge）'
  },
  created: {
    title: (name: string) => `「${name}」已创建——token 只显示这一次`,
    copyToken: '复制 Token',
    copyCodex: '复制 Codex 配置',
    copyWorkBuddy: '复制 WorkBuddy 配置',
    dismiss: '我已保存，收起'
  },
  create: {
    title: '新建客户端',
    name: '名称',
    namePlaceholder: '例如 Codex / WorkBuddy',
    submit: '创建并生成 Token',
    scopeGroup: {
      records: '记录',
      tags: '标签',
      coffee: '咖啡',
      workContext: '工作上下文',
      canvas: '画布',
      direction: '个人方向'
    }
  },
  clients: {
    title: '已授权客户端',
    empty: '还没有已授权的客户端。',
    revoked: '（已撤销）',
    lastUsed: (when: string) => `最近使用：${when}`,
    revoke: '撤销',
    revokeConfirm: '确认撤销'
  },
  local: {
    title: '本机连接信息',
    entry: 'MCP 入口',
    dataDir: '数据目录',
    command: '启动命令',
    buildHint: (command: string) => `需要先运行 ${command}，并保持 BrewPhase Desktop 打开。`,
    copyInfo: '复制启动信息'
  }
}
