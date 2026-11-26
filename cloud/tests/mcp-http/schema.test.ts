import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadDesktopToolDefinitions, type DesktopToolDefinition } from "../helpers/desktop-tools.js";
import { REMOTE_TOOLS, scopeForTool } from "../../src/mcp-http/tools.js";
import { MCP_SCOPES } from "../../src/mcp-oauth/constants.js";

/**
 * G. 工具面 schema 一致性（Phase 1.3.2，任务书 §6.1、设计 §11.2 #5 / §12 K 组）。
 *
 * Cloud 侧的 8 个工具定义与 Desktop `TOOL_DEFINITIONS` **深度一致**：
 * name / description 逐字符、input schema 用 `z.toJSONSchema` 结构深比较、
 * scope 映射逐项、数量恰为 8、无重复、无写工具、无额外工具、
 * arguments schema 不含任何身份字段。
 *
 * 这不是「抄一遍就算」——两侧会被本文件逐字段钉死，任何一侧漂移即转红。
 */

const SELECTED = [
  "search_records",
  "get_record",
  "list_record_tags",
  "list_beans",
  "list_brews",
  "list_tastings",
  "list_canvases",
  "get_canvas",
] as const;

const SELECTED_SET = new Set<string>(SELECTED);

/** Desktop 权威定义（运行时加载，见 helpers/desktop-tools.ts）。 */
let TOOL_DEFINITIONS: Record<string, DesktopToolDefinition>;

beforeAll(async () => {
  TOOL_DEFINITIONS = await loadDesktopToolDefinitions();
});

describe("Cloud / Desktop 八个工具深度一致", () => {
  it("数量恰为 8、名称唯一、与权威清单完全相同", () => {
    expect(REMOTE_TOOLS).toHaveLength(8);
    const names = REMOTE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(8);
    expect(new Set(names)).toEqual(SELECTED_SET);
    // 顺序也一致（tools/list 的呈现顺序）。
    expect(names).toEqual([...SELECTED]);
  });

  it("每个工具的 description 与 input schema 与 Desktop 逐字段相等", () => {
    for (const tool of REMOTE_TOOLS) {
      const desktop = TOOL_DEFINITIONS[tool.name];
      if (!desktop) throw new Error(`Desktop definition missing for ${tool.name}`);
      // 描述逐字符（描述是 AI 选择工具的唯一依据，改一个词都是行为变化）。
      expect(tool.description, tool.name).toBe(desktop.description);
      // input schema 结构深相等（zod v4 → JSON Schema，两侧同一转换）。
      expect(z.toJSONSchema(tool.input), tool.name).toEqual(z.toJSONSchema(desktop.input));
    }
  });

  it("scope 映射与 Desktop 一致，且全部属于 MCP_SCOPES", () => {
    for (const tool of REMOTE_TOOLS) {
      const desktop = TOOL_DEFINITIONS[tool.name];
      if (!desktop) throw new Error(`Desktop definition missing for ${tool.name}`);
      expect(tool.scope, tool.name).toBe(desktop.scope);
      expect(MCP_SCOPES, tool.name).toContain(tool.scope);
      expect(scopeForTool(tool.name), tool.name).toBe(desktop.scope);
    }
    // 设计 §5.8 的映射表逐项复核（防止两侧「一致地改错」）。
    expect(scopeForTool("search_records")).toBe("records:read");
    expect(scopeForTool("get_record")).toBe("records:read");
    expect(scopeForTool("list_record_tags")).toBe("tags:read");
    expect(scopeForTool("list_beans")).toBe("coffee:read");
    expect(scopeForTool("list_brews")).toBe("coffee:read");
    expect(scopeForTool("list_tastings")).toBe("coffee:read");
    expect(scopeForTool("list_canvases")).toBe("canvas:read");
    expect(scopeForTool("get_canvas")).toBe("canvas:read");
    expect(scopeForTool("no_such_tool")).toBeUndefined();
  });

  it("不包含任何写工具，也不额外开放其它读工具", () => {
    for (const [name, def] of Object.entries(TOOL_DEFINITIONS)) {
      if (def.write) {
        // 写工具必须全部缺席（开放写工具需要 DPoP / nonce，OQ-16）。
        expect(SELECTED_SET.has(name), name).toBe(false);
      }
    }
    // 显式点名禁止暴露的写工具。
    for (const banned of ["create_record", "update_record", "create_tag", "create_canvas", "create_canvas_note"]) {
      expect(SELECTED_SET.has(banned)).toBe(false);
      expect(REMOTE_TOOLS.map((t) => t.name)).not.toContain(banned);
    }
    // Desktop 的其它读工具（get_bean / get_coffee_summary / work_context 等）
    // 也不在本阶段的 8 个之内——「不为凑数量额外开放」。
    for (const extra of ["get_bean", "get_coffee_summary", "get_work_context"]) {
      expect(SELECTED_SET.has(extra)).toBe(false);
    }
  });

  it("arguments schema 不含任何身份字段（userId 等只能来自 JWT sub）", () => {
    for (const tool of REMOTE_TOOLS) {
      const json = z.toJSONSchema(tool.input) as { properties?: Record<string, unknown> };
      for (const key of Object.keys(json.properties ?? {})) {
        expect(key, `${tool.name}.${key}`).not.toMatch(/user_?id|identity|grant_?id|session_?id|jti/i);
      }
    }
  });

  it("Desktop 权威定义里这 8 个全部是只读（write=false）", () => {
    for (const name of SELECTED) {
      const desktop = TOOL_DEFINITIONS[name];
      if (!desktop) throw new Error(`Desktop definition missing for ${name}`);
      expect(desktop.write, name).toBe(false);
    }
  });
});
