/** AI Workspace（Multi-AI）文案。 */
export const aiWorkspace = {
  title: 'AI Workspace',
  nav: {
    multi: 'Multi-AI',
    conversations: '讨论记录',
    accounts: '账号'
  },
  providers: {
    chatgpt: 'GPT',
    claude: 'Claude'
  },
  login: {
    logged_in: '已登录',
    logged_out: '未登录',
    unknown: '状态未知',
    not_open: '页面未打开'
  },
  taskState: {
    idle: '空闲',
    checking: '检查页面…',
    ready: '就绪',
    sending: '发送中…',
    generating: '正在生成…',
    completed: '已完成',
    login_required: '需要登录',
    page_unavailable: '页面不可用',
    unsupported_page: '页面无法操作',
    timeout: '等待超时',
    failed: '失败',
    cancelled: '已取消'
  },
  ask: {
    placeholder: '问同一个问题，听两边的回答…',
    submit: '同时提问',
    submitBusy: '进行中…',
    stop: '停止任务',
    clear: '清空',
    pickHint: '选择要提问的平台（可多选）',
    emptyHint: '两份回答会并排显示在这里。第一次使用请先到「账号」里确认登录。'
  },
  result: {
    viewSource: '查看原网页',
    copy: '复制回答',
    copied: '已复制',
    noContent: '未能提取到回答内容——页面可能已改版，请到原网页确认。',
    notePrefix: '说明：'
  },
  accounts: {
    title: '账号与登录',
    lead: 'AI Workspace 使用内置浏览器的登录状态，不读取、不导出任何凭据。登录一次，之后一直有效。',
    openLogin: '打开登录页',
    reloadStatus: '刷新状态',
    urlLabel: '当前页面',
    empty: '还没打开过这个平台的页面。点「打开登录页」开始。'
  },
  conversations: {
    title: '讨论记录',
    lead: '每次「同时提问」会自动保存在这里，包括问题与每个平台的回答。',
    empty: '还没有记录。第一次讨论从 Multi-AI 开始。',
    delete: '删除',
    back: '返回列表',
    question: '问题'
  }
}
