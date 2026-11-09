import { z } from 'zod'
import type { McpScope } from '../contracts/mcp'

/**
 * MCP 工具清单的**唯一事实来源**。
 *
 * - MCP STDIO Server 用 `TOOL_DEFINITIONS` 注册工具（描述 + 参数 schema）；
 * - Main 的 Bridge 路由用同一份 schema 做第二次校验（MCP 进程不可信）；
 * - 工具 → scope 映射也在这里，权限检查在 Main 执行。
 *
 * 参数命名面向 AI：snake_case、单位明确的毫秒、UUID。内部实体字段的
 * camelCase 映射只发生在 Application Service 里。
 */

const uuid = z.string().uuid()
const idempotencyKey = z.string().min(1).max(200)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)

const recordPage = {
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional()
}

const coffeePage = {
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional()
}

export type ToolDefinition = {
  /** Main 端执行前必须命中的 scope。 */
  scope: McpScope
  /** 是否写操作——写操作进审计表，并且要求幂等键（若 schema 含该字段）。 */
  write: boolean
  description: string
  input: z.ZodObject<z.ZodRawShape>
}

export const TOOL_DEFINITIONS = {
  search_records: {
    scope: 'records:read',
    write: false,
    description:
      'Search the user\'s BrewPhase records (articles, links, images, videos, text notes). ' +
      'Matches title, body, note, source/author/summary, URL, and desktop-fetched metadata. ' +
      'Returns summaries; use get_record for full content.',
    input: z.object({
      search: z.string().max(200).optional().describe('Free-text query matched against record fields'),
      carrier: z.enum(['link', 'image', 'video', 'text']).optional().describe('Filter by record carrier type'),
      tag_id: uuid.optional().describe('Only records carrying this tag id'),
      ...recordPage
    })
  },

  get_record: {
    scope: 'records:read',
    write: false,
    description: 'Read one record in full: title, body, note, URL, provider, tags, metadata, timestamps.',
    input: z.object({ record_id: uuid })
  },

  list_record_tags: {
    scope: 'tags:read',
    write: false,
    description: 'List all record tags with their ids, so records can be filtered or tagged by id.',
    input: z.object({})
  },

  create_record: {
    scope: 'records:create',
    write: true,
    description:
      'Create a text or link record. For links the platform (YouTube/Bilibili/X/GitHub/generic) is detected ' +
      'by BrewPhase — do not provide provider or canonical fields. Media upload is not supported in V1.',
    input: z.object({
      carrier: z.enum(['link', 'text']),
      title: z.string().max(500).optional(),
      note: z.string().max(20_000).optional().describe('Free-form body / personal note'),
      url: z.string().max(2_000).optional().describe('Required for carrier=link, must be a valid http(s) URL'),
      tag_ids: z.array(uuid).max(20).optional(),
      idempotency_key: idempotencyKey.describe('Stable key so a retried create does not duplicate the record')
    })
  },

  update_record: {
    scope: 'records:update',
    write: true,
    description:
      'Update title/note/url/tags of an existing record. Requires expected_updated_at (epoch ms) read from ' +
      'get_record; a mismatch returns STALE_RECORD — re-read, then retry. Cannot change carrier or media.',
    input: z.object({
      record_id: uuid,
      expected_updated_at: z.number().int(),
      patch: z
        .object({
          title: z.string().max(500).optional().describe('Empty string clears the title'),
          note: z.string().max(20_000).optional().describe('Empty string clears the note'),
          url: z.string().max(2_000).optional().describe('New URL; old fetched metadata is invalidated'),
          tag_ids: z.array(uuid).max(20).optional().describe('Replaces the full tag set')
        })
        .refine((value) => Object.keys(value).length > 0, { message: 'patch must contain at least one field' })
    })
  },

  create_tag: {
    scope: 'tags:create',
    write: true,
    description: 'Create a tag (1–40 chars). An existing tag with the same name is returned instead of duplicated.',
    input: z.object({ name: z.string().trim().min(1).max(40) })
  },

  list_beans: {
    scope: 'coffee:read',
    write: false,
    description:
      'List coffee beans with stock, roast level and roast date. days_since_roast is derived from roast_date; ' +
      'null when the roast date is unknown (never invented).',
    input: z.object({
      status: z.enum(['active', 'finished']).optional(),
      ...coffeePage
    })
  },

  get_bean: {
    scope: 'coffee:read',
    write: false,
    description: 'Read one bean with its brew/tasting counts and recent brews.',
    input: z.object({ bean_id: uuid })
  },

  list_brews: {
    scope: 'coffee:read',
    write: false,
    description: 'List brews (recipe parameters, scores, flavor tags). Read-only in V1.',
    input: z.object({
      bean_id: uuid.optional(),
      since_ms: z.number().int().optional().describe('Only brews at or after this epoch-millisecond timestamp'),
      ...coffeePage
    })
  },

  list_tastings: {
    scope: 'coffee:read',
    write: false,
    description: 'List tastings. Read-only in V1.',
    input: z.object({
      bean_id: uuid.optional(),
      since_ms: z.number().int().optional(),
      ...coffeePage
    })
  },

  get_coffee_summary: {
    scope: 'coffee:read',
    write: false,
    description: 'Aggregate overview: bean/brew/tasting counts, brews in the last 30 days, average tasting score.',
    input: z.object({})
  },

  list_canvases: {
    scope: 'canvas:read',
    write: false,
    description: 'List canvases with node and note counts.',
    input: z.object({})
  },

  get_canvas: {
    scope: 'canvas:read',
    write: false,
    description:
      'Read one canvas: record nodes (with record summaries and positions), notes, and stroke metadata ' +
      '(no point data, no file paths).',
    input: z.object({ canvas_id: uuid })
  },

  create_canvas: {
    scope: 'canvas:write',
    write: true,
    description: 'Create an empty canvas.',
    input: z.object({
      name: z.string().trim().min(1).max(120),
      note: z.string().max(2_000).optional(),
      idempotency_key: idempotencyKey
    })
  },

  add_record_to_canvas: {
    scope: 'canvas:write',
    write: true,
    description:
      'Place an existing record on a canvas. BrewPhase computes the initial position. Adding the same record ' +
      'to the same canvas again returns the existing node instead of duplicating it.',
    input: z.object({
      canvas_id: uuid,
      record_id: uuid,
      annotation: z.string().max(2_000).optional(),
      idempotency_key: idempotencyKey
    })
  },

  create_canvas_note: {
    scope: 'canvas:write',
    write: true,
    description:
      'Create a sticky note on a canvas. BrewPhase picks a free position — do not provide coordinates.',
    input: z.object({
      canvas_id: uuid,
      title: z.string().trim().min(1).max(200),
      body: z.string().max(10_000),
      color: color.optional().describe('Hex like #f6f2df'),
      idempotency_key: idempotencyKey
    })
  },

  update_canvas_note: {
    scope: 'canvas:write',
    write: true,
    description:
      'Update a note\'s title/body/color. Requires expected_updated_at (epoch ms) from get_canvas; ' +
      'a mismatch returns STALE_RECORD.',
    input: z.object({
      note_id: uuid,
      expected_updated_at: z.number().int(),
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().max(10_000).optional(),
      color: color.optional()
    })
  },

  annotate_canvas_node: {
    scope: 'canvas:write',
    write: true,
    description: 'Set the annotation (short note) on a canvas node.',
    input: z.object({
      node_id: uuid,
      annotation: z.string().max(2_000)
    })
  }
} satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof TOOL_DEFINITIONS

export const TOOL_NAMES = Object.keys(TOOL_DEFINITIONS) as ToolName[]

export function toolScope(tool: string): McpScope | null {
  return tool in TOOL_DEFINITIONS ? TOOL_DEFINITIONS[tool as ToolName].scope : null
}
