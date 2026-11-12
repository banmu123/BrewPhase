import { ApplicationError } from '../errors'
import type { ApplicationEvents } from '../events/application-events'
import type { Db } from '../../database/client'
import { canvases, records } from '../../database/schema'
import { eq } from 'drizzle-orm'
import {
  deleteWorkContext,
  deleteWorkContextResources,
  insertWorkContext,
  insertWorkContextResource,
  selectWorkContext,
  selectWorkContextResource,
  selectWorkContextResources,
  selectWorkContexts,
  updateWorkContext,
  type UpdateWorkContextPatch
} from '../../database/repositories/work-contexts'
import type {
  WorkContext,
  WorkContextResource,
  WorkContextResourceType,
  WorkContextStatus,
  WorkContextStudioItem
} from '../../../shared/contracts/work-context'

/**
 * WorkContextService：持续工作上下文的应用服务。
 *
 * - 校验与清理都在 Main 端（MCP 进程与 Renderer 都没有数据库权限）；
 * - 关联的 Record / Canvas 被删除后，读取时清理失效关联（prune-on-read），
 *   URL 关联永远有效；
 * - V1 不提供删除接口（Agent 不能删工作上下文）；应用退出等内部场景用
 *   `deleteForTest` 之外的 prune 即可，本类不暴露 delete。
 */

export type WorkContextResourceView = WorkContextResource & {
  /** 资源是否真实存在（record / canvas 校验；url 恒真）。 */
  exists: boolean
  /** 供展示与 MCP get 的短摘要：record 标题 / canvas 名称 / url 本身。 */
  label: string
}

export type WorkContextDetail = {
  context: WorkContext
  resources: WorkContextResourceView[]
  recordCount: number
  canvasCount: number
  urlCount: number
}

/**
 * 业务错误：继承 ApplicationError，让 Bridge 路由把 code / message
 * 原样透给 MCP 客户端（其它异常会被替换成 INTERNAL_ERROR 通用文案）。
 */
export class WorkContextError extends ApplicationError {
  constructor(
    code: 'NOT_FOUND' | 'STALE_RECORD' | 'VALIDATION_ERROR',
    message: string
  ) {
    super(code, message)
    this.name = 'WorkContextError'
  }
}

export class WorkContextService {
  constructor(
    private readonly db: Db,
    private readonly events: ApplicationEvents
  ) {}

  create(input: { title: string; goal?: string; summary?: string; nextStep?: string }): WorkContext {
    const context = insertWorkContext(this.db, {
      title: input.title,
      goal: input.goal ?? '',
      summary: input.summary ?? '',
      nextStep: input.nextStep ?? '',
      now: Date.now()
    })
    this.events.emit('workContexts')
    return context
  }

  list(status: WorkContextStatus | null): WorkContext[] {
    return selectWorkContexts(this.db, status)
  }

  get(id: string): WorkContextDetail {
    const context = selectWorkContext(this.db, id)
    if (!context) throw new WorkContextError('NOT_FOUND', `work context ${id} does not exist`)

    const resources = selectWorkContextResources(this.db, id)
    const views: WorkContextResourceView[] = []
    const staleIds: string[] = []

    for (const resource of resources) {
      if (resource.resourceType === 'url') {
        views.push({ ...resource, exists: true, label: resource.resourceId })
        continue
      }
      const exists = this.resourceExists(resource.resourceType, resource.resourceId)
      if (!exists) {
        staleIds.push(resource.id)
        continue
      }
      views.push({ ...resource, exists: true, label: this.resourceLabel(resource.resourceType, resource.resourceId) })
    }
    if (staleIds.length > 0) deleteWorkContextResources(this.db, staleIds)
    this.events.emit('workContexts')

    return {
      context,
      resources: views,
      recordCount: views.filter((v) => v.resourceType === 'record').length,
      canvasCount: views.filter((v) => v.resourceType === 'canvas').length,
      urlCount: views.filter((v) => v.resourceType === 'url').length
    }
  }

  /** Studio Home 的只读列表：扁平视图，附资源计数与可点击资源（存在性已校验）。 */
  listForStudio(limit = 3): WorkContextStudioItem[] {
    return this.list(null)
      .filter((context) => context.status === 'active')
      .slice(0, limit)
      .map((context) => {
        const detail = this.get(context.id)
        return {
          id: context.id,
          title: context.title,
          summary: context.summary,
          nextStep: context.nextStep,
          status: context.status,
          lastActivityAt: context.lastActivityAt,
          recordCount: detail.recordCount,
          canvasCount: detail.canvasCount,
          urlCount: detail.urlCount,
          resources: detail.resources.map((resource) => ({
            id: resource.id,
            resourceType: resource.resourceType,
            resourceId: resource.resourceId,
            role: resource.role,
            label: resource.label
          }))
        }
      })
  }

  update(
    id: string,
    expectedUpdatedAt: number,
    patch: UpdateWorkContextPatch
  ): WorkContext {
    const updated = updateWorkContext(this.db, id, expectedUpdatedAt, patch, Date.now())
    if (!updated) {
      const current = selectWorkContext(this.db, id)
      if (!current) throw new WorkContextError('NOT_FOUND', `work context ${id} does not exist`)
      throw new WorkContextError('STALE_RECORD', 'work context was updated by someone else; re-read and retry')
    }
    this.events.emit('workContexts')
    return updated
  }

  link(input: {
    contextId: string
    resourceType: WorkContextResourceType
    resourceId?: string
    url?: string
    role?: WorkContextResource['role']
    note?: string
  }): { resource: WorkContextResource; created: boolean } {
    const context = selectWorkContext(this.db, input.contextId)
    if (!context) {
      throw new WorkContextError('NOT_FOUND', `work context ${input.contextId} does not exist`)
    }

    let resourceId: string
    if (input.resourceType === 'url') {
      const url = (input.url ?? '').trim()
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new WorkContextError('VALIDATION_ERROR', 'url is not a valid absolute URL')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new WorkContextError('VALIDATION_ERROR', 'only http / https URLs are supported')
      }
      resourceId = parsed.toString()
    } else {
      resourceId = input.resourceId ?? ''
      if (!resourceId) {
        throw new WorkContextError('VALIDATION_ERROR', `${input.resourceType} resources need resource_id`)
      }
      if (!this.resourceExists(input.resourceType, resourceId)) {
        throw new WorkContextError(
          'NOT_FOUND',
          `${input.resourceType} ${resourceId} does not exist`
        )
      }
    }

    const result = insertWorkContextResource(this.db, {
      workContextId: input.contextId,
      resourceType: input.resourceType,
      resourceId,
      role: input.role ?? 'reference',
      note: input.note ?? '',
      now: Date.now()
    })
    this.events.emit('workContexts')
    return result
  }

  private resourceExists(type: WorkContextResourceType, id: string): boolean {
    if (type === 'url') return true
    if (type === 'record') {
      return !!this.db.select({ id: records.id }).from(records).where(eq(records.id, id)).get()
    }
    return !!this.db.select({ id: canvases.id }).from(canvases).where(eq(canvases.id, id)).get()
  }

  private resourceLabel(type: WorkContextResourceType, id: string): string {
    if (type === 'record') {
      return (
        this.db.select({ title: records.title }).from(records).where(eq(records.id, id)).get()
          ?.title ?? id
      )
    }
    if (type === 'canvas') {
      return (
        this.db.select({ name: canvases.name }).from(canvases).where(eq(canvases.id, id)).get()
          ?.name ?? id
      )
    }
    return id
  }

  /** MCP 形状：get_work_context 的返回（snake_case，含资源标签与计数）。 */
  getForMcp(id: string): Record<string, unknown> {
    const detail = this.get(id)
    return {
      context_id: detail.context.id,
      title: detail.context.title,
      goal: detail.context.goal,
      summary: detail.context.summary,
      next_step: detail.context.nextStep,
      status: detail.context.status,
      created_at: detail.context.createdAt,
      updated_at: detail.context.updatedAt,
      last_activity_at: detail.context.lastActivityAt,
      resources: detail.resources.map((resource) => ({
        resource_id: resource.id,
        resource_type: resource.resourceType,
        resource_ref: resource.resourceId,
        role: resource.role,
        note: resource.note,
        label: resource.label
      })),
      record_count: detail.recordCount,
      canvas_count: detail.canvasCount,
      url_count: detail.urlCount
    }
  }

  /** MCP 形状：单条关联（幂等重放 / link 响应用）。 */
  resourceForMcp(resourceId: string): Record<string, unknown> {
    const resource = selectWorkContextResource(this.db, resourceId)
    if (!resource) {
      throw new WorkContextError('NOT_FOUND', `work context resource ${resourceId} does not exist`)
    }
    return {
      resource_id: resource.id,
      resource_type: resource.resourceType,
      resource_ref: resource.resourceId,
      role: resource.role,
      note: resource.note,
      label: this.resourceLabel(resource.resourceType, resource.resourceId)
    }
  }

  /** 列表用摘要形状：附资源计数，不展开资源明细。 */
  summaryForMcp(context: WorkContext): Record<string, unknown> {
    const detail = this.get(context.id)
    return {
      context_id: context.id,
      title: context.title,
      status: context.status,
      summary: context.summary,
      next_step: context.nextStep,
      last_activity_at: context.lastActivityAt,
      record_count: detail.recordCount,
      canvas_count: detail.canvasCount,
      url_count: detail.urlCount
    }
  }

  /** 供测试注入假时钟（幂等/乐观锁的时间戳可预测）。 */
  deleteForTest(id: string): void {
    deleteWorkContext(this.db, id)
  }
}
