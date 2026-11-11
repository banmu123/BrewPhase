/**
 * Coffee 模块文案（页面、豆子、冲煮、品鉴、空状态、表单）。
 *
 * 由 Coffee 页面维护者补全：新增条目时**必须同时**更新 en-US/coffee.ts，
 * 否则类型检查会失败（en 侧 `satisfies Messages`）。
 */
export const coffee = {
  title: '咖啡',
  subtitle: '观察与实验',
  shelfSummary: (n: number) => `你的咖啡架 · ${n} 包在架`,
  currentlyBrewing: '正在喝',
  addBean: '新增豆子',
  unnamedBean: '未命名豆子',
  noRoaster: '未填烘焙商',
  noMethod: '未填手法',
  noFlavor: '未记风味',
  beanDetail: '豆子详情',
  closeDetail: '关闭详情',
  beanProfile: '豆子档案',
  editProfile: '编辑档案',
  phaseWindow: '风味窗口',
  roastedOn: (date: string) => `烘焙 ${date}`,
  dayCount: (n: number) => `第 ${n} 天`,
  status: {
    active: '在喝',
    finished: '已喝完'
  },
  brews: (n: number) => `冲煮 · ${n}`,
  tastings: (n: number) => `品鉴 · ${n}`,
  logBrew: '记一杯',
  deleteBrewTitle: '删除这次冲煮，库存按实扣量退回',
  deleteBean: '删除这包豆子',
  confirmDeleteBean: (name: string) => `删除「${name}」？它的冲煮与品鉴会一并删除。`,
  windowNote: (restMin: number, restMax: number, peakStart: number, peakEnd: number, declineStart: number) =>
    `养豆 ${restMin}–${restMax} 天 · 黄金 ${peakStart}–${peakEnd} 天 · 第 ${declineStart} 天起衰减`,
  windowNoteHint: '基于默认窗口估算，不是保质期结论。',
  newBean: '新的一包豆',
  form: {
    name: '名字',
    roaster: '烘焙商',
    roastLevel: '烘焙度',
    roastDate: '烘焙日期',
    openDate: '开封日期',
    weightG: '总量 g',
    remainingG: '剩余 g',
    price: '价格'
  },
  placeholder: {
    name: '例如：哥伦比亚 粉波旁',
    roaster: '例如：Onibus'
  },
  roastLevel: {
    light: '浅烘',
    medium: '中烘',
    mediumDark: '中深烘',
    dark: '深烘',
    espressoBlend: '意式拼配'
  },
  phase: {
    resting: { title: '养豆期', hint: '正在养豆' },
    opening: { title: '风味打开', hint: '风味开始打开' },
    peak: { title: '黄金风味期', hint: '现在喝' },
    declining: { title: '风味衰减', hint: '建议优先饮用' }
  },
  stockNote: '改「剩余 g」等于一次盘点：之前的冲煮不再参与自动退粉。',
  empty: {
    noBeans: '还没有豆子。先记一包，冲煮与品鉴会挂到它下面。',
    noBrews: '还没有冲煮记录。记一杯，库存会按实际粉量扣。',
    noTastings: '还没有品鉴。记一杯之后会自动留下一条。',
    noRule: '没有可用规则。'
  },
  brew: {
    method: '手法',
    grind: '研磨',
    coffeeG: '粉量 g',
    waterG: '水量 g',
    waterTemp: '水温 ℃',
    time: '时间 秒',
    score: '评分',
    notes: '备注',
    save: '保存这杯'
  }
}
