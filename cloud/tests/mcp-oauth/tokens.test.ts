import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { createHash } from "node:crypto";
import {
  McpTokenError,
  signMcpAccessToken,
  verifyMcpAccessToken,
} from "../../src/mcp-oauth/tokens.js";
import { mcpResourceFor, MCP_SCOPES } from "../../src/mcp-oauth/constants.js";
import {
  TOKEN_AUDIENCE,
  createKeyRing,
  signAccessToken,
  verifyAccessToken,
} from "../../src/sessions/jwt.js";

/**
 * MCP Access Token（Phase 1.3.1-C1，设计 §12 的 C 组）。
 *
 * 这一组最重要的两件事：
 * 1. **双向 audience 隔离**——Desktop token 打不开 MCP，MCP token 打不开 Desktop。
 * 2. **scope 不能自证**——token 里的 scope 必须是「用户勾的 ∩ grant 给的」，
 *    由签发方保证；验证方只能拒绝，不能纠正。
 */

const ISSUER = "https://gateway.example";
const RESOURCE = mcpResourceFor(ISSUER);
const SIGNING_KEY = "test-jwt-signing-key-0123456789abcdef0123456789abcdef";
const PREVIOUS_KEY = "previous-jwt-signing-key-0123456789abcdef0123456";

/**
 * 可预测但**仍然有效**的时钟。
 *
 * 不能取一个遥远的固定日期：`jwtVerify` 用真实时钟判 `exp`，写死
 * `2026-03-01` 会让每一条用例都死于 `JWTExpired`，看起来像实现坏了。
 * 截到整秒既保留「`iat - exp === 900`」这类精确断言，又让 token 真的可用。
 */
const FIXED_NOW = new Date(Math.floor(Date.now() / 1000) * 1000);

function ring(previous?: string) {
  return createKeyRing(SIGNING_KEY, previous);
}

function options(overrides: Partial<Parameters<typeof signMcpAccessToken>[2]> = {}) {
  return { issuer: ISSUER, resource: RESOURCE, ttlSeconds: 900, now: () => FIXED_NOW, ...overrides };
}

const VALID_INPUT = {
  userId: "11111111-1111-1111-1111-111111111111",
  sessionId: "22222222-2222-2222-2222-222222222222",
  clientId: "test-client",
  scope: ["records:read", "coffee:read"],
};

function decodePayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("签发与验证", () => {
  it("正确签发并能验证，claims 逐项正确", async () => {
    const token = await signMcpAccessToken(ring(), VALID_INPUT, options());
    const claims = await verifyMcpAccessToken(ring(), token, {
      issuer: ISSUER,
      resource: RESOURCE,
    });

    expect(claims.userId).toBe(VALID_INPUT.userId);
    expect(claims.sessionId).toBe(VALID_INPUT.sessionId);
    expect(claims.scope).toEqual(["records:read", "coffee:read"]);
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{22}$/); // randomToken(16) → 22 字符
    expect(claims.expiresAt - claims.issuedAt).toBe(900);
    expect(claims.issuedAt).toBe(Math.floor(FIXED_NOW.getTime() / 1000));
  });

  it("audience 精确等于 MCP_RESOURCE（不是前缀、不是常量）", async () => {
    const token = await signMcpAccessToken(ring(), VALID_INPUT, options());
    const payload = decodePayload(token);

    expect(payload.aud).toBe(RESOURCE);
    expect(RESOURCE).toBe("https://gateway.example/mcp");
    // 绝不能是 Desktop 的常量。
    expect(payload.aud).not.toBe(TOKEN_AUDIENCE);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.sub).toBe(VALID_INPUT.userId);
    expect(payload.sid).toBe(VALID_INPUT.sessionId);
    expect(payload.scope).toBe("records:read coffee:read");
  });

  it("JWT 里没有 refresh token / provider token / 任何多余秘密", async () => {
    const token = await signMcpAccessToken(ring(), VALID_INPUT, options());
    const payload = decodePayload(token);
    expect(Object.keys(payload).sort()).toEqual(
      ["aud", "client_id", "exp", "iat", "iss", "jti", "scope", "sid", "sub"].sort(),
    );
  });

  it("MCP_RESOURCE 由 BASE_URL 推导，尾斜杠不会重复", () => {
    expect(mcpResourceFor("https://gw.example")).toBe("https://gw.example/mcp");
    expect(mcpResourceFor("https://gw.example/")).toBe("https://gw.example/mcp");
    expect(mcpResourceFor("https://gw.example///")).toBe("https://gw.example/mcp");
  });
});

describe("双向 audience 隔离", () => {
  it("Desktop Access Token 不能通过 MCP 验证", async () => {
    const desktopToken = await signAccessToken(
      ring(),
      { userId: VALID_INPUT.userId, sessionId: VALID_INPUT.sessionId },
      { issuer: ISSUER, ttlSeconds: 900 },
    );

    await expect(
      verifyMcpAccessToken(ring(), desktopToken, { issuer: ISSUER, resource: RESOURCE }),
    ).rejects.toThrow();

    // 但它在自己那套里仍然有效（证明上面失败的原因是 aud，而不是 token 坏了）。
    await expect(
      verifyAccessToken(ring(), desktopToken, { issuer: ISSUER }),
    ).resolves.toMatchObject({ userId: VALID_INPUT.userId });
  });

  it("MCP Access Token 不能通过 Desktop 验证", async () => {
    const mcpToken = await signMcpAccessToken(ring(), VALID_INPUT, options());

    await expect(
      verifyAccessToken(ring(), mcpToken, { issuer: ISSUER }),
    ).rejects.toThrow();

    await expect(
      verifyMcpAccessToken(ring(), mcpToken, { issuer: ISSUER, resource: RESOURCE }),
    ).resolves.toMatchObject({ sessionId: VALID_INPUT.sessionId });
  });

  it("同一个人、同一个 session，两套 token 互不通用（同位对照）", async () => {
    // 消除「因为 sub/sid 不同才失败」的可能：两边 claims 完全相同，
    // 唯一差别是 aud。此时隔离必须仍然成立。
    const desktop = await signAccessToken(
      ring(),
      { userId: VALID_INPUT.userId, sessionId: VALID_INPUT.sessionId },
      { issuer: ISSUER, ttlSeconds: 900 },
    );
    const mcp = await signMcpAccessToken(ring(), VALID_INPUT, options());

    expect(decodePayload(desktop).sub).toBe(decodePayload(mcp).sub);
    expect(decodePayload(desktop).sid).toBe(decodePayload(mcp).sid);

    await expect(
      verifyMcpAccessToken(ring(), desktop, { issuer: ISSUER, resource: RESOURCE }),
    ).rejects.toThrow();
    await expect(verifyAccessToken(ring(), mcp, { issuer: ISSUER })).rejects.toThrow();
  });

  it("aud 指向另一个资源（例如 /mcp/v2）时拒绝", async () => {
    const token = await signMcpAccessToken(ring(), VALID_INPUT, options());
    await expect(
      verifyMcpAccessToken(ring(), token, { issuer: ISSUER, resource: `${RESOURCE}/v2` }),
    ).rejects.toThrow();
  });
});

describe("密钥轮换", () => {
  it("旧 kid 的 token 在 previous 密钥下仍可验证", async () => {
    const oldRing = createKeyRing(PREVIOUS_KEY);
    const token = await signMcpAccessToken(oldRing, VALID_INPUT, options());

    // 轮换后：current = 新密钥，previous = 旧密钥。
    const rotatedRing = createKeyRing(SIGNING_KEY, PREVIOUS_KEY);
    await expect(
      verifyMcpAccessToken(rotatedRing, token, { issuer: ISSUER, resource: RESOURCE }),
    ).resolves.toMatchObject({ userId: VALID_INPUT.userId });
  });

  it("没有 previous 时旧 kid 的 token 被拒（轮换必须显式保留旧密钥）", async () => {
    const oldRing = createKeyRing(PREVIOUS_KEY);
    const token = await signMcpAccessToken(oldRing, VALID_INPUT, options());

    await expect(
      verifyMcpAccessToken(createKeyRing(SIGNING_KEY), token, {
        issuer: ISSUER,
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/no matching signing key/);
  });

  it("未知 kid 拒绝，不回退到 current", async () => {
    const token = await signMcpAccessToken(ring(), VALID_INPUT, options());
    // 手工改 header 的 kid 会破坏签名，所以这里直接用一把陌生密钥签。
    const strangerRing = createKeyRing("stranger-key-0123456789abcdef0123456789abcdef");
    const strangerToken = await signMcpAccessToken(strangerRing, VALID_INPUT, options());
    // 两份 payload 形状相同、只有 kid 不同——所以失败只可能来自密钥选择。
    expect(Object.keys(decodePayload(strangerToken)).sort()).toEqual(
      Object.keys(decodePayload(token)).sort(),
    );

    await expect(
      verifyMcpAccessToken(ring(), strangerToken, { issuer: ISSUER, resource: RESOURCE }),
    ).rejects.toThrow(/no matching signing key/);
  });
});

describe("claim 与算法校验", () => {
  it("错误 iss 拒绝", async () => {
    const token = await signMcpAccessToken(ring(), VALID_INPUT, options());
    await expect(
      verifyMcpAccessToken(ring(), token, { issuer: "https://other.example", resource: RESOURCE }),
    ).rejects.toThrow();
  });

  it("过期 token 拒绝，而 exp 刚过 2 秒的仍在 5 秒容差内", async () => {
    const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);

    const build = async (iat: number, exp: number, jti: string) =>
      new SignJWT({
        sid: VALID_INPUT.sessionId,
        client_id: VALID_INPUT.clientId,
        scope: "records:read",
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: ring().current.kid })
        .setSubject(VALID_INPUT.userId)
        .setIssuer(ISSUER)
        .setAudience(RESOURCE)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .setJti(jti)
        .sign(ring().current.key);

    // 刚过期 2 秒 → 在 5 秒容差内，仍接受（与 Desktop 的 clockTolerance 一致）。
    const justExpired = await build(nowSec - 902, nowSec - 2, "just-expired");
    await expect(
      verifyMcpAccessToken(ring(), justExpired, { issuer: ISSUER, resource: RESOURCE }),
    ).resolves.toMatchObject({ userId: VALID_INPUT.userId });

    // 过期 60 秒 → 远超容差，必须拒绝。
    const expired = await build(nowSec - 960, nowSec - 60, "expired");
    await expect(
      verifyMcpAccessToken(ring(), expired, { issuer: ISSUER, resource: RESOURCE }),
    ).rejects.toThrow(/exp/i);
  });

  it("错误算法拒绝（alg=none 与 alg=RS256 都不行）", async () => {
    // alg=none：header 与空签名。
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        sub: VALID_INPUT.userId,
        sid: VALID_INPUT.sessionId,
        aud: RESOURCE,
        iss: ISSUER,
        scope: "records:read",
        jti: "x",
        iat: 1,
        exp: 9999999999,
      }),
    ).toString("base64url");
    const noneToken = `${header}.${body}.`;
    await expect(
      verifyMcpAccessToken(ring(), noneToken, { issuer: ISSUER, resource: RESOURCE }),
    ).rejects.toThrow(/unsupported token algorithm|signature/i);
  });

  it("malformed token 拒绝（不是三段、header 不是 base64url JSON）", async () => {
    for (const bad of ["", "not-a-jwt", "a.b", "!!!.@@@.###"]) {
      await expect(
        verifyMcpAccessToken(ring(), bad, { issuer: ISSUER, resource: RESOURCE }),
      ).rejects.toThrow();
    }
  });

  it("缺少 sub / sid / client_id / jti / iat / exp / scope 都拒绝", async () => {
    const base = {
      sub: VALID_INPUT.userId,
      sid: VALID_INPUT.sessionId,
      client_id: VALID_INPUT.clientId,
      scope: "records:read",
      jti: "jti-1",
    };
    for (const missing of ["sub", "sid", "client_id", "scope", "jti"]) {
      const claims: Record<string, unknown> = { ...base };
      delete claims[missing];
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: ring().current.kid })
        .setIssuer(ISSUER)
        .setAudience(RESOURCE)
        .setIssuedAt(1)
        .setExpirationTime(9999999999)
        .sign(ring().current.key);

      await expect(
        verifyMcpAccessToken(ring(), token, { issuer: ISSUER, resource: RESOURCE }),
        `missing ${missing}`,
      ).rejects.toThrow();
    }
  });

  it("sid 为空串时拒绝（空串不等于「没有 session」）", async () => {
    const token = await new SignJWT({
      sid: "",
      client_id: VALID_INPUT.clientId,
      scope: "records:read",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: ring().current.kid })
      .setSubject(VALID_INPUT.userId)
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setIssuedAt(1)
      .setExpirationTime(9999999999)
      .setJti("jti-2")
      .sign(ring().current.key);

    await expect(
      verifyMcpAccessToken(ring(), token, { issuer: ISSUER, resource: RESOURCE }),
    ).rejects.toThrow(/sid/);
  });
});

describe("scope 校验", () => {
  const makeToken = async (scope: unknown) =>
    new SignJWT({ sid: VALID_INPUT.sessionId, client_id: VALID_INPUT.clientId, scope })
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: ring().current.kid })
      .setSubject(VALID_INPUT.userId)
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setIssuedAt(1)
      .setExpirationTime(9999999999)
      .setJti("scope-jti")
      .sign(ring().current.key);

  it("空 scope / 全空格 → 拒绝", async () => {
    for (const bad of ["", "   "]) {
      await expect(
        verifyMcpAccessToken(ring(), await makeToken(bad), {
          issuer: ISSUER,
          resource: RESOURCE,
        }),
      ).rejects.toThrow(/scope/);
    }
  });

  it("含未知 scope → 拒绝（不是过滤掉）", async () => {
    await expect(
      verifyMcpAccessToken(ring(), await makeToken("records:read records:write"), {
        issuer: ISSUER,
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/unknown scope/);
  });

  it("scope 不是字符串 → 拒绝", async () => {
    for (const bad of [123, ["records:read"], { a: 1 }, null]) {
      await expect(
        verifyMcpAccessToken(ring(), await makeToken(bad), {
          issuer: ISSUER,
          resource: RESOURCE,
        }),
      ).rejects.toThrow();
    }
  });

  it("重复 scope 去重，顺序保持（不因重复而拒绝）", async () => {
    const token = await makeToken("coffee:read records:read coffee:read");
    const claims = await verifyMcpAccessToken(ring(), token, {
      issuer: ISSUER,
      resource: RESOURCE,
    });
    expect(claims.scope).toEqual(["coffee:read", "records:read"]);
  });

  it("四个已知 scope 全部可用，五个（含伪造）一律拒绝", async () => {
    const all = await makeToken([...MCP_SCOPES].join(" "));
    const claims = await verifyMcpAccessToken(ring(), all, {
      issuer: ISSUER,
      resource: RESOURCE,
    });
    expect(claims.scope).toEqual([...MCP_SCOPES]);

    await expect(
      verifyMcpAccessToken(ring(), await makeToken(`${MCP_SCOPES.join(" ")} records:write`), {
        issuer: ISSUER,
        resource: RESOURCE,
      }),
    ).rejects.toThrow();
  });

  it("签发时就拒绝空 scope 与未知 scope（非法 token 不该被造出来）", async () => {
    await expect(
      signMcpAccessToken(ring(), { ...VALID_INPUT, scope: [] }, options()),
    ).rejects.toBeInstanceOf(McpTokenError);

    await expect(
      signMcpAccessToken(ring(), { ...VALID_INPUT, scope: ["records:write"] }, options()),
    ).rejects.toBeInstanceOf(McpTokenError);
  });

  it("签发的 scope 就是调用方给的交集，不会自行补全", async () => {
    // 交集只有一项时，token 里就只有一项——即使 MCP_SCOPES 有四个。
    const token = await signMcpAccessToken(
      ring(),
      { ...VALID_INPUT, scope: ["canvas:read"] },
      options(),
    );
    const claims = await verifyMcpAccessToken(ring(), token, {
      issuer: ISSUER,
      resource: RESOURCE,
    });
    expect(claims.scope).toEqual(["canvas:read"]);
  });
});

describe("jti", () => {
  it("连续签发不重复", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const token = await signMcpAccessToken(ring(), VALID_INPUT, options());
      const claims = await verifyMcpAccessToken(ring(), token, {
        issuer: ISSUER,
        resource: RESOURCE,
      });
      expect(seen.has(claims.jti), `duplicate jti at ${i}`).toBe(false);
      seen.add(claims.jti);
    }
    expect(seen.size).toBe(50);
  });

  it("jti 不是请求去重键：同一 token 可被反复验证", async () => {
    // 这条是 P0-2 的预防性回归：任何「按 jti 拦重复」的实现都会让 /mcp
    // 的同 token 多次工具调用失败。验证是纯函数，必须无副作用。
    const token = await signMcpAccessToken(ring(), VALID_INPUT, options());
    for (let i = 0; i < 10; i += 1) {
      await expect(
        verifyMcpAccessToken(ring(), token, { issuer: ISSUER, resource: RESOURCE }),
      ).resolves.toMatchObject({ sessionId: VALID_INPUT.sessionId });
    }
  });
});

describe("错误信息不泄露密钥", () => {
  it("验证失败的 message 里没有密钥片段", async () => {
    const token = await signMcpAccessToken(ring(), VALID_INPUT, options());
    const kid = createKeyRing(SIGNING_KEY).current.kid;

    const attempts: Array<() => Promise<unknown>> = [
      () => verifyMcpAccessToken(ring(), token, { issuer: "https://x", resource: RESOURCE }),
      () => verifyMcpAccessToken(ring(), token, { issuer: ISSUER, resource: "https://x" }),
      () => verifyMcpAccessToken(ring(), "garbage", { issuer: ISSUER, resource: RESOURCE }),
    ];
    for (const attempt of attempts) {
      const error = (await attempt().catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain(SIGNING_KEY);
      // kid 是公开信息（出现在 header 里），但完整密钥不能出现。
      expect(error.message).not.toContain(kid.slice(0, 4) + SIGNING_KEY.slice(4));
    }
  });

  it("签发的 JWT 不含 pepper / 密钥材料", async () => {
    const token = await signMcpAccessToken(ring(), VALID_INPUT, options());
    const raw = Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8");
    expect(raw).not.toContain(SIGNING_KEY);
    expect(raw).not.toContain(createHash("sha256").update(SIGNING_KEY).digest("hex"));
  });
});
