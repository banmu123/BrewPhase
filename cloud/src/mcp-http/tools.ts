import { z } from "zod";
import type { McpScope } from "../mcp-oauth/constants.js";

/**
 * Remote MCP 的**只读工具面**（Phase 1.3.2，设计 §5.8）。
 *
 * ## 唯一事实来源与一致性
 *
 * 本文件的 name / description / input schema 必须与 Desktop 的
 * `Desktop/src/shared/mcp/tool-schemas.ts`（`TOOL_DEFINITIONS`）**深度一致**。
 * 这不是「抄一遍就算」——`tests/mcp-http/schema.test.ts` 会直接 import
 * Desktop 的权威定义，对两侧做逐字段比较（描述逐字符、`z.toJSONSchema`
 * 结构深比较、scope 映射逐项、数量恰为 8）。任何一侧漂移都会让测试转红。
 *
 * 为什么 Cloud 不能直接 import Desktop 的模块：Cloud 是独立 pnpm 项目、
 * 独立构建（`tsc -p tsconfig.build.json` 只编译 `cloud/src`），跨项目 import
 * 会让生产构建依赖 Desktop 源码。因此这里维护**受测试约束的副本**。
 *
 * ## 只读纪律
 *
 * 本阶段只开放 8 个只读工具：`create_record` / `update_record` /
 * `create_canvas` 等写工具**不得**出现在这里——写工具需要发送者约束
 * （DPoP / per-request nonce，安全 §3.2.1 OQ-16）才能开放。
 */

const uuid = z.string().uuid();

const recordPage = {
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
};

const coffeePage = {
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
};

/** 一个 Remote MCP 只读工具的完整定义。 */
export interface RemoteToolDefinition {
  readonly name: string;
  /** 执行该工具所需的最小 scope（§5.8 表）。 */
  readonly scope: McpScope;
  readonly description: string;
  readonly input: z.ZodObject<z.ZodRawShape>;
}

/**
 * 8 个只读工具，顺序即 `tools/list` 的返回顺序。
 *
 * scope 映射（设计 §5.8，与 Desktop `TOOL_DEFINITIONS[...].scope` 一致）：
 * `records:read` → search_records / get_record；`tags:read` → list_record_tags；
 * `coffee:read` → list_beans / list_brews / list_tastings；
 * `canvas:read` → list_canvases / get_canvas。
 */
export const REMOTE_TOOLS: readonly RemoteToolDefinition[] = [
  {
    name: "search_records",
    scope: "records:read",
    description:
      "Search the user's BrewPhase records (articles, links, images, videos, text notes). " +
      "Matches title, body, note, source/author/summary, URL, and desktop-fetched metadata. " +
      "Returns summaries; use get_record for full content.",
    input: z.object({
      search: z.string().max(200).optional().describe("Free-text query matched against record fields"),
      carrier: z.enum(["link", "image", "video", "text"]).optional().describe("Filter by record carrier type"),
      tag_id: uuid.optional().describe("Only records carrying this tag id"),
      ...recordPage,
    }),
  },
  {
    name: "get_record",
    scope: "records:read",
    description:
      "Read one record in full: title, body, note, URL, provider, tags, metadata, timestamps.",
    input: z.object({ record_id: uuid }),
  },
  {
    name: "list_record_tags",
    scope: "tags:read",
    description:
      "List all record tags with their ids, so records can be filtered or tagged by id.",
    input: z.object({}),
  },
  {
    name: "list_beans",
    scope: "coffee:read",
    description:
      "List coffee beans with stock, roast level and roast date. days_since_roast is derived from roast_date; " +
      "null when the roast date is unknown (never invented).",
    input: z.object({
      status: z.enum(["active", "finished"]).optional(),
      ...coffeePage,
    }),
  },
  {
    name: "list_brews",
    scope: "coffee:read",
    description: "List brews (recipe parameters, scores, flavor tags). Read-only in V1.",
    input: z.object({
      bean_id: uuid.optional(),
      since_ms: z.number().int().optional().describe("Only brews at or after this epoch-millisecond timestamp"),
      ...coffeePage,
    }),
  },
  {
    name: "list_tastings",
    scope: "coffee:read",
    description: "List tastings. Read-only in V1.",
    input: z.object({
      bean_id: uuid.optional(),
      since_ms: z.number().int().optional(),
      ...coffeePage,
    }),
  },
  {
    name: "list_canvases",
    scope: "canvas:read",
    description: "List canvases with node and note counts.",
    input: z.object({}),
  },
  {
    name: "get_canvas",
    scope: "canvas:read",
    description:
      "Read one canvas: record nodes (with record summaries and positions), notes, and stroke metadata " +
      "(no point data, no file paths).",
    input: z.object({ canvas_id: uuid }),
  },
] as const;

const BY_NAME = new Map(REMOTE_TOOLS.map((tool) => [tool.name, tool]));

/** 工具名 → 所需 scope；未知工具名返回 `undefined`（调用方 fail-closed）。 */
export function scopeForTool(tool: string): McpScope | undefined {
  return BY_NAME.get(tool)?.scope;
}

export function isRemoteTool(tool: string): boolean {
  return BY_NAME.has(tool);
}

/** 按有效 scope 过滤 `tools/list` 返回的子集（无 scope → 空数组，不是 403）。 */
export function toolsForScopes(scopes: readonly string[]): RemoteToolDefinition[] {
  const granted = new Set(scopes);
  return REMOTE_TOOLS.filter((tool) => granted.has(tool.scope));
}
