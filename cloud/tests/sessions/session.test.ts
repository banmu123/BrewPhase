import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { resetDb } from "../helpers/db.js";
import {
  authedGet,
  backdateAllRevocations,
  createHarness,
  fullGoogleLogin,
  logout,
  refresh,
  type Harness,
} from "../helpers/harness.js";

/**
 * 会话生命周期：rotation、重放检测（宽限窗口语义）、并发刷新、
 * logout 撤销整族、JWT 校验（过期 / 错误签名 / 错误 alg / 错误 iss / aud）。
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

describe("refresh token rotation", () => {
  it("normal refresh rotates the token and the old one stops working", async () => {
    const { tokens } = await fullGoogleLogin(harness, { sub: "rotate-sub", email: "r@example.com", email_verified: true, name: "R" });

    const r1 = await refresh(harness, tokens.refreshToken);
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()) as { refresh_token: string; access_token: string };
    expect(t1.refresh_token).not.toBe(tokens.refreshToken);

    // 旧 token 已轮换：宽限期内重放 → 拒绝但不撤销整族
    const replay = await refresh(harness, tokens.refreshToken);
    expect(replay.status).toBe(401);

    // 新 token 仍然可用（整族未被撤销的证据）
    const r2 = await refresh(harness, t1.refresh_token);
    expect(r2.status).toBe(200);
  });

  it("two concurrent refreshes of the same token: exactly one wins, family intact", async () => {
    const { tokens } = await fullGoogleLogin(harness, { sub: "concurrent-sub", email: "c@example.com", email_verified: true, name: "C" });

    const [a, b] = await Promise.all([
      refresh(harness, tokens.refreshToken),
      refresh(harness, tokens.refreshToken),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    // 胜者拿到的新 token 能继续刷新 → 没有误触发整族撤销
    const winnerBody = (await (a.status === 200 ? a.json() : b.json())) as { refresh_token: string };
    const r2 = await refresh(harness, winnerBody.refresh_token);
    expect(r2.status).toBe(200);

    // 审计：记录了一次 refresh_grace_reuse（并发重试被拒绝）
    const grace = await harness.db.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events where event_type = 'refresh_grace_reuse'`;
    expect(grace[0]?.count).toBe("1");
    const reuse = await harness.db.sql<{ count: string }[]>`
      select count(*)::text as count from auth_events where event_type = 'refresh_reuse_detected'`;
    expect(reuse[0]?.count).toBe("0");
  });

  it("replay beyond the grace window revokes the entire token family", async () => {
    const { tokens } = await fullGoogleLogin(harness, { sub: "reuse-sub", email: "re@example.com", email_verified: true, name: "RE" });

    const r1 = await refresh(harness, tokens.refreshToken);
    const t1 = (await r1.json()) as { refresh_token: string };

    // 回拨撤销时间到宽限期（30s）之外，模拟「时间已经过去很久的重放」
    await backdateAllRevocations(harness, 61);

    const replay = await refresh(harness, tokens.refreshToken);
    expect(replay.status).toBe(401);

    // 整族被撤销：胜者的 token 也失效
    const after = await refresh(harness, t1.refresh_token);
    expect(after.status).toBe(401);

    const events = await harness.db.sql<{ event_type: string }[]>`
      select event_type from auth_events where event_type in ('refresh_reuse_detected','session_revoked')`;
    expect(events.map((e) => e.event_type)).toContain("refresh_reuse_detected");
    expect(events.map((e) => e.event_type)).toContain("session_revoked");

    const revokedRows = await harness.db.sql<{ count: string }[]>`
      select count(*)::text as count from auth_sessions where revoked_at is not null`;
    expect(revokedRows[0]?.count).toBe("2");
  });

  it("unknown refresh token is rejected", async () => {
    const resp = await refresh(harness, "f".repeat(64));
    expect(resp.status).toBe(401);
  });
});

describe("logout", () => {
  it("logout revokes the family; refresh afterwards fails", async () => {
    const { tokens } = await fullGoogleLogin(harness, { sub: "logout-sub", email: "l@example.com", email_verified: true, name: "L" });

    // 先 rotation 一次，确保 logout 撤销的是整族（旧+新）
    const r1 = await refresh(harness, tokens.refreshToken);
    const t1 = (await r1.json()) as { refresh_token: string };

    const lo = await logout(harness, t1.refresh_token);
    expect(lo.status).toBe(200);

    const r2 = await refresh(harness, t1.refresh_token);
    expect(r2.status).toBe(401);

    const events = await harness.db.sql<{ event_type: string }[]>`
      select event_type from auth_events where event_type = 'logout'`;
    expect(events.length).toBe(1);
  });

  it("logout with an unknown token is idempotent success", async () => {
    const resp = await logout(harness, "unknown-token-value-0123456789abcdef");
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("access token (JWT) validation", () => {
  it("expired token is rejected", async () => {
    await fullGoogleLogin(harness, { sub: "jwt-sub", email: "j@example.com", email_verified: true, name: "J" });
    // 用当前密钥签一个已过期的 token
    const expired = await new SignJWT({ sid: crypto.randomUUID() })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("someone")
      .setIssuer(harness.env.baseUrl)
      .setAudience("brewphase-desktop")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .setJti("jti-expired")
      .sign(new TextEncoder().encode(harness.env.jwtSigningKey));

    const resp = await authedGet(harness, "/auth/me", expired);
    expect(resp.status).toBe(401);
  });

  it("token signed with a wrong key is rejected", async () => {
    const forged = await new SignJWT({ sid: crypto.randomUUID() })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("someone")
      .setIssuer(harness.env.baseUrl)
      .setAudience("brewphase-desktop")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setJti("jti-forged")
      .sign(new TextEncoder().encode("an-entirely-different-signing-key-value-0123456789"));

    const resp = await authedGet(harness, "/auth/me", forged);
    expect(resp.status).toBe(401);
  });

  it("token with wrong issuer or audience is rejected", async () => {
    const key = new TextEncoder().encode(harness.env.jwtSigningKey);
    const wrongIssuer = await new SignJWT({ sid: crypto.randomUUID() })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("someone")
      .setIssuer("https://evil.example.com")
      .setAudience("brewphase-desktop")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setJti("jti-iss")
      .sign(key);
    const wrongAud = await new SignJWT({ sid: crypto.randomUUID() })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("someone")
      .setIssuer(harness.env.baseUrl)
      .setAudience("other-client")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setJti("jti-aud")
      .sign(key);

    expect((await authedGet(harness, "/auth/me", wrongIssuer)).status).toBe(401);
    expect((await authedGet(harness, "/auth/me", wrongAud)).status).toBe(401);
  });

  it("alg=none token and missing bearer are rejected", async () => {
    // 手工构造 alg=none 的「JWT」
    const header = Buffer.from(JSON.stringify({ alg: "none" }), "utf8").toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "someone",
        iss: harness.env.baseUrl,
        aud: "brewphase-desktop",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        jti: "jti-none",
        sid: crypto.randomUUID(),
      }),
      "utf8",
    ).toString("base64url");
    const noneToken = `${header}.${payload}.`;
    expect((await authedGet(harness, "/auth/me", noneToken)).status).toBe(401);

    const noAuth = await harness.app.request("/auth/me");
    expect(noAuth.status).toBe(401);
    const badScheme = await harness.app.request("/auth/me", {
      headers: { authorization: "Basic abc" },
    });
    expect(badScheme.status).toBe(401);
  });

  it("previous signing key still verifies old tokens (rotation headroom)", async () => {
    // 用旧密钥签发（模拟轮换前签出的 token），新 key ring（带 previous）应能验证
    const previousKey = "the-previous-jwt-signing-key-value-0123456789abcdef";

    const { createHarness: makeIsolated } = await import("../helpers/harness.js");
    const isolated = await makeIsolated({
      jwtSigningKey: "the-current-jwt-signing-key-value-0123456789abcd",
      jwtSigningKeyPrevious: previousKey,
    });
    try {
      await resetDb(isolated.db);
      const users = await isolated.db.sql<{ id: string }[]>`
        insert into users (display_name) values ('OldKey User') returning id`;
      const userId = users[0]!.id;
      const oldToken = await new SignJWT({ sid: crypto.randomUUID() })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(userId)
        .setIssuer(isolated.env.baseUrl)
        .setAudience("brewphase-desktop")
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setJti("jti-old-key-user")
        .sign(new TextEncoder().encode(previousKey));

      const me = await authedGet(isolated, "/auth/me", oldToken);
      expect(me.status).toBe(200);
      expect(((await me.json()) as { display_name: string }).display_name).toBe("OldKey User");

      // 没有 kid 时按 current → previous 顺序尝试；换成错误密钥仍拒绝
      const forged = await new SignJWT({ sid: crypto.randomUUID() })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(userId)
        .setIssuer(isolated.env.baseUrl)
        .setAudience("brewphase-desktop")
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setJti("jti-wrong")
        .sign(new TextEncoder().encode("not-any-configured-key-0123456789abcdef"));
      expect((await authedGet(isolated, "/auth/me", forged)).status).toBe(401);
    } finally {
      await isolated.close();
    }
  });
});
