import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  createMcpOAuthHarness,
  seedAuthorizeClient,
  type McpOAuthHarness,
} from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { decodeJwtPayload, exchangeCode, obtainAuthCode, readTokenResponse, type TokenResponse } from "../helpers/mcp-token.js";
import { signAccessToken } from "../../src/sessions/jwt.js";
import { signMcpAccessToken } from "../../src/mcp-oauth/tokens.js";
import { mcpRefreshTokenHash, revokeMcpSession } from "../../src/mcp-oauth/sessions.js";
import { mcpResourceFor } from "../../src/mcp-oauth/constants.js";

/**
 * `POST /mcp/oauth/revoke`（Phase 1.3.1-C3b）。
 *
 * 本阶段最核心的判据只有一条：**撤销的是 Session，不是 Grant**。
 * 因此 B 组用「同一个 Grant 下的两个 Session」来钉死它——如果实现图省事走了
 * `revokeMcpSessionsByGrant`，B 组会立刻转红。
 *
 * 其余的组围绕 RFC 7009 的两个反直觉点：
 * - 无效 Token 必须 200（否则端点成为存在性探针）；
 * - `token_type_hint` 只是提示（说 access_token 也必须能撤掉 refresh_token）。
 */

const handle = await getTestDb();
let h: McpOAuthHarness;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
  h = await createMcpOAuthHarness();
  await seedAuthorizeClient(handle);
});

afterAll(async () => {
  await closeTestDb();
});

/** 一次「授权码 → token」的完整兑换，返回 token 与 Session id。 */
async function issueTokens(
  clientId = "test-client",
): Promise<{ tokens: TokenResponse; sessionId: string; grantId: string; clientId: string }> {
  const code = await obtainAuthCode(h, { clientId });
  const tokens = await readTokenResponse(await exchangeCode(h, code));
  const claims = decodeJwtPayload(tokens.access_token);
  const sessionId = claims.sid as string;

  const rows = await handle.sql<{ grant_id: string }[]>`
    select grant_id from mcp_sessions where id = ${sessionId}`;
  return { tokens, sessionId, grantId: rows[0]!.grant_id, clientId };
}

/** 发一次撤销请求（标准 urlencoded）。 */
async function revoke(
  body: Record<string, string | undefined>,
  contentType = "application/x-www-form-urlencoded",
): Promise<Response> {
  const params = new URLSearchParams();
  // 默认带上 `test-client`（harness 里的默认注册客户端）；要测「缺 client_id」
  // 时显式传 `client_id: undefined`。
  for (const [key, value] of Object.entries({ client_id: "test-client", ...body })) {
    if (value !== undefined) params.set(key, value);
  }
  return h.app.request("/mcp/oauth/revoke", {
    method: "POST",
    headers: { "content-type": contentType },
    body: params.toString(),
  });
}

async function revokeRaw(body: string, contentType?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers["content-type"] = contentType ?? "application/x-www-form-urlencoded";
  return h.app.request("/mcp/oauth/revoke", { method: "POST", headers, body });
}

interface SessionRow {
  id: string;
  user_id: string;
  grant_id: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

async function sessions(): Promise<SessionRow[]> {
  return handle.sql<SessionRow[]>`
    select id, user_id, grant_id, revoked_at::text, revoked_reason
      from mcp_sessions order by created_at, id`;
}

async function sessionOf(sessionId: string): Promise<SessionRow> {
  const rows = await handle.sql<SessionRow[]>`
    select id, user_id, grant_id, revoked_at::text, revoked_reason
      from mcp_sessions where id = ${sessionId}`;
  const row = rows[0];
  if (!row) throw new Error(`session ${sessionId} not found`);
  return row;
}

async function auditCount(eventType: string): Promise<number> {
  const rows = await handle.sql<{ count: string }[]>`
    select count(*)::text as count from auth_events where event_type = ${eventType}`;
  return Number(rows[0]?.count ?? "0");
}

async function desktopTableCount(): Promise<number> {
  const rows = await handle.sql<{ count: string }[]>`
    select count(*)::text as count from auth_sessions`;
  return Number(rows[0]?.count ?? "0");
}

describe("协议面", () => {
  it("缺少 token → 400 invalid_request", async () => {
    const res = await revoke({ token_type_hint: "refresh_token" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("token 为空 → 400 invalid_request", async () => {
    const res = await revoke({ token: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("JSON / multipart → 400（只收 urlencoded）", async () => {
    for (const contentType of ["application/json", "multipart/form-data; boundary=x"]) {
      const res = await revokeRaw(JSON.stringify({ token: "x" }), contentType);
      expect(res.status, contentType).toBe(400);
      expect(((await res.json()) as { error: string }).error, contentType).toBe("invalid_request");
    }
  });

  it("重复 token / 重复 token_type_hint → 400", async () => {
    for (const body of [
      "token=a&token=b",
      "token=a&token_type_hint=refresh_token&token_type_hint=access_token",
    ]) {
      const res = await revokeRaw(body);
      expect(res.status, body).toBe(400);
      expect(((await res.json()) as { error: string }).error, body).toBe("invalid_request");
    }
  });

  it("超过 8 KiB → 拒绝（字段值本身合法，只是总量超限）", async () => {
    const parts = ["token=whatever"];
    for (let i = 0; i < 20; i += 1) parts.push(`pad${i}=${"p".repeat(500)}`);
    const body = parts.join("&");
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(8192);

    const res = await revokeRaw(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("token 字段超过 512 字符 → 拒绝", async () => {
    const res = await revoke({ token: "x".repeat(513) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("成功响应 200、空体、no-store + no-cache", async () => {
    const { tokens } = await issueTokens();
    const res = await revoke({ token: tokens.refresh_token });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("错误响应同样带 no-store + no-cache", async () => {
    const res = await revoke({ token: "" });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("不接受 Query 参数里的 token", async () => {
    // 只从表单取 token；query 里的值不参与判定，因此这里是「缺 token」。
    const res = await h.app.request("/mcp/oauth/revoke?token=abc", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("不读 bp_mcp_bs Cookie：带无效 Cookie 也能正常撤销", async () => {
    const { tokens } = await issueTokens();
    const res = await h.app.request("/mcp/oauth/revoke", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "bp_mcp_bs=forged.value",
      },
      body: new URLSearchParams({ token: tokens.refresh_token, client_id: "test-client" }).toString(),
    });
    expect(res.status).toBe(200);
  });
});

async function consumedAtOf(sessionId: string): Promise<Array<string | null>> {
  const rows = await handle.sql<{ consumed_at: string | null }[]>`
    select consumed_at::text from mcp_refresh_tokens
     where session_id = ${sessionId} order by generation`;
  return rows.map((row) => row.consumed_at);
}

async function grantsSnapshot() {
  return handle.sql<{ id: string; scopes: string[]; epoch: number; revoked_at: string | null }[]>`
    select id, scopes, epoch, revoked_at::text from mcp_grants order by id`;
}

describe("Query 中的 token 一律拒绝（C3b-R1）", () => {
  /** 打到带 query 的 revoke 端点。 */
  async function revokeVia(
    query: string,
    body: Record<string, string | undefined>,
  ): Promise<Response> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) params.set(key, value);
    }
    return h.app.request(`/mcp/oauth/revoke${query}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  }

  /**
   * 「Body 里有合法 Token 也不行」的统一验收：400 + 零副作用。
   *
   * 只断言状态码是不够的——一个「先撤销、再报错」的实现同样返回 400。
   */
  async function expectRejectedWithoutSideEffects(
    query: string,
    bodyToken: string,
    sessionId: string,
  ): Promise<void> {
    const grantsBefore = await grantsSnapshot();
    const consumedBefore = await consumedAtOf(sessionId);
    const sessionBefore = await sessionOf(sessionId);

    const res = await revokeVia(query, { token: bodyToken });
    expect(res.status, query).toBe(400);
    expect(((await res.json()) as { error: string }).error, query).toBe("invalid_request");

    const sessionAfter = await sessionOf(sessionId);
    expect(sessionAfter.revoked_at).toBeNull();
    // `revoked_reason` 也不能被改（有些实现只改 reason 不改 revoked_at）。
    expect(sessionAfter.revoked_reason).toBe(sessionBefore.revoked_reason);
    // 数组相等同时覆盖「消费状态」与「历史行数」。
    expect(await consumedAtOf(sessionId)).toEqual(consumedBefore);
    expect(await auditCount("mcp_session_revoked")).toBe(0);
    expect(await grantsSnapshot()).toEqual(grantsBefore);
    expect(await desktopTableCount()).toBe(0);
  }

  it("?token=abc + 空 Body → 400", async () => {
    const res = await revokeVia("?token=abc", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("?token=（空值）+ 空 Body → 400（空值也算「出现了」）", async () => {
    const res = await revokeVia("?token=", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("?token=a&token=b（重复）→ 400", async () => {
    const res = await revokeVia("?token=a&token=b", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("Query 带 token、Body 缺 token → 400（仍然拒绝，不回退到 Query）", async () => {
    const res = await revokeVia("?token=secret-in-url", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("Query 带 token + Body 是有效 Refresh Token → 400，且 Session 不受影响", async () => {
    const { tokens, sessionId } = await issueTokens();
    await expectRejectedWithoutSideEffects(
      "?token=secret-in-url",
      tokens.refresh_token,
      sessionId,
    );
  });

  it("Query 与 Body 的 token 相同 → 400，且不撤销", async () => {
    const { tokens, sessionId } = await issueTokens();
    await expectRejectedWithoutSideEffects(
      `?token=${encodeURIComponent(tokens.refresh_token)}`,
      tokens.refresh_token,
      sessionId,
    );
  });

  it("Query 与 Body 的 token 不同 → 400，且不撤销（Body 的合法值也不被采用）", async () => {
    const { tokens, sessionId } = await issueTokens();
    await expectRejectedWithoutSideEffects("?token=another-value", tokens.refresh_token, sessionId);
  });

  it("Query 的 token 为空值、Body 有效 → 400，且不撤销", async () => {
    const { tokens, sessionId } = await issueTokens();
    // 「空值就等于没传」是常见的放行借口：这里钉死它不成立。
    await expectRejectedWithoutSideEffects("?token=", tokens.refresh_token, sessionId);
  });

  it("Query 的 token 重复、Body 有效 → 400，且不撤销", async () => {
    const { tokens, sessionId } = await issueTokens();
    // 重复出现往往被解析器「取第一个/最后一个」消化掉；这里要求整单拒绝。
    await expectRejectedWithoutSideEffects("?token=a&token=b", tokens.refresh_token, sessionId);
  });

  it("拒绝发生在解析之前：错误体 / 日志 / 审计都不含哨兵值", async () => {
    const SENTINEL = "QUERY-TOKEN-SENTINEL-2026";
    const { tokens, sessionId } = await issueTokens();

    const captured: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(" "));
      }),
    );

    let bodyText = "";
    try {
      const res = await revokeVia(`?token=${SENTINEL}`, { token: tokens.refresh_token });
      expect(res.status).toBe(400);
      bodyText = await res.text();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(bodyText).not.toContain(SENTINEL);
    // 连哈希都不该出现（说明根本没走到哈希计算这一步）。
    expect(bodyText).not.toContain(mcpRefreshTokenHash(h.env.sessionTokenPepper, SENTINEL));
    expect(bodyText).not.toContain(tokens.refresh_token);

    const logs = captured.join("\n");
    expect(logs).not.toContain(SENTINEL);
    expect(logs).not.toContain(tokens.refresh_token);

    expect(await auditCount("mcp_session_revoked")).toBe(0);
    expect((await sessionOf(sessionId)).revoked_at).toBeNull();
  });

  it("错误响应仍然带 no-store / no-cache", async () => {
    const res = await revokeVia("?token=abc", {});
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });
});

describe("client_id 必填（C3b-R2）", () => {
  it("缺少 client_id → 400 invalid_request", async () => {
    const { tokens } = await issueTokens();
    const res = await revoke({ token: tokens.refresh_token, client_id: undefined });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("client_id 为空 → 400 invalid_request", async () => {
    const { tokens } = await issueTokens();
    const res = await revoke({ token: tokens.refresh_token, client_id: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("重复 client_id → 400 invalid_request（不挑一个）", async () => {
    const { tokens } = await issueTokens();
    const body = `token=${encodeURIComponent(tokens.refresh_token)}&client_id=test-client&client_id=other-client`;
    const res = await h.app.request("/mcp/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("client_id 超过 512 字符 → 400（复用统一字段限长）", async () => {
    const { tokens } = await issueTokens();
    const res = await revoke({ token: tokens.refresh_token, client_id: "c".repeat(513) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("合法 client_id → 正常撤销", async () => {
    const { tokens, sessionId } = await issueTokens();
    const res = await revoke({ token: tokens.refresh_token, client_id: "test-client" });
    expect(res.status).toBe(200);
    expect((await sessionOf(sessionId)).revoked_at).not.toBeNull();
  });
});

describe("Refresh Token 的客户端归属（C3b-R2）", () => {
  /**
   * 「错误 client 不能撤销别人的 Session」的统一验收。
   *
   * 只断言 401 不够：一个「先撤销、再报 401」的实现同样返回 401。
   */
  async function expectClientMismatch(
    claimedClientId: string,
    token: string,
    sessionId: string,
  ): Promise<void> {
    const grantsBefore = await grantsSnapshot();
    const consumedBefore = await consumedAtOf(sessionId);
    const sessionBefore = await sessionOf(sessionId);

    const res = await revoke({ token, client_id: claimedClientId });
    expect(res.status, claimedClientId).toBe(401);
    expect(((await res.json()) as { error: string }).error, claimedClientId).toBe(
      "invalid_client",
    );

    const sessionAfter = await sessionOf(sessionId);
    expect(sessionAfter.revoked_at).toBeNull();
    expect(sessionAfter.revoked_reason).toBe(sessionBefore.revoked_reason);
    expect(await consumedAtOf(sessionId)).toEqual(consumedBefore);
    expect(await auditCount("mcp_session_revoked")).toBe(0);
    expect(await grantsSnapshot()).toEqual(grantsBefore);
    expect(await desktopTableCount()).toBe(0);
  }

  it("客户端 A 用自己的 client_id 撤销自己的 Token → 200", async () => {
    const a = await issueTokens("test-client");
    const res = await revoke({ token: a.tokens.refresh_token, client_id: a.clientId });
    expect(res.status).toBe(200);
    expect((await sessionOf(a.sessionId)).revoked_at).not.toBeNull();
  });

  it("客户端 B 拿 A 的 Refresh Token → 401，A 的 Session 与 Token 都不动", async () => {
    await seedAuthorizeClient(handle, { clientId: "other-client", clientName: "Other" });
    const a = await issueTokens("test-client");

    await expectClientMismatch("other-client", a.tokens.refresh_token, a.sessionId);
  });

  it("client_id 仅大小写不同 → 401（逐字符比较，不做大小写归一）", async () => {
    const a = await issueTokens("test-client");
    await expectClientMismatch("TEST-CLIENT", a.tokens.refresh_token, a.sessionId);
  });

  it("client_id 仅前后空格不同 → 401（不 trim）", async () => {
    const a = await issueTokens("test-client");
    await expectClientMismatch(" test-client ", a.tokens.refresh_token, a.sessionId);
  });

  it("不存在的 client_id → 401", async () => {
    const a = await issueTokens("test-client");
    await expectClientMismatch("no-such-client", a.tokens.refresh_token, a.sessionId);
  });

  it("已消费的旧代 + 错误 client → 401（归属判定早于状态判定）", async () => {
    const a = await issueTokens("test-client");
    const rotated = await readTokenResponse(
      await h.app.request("/mcp/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: a.tokens.refresh_token,
          client_id: "test-client",
          resource: "https://gateway.example/mcp",
        }).toString(),
      }),
    );
    expect(rotated.refresh_token).not.toBe(a.tokens.refresh_token);

    // 旧代已消费；但先用**错误** client 提交它 → 401，而不是 200。
    await expectClientMismatch("other-client", a.tokens.refresh_token, a.sessionId);
    // 用正确 client 提交旧代 → 仍是 200（无效 Token），且不撤销。
    const ok = await revoke({ token: a.tokens.refresh_token, client_id: "test-client" });
    expect(ok.status).toBe(200);
    expect((await sessionOf(a.sessionId)).revoked_at).toBeNull();
  });

  it("同一 Grant 下两个 Session 的客户端隔离", async () => {
    const first = await issueTokens("test-client");
    const second = await issueTokens("test-client");
    expect(second.grantId).toBe(first.grantId);

    await expectClientMismatch("other-client", second.tokens.refresh_token, second.sessionId);

    // 两个 Session 都没被碰过。
    expect((await sessionOf(first.sessionId)).revoked_at).toBeNull();
    expect((await sessionOf(second.sessionId)).revoked_at).toBeNull();
  });
});

describe("Access JWT 的客户端归属（C3b-R2）", () => {
  it("正确 client_id → 400 unsupported_token_type", async () => {
    const a = await issueTokens("test-client");
    const res = await revoke({ token: a.tokens.access_token, client_id: "test-client" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_token_type");
    expect((await sessionOf(a.sessionId)).revoked_at).toBeNull();
  });

  it("错误 client_id → 401 invalid_client（且不撤销）", async () => {
    const a = await issueTokens("test-client");
    const res = await revoke({ token: a.tokens.access_token, client_id: "other-client" });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
    expect((await sessionOf(a.sessionId)).revoked_at).toBeNull();
    expect(await auditCount("mcp_session_revoked")).toBe(0);
  });

  it("签名被篡改的 JWT → 200（当无效 Token，不做归属判定）", async () => {
    const a = await issueTokens("test-client");
    const [header, payload] = a.tokens.access_token.split(".");
    const tampered = `${header}.${payload}.${"A".repeat(43)}`;

    const res = await revoke({ token: tampered, client_id: "test-client" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect((await sessionOf(a.sessionId)).revoked_at).toBeNull();
  });

  it("JWT 的 client_id claim 与实际 Session 归属一致（签发侧不撒谎）", async () => {
    // 这条不是撤销用例，而是钉住「claim 来自 Session」：签发时若写错，
    // 上面的归属校验就会变成「两个错误互相印证」。
    const a = await issueTokens("test-client");
    const claims = decodeJwtPayload(a.tokens.access_token);
    expect(claims.client_id).toBe(a.clientId);

    const rows = await handle.sql<{ client_id: string }[]>`
      select client_id from mcp_sessions where id = ${a.sessionId}`;
    expect(rows[0]!.client_id).toBe(claims.client_id);
  });
});

describe("Access JWT Session 状态（C3b-R2-R1）", () => {
  /** 用测试密钥签一枚 MCP Access JWT（可指定 sid / client_id）。 */
  async function signAccess(sessionId: string, clientId: string): Promise<string> {
    return await signMcpAccessToken(
      h.ctx.keyRing,
      { userId: "00000000-0000-4000-8000-00000000000a", sessionId, clientId, scope: ["records:read"] },
      {
        issuer: h.ctx.env.baseUrl,
        resource: mcpResourceFor(h.ctx.env.baseUrl),
        ttlSeconds: 900,
      },
    );
  }

  /**
   * 「无效 Access JWT」的统一验收：200 空体 + 零写入。
   *
   * 只断言状态码不够：一个把已撤销 Session 的 token 当成「有效但不支持撤销」
   * 的实现同样可能返回 400，或者更糟——顺手写一次撤销。
   */
  async function expectInvalidAccessToken(
    token: string,
    clientId: string,
    sessionId: string | null,
  ): Promise<void> {
    const grantsBefore = await grantsSnapshot();
    const auditBefore = await auditCount("mcp_session_revoked");
    const desktopBefore = await desktopTableCount();
    const sessionsBefore = await sessions();
    const sessionBefore = sessionId ? await sessionOf(sessionId) : null;
    const consumedBefore = sessionId ? await consumedAtOf(sessionId) : null;

    const res = await revoke({ token, client_id: clientId });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");

    if (sessionId && sessionBefore) {
      const after = await sessionOf(sessionId);
      expect(after.revoked_at).toBe(sessionBefore.revoked_at);
      expect(after.revoked_reason).toBe(sessionBefore.revoked_reason);
      expect(await consumedAtOf(sessionId)).toEqual(consumedBefore);
    }
    expect(await sessions()).toEqual(sessionsBefore);
    expect(await grantsSnapshot()).toEqual(grantsBefore);
    expect(await auditCount("mcp_session_revoked")).toBe(auditBefore);
    expect(await desktopTableCount()).toBe(desktopBefore);
  }

  it("Session active + 正确 client_id → 400 unsupported_token_type，且不撤销", async () => {
    const a = await issueTokens("test-client");

    const res = await revoke({ token: a.tokens.access_token, client_id: "test-client" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_token_type");

    expect((await sessionOf(a.sessionId)).revoked_at).toBeNull();
    expect(await auditCount("mcp_session_revoked")).toBe(0);
  });

  it("Session active + 错误 client_id → 401 invalid_client，且不撤销", async () => {
    const a = await issueTokens("test-client");

    const res = await revoke({ token: a.tokens.access_token, client_id: "other-client" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
    expect((await sessionOf(a.sessionId)).revoked_at).toBeNull();
    expect(await auditCount("mcp_session_revoked")).toBe(0);
  });

  it("Session 已撤销 → 200 空体（不再是「有效但不支持撤销」）", async () => {
    const a = await issueTokens("test-client");
    // 用 Refresh Token 正常撤销这条 Session；JWT 本身仍在 exp 内。
    expect((await revoke({ token: a.tokens.refresh_token, client_id: "test-client" })).status).toBe(200);
    const revokedAt = (await sessionOf(a.sessionId)).revoked_at;
    expect(revokedAt).not.toBeNull();
    expect(await auditCount("mcp_session_revoked")).toBe(1);

    await expectInvalidAccessToken(a.tokens.access_token, "test-client", a.sessionId);

    // revoked_at 不被覆盖，审计也不新增。
    expect((await sessionOf(a.sessionId)).revoked_at).toBe(revokedAt);
    expect(await auditCount("mcp_session_revoked")).toBe(1);
  });

  it("Session 已过期 → 200 空体，且不写 revoked_at（过期不是撤销）", async () => {
    const a = await issueTokens("test-client");
    // CHECK 要求 absolute_expires_at > created_at，两个时间一起前移。
    await handle.sql`
      update mcp_sessions
         set created_at = now() - interval '91 days',
             absolute_expires_at = now() - interval '1 day'
       where id = ${a.sessionId}`;

    await expectInvalidAccessToken(a.tokens.access_token, "test-client", a.sessionId);
    expect((await sessionOf(a.sessionId)).revoked_at).toBeNull();
  });

  it("Session 不存在 → 200 空体，不产生任何写入", async () => {
    const ghostSid = "99999999-9999-4999-8999-999999999999";
    const token = await signAccess(ghostSid, "test-client");

    const sessionsBefore = await sessions();
    await expectInvalidAccessToken(token, "test-client", null);
    expect(await sessions()).toEqual(sessionsBefore);
  });

  it("JWT 的 client_id 与 Session 归属不一致 → 200（claims 不能自证）", async () => {
    const a = await issueTokens("test-client");
    // 签名合法、sid 真实，但 claim 里的 client_id 不是这条 Session 的主人。
    const forgedClaim = await signAccess(a.sessionId, "ghost-client");

    // 即使请求的 client_id 与 **claim** 完全一致，也不能被当成有效 Access Token。
    await expectInvalidAccessToken(forgedClaim, "ghost-client", a.sessionId);
    expect((await sessionOf(a.sessionId)).revoked_at).toBeNull();
  });

  it("三种「无效」对外不可区分：撤销 / 过期 / 不存在都是同一个 200 空体", async () => {
    const a = await issueTokens("test-client");
    expect((await revoke({ token: a.tokens.refresh_token, client_id: "test-client" })).status).toBe(200);

    const revokedRes = await revoke({ token: a.tokens.access_token, client_id: "test-client" });
    const missingRes = await revoke({
      token: await signAccess("88888888-8888-4888-8888-888888888888", "test-client"),
      client_id: "test-client",
    });

    expect(revokedRes.status).toBe(200);
    expect(missingRes.status).toBe(200);
    expect(await revokedRes.text()).toBe("");
    expect(await missingRes.text()).toBe("");
    // 响应体也不带错误码——完全空。
    expect(revokedRes.headers.get("content-type") ?? "").not.toContain("application/json");
  });
});

describe("Session 级撤销（本阶段核心）", () => {
  it("只撤当前 Session：同 Grant 的另一个 Session、Grant 本身都不动", async () => {
    // 同一个 client、同一个 Grant 下的两条独立 Session。
    const a = await issueTokens();
    const b = await issueTokens();
    expect(b.grantId).toBe(a.grantId);
    expect(b.sessionId).not.toBe(a.sessionId);

    const grantBefore = await handle.sql<{ scopes: string[]; epoch: number; revoked_at: string | null }[]>`
      select scopes, epoch, revoked_at::text from mcp_grants where id = ${a.grantId}`;
    const desktopBefore = await desktopTableCount();

    const res = await revoke({ token: a.tokens.refresh_token });
    expect(res.status).toBe(200);

    const afterA = await sessionOf(a.sessionId);
    expect(afterA.revoked_at).not.toBeNull();
    expect(afterA.revoked_reason).toBe("client_revoke");

    const afterB = await sessionOf(b.sessionId);
    expect(afterB.revoked_at).toBeNull();
    expect(afterB.revoked_reason).toBeNull();

    const grantAfter = await handle.sql<{ scopes: string[]; epoch: number; revoked_at: string | null }[]>`
      select scopes, epoch, revoked_at::text from mcp_grants where id = ${a.grantId}`;
    expect(grantAfter[0]).toEqual(grantBefore[0]);

    // Desktop 的登录会话表一行都没多。
    expect(await desktopTableCount()).toBe(desktopBefore);

    // 用户与 Grant 的关联没有变（撤销不删行、不改归属）。
    const all = await sessions();
    expect(all).toHaveLength(2);
    for (const row of all) {
      expect(row.user_id).toBe(afterA.user_id);
      expect(row.grant_id).toBe(a.grantId);
    }
  });

  it("撤销后 Session 行与 Refresh Token 历史行都不删除", async () => {
    const { tokens, sessionId } = await issueTokens();
    const before = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_refresh_tokens where session_id = ${sessionId}`;

    expect((await revoke({ token: tokens.refresh_token })).status).toBe(200);

    const after = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_refresh_tokens where session_id = ${sessionId}`;
    expect(after[0]?.count).toBe(before[0]?.count);
    expect((await sessionOf(sessionId)).id).toBe(sessionId);

    // 审计写了一条，理由是 client_revoke。
    const rows = await handle.sql<{ detail: { reason?: string } }[]>`
      select detail from auth_events where event_type = 'mcp_session_revoked'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail.reason).toBe("client_revoke");
  });

  it("撤销别的客户端会话时，本客户端的会话不受影响", async () => {
    await seedAuthorizeClient(handle, { clientId: "other-client", clientName: "Other" });
    const other = await issueTokens();
    const mine = await issueTokens();

    expect((await revoke({ token: mine.tokens.refresh_token })).status).toBe(200);

    expect((await sessionOf(mine.sessionId)).revoked_at).not.toBeNull();
    expect((await sessionOf(other.sessionId)).revoked_at).toBeNull();
  });
});

describe("Token 生命周期：无效即 200，且不写库", () => {
  const invalidCases: Array<[string, (ctx: { token: string; sessionId: string }) => Promise<string>]> = [
    [
      "随机伪造",
      async () => "not-a-real-refresh-token-" + Math.random().toString(36).slice(2),
    ],
    [
      "已消费的旧代",
      async (ctx) => {
        const rotated = await readTokenResponse(
          await h.app.request("/mcp/oauth/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: ctx.token,
              client_id: "test-client",
              resource: "https://gateway.example/mcp",
            }).toString(),
          }),
        );
        expect(rotated.refresh_token).not.toBe(ctx.token);
        return ctx.token; // 旧代现在已消费
      },
    ],
    [
      "已过期",
      async (ctx) => {
        // CHECK 要求 expires_at > created_at，两个时间一起前移。
        await handle.sql`
          update mcp_refresh_tokens
             set created_at = now() - interval '31 days',
                 expires_at = now() - interval '1 second'
           where session_id = ${ctx.sessionId} and consumed_at is null`;
        return ctx.token;
      },
    ],
  ];

  for (const [name, prepare] of invalidCases) {
    it(`${name} → 200 空体，Session 保持 active`, async () => {
      const { tokens, sessionId } = await issueTokens();
      const token = await prepare({ token: tokens.refresh_token, sessionId });

      const res = await revoke({ token });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expect((await sessionOf(sessionId)).revoked_at).toBeNull();
      expect(await auditCount("mcp_session_revoked")).toBe(0);
    });
  }

  it("Session 已过期 → 200，且不写 revoked_at（过期不是撤销）", async () => {
    const { tokens, sessionId } = await issueTokens();
    // CHECK 要求 absolute_expires_at > created_at，两个时间一起前移。
    await handle.sql`
      update mcp_sessions
         set created_at = now() - interval '91 days',
             absolute_expires_at = now() - interval '1 day'
       where id = ${sessionId}`;

    const res = await revoke({ token: tokens.refresh_token });
    expect(res.status).toBe(200);
    expect((await sessionOf(sessionId)).revoked_at).toBeNull();
    expect(await auditCount("mcp_session_revoked")).toBe(0);
  });

  it("Session 已撤销 → 200，且不重复写审计", async () => {
    const { tokens, sessionId } = await issueTokens();
    expect((await revoke({ token: tokens.refresh_token })).status).toBe(200);
    const firstRevokedAt = (await sessionOf(sessionId)).revoked_at;
    expect(await auditCount("mcp_session_revoked")).toBe(1);

    const second = await revoke({ token: tokens.refresh_token });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("");
    // 时间戳没有第二次覆盖，审计也没有第二条。
    expect((await sessionOf(sessionId)).revoked_at).toBe(firstRevokedAt);
    expect(await auditCount("mcp_session_revoked")).toBe(1);
  });

  it("已撤销 Session 的另一枚历史 Refresh Token 也是 200 且无副作用", async () => {
    const { tokens, sessionId } = await issueTokens();
    const rotated = await readTokenResponse(
      await h.app.request("/mcp/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: "test-client",
          resource: "https://gateway.example/mcp",
        }).toString(),
      }),
    );

    expect((await revoke({ token: rotated.refresh_token })).status).toBe(200);
    // 旧代（已消费）再撤一次：仍是 200，且不会把已撤销的 Session 再写一遍。
    expect((await revoke({ token: tokens.refresh_token })).status).toBe(200);
    expect(await auditCount("mcp_session_revoked")).toBe(1);
    expect((await sessionOf(sessionId)).revoked_reason).toBe("client_revoke");
  });
});

describe("token_type_hint 只是提示", () => {
  const hints = [
    "refresh_token",
    undefined,
    "banana", // 未知值：忽略
    "access_token", // 与真实类型不符：仍要能撤
  ] as const;

  for (const hint of hints) {
    it(`hint=${hint ?? "(无)"} + 有效 refresh → 撤销成功`, async () => {
      const { tokens, sessionId } = await issueTokens();
      const res = await revoke({ token: tokens.refresh_token, token_type_hint: hint });
      expect(res.status).toBe(200);
      expect((await sessionOf(sessionId)).revoked_at).not.toBeNull();
    });
  }

  it("有效 MCP Access JWT → 400 unsupported_token_type，且不撤销 Session", async () => {
    const { tokens, sessionId } = await issueTokens();
    const res = await revoke({ token: tokens.access_token, token_type_hint: "access_token" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_token_type");
    // 错误体里绝不能回显这枚 token。
    expect(JSON.stringify(body)).not.toContain(tokens.access_token);
    expect((await sessionOf(sessionId)).revoked_at).toBeNull();
    expect(await auditCount("mcp_session_revoked")).toBe(0);
  });

  it("过期的 MCP Access JWT → 当无效 Token，200", async () => {
    const { tokens, sessionId } = await issueTokens();
    const expired = await signMcpAccessToken(
      h.ctx.keyRing,
      { userId: "u", sessionId, clientId: "test-client", scope: ["records:read"] },
      {
        issuer: h.ctx.env.baseUrl,
        resource: mcpResourceFor(h.ctx.env.baseUrl),
        ttlSeconds: 900,
        // 一小时前签发、15 分钟有效期 —— 早就过期。
        now: () => new Date(Date.now() - 60 * 60 * 1000),
      },
    );

    const res = await revoke({ token: expired });
    expect(res.status).toBe(200);
    expect((await sessionOf(sessionId)).revoked_at).toBeNull();
    // 顺带确认它确实是一枚「签名有效但过期」的 token，而不是被当成垃圾。
    expect(tokens.access_token).not.toBe(expired);
  });

  it("Desktop Access Token 不被识别为 MCP token → 200", async () => {
    const { sessionId } = await issueTokens();
    const desktopToken = await signAccessToken(
      h.ctx.keyRing,
      { userId: "00000000-0000-4000-8000-000000000001", sessionId },
      { issuer: h.ctx.env.baseUrl, ttlSeconds: 900 },
    );

    const res = await revoke({ token: desktopToken });
    expect(res.status).toBe(200);
    expect((await sessionOf(sessionId)).revoked_at).toBeNull();
  });
});

describe("revokeMcpSession 的幂等性（服务层）", () => {
  /**
   * 直接打服务层，不经过路由。
   *
   * 路由在调用前会先判 `getMcpSessionState()`，所以「重复撤销」在 HTTP 层是
   * 提前返回的——那样就测不到 `revokeMcpSession` 自己的条件更新
   * （`WHERE revoked_at IS NULL`）。而这条条件正是「撤销只发生一次、
   * 审计只写一条」的最后一道防线。
   */
  it("第二次调用返回 revoked=false，且不再写审计", async () => {
    const { sessionId } = await issueTokens();
    const deps = { db: handle.db, pepper: h.env.sessionTokenPepper };

    const first = await revokeMcpSession(deps, { sessionId, reason: "client_revoke" });
    const second = await revokeMcpSession(deps, { sessionId, reason: "client_revoke" });

    expect(first.revoked).toBe(true);
    expect(second.revoked).toBe(false);
    expect(await auditCount("mcp_session_revoked")).toBe(1);
  });
});

describe("并发与审计", () => {
  it("两个并发撤销同一 Refresh Token：都 200，Session 只撤一次、审计只一条", async () => {
    const { tokens, sessionId } = await issueTokens();

    const [first, second] = await Promise.all([
      revoke({ token: tokens.refresh_token }),
      revoke({ token: tokens.refresh_token }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.text()).toBe("");
    expect(await second.text()).toBe("");

    expect((await sessionOf(sessionId)).revoked_at).not.toBeNull();
    expect(await auditCount("mcp_session_revoked")).toBe(1);
  });

  it("审计里没有明文 Token、没有 Token 哈希", async () => {
    const { tokens } = await issueTokens();
    expect((await revoke({ token: tokens.refresh_token })).status).toBe(200);

    for (const needle of [tokens.refresh_token, tokens.access_token]) {
      const rows = await handle.sql<{ count: string }[]>`
        select count(*)::text as count from auth_events where strpos(detail::text, ${needle}) > 0`;
      expect(rows[0]?.count).toBe("0");
    }
    // 库里也没有明文 token（只有 64 位十六进制哈希）。
    const raw = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_refresh_tokens
       where strpos(token_hash, ${tokens.refresh_token}) > 0`;
    expect(raw[0]?.count).toBe("0");
  });

  it("数据库异常 → 500 固定文案，不回显 SQL / 表名 / Token", async () => {
    const { tokens } = await issueTokens();
    await handle.sql.unsafe("alter table mcp_refresh_tokens rename to mcp_refresh_tokens_hidden");
    try {
      const res = await revoke({ token: tokens.refresh_token });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: "server_error" });
      expect(text).not.toContain("mcp_refresh_tokens");
      expect(text).not.toContain("select");
      expect(text).not.toContain(tokens.refresh_token);
    } finally {
      await handle.sql.unsafe("alter table mcp_refresh_tokens_hidden rename to mcp_refresh_tokens");
    }
  });
});
