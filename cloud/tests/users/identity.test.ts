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
