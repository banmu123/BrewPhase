/** Studio Home 与全局顶栏。文案与其它字典一样：中文是类型基准。 */
export const studio = {
  brand: 'BREWPHASE',
  overline: '个人工作室',
  title: '为在意的事，留出位置。',
  subtitle: '你的桌面、你的收藏、你的想法。',
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
