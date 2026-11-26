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

describe("transaction atomic consumption (I-4)", () => {
  it("concurrent duplicate provider callbacks: exactly one consumes the transaction", async () => {
    const state = desktopState();
    const start = await startAuthorize(harness, { provider: "google", state });
    const payload = { identity: googleIdentity, nonce: start.nonce };

    // 同一个 PR.CS 的回调同时到达两次
    const [r1, r2] = await Promise.all([
      providerCallback(harness, "google", { combinedState: start.combinedState, ...payload }),
      providerCallback(harness, "google", { combinedState: start.combinedState, ...payload }),
    ]);

    // 恰好一个 302 携带授权码；另一个是可预期的 400 invalid_grant（不是 500）
    const statuses = [r1.resp.status, r2.resp.status].sort();
    expect(statuses).toEqual([302, 400]);
    const codes = [r1.code, r2.code].filter((c) => c !== null);
    expect(codes).toHaveLength(1);

    // 失败方响应体为统一 JSON 错误
    const failed = r1.resp.status === 400 ? r1.resp : r2.resp;
    const failedBody = (await failed.json()) as { error: string };
    expect(failedBody.error).toBe("invalid_grant");

    // 最多一条授权码；事务被消费；不产生重复用户
    const counts = await harness.db.sql<
      { codes: string; txs: string; users: string; identities: string }[]
    >`select
        (select count(*)::text from oauth_codes) as codes,
        (select count(*)::text from oauth_transactions) as txs,
        (select count(*)::text from users) as users,
        (select count(*)::text from user_identities) as identities`;
    expect(counts[0]).toMatchObject({ codes: "1", txs: "0", users: "1", identities: "1" });
  });
});

describe("concurrent first-time login (I-5)", () => {
  it("two authorize flows racing the same identity both succeed onto one user", async () => {
    // 两个独立授权流程（两个标签页），同一 Google 身份并发完成回调
    const identity: MockGoogleIdentity = { sub: "two-tabs-sub", email: "tabs@example.com", email_verified: true, name: "Tabs" };
    const s1 = await startAuthorize(harness, { provider: "google" });
    const s2 = await startAuthorize(harness, { provider: "google" });
    const [c1, c2] = await Promise.all([
      providerCallback(harness, "google", { combinedState: s1.combinedState, identity, nonce: s1.nonce }),
      providerCallback(harness, "google", { combinedState: s2.combinedState, identity, nonce: s2.nonce }),
    ]);

    // 两个回调都成功（23505 冲突方经重读复用，不再外泄 500）
    expect(c1.resp.status).toBe(302);
    expect(c2.resp.status).toBe(302);
    expect(c1.error).toBeNull();
    expect(c2.error).toBeNull();
    expect(c1.code).toBeTruthy();
    expect(c2.code).toBeTruthy();
    expect(c1.code).not.toBe(c2.code); // 各自独立的一次性授权码

    // 两条授权码各自兑换，落到同一个用户
    const e1 = await exchangeCode(harness, { code: c1.code ?? "", verifier: s1.verifier });
    const e2 = await exchangeCode(harness, { code: c2.code ?? "", verifier: s2.verifier });
    expect(e1.status).toBe(200);
    expect(e2.status).toBe(200);
    const t1 = (await e1.json()) as { access_token: string };
    const t2 = (await e2.json()) as { access_token: string };
    const me1 = (await (await authedGet(harness, "/auth/me", t1.access_token)).json()) as { id: string };
    const me2 = (await (await authedGet(harness, "/auth/me", t2.access_token)).json()) as { id: string };
    expect(me1.id).toBe(me2.id);

    // 最终状态：恰好 1 用户 / 1 身份 / 2 个合法会话
    const counts = await harness.db.sql<
      { users: string; identities: string; sessions: string }[]
    >`select
        (select count(*)::text from users) as users,
        (select count(*)::text from user_identities) as identities,
        (select count(*)::text from auth_sessions) as sessions`;
    expect(counts[0]).toMatchObject({ users: "1", identities: "1", sessions: "2" });
  });
});

describe("provider infrastructure failures (I-6)", () => {
  const identity: MockGoogleIdentity = { sub: "infra-fail-sub", email: "infra@example.com", email_verified: true, name: "Infra" };

  async function expectServerErrorRedirect(
    args: Pick<
      Parameters<typeof providerCallback>[2],
      "identity" | "useWrongKey" | "failToken" | "badJson" | "omitIdToken"
    > & { provider: "google" | "github" },
  ): Promise<void> {
    const provider = args.provider;
    const start = await startAuthorize(harness, { provider });
    const cb = await providerCallback(harness, provider, {
      combinedState: start.combinedState,
      identity: args.identity,
      nonce: start.nonce,
      useWrongKey: args.useWrongKey,
      failToken: args.failToken,
      badJson: args.badJson,
      omitIdToken: args.omitIdToken,
    });
    // 失败以 OAuth error 重定向（不是意外 500），且不携带授权码
    expect(cb.resp.status).toBe(302);
    expect(cb.error).toBe("server_error");
    expect(cb.code).toBeNull();
    expect(cb.clientState).toBe(start.state);
    expect(cb.location.startsWith(DESKTOP_REDIRECT)).toBe(true);
    // 事务保持已消费状态（不复活、不残留）
    const txs = await harness.db.sql<{ count: string }[]>`
      select count(*)::text as count from oauth_transactions`;
    expect(txs[0]?.count).toBe("0");
    // 用户未被创建
    const users = await harness.db.sql<{ count: string }[]>`
      select count(*)::text as count from users`;
    expect(users[0]?.count).toBe("0");
    await resetDb(harness.db);
  }

  it("google token endpoint returns malformed JSON", async () => {
    await expectServerErrorRedirect({ provider: "google", identity, badJson: true });
  });

  it("google token endpoint returns JSON without id_token", async () => {
    await expectServerErrorRedirect({ provider: "google", identity, omitIdToken: true });
  });

  it("github token endpoint returns malformed JSON", async () => {
    await expectServerErrorRedirect({ provider: "github", identity: githubIdentity, badJson: true });
  });

  it("github user API returns malformed JSON", async () => {
    await expectServerErrorRedirect({
      provider: "github",
      identity: { ...githubIdentity, badUserJson: true },
    });
  });

  it("provider endpoint unreachable (connection refused)", async () => {
    const isolated = await createHarness();
    try {
      await isolated.mockGoogle.close(); // 模拟 Provider 端口不可达
      const start = await startAuthorize(isolated, { provider: "google" });
      const cb = await providerCallback(isolated, "google", {
        combinedState: start.combinedState,
        identity,
        nonce: start.nonce,
      });
      expect(cb.resp.status).toBe(302);
      expect(cb.error).toBe("server_error");
      expect(cb.code).toBeNull();
      const txs = await isolated.db.sql<{ count: string }[]>`
        select count(*)::text as count from oauth_transactions`;
      expect(txs[0]?.count).toBe("0");
    } finally {
      await isolated.close();
    }
  });
});
