/**
 * Records 模块文案（列表、搜索、筛选、编辑器、详情、预览、空状态）。
 * 新增条目必须同时更新 en-US/records.ts。
 */
export const records = {
  title: '记录',
  subtitle: '收集与探索',
  count: (count: string) => `${count} 条`,
  searchPlaceholder: '搜索标题、备注、网址…',
  allTags: '所有标签',
  empty: '还没有记录。先从一条链接、一张图或一段文字开始。',
  untitled: '未命名记录',
  newText: '新文字',
  newLink: '新链接',
  importImage: '导入图片',
  importedImageTitle: '导入的图片',
  carrier: {
    link: '链接',
    image: '图片',
    video: '视频',
    text: '文字'
  },
  platform: {
    web: '网页'
  },
  provider: {
    github: 'GitHub',
    youtube: 'YouTube',
    bilibili: '哔哩哔哩',
    x: 'X',
    generic: '网页'
  },
  link: {
    invalid: '不是有效的网页地址（只支持 http/https）',
    short: '短链接，保存后解析最终地址',
    contentId: '已提取内容 ID，保存后获取预览',
    tryPreview: '保存后尝试获取预览',
    recognized: (provider: string) => `已识别 ${provider}`
  },
  form: {
    title: '标题',
    url: '网址',
    body: '正文',
    invalidUrlNotSaved: '这不是有效的网页地址，未保存'
  },
  detail: {
    ariaLabel: '记录详情',
    close: '关闭详情'
  },
  errors: {
    recordDeleted: '要打开的记录已经被删除。',
    openFailed: (message: string) => `没能打开记录：${message}`
  },
  metadata: {
    pending: '正在获取预览…',
    ok: '预览信息已更新',
    partial: '已获取部分预览信息',
    unavailable: '暂时无法获取预览',
    fetching: '获取中…',
    fetch: '获取预览',
    refresh: '刷新预览'
  },
  inspector: {
    title: '记录属性',
    titleHint: '灰字是本机抓到的标题，输入后才会成为你的标题',
    note: '备注',
    tags: '标签',
    newTag: '新标签',
    addTag: '添加',
    saveChanges: '保存修改',
    deleteConfirm: '删除这条记录？它所在的画布节点会一起消失。',
    info: '信息',
    carrierLine: (name: string) => `载体：${name}`,
    createdLine: (value: string) => `创建：${value}`,
    updatedLine: (value: string) => `修改：${value}`,
    fileLine: (value: string) => `文件：${value}`
  },
  preview: {
    title: '预览信息',
    repository: '仓库',
    content: '内容',
    stats: '数据',
    socialPost: '社交动态'
  },
  player: {
    play: (title: string) => `播放：${title}`,
    note: '点封面在 App 内播放',
    collapse: '收起',
    expand: '放大',
    openBrowser: '浏览器打开'
  }
}
