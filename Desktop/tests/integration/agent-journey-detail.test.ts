import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { digestParams } from '../../src/main/database/repositories/mcp-idempotency'
import {
  AgentJourneyError,
  AgentJourneyService,
  type AgentJourneyCallContext
} from '../../src/main/application/agent-journey/agent-journey-service'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import {
  JOURNEY_DETAIL_KEY,
  parseJourneyDetail,
  type JourneyDetailV1
} from '../../src/shared/contracts/entities/agent-journey'
import { JOURNEY_METADATA_MAX } from '../../src/main/application/agent-journey/sanitize'

/**
 * 结构化执行详情的**真实 SQLite** 数据链测试（R6-4.2 §12）。
 *
 * 链路：MCP 入参 → Zod → Handler 合并 → Service 校验/脱敏/预算 →
 * Repository → SQLite → `getDetailForRenderer()` → Renderer 契约。
 *
 * **不 mock**：Schema 拒绝、递归脱敏、长度预算、幂等重放、旧数据兼容
 * 都只有在真库上才测得出来。
 */

const CLIENT = 'client-aaaaaaaa-0000-4000-8000-000000000001'

let handle: DatabaseHandle
let dir: string
let service: AgentJourneyService

function ctx(
  toolName: string,
  params: Record<string, unknown>,
  key?: string
): AgentJourneyCallContext {
  return {
    actor: { kind: 'mcp_client', clientId: CLIENT },
    idempotency: {
      key: key ?? `evt:${randomUUID()}`,
      toolName,
      requestDigest: digestParams(params)
    }
  }
}

function newJourney(title = '结构化详情验收'): string {
  const result = service.createJourney(ctx('start_agent_journey', { title }), { title })
  return result.journey.id
}

function append(journeyId: string, input: Record<string, unknown>, key?: string) {
  const params = { journeyId, ...input }
  return service.appendEvent(ctx('append_agent_journey_event', params, key), {
    journeyId,
    ...input
  } as Parameters<AgentJourneyService['appendEvent']>[1])
}

/** 场景 A 的核心：一个文件一条 `changes`，路径/符号/前后行为/为什么改在这里。 */
const THREE_FILE_CHANGES: JourneyDetailV1 = {
  version: 1,
  changes: [
    {
      file_path: 'Desktop/src/main/application/mcp-tools/handlers.ts',
      change_type: 'modified',
      symbols: ['append_agent_journey_event'],
      change_summary: '把外部 to_event_id 显式转换为内部 toEventId。',
      before_behavior: '断言只改类型不改字段名，Service 读到 undefined，整条 append 回滚。',
      after_behavior: 'Handler 在应用边界执行明确转换，边关系正常写入。',
      why_this_location: 'Handler 是外部协议与内部 Application Service 的适配边界。',
      line_range: { start: 369, end: 410 }
    },
    {
      file_path: 'Desktop/tests/integration/mcp-journey-bridge.test.ts',
      change_type: 'modified',
      symbols: ['F2. edges 的 snake_case → camelCase 映射'],
      change_summary: '新增三条边关系回归。',
      before_behavior: '没有任何测试覆盖 edges 的字段名映射。',
      after_behavior: '映射写错时套件立刻变红。',
      why_this_location: '该文件已有真实 Bridge 到 SQLite 的链路，回归放这里才测得到端到端。'
    },
    {
      file_path: 'Desktop/src/main/database/repositories/agent-journeys.ts',
      change_type: 'modified',
      symbols: ['insertEdge'],
      change_summary: '保持既有写入语义不变，仅被上层调用方式改变。',
      why_this_location: '边的持久化唯一入口，改动必须留在这一层。'
    }
  ]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'r642-'))
  handle = openDatabase(join(dir, 'app.db'))
  service = new AgentJourneyService(handle.db, new ApplicationEvents())
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

// MARK: - 场景 A：多文件修改记录

describe('场景 A：详细代码修改记录', () => {
  it('每个文件的路径、符号、前后行为、修改位置理由都能读回来', () => {
    const journeyId = newJourney()
    append(journeyId, {
      eventType: 'execution',
      title: '补齐 edges 的字段映射',
      summary: '在 Handler 边界逐字段转换。',
      metadata: { [JOURNEY_DETAIL_KEY]: THREE_FILE_CHANGES }
    })

    const detail = service.getDetailForRenderer(journeyId)
    const event = detail.events[0]
    const parsed = parseJourneyDetail(event.metadata)
    expect(parsed, '结构化详情必须能从 Renderer 读路径取到').not.toBeNull()
    expect(parsed!.changes).toHaveLength(3)

    for (const change of parsed!.changes!) {
      expect(change.file_path).toMatch(/^Desktop\/.+$/) // 仓库相对路径，不是绝对路径
      expect(change.why_this_location.length).toBeGreaterThan(0)
      expect(change.change_summary.length).toBeGreaterThan(0)
      expect(change.change_type).toMatch(/^(created|modified|deleted|renamed)$/)
    }
    expect(parsed!.changes![0].symbols).toEqual(['append_agent_journey_event'])
    expect(parsed!.changes![0].line_range).toEqual({ start: 369, end: 410 })
    expect(parsed!.changes![0].before_behavior).toContain('undefined')
    expect(parsed!.changes![0].after_behavior).toContain('应用边界')
    expect(parsed!.changes![1].why_this_location).toContain('真实 Bridge')
  })

  it('evidence_level 与 metadata 一并进入 Renderer 读路径（R6-4.2 §3 断链修复）', () => {
    const journeyId = newJourney()
    append(journeyId, {
      eventType: 'execution',
      title: '带详情的执行',
      metadata: { [JOURNEY_DETAIL_KEY]: THREE_FILE_CHANGES, legacy_note: 'kept' }
    })

    const event = service.getDetailForRenderer(journeyId).events[0]
    expect(event).toHaveProperty('evidence_level', 'agent_reported')
    expect(event.metadata).not.toBeNull()
    // 旧 metadata 键不被吞掉
    expect(event.metadata!.legacy_note).toBe('kept')
  })
})

// MARK: - 场景 B：决策复盘

describe('场景 B：决策复盘', () => {
  it('选择原因、未选方案、代价与限制完整保留', () => {
    const journeyId = newJourney()
    append(journeyId, {
      eventType: 'decision',
      title: '映射放在 Handler 边界',
      reason: '边界转换可测、可枚举。',
      metadata: {
        [JOURNEY_DETAIL_KEY]: {
          version: 1,
          decision: {
            selected_approach: '在 Handler 边界做显式转换',
            rationale: '协议细节只应出现在适配层。',
            alternatives: [
              { approach: '在 Service 内兼容两种命名', reason_not_selected: '领域模型背上协议细节' },
              { approach: '只补类型断言', reason_not_selected: '断言骗过编译器，运行时仍是 undefined' }
            ],
            tradeoffs: ['边界多一层显式转换', '需要补回归']
          }
        }
      }
    })

    const detail = parseJourneyDetail(
      service.getDetailForRenderer(journeyId).events[0].metadata
    )
    expect(detail!.decision!.selected_approach).toContain('Handler')
    expect(detail!.decision!.rationale).toContain('适配层')
    expect(detail!.decision!.alternatives).toHaveLength(2)
    expect(detail!.decision!.alternatives![0].reason_not_selected).toContain('领域模型')
    expect(detail!.decision!.tradeoffs).toHaveLength(2)
    // 人类可读的 reason 字段仍在，两者并存不冲突
    expect(service.getDetailForRenderer(journeyId).events[0].reason).toBe('边界转换可测、可枚举。')
  })
})

// MARK: - 场景 C：失败与修正

describe('场景 C：失败与修正', () => {
  it('失败执行 → Revision → 再执行，历史一条不覆盖', () => {
    const journeyId = newJourney()
    // Service 规则：execution 只能以 planned/running 创建（「宣布做完了」与
    // 「做完了」必须是两次独立写入），失败要用 updateEventStatus 推进。
    const firstAttempt = append(journeyId, {
      eventType: 'execution',
      title: '第一次改映射',
      summary: '只改了断言，回归仍红。',
      metadata: {
        [JOURNEY_DETAIL_KEY]: {
          version: 1,
          changes: [
            {
              file_path: 'Desktop/src/main/application/mcp-tools/handlers.ts',
              change_type: 'modified',
              change_summary: '只补了类型断言。',
              why_this_location: '误以为类型对了字段就对了。'
            }
          ]
        }
      }
    })
    // 状态机：planned → running → failed（planned 不能直接 failed）
    service.updateEventStatus({
      eventId: firstAttempt.event.id,
      status: 'running',
      expectedUpdatedAt: firstAttempt.event.updatedAt
    })
    const running = service.getDetailForRenderer(journeyId).events[0]
    service.updateEventStatus({
      eventId: firstAttempt.event.id,
      status: 'failed',
      expectedUpdatedAt: running.updated_at
    })
    const failed = firstAttempt

    const revision = append(journeyId, {
      eventType: 'revision',
      title: '改成显式 map',
      reason: '断言不产生运行时转换。',
      parentEventId: failed.event.id,
      edges: [{ toEventId: failed.event.id, relationshipType: 'revises' }]
    })
    const secondAttempt = append(journeyId, {
      eventType: 'execution',
      title: '第二次：逐字段转换',
      metadata: { [JOURNEY_DETAIL_KEY]: THREE_FILE_CHANGES }
    })
    service.updateEventStatus({
      eventId: secondAttempt.event.id,
      status: 'running',
      expectedUpdatedAt: secondAttempt.event.updatedAt
    })
    const running2 = service.getDetailForRenderer(journeyId).events[2]
    service.updateEventStatus({
      eventId: secondAttempt.event.id,
      status: 'completed',
      expectedUpdatedAt: running2.updated_at
    })

    const detail = service.getDetailForRenderer(journeyId)
    expect(detail.events.map((event) => event.status)).toEqual(['failed', 'completed', 'completed'])
    expect(detail.events[0].title).toBe('第一次改映射')
    // 失败事件的详情**没有**被后续执行覆盖
    const failedDetail = parseJourneyDetail(detail.events[0].metadata)
    expect(failedDetail!.changes![0].change_summary).toContain('类型断言')
    expect(detail.events[1].event_type).toBe('revision')
    expect(detail.edges).toHaveLength(1)
    expect(detail.edges[0].relationship_type).toBe('revises')
    // 第三次执行有自己的详情
    expect(parseJourneyDetail(detail.events[2].metadata)!.changes).toHaveLength(3)
  })
})

// MARK: - 场景 D：真实验证记录 + 证据真实性

describe('场景 D：验证结果与证据等级', () => {
  it('passed / failed / not_run 三种结果各自保留，未执行不显示为通过', () => {
    const journeyId = newJourney()
    append(journeyId, {
      eventType: 'verification',
      title: '跑回归',
      metadata: {
        [JOURNEY_DETAIL_KEY]: {
          version: 1,
          verification: [
            {
              command: 'npx vitest run tests/integration/mcp-journey-bridge.test.ts',
              target: '边关系回归 3 例',
              result: 'passed',
              exit_code: 0,
              summary: '23 通过。'
            },
            {
              command: 'npx vitest run tests/unit/mcp-journey-tools.test.ts',
              target: '工具契约',
              result: 'failed',
              exit_code: 1,
              summary: '12 通过，1 失败。'
            },
            { target: 'Playwright 全量 E2E', result: 'not_run', summary: '本阶段未运行。' },
            { target: 'Windows 打包验证', result: 'skipped', summary: '不在本机范围。' }
          ]
        }
      }
    })

    const verification = parseJourneyDetail(
      service.getDetailForRenderer(journeyId).events[0].metadata
    )!.verification!
    expect(verification.map((item) => item.result)).toEqual([
      'passed',
      'failed',
      'not_run',
      'skipped'
    ])
    expect(verification[0].exit_code).toBe(0)
    expect(verification[2].command).toBeUndefined()
    // 关键：not_run 不能被读成通过
    expect(verification.some((item) => item.result === 'passed')).toBe(true)
    expect(verification.filter((item) => item.result === 'passed')).toHaveLength(1)
  })

  it('客户端自称 tool_result / runtime_observed 一律被拒（证据等级不可自封）', () => {
    const journeyId = newJourney()
    for (const level of ['tool_result', 'runtime_observed']) {
      expect(() =>
        append(journeyId, {
          eventType: 'verification',
          title: '想冒充系统观察',
          evidenceLevel: level
        })
      ).toThrow(/only agent_reported/)
    }
    // 两笔都没写进去
    expect(service.getDetailForRenderer(journeyId).events).toHaveLength(0)

    // 正常写入后也恒为 agent_reported
    append(journeyId, { eventType: 'verification', title: '正常提交' })
    expect(service.getDetailForRenderer(journeyId).events[0].evidence_level).toBe('agent_reported')
  })
})

// MARK: - 场景 E：向后兼容

describe('场景 E：旧 Journey 兼容', () => {
  it('没有 journey_detail_v1 的旧事件正常读出，不报错、不伪造详情', () => {
    const journeyId = newJourney()
    // 旧数据：只有 content / reason，metadata 为 null
    append(journeyId, {
      eventType: 'execution',
      title: '旧事件',
      content: '当时只写了正文。',
      reason: '当时只写了理由。'
    })

    const event = service.getDetailForRenderer(journeyId).events[0]
    expect(event.content).toBe('当时只写了正文。')
    expect(event.reason).toBe('当时只写了理由。')
    expect(event.metadata).toBeNull()
    expect(parseJourneyDetail(event.metadata)).toBeNull()
    expect(event.evidence_level).toBe('agent_reported')
  })

  it('旧 metadata（自由键值）原样保留，且不被当成结构化详情', () => {
    const journeyId = newJourney()
    append(journeyId, {
      eventType: 'observation',
      title: '旧 metadata 事件',
      metadata: { command: 'pnpm test', note: '旧的自由格式' }
    })

    const event = service.getDetailForRenderer(journeyId).events[0]
    expect(event.metadata).toEqual({ command: 'pnpm test', note: '旧的自由格式' })
    expect(parseJourneyDetail(event.metadata)).toBeNull()
  })
})

// MARK: - 场景 G：脱敏与限制

describe('场景 G：脱敏、预算与非法 Schema', () => {
  it('嵌套 token 被递归脱敏，敏感子树整块替换', () => {
    const journeyId = newJourney()
    append(journeyId, {
      eventType: 'execution',
      title: '带凭据的详情',
      metadata: {
        [JOURNEY_DETAIL_KEY]: THREE_FILE_CHANGES,
        nested: { api_key: 'sk-live-abcdef123456', deep: { BREWPHASE_MCP_TOKEN: 'bp_mcp_secret9999' } }
      }
    })

    const json = JSON.stringify(service.getDetailForRenderer(journeyId).events[0].metadata)
    expect(json).not.toContain('sk-live-abcdef123456')
    expect(json).not.toContain('bp_mcp_secret9999')
    expect(json).toContain('[redacted]')
    // 结构化详情本身仍然完好
    expect(parseJourneyDetail(service.getDetailForRenderer(journeyId).events[0].metadata)).not.toBeNull()
  })

  it('超出预算的 metadata 被拒绝，且不留半截坏 JSON', () => {
    const journeyId = newJourney()
    const huge = 'x'.repeat(JOURNEY_METADATA_MAX + 100)
    expect(() =>
      append(journeyId, { eventType: 'execution', title: '超大', metadata: { blob: huge } })
    ).toThrow(new RegExp(String(JOURNEY_METADATA_MAX)))

    expect(service.getDetailForRenderer(journeyId).events).toHaveLength(0)
    expect(handle.db.all('select * from agent_journey_events')).toHaveLength(0)
  })

  it('结构化详情违反 Schema 时被 Service 拒绝（MCP 之外的写入口也拦得住）', () => {
    const journeyId = newJourney()
    expect(() =>
      append(journeyId, {
        eventType: 'execution',
        title: '非法结构',
        metadata: {
          [JOURNEY_DETAIL_KEY]: {
            version: 1,
            changes: [
              {
                file_path: 'a.ts',
                change_type: 'rewrote', // 不在枚举里
                change_summary: 'x',
                why_this_location: 'y'
              }
            ]
          }
        }
      })
    ).toThrow(/journey_detail_v1/)

    expect(() =>
      append(journeyId, {
        eventType: 'execution',
        title: '多余字段',
        metadata: { [JOURNEY_DETAIL_KEY]: { version: 1, made_up: true } }
      })
    ).toThrow(/journey_detail_v1/)

    expect(service.getDetailForRenderer(journeyId).events).toHaveLength(0)
  })

  it('错误信息带 Zod 路径，能定位到具体字段', () => {
    const journeyId = newJourney()
    try {
      append(journeyId, {
        eventType: 'execution',
        title: '定位错误',
        metadata: {
          [JOURNEY_DETAIL_KEY]: {
            version: 1,
            changes: [
              {
                file_path: 'a.ts',
                change_type: 'modified',
                change_summary: 'x',
                why_this_location: 'y',
                line_range: { start: -1, end: 5 }
              }
            ]
          }
        }
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentJourneyError)
      const message = (error as AgentJourneyError).message
      expect(message).toContain('journey_detail_v1')
      expect(message).toContain('line_range')
    }
  })
})
