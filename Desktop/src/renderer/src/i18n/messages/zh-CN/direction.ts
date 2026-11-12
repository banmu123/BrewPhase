/**
 * Personal Direction（现状 / 方向 / 阶段）的界面文案。
 *
 * 语气的底线：不催促、不打分、不承诺结果。所有句子都应该让用户觉得
 * 「这是我自己的事」，而不是「系统在考核我」。
 */
export const direction = {
  overline: 'PERSONAL DIRECTION',
  title: '我的方向',
  subtitle: '从现在的你，到想成为的样子',

  empty: {
    title: '还没有写下方向',
    body: '说说你现在在做什么、想去哪里。不用一次填完，之后随时可以补。',
    action: '开始梳理'
  },

  /** 三层共用一套状态词：方向与阶段的状态有交集，不各自发明叫法。 */
  status: {
    proposed: '待确认',
    active: '进行中',
    paused: '已暂停',
    completed: '已完成',
    achieved: '已达成',
    dropped: '已放下',
    revised: '已调整'
  },

  currentState: {
    title: '我的现状',
    review: '继续梳理',
    empty: '还没有描述现状'
  },

  stage: {
    current: '当前阶段',
    none: '还没有阶段目标',
    criteria: '完成标准',
    noCriteria: '还没有写完成标准',
    horizon: '时间范围'
  },

  /** 待确认提议的提示条：AI 写的东西一律先停在这里。 */
  proposal: {
    title: 'WorkBuddy 留了一条提议',
    more: (count: number) => `还有 ${count} 条待确认`,
    hint: '确认之后才会成为你的正式资料',
    fromState: '关于你的现状',
    fromDirection: '一个方向',
    fromStage: '一个阶段目标',
    confirm: '确认',
    discard: '忽略'
  },

  wizard: {
    title: '梳理我的方向',
    step: (current: number, total: number) => `第 ${current} 步 / 共 ${total} 步`,
    skip: '跳过这步',
    back: '上一步',
    next: '下一步',
    finish: '保存',
    saving: '正在保存…',
    saveError: '保存失败，请稍后再试。',
    /** 保存后只说事实，不祝贺、不总结「你迈出了重要一步」。 */
    saved: '已保存。之后随时可以改。',

    state: {
      title: '现在的你',
      hint: '想到哪写到哪。这些只有你自己看得到，也可以之后再改。',
      summary: '一句话描述现在的你',
      summaryPlaceholder: '例如：有一份稳定的工作，业余时间想把自己的产品做出来。',
      workStatus: '工作与职业状态',
      capabilities: '能力、经验和资源',
      ongoing: '正在推进的事',
      capacity: '能投入的时间与精力',
      constraints: '限制、困难和不满意的地方',
      other: '其他重要的状态'
    },

    dir: {
      title: '想成为的样子',
      hint: '不用量化，也不用写成指标。写你真正想要的那个状态。',
      name: '方向',
      namePlaceholder: '例如：成为一名独立开发者',
      description: '它具体是什么样',
      descriptionPlaceholder: '那时候你的日常、收入和节奏是怎样的？',
      motivation: '为什么想要它'
    },

    stage: {
      title: '这一段怎么走',
      hint: '把方向切成一段可以验证的路。没有完成标准也能先存着。',
      name: '阶段名称',
      namePlaceholder: '例如：发布第一个可以收费的版本',
      goal: '这一段想达成什么',
      criteria: '完成标准',
      criteriaPlaceholder: '怎么才算完成？写能被观察到的事。',
      horizon: '预计时间范围',
      horizonPlaceholder: '例如：三到六个月'
    },

    review: {
      title: '确认一下',
      hint: '保存后随时可以改。写下来的东西不是承诺。',
      state: '现状',
      directionLabel: '方向',
      stageLabel: '阶段',
      nothing: '还什么都没填。可以只存一个方向，也可以返回补一点。'
    }
  },

  /** 方向卡上的操作。放弃是「放下」而不是删除，记录还在。 */
  actions: {
    addStage: '加一个阶段',
    pause: '暂停',
    resume: '继续',
    achieve: '标记达成',
    drop: '放下',
    edit: '编辑',
    remove: '删除',
    removeConfirm: '删除这个方向？它的阶段会一起消失。'
  }
}
