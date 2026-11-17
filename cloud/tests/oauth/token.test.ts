import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../helpers/db.js";
import {
  authedGet,
  backdateAllOauthCodes,
  createHarness,
  desktopPkce,
  desktopState,
  exchangeCode,

  providerCallback,
  startAuthorize,
  type Harness,
} from "../helpers/harness.js";

/**
 * /oauth/token：授权码一次性语义 + PKCE + redirect_uri 绑定。
 */

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await resetDb(harness.db);
});

/** 走完整流程拿一个「可消费」的授权码。 */
async function issueFreshCode(h: Harness): Promise<{ code: string; verifier: string }> {
  const state = desktopState();
  const { verifier, challenge } = desktopPkce();
  const start = await startAuthorize(h, { provider: "google", state, challenge });
  const cb = await providerCallback(h, "google", {
    combinedState: start.combinedState,
    identity: { sub: "token-flow-sub", email: "token@example.com", email_verified: true, name: "T" },
    nonce: start.nonce,
  });
  if (!cb.code) throw new Error(`callback failed: ${cb.error} ${cb.errorDescription}`);
  return { code: cb.code, verifier };
}

describe("token exchange", () => {
  it("valid exchange issues a working JWT access token", async () => {
    const { code, verifier } = await issueFreshCode(harness);
    const resp = await exchangeCode(harness, { code, verifier });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(harness.env.accessTokenTtlSeconds);
    expect(body.refresh_token.length).toBeGreaterThanOrEqual(43);

    const me = await authedGet(harness, "/auth/me", body.access_token);
    expect(me.status).toBe(200);
    const profile = (await me.json()) as { email?: string; display_name: string };
    expect(profile.display_name).toBe("T");
  });

  it("accepts form-urlencoded bodies (OAuth convention)", async () => {
    const { code, verifier } = await issueFreshCode(harness);
    const resp = await exchangeCode(harness, { code, verifier, formEncoded: true });
    expect(resp.status).toBe(200);
  });

  it("rejects a wrong PKCE verifier and burns the code", async () => {
    const { code, verifier } = await issueFreshCode(harness);
    const bad = await exchangeCode(harness, { code, verifier: "A".repeat(64) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");

    // 授权码已被销毁：正确的 verifier 也不能再用
    const retry = await exchangeCode(harness, { code, verifier });
    expect(retry.status).toBe(400);
    expect(((await retry.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects redirect_uri mismatch", async () => {
    const { code, verifier } = await issueFreshCode(harness);
    const resp = await exchangeCode(harness, {
      code,
      verifier,
      redirectUri: "http://127.0.0.1:9999/callback",
    });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toBe("invalid_grant");

    // 绑定被破坏的授权码同样销毁
    const retry = await exchangeCode(harness, { code, verifier });
    expect(retry.status).toBe(400);
  });

  it("rejects expired codes", async () => {
    const { code, verifier } = await issueFreshCode(harness);
    await backdateAllOauthCodes(harness, 120);
    const resp = await exchangeCode(harness, { code, verifier });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error_description?: string }).error_description).toContain("expired");
  });

  it("rejects double consumption (sequential)", async () => {
    const { code, verifier } = await issueFreshCode(harness);
    const first = await exchangeCode(harness, { code, verifier });
    expect(first.status).toBe(200);
    const second = await exchangeCode(harness, { code, verifier });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error_description?: string }).error_description).toContain("consumed");
  });

  it("two concurrent exchanges of the same code yield exactly one success", async () => {
    const { code, verifier } = await issueFreshCode(harness);
    const [a, b] = await Promise.all([
      exchangeCode(harness, { code, verifier }),
      exchangeCode(harness, { code, verifier }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);

    const sessions = await harness.db.sql<{ count: string }[]>`select count(*)::text as count from auth_sessions`;
    expect(sessions[0]?.count).toBe("1");
  });

  it("rejects unknown codes and malformed requests", async () => {
    const resp = await exchangeCode(harness, { code: "nonexistent", verifier: "v".repeat(64) });
    expect(resp.status).toBe(400);

    const missing = await harness.app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x" }),
    });
    expect(missing.status).toBe(400);
  });
});
