import { describe, expect, it } from 'vitest'
import {
  JOURNEY_DETAIL_KEY,
  journeyDetailV1Schema,
  parseJourneyDetail,
  parseJourneyMetadataJson,
  type JourneyDetailV1
} from '../../src/shared/contracts/entities/agent-journey'
import { JOURNEY_METADATA_MAX } from '../../src/main/application/agent-journey/sanitize'

/**
 * 结构化执行详情（R6-4.2 §4）的契约测试。
 *
 * 这里守住四件事：
 * 1. **`.strict()` 真的严格**——多一个字段就拒绝，AI 不能靠自由组合 JSON
 *    绕开校验（这是 §6 的原话）；
 * 2. **字段与数组上限生效**——单个字段吃不掉整个 metadata 预算；
 * 3. **`not_run` 与 `passed` 平级**——未执行的测试永远不能写成通过（§7）；
 * 4. **旧数据兼容**——没有 `journey_detail_v1`、结构脏了、版本不认识，
 *    一律返回 null 而不是抛错，UI 据此显示原始摘要而不是伪造详情（场景 E）。
 */

/** 一份「够详细」的三文件修改记录：用来验预算够不够装（场景 A）。 */
const THREE_FILE_DETAIL: JourneyDetailV1 = {
  version: 1,
  decision: {
    selected_approach: '在 Handler 边界做 snake_case → camelCase 映射',
    rationale: '边界转换可测、可枚举；散落到 Service 会让领域模型背上协议细节。',
    alternatives: [
      { approach: '在 Service 内部兼容两种命名', reason_not_selected: '领域模型被迫知道外部协议' },
      { approach: '只补类型断言', reason_not_selected: '断言骗过编译器，运行时字段仍是 undefined' },
      { approach: '改 MCP 对外用 camelCase', reason_not_selected: '破坏既有客户端契约' }
    ],
    tradeoffs: ['边界多一层显式转换', '需要补一条边关系回归']
  },
  changes: [
    {
      file_path: 'Desktop/src/main/application/mcp-tools/handlers.ts',
      change_type: 'modified',
      symbols: ['append_agent_journey_event', 'mergeJourneyDetail'],
      change_summary: '把外部 to_event_id 显式转换为内部 toEventId，逐字段 map 而不是断言。',
      before_behavior: '断言只改类型不改字段名，Service 读到 undefined，整条 append 回滚。',
      after_behavior: 'Handler 在应用边界执行明确转换，边关系正常写入。',
      why_this_location: 'Handler 是外部协议与内部 Application Service 的适配边界，协议细节只应出现在这里。',
      line_range: { start: 369, end: 410 }
    },
    {
      file_path: 'Desktop/tests/integration/mcp-journey-bridge.test.ts',
      change_type: 'modified',
      symbols: ['F2. edges 的 snake_case → camelCase 映射'],
      change_summary: '新增三条边关系回归：snake_case 提交落库、未传 edges 返回空、非法目标整体回滚。',
      before_behavior: '没有任何测试覆盖 edges 的字段名映射。',
      after_behavior: '映射写错时套件立刻变红。',
      why_this_location: '该文件已经有真实 Bridge 到 SQLite 的链路，回归放在这里才测得到端到端。'
    },
    {
      file_path: 'Desktop/src/main/database/repositories/agent-journeys.ts',
      change_type: 'modified',
      symbols: ['insertEdge'],
      change_summary: '保持既有写入语义不变，仅被上层调用方式改变。',
      why_this_location: '边的持久化唯一入口，改动必须留在这一层而不是散落在 Handler。'
    }
  ],
  observations: [
    {
      finding: '日志里 edge.toEventId 是 undefined',
      impact: '整条 append 回滚，一条边都没写进去。',
      source: '回归套件的断言输出'
    }
  ],
  verification: [
    {
      command: 'npx vitest run tests/integration/mcp-journey-bridge.test.ts',
      target: '边关系回归 3 例',
      result: 'passed',
      exit_code: 0,
      summary: '23 通过。',
      evidence_reference: 'tests/integration/mcp-journey-bridge.test.ts'
    },
    {
      command: 'npx vitest run tests/integration/mcp-protocol.integration.test.ts',
      target: '真实 STDIO A→F 闭环',
      result: 'passed',
      exit_code: 0,
      summary: '7 通过。'
    },
    {
      target: 'Playwright 全量 E2E',
      result: 'not_run',
      summary: '本阶段未运行，不能声称通过。'
    }
  ],
  references: [
    { kind: 'commit', value: 'e8390e35f793769a1776d5f0e9907fdef3f13839', label: 'R6-2.1' },
    { kind: 'test', value: 'tests/unit/mcp-journey-tools.test.ts', label: '工具契约 13 例' }
  ],
  limitations: ['未运行 Playwright 全量 E2E', '行号仅作辅助，以符号名为准']
}

describe('journey_detail_v1：结构与严格性', () => {
  it('一份完整的三文件修改记录能通过校验', () => {
    const parsed = journeyDetailV1Schema.safeParse(THREE_FILE_DETAIL)
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true
    )
  })

  it('整包能装进 metadata 预算（场景 A 的前提）', () => {
    const json = JSON.stringify({ [JOURNEY_DETAIL_KEY]: THREE_FILE_DETAIL })
    expect(json.length).toBeLessThan(JOURNEY_METADATA_MAX)
    // 留给旧 metadata 其它键的余量也要够：至少还有一半预算
    expect(json.length).toBeLessThan(JOURNEY_METADATA_MAX / 2)
  })

  it('多余字段被拒：AI 不能靠自由组合 JSON 绕开 Schema', () => {
    const withExtra = { ...THREE_FILE_DETAIL, sneaky_field: 'bypass' }
    expect(journeyDetailV1Schema.safeParse(withExtra).success).toBe(false)

    const changeExtra = {
      ...THREE_FILE_DETAIL,
      changes: [{ ...THREE_FILE_DETAIL.changes![0], arbitrary_json: { a: 1 } }]
    }
    expect(journeyDetailV1Schema.safeParse(changeExtra).success).toBe(false)
  })

  it('version 必须是字面量 1（未来 v2 走新命名空间，不复用这个键）', () => {
    expect(journeyDetailV1Schema.safeParse({ ...THREE_FILE_DETAIL, version: 2 }).success).toBe(false)
    expect(journeyDetailV1Schema.safeParse({ ...THREE_FILE_DETAIL, version: '1' }).success).toBe(false)
  })

  it('未知 change_type / result 被拒', () => {
    const badType = {
      ...THREE_FILE_DETAIL,
      changes: [{ ...THREE_FILE_DETAIL.changes![0], change_type: 'rewrote' }]
    }
    expect(journeyDetailV1Schema.safeParse(badType).success).toBe(false)

    const badResult = {
      ...THREE_FILE_DETAIL,
      verification: [{ target: 't', result: 'probably_passed', summary: 's' }]
    }
    expect(journeyDetailV1Schema.safeParse(badResult).success).toBe(false)
  })

  it('未执行的测试可以写 not_run / skipped（与 passed 平级，不是失败）', () => {
    for (const result of ['not_run', 'skipped'] as const) {
      const detail = {
        version: 1 as const,
        verification: [{ target: '全量 E2E', result, summary: '本阶段未运行。' }]
      }
      expect(journeyDetailV1Schema.safeParse(detail).success, result).toBe(true)
    }
  })

  it('字段长度上限生效：单个字段吃不掉整个预算', () => {
    const tooLong = {
      ...THREE_FILE_DETAIL,
      changes: [{ ...THREE_FILE_DETAIL.changes![0], change_summary: 'x'.repeat(601) }]
    }
    expect(journeyDetailV1Schema.safeParse(tooLong).success).toBe(false)

    const tooManyFiles = {
      ...THREE_FILE_DETAIL,
      changes: Array.from({ length: 13 }, (_, i) => ({
        ...THREE_FILE_DETAIL.changes![0],
        file_path: `src/file-${i}.ts`
      }))
    }
    expect(journeyDetailV1Schema.safeParse(tooManyFiles).success).toBe(false)
  })

  it('空的必需字段被拒（不许用空串占位冒充已说明）', () => {
    const emptyWhy = {
      ...THREE_FILE_DETAIL,
      changes: [{ ...THREE_FILE_DETAIL.changes![0], why_this_location: '' }]
    }
    expect(journeyDetailV1Schema.safeParse(emptyWhy).success).toBe(false)
  })
})

describe('parseJourneyDetail：旧数据与脏数据都不炸', () => {
  it('没有 journey_detail_v1 → null（UI 据此显示原始摘要，不伪造详情）', () => {
    expect(parseJourneyDetail({ command: 'psql' })).toBeNull()
    expect(parseJourneyDetail(null)).toBeNull()
    expect(parseJourneyDetail(undefined)).toBeNull()
    expect(parseJourneyDetail('not an object')).toBeNull()
  })

  it('结构非法 / 版本不认识 → null，不抛错', () => {
    expect(parseJourneyDetail({ [JOURNEY_DETAIL_KEY]: { version: 1, changes: 'nope' } })).toBeNull()
    expect(parseJourneyDetail({ [JOURNEY_DETAIL_KEY]: { version: 99 } })).toBeNull()
    expect(parseJourneyDetail({ [JOURNEY_DETAIL_KEY]: null })).toBeNull()
  })

  it('合法详情能原样读回（往返一致）', () => {
    const metadata = { [JOURNEY_DETAIL_KEY]: THREE_FILE_DETAIL, legacy_key: 'kept' }
    const detail = parseJourneyDetail(metadata)
    expect(detail).not.toBeNull()
    expect(detail!.changes).toHaveLength(3)
    expect(detail!.changes![0].file_path).toBe(
      'Desktop/src/main/application/mcp-tools/handlers.ts'
    )
    expect(detail!.verification!.map((item) => item.result)).toEqual([
      'passed',
      'passed',
      'not_run'
    ])
    // 旧 metadata 键不被吞掉
    expect(metadata.legacy_key).toBe('kept')
  })
})

describe('parseJourneyMetadataJson：库里的 JSON 串', () => {
  it('普通对象能解析', () => {
    expect(parseJourneyMetadataJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('坏 JSON / 空串 / null → null（读路径不被脏数据打断）', () => {
    expect(parseJourneyMetadataJson('{not json')).toBeNull()
    expect(parseJourneyMetadataJson('')).toBeNull()
    expect(parseJourneyMetadataJson(null)).toBeNull()
    expect(parseJourneyMetadataJson(undefined)).toBeNull()
  })

  it('数组与标量不透传（Renderer 只应拿到对象）', () => {
    expect(parseJourneyMetadataJson('[1,2,3]')).toBeNull()
    expect(parseJourneyMetadataJson('"str"')).toBeNull()
    expect(parseJourneyMetadataJson('42')).toBeNull()
    expect(parseJourneyMetadataJson('null')).toBeNull()
  })
})
