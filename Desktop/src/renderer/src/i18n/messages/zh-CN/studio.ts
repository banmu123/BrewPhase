/** Studio Home 与全局顶栏。文案与其它字典一样：中文是类型基准。 */
export const studio = {
  brand: 'BREWPHASE',
  appMenu: '应用菜单（Alt 也可唤出）',
  overline: '个人工作室',
  // 品牌主文案：Studio Home 的固定标题已改为动态问候，但 About / 产品宣传等
  // 场景仍可能复用这句，所以保留原键，不随本次改动全局删除。
  title: '为在意的事，留出位置。',
  subtitle: '你的桌面、你的收藏、你的想法。',
  /** 动态问候：按设备本地时段取 `greeting[key]`，标识由 shared/greeting.ts 提供。 */
  greeting: {
    lateNight: '夜深了',
    morning: '上午好',
    midday: '中午好',
    afternoon: '下午好',
    evening: '晚上好'
  },
  /** 辅助文案：所有时段统一，视觉权重低于标题。 */
  greetingSubtitle: '今天，也按自己的节奏来。',
  back: '返回 Studio',
  search: '搜索记录',
  quickAdd: '快速添加',
  settings: '设置',
  searchTitle: '搜索',
  searchPlaceholder: '输入关键词，找一条记录',
  searchEmpty: '输入关键词开始搜索。',
  searchNoResults: '没有找到匹配的记录。',
  quickAddTitle: '放点什么进来',
  quickAddHint: '选择一种内容，继续在它自己的空间里完成。',
  newBean: '新增一包豆',
  newText: '写一段文字',
  newLink: '收藏一个链接',
  newCanvas: '新建一块画布',
  workContext: {
    overline: 'WORK CONTEXT',
    title: '继续工作',
    nextStep: '下一步',
    status: { active: '进行中', paused: '已暂停', completed: '已完成' },
    counts: (records: number, canvases: number, urls: number) =>
      `${records} 条记录 · ${canvases} 块画布 · ${urls} 个链接`
  },
  /** 网页卡片架（「正在使用」）：Studio Home 底部第一层。 */
  webShelf: {
    overline: 'IN USE',
    title: '正在使用',
    add: '添加网页',
    unnamed: '未命名网页',
    emptyDomain: '还没有地址',
    editHint: '双击编辑；按住拖动可排序或拖入圆桌',
    inRoundtable: '在圆桌上',
    close: '关闭网页卡片',
    namePlaceholder: '名称（如 ChatGPT）',
    urlPlaceholder: '网址（如 https://chatgpt.com）',
    save: '保存',
    cancel: '取消',
    status: {
      empty: '空白',
      ready: '已就绪',
      loading: '加载中',
      error: '加载失败'
    }
  },
  /** AI 圆桌：Studio Home 底部第二层。 */
  roundtable: {
    title: '圆桌',
    count: (n: number) => `${n} 位参与者`,
    emptyTitle: '把网页卡片放到这里',
    emptyHint: '选择你想参与讨论的 AI 网页',
    joined: '已加入圆桌',
    remove: (name: string) => `移除 ${name}`,
    removeAction: '移除',
    askLabel: '讨论问题',
    askPlaceholder: '输入一个问题，让参与者一起讨论…',
    askPlaceholderIdle: '先拖入参与者，再开始讨论',
    start: '开启圆桌',
    undock: '独立展开圆桌',
    undockAction: '独立展开',
    dock: '圆桌归位',
    dockAction: '归位',
    close: '收起浮动圆桌（归位）',
    slotHint: '圆桌正在独立工作',
    dragHint: '拖动标题栏移动圆桌；拖动停靠位标题栏可拆出浮动',
    resizeHint: '拖动调整圆桌大小'
  },
  coffee: {
    overline: 'COFFEE / SHELF',
    hint: '像书架上的包装袋，一层一层收着。',
    open: '打开收藏架',
    emptyTitle: '你的咖啡架还在等。',
    emptyHint: '把喜欢的咖啡，一杯一杯收进来。',
    emptyAction: '收入第一包豆',
    count: (n: number) => `${n} 包豆子`,
    unnamed: '未命名豆子',
    noRoaster: '未记录烘焙商'
  },
  records: {
    overline: 'RECORDS / LIBRARY',
    hint: '图片、链接与文字，慢慢攒成自己的 library。',
    open: '打开收藏库',
    emptyTitle: '值得留下的，都收进来。',
    emptyHint: '存一个念头、一条链接，或一个瞬间。',
    emptyNote: '写一段文字',
    emptyLink: '存一条链接',
    untitled: '未命名记录'
  },
  canvas: {
    overline: 'CANVAS / CREATIVE SPACE',
    hint: '摊开的项目，留着当时摆放的样子。',
    open: '打开画布',
    emptyTitle: '每个想法，都始于一张空桌。',
    emptyHint: '给思绪一个成形的地方。',
    emptyAction: '新建一块画布',
    count: (n: number) => `${n} 块画布`,
    untitled: '未命名画布',
    updated: (date: string) => `更新于 ${date}`
  }
}
