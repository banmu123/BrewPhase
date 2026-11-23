/**
 * Canvas 模块文案（集合页、工作区、工具栏、便签、选择器、快捷键提示）。
 * 新增条目必须同时更新 en-US/canvas.ts。
 */
export const canvas = {
  title: '画布',
  subtitle: '连接与创作',

  untitledCanvas: '未命名画布',
  untitledRecord: '未命名记录',
  untitledVideo: '未命名视频',
  untitledLink: '未命名链接',
  newCanvasName: '新的画布',
  updatedAt: (date: string) => `${date} 更新`,
  gallerySubtitle: (count: number) => `你的创作空间 · ${count} 块`,

  gallery: {
    newCanvas: '新建画布',
    loading: '正在读取画布…',
    emptyTitle: '还没有画布。',
    emptyBody: '画布是一个自己命名的空间，把记录里的东西放在一起连接与创造。',
    rename: '重命名',
    deleteCanvas: '删除画布',
    renameNamed: (name: string) => `重命名 ${name}`,
    deleteNamed: (name: string) => `删除 ${name}`
  },

  workspace: {
    back: '返回画布集合',
    switchCanvas: '切换画布',
    myCanvases: '我的画布',
    newCanvas: '新建',
    focusMode: '沉浸模式',
    focus: '沉浸',
    noCanvas: '还没有画布。返回集合新建一块开始。',
    loading: '正在读取画布…',
    loadFailed: '画布内容没能读出来。',
    reload: '重新加载',
    noteHint: '在画布上点一下，放一张便签',
    closePanel: '关闭面板'
  },

  zoom: {
    controls: '画布缩放',
    out: '缩小',
    in: '放大',
    fit: '适配全部内容',
    fitTitle: '适配全部内容 (0)',
    fitLabel: '适配',
    reset: '回到 100%',
    resetTitle: '100% (1)'
  },

  carrier: {
    all: '全部',
    image: '图片',
    video: '视频',
    link: '链接',
    text: '文字'
  },

  picker: {
    title: '添加记录',
    subtitle: '从你的收藏中挑选内容',
    searchPlaceholder: '搜索标题、备注、来源、作者…',
    alreadyOnCanvas: ' · 已在画布',
    selected: ' · 已选择',
    loading: '正在读取…',
    loadingMore: '正在加载更多…',
    empty: '没有匹配的记录。',
    clearSearch: '清除搜索',
    addCount: (count: number) => `加入 ${count} 项`,
    batchPartial: (added: number, names: string[], failed: number, error: string) =>
      `已加入 ${added} 项${names.length ? `（${names.join('、')}）` : ''}；${failed} 项加入失败：${error}`
  },

  journey: {
    section: 'Agent Journey',
    sectionHint: '一次完整执行记录，放进画布会展开成流程图',
    add: '加入画布',
    added: '已在画布',
    empty: '还没有 Agent Journey。',
    emptyHint: 'Agent 执行多步骤任务时会自动沉淀成 Journey。',
    status: {
      created: '已创建',
      running: '进行中',
      paused: '已暂停',
      completed: '已完成',
      failed: '已失败',
      cancelled: '已取消',
      abandoned: '已放弃'
    },
    collapse: '折叠分组',
    expand: '展开分组',
    removeFromCanvas: '从画布移除',
    removeFromCanvasHint: '只移除画布上的摆位，Journey 本身与笔记、关系都还在。',
    eventCount: (count: number) => `${count} 个事件`,
    linkedCount: (count: number) => `${count} 条关联`,
    linkToRecord: '连接到记录',
    linkType: {
      references: '参考',
      supports: '支持',
      produces: '产生',
      validates: '验证',
      related_to: '相关'
    },
    linkPickRecord: '选择目标记录',
    linkCreate: '建立连接',
    linkRemove: '删除连接',
    linkEmpty: '还没有建立连接。',
    noteLabel: '我的笔记',
    notePlaceholder: '写下你的经验、提醒或评价——只属于你，不会改写 Agent 的原始记录。',
    noteJourneyLevel: '整条 Journey 的笔记',
    noteEventLevel: '这个节点的笔记',
    noteSave: '保存笔记',
    noteDelete: '删除笔记',
    noteEmpty: '还没有笔记。',
    notesCount: (count: number) => `${count} 条笔记`,
    timeline: '执行时间线',
    sequence: (value: number) => `#${value}`,
    eventType: {
      user_input: '用户需求',
      plan: '计划',
      decision: '决策',
      execution: '执行',
      observation: '观察',
      revision: '修订',
      verification: '验证',
      outcome: '结果',
      user_annotation: '用户补充'
    },
    eventStatus: {
      planned: '待执行',
      running: '执行中',
      completed: '已完成',
      failed: '已失败',
      skipped: '已跳过',
      cancelled: '已取消'
    },
    edgeType: {
      depends_on: '依赖',
      branch_from: '分支',
      revises: '修订',
      retries: '重试'
    },
    addRecordTarget: '添加记录到画布后再连接',
    selectEventFirst: '先选中一个事件节点',
    detailTitle: 'Journey 详情',
    goal: '目标',
    outcome: '最终结果',
    source: (name: string) => `来源：${name}`,
    createdAt: (value: string) => `创建：${value}`,
    updatedAt: (value: string) => `更新：${value}`,
    openInRecords: '在记录中查看'
  },

  inspector: {
    title: '选中内容',
    overline: '已选中',
    play: '▶ 播放',
    stopPlay: '⏸ 停止播放',
    annotationLabel: '画布备注',
    annotationPlaceholder: '只属于这块画布，不会改动记录本身。',
    editAnnotation: '编辑画布备注',
    remove: '从画布移除',
    removeHint: '只解除引用，原始记录还在记录库里。',
    annotationQuote: (text: string) => `「${text}」`
  },

  contextMenu: {
    openRecord: '打开原记录',
    openSource: '打开原始来源'
  },

  player: {
    videoTitle: '视频播放',
    loadFailed: '视频加载失败。',
    openInBrowser: '在浏览器打开',
    stop: '停止播放',
    stopTitle: '停止播放 (Esc)'
  },

  dialog: {
    createTitle: '新建画布',
    renameTitle: '重命名画布',
    deleteTitle: '删除这块画布？',
    deleteBody: '画布上的节点、便签和笔迹会一起消失；原始记录不受影响，删除后不可恢复。',
    namePlaceholder: '画布叫什么',
    confirmDelete: '确认删除'
  },

  tools: {
    selectHint: '选择 (V)',
    handHint: '抓手 (H / Space)',
    penHint: '画笔 (P)',
    eraserHint: '按笔画擦除 (E)',
    noteHint: '点画布放便签 (N)',
    penColor: (color: string) => `画笔颜色 ${color}`
  },

  toolbar: {
    note: '便签',
    newNoteTitle: '新建便签 (N)',
    image: '图片',
    importImageTitle: '导入图片',
    record: '记录',
    addRecordTitle: '添加记录'
  },

  save: {
    saved: '已保存',
    failed: '保存失败'
  },

  note: {
    defaultTitle: '便签',
    defaultBody: '双击编辑这条想法。',
    titlePlaceholder: '标题',
    bodyPlaceholder: '写点什么…',
    colorLabel: (color: string) => `便签颜色 ${color}`,
    delete: '删除便签',
    done: '完成'
  },

  textCard: {
    noBody: '（没有正文）'
  },

  empty: {
    overline: '从一个小动作开始',
    addRecord: '添加一条记录',
    addImage: '导入一张图片',
    addNote: '创建一张便签',
    draw: '随手画一笔'
  }
}
