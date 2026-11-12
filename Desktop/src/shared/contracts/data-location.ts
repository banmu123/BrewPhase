import { z } from 'zod'

/**
 * 业务数据目录（`brewphase.db` + `media/`）的位置管理。
 *
 * 与 Electron 的 `userData` 分开：缓存、语言偏好、MCP/Chrome 的本地端点
 * 留在 userData；只有用户数据跟着这里走。
 */

export const dataLocationStatusSchema = z.object({
  dataDir: z.string(),
  defaultDir: z.string(),
  isCustom: z.boolean(),
  configPath: z.string(),
  lastError: z.string().nullable()
})
export type DataLocationStatus = z.infer<typeof dataLocationStatusSchema>

export const dataLocationChangeResultSchema = z.object({
  ok: z.boolean(),
  canceled: z.boolean().optional(),
  dataDir: z.string().optional(),
  requiresRestart: z.boolean().optional(),
  message: z.string().max(400).optional(),
  status: dataLocationStatusSchema
})
export type DataLocationChangeResult = z.infer<typeof dataLocationChangeResultSchema>
