import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { createMcpOAuthHarness, seedAuthorizeClient, type McpOAuthHarness } from "../helpers/mcp-oauth-app.js";
import {
  codesOf,
  grantsOf,
  redirectParams,
  startConsentFlow,
  submitConsent,
  tableCount,
} from "../helpers/mcp-consent.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { mcpAuthCodeHash } from "../../src/mcp-oauth/authorize-flow.js";

/**
 * Authorization Code 的签发语义（Phase 1.3.1-C2b）。
 *
 * 授权码是**唯一**会把「用户同意」变成「客户端拿到数据访问权」的那一步。
 * 所以这一组盯的不是「有没有生成一个字符串」，而是四条不可让步的性质：
 *
 * | 性质 | 反例 |
 * |---|---|
 * | 只有哈希落库 | 明文入库 = 任何一次数据库读取都能换 token |
 * | 60 秒 | 一小时 = 泄漏窗口放大 60 倍 |
 * | 与 grant / 删行同事务 | 部分成功 = 「有 code 没 grant」或「有 grant 无 code」 |
 * | 绑定最终 scope | 用户取消的权限出现在 code 里 = 静默扩权 |
 */

const handle = await getTestDb();

let h: McpOAuthHarness;
/** 本文件里注入过的触发器（必须逐个 drop，truncate 不会清 DDL）。 */
const createdTriggers: string[] = [];

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
  h = await createMcpOAuthHarness();
  await seedAuthorizeClient(handle);
});

afterEach(async () => {
  for (const name of createdTriggers.splice(0)) {
    await handle.sql.unsafe(`drop trigger if exists ${name} on mcp_auth_codes`);
  }
  await handle.sql.unsafe("drop function if exists mcp_auth_codes_reject()");
});

afterAll(async () => {
  await closeTestDb();
});

async function flow(scope = "records:read coffee:read") {
  return startConsentFlow(h, {
    query: new URLSearchParams({
      response_type: "code",
      client_id: "test-client",
      redirect_uri: "https://client.example/callback",
      scope,
      state: "state-xyz",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      resource: "https://gateway.example/mcp",
    }).toString(),
  });
}

async function approve(
  session: { rid: string; cookie: string; csrf: string },
  scopes: readonly string[],
) {
  return submitConsent(h, {
    rid: session.rid,
    cookie: session.cookie,
    csrf: session.csrf,
    decision: "allow",
    scopes,
  });
}

describe("授权码本身", () => {
  it("43 字符 base64url、两次授权不相同", async () => {
    const first = await flow("records:read");
    const firstRes = await approve(first, ["records:read"]);
    const firstCode = redirectParams(firstRes).get("code")!;

    const second = await flow("records:read");
    const secondRes = await approve(second, ["records:read"]);
    const secondCode = redirectParams(secondRes).get("code")!;

    for (const code of [firstCode, secondCode]) {
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(firstCode).not.toBe(secondCode);
  });

  it("库里只有 sha256(\"mcp-code:\" ‖ code)", async () => {
    const session = await flow("records:read");
    const res = await approve(session, ["records:read"]);
    const code = redirectParams(res).get("code")!;

    const rows = await codesOf(handle.sql, session.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toBe(mcpAuthCodeHash(code));
    expect(rows[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("明文 code 不出现在任何列里", async () => {
    const session = await flow("records:read");
    const res = await approve(session, ["records:read"]);
    const code = redirectParams(res).get("code")!;

    const hits = await handle.sql<{ count: string }[]>`
      select count(*)::text as count
        from mcp_auth_codes
       where code_hash = ${code} or scope::text like ${`%${code}%`}`;
    expect(hits[0]?.count).toBe("0");
  });

  it("有效期恰好 60 秒", async () => {
    const session = await flow("records:read");
    await approve(session, ["records:read"]);

    const rows = await handle.sql<{ seconds: string }[]>`
      select extract(epoch from (expires_at - created_at))::text as seconds from mcp_auth_codes`;
    expect(Number(rows[0]!.seconds)).toBe(60);
  });

  it("scope 使用用户实际勾选的最终集合（不是请求集合）", async () => {
    const session = await flow("records:read coffee:read tags:read");
    await approve(session, ["records:read", "tags:read"]);

    const rows = await codesOf(handle.sql, session.userId);
    expect(rows[0]!.scope).toEqual(["records:read", "tags:read"]);
    const grants = await grantsOf(handle.sql, session.userId);
    expect(grants[0]!.scopes).toEqual(["records:read", "tags:read"]);
  });

  it("resource / redirect_uri / code_challenge 来自原授权请求", async () => {
    const session = await flow("records:read");
    await approve(session, ["records:read"]);

    const rows = await codesOf(handle.sql, session.userId);
    expect(rows[0]!).toMatchObject({
      resource: "https://gateway.example/mcp",
      redirect_uri: "https://client.example/callback",
      code_challenge: "c".repeat(43),
      consumed_at: null,
    });
  });

  it("code 行挂在 upsert 出来的那条 grant 上", async () => {
    const session = await flow("records:read");
    await approve(session, ["records:read"]);

    const rows = await handle.sql<{ grant_id: string; id: string }[]>`
      select c.grant_id, g.id from mcp_auth_codes c join mcp_grants g on g.id = c.grant_id`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.grant_id).toBe(rows[0]!.id);
  });
});

describe("事务原子性", () => {
  /**
   * 在 `mcp_auth_codes` 上装一个只在指定用户下报错的触发器。
   *
   * 这是唯一能在**不修改生产代码**的前提下让「事务最后一步失败」的方法：
   * 如果实现把 grant / code / 删行分在多个事务里，那么 grant 会留下来、
   * 授权请求会被删掉，而 code 不存在——测试会立刻看见。
   */
  async function failCodeInsertFor(userId: string): Promise<void> {
    await handle.sql.unsafe(`
      create or replace function mcp_auth_codes_reject() returns trigger as $$
      begin
        if new.user_id = '${userId}'::uuid then
          raise exception 'injected mcp_auth_codes failure';
        end if;
        return new;
      end $$ language plpgsql`);
    await handle.sql.unsafe(`
      create trigger mcp_auth_codes_reject before insert on mcp_auth_codes
      for each row execute function mcp_auth_codes_reject()`);
    createdTriggers.push("mcp_auth_codes_reject");
  }

  it("授权码插入失败 → grant 不残留、授权请求仍在（整体回滚）", async () => {
    const session = await flow("records:read");
    await failCodeInsertFor(session.userId);

    const res = await approve(session, ["records:read"]);
    // 注入的是数据库异常：它不属于「用户输入不合法」，所以走 500。
    expect(res.status).toBe(500);

    expect(await tableCount(handle.sql, "mcp_grants")).toBe(0);
    expect(await tableCount(handle.sql, "mcp_auth_codes")).toBe(0);
    // 授权请求没有被消费：用户重新打开同意页还能再试一次。
    expect(await tableCount(handle.sql, "mcp_auth_requests")).toBe(1);

    const audit = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events where event_type = 'mcp_consent_allowed'`;
    expect(audit[0]?.count).toBe("0");
  });

  it("已有 grant 时失败 → 原 grant 的 scope / epoch 完全不变", async () => {
    const first = await flow("records:read");
    await approve(first, ["records:read"]);

    const second = await flow("records:read coffee:read");
    await failCodeInsertFor(second.userId);
    expect((await approve(second, ["coffee:read"])).status).toBe(500);

    const grants = await grantsOf(handle.sql, first.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scopes).toEqual(["records:read"]);
    expect(grants[0]!.epoch).toBe(1);
  });
});
