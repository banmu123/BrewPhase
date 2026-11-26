import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findOrCreateUserWithIdentity } from "../../src/users/user-service.js";
import { findIdentity, listIdentities } from "../../src/users/identity-service.js";
import { userIdentities } from "../../src/db/schema.js";
import { getTestDb, resetDb } from "../helpers/db.js";
import {
  authedGet,
  createHarness,
  fullGithubLogin,
  fullGoogleLogin,
  type Harness,
} from "../helpers/harness.js";

/**
 * 用户身份映射：身份锚点 = (provider, provider_subject)。
 * 邮箱相同绝不自动合并；GitHub 隐藏邮箱也能建立身份。
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

describe("identity mapping via full OAuth flows", () => {
  it("first Google login creates a user, second login finds the same user", async () => {
    const identity = { sub: "google-sub-1001", email: "alice@example.com", email_verified: true, name: "Alice" };

    const first = await fullGoogleLogin(harness, identity);
    const me1 = await authedGet(harness, "/auth/me", first.tokens.accessToken);
    expect(me1.status).toBe(200);
    const profile1 = (await me1.json()) as { id: string; display_name: string };
    expect(profile1.display_name).toBe("Alice");

    const second = await fullGoogleLogin(harness, identity);
    const me2 = await authedGet(harness, "/auth/me", second.tokens.accessToken);
    const profile2 = (await me2.json()) as { id: string };
    expect(profile2.id).toBe(profile1.id);

    const users = await harness.db.sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(users[0]?.count).toBe("1");
  });

  it("first GitHub login creates a user, second login finds the same user", async () => {
    const identity = { id: 2048, login: "bob", email: "bob@example.com" };

    const first = await fullGithubLogin(harness, identity);
    const me1 = await authedGet(harness, "/auth/me", first.accessToken);
    expect(me1.status).toBe(200);
    const profile1 = (await me1.json()) as { id: string; display_name: string };
    expect(profile1.display_name).toBe("bob");

    const second = await fullGithubLogin(harness, identity);
    const me2 = await authedGet(harness, "/auth/me", second.accessToken);
    const profile2 = (await me2.json()) as { id: string };
    expect(profile2.id).toBe(profile1.id);
  });

  it("same email across different providers never merges into one user", async () => {
    const googleTokens = await fullGoogleLogin(harness, {
      sub: "google-sub-same-email",
      email: "shared@example.com",
      email_verified: true,
      name: "Google Side",
    });
    const githubTokens = await fullGithubLogin(harness, {
      id: 4096,
      login: "shared-email-user",
      email: "shared@example.com",
    });

    const meG = (await (await authedGet(harness, "/auth/me", googleTokens.tokens.accessToken)).json()) as { id: string };
    const meH = (await (await authedGet(harness, "/auth/me", githubTokens.accessToken)).json()) as { id: string };

    expect(meG.id).not.toBe(meH.id);
    const users = await harness.db.sql<{ count: string }[]>`select count(*)::text as count from users`;
    expect(users[0]?.count).toBe("2");
  });

  it("GitHub hidden email still creates a usable identity", async () => {
    const tokens = await fullGithubLogin(harness, { id: 777, login: "private-emailer", email: null });
    const me = (await (await authedGet(harness, "/auth/me", tokens.accessToken)).json()) as { id: string };
    expect(me.id).toBeTruthy();

    const identities = await harness.db.sql<{ email: string | null }[]>`
      select email from user_identities where provider = 'github'`;
    expect(identities[0]?.email).toBeNull();
  });
});

describe("identity service invariants", () => {
  it("provider_subject unique constraint blocks duplicates", async () => {
    const db = (await getTestDb()).db;
    const created = await findOrCreateUserWithIdentity(db, {
      provider: "google",
      subject: "dup-sub",
      email: "dup@example.com",
      emailVerified: true,
      displayName: "Dup",
      avatarUrl: null,
    });
    expect(created.created).toBe(true);

    await expect(
      db.insert(userIdentities).values({
        userId: created.user.id,
        provider: "google",
        providerSubject: "dup-sub",
      }),
    ).rejects.toThrow();
  });

  it("findIdentity returns the mapping and listIdentities exposes it via API", async () => {
    const db = (await getTestDb()).db;
    await findOrCreateUserWithIdentity(db, {
      provider: "github",
      subject: "12345",
      email: null,
      emailVerified: false,
      displayName: "GH User",
      avatarUrl: "https://avatars.example/u/12345",
    });

    const found = await findIdentity(db, "github", "12345");
    expect(found?.provider).toBe("github");
    expect(found?.providerSubject).toBe("12345");
    expect(await findIdentity(db, "github", "other")).toBeUndefined();
    expect(await findIdentity(db, "google", "12345")).toBeUndefined();

    const tokens = await fullGithubLogin(harness, { id: 12345, login: "GH User", email: null });
    const resp = await authedGet(harness, "/auth/identities", tokens.accessToken);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      identities: { provider: string; email: string | null; email_verified: boolean }[];
    };
    expect(body.identities).toHaveLength(1);
    expect(body.identities[0]).toMatchObject({ provider: "github", email: null, email_verified: false });
    void listIdentities;
  });
});

describe("auth identities access control (I-3)", () => {
  it("active user reads identities; suspended keeps read visibility; deleted and missing user get 401", async () => {
    const { tokens } = await fullGoogleLogin(harness, {
      sub: "access-control-sub",
      email: "ac@example.com",
      email_verified: true,
      name: "Access Control",
    });
    const me = (await (await authedGet(harness, "/auth/me", tokens.accessToken)).json()) as { id: string };

    // active：正常访问
    const active = await authedGet(harness, "/auth/identities", tokens.accessToken);
    expect(active.status).toBe(200);
    expect(((await active.json()) as { identities: unknown[] }).identities).toHaveLength(1);

    // suspended：遵循现有约定（与 /auth/me 一致保留只读可见性）
    await harness.db.sql`update users set status = 'suspended' where id = ${me.id}`;
    const suspendedMe = await authedGet(harness, "/auth/me", tokens.accessToken);
    expect(suspendedMe.status).toBe(200);
    const suspendedIds = await authedGet(harness, "/auth/identities", tokens.accessToken);
    expect(suspendedIds.status).toBe(200);

    // deleted：统一 401（不再返回身份列表）
    await harness.db.sql`update users set status = 'deleted' where id = ${me.id}`;
    const deletedMe = await authedGet(harness, "/auth/me", tokens.accessToken);
    expect(deletedMe.status).toBe(401);
    const deletedIds = await authedGet(harness, "/auth/identities", tokens.accessToken);
    expect(deletedIds.status).toBe(401);

    // 用户记录不存在（行被删除）：统一 401
    await harness.db.sql`delete from users where id = ${me.id}`;
    const missingIds = await authedGet(harness, "/auth/identities", tokens.accessToken);
    expect(missingIds.status).toBe(401);
    const missingMe = await authedGet(harness, "/auth/me", tokens.accessToken);
    expect(missingMe.status).toBe(401);
  });
});

describe("concurrent first-time identity creation (I-5)", () => {
  it("parallel findOrCreateUserWithIdentity for the same subject resolves to one user", async () => {
    const db = (await getTestDb()).db;
    const identity = {
      provider: "google" as const,
      subject: "svc-concurrent-sub",
      email: "svc-concurrent@example.com",
      emailVerified: true,
      displayName: "Concurrent Creator",
      avatarUrl: null,
    };

    const [a, b] = await Promise.all([
      findOrCreateUserWithIdentity(db, identity),
      findOrCreateUserWithIdentity(db, identity),
    ]);

    // 两个并发请求都得到可预期结果，且指向同一个用户
    expect(a.user.id).toBe(b.user.id);
    expect(a.identity.providerSubject).toBe(identity.subject);
    expect(b.identity.providerSubject).toBe(identity.subject);
    expect(a.created || b.created).toBe(true);

    // 最终只存在一个 users、一条 identity（唯一约束 + 重读复用）
    const counts = await harness.db.sql<
      { users: string; identities: string }[]
    >`select
        (select count(*)::text from users) as users,
        (select count(*)::text from user_identities) as identities`;
    expect(counts[0]).toMatchObject({ users: "1", identities: "1" });
  });

  it("same email via different providers still creates two independent users", async () => {
    const db = (await getTestDb()).db;
    const email = "shared-23505@example.com";
    const a = await findOrCreateUserWithIdentity(db, {
      provider: "google",
      subject: "google-shared-email",
      email,
      emailVerified: true,
      displayName: "Google Side",
      avatarUrl: null,
    });
    const b = await findOrCreateUserWithIdentity(db, {
      provider: "github",
      subject: "github-shared-email",
      email,
      emailVerified: false,
      displayName: "GitHub Side",
      avatarUrl: null,
    });
    expect(a.user.id).not.toBe(b.user.id);
    const counts = await harness.db.sql<{ count: string }[]>`
      select count(*)::text as count from users`;
    expect(counts[0]?.count).toBe("2");
  });
});
