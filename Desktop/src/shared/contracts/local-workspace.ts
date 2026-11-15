import { z } from 'zod'

/**
 * AI Card Workspace Bridge（Phase 1）：本地工作区 + 卡片绑定 + 文件上下文。
 *
 * **本地数据铁律**：工作区授权登记与卡片绑定只存本地库，不进 change_log、
 * 不进 iOS 同步协议——这是「这台机器授权过哪些文件夹」的本机事实。
 *
 * 渲染层只拿 DTO：`absolutePath` 用于展示（规格 §2.1 要求显示完整路径），
 * 但文件访问只能走 `workspaceId + relativePath`——不接受渲染层传任意绝对路径。
 */

export const LOCAL_WORKSPACE_NAME_MAX = 80
/** 授权登记上限：这是人手维护的列表，不是目录扫描缓存。 */
export const LOCAL_WORKSPACE_MAX = 16

/** 单目录列表条目上限（超出 truncated=true）。 */
export const WORKSPACE_LIST_LIMIT = 500
/** 单文件最大读取字节数（UTF-8 解码前）。 */
export const WORKSPACE_FILE_MAX_BYTES = 512 * 1024
/** 单文件进入上下文的最大字符数（超出截断并提示）。 */
export const WORKSPACE_FILE_MAX_CHARS = 64_000
/** 上下文总字符上限。 */
export const CONTEXT_TOTAL_CHAR_LIMIT = 200_000
/** 上下文最多文件数。 */
export const CONTEXT_MAX_FILES = 20
/** 文件名搜索的结果上限 / 遍历深度 / 参与匹配的文件数上限。 */
export const WORKSPACE_SEARCH_LIMIT = 50
export const WORKSPACE_SEARCH_MAX_DEPTH = 8
export const WORKSPACE_SEARCH_MAX_FILES = 2_000

const uuid = z.string().uuid()
/** 渲染层与主进程之间统一用 POSIX 分隔符表达相对路径。 */
export const relativePathSchema = z
  .string()
  .max(2_048)
  .refine((value) => !value.includes('\\') && !value.includes('\u0000'), 'invalid path')

export const localWorkspaceAvailabilitySchema = z.enum(['available', 'missing'])
export type LocalWorkspaceAvailability = z.infer<typeof localWorkspaceAvailabilitySchema>

export const localWorkspaceSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(LOCAL_WORKSPACE_NAME_MAX),
  /** 真实绝对路径（添加时已 realpath 规范化）。仅供展示，文件访问不走它。 */
  absolutePath: z.string().min(1).max(1_024),
  platform: z.string().max(16),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  availability: localWorkspaceAvailabilitySchema
})
export type LocalWorkspace = z.infer<typeof localWorkspaceSchema>

/**
 * 卡片绑定：tabId → workspaceId。`missing = true` 表示绑定指向的工作区
 * 已被删除授权（行还在、目标不在）——UI 显示「绑定失效」，可清除或换绑。
 */
export const cardWorkspaceBindingSchema = z.object({
  tabId: z.string().min(1).max(64),
  workspace: localWorkspaceSchema.nullable(),
  missing: z.boolean()
})
export type CardWorkspaceBinding = z.infer<typeof cardWorkspaceBindingSchema>

export const workspaceFileEntrySchema = z.object({
  name: z.string().max(512),
  /** POSIX 分隔的相对路径（不含工作区根前缀）。 */
  relativePath: relativePathSchema,
  kind: z.enum(['file', 'directory']),
  /** 字节；目录为 0。 */
  size: z.number().int().nonnegative(),
  /** 文本可读初判（类型与大小都过关）；目录恒 false。 */
  readable: z.boolean(),
  /** 敏感文件在列表阶段就被排除，不会出现；这里只给「可读但会被截断」预警。 */
  oversize: z.boolean()
})
export type WorkspaceFileEntry = z.infer<typeof workspaceFileEntrySchema>

export const workspaceFileListingSchema = z.object({
  workspaceId: uuid,
  /** 目录的相对路径；'' = 工作区根。 */
  relativePath: relativePathSchema,
  entries: z.array(workspaceFileEntrySchema).max(WORKSPACE_LIST_LIMIT),
  /** 条目数超过 WORKSPACE_LIST_LIMIT 时为 true（只显示前 N 条）。 */
  truncated: z.boolean()
})
export type WorkspaceFileListing = z.infer<typeof workspaceFileListingSchema>

export const workspaceFileContentSchema = z.object({
  workspaceId: uuid,
  relativePath: relativePathSchema,
  content: z.string(),
  truncated: z.boolean(),
  totalCharacters: z.number().int().nonnegative()
})
export type WorkspaceFileContent = z.infer<typeof workspaceFileContentSchema>

export const workspaceSearchResultSchema = z.object({
  workspaceId: uuid,
  query: z.string().min(1).max(200),
  entries: z.array(workspaceFileEntrySchema).max(WORKSPACE_SEARCH_LIMIT),
  /** 命中数超过 WORKSPACE_SEARCH_LIMIT 时为 true。 */
  truncated: z.boolean(),
  /** 遍历文件数达到上限提前停走时为 true（结果不含全部匹配）。 */
  incomplete: z.boolean()
})
export type WorkspaceSearchResult = z.infer<typeof workspaceSearchResultSchema>

export const contextFilePartSchema = z.object({
  relativePath: relativePathSchema,
  content: z.string(),
  truncated: z.boolean(),
  totalCharacters: z.number().int().nonnegative()
})
export type ContextFilePart = z.infer<typeof contextFilePartSchema>

/**
 * 结构化上下文包。**不含工作区绝对路径**——交给 AI 的内容里只有相对路径。
 * `formattedText` 是「复制到 AI 对话」时进剪贴板的最终文本。
 */
export const contextPackageSchema = z.object({
  workspaceId: uuid,
  workspaceName: z.string().max(LOCAL_WORKSPACE_NAME_MAX),
  selectedFiles: z.array(contextFilePartSchema).max(CONTEXT_MAX_FILES),
  totalCharacters: z.number().int().nonnegative(),
  truncated: z.boolean(),
  createdAt: z.number().int(),
  formattedText: z.string().max(CONTEXT_TOTAL_CHAR_LIMIT + 8_000)
})
export type ContextPackage = z.infer<typeof contextPackageSchema>
