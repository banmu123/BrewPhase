import { z } from 'zod'

/**
 * Work Context V1（migration 008）：持续工作上下文。
 *
 * 只描述「一项持续工作」的元信息（目标 / 进度 / 下一步），通过现有实体 ID
 * 引用 Record / Canvas / URL——**不复制业务内容**，不是任务管理系统。
 * V1 是 Desktop 本地数据：不进 change_log，不进 iOS 同步协议；
 * 所有写工具的响应都带 `sync_status: "desktop_local_only"`。
 */

export const WORK_CONTEXT_STATUSES = ['active', 'paused', 'completed'] as const
export type WorkContextStatus = (typeof WORK_CONTEXT_STATUSES)[number]
export const workContextStatusSchema = z.enum(WORK_CONTEXT_STATUSES)

export const WORK_CONTEXT_RESOURCE_TYPES = ['record', 'canvas', 'url'] as const
export type WorkContextResourceType = (typeof WORK_CONTEXT_RESOURCE_TYPES)[number]
export const workContextResourceTypeSchema = z.enum(WORK_CONTEXT_RESOURCE_TYPES)

export const WORK_CONTEXT_RESOURCE_ROLES = ['source', 'output', 'reference'] as const
export type WorkContextResourceRole = (typeof WORK_CONTEXT_RESOURCE_ROLES)[number]
export const workContextResourceRoleSchema = z.enum(WORK_CONTEXT_RESOURCE_ROLES)

const uuid = z.string().uuid()

export const workContextSchema = z.object({
  id: uuid,
  title: z.string().max(200),
  goal: z.string().max(2_000).default(''),
  summary: z.string().max(4_000).default(''),
  nextStep: z.string().max(2_000).default(''),
  status: workContextStatusSchema.default('active'),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastActivityAt: z.number().int()
})
export type WorkContext = z.infer<typeof workContextSchema>

export const workContextResourceSchema = z.object({
  id: uuid,
  workContextId: uuid,
  resourceType: workContextResourceTypeSchema,
  /** record / canvas 存实体 ID；url 类型存规范化后的 HTTP(S) 地址。 */
  resourceId: z.string().max(2_000),
  role: workContextResourceRoleSchema.default('reference'),
  note: z.string().max(500).default(''),
  createdAt: z.number().int()
})
export type WorkContextResource = z.infer<typeof workContextResourceSchema>

/** Studio Home「继续工作」区块的只读视图（Renderer 经 IPC 读取）。 */
export type WorkContextStudioItem = {
  id: string
  title: string
  summary: string
  nextStep: string
  status: WorkContextStatus
  lastActivityAt: number
  recordCount: number
  canvasCount: number
  urlCount: number
  resources: Array<{
    id: string
    resourceType: WorkContextResourceType
    resourceId: string
    role: WorkContextResourceRole
    label: string
  }>
}
