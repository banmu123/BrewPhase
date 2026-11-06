import { z } from 'zod'

/**
 * 资料库契约。四种载体与 iOS `Record.carrier` 完全一致：link / image / video / text。
 * 标签是多对多（`record_tags` 关系表），不是数组——数组会让「按标签筛选」退化成
 * 全表扫描，也没法在标签改名时一次改完。
 */

export const RECORD_CARRIERS = ['link', 'image', 'video', 'text'] as const
export const recordCarrierSchema = z.enum(RECORD_CARRIERS)
export type RecordCarrier = z.infer<typeof recordCarrierSchema>

export const LINK_PROVIDERS = ['youtube', 'bilibili', 'x', 'github', 'generic'] as const
export const linkProviderSchema = z.enum(LINK_PROVIDERS)
export type LinkProvider = z.infer<typeof linkProviderSchema>

export const carrierLabel: Record<RecordCarrier, string> = {
  link: '链接',
  image: '图片',
  video: '视频',
  text: '文字'
}

export const recordTagSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(40),
  createdAt: z.number().int()
})
export type RecordTag = z.infer<typeof recordTagSchema>

/**
 * `mediaPath` / `previewPath` 是**文件名**，不是绝对路径——媒体目录由主进程管理，
 * 换机器、换用户目录都不会把记录指向一个不存在的绝对路径。
 */
export const recordSchema = z.object({
  id: z.string().uuid(),
  carrier: recordCarrierSchema,
  title: z.string().max(500).default(''),
  note: z.string().max(20_000).default(''),
  urlString: z.string().max(2_000).default(''),
  canonicalURL: z.string().max(2_000).nullable().default(null),
  provider: linkProviderSchema.default('generic'),
  platformContentID: z.string().max(120).nullable().default(null),
  sourceName: z.string().max(200).default(''),
  authorName: z.string().max(200).default(''),
  summary: z.string().max(4_000).default(''),
  mediaPath: z.string().max(300).nullable().default(null),
  previewPath: z.string().max(300).nullable().default(null),
  thumbnailURLString: z.string().max(2_000).nullable().default(null),
  metadataStatus: z.enum(['idle', 'ok', 'failed']).default('idle'),
  repositoryStars: z.number().int().nullable().default(null),
  repositoryForks: z.number().int().nullable().default(null),
  repositoryLanguage: z.string().max(60).nullable().default(null),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  tagIds: z.array(z.string().uuid()).default([])
})
export type RecordItem = z.infer<typeof recordSchema>

export const recordDraftSchema = z.object({
  carrier: recordCarrierSchema,
  title: z.string().max(500).default(''),
  note: z.string().max(20_000).default(''),
  urlString: z.string().max(2_000).default(''),
  provider: linkProviderSchema.default('generic'),
  sourceName: z.string().max(200).default(''),
  authorName: z.string().max(200).default(''),
  summary: z.string().max(4_000).default(''),
  mediaPath: z.string().max(300).nullable().default(null),
  previewPath: z.string().max(300).nullable().default(null),
  tagIds: z.array(z.string().uuid()).default([])
})
export type RecordDraft = z.infer<typeof recordDraftSchema>

export const recordQuerySchema = z.object({
  search: z.string().max(200).default(''),
  carrier: recordCarrierSchema.nullable().default(null),
  tagId: z.string().uuid().nullable().default(null),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0)
})
export type RecordQuery = z.infer<typeof recordQuerySchema>

/** 导入一张图片：主进程负责复制、校验、返回文件名。 */
export const importImageResultSchema = z.object({
  fileName: z.string(),
  previewName: z.string().nullable(),
  width: z.number().int(),
  height: z.number().int(),
  byteSize: z.number().int(),
  sha256: z.string()
})
export type ImportImageResult = z.infer<typeof importImageResultSchema>
