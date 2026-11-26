import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, computeRequestHash } from "../../src/link/request-hash.js";
import { computeDeadline } from "../../src/link/forwarder.js";
import {
  REMOTE_ERROR_CODES,
  REMOTE_HARD_DEADLINE_MS,
  REMOTE_TOOL_BUDGET_MS,
  REMOTE_TOOL_SCOPES,
  REMOTE_TOOLS,
  filterScopes,
  isRemoteTool,
  isRetryableRemoteError,
  scopeForTool,
} from "../../src/link/schemas.js";

/**
 * 请求内容指纹的**纯**单元测试（协议运行时 §8.2）。
 *
 * 最重要的不是「我的实现能算出一个哈希」，而是**它与 Desktop 算的是同一个**。
 * 所以整组围绕 `fixtures/remote-mcp/req-v1.json` 走：两端读同一份向量，
 * 对同一串字节得出同一个结果，才算兼容。
 */

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "remote-mcp",
  "req-v1.json",
);

interface ReqFixture {
  protocol: string;
  cases: Array<{
    name: string;
    input: { v: number; tool: string; arguments: unknown };
    canonical: string;
    request_hash: string;
  }>;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ReqFixture;

describe("request_hash 黄金向量（与 Desktop 共用一份）", () => {
  it("fixture 本身是可用的（协议名 + 至少 6 条用例）", () => {
    expect(fixture.protocol).toBe("brewphase.remote.req.v1");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(6);
  });

  for (const testCase of fixture.cases) {
    it(`${testCase.name}：规范串与哈希逐字节一致`, () => {
      expect(canonicalJson(testCase.input)).toBe(testCase.canonical);
      expect(computeRequestHash(testCase.input)).toBe(testCase.request_hash);
    });
  }

  it("哈希带 `sha256:` 前缀（协议 §8.2）", () => {
    for (const testCase of fixture.cases) {
      expect(testCase.request_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

describe("canonicalJson 的五条规则", () => {
  it("对象键排序与书写顺序无关：两种写法同哈希", () => {
    const a = computeRequestHash({ v: 1, tool: "search_records", arguments: { b: 1, a: 2 } });
    const b = computeRequestHash({ v: 1, tool: "search_records", arguments: { a: 2, b: 1 } });
    expect(a).toBe(b);
  });

  it("`undefined` 的键被剔除，等价于没写这个键", () => {
    // JSON 表达不了 undefined，所以只能在代码里断言——而它恰恰是最容易
    // 被实现成 `"a":null` 的一条。
    const withUndefined = computeRequestHash({
      v: 1,
      tool: "search_records",
      arguments: { a: 1, b: undefined },
    });
    const without = computeRequestHash({ v: 1, tool: "search_records", arguments: { a: 1 } });
    expect(withUndefined).toBe(without);
    // 而显式的 null 是**不同的**内容，不能与「没传」合并。
    const withNull = computeRequestHash({ v: 1, tool: "search_records", arguments: { a: 1, b: null } });
    expect(withNull).not.toBe(without);
  });

  it("数组保序：[3,1,2] 与 [1,2,3] 不同", () => {
    const one = computeRequestHash({ v: 1, tool: "search_records", arguments: { ids: [3, 1, 2] } });
    const two = computeRequestHash({ v: 1, tool: "search_records", arguments: { ids: [1, 2, 3] } });
    expect(one).not.toBe(two);
  });

  it("不做 Unicode 归一化：NFC 与 NFD 的 é 是两份内容", () => {
    const nfc = computeRequestHash({ v: 1, tool: "search_records", arguments: { s: "\u00e9" } });
    const nfd = computeRequestHash({ v: 1, tool: "search_records", arguments: { s: "e\u0301" } });
    expect(nfc).not.toBe(nfd);
  });

  it("数组里的 undefined 变成 null（与对象不同），长度不变", () => {
    // JSON.stringify 的行为就是如此；显式断言是为了防止有人「顺手统一」。
    expect(canonicalJson({ a: [1, undefined, 3] })).toBe('{"a":[1,null,3]}');
  });

  it("工具名与版本都在指纹里：改任一项都换哈希", () => {
    const base = computeRequestHash({ v: 1, tool: "search_records", arguments: { a: 1 } });
    expect(computeRequestHash({ v: 2, tool: "search_records", arguments: { a: 1 } })).not.toBe(base);
    expect(computeRequestHash({ v: 1, tool: "list_beans", arguments: { a: 1 } })).not.toBe(base);
  });

  it("深嵌套也稳定（同结构不同书写顺序同哈希）", () => {
    const a = canonicalJson({ x: { z: [1, { b: 2, a: 1 }], y: null } });
    const b = canonicalJson({ x: { y: null, z: [1, { a: 1, b: 2 }] } });
    expect(a).toBe(b);
  });
});

describe("deadline 预算（协议运行时 §7.2）", () => {
  const now = 1_800_000_000_000;

  it("默认 15 秒", () => {
    expect(computeDeadline({ nowMs: now })).toBe(now + REMOTE_TOOL_BUDGET_MS);
  });

  it("硬上限 30 秒：工具预算被调大也压到 30 秒", () => {
    expect(computeDeadline({ nowMs: now, toolBudgetMs: 120_000 })).toBe(now + REMOTE_HARD_DEADLINE_MS);
  });

  it("clientDeadline 只能收紧，不能延长", () => {
    expect(computeDeadline({ nowMs: now, clientDeadline: now + 1_000 })).toBe(now + 1_000);
    // 客户端的 60 秒不该让 Cloud 多等：仍然取 15 秒。
    expect(computeDeadline({ nowMs: now, clientDeadline: now + 60_000 })).toBe(
      now + REMOTE_TOOL_BUDGET_MS,
    );
  });

  it("clientDeadline 早于现在 → 原样返回（调用方据此立刻超时）", () => {
    expect(computeDeadline({ nowMs: now, clientDeadline: now - 5 })).toBe(now - 5);
  });
});

describe("工具面与 scope 映射", () => {
  it("8 个工具，且每个都有 scope 映射（没有漏项）", () => {
    expect(REMOTE_TOOLS).toHaveLength(8);
    for (const tool of REMOTE_TOOLS) {
      expect(scopeForTool(tool)).toBe(REMOTE_TOOL_SCOPES[tool]);
      expect(isRemoteTool(tool)).toBe(true);
    }
  });

  it("未知工具返回 null 且不是远程工具", () => {
    expect(scopeForTool("delete_record")).toBeNull();
    expect(isRemoteTool("delete_record")).toBe(false);
  });

  it("filterScopes 丢弃未知 scope 但保留合法项（不让整条 grant 失效）", () => {
    expect(filterScopes(["records:read", "admin:write", "coffee:read"])).toEqual([
      "records:read",
      "coffee:read",
    ]);
  });

  it("filterScopes 去重并保留输入顺序（顺序不参与授权语义）", () => {
    // 刻意不断言「按 REMOTE_SCOPES 排序」：scope 数组的顺序在两端都不参与
    // 判定（Desktop 的 `effectiveScopes` 自己按本地白名单过滤），钉死顺序
    // 只会让一次无害的重排变成红。
    expect(filterScopes(["coffee:read", "records:read", "coffee:read"])).toEqual([
      "coffee:read",
      "records:read",
    ]);
  });

  it("19 个错误码，且只有 4 个可重试", () => {
    expect(REMOTE_ERROR_CODES).toHaveLength(19);
    const retryable = REMOTE_ERROR_CODES.filter((code) => isRetryableRemoteError(code));
    expect(retryable.sort()).toEqual(["DEVICE_BUSY", "DEVICE_OFFLINE", "INTERNAL_ERROR", "REQUEST_TIMEOUT"]);
  });
});
