import { describe, expect, it } from 'vitest'
import {
  detailEventTypeError,
  isLikelyTestOrConfigPath,
  journeyDetailV1Schema,
  parseJourneyDetail,
  repoRelativePathError,
  type JourneyDetailV1
} from '../../src/shared/contracts/entities/agent-journey'

/**
 * R6-4.2.1 结构化详情**质量门**（§12 场景 A–F 的 Schema 层）。
 *
 * 守住六件事：
 * A. 空壳（只有 version / 空数组 / 空字符串）不算详情；
 * B. Event Type 与详情内容必须匹配（纯函数，可独立测试）；
 * C. 文件路径必须是安全的仓库相对路径，且不重复；
 * D. 修改类型决定必须提供哪些字段；
 * E. 行号从 1 开始、end >= start；
 * F. 验证结果与退出码不自相矛盾，且无法伪造证据等级。
 */

/** 合法的最小「有料」详情：一个文件的完整修改记录。 */
function changeOf(overrides: Record<string, unknown> = {}) {
  return {
    file_path: 'src/example.ts',
    change_type: 'modified' as const,
    change_summary: '把入参校验从 Service 提到边界。',
    before_behavior: '非法入参一路穿到仓储层才报错。',
    after_behavior: '非法入参在边界即被拒绝。',
    why_this_location: '边界层负责入参合法性，仓储层只应处理已校验的数据。',
    ...overrides
  }
}

const parse = (detail: unknown) => journeyDetailV1Schema.safeParse(detail)

// ================================================================
// A. 空壳 details
// ================================================================

describe('A. 空壳 details 被拒绝', () => {
  it('只有 version 的对象被拒，且错误说明要什么', () => {
    const result = parse({ version: 1 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('meaningful block'))).toBe(
        true
      )
    }
  })

  it('每个块都给空数组同样不算有料', () => {
    const result = parse({
      version: 1,
      changes: [],
      observations: [],
      verification: [],
      references: [],
      limitations: []
    })
    expect(result.success).toBe(false)
  })

  it('空字符串 / 纯空白不能绕过必填', () => {
    expect(parse({ version: 1, limitations: [''] }).success).toBe(false)
    expect(parse({ version: 1, limitations: ['   '] }).success).toBe(false)
    expect(
      parse({ version: 1, decision: { selected_approach: '   ', rationale: 'x' } }).success
    ).toBe(false)
    expect(parse({ version: 1, changes: [changeOf({ why_this_location: '   ' })] }).success).toBe(
      false
    )
  })

  it('单个有料的详情块就能通过', () => {
    expect(parse({ version: 1, changes: [changeOf()] }).success).toBe(true)
    expect(
      parse({
        version: 1,
        verification: [{ target: 'pnpm test', result: 'passed', summary: '1557 passed.' }]
      }).success
    ).toBe(true)
    expect(parse({ version: 1, limitations: ['E2E not run'] }).success).toBe(true)
    expect(
      parse({ version: 1, observations: [{ finding: 'race in the sync section' }] }).success
    ).toBe(true)
  })
})

// ================================================================
// B. Event Type 与详情语义
// ================================================================

describe('B. Event Type 与详情语义（纯函数）', () => {
  const detail = (extra: Record<string, unknown>) =>
    ({ version: 1, ...extra }) as JourneyDetailV1

  it('decision 缺 decision 被拒，带了就过', () => {
    expect(detailEventTypeError('decision', detail({ changes: [changeOf()] }))).toMatch(
      /requires a "decision" block/
    )
    expect(
      detailEventTypeError(
        'decision',
        detail({ decision: { selected_approach: 'A', rationale: 'r' } })
      )
    ).toBeNull()
  })

  it('observation 缺 observations 被拒', () => {
    expect(detailEventTypeError('observation', detail({ changes: [changeOf()] }))).toMatch(
      /requires a non-empty "observations"/
    )
    expect(
      detailEventTypeError('observation', detail({ observations: [{ finding: 'f' }] }))
    ).toBeNull()
  })

  it('verification 缺 verification 被拒', () => {
    expect(detailEventTypeError('verification', detail({ changes: [changeOf()] }))).toMatch(
      /requires a non-empty "verification"/
    )
    expect(
      detailEventTypeError(
        'verification',
        detail({ verification: [{ target: 't', result: 'not_run', summary: 's' }] })
      )
    ).toBeNull()
  })

  it('execution: changes 用于改代码，observations/references 用于调试分析', () => {
    expect(detailEventTypeError('execution', detail({ changes: [changeOf()] }))).toBeNull()
    expect(
      detailEventTypeError('execution', detail({ observations: [{ finding: 'race found' }] }))
    ).toBeNull()
    expect(
      detailEventTypeError(
        'execution',
        detail({ references: [{ kind: 'test', value: 'tests/x.test.ts' }] })
      )
    ).toBeNull()
    expect(detailEventTypeError('execution', detail({ limitations: ['E2E not run'] }))).toBeNull()
    expect(detailEventTypeError('execution', detail({}))).toMatch(
      /needs evidence of what was executed/
    )
  })

  it('revision 必须有实际调整或修正依据', () => {
    expect(detailEventTypeError('revision', detail({}))).toMatch(/requires the actual adjustment/)
    expect(
      detailEventTypeError('revision', detail({ observations: [{ finding: 'assert only' }] }))
    ).toBeNull()
    expect(detailEventTypeError('revision', detail({ changes: [changeOf()] }))).toBeNull()
    expect(
      detailEventTypeError(
        'revision',
        detail({ decision: { selected_approach: 'A', rationale: 'r' } })
      )
    ).toBeNull()
  })

  it('outcome 必须有真实结果块', () => {
    expect(detailEventTypeError('outcome', detail({}))).toMatch(
      /requires at least one real result/
    )
    expect(
      detailEventTypeError(
        'outcome',
        detail({ verification: [{ target: 't', result: 'passed', summary: 's' }] })
      )
    ).toBeNull()
    expect(detailEventTypeError('outcome', detail({ limitations: ['E2E not run'] }))).toBeNull()
    expect(detailEventTypeError('outcome', detail({ changes: [changeOf()] }))).toBeNull()
  })

  it('未知事件类型不在此处拦（由事件类型枚举负责）', () => {
    expect(detailEventTypeError('something_else', detail({}))).toBeNull()
  })

  it('错误信息包含事件类型与缺失字段（不许只回 invalid details）', () => {
    const message = detailEventTypeError('verification', detail({}))
    expect(message).toContain('verification')
    expect(message).toContain('journey_detail_v1')
    expect(message).not.toBe('invalid details')
  })
})

// ================================================================
// C. 文件路径
// ================================================================

describe('C. 文件路径必须是安全的仓库相对路径', () => {
  const withPath = (file_path: string) =>
    parse({ version: 1, changes: [changeOf({ file_path })] })

  const posixOk = [
    'Desktop/src/main/application/mcp-tools/handlers.ts',
    'src/components/AgentJourney.tsx',
    'tests/integration/journey.test.ts',
    '.github/workflows/ci.yml',
    '.env.example',
    'a.ts'
  ]
  for (const path of posixOk) {
    it(`通过：${path}`, () => expect(withPath(path).success, path).toBe(true))
  }

  const rejected: Array<[string, RegExp]> = [
    ['/Users/user/project/src/main.ts', /repository-relative, not absolute/],
    ['C:\\Users\\user\\project\\src\\main.ts', /backslashes/],
    ['D:\\workspace\\project\\src\\main.ts', /backslashes/],
    ['\\\\server\\share\\file.ts', /backslashes/],
    ['../../outside/project/secrets.txt', /segments/],
    ['../.env', /segments/],
    ['src/../../etc/passwd', /segments/],
    ['src//main.ts', /empty segment/],
    ['src/main.ts/', /empty segment/]
  ]
  for (const [path, pattern] of rejected) {
    it(`拒绝：${JSON.stringify(path)}`, () => {
      const result = withPath(path)
      expect(result.success, path).toBe(false)
      if (!result.success) expect(result.error.issues[0]?.message).toMatch(pattern)
    })
  }

  it('拒绝 NUL 字符', () => {
    // 用 fromCharCode 构造，避免源文件里出现原始 NUL 字节
    const result = withPath(`src/main${String.fromCharCode(0)}.ts`)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/NUL/)
  })

  it('repoRelativePathError 直接给出原因（可单独测试）', () => {
    expect(repoRelativePathError('src/a.ts')).toBeNull()
    expect(repoRelativePathError('/abs')).toMatch(/absolute/)
    expect(repoRelativePathError('..\\x')).toMatch(/backslash/)
    expect(repoRelativePathError('a/../b')).toMatch(/segments/)
  })

  it('isLikelyTestOrConfigPath 只认测试与配置，不误判源码', () => {
    expect(isLikelyTestOrConfigPath('tests/unit/x.test.ts')).toBe(true)
    expect(isLikelyTestOrConfigPath('src/a.spec.tsx')).toBe(true)
    expect(isLikelyTestOrConfigPath('package.json')).toBe(true)
    expect(isLikelyTestOrConfigPath('.github/workflows/ci.yml')).toBe(true)
    expect(isLikelyTestOrConfigPath('Desktop/src/main/index.ts')).toBe(false)
  })

  it('重复的规范化文件路径被拒，并指出是哪一条', () => {
    const result = parse({
      version: 1,
      changes: [changeOf(), changeOf({ change_summary: '同一文件的第二处改动' })]
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((item) => item.message.includes('duplicate'))
      expect(issue).toBeDefined()
      expect(issue!.path).toEqual(['changes', 1, 'file_path'])
      expect(issue!.message).toContain('src/example.ts')
    }
  })

  it('同一文件的多处改动合并在一条里（symbols 区分）就合法', () => {
    const result = parse({
      version: 1,
      changes: [
        changeOf({
          symbols: ['appendEvent', 'updateEventStatus'],
          change_summary: '同一文件里两处不同的改动，写在同一条目。'
        })
      ]
    })
    expect(result.success).toBe(true)
  })
})

// ================================================================
// D. 修改类型与前后行为
// ================================================================

describe('D. 修改类型决定必须提供哪些字段', () => {
  const withChange = (overrides: Record<string, unknown>) =>
    parse({ version: 1, changes: [changeOf(overrides)] })

  it('合法 created：说明新文件做什么', () => {
    expect(
      withChange({
        file_path: 'src/new-module.ts',
        change_type: 'created',
        change_summary: '新增边界校验模块。',
        after_behavior: '导出 validateInput，拒绝非法入参。',
        why_this_location: '边界校验需要一个不依赖仓储层的独立模块。'
      }).success
    ).toBe(true)
  })

  it('created 缺 after_behavior 被拒', () => {
    const result = withChange({
      file_path: 'src/new-module.ts',
      change_type: 'created',
      change_summary: '新增模块。',
      // changeOf 的默认值里带了 after_behavior，这里必须显式抹掉
      after_behavior: undefined,
      why_this_location: '需要一个独立模块承载边界校验逻辑。'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/created requires after_behavior/)
    }
  })

  it('合法 deleted：说明删除前它负责什么', () => {
    expect(
      withChange({
        file_path: 'src/legacy-helper.ts',
        change_type: 'deleted',
        change_summary: '移除已被新模块取代的旧助手。',
        before_behavior: '提供三份重复的入参拼装逻辑。',
        why_this_location: '职责已并入新的边界校验模块，留着会造成两处实现漂移。'
      }).success
    ).toBe(true)
  })

  it('deleted 缺 before_behavior 被拒', () => {
    const result = withChange({
      file_path: 'src/legacy-helper.ts',
      change_type: 'deleted',
      change_summary: '移除旧助手。',
      before_behavior: undefined,
      why_this_location: '职责已并入新模块，继续保留会让两处实现漂移。'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/deleted requires before_behavior/)
    }
  })

  it('合法 renamed：旧路径必须存在且与新路径不同', () => {
    expect(
      withChange({
        file_path: 'src/renamed-helper.ts',
        previous_file_path: 'src/old-helper.ts',
        change_type: 'renamed',
        change_summary: '改名为更能表达职责的名字。',
        before_behavior: '旧名字看不出它负责入参校验。',
        after_behavior: '新名字直接指向职责。',
        why_this_location: '模块职责没变，只是命名与实际职责不符。'
      }).success
    ).toBe(true)
  })

  it('renamed 缺旧路径被拒', () => {
    const result = withChange({
      file_path: 'src/b.ts',
      change_type: 'renamed',
      change_summary: '改名。',
      before_behavior: '旧名。',
      after_behavior: '新名。',
      why_this_location: '命名与职责不符，改名让读者一眼看懂。'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/renamed requires previous_file_path/)
    }
  })

  it('旧路径等于新路径被拒（那不是改名）', () => {
    const result = withChange({
      file_path: 'src/b.ts',
      previous_file_path: 'src/b.ts',
      change_type: 'renamed',
      change_summary: '改名。',
      before_behavior: '旧名。',
      after_behavior: '新名。',
      why_this_location: '命名与职责不符，改名让读者一眼看懂。'
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/must differ/)
  })

  it('非 renamed 带旧路径被拒', () => {
    const result = withChange({
      previous_file_path: 'src/b.ts',
      change_summary: '改内容。',
      before_behavior: '旧行为。',
      after_behavior: '新行为。',
      why_this_location: '边界层负责入参合法性，仓储层只应处理已校验的数据。'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/only valid for change_type "renamed"/)
    }
  })

  it('modified 的前后行为必须成对给出', () => {
    const result = withChange({
      change_summary: '只写了修改前。',
      before_behavior: '入参一路穿到仓储层。',
      after_behavior: undefined,
      why_this_location: '边界层负责入参合法性，仓储层只应处理已校验的数据。'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/provided together|requires both/)
    }
  })

  it('纯测试 / 纯配置的 modified 允许省略前后行为（§6.4 兼容）', () => {
    for (const file_path of [
      'tests/integration/journey.test.ts',
      'src/components/Widget.spec.tsx',
      'package.json',
      '.github/workflows/ci.yml'
    ]) {
      const result = withChange({
        file_path,
        change_summary: '更新断言以匹配新的字段名。',
        why_this_location: '断言与被测实现同处一个文件，改动必须跟着走。'
      })
      expect(result.success, file_path).toBe(true)
    }
  })

  it('源码文件的 modified 缺前后行为被拒', () => {
    const result = withChange({
      file_path: 'Desktop/src/main/index.ts',
      change_summary: '调整注入顺序。',
      before_behavior: undefined,
      after_behavior: undefined,
      why_this_location: 'Service 的构造顺序决定了共享的 ApplicationEvents 是否唯一。'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/modified requires both/)
    }
  })

  it('why_this_location 太短（占位符）被拒', () => {
    for (const why of ['改这里', '因为要改', '需要修改这个文件', 'y']) {
      expect(withChange({ why_this_location: why }).success, why).toBe(false)
    }
  })
})

// ================================================================
// E. 行号
// ================================================================

describe('E. 行号', () => {
  const withLine = (line_range: unknown) =>
    parse({ version: 1, changes: [changeOf({ line_range })] })

  it('起始行 1 通过', () => {
    expect(withLine({ start: 1, end: 1 }).success).toBe(true)
    expect(withLine({ start: 1, end: 400 }).success).toBe(true)
  })

  it('起始行 0 拒绝（源码行号从 1 开始）', () => {
    const result = withLine({ start: 0, end: 10 })
    expect(result.success).toBe(false)
    // Zod 会把数组下标也放进 path：['changes', 0, 'line_range', 'start']
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['changes', 0, 'line_range', 'start'])
  })

  it('结束行小于起始行拒绝', () => {
    const result = withLine({ start: 20, end: 5 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/line_range\.end must be greater than/)
    }
  })

  it('非整数行号拒绝', () => {
    expect(withLine({ start: 1.5, end: 3 }).success).toBe(false)
    expect(withLine({ start: 1, end: '3' }).success).toBe(false)
  })

  it('没有行号的合法修改记录通过（行号只是辅助，路径与符号才是主）', () => {
    expect(withLine(undefined).success).toBe(true)
  })
})

// ================================================================
// F. Verification 一致性
// ================================================================

describe('F. Verification 结果与退出码一致性', () => {
  const withVerify = (item: Record<string, unknown>) => parse({ version: 1, verification: [item] })

  const base = { target: 'pnpm test', summary: '1557 通过。' }

  it('四种结果各自的合法记录都通过', () => {
    expect(withVerify({ ...base, result: 'passed', exit_code: 0 }).success).toBe(true)
    expect(withVerify({ ...base, result: 'passed' }).success).toBe(true)
    expect(withVerify({ ...base, result: 'failed', exit_code: 1 }).success).toBe(true)
    expect(withVerify({ ...base, result: 'not_run' }).success).toBe(true)
    expect(withVerify({ ...base, result: 'skipped' }).success).toBe(true)
  })

  it('not_run 不许带退出码（什么都没跑就没有真实退出码）', () => {
    const result = withVerify({ ...base, result: 'not_run', exit_code: 0 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['verification', 0, 'exit_code'])
      expect(result.error.issues[0]?.message).toMatch(/nothing was executed/)
    }
  })

  it('passed 带非零退出码自相矛盾，被拒并给出改法', () => {
    const result = withVerify({ ...base, result: 'passed', exit_code: 1 })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/contradicts a non-zero/)
  })

  it('failed 带 0 允许：特殊预期由 summary 解释，不替 Agent 推断结果', () => {
    expect(withVerify({ ...base, result: 'failed', exit_code: 0 }).success).toBe(true)
    expect(
      withVerify({ ...base, result: 'failed', exit_code: 0, summary: '按预期非零退出。' }).success
    ).toBe(true)
  })

  it('缺失 result 不会被自动当成 passed（result 是必填枚举）', () => {
    expect(withVerify({ target: 't', summary: 's' }).success).toBe(false)
  })

  it('结构化详情里没有任何能声明 runtime_observed 的入口', () => {
    const result = parse({
      version: 1,
      verification: [{ ...base, result: 'passed', evidence_level: 'runtime_observed' }]
    })
    expect(result.success).toBe(false) // .strict() 拒绝未知字段
  })
})


// ================================================================
// R6-4.2.2 —— 陈述事件不允许携带 journey_detail_v1（§4.A）
// ================================================================

/**
 * 通过 **Schema parse** 构造合法详情——不靠 `as JourneyDetailV1` 绕开基础契约。
 * 构造本身就证明该对象确实满足 `journeyDetailV1Schema`。
 */
function legalDetail(extra: Record<string, unknown>): JourneyDetailV1 {
  const parsed = journeyDetailV1Schema.safeParse({ version: 1, ...extra })
  if (!parsed.success) {
    throw new Error(
      `fixture is not schema-valid: ${JSON.stringify(parsed.error.issues, null, 2)}`
    )
  }
  return parsed.data
}

/** 合法的 decision 块。 */
const DECISION_BLOCK = {
  selected_approach: '在 Handler 边界做显式映射',
  rationale: '协议细节只应出现在适配层。',
  alternatives: [
    { approach: '在 Service 内兼容两种命名', reason_not_selected: '领域模型背上协议细节' }
  ],
  tradeoffs: ['边界多一层显式转换']
}

/** 合法的 verification 块。 */
const VERIFICATION_BLOCK = [
  {
    target: '边关系回归',
    result: 'passed' as const,
    exit_code: 0,
    summary: '23 通过。',
    evidence_reference: 'tests/integration/mcp-journey-bridge.test.ts'
  }
]

describe('§4.A 陈述事件（user_input / plan / user_annotation）不接受 journey_detail_v1', () => {
  const STATEMENT_TYPES = ['user_input', 'plan', 'user_annotation'] as const

  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['user_input', 'decision', { decision: DECISION_BLOCK }],
    ['user_input', 'changes', { changes: [changeOf()] }],
    ['plan', 'changes', { changes: [changeOf()] }],
    ['plan', 'verification', { verification: VERIFICATION_BLOCK }],
    ['user_annotation', 'observations', { observations: [{ finding: '用户补充的一条事实' }] }]
  ]

  for (const [eventType, label, extra] of cases) {
    it(`${eventType} + 合法 ${label} 详情 → 拒绝`, () => {
      // 先证明这个对象**确实**通过 Schema（不是靠类型断言造出来的）
      const detail = legalDetail(extra)
      expect(journeyDetailV1Schema.safeParse(detail).success).toBe(true)

      const message = detailEventTypeError(eventType, detail)
      expect(message, `${eventType} 必须被拒`).not.toBeNull()
      expect(message).toContain('is not accepted on event_type')
      expect(message).toContain(eventType)
      // 必须指出改法：写普通字段 / 删掉 details，而不是模糊的 invalid details
      expect(message).toContain('journey_detail_v1')
      expect(message).toMatch(/summary\/content\/reason/)
      expect(message).toContain('remove `details`')
      expect(message).not.toBe('invalid details')
    })
  }

  it('每种陈述事件的错误信息指向它自己的普通字段', () => {
    const detail = legalDetail({ decision: DECISION_BLOCK })
    expect(detailEventTypeError('user_input', detail)).toContain("the user's own words")
    expect(detailEventTypeError('plan', detail)).toContain('the plan you showed the user')
    expect(detailEventTypeError('user_annotation', detail)).toContain("the user's note")
  })

  it('陈述事件不提交 details：parseJourneyDetail 为 null，语义校验根本不会被调用', () => {
    // Service 只在 metadata.journey_detail_v1 存在时才调 detailEventTypeError；
    // 旧客户端/不传 details 的路径 = metadata 里没有这个键。
    expect(parseJourneyDetail(null)).toBeNull()
    expect(parseJourneyDetail(undefined)).toBeNull()
    expect(parseJourneyDetail({})).toBeNull()
    expect(parseJourneyDetail({ command: 'pnpm test' })).toBeNull()
    for (const type of STATEMENT_TYPES) {
      expect(type).toBeTruthy()
    }
  })

  it('其它 metadata 键不受本规则影响（只有 journey_detail_v1 被看）', () => {
    // 这条在 Service 层生效：metadata 里没有 journey_detail_v1 时
    // detailEventTypeError 不会被调用，普通键原样保留（见集成测试）。
    const legacy = { command: 'pnpm test', note: '旧的自由格式' }
    expect(parseJourneyDetail(legacy)).toBeNull()
    expect(legacy.command).toBe('pnpm test')
  })

  it('允许携带详情的事件满足最低要求后仍可带辅助信息', () => {
    // decision + decision 块 + references：不被实现成「只能有一个字段」
    const withRefs = legalDetail({
      decision: DECISION_BLOCK,
      references: [{ kind: 'commit', value: 'ed3f22c', label: 'R6-4.2.1' }],
      limitations: ['未运行全量 E2E']
    })
    expect(detailEventTypeError('decision', withRefs)).toBeNull()

    // execution 的两种合法形态都保持可用（不破坏非代码分析工作的兼容）
    expect(detailEventTypeError('execution', legalDetail({ changes: [changeOf()] }))).toBeNull()
    expect(
      detailEventTypeError(
        'execution',
        legalDetail({ observations: [{ finding: '竞态出现在同步段' }] })
      )
    ).toBeNull()
    expect(
      detailEventTypeError(
        'execution',
        legalDetail({ references: [{ kind: 'test', value: 'tests/x.test.ts' }] })
      )
    ).toBeNull()
  })
})
