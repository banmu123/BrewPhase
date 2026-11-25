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
  journey: {
    typeLabel: 'Agent Journey',
    chip: 'Agent Journey',
    empty: '还没有 Agent Journey。',
    emptyHint: 'Agent 执行多步骤任务时会自动沉淀成一条完整记录。',
    events: (count: number) => `${count} 个事件`,
    links: (count: number) => `${count} 条关联`,
    notes: (count: number) => `${count} 条笔记`,
    status: {
      created: '已创建',
      running: '进行中',
      paused: '已暂停',
      completed: '已完成',
      failed: '已失败',
      cancelled: '已取消',
      abandoned: '已放弃'
    },
    changesCount: (count: number) => `${count} 个文件`,
    verifyCount: (count: number) => `${count} 项验证`,
    detail: {
      expand: '展开详细信息',
      collapse: '收起详细信息',
      noDetail: '尚无详细执行信息',
      overview: '处理概览',
      changes: '修改位置',
      noChanges: '本步骤没有文件修改。',
      changeType: {
        created: '新建',
        modified: '修改',
        deleted: '删除',
        renamed: '重命名'
      },
      symbols: '涉及符号',
      changeSummary: '改动内容',
      before: '修改前',
      after: '修改后',
      why: '为什么改在这里',
      decision: '决策依据',
      selected: '选择的方案',
      rationale: '选择理由',
      alternatives: '放弃的方案',
      notSelected: '未选择原因',
      tradeoffs: '已知代价与限制',
      verification: '实际验证',
      command: '命令',
      target: '验证目标',
      exitCode: '退出码',
      result: {
        passed: '通过',
        failed: '失败',
        not_run: '未运行',
        skipped: '已跳过'
      },
      evidenceRef: '可追溯引用',
      observations: '实际观察',
      impact: '影响',
      source: '来源',
      evidence: '证据来源',
      agentReported: 'Agent 自述',
      agentReportedHint: '本条由 Agent 提交，未经本地运行时独立复核；有引用的条目可另行追溯。',
      references: '引用',
      refKind: {
        commit: '提交',
        diff: 'Diff',
        test: '测试',
        file: '文件',
        record: '记录',
        url: '链接'
      },
      limitations: '尚未解决'
    },
    detailAria: 'Agent Journey 详情',
    goal: '任务目标',
    timeline: '执行过程',
    // R6-P5.1：Execution 时间线的 Evidence 摘要与文件级对照（不含 Diff 正文）
    evidence: {
      loading: '正在加载工作区证据…',
      loadFailed: '工作区证据查询失败。',
      retry: '重试',
      confidence: {
        confirmed: '观察窗口完整，结论可靠',
        window_net_change: '窗口内 HEAD 有变动，只能确认净变化',
        unconfirmed: '基线或结束快照缺失，无法确认'
      },
      countsLine: (
        reported: number,
        observed: number,
        matched: number,
        reportedOnly: number,
        observedOnly: number
      ) =>
        `Agent 报告 ${reported} · 工作区观察 ${observed} · 匹配 ${matched} · 仅报告 ${reportedOnly} · 仅观察 ${observedOnly}`,
      filesCount: (count: number) => `${count} 个证据文件`,
      emptyComplete: '观察窗口完整，本次未发现净文件变化。',
      emptyIncomplete: '观察窗口未完整，暂时无法确认文件变化。',
      agentReported: 'Agent 报告',
      workspaceObserved: '工作区观察',
      reportedOnlyHint:
        '可能是改后还原、观察时间不完整，或变化发生在窗口之外，不代表报告不真实。',
      attribution: {
        reported_and_observed: '已报告并观察到',
        observed_only: '仅系统观察到',
        reported_only: '仅 Agent 报告，未观察到净变化'
      },
      changeKind: {
        added: '新增',
        modified: '修改',
        deleted: '删除',
        renamed: '重命名',
        type_changed: '类型变化',
        conflicted: '冲突',
        mode_changed: '权限位变化'
      },
      observation: {
        changed: '净变化已确定',
        unavailable: '净变化不可判定',
        legacy: '历史记录未保存观察状态'
      },
      artifactKind: {
        diff: 'Diff 正文',
        binary: '二进制文件',
        sensitive: '已按敏感文件规则排除',
        mode_only: '仅权限位变化',
        symlink: '符号链接',
        over_budget: '已超容量限制',
        unavailable: '未生成 Diff 正文'
      },
      artifactOmission: {
        file_budget: '单文件超限',
        snapshot_budget: '单快照超限',
        journey_budget: 'Journey 总量超限',
        source_too_large: '源文件过大',
        algorithm_budget: 'Diff 计算超预算',
        baseline_not_stored: '基线内容未留存',
        current_not_stored: '当前内容未留存',
        blob_missing: 'Git 对象缺失',
        decode_failed: '内容非文本',
        not_observable: '不可观测',
        stale: '数据已过期'
      },
      renameFrom: (path: string) => `原路径：${path}`,
      diffStat: (insertions: number, deletions: number) => `+${insertions} / −${deletions}`
    },
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
    edgeLabel: (kind: string) => `关系：${kind}`,
    source: (name: string) => `来源：${name}`,
    selfReported: 'Agent 自述',
    addToCanvas: '添加到画布',
    addToCanvasPick: '选择画布',
    addToCanvasDone: (name: string) => `已加入「${name}」`,
    addToCanvasFailed: (error: string) => `加入画布失败：${error}`,
    notesTitle: '我的笔记',
    notePlaceholder: '写下你的经验、提醒或评价——只属于你，不会改写 Agent 的原始记录。',
    noteSave: '保存',
    noteDelete: '删除',
    noteEventLevel: '这个节点的笔记',
    noteJourneyLevel: '整条 Journey 的笔记',
    noteSaving: '保存中…',
    noteSaved: '已保存',
    recordUnavailable: '记录已不可用',
    recordResolving: '读取中…',
    eventMissing: '事件已删除',
    noteEmpty: '还没有笔记。',
    linksTitle: '关联记录',
    linkEmpty: '还没有关联记录。',
    linkRemove: '删除关联',
    linkType: {
      references: '参考',
      supports: '支持',
      produces: '产生',
      validates: '验证',
      related_to: '相关'
    },
    outcome: '最终结果',
    // R6-4.3.1：工作区关联（只显示登记名，不显示机器绝对路径）
    workspaceTitle: '工作区',
    workspaceNone: '未关联工作区',
    workspaceLinked: (name: string) => `已关联：${name}`,
    workspaceUnavailable: (name: string) => `工作区不可用：${name}（文件夹已失效）`,
    workspaceDeleted: '原工作区已删除，关联已解除',
    workspacePick: '选择工作区',
    workspaceOptionUnavailable: '（不可用）',
    workspaceNoRegistered: '还没有登记的工作区，可先到工作区页面添加。',
    workspaceBind: '关联',
    workspaceRebind: '换绑',
    workspaceUnbind: '解除关联',
    workspaceLockedStarted: '执行已开始，不能再更改工作区关联。',
    workspaceLockedFinished: 'Journey 已结束，不能再更改工作区关联。',
    workspaceBindDone: (name: string) => `已关联「${name}」`,
    workspaceBindFailed: (error: string) => `关联失败：${error}`,
    workspaceUnbindDone: '已解除关联',
    workspaceUnbindFailed: (error: string) => `解除关联失败：${error}`,
    // R6-4.3.1.1：列表读取状态（与「已删除」严格区分）
    workspaceLoading: '正在读取工作区信息……',
    workspaceLoadFailed: '暂时无法读取工作区信息，请重试。',
    workspaceRetry: '重试'
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
    deleteTitle: '删除这条记录？',
    deleteBody: '它所在的画布节点会一起消失，删除后无法恢复。',
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
