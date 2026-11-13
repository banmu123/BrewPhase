import { z } from 'zod'

/**
 * MCP 接入的共享契约：scope、错误码、客户端信息、Bridge 状态。
 *
 * 这一份同时被三处引用：Main 的授权/路由、preload 的类型、Renderer 的
 * AI Connections 页。**scope 枚举只在这里定义一次**——新增 scope 必须同时
 * 更新 `shared/mcp/tool-schemas.ts` 的工具映射与设置页的分组展示。
 */

export const MCP_SCOPES = [
  'records:read',
  'records:create',
  'records:update',
  'tags:read',
  'tags:create',
  'coffee:read',
  'canvas:read',
  'canvas:write',
  'work_context:read',
  'work_context:create',
  'work_context:update',
  'work_context:link',
  // Personal Direction：Agent 只能读，和「提议」（写草稿）。
  // 没有 confirm 类 scope——确认动作只存在于应用界面，MCP 无权授出。
  'direction:read',
  'direction:propose'
] as const

export const mcpScopeSchema = z.enum(MCP_SCOPES)
export type McpScope = (typeof MCP_SCOPES)[number]

/**
 * 设置页展示时的分组。`group` 只是字典键——显示名由 Renderer 的 i18n
 * （`t.mcp.create.scopeGroup[group]`）提供；权限判断与它对无关。
 */
export const MCP_SCOPE_GROUP_KEYS = [
  'records',
  'tags',
  'coffee',
  'canvas',
  'workContext',
  'direction'
] as const
export type McpScopeGroup = (typeof MCP_SCOPE_GROUP_KEYS)[number]

export const MCP_SCOPE_GROUPS: Array<{ group: McpScopeGroup; scopes: McpScope[] }> = [
  { group: 'records', scopes: ['records:read', 'records:create', 'records:update'] },
  { group: 'tags', scopes: ['tags:read', 'tags:create'] },
  { group: 'coffee', scopes: ['coffee:read'] },
  { group: 'canvas', scopes: ['canvas:read', 'canvas:write'] },
  {
    group: 'workContext',
    scopes: ['work_context:read', 'work_context:create', 'work_context:update', 'work_context:link']
  },
  { group: 'direction', scopes: ['direction:read', 'direction:propose'] }
]

/**
 * 权限预设。第一项就是默认值，顺序即梯度：默认全给，往下逐级收紧。
 *
 * 默认给全量 14 项，是因为这是用户自己电脑上的 Agent、读的是用户自己的数据：
 * 一个连记录都改不了的助手，每次都要人转述，实际帮不上忙。这里的安全边界
 * 不靠「少给权限」，而靠三件更硬的事：
 *
 *   1. Agent 写的一律是草稿或普通记录，**用户的人生方向只能由本人在应用内确认**
 *      （MCP 侧根本没有 confirm 这个能力，不是靠默认不勾来省）。
 *   2. 每个 Agent 独立 Token、可在设置里随时撤销。
 *   3. 写入类权限在界面上逐项可见，想收紧随时往下点一档。
 *
 * 「个人成长协作」与「个人成长」是降级档：只读 + 写草稿、纯只读。
 */
export const MCP_SCOPE_PRESETS = [
  { key: 'fullAccess', scopes: [...MCP_SCOPES] },
  {
    key: 'personalGrowthCollab',
    scopes: ['direction:read', 'work_context:read', 'records:read', 'direction:propose']
  },
  { key: 'personalGrowth', scopes: ['direction:read', 'work_context:read', 'records:read'] },
  { key: 'recordsOnly', scopes: ['records:read'] }
] as const satisfies ReadonlyArray<{ key: string; scopes: readonly McpScope[] }>

export type McpScopePresetKey = (typeof MCP_SCOPE_PRESETS)[number]['key']

export const MCP_ERROR_CODES = [
  'APP_NOT_RUNNING',
  'UNAUTHORIZED',
  'PERMISSION_DENIED',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'STALE_RECORD',
  'IDEMPOTENCY_KEY_REUSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_PROTOCOL_MISMATCH',
  'REQUEST_TOO_LARGE',
  'REQUEST_TIMEOUT',
  'INTERNAL_ERROR'
] as const

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number]

export const mcpClientInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  scopes: z.array(mcpScopeSchema),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable()
})
export type McpClientInfo = z.infer<typeof mcpClientInfoSchema>

/** 创建客户端成功：明文 token 只在这里出现一次，之后无法再取。 */
export const mcpClientCreatedSchema = mcpClientInfoSchema.extend({
  token: z.string().min(10)
})
export type McpClientCreated = z.infer<typeof mcpClientCreatedSchema>

export const mcpClientCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(mcpScopeSchema).min(1).max(MCP_SCOPES.length)
})
export type McpClientCreateInput = z.infer<typeof mcpClientCreateInputSchema>

/** 设置页展示的 Bridge 运行状态。 */
export const mcpBridgeStatusSchema = z.object({
  running: z.boolean(),
  socketPath: z.string().nullable(),
  protocolVersion: z.number().int(),
  clientCount: z.number().int(),
  /** 当前应用数据目录——用户复制配置时用来填 BREWPHASE_MCP_USER_DATA_DIR。 */
  userDataDir: z.string(),
  /** 编译后的 MCP 入口绝对路径（mcp:build 的产物），供复制配置使用。 */
  mcpEntryPath: z.string(),
  platformSupported: z.boolean()
})
export type McpBridgeStatus = z.infer<typeof mcpBridgeStatusSchema>
