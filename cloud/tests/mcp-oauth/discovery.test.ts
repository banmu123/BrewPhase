import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import {
  authorizeQuery,
  cookiePair,
  createMcpOAuthHarness,
  seedAuthorizeClient,
  type McpOAuthHarness,
} from "../helpers/mcp-oauth-app.js";
import { startConsentFlow, submitConsent } from "../helpers/mcp-consent.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { MCP_SCOPES, mcpResourceFor } from "../../src/mcp-oauth/constants.js";
import { createApp } from "../../src/app.js";
import { createDb } from "../../src/db/client.js";
import { makeTestEnv, TEST_DATABASE_URL } from "../helpers/env.js";
import { createKeyRing } from "../../src/sessions/jwt.js";
import { createProviders } from "../../src/oauth/providers.js";
import type { AppContext } from "../../src/context.js";
import type { Logger } from "../../src/logger.js";

/**
 * OAuth Discovery 元数据（Phase 1.3.1-C3c-1）。
 *
 * 这一组不测「JSON 常量长什么样」——那只能证明代码抄了两遍。它测的是
 * **声明与实现是否一致**：元数据里的每个 endpoint 都真的存在，每个 scope
 * 都真的能用，每个 `true` 都真的成立（尤其是 RFC 9207 的 `iss`）。
 *
 * 元数据是承诺：多写一个字段就是多一个客户端会去调用、而我们要么 404
 * 要么行为不符的接口。
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

const PRM_ROOT = "/.well-known/oauth-protected-resource";
const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";
const AS_METADATA = "/.well-known/oauth-authorization-server";

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown>; type: string }> {
  const res = await h.app.request(path);
  const text = await res.text();
  return {
    status: res.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
    type: res.headers.get("content-type") ?? "",
  };
}

async function asMetadata(): Promise<Record<string, unknown>> {
  return (await getJson(AS_METADATA)).body;
}

interface CapturingLogger extends Logger {
  lines: Array<{ level: string; message: string }>;
}

function capturingLogger(): CapturingLogger {
  const lines: CapturingLogger["lines"] = [];
  const record =
    (level: string) =>
    (message: string): void => {
      lines.push({ level, message });
    };
  return { lines, debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
}

/** 用指定 env 装配 app（用于「未启用」边界）。 */
function appWithEnv(overrides: Record<string, unknown>) {
  const env = makeTestEnv({ baseUrl: "https://gateway.example", ...overrides });
  const db = createDb(TEST_DATABASE_URL);
  const logger = capturingLogger();
  const ctx: AppContext = {
    env,
    db,
    providers: createProviders(env),
    logger,
    keyRing: createKeyRing(env.jwtSigningKey, env.jwtSigningKeyPrevious),
  };
  return { app: createApp(ctx), ctx, logger, env, close: () => db.close() };
}

describe("Protected Resource Metadata（RFC 9728）", () => {
  it("根形式与路径插入形式都返回 200，且内容完全一致", async () => {
    const root = await getJson(PRM_ROOT);
    const inserted = await getJson(PRM_PATH);

    expect(root.status).toBe(200);
    expect(inserted.status).toBe(200);
    expect(root.type).toContain("application/json");
    expect(inserted.type).toContain("application/json");
    // 路径插入只改变「怎么找到」，不改变「资源是什么」。
    expect(inserted.body).toEqual(root.body);
  });

  it("resource 是 MCP 端点本身，不是站点根", async () => {
    const { body } = await getJson(PRM_ROOT);
    expect(body.resource).toBe(mcpResourceFor("https://gateway.example"));
    expect(body.resource).toBe("https://gateway.example/mcp");
    // 反例：把根地址当资源会让客户端把 token 发到错误的地方。
    expect(body.resource).not.toBe("https://gateway.example");
  });

  it("authorization_servers 精确等于当前 issuer", async () => {
    const { body } = await getJson(PRM_PATH);
    expect(body.authorization_servers).toEqual(["https://gateway.example"]);
  });

  it("scopes_supported 与 MCP_SCOPES 完全一致（顺序也一致）", async () => {
    const { body } = await getJson(PRM_ROOT);
    expect(body.scopes_supported).toEqual([...MCP_SCOPES]);
  });

  it("bearer_methods_supported 只有 header", async () => {
    const { body } = await getJson(PRM_ROOT);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    // 明确不含 body / query——尤其 query：撤销端点已经拒绝 Query 里的 token。
    expect(body.bearer_methods_supported).not.toContain("body");
    expect(body.bearer_methods_supported).not.toContain("query");
  });

  it("不认识的子路径不会被当成 PRM（精确匹配）", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource/other",
      "/.well-known/oauth-protected-resource/mcp/extra",
    ]) {
      const res = await h.app.request(path);
      expect(res.status, path).toBe(404);
    }
  });
});

describe("Authorization Server Metadata（RFC 8414）", () => {
  it("GET 返回 200 与 JSON Content-Type", async () => {
    const res = await getJson(AS_METADATA);
    expect(res.status).toBe(200);
    expect(res.type).toContain("application/json");
  });

  it("issuer 与 env.baseUrl 逐字符一致", async () => {
    expect((await asMetadata()).issuer).toBe(h.env.baseUrl);
  });

  it("三个 endpoint 都指向真实存在的路由（不是 404）", async () => {
    const meta = await asMetadata();
    expect(meta.authorization_endpoint).toBe("https://gateway.example/mcp/oauth/authorize");
    expect(meta.token_endpoint).toBe("https://gateway.example/mcp/oauth/token");
    expect(meta.revocation_endpoint).toBe("https://gateway.example/mcp/oauth/revoke");

    // 声明了就必须存在：缺少参数/格式不对时是 400，而不是 404。
    const authorize = await h.app.request(String(meta.authorization_endpoint));
    expect(authorize.status).toBe(400);

    const token = await h.app.request(String(meta.token_endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(token.status).toBe(400);

    const revoke = await h.app.request(String(meta.revocation_endpoint), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(revoke.status).toBe(400);
  });

  it("response_types / grant_types 只列已实现的取值", async () => {
    const meta = await asMetadata();
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.grant_types_supported).not.toContain("client_credentials");
    expect(meta.grant_types_supported).not.toContain("implicit");
  });

  it("PKCE 只声明 S256", async () => {
    const meta = await asMetadata();
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.code_challenge_methods_supported).not.toContain("plain");
  });

  it("Token Endpoint 认证方式只有 none（Public Client）", async () => {
    const meta = await asMetadata();
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(meta.token_endpoint_auth_methods_supported).not.toContain("client_secret_basic");
    expect(meta.token_endpoint_auth_methods_supported).not.toContain("client_secret_post");
  });

  it("scopes_supported 与 MCP_SCOPES 完全一致", async () => {
    expect((await asMetadata()).scopes_supported).toEqual([...MCP_SCOPES]);
  });

  it("声明 RFC 9207 的 iss 参数", async () => {
    expect((await asMetadata()).authorization_response_iss_parameter_supported).toBe(true);
  });

  it("不声明 DCR（registration_endpoint 不存在，且注册路由是 404）", async () => {
    const meta = await asMetadata();
    expect("registration_endpoint" in meta).toBe(false);

    const res = await h.app.request("/mcp/oauth/register", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("不声明 CIMD、introspection、userinfo、jwks_uri", async () => {
    const meta = await asMetadata();
    for (const key of [
      "client_id_metadata_document_supported",
      "introspection_endpoint",
      "userinfo_endpoint",
      "jwks_uri",
      "device_authorization_endpoint",
    ]) {
      expect(key in meta, key).toBe(false);
    }
  });

  it("字段集合就是这 10 个（不多不少）", async () => {
    expect(Object.keys(await asMetadata()).sort()).toEqual(
      [
        "issuer",
        "authorization_endpoint",
        "token_endpoint",
        "revocation_endpoint",
        "scopes_supported",
        "response_types_supported",
        "grant_types_supported",
        "token_endpoint_auth_methods_supported",
        "code_challenge_methods_supported",
        "authorization_response_iss_parameter_supported",
      ].sort(),
    );
  });
});

describe("RFC 9207：iss 参数回归（元数据声明必须成立）", () => {
  /**
   * 只走到「Provider 已认领」这一步（不完成回调）。
   *
   * 不能复用 `startConsentFlow()`：它已经把 `provider_consumed_at` 写上了，
   * 再用同一个 rid 重新登录会被「已消费的授权请求不能重新启动 Provider 流程」
   * 挡住——那时拿到的 state 不是数据库里的那一把。
   */
  async function startProvider(): Promise<{ rid: string; cookie: string; state: string }> {
    const authorizeRes = await h.app.request(`/mcp/oauth/authorize?${authorizeQuery()}`, {
      headers: {},
    });
    expect(authorizeRes.status).toBe(302);
    const rid = new URL(authorizeRes.headers.get("location")!, "https://x").searchParams.get("rid")!;
    const cookie = cookiePair(authorizeRes) ?? "";

    const jump = await h.app.request(`/mcp/oauth/login?rid=${rid}&provider=google`, {
      headers: { cookie },
    });
    expect(jump.status).toBe(302);
    const state = new URL(jump.headers.get("location")!).searchParams.get("state");
    if (!state) throw new Error("login did not redirect with a provider state");
    return { rid, cookie, state };
  }

  it("授权成功的回调携带 iss，且等于 metadata.issuer", async () => {
    const flow = await startConsentFlow(h);
    const approved = await submitConsent(h, {
      rid: flow.rid,
      cookie: flow.cookie,
      csrf: flow.csrf,
      decision: "allow",
      scopes: ["records:read"],
    });
    expect(approved.status).toBe(302);

    const location = new URL(approved.headers.get("location")!);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("iss")).toBe((await asMetadata()).issuer);
  });

  it("access_denied 的错误响应携带 iss", async () => {
    const started = await startProvider();
    const res = await h.app.request(
      `/mcp/oauth/callback/google?error=access_denied&state=${encodeURIComponent(started.state)}`,
      { headers: { cookie: started.cookie } },
    );
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("iss")).toBe((await asMetadata()).issuer);
  });

  it("server_error 的错误响应携带 iss", async () => {
    const started = await startProvider();
    const res = await h.app.request(
      `/mcp/oauth/callback/google?error=server_error&state=${encodeURIComponent(started.state)}`,
      { headers: { cookie: started.cookie } },
    );
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("server_error");
    expect(location.searchParams.get("iss")).toBe((await asMetadata()).issuer);
  });

  it("三处 issuer 逐字符相同：metadata.issuer = PRM.authorization_servers[0]", async () => {
    const meta = await asMetadata();
    const prm = (await getJson(PRM_PATH)).body;
    expect((prm.authorization_servers as string[])[0]).toBe(meta.issuer);
    expect(meta.issuer).toBe(h.env.baseUrl);
  });
});

describe("启用边界：OAuth 关闭时 Discovery 也必须消失", () => {
  const disabledCases: Array<[string, Record<string, unknown>]> = [
    ["缺失密钥", { mcpBrowserSessionKey: undefined }],
    ["密钥过短", { mcpBrowserSessionKey: "short" }],
    ["复用 JWT 密钥", { mcpBrowserSessionKey: makeTestEnv().jwtSigningKey }],
  ];

  for (const [label, overrides] of disabledCases) {
    it(`${label}：三条 Discovery 路由都 404，Desktop OAuth 仍可用`, async () => {
      const rig = appWithEnv(overrides);
      try {
        for (const path of [PRM_ROOT, PRM_PATH, AS_METADATA]) {
          const res = await rig.app.request(path);
          expect(res.status, `${label} ${path}`).toBe(404);
        }

        // 旧能力不受影响：Desktop 的 authorize 仍然按自己的规则回 400
        // （缺 redirect_uri / provider 之类），而不是 404。
        const desktop = await rig.app.request("/oauth/authorize");
        expect(desktop.status).not.toBe(404);
      } finally {
        await rig.close();
      }
    });
  }

  it("启用时三条路由都存在（对照组，排除「一直 404」）", async () => {
    for (const path of [PRM_ROOT, PRM_PATH, AS_METADATA]) {
      expect((await h.app.request(path)).status, path).toBe(200);
    }
  });
});

describe("Discovery 没有副作用", () => {
  it("不建 Session / Grant / Refresh，不写审计，不触发 Provider，不读个人数据", async () => {
    const count = async (table: string): Promise<number> => {
      const rows = await handle.sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from "${table}"`,
      );
      return Number(rows[0]?.count ?? "-1");
    };

    const tables = ["mcp_sessions", "mcp_grants", "mcp_refresh_tokens", "auth_events", "users"];
    const before = new Map<string, number>();
    for (const table of tables) before.set(table, await count(table));
    const exchangesBefore =
      h.providers.google.state.exchangeCount + h.providers.github.state.exchangeCount;

    for (let i = 0; i < 3; i += 1) {
      await h.app.request(PRM_ROOT);
      await h.app.request(PRM_PATH);
      await h.app.request(AS_METADATA);
    }

    for (const table of tables) {
      expect(await count(table), table).toBe(before.get(table));
    }
    expect(
      h.providers.google.state.exchangeCount + h.providers.github.state.exchangeCount,
    ).toBe(exchangesBefore);

    // 无 Cookie、无 Bearer 也能拿到（说明不依赖任何凭据）。
    const res = await h.app.request(PRM_ROOT, { headers: {} });
    expect(res.status).toBe(200);
  });
});
