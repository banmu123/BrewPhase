import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isValidLocalCallbackUri } from "../../src/security/crypto.js";
import { resetDb } from "../helpers/db.js";
import {
  createHarness,
  DESKTOP_REDIRECT,
  desktopPkce,
  desktopState,
  startAuthorize,
  type Harness,
} from "../helpers/harness.js";

/**
 * /oauth/authorize 入口安全：
 * redirect_uri 白名单、client state 强度、PKCE S256 形态、provider 白名单。
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

describe("authorize: provider validation", () => {
  it("rejects unknown providers with 400 JSON (no redirect)", async () => {
    const resp = await startAuthorize(harness, { provider: "twitter" }).then((r) => r.resp);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("unsupported_provider");
    expect(resp.headers.get("location")).toBeNull();
  });

  it("rejects unconfigured providers", async () => {
    const { createHarness: makeIsolated } = await import("../helpers/harness.js");
    // 未配置 Google 凭据 → provider 不注册
    const isolated = await makeIsolated({
      googleClientId: undefined,
      googleClientSecret: undefined,
    });
    try {
      const start = await startAuthorize(isolated, { provider: "google" });
      expect(start.resp.status).toBe(400);
      const body = (await start.resp.json()) as { error: string };
      expect(body.error).toBe("provider_not_configured");
    } finally {
      await isolated.close();
    }
  });
});

describe("authorize: client state strength", () => {
  it("rejects short/missing state", async () => {
    for (const state of ["", "short-state", "a".repeat(31), "with space not allowed!"]) {
      const resp = await startAuthorize(harness, { state }).then((r) => r.resp);
      expect(resp.status).toBe(400);
      expect(((await resp.json()) as { error: string }).error).toBe("invalid_request");
    }
  });

  it("accepts a 43+ char base64url state", async () => {
    const start = await startAuthorize(harness, { state: desktopState() });
    expect(start.resp.status).toBe(302);
  });
});

describe("authorize: PKCE S256 only", () => {
  it("rejects malformed challenges", async () => {
    for (const challenge of ["", "plain", "a".repeat(42), "a".repeat(44), "has+plus/and="]) {
      const resp = await startAuthorize(harness, { challenge }).then((r) => r.resp);
      expect(resp.status).toBe(400);
    }
  });

  it("accepts a proper 43-char S256 challenge and includes nonce for google", async () => {
    const { challenge } = desktopPkce();
    const start = await startAuthorize(harness, { provider: "google", challenge });
    expect(start.resp.status).toBe(302);
    expect(start.nonce).toBeTruthy();
    expect(start.combinedState).toContain(".");
    // 授权 URL 指向 mock Google 并携带 openid email profile
    expect(start.authorizeUrl?.searchParams.get("scope")).toBe("openid email profile");
    expect(start.authorizeUrl?.searchParams.get("response_type")).toBe("code");
  });

  it("github authorize URL has no nonce", async () => {
    const start = await startAuthorize(harness, { provider: "github" });
    expect(start.resp.status).toBe(302);
    expect(start.nonce).toBeUndefined();
  });
});

describe("authorize: strict localhost redirect_uri whitelist", () => {
  const badRedirectUris = [
    "https://evil.example.com/callback",
    "http://localhost:1234/callback",
    "http://127.0.0.1:70000/callback",
    "http://127.0.0.1:0/callback",
    "http://127.0.0.1:8080/other",
    "http://127.0.0.1:8080/callback?extra=1",
    "http://127.0.0.1:8080/callback#fragment",
    "http://user@127.0.0.1:8080/callback",
    "http://0.0.0.0:8080/callback",
    "http://[::1]:8080/callback",
    "http://127.0.0.1:8080/callback/",
    "",
    "not a url",
  ];

  it.each(badRedirectUris)("rejects redirect_uri %j", async (redirectUri) => {
    const resp = await startAuthorize(harness, { redirectUri }).then((r) => r.resp);
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toBe("invalid_request");
    expect(resp.headers.get("location")).toBeNull();
  });

  it("accepts the standard desktop callback form", () => {
    expect(isValidLocalCallbackUri(DESKTOP_REDIRECT)).toBe(true);
    expect(isValidLocalCallbackUri("http://127.0.0.1:1/callback")).toBe(true);
    expect(isValidLocalCallbackUri("http://127.0.0.1:65535/callback")).toBe(true);
  });

  it("valid redirect creates a transaction bound to the request parameters", async () => {
    const state = desktopState();
    const { challenge } = desktopPkce();
    const start = await startAuthorize(harness, { state, challenge });
    expect(start.resp.status).toBe(302);
    const rows = await harness.db.sql<{ redirect_uri: string; code_challenge: string }[]>`
      select redirect_uri, code_challenge from oauth_transactions`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.redirect_uri).toBe(DESKTOP_REDIRECT);
    expect(rows[0]?.code_challenge).toBe(challenge);
  });
});
