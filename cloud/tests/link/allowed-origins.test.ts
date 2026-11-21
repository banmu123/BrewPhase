import { describe, expect, it } from "vitest";
import { resolveWebSocketAllowedOrigins } from "../../src/link/allowed-origins.js";

/**
 * `BASE_URL Origin ∪ CORS_ORIGINS` 的白名单构造（Phase 1.3.3-A-R2）。
 *
 * 这一层是**纯函数**，所以边界可以逐条钉死而不用起真实服务器：
 * 通配、path、query、端口、子域名冒充——任何一条漏掉，都会变成
 * 「配置看起来对、实际放行了不该放行的 Origin」。
 *
 * 真实 Upgrade 侧的行为（含恶意 Origin 403）由
 * `tests/link/link-server.test.ts` 的 A3 组覆盖。
 */

describe("resolveWebSocketAllowedOrigins", () => {
  it("BASE_URL Origin 自动进白名单（corsOrigins 为空也不退化）", () => {
    expect(resolveWebSocketAllowedOrigins("http://127.0.0.1:3000", [])).toEqual([
      "http://127.0.0.1:3000",
    ]);
    expect(resolveWebSocketAllowedOrigins("https://cloud.brewphase.app", [])).toEqual([
      "https://cloud.brewphase.app",
    ]);
  });

  it("合并额外 CORS Origins，且不修改传入数组", () => {
    const extra = ["https://a.example", "https://b.example"];
    const snapshot = [...extra];
    const result = resolveWebSocketAllowedOrigins("http://127.0.0.1:3000", extra);
    expect(result).toEqual([
      "http://127.0.0.1:3000",
      "https://a.example",
      "https://b.example",
    ]);
    // 纯函数：不能就地 sort / push / splice 调用方的 env 数组。
    expect(extra).toEqual(snapshot);
  });

  it("重复 Origin 只保留一个", () => {
    const result = resolveWebSocketAllowedOrigins("https://cloud.brewphase.app", [
      "https://cloud.brewphase.app",
      "https://cloud.brewphase.app",
      "  https://cloud.brewphase.app  ",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("https://cloud.brewphase.app");
  });

  it("BASE_URL 与 CORS 里同一个 Origin 也只留一个", () => {
    const result = resolveWebSocketAllowedOrigins("https://x.example", ["https://x.example"]);
    expect(result).toEqual(["https://x.example"]);
  });

  it("大小写与默认端口归一化后能与浏览器发的 Origin 对上", () => {
    // 浏览器发的 Origin 是小写、去默认端口的形态。
    expect(resolveWebSocketAllowedOrigins("HTTPS://Cloud.Example:443", [])).toEqual([
      "https://cloud.example",
    ]);
    expect(resolveWebSocketAllowedOrigins("http://127.0.0.1:80", [])).toEqual([
      "http://127.0.0.1",
    ]);
  });

  it("BASE_URL 非法时抛错，绝不退化成空白名单或放行所有", () => {
    // 静默返回 [] = 关掉这层边界；静默返回 ['*'] = 直接破边界。都必须炸。
    for (const bad of ["", "   ", "not a url", "ftp://x.example", "*", "file:///tmp/x"]) {
      expect(() => resolveWebSocketAllowedOrigins(bad, []), JSON.stringify(bad)).toThrow();
    }
  });

  it("CORS 条目里的通配 / path / query / fragment 一律抛错", () => {
    const base = "https://cloud.brewphase.app";
    const bad: Array<[string, string]> = [
      ["通配域名", "https://*.example.com"],
      ["裸通配", "*"],
      ["带 path", "https://example.com/callback"],
      ["带 query", "https://example.com?x=1"],
      ["带 fragment", "https://example.com#f"],
      ["非 http(s)", "ws://example.com"],
      ["带 userinfo", "https://user:pass@example.com"],
      ["空串以外的垃圾", "example.com"],
    ];
    for (const [label, entry] of bad) {
      expect(() => resolveWebSocketAllowedOrigins(base, [entry]), label).toThrow();
    }
  });

  it("空白条目按「未配置」跳过，不炸启动（与 env 切分语义一致）", () => {
    expect(resolveWebSocketAllowedOrigins("https://a.example", ["", "   "])).toEqual([
      "https://a.example",
    ]);
  });

  it("端口与 Scheme 都是身份的一部分：不会被归一掉", () => {
    // 不同端口必须是**不同**条目——这正是「不同端口要 403」的基础。
    const result = resolveWebSocketAllowedOrigins("http://127.0.0.1:3000", [
      "http://127.0.0.1:3001",
      "https://127.0.0.1:3000",
    ]);
    expect(result).toEqual([
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "https://127.0.0.1:3000",
    ]);
    // 三条互不相等（精确比对的前提）。
    expect(new Set(result).size).toBe(3);
  });

  it("子域名 / 相似域名不会被当成同一个 Origin", () => {
    const result = resolveWebSocketAllowedOrigins("https://example.com", [
      "https://evil.example.com",
      "https://example.com.evil.com",
    ]);
    // 白名单里只有字面量那三条：前缀 / 后缀关系不产生任何额外匹配，
    // 是否放行由调用方逐字比对决定（真实 403 见 link-server A3-C）。
    expect(new Set(result)).toEqual(
      new Set(["https://example.com", "https://evil.example.com", "https://example.com.evil.com"]),
    );
  });
});
