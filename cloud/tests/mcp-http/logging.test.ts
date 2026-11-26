import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  createMcpHttpHarness,
  jsonBody,
  modernEnvelope,
  modernRequest,
  obtainMcpBearer,
  type McpHttpHarness,
} from "../helpers/mcp-http.js";

/**
 * F. 日志纪律与 `jti` 语义（Phase 1.3.2，任务书 §九、安全 §3.2.1、生命周期 §15.2）。
 *
 * - 允许字段只有：tool / status / durationMs / errorCode / `jti` 前 8 位 /
 *   grantId——用**哨兵值**跑一次真实调用，然后对**全部捕获日志**做 0 命中断言；
 * - `jti` 是 **token 级**标识：同一枚 Access Token 连续 10 次 `tools/call`
 *   必须全部成功——任何「按 jti 去重」的实现都会在这里变红。
 */

const handle = await getTestDb();

let h: McpHttpHarness;

const ARGS_SENTINEL = "SENTINEL_ARGS_7c1f9a4e_do_not_log";
const RESULT_SENTINEL = "SENTINEL_RESULT_b83d21f0_do_not_log";

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  h = await createMcpHttpHarness();
});

afterAll(async () => {
  await closeTestDb();
});

function jtiOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as {
    jti?: string;
  };
  if (!payload.jti) throw new Error("token has no jti");
  return payload.jti;
}

function call(token: string, args: Record<string, unknown>): Request {
  return modernRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_records", arguments: args, _meta: modernEnvelope() },
    },
    { token, mcpName: "search_records" },
  );
}

describe("日志哨兵（0 命中）", () => {
  it("token / arguments / 结果正文 / 完整 jti 都不进日志", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    const jti = jtiOf(bearer.accessToken);
    expect(jti.length).toBeGreaterThan(8);

    // 派发结果里埋第二个哨兵（结果正文同样不得入日志）。
    h.link.setDispatch(() => ({
      ok: true,
      data: { items: [{ title: RESULT_SENTINEL }] },
      meta: { duration_ms: 3, cached: false },
    }));

    const res = await h.app.request(
      call(bearer.accessToken, { search: ARGS_SENTINEL, limit: 10 }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    // 结果确实回到了客户端（日志不记 ≠ 响应不给）。
    expect(JSON.stringify(body)).toContain(RESULT_SENTINEL);

    const all = JSON.stringify(h.logs);
    expect(all.length).toBeGreaterThan(0); // 确实有日志可查（不是没记所以0命中）
    // 0 命中：完整 token、参数、结果、完整 jti、Bearer 头。
    expect(all).not.toContain(bearer.accessToken);
    expect(all).not.toContain(jti);
    expect(all).not.toContain(ARGS_SENTINEL);
    expect(all).not.toContain(RESULT_SENTINEL);
    expect(all).not.toContain("Bearer ");
    // 也不允许出现任何敏感字段名。
    for (const entry of h.logs) {
      for (const key of Object.keys(entry.fields)) {
        expect(key).not.toMatch(/token|authorization|cookie|secret|password|verifier/i);
      }
    }

    // 正面断言：允许字段确实在（jti 只有前 8 位）。
    const toolLogs = h.logs.filter((l) => l.message === "mcp_tool_call");
    expect(toolLogs).toHaveLength(1);
    const fields = toolLogs[0]!.fields as Record<string, unknown>;
    expect(fields.tool).toBe("search_records");
    expect(fields.status).toBe("ok");
    expect(typeof fields.durationMs).toBe("number");
    expect(typeof fields.grantId).toBe("string");
    expect(fields.jti).toBe(jti.slice(0, 8));
    expect(String(fields.jti)).toHaveLength(8);
    expect(fields).not.toHaveProperty("arguments");
    expect(fields).not.toHaveProperty("result");
  });

  it("失败调用的日志只带 errorCode（不含 token / 参数）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });
    h.link.setDispatch(() => ({
      ok: false,
      error: { code: "GRANT_REVOKED", message: "revoked", retryable: false },
    }));
    const res = await h.app.request(call(bearer.accessToken, { search: ARGS_SENTINEL }));
    expect(res.status).toBe(200); // 工具级 isError

    const toolLogs = h.logs.filter((l) => l.message === "mcp_tool_call");
    expect(toolLogs).toHaveLength(1);
    const fields = toolLogs[0]!.fields as Record<string, unknown>;
    expect(fields.status).toBe("error");
    expect(fields.errorCode).toBe("GRANT_REVOKED");
    const all = JSON.stringify(h.logs);
    expect(all).not.toContain(ARGS_SENTINEL);
    expect(all).not.toContain(bearer.accessToken);
  });
});

describe("jti 是 token 级标识（P0-2 / ST-25 回归）", () => {
  it("同一枚 Access Token 连续 10 次 tools/call 全部成功（绝不按 jti 去重）", async () => {
    const bearer = await obtainMcpBearer(h, { scope: "records:read" });

    for (let i = 0; i < 10; i += 1) {
      const res = await h.app.request(call(bearer.accessToken, { limit: i + 1 }));
      expect(res.status, `call #${i + 1}`).toBe(200);
      const body = await jsonBody(res);
      expect((body.result as { isError?: boolean }).isError, `call #${i + 1}`).toBeUndefined();
    }

    expect(h.link.calls).toHaveLength(10); // 每次都真的派发了
    const toolLogs = h.logs.filter((l) => l.message === "mcp_tool_call");
    expect(toolLogs).toHaveLength(10);
    // 10 条日志的 jti 前缀完全相同（同一个 token），且都只有 8 位。
    const prefixes = new Set(toolLogs.map((l) => String(l.fields.jti)));
    expect(prefixes.size).toBe(1);
    expect([...prefixes][0]).toHaveLength(8);
    expect(JSON.stringify(h.logs)).not.toContain(jtiOf(bearer.accessToken));
  });
});
