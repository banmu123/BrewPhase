import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { stageGoals } from '../../src/main/database/schema'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import {
  PersonalDirectionService,
  PersonalDirectionError
} from '../../src/main/application/personal-direction/personal-direction-service'

/**
 * Personal Direction 的服务层测试：独立临时库，不碰真实数据。
 *
 * 重点不在 CRUD，而在两条**结构性约束**：
 * 1. 现状是版本化的——确认新版会把旧版归档，历史不会消失；
 * 2. Agent 写的东西永远是草稿，且没有任何方法能把它变成正式资料
 *    （确认方法存在，但只挂在 IPC 上；这里验证它拒绝非草稿输入）。
 */

let handle: DatabaseHandle
let service: PersonalDirectionService
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-direction-'))
  handle = openDatabase(join(dir, 'test.db'))
  service = new PersonalDirectionService(handle.db, new ApplicationEvents())
})

afterEach(() => {
  // 先关连接再删目录：Windows 上未释放的 SQLite 句柄会让 unlink 直接 EBUSY。
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

const STATE_DRAFT = {
  summary: '有一份稳定的工作，业余时间想做自己的产品。',
  workStatus: '在职',
  capabilities: '前端、一点后端',
  ongoing: '一个咖啡记录工具',
  capacity: '每周 10 小时',
  constraints: '时间零碎',
  other: ''
}

describe('Current State：版本化', () => {
  it('第一次保存就是正式版本', () => {
    const saved = service.saveCurrentState(STATE_DRAFT)
    expect(saved.status).toBe('confirmed')
    expect(saved.source).toBe('user')
    expect(service.overview().currentState?.id).toBe(saved.id)
  })

  it('再次保存会把上一版归档，而不是覆盖', () => {
    const first = service.saveCurrentState(STATE_DRAFT)
    const second = service.saveCurrentState({ ...STATE_DRAFT, summary: '换了一份工作。' })

    const overview = service.overview()
    expect(overview.currentState?.id).toBe(second.id)
    expect(overview.currentState?.summary).toBe('换了一份工作。')
    // 旧版仍在，能查到「当时我是怎么描述自己的」。
    expect(overview.currentStateHistory.map((item) => item.id)).toContain(first.id)
    expect(overview.currentStateHistory[0].status).toBe('archived')
  })

  it('Agent 的草稿不会替换正式版本', () => {
    const confirmed = service.saveCurrentState(STATE_DRAFT)
    const draft = service.proposeCurrentState({ ...STATE_DRAFT, summary: 'AI 整理的版本' })

    expect(draft.status).toBe('draft')
    expect(draft.source).toBe('agent')
    const overview = service.overview()
    expect(overview.currentState?.id).toBe(confirmed.id)
    expect(overview.currentStateDraft?.id).toBe(draft.id)
    expect(overview.proposalCount).toBe(1)
  })

  it('反复提议覆盖同一份草稿，不堆积', () => {
    const first = service.proposeCurrentState({ ...STATE_DRAFT, summary: '第一版' })
    const second = service.proposeCurrentState({ ...STATE_DRAFT, summary: '第二版' })

    expect(second.id).toBe(first.id)
    expect(second.summary).toBe('第二版')
    expect(service.overview().currentStateDraft?.summary).toBe('第二版')
  })

  it('用户保存后，Agent 的草稿被清掉', () => {
    service.proposeCurrentState(STATE_DRAFT)
    service.saveCurrentState(STATE_DRAFT)
    expect(service.overview().currentStateDraft).toBeNull()
  })

  it('确认草稿后它成为正式版本，旧的归档', () => {
    const old = service.saveCurrentState(STATE_DRAFT)
    const draft = service.proposeCurrentState({ ...STATE_DRAFT, summary: '新描述' })

    const confirmed = service.confirmCurrentState(draft.id)
    expect(confirmed.status).toBe('confirmed')

    const overview = service.overview()
    expect(overview.currentState?.id).toBe(draft.id)
    expect(overview.currentStateDraft).toBeNull()
    expect(overview.currentStateHistory.map((item) => item.id)).toContain(old.id)
  })

  it('已归档的版本不能再被确认', () => {
    const first = service.saveCurrentState(STATE_DRAFT)
    service.saveCurrentState({ ...STATE_DRAFT, summary: '第二版' })

    expect(() => service.confirmCurrentState(first.id)).toThrow(PersonalDirectionError)
  })
})

describe('Direction：用户与 Agent 的分界', () => {
  it('用户创建的方向直接是 active', () => {
    const direction = service.createDirection({ title: '成为独立开发者' })
    expect(direction.status).toBe('active')
    expect(direction.source).toBe('user')
  })

  it('Agent 提议的方向是 proposed，且不算正式方向', () => {
    const proposal = service.proposeDirection({ title: '做自己的产品' })
    expect(proposal.status).toBe('proposed')

    const overview = service.overview()
    expect(overview.proposalCount).toBe(1)
    expect(overview.directions[0].status).toBe('proposed')
  })

  it('同名提议覆盖而不是新建', () => {
    const first = service.proposeDirection({ title: '成为独立开发者', motivation: '想自由安排时间' })
    const second = service.proposeDirection({ title: '成为独立开发者', description: '补充描述' })

    expect(second.id).toBe(first.id)
    expect(service.overview().directions).toHaveLength(1)
  })

  it('确认提议后变成 active', () => {
    const proposal = service.proposeDirection({ title: '成为独立开发者' })
    const confirmed = service.confirmDirection(proposal.id)
    expect(confirmed.status).toBe('active')
  })

  it('已经是 active 的方向不能再被"确认"一次', () => {
    const direction = service.createDirection({ title: '成为独立开发者' })
    expect(() => service.confirmDirection(direction.id)).toThrow(PersonalDirectionError)
  })

  it('空标题被拒绝', () => {
    expect(() => service.createDirection({ title: '   ' })).toThrow(PersonalDirectionError)
  })

  it('过期的 updatedAt 会得到 STALE_RECORD', () => {
    const direction = service.createDirection({ title: '成为独立开发者' })
    service.updateDirection(direction.id, direction.updatedAt, { title: '改过的标题' })

    try {
      service.updateDirection(direction.id, direction.updatedAt, { title: '再改一次' })
      throw new Error('应当抛出 STALE_RECORD')
    } catch (error) {
      expect(error).toBeInstanceOf(PersonalDirectionError)
      expect((error as PersonalDirectionError).code).toBe('STALE_RECORD')
    }
  })
})

describe('Stage Goal：同一方向只有一个当前阶段', () => {
  it('新建阶段直接 active，并把上一个 active 降为 paused', () => {
    const direction = service.createDirection({ title: '成为独立开发者' })
    const first = service.createStage({ directionId: direction.id, name: '第一段' })
    const second = service.createStage({ directionId: direction.id, name: '第二段' })

    expect(second.status).toBe('active')
    const stages = service.overview().stages
    expect(stages.find((item) => item.id === first.id)?.status).toBe('paused')
    expect(stages.find((item) => item.id === second.id)?.status).toBe('active')
  })

  it('确认阶段提议同样只留一个 active', () => {
    const direction = service.createDirection({ title: '成为独立开发者' })
    const current = service.createStage({ directionId: direction.id, name: '当前阶段' })
    const proposal = service.proposeStage({ directionId: direction.id, name: '提议的阶段' })

    service.confirmStage(proposal.id)

    const stages = service.overview().stages
    expect(stages.find((item) => item.id === current.id)?.status).toBe('paused')
    expect(stages.find((item) => item.id === proposal.id)?.status).toBe('active')
  })

  it('Agent 提议的阶段是 proposed，不会顶掉当前阶段', () => {
    const direction = service.createDirection({ title: '成为独立开发者' })
    const current = service.createStage({ directionId: direction.id, name: '当前阶段' })
    service.proposeStage({ directionId: direction.id, name: '提议的阶段' })

    const stages = service.overview().stages
    expect(stages.find((item) => item.id === current.id)?.status).toBe('active')
    expect(stages.filter((item) => item.status === 'proposed')).toHaveLength(1)
  })

  it('阶段必须挂在一个真实方向上', () => {
    expect(() =>
      service.createStage({ directionId: '00000000-0000-4000-8000-000000000000', name: '孤立阶段' })
    ).toThrow(PersonalDirectionError)
  })

  it('删除方向会连带删掉它的阶段', () => {
    const direction = service.createDirection({ title: '成为独立开发者' })
    service.createStage({ directionId: direction.id, name: '第一段' })

    service.deleteDirection(direction.id)

    const rows = handle.db.select().from(stageGoals).where(eq(stageGoals.directionId, direction.id)).all()
    expect(rows).toHaveLength(0)
  })
})

describe('丢弃：只对草稿生效', () => {
  it('可以丢弃 Agent 的方向提议', () => {
    const proposal = service.proposeDirection({ title: '做自己的产品' })
    service.discardDraft('direction', proposal.id)
    expect(service.overview().directions).toHaveLength(0)
  })

  it('正式方向不能被"丢弃"——必须走删除，用户要看得到自己删的是什么', () => {
    const direction = service.createDirection({ title: '成为独立开发者' })
    expect(() => service.discardDraft('direction', direction.id)).toThrow(PersonalDirectionError)
  })

  it('正式现状不能被丢弃', () => {
    const state = service.saveCurrentState(STATE_DRAFT)
    expect(() => service.discardDraft('currentState', state.id)).toThrow(PersonalDirectionError)
  })
})

describe('overview：Agent 读到的形状', () => {
  it('待确认数量把三层加起来', () => {
    const direction = service.createDirection({ title: '成为独立开发者' })
    service.proposeCurrentState(STATE_DRAFT)
    service.proposeDirection({ title: '做自己的产品' })
    service.proposeStage({ directionId: direction.id, name: '提议的阶段' })

    const snapshot = service.overviewForMcp(false)
    expect(snapshot.pending_proposals).toEqual({ current_state: true, directions: 1, stages: 1 })
  })

  it('默认不返回现状历史，要求时才给', () => {
    service.saveCurrentState(STATE_DRAFT)
    service.saveCurrentState({ ...STATE_DRAFT, summary: '第二版' })

    expect(service.overviewForMcp(false).current_state_history).toBeUndefined()
    expect(Array.isArray(service.overviewForMcp(true).current_state_history)).toBe(true)
  })
})
