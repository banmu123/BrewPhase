import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../helpers/db.js";
import {
  authedGet,
  createHarness,
  DESKTOP_REDIRECT,
  desktopState,
  exchangeCode,
  fullGoogleLogin,
  providerCallback,
  startAuthorize,
  type Harness,
  type MockGithubIdentity,
  type MockGoogleIdentity,
} from "../helpers/harness.js";

/**
 * Provider 回调安全：Provider State 一次性 / 跨 Provider 隔离 / Client State
 * 篡改检测 / OIDC 验签与 nonce / 错误重定向只回合法 redirect_uri。
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

const googleIdentity: MockGoogleIdentity = {
  sub: "google-sub-callback",
  email: "cb@example.com",
  email_verified: true,
  name: "Callback Tester",
};

const githubIdentity: MockGithubIdentity = { id: 31337, login: "gh-cb" };

describe("callback: happy paths", () => {
  it("google login redirects code + original client state to desktop callback", async () => {
    const state = desktopState();
    const start = await startAuthorize(harness, { provider: "google", state });
    const cb = await providerCallback(harness, "google", {
      combinedState: start.combinedState,
      identity: googleIdentity,
      nonce: start.nonce,
    });
    expect(cb.resp.status).toBe(302);
    expect(cb.location.startsWith(DESKTOP_REDIRECT)).toBe(true);
    expect(cb.clientState).toBe(state);
    expect(cb.code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // 事务已清理
    const txs = await harness.db.sql<{ count: string }[]>`select count(*)::text as count from oauth_transactions`;
    expect(txs[0]?.count).toBe("0");
    // 授权码已落库（哈希形态），60 秒 TTL
    const codes = await harness.db.sql<{ expires_in_seconds: number }[]>`
      select extract(epoch from (expires_at - now()))::int as expires_in_seconds from oauth_codes`;
    expect(codes).toHaveLength(1);
    expect(codes[0]!.expires_in_seconds).toBeLessThanOrEqual(60);
  });

  it("github login works and never produces a nonce", async () => {
    const state = desktopState();
    const start = await startAuthorize(harness, { provider: "github", state });
    expect(start.nonce).toBeUndefined();
    const cb = await providerCallback(harness, "github", {
      combinedState: start.combinedState,
      identity: githubIdentity,
    });
    expect(cb.resp.status).toBe(302);
    expect(cb.code).toBeTruthy();

    // GitHub 资料里的 email 仅是公开资料，不标记为已验证
    const identityRows = await harness.db.sql<{ email_verified: boolean }[]>`
      select email_verified from user_identities where provider = 'github'`;
    expect(identityRows[0]?.email_verified).toBe(false);
  });
});

describe("callback: state security", () => {
  it("rejects unknown / replayed provider state with 400 JSON (no redirect)", async () => {
    const start = await startAuthorize(harness, { provider: "google" });
    const cb = await providerCallback(harness, "google", {
      combinedState: start.combinedState,
      identity: googleIdentity,
      nonce: start.nonce,
    });
    expect(cb.resp.status).toBe(302);

    // 重放：同一 state + 同一 code 再次回调
    const replay = await harness.app.request(
      `/oauth/callback/google?code=${encodeURIComponent(cb.code ?? "")}&state=${encodeURIComponent(start.combinedState)}`,
    );
    expect(replay.status).toBe(400);
    const body = (await replay.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    expect(replay.headers.get("location")).toBeNull();
  });

  it("rejects a google transaction state presented to the github callback", async () => {
    const start = await startAuthorize(harness, { provider: "google" });
    const resp = await harness.app.request(
      `/oauth/callback/github?code=x&state=${encodeURIComponent(start.combinedState)}`,
    );
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toBe("invalid_grant");
    // 事务未被误删
    const txs = await harness.db.sql<{ count: string }[]>`select count(*)::text as count from oauth_transactions`;
    expect(txs[0]?.count).toBe("1");
  });

  it("rejects tampered client state inside the provider state", async () => {
    const start = await startAuthorize(harness, { provider: "google" });
    const [providerState, _clientState] = start.combinedState.split(".") as [string, string];
    const tampered = `${providerState}.${desktopState()}`;
    const resp = await harness.app.request(
      `/oauth/callback/google?code=x&state=${encodeURIComponent(tampered)}`,
    );
    expect(resp.status).toBe(400);
    // 被篡改的事务必须被清理
    const txs = await harness.db.sql<{ count: string }[]>`select count(*)::text as count from oauth_transactions`;
    expect(txs[0]?.count).toBe("0");
  });

  it("rejects missing state", async () => {
    const resp = await harness.app.request("/oauth/callback/google?code=x");
    expect(resp.status).toBe(400);
  });
});

describe("callback: provider failures and error redirects", () => {
  it("missing code → redirect access_denied back to the stored redirect_uri", async () => {
    const state = desktopState();
    const start = await startAuthorize(harness, { provider: "google", state });
    const cb = await providerCallback(harness, "google", {
      combinedState: start.combinedState,
      identity: googleIdentity,
      omitCode: true,
    });
    expect(cb.resp.status).toBe(302);
    expect(cb.location.startsWith(DESKTOP_REDIRECT)).toBe(true);
    expect(cb.error).toBe("access_denied");
    expect(cb.clientState).toBe(state);
    // 事务已清理
    const txs = await harness.db.sql<{ count: string }[]>`select count(*)::text as count from oauth_transactions`;
    expect(txs[0]?.count).toBe("0");
  });

  it("open redirect: error redirects can only go to the stored localhost redirect_uri", async () => {
    // 事务的 redirect_uri 在 authorize 阶段被严格校验为 127.0.0.1 形态，
    // 回调的错误重定向只可能指向它 —— 攻击者无法通过回调参数注入目标地址。
    const state = desktopState();
    const start = await startAuthorize(harness, { provider: "google", state });
    const cb = await providerCallback(harness, "google", {
      combinedState: start.combinedState,
      identity: googleIdentity,
      omitCode: true,
    });
    const url = new URL(cb.location);
    expect(url.origin).toBe("http://127.0.0.1:51743");
    expect(url.pathname).toBe("/callback");
  });

  it("google ID token signed by an unknown key → redirect server_error", async () => {
    const start = await startAuthorize(harness, { provider: "google" });
    const cb = await providerCallback(harness, "google", {
      combinedState: start.combinedState,
      identity: googleIdentity,
      nonce: start.nonce,
      useWrongKey: true,
    });
    expect(cb.resp.status).toBe(302);
    expect(cb.error).toBe("server_error");
    expect(cb.code).toBeNull();
    // 用户未被创建
    const users = await harness.db.sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(users[0]?.count).toBe("0");
  });

  it("google ID token with mismatched nonce → redirect server_error", async () => {
    const start = await startAuthorize(harness, { provider: "google" });
    const cb = await providerCallback(harness, "google", {
      combinedState: start.combinedState,
      identity: googleIdentity,
      nonce: "attacker-chosen-nonce-value-123456789012345678901234",
    });
    expect(cb.error).toBe("server_error");
    expect(cb.code).toBeNull();
  });

  it("provider token endpoint failure → redirect server_error", async () => {
    const start = await startAuthorize(harness, { provider: "google" });
    const cb = await providerCallback(harness, "google", {
      combinedState: start.combinedState,
      identity: googleIdentity,
      nonce: start.nonce,
      failToken: true,
    });
    expect(cb.error).toBe("server_error");
  });

  it("suspended account cannot sign in → redirect access_denied", async () => {
    // 先正常登录建立身份
    const { tokens } = await fullGoogleLogin(harness, googleIdentity);
    const me = (await (await authedGet(harness, "/auth/me", tokens.accessToken)).json()) as { id: string };

    // 挂起用户
    await harness.db.sql`update users set status = 'suspended' where id = ${me.id}`;

    // 再次登录被拒绝
    const state = desktopState();
    const start = await startAuthorize(harness, { provider: "google", state });
    const cb = await providerCallback(harness, "google", {
      combinedState: start.combinedState,
      identity: googleIdentity,
      nonce: start.nonce,
    });
    expect(cb.error).toBe("access_denied");
    expect(cb.code).toBeNull();

    // 安全事件：login_failed 已记录
    const events = await harness.db.sql<{ event_type: string }[]>`
      select event_type from auth_events where event_type = 'login_failed'`;
    expect(events.length).toBeGreaterThan(0);

    // 已签发的旧 access token 仍可读 profile（status=suspended 暴露给客户端）
    const meAfter = await authedGet(harness, "/auth/me", tokens.accessToken);
    expect(meAfter.status).toBe(200);
    expect(((await meAfter.json()) as { status: string }).status).toBe("suspended");
    void exchangeCode;
  });
});
