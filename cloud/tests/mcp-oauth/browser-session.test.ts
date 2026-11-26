import { describe, expect, it } from "vitest";
import { Hono, type Context } from "hono";
import {
  MCP_BROWSER_COOKIE_NAME,
  MCP_BROWSER_COOKIE_PATH,
  MCP_BROWSER_SESSION_KEY_MIN_BYTES,
  MCP_BROWSER_SESSION_TTL_SECONDS,
} from "../../src/mcp-oauth/constants.js";
import {
  assertBrowserSessionKey,
  browserBindingHash,
  clearBrowserSessionCookie,
  createBrowserSession,
  readBrowserSessionCookie,
  setBrowserSessionCookie,
  type BrowserSessionOptions,
} from "../../src/mcp-oauth/browser-session.js";

/**
 * 浏览器授权 Cookie（Phase 1.3.1-C1，设计 §5.3）。
 *
 * 这一组要证明两件事，缺一不可：
 * 1. **属性正确**——`Path=/mcp/oauth`（不是 `/mcp`）、HttpOnly、SameSite=Lax、
 *    30 分钟硬窗口、无 Domain。
 * 2. **失效即拒绝**——篡改、过期、畸形、sid 形态错，全部返回 `{ok:false}`，
 *    绝不降级成「匿名放行」。
 */

const KEY = "test-mcp-browser-session-key-0123456789abcdef";
const NOW = new Date("2026-05-01T12:00:00.000Z");

function opts(overrides: Partial<BrowserSessionOptions> = {}): BrowserSessionOptions {
  return { key: KEY, secure: true, now: () => NOW, ...overrides };
}

/** 建一个只有 MCP Cookie 路由的 Hono app（不挂任何业务路由）。 */
function makeApp(options: BrowserSessionOptions) {
  const app = new Hono();
  let capturedSession: ReturnType<typeof createBrowserSession> | null = null;

  app.get("/set", async (c) => {
    capturedSession = createBrowserSession(options);
    await setBrowserSessionCookie(c, capturedSession, options);
    return c.text("ok");
  });
  app.get("/read", async (c) => {
    const result = await readBrowserSessionCookie(c, options);
    return c.json(result);
  });
  app.get("/clear", (c) => {
    clearBrowserSessionCookie(c, options);
    return c.text("ok");
  });
  app.get("/set/:sid", async (c) => {
    // 用指定 sid 写 Cookie（测 sid 形态用）。
    await setBrowserSessionCookie(
      c,
      { sid: c.req.param("sid"), iat: NOW.getTime() / 1000, exp: NOW.getTime() / 1000 + 1800 },
      options,
    );
    return c.text("ok");
  });

  return { app, getSession: () => capturedSession };
}

function parseSetCookie(header: string): Record<string, string> {
  const [nameValue, ...attrs] = header.split(";").map((part) => part.trim());
  const out: Record<string, string> = {};
  const [name, ...rest] = (nameValue ?? "").split("=");
  out["__name"] = name ?? "";
  out["__value"] = rest.join("=");
  for (const attr of attrs) {
    const [k, ...v] = attr.split("=");
    out[(k ?? "").toLowerCase()] = v.length > 0 ? v.join("=") : "true";
  }
  return out;
}

describe("签发与读取", () => {
  it("正常签发：Cookie 名、值形态、属性逐项正确", async () => {
    const { app } = makeApp(opts());
    const res = await app.request("/set");
    const header = res.headers.get("set-cookie") ?? "";
    const cookie = parseSetCookie(header);

    expect(cookie.__name).toBe(MCP_BROWSER_COOKIE_NAME);
    expect(cookie.__name).toBe("bp_mcp_bs");
    // 值 = payload + "." + 签名（Hono 的签名格式）。
    expect(cookie.__value).toMatch(/^.+\./);

    expect(cookie["path"]).toBe(MCP_BROWSER_COOKIE_PATH);
    expect(cookie["path"]).toBe("/mcp/oauth");
    // **必须不是 /mcp**：Cookie 的 Path 是前缀匹配，/mcp 会把它送到数据端点。
    expect(cookie["path"]).not.toBe("/mcp");

    expect(cookie["httponly"]).toBe("true");
    expect(cookie["samesite"]).toBe("Lax");
    expect(cookie["secure"]).toBe("true");
    expect(cookie["max-age"]).toBe(String(MCP_BROWSER_SESSION_TTL_SECONDS));
    // 无 Domain：host-only，不跨子域。
    expect(cookie["domain"]).toBeUndefined();
  });

  it("正常读取：拿回同一个 sid，且 iat/exp 是 30 分钟窗口", async () => {
    const { app, getSession } = makeApp(opts());
    const setRes = await app.request("/set");
    const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const readRes = await app.request("/read", { headers: { cookie: cookieValue } });
    const body = (await readRes.json()) as { ok: boolean; session?: { sid: string; iat: number; exp: number } };

    expect(body.ok).toBe(true);
    const issued = getSession();
    expect(issued).toBeTruthy();
    expect(body.session?.sid).toBe(issued?.sid);
    expect(body.session?.sid).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 字节 base64url
    const session = body.session;
    expect(session).toBeTruthy();
    if (session) {
      expect(session.exp - session.iat).toBe(MCP_BROWSER_SESSION_TTL_SECONDS);
    }
  });

  it("Cookie 内容不含 user_id / access token / refresh token", async () => {
    const { app } = makeApp(opts());
    const setRes = await app.request("/set");
    const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // Hono 的签名 Cookie 是 `<百分号编码的明文>.<签名>`：按**最后一个**点切，
    // 因为明文本身（JSON）也可能含点号。
    const decoded = decodeURIComponent(cookieValue.slice(cookieValue.indexOf("=") + 1));
    const lastDot = decoded.lastIndexOf(".");
    const payloadPart = decoded.slice(0, lastDot);
    const payload = JSON.parse(payloadPart) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "sid"]);
    const raw = JSON.stringify(payload).toLowerCase();
    for (const forbidden of ["user", "token", "refresh", "access", "provider", "email"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("sid 每次新建都不同（32 字节密码学随机）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      seen.add(createBrowserSession(opts()).sid);
    }
    expect(seen.size).toBe(50);
  });

  it("不产生滑动续期：读取后没有再写 Set-Cookie", async () => {
    const { app } = makeApp(opts());
    const setRes = await app.request("/set");
    const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const readRes = await app.request("/read", { headers: { cookie: cookieValue } });
    // 只读：没有任何回写，30 分钟是硬窗口。
    expect(readRes.headers.get("set-cookie")).toBeNull();
  });
});

describe("失效即拒绝", () => {
  it("缺少 Cookie → ok:false / missing", async () => {
    const { app } = makeApp(opts());
    const res = await app.request("/read");
    expect(await res.json()).toEqual({ ok: false, reason: "missing" });
  });

  it("签名被篡改 → ok:false（不降级成匿名放行）", async () => {
    const { app } = makeApp(opts());
    const setRes = await app.request("/set");
    const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const [name, value = ""] = cookieValue.split("=");

    // 改签名最后两个字符。
    const tampered = `${name}=${value.slice(0, -2)}zz`;
    const res = await app.request("/read", { headers: { cookie: tampered } });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("篡改 payload（把 exp 拉长）→ 拒绝", async () => {
    const { app } = makeApp(opts());
    const setRes = await app.request("/set");
    const cookieValue = decodeURIComponent((setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "");
    const name = cookieValue.slice(0, cookieValue.indexOf("="));
    const decoded = decodeURIComponent(cookieValue.slice(cookieValue.indexOf("=") + 1));
    const lastDot = decoded.lastIndexOf(".");
    const payload = JSON.parse(decoded.slice(0, lastDot)) as { sid: string; iat: number; exp: number };
    payload.exp = payload.iat + 86_400; // 想活一天
    const forged = `${JSON.stringify(payload)}${decoded.slice(lastDot)}`;

    const res = await app.request("/read", {
      headers: { cookie: `${name}=${encodeURIComponent(forged)}` },
    });
    expect((await res.json()) as { ok: boolean }).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("过期 Cookie → ok:false / expired", async () => {
    const { app } = makeApp(opts());
    const setRes = await app.request("/set");
    const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    // 同一个 Cookie，但读取时的「现在」推到 30 分钟零 1 秒之后。
    const lateApp = makeApp(opts({ now: () => new Date(NOW.getTime() + 1801 * 1000) })).app;
    const res = await lateApp.request("/read", { headers: { cookie: cookieValue } });
    expect(await res.json()).toEqual({ ok: false, reason: "expired" });
  });

  it("窗口边界：正好 1800 秒时仍有效（exp 是排他的下界）", async () => {
    const { app } = makeApp(opts());
    const setRes = await app.request("/set");
    const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const edgeApp = makeApp(opts({ now: () => new Date(NOW.getTime() + 1800 * 1000 - 1) })).app;
    const res = await edgeApp.request("/read", { headers: { cookie: cookieValue } });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("非法 JSON / 非对象 payload → malformed", async () => {
    const options = opts();
    // 用真实的签名路径写一个「合法签名但非法内容」的 Cookie：
    // 这正是「签名对了不代表内容可信」的那条边界。
    const app = new Hono();
    app.get("/bad", async (c) => {
      const { setSignedCookie } = await import("hono/cookie");
      await setSignedCookie(c, MCP_BROWSER_COOKIE_NAME, "not-json-at-all", options.key, {
        path: MCP_BROWSER_COOKIE_PATH,
        httpOnly: true,
        secure: options.secure,
        sameSite: "Lax",
        maxAge: 1800,
      });
      return c.text("ok");
    });
    app.get("/bad-array", async (c) => {
      const { setSignedCookie } = await import("hono/cookie");
      await setSignedCookie(c, MCP_BROWSER_COOKIE_NAME, "[1,2,3]", options.key, {
        path: MCP_BROWSER_COOKIE_PATH,
        httpOnly: true,
        secure: options.secure,
        sameSite: "Lax",
        maxAge: 1800,
      });
      return c.text("ok");
    });

    for (const path of ["/bad", "/bad-array"]) {
      const setRes = await app.request(path);
      const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const readApp = makeApp(options).app;
      const res = await readApp.request("/read", { headers: { cookie: cookieValue } });
      expect(await res.json(), path).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("sid 不符合 43 字符 base64url → malformed", async () => {
    const options = opts();
    const { app } = makeApp(options);
    for (const sid of ["short", "x".repeat(44), "x".repeat(43) + "!", "../../etc/passwd"]) {
      const setRes = await app.request(`/set/${encodeURIComponent(sid)}`);
      const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const res = await app.request("/read", { headers: { cookie: cookieValue } });
      const body = (await res.json()) as { ok: boolean; reason?: string };
      expect(body.ok, `sid=${sid}`).toBe(false);
      expect(body.reason, `sid=${sid}`).toBe("malformed");
    }
  });

  it("exp - iat 超出 1800 秒 → 拒绝（防止将来换签名实现时窗口被悄悄放大）", async () => {
    const options = opts();
    const app = new Hono();
    app.get("/long", async (c) => {
      const session = { sid: createBrowserSession(options).sid, iat: 1_000_000, exp: 1_000_000 + 86_400 };
      await setBrowserSessionCookie(c, session, options);
      return c.text("ok");
    });
    const readApp = makeApp(options).app;
    const setRes = await app.request("/long");
    const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await readApp.request("/read", { headers: { cookie: cookieValue } });
    expect(await res.json()).toEqual({ ok: false, reason: "malformed" });
  });

  it("iat 超前当前时间 61 秒 → 拒绝（60 秒容差之内仍接受）", async () => {
    const options = opts();
    const nowSec = Math.floor(NOW.getTime() / 1000);
    const app = new Hono();
    const writeWithOffset = (iatOffset: number) => async (c: Context) => {
      await setBrowserSessionCookie(
        c,
        {
          sid: createBrowserSession(options).sid,
          iat: nowSec + iatOffset,
          exp: nowSec + iatOffset + MCP_BROWSER_SESSION_TTL_SECONDS,
        },
        options,
      );
      return c.text("ok");
    };
    app.get("/future-ok", writeWithOffset(30));
    app.get("/future-bad", writeWithOffset(61));

    const readApp = makeApp(options).app;
    for (const [path, expected] of [
      ["/future-ok", true],
      ["/future-bad", false],
    ] as const) {
      const setRes = await app.request(path);
      const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const res = await readApp.request("/read", { headers: { cookie: cookieValue } });
      expect(((await res.json()) as { ok: boolean }).ok, path).toBe(expected);
    }
  });
});

describe("清除", () => {
  it("清除用同一个 Path，且 Max-Age=0", async () => {
    const { app } = makeApp(opts());
    const res = await app.request("/clear");
    const cookie = parseSetCookie(res.headers.get("set-cookie") ?? "");

    expect(cookie.__name).toBe(MCP_BROWSER_COOKIE_NAME);
    // Path 必须一致：不同 Path 的 Set-Cookie 是另一个 Cookie，
    // 用默认 Path 清除会留下原来那个，于是「点完同意 Cookie 还在」。
    expect(cookie["path"]).toBe(MCP_BROWSER_COOKIE_PATH);
    expect(cookie["max-age"]).toBe("0");
    expect(cookie["httponly"]).toBe("true");
    expect(cookie["samesite"]).toBe("Lax");
  });

  it("清除后再读 → missing", async () => {
    const { app } = makeApp(opts());
    const clean = await app.request("/clear");
    const clearedValue = (clean.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await app.request("/read", { headers: { cookie: clearedValue } });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe("Secure 策略与密钥", () => {
  it("生产（secure:true）带 Secure；开发（secure:false）不带", async () => {
    const prod = await makeApp(opts({ secure: true })).app.request("/set");
    expect(prod.headers.get("set-cookie")).toContain("Secure");

    const dev = await makeApp(opts({ secure: false })).app.request("/set");
    const devCookie = dev.headers.get("set-cookie") ?? "";
    expect(devCookie).not.toContain("Secure");
    // 其余安全属性在开发环境**不能**跟着放松。
    expect(devCookie).toContain("HttpOnly");
    expect(devCookie).toContain("SameSite=Lax");
    expect(devCookie).toContain("Path=/mcp/oauth");
  });

  it("不同密钥签的 Cookie 无法互读（篡改等价）", async () => {
    const writer = makeApp(opts({ key: "a".repeat(40) })).app;
    const reader = makeApp(opts({ key: "b".repeat(40) })).app;

    const setRes = await writer.request("/set");
    const cookieValue = (setRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await reader.request("/read", { headers: { cookie: cookieValue } });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("密钥缺失或过短 → fail-closed（抛错，不降级）", () => {
    expect(() => assertBrowserSessionKey(undefined)).toThrow(/required/);
    expect(() => assertBrowserSessionKey("")).toThrow(/required/);
    expect(() => assertBrowserSessionKey("short-key")).toThrow(/at least 32 bytes/);
    // 31 字节
    expect(() => assertBrowserSessionKey("x".repeat(31))).toThrow();
    // 正好 32 字节
    expect(assertBrowserSessionKey("x".repeat(32))).toBe("x".repeat(32));
  });

  it("多字节字符按字节数算，不按字符数", () => {
    // 20 个中文字 = 60 字节 → 通过；10 个 = 30 字节 → 拒绝。
    expect(() => assertBrowserSessionKey("密".repeat(10))).toThrow();
    expect(assertBrowserSessionKey("密".repeat(20))).toHaveLength(20);
    expect(Buffer.byteLength("密".repeat(20), "utf8")).toBeGreaterThanOrEqual(
      MCP_BROWSER_SESSION_KEY_MIN_BYTES,
    );
  });

  it("setBrowserSessionCookie 在密钥无效时抛错（而不是写一个未签名的 Cookie）", async () => {
    const app = new Hono();
    app.get("/x", async (c) => {
      await setBrowserSessionCookie(
        c,
        createBrowserSession({ key: "k".repeat(32), secure: true }),
        { key: "too-short", secure: true },
      );
      return c.text("ok");
    });
    // Hono 会把处理器里的异常转成 500。关键判据不是「抛没抛」，
    // 而是**根本没有写出 Cookie** —— 一个未签名的 Cookie 比失败更糟。
    const res = await app.request("/x");
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("绑定哈希", () => {
  it("同一 sid 稳定、不同 sid 不同，且带域分隔", () => {
    const sid = createBrowserSession(opts()).sid;
    const other = createBrowserSession(opts()).sid;

    expect(browserBindingHash(sid)).toBe(browserBindingHash(sid));
    expect(browserBindingHash(sid)).not.toBe(browserBindingHash(other));
    expect(browserBindingHash(sid)).toMatch(/^[0-9a-f]{64}$/);
  });
});
