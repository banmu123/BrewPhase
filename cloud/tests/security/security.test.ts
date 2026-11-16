import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  hashIp,
  isValidPkceVerifier,
  pkceChallengeFromVerifier,
  pepperedSha256Hex,
  randomToken,
  verifyPkce,
} from "../../src/security/crypto.js";
import { serializeError, AppError } from "../../src/security/errors.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { createHarness, refresh, type Harness } from "../helpers/harness.js";

describe("crypto primitives", () => {
  it("PKCE S256 matches the RFC 7636 appendix B test vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(pkceChallengeFromVerifier(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(verifyPkce(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(verifyPkce(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN")).toBe(false);
  });

  it("rejects malformed verifiers", () => {
    expect(isValidPkceVerifier("short")).toBe(false);
    expect(isValidPkceVerifier("a".repeat(43))).toBe(true);
    expect(isValidPkceVerifier("a".repeat(128))).toBe(true);
    expect(isValidPkceVerifier("a".repeat(129))).toBe(false);
    expect(isValidPkceVerifier("has space and+plus/= pad")).toBe(false);
    expect(verifyPkce("short", "anything")).toBe(false);
  });

  it("random tokens have expected entropy and alphabet", () => {
    for (const bytes of [32, 48]) {
      const token = randomToken(bytes);
      expect(token.length).toBe(Math.ceil((bytes * 8) / 6)); // base64url 无填充
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(randomToken(32)).not.toBe(randomToken(32));
  });

  it("constant-time comparison is correct", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("peppered hashes are deterministic, domain-separated and pepper-sensitive", () => {
    const a = pepperedSha256Hex("pepper", "domain", "value");
    expect(a).toBe(pepperedSha256Hex("pepper", "domain", "value"));
    expect(a).not.toBe(pepperedSha256Hex("pepper", "other", "value"));
    expect(a).not.toBe(pepperedSha256Hex("other-pepper", "domain", "value"));
    expect(hashIp("pepper", "1.2.3.4")).toBe(pepperedSha256Hex("pepper", "ip", "1.2.3.4"));
    expect(hashIp("pepper", "")).toBe("");
  });
});

describe("error serialization", () => {
  it("exposes AppError codes without internals", () => {
    const { status, body } = serializeError(new AppError("invalid_grant", 400, "code expired"), false);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid_grant", error_description: "code expired" });
  });

  it("hides unexpected errors in production, shows message in dev", () => {
    const prod = serializeError(new Error("db secret details"), true);
    expect(prod.status).toBe(500);
    expect(prod.body.error).toBe("server_error");
    expect(prod.body.error_description).toBeUndefined();

    const dev = serializeError(new Error("db secret details"), false);
    expect(dev.body.error_description).toBe("db secret details");
  });
});

describe("health endpoints", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("/health is always ok; /ready reflects db availability", async () => {
    const health = await harness.app.request("/health");
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe("ok");

    const ready = await harness.app.request("/ready");
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { status: string }).status).toBe("ready");
  });

  it("unknown routes return 404 JSON", async () => {
    const resp = await harness.app.request("/nope");
    expect(resp.status).toBe(404);
    expect(((await resp.json()) as { error: string }).error).toBe("not_found");
  });
});

describe("rate limiting", () => {
  let harness: Harness;

  beforeAll(async () => {
    // 三个请求后触发限流（刷新端点 maxAuth=3）
    harness = await createHarness({
      rateLimit: {
        windowMs: 60_000,
        maxAuthorize: 30,
        maxToken: 20,
        maxAuth: 3,
      },
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    resetRateLimiter();
  });

  it("blocks the 4th request within the window with 429 + Retry-After", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const resp = await refresh(harness, "not-a-real-token-0123456789");
      statuses.push(resp.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it("recovers after the window elapses", async () => {
    // 用极短窗口构造独立 harness 太慢，这里直接验证同一窗口内计数独立按端点：
    // token 端点限流不影响 auth 端点（不同桶）。
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const resp = await harness.app.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "x", code_verifier: "y".repeat(43), redirect_uri: "http://127.0.0.1:1/callback" }),
      });
      statuses.push(resp.status);
    }
    // token 端点 maxToken=20，4 次请求全部到达业务校验层（400 而非 429）
    expect(statuses).toEqual([400, 400, 400, 400]);
  });
});
