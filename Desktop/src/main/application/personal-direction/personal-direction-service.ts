import { ApplicationError } from '../errors'
import type { ApplicationEvents } from '../events/application-events'
import type { Db } from '../../database/client'
import {
  archiveConfirmedCurrentStates,
  deleteCurrentState,
  deleteDirection,
  deleteStageGoal,
  insertCurrentState,
  insertDirection,
  insertStageGoal,
  nextStageSortOrder,
  pauseOtherActiveStages,
  selectArchivedCurrentStates,
  selectCurrentState,
  selectDirection,
  selectDirections,
  selectLatestCurrentState,
  selectProposedDirectionByTitle,
  selectProposedStageByName,
  selectStageGoal,
  selectStageGoals,
  updateCurrentState,
  updateDirection,
  updateStageGoal,
  type UpdateDirectionPatch,
  type UpdateStageGoalPatch
} from '../../database/repositories/personal-direction'
import type {
  CurrentState,
  CurrentStateDraft,
  CurrentStateStatus,
  Direction,
  DirectionStatus,
  PersonalDirectionOverview,
  StageGoal,
  StageGoalStatus
} from '../../../shared/contracts/personal-direction'

/**
 * Personal Direction 的业务规则。
 *
 * 这一层唯一重要的事，是把「谁说的」和「算不算数」分开：
 *
 * - `save*` / `create*` / `update*` —— 用户在应用里亲手操作，直接生效；
 * - `propose*` —— Agent 经 MCP 写的，一律进草稿；同一个对象反复提议是覆盖，
 *   不是堆积。
 *
 * Agent **没有任何方法**能把草稿变成正式资料：确认只有 `confirm*`，
 * 而它只挂在 IPC 上、只有应用界面会调。所以「AI 整理的内容必须经用户确认」
 * 是结构保证，不是约定。
 */

export class PersonalDirectionError extends ApplicationError {
  constructor(
    code: 'NOT_FOUND' | 'STALE_RECORD' | 'VALIDATION_ERROR',
    message: string
  ) {
    super(code, message)
    this.name = 'PersonalDirectionError'
  }
}

// 入参类型由契约里的 zod schema 推出，IPC 与 MCP 共用同一组字段与长度上限。
import type { DirectionInput, StageGoalInput } from '../../../shared/contracts/personal-direction'
export type { DirectionInput, StageGoalInput }

function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new PersonalDirectionError('VALIDATION_ERROR', `${field} must not be empty`)
  }
  return trimmed
}

export class PersonalDirectionService {
  constructor(
    private readonly db: Db,
    private readonly events: ApplicationEvents
  ) {}

  // MARK: - 读取

  /** 按 ID 取现状；草稿也要能取到，所以不按状态过滤。 */
  private currentStateOrThrow(id: string): CurrentState {
    const row = selectCurrentState(this.db, id)
    if (!row) {
      throw new PersonalDirectionError('NOT_FOUND', `current state ${id} does not exist`)
    }
    return row
  }

  /**
   * Studio 面板一次性要的全部数据。
   *
   * 「待确认的提议」按类型分别给出：现状草稿只有一条（反复提议覆盖），
   * 方向与阶段的 proposed 可能有多条，面板只显示数量与最新一条，详情在
   * 各自的列表里看。
   */
  overview(): PersonalDirectionOverview {
    const currentState = selectLatestCurrentState(this.db, 'confirmed')
    const currentStateDraft = selectLatestCurrentState(this.db, 'draft')
    const history = selectArchivedCurrentStates(this.db)
    const allDirections = selectDirections(this.db)
    const stages = selectStageGoals(this.db)

    const proposalCount =
      (currentStateDraft ? 1 : 0) +
      allDirections.filter((item) => item.status === 'proposed').length +
      stages.filter((item) => item.status === 'proposed').length

    return {
      currentState,
      currentStateHistory: history,
      currentStateDraft,
      directions: allDirections,
      proposalCount,
      stages
    }
  }

  /**
   * MCP 的读取形状：snake_case，只给 Agent 真正要用的东西。
   *
   * 刻意不返回 `created_at` 之类的内部时间戳——AI 很容易拿一个时间戳
   * 编出「最近三周没有进展」这种结论，而它根本没有活动数据支撑。
   * 时间只在 updated_at 上给一次，够它判断新旧。
   */
  overviewForMcp(includeHistory: boolean): Record<string, unknown> {
    const overview = this.overview()

    const stateShape = (state: CurrentState): Record<string, unknown> => ({
      state_id: state.id,
      summary: state.summary,
      work_status: state.workStatus,
      capabilities: state.capabilities,
      ongoing: state.ongoing,
      capacity: state.capacity,
      constraints: state.constraints,
      other: state.other,
      status: state.status,
      source: state.source,
      updated_at: state.updatedAt
    })

    const result: Record<string, unknown> = {
      current_state: overview.currentState ? stateShape(overview.currentState) : null,
      current_state_draft: overview.currentStateDraft ? stateShape(overview.currentStateDraft) : null,
      directions: overview.directions.map((direction) => ({
        direction_id: direction.id,
        title: direction.title,
        description: direction.description,
        motivation: direction.motivation,
        time_horizon: direction.timeHorizon,
        outcomes: direction.outcomes,
        constraints: direction.constraints,
        status: direction.status,
        source: direction.source,
        updated_at: direction.updatedAt
      })),
      stages: overview.stages.map((stage) => ({
        stage_id: stage.id,
        direction_id: stage.directionId,
        name: stage.name,
        goal: stage.goal,
        expected_outcome: stage.expectedOutcome,
        completion_criteria: stage.completionCriteria,
        time_horizon: stage.timeHorizon,
        obstacles: stage.obstacles,
        work_context_id: stage.workContextId,
        status: stage.status,
        source: stage.source,
        updated_at: stage.updatedAt
      })),
      pending_proposals: {
        current_state: overview.currentStateDraft !== null,
        directions: overview.directions.filter((item) => item.status === 'proposed').length,
        stages: overview.stages.filter((item) => item.status === 'proposed').length
      }
    }

    if (includeHistory) {
      result.current_state_history = overview.currentStateHistory.map(stateShape)
    }
    return result
  }

  // MARK: - Current State（用户）

  /**
   * 用户保存现状：直接成为正式版本。
   *
   * 旧版本转 archived 而不是删除——「我三个月前怎么描述自己」本身就是
   * 一条有价值的变化记录。同时清掉 Agent 的草稿：用户已经用新的描述
   * 覆盖了那次提议，草稿再留着只会让面板一直提示「有 1 条待确认」。
   */
  saveCurrentState(draft: CurrentStateDraft): CurrentState {
    const now = Date.now()
    const draftRow = selectLatestCurrentState(this.db, 'draft')
    if (draftRow) deleteCurrentState(this.db, draftRow.id)

    const saved = insertCurrentState(this.db, {
      ...draft,
      status: 'confirmed',
      source: 'user',
      now
    })
    archiveConfirmedCurrentStates(this.db, saved.id, now)
    this.events.emit('personalDirection')
    return saved
  }

  // MARK: - Current State（Agent）

  /** Agent 提议现状：只能写草稿，覆盖上一版草稿，绝不碰已确认的版本。 */
  proposeCurrentState(draft: CurrentStateDraft): CurrentState {
    const now = Date.now()
    const existing = selectLatestCurrentState(this.db, 'draft')
    if (existing) {
      const updated = updateCurrentState(
        this.db,
        existing.id,
        existing.updatedAt,
        { ...draft, status: 'draft' },
        now
      )
      if (!updated) throw new PersonalDirectionError('STALE_RECORD', 'current state draft changed')
      this.events.emit('personalDirection')
      return updated
    }

    const created = insertCurrentState(this.db, { ...draft, status: 'draft', source: 'agent', now })
    this.events.emit('personalDirection')
    return created
  }

  // MARK: - Direction（用户）

  createDirection(input: DirectionInput): Direction {
    const now = Date.now()
    const created = insertDirection(this.db, {
      title: requireText(input.title, 'title'),
      description: input.description ?? '',
      motivation: input.motivation ?? '',
      timeHorizon: input.timeHorizon ?? '',
      outcomes: input.outcomes ?? [],
      constraints: input.constraints ?? '',
      status: 'active',
      source: 'user',
      now
    })
    this.events.emit('personalDirection')
    return created
  }

  updateDirection(id: string, expectedUpdatedAt: number, patch: UpdateDirectionPatch): Direction {
    const existing = selectDirection(this.db, id)
    if (!existing) throw new PersonalDirectionError('NOT_FOUND', `direction ${id} does not exist`)
    if (patch.title !== undefined) patch = { ...patch, title: requireText(patch.title, 'title') }

    const updated = updateDirection(this.db, id, expectedUpdatedAt, patch, Date.now())
    if (!updated) throw new PersonalDirectionError('STALE_RECORD', `direction ${id} changed`)
    this.events.emit('personalDirection')
    return updated
  }

  deleteDirection(id: string): void {
    const existing = selectDirection(this.db, id)
    if (!existing) throw new PersonalDirectionError('NOT_FOUND', `direction ${id} does not exist`)
    // 阶段随方向一起走（FK cascade）：离开方向的阶段没有意义。
    deleteDirection(this.db, id)
    this.events.emit('personalDirection')
  }

  /** 暂停 / 恢复 / 达成 / 放弃——规格要求「不删除也能表达不再推进」。 */
  setDirectionStatus(id: string, status: DirectionStatus): Direction {
    const existing = selectDirection(this.db, id)
    if (!existing) throw new PersonalDirectionError('NOT_FOUND', `direction ${id} does not exist`)
    const updated = updateDirection(this.db, id, existing.updatedAt, { status }, Date.now())
    if (!updated) throw new PersonalDirectionError('STALE_RECORD', `direction ${id} changed`)
    this.events.emit('personalDirection')
    return updated
  }

  // MARK: - Direction（Agent）

  proposeDirection(input: DirectionInput): Direction {
    const title = requireText(input.title, 'title')
    const now = Date.now()
    const fields = {
      title,
      description: input.description ?? '',
      motivation: input.motivation ?? '',
      timeHorizon: input.timeHorizon ?? '',
      outcomes: input.outcomes ?? [],
      constraints: input.constraints ?? ''
    }

    // 同名提议视为同一份草稿的再编辑：覆盖而不是追加，否则用户会攒下
    // 一堆内容相同的待确认项。
    const existing = selectProposedDirectionByTitle(this.db, title)
    if (existing) {
      const updated = updateDirection(this.db, existing.id, existing.updatedAt, fields, now)
      if (!updated) throw new PersonalDirectionError('STALE_RECORD', `direction ${existing.id} changed`)
      this.events.emit('personalDirection')
      return updated
    }

    const created = insertDirection(this.db, {
      ...fields,
      status: 'proposed',
      source: 'agent',
      now
    })
    this.events.emit('personalDirection')
    return created
  }

  // MARK: - Stage Goal（用户）

  /**
   * 用户新建阶段：直接是 active。
   *
   * 同方向的其他 active 会被降为 paused——「当前阶段」只能是单数，
   * 否则「我现在在哪一段」永远没有答案。
   */
  createStage(input: StageGoalInput): StageGoal {
    const direction = selectDirection(this.db, input.directionId)
    if (!direction) {
      throw new PersonalDirectionError('NOT_FOUND', `direction ${input.directionId} does not exist`)
    }
    const now = Date.now()
    const created = insertStageGoal(this.db, {
      directionId: input.directionId,
      name: requireText(input.name, 'name'),
      goal: input.goal ?? '',
      expectedOutcome: input.expectedOutcome ?? '',
      completionCriteria: input.completionCriteria ?? '',
      timeHorizon: input.timeHorizon ?? '',
      obstacles: input.obstacles ?? '',
      workContextId: input.workContextId ?? null,
      status: 'active',
      source: 'user',
      sortOrder: nextStageSortOrder(this.db, input.directionId),
      now
    })
    pauseOtherActiveStages(this.db, input.directionId, created.id, now)
    this.events.emit('personalDirection')
    return created
  }

  updateStage(id: string, expectedUpdatedAt: number, patch: UpdateStageGoalPatch): StageGoal {
    const existing = selectStageGoal(this.db, id)
    if (!existing) throw new PersonalDirectionError('NOT_FOUND', `stage ${id} does not exist`)
    if (patch.name !== undefined) patch = { ...patch, name: requireText(patch.name, 'name') }

    const now = Date.now()
    const updated = updateStageGoal(this.db, id, expectedUpdatedAt, patch, now)
    if (!updated) throw new PersonalDirectionError('STALE_RECORD', `stage ${id} changed`)
    if (updated.status === 'active') {
      pauseOtherActiveStages(this.db, updated.directionId, updated.id, now)
    }
    this.events.emit('personalDirection')
    return updated
  }

  setStageStatus(id: string, status: StageGoalStatus): StageGoal {
    const existing = selectStageGoal(this.db, id)
    if (!existing) throw new PersonalDirectionError('NOT_FOUND', `stage ${id} does not exist`)
    const now = Date.now()
    const updated = updateStageGoal(this.db, id, existing.updatedAt, { status }, now)
    if (!updated) throw new PersonalDirectionError('STALE_RECORD', `stage ${id} changed`)
    if (status === 'active') {
      pauseOtherActiveStages(this.db, updated.directionId, updated.id, now)
    }
    this.events.emit('personalDirection')
    return updated
  }

  deleteStage(id: string): void {
    const existing = selectStageGoal(this.db, id)
    if (!existing) throw new PersonalDirectionError('NOT_FOUND', `stage ${id} does not exist`)
    deleteStageGoal(this.db, id)
    this.events.emit('personalDirection')
  }

  // MARK: - Stage Goal（Agent）

  proposeStage(input: StageGoalInput): StageGoal {
    const direction = selectDirection(this.db, input.directionId)
    if (!direction) {
      throw new PersonalDirectionError('NOT_FOUND', `direction ${input.directionId} does not exist`)
    }
    const name = requireText(input.name, 'name')
    const now = Date.now()
    const fields = {
      name,
      goal: input.goal ?? '',
      expectedOutcome: input.expectedOutcome ?? '',
      completionCriteria: input.completionCriteria ?? '',
      timeHorizon: input.timeHorizon ?? '',
      obstacles: input.obstacles ?? '',
      workContextId: input.workContextId ?? null
    }

    const existing = selectProposedStageByName(this.db, input.directionId, name)
    if (existing) {
      const updated = updateStageGoal(this.db, existing.id, existing.updatedAt, fields, now)
      if (!updated) throw new PersonalDirectionError('STALE_RECORD', `stage ${existing.id} changed`)
      this.events.emit('personalDirection')
      return updated
    }

    const created = insertStageGoal(this.db, {
      ...fields,
      directionId: input.directionId,
      status: 'proposed',
      source: 'agent',
      sortOrder: nextStageSortOrder(this.db, input.directionId),
      now
    })
    this.events.emit('personalDirection')
    return created
  }

  // MARK: - 确认与丢弃（只由应用界面调用）

  /**
   * 确认一条现状草稿。
   *
   * 确认之后它就是正式版本，其余 confirmed 全部归档——所以「当前现状」
   * 永远只有一条，历史仍然完整。
   */
  confirmCurrentState(id: string): CurrentState {
    const existing = this.currentStateOrThrow(id)
    if (existing.status === 'archived') {
      throw new PersonalDirectionError('VALIDATION_ERROR', `current state ${id} is archived`)
    }
    const now = Date.now()
    const updated = updateCurrentState(
      this.db,
      id,
      existing.updatedAt,
      { status: 'confirmed' },
      now
    )
    if (!updated) throw new PersonalDirectionError('STALE_RECORD', `current state ${id} changed`)
    archiveConfirmedCurrentStates(this.db, id, now)
    this.events.emit('personalDirection')
    return this.currentStateOrThrow(id)
  }

  /** 确认方向提议：proposed → active。 */
  confirmDirection(id: string): Direction {
    const existing = selectDirection(this.db, id)
    if (!existing) throw new PersonalDirectionError('NOT_FOUND', `direction ${id} does not exist`)
    if (existing.status !== 'proposed') {
      throw new PersonalDirectionError('VALIDATION_ERROR', `direction ${id} is not a proposal`)
    }
    const updated = updateDirection(this.db, id, existing.updatedAt, { status: 'active' }, Date.now())
    if (!updated) throw new PersonalDirectionError('STALE_RECORD', `direction ${id} changed`)
    this.events.emit('personalDirection')
    return updated
  }

  /** 确认阶段提议：proposed → active，并让同方向其他 active 让位。 */
  confirmStage(id: string): StageGoal {
    const existing = selectStageGoal(this.db, id)
    if (!existing) throw new PersonalDirectionError('NOT_FOUND', `stage ${id} does not exist`)
    if (existing.status !== 'proposed') {
      throw new PersonalDirectionError('VALIDATION_ERROR', `stage ${id} is not a proposal`)
    }
    const now = Date.now()
    const updated = updateStageGoal(this.db, id, existing.updatedAt, { status: 'active' }, now)
    if (!updated) throw new PersonalDirectionError('STALE_RECORD', `stage ${id} changed`)
    pauseOtherActiveStages(this.db, updated.directionId, updated.id, now)
    this.events.emit('personalDirection')
    return updated
  }

  /**
   * 丢弃一条草稿。
   *
   * 只允许丢弃草稿与提议：正式资料不能被「丢弃」掉——那是删除操作，
   * 得走各自的 delete，且用户要看到自己删的是什么。
   */
  discardDraft(kind: 'currentState' | 'direction' | 'stage', id: string): void {
    if (kind === 'currentState') {
      const existing = this.currentStateOrThrow(id)
      if (existing.status !== 'draft') {
        throw new PersonalDirectionError('VALIDATION_ERROR', `current state ${id} is not a draft`)
      }
      deleteCurrentState(this.db, id)
    } else if (kind === 'direction') {
      const existing = selectDirection(this.db, id)
      if (!existing) throw new PersonalDirectionError('NOT_FOUND', `direction ${id} does not exist`)
      if (existing.status !== 'proposed') {
        throw new PersonalDirectionError('VALIDATION_ERROR', `direction ${id} is not a proposal`)
      }
      deleteDirection(this.db, id)
    } else {
      const existing = selectStageGoal(this.db, id)
      if (!existing) throw new PersonalDirectionError('NOT_FOUND', `stage ${id} does not exist`)
      if (existing.status !== 'proposed') {
        throw new PersonalDirectionError('VALIDATION_ERROR', `stage ${id} is not a proposal`)
      }
      deleteStageGoal(this.db, id)
    }
    this.events.emit('personalDirection')
  }
}
