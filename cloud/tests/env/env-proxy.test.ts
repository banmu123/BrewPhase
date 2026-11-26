import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../../src/env.js";
import { describeOutboundProxy } from "../../src/net/proxy-fetch.js";

/**
 * 出网代理解析与启动日志脱敏（Phase 1.3.1-C3c-3B-1，设计 §9.2）。
 *
 * 两条纪律在这里被钉死：
 *   1) 代理环境变量**只在 `loadEnv` 解析一次**，业务代码不再读 `process.env`；
 *   2) 启动日志**绝不**输出代理 URL 里的用户名 / 密码 / token。
 *
 * 另外覆盖 `MCP_TRUSTED_PEER_IDENTIFIERS` 的格式校验（[ID §10.1] 的比较对象，
 * 格式错误的条目永远匹配不上 → 必须 fail-fast，不能静默失效）。
 */

const BASE = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/brewphase_cloud",
  // 显式给密钥：否则 development 下 loadEnv 会生成临时密钥并各 warn 一次，
  // 污染「代理告警」类断言（那些用例只关心代理相关的一条 warn）。
  JWT_SIGNING_KEY: "x".repeat(48),
  SESSION_TOKEN_PEPPER: "y".repeat(32),
} as const;

describe("outboundProxy 解析（loadEnv 唯一入口）", () => {
  it("未配置任何代理变量 → url = null（直连）", () => {
    const env = loadEnv({ ...BASE });
    expect(env.outboundProxy.url).toBeNull();
    expect(env.outboundProxy.noProxy).toBe("");
  });

  it("HTTPS_PROXY 优先于 HTTP_PROXY", () => {
    const env = loadEnv({
      ...BASE,
      HTTPS_PROXY: "http://secure-proxy:8443",
      HTTP_PROXY: "http://plain-proxy:8080",
    });
    expect(env.outboundProxy.url).toBe("http://secure-proxy:8443");
    expect(env.outboundProxy.scheme).toBe("http");
  });

  it("大写优先于小写；两者都存在且不同 → 大写胜出并告警一次", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = loadEnv({
        ...BASE,
        HTTPS_PROXY: "http://upper:1",
        https_proxy: "http://lower:2",
      });
      expect(env.outboundProxy.url).toBe("http://upper:1");
      const messages = warnSpy.mock.calls.map((call) => String(call[0] ?? ""));
      expect(
        messages.some((m) => m.includes("HTTPS_PROXY") && m.includes("https_proxy") && m.includes("wins")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("大小写同时存在但取值相同 → 不告警（没有歧义）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = loadEnv({ ...BASE, HTTPS_PROXY: "http://p:1", https_proxy: "http://p:1" });
      expect(env.outboundProxy.url).toBe("http://p:1");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("空白串视为未配置（不产生一个解析不出的代理）", () => {
    const env = loadEnv({ ...BASE, HTTPS_PROXY: "   " });
    expect(env.outboundProxy.url).toBeNull();
  });

  it("省略 scheme 的常见写法（127.0.0.1:7900）→ scheme http", () => {
    const env = loadEnv({ ...BASE, HTTPS_PROXY: "127.0.0.1:7900" });
    expect(env.outboundProxy.url).toBe("127.0.0.1:7900");
    expect(env.outboundProxy.scheme).toBe("http");
  });

  it("https 代理 → scheme https", () => {
    const env = loadEnv({ ...BASE, HTTPS_PROXY: "https://proxy.internal:8443" });
    expect(env.outboundProxy.scheme).toBe("https");
  });

  it("socks5 → scheme unsupported，且 url 保留原文（消费方据此决定处置）", () => {
    const env = loadEnv({ ...BASE, HTTPS_PROXY: "socks5://127.0.0.1:1080" });
    expect(env.outboundProxy.url).toBe("socks5://127.0.0.1:1080");
    expect(env.outboundProxy.scheme).toBe("unsupported");
    // Provider 会 warn 后直连；CIMD 必须失败（resolvePinnedProxy 抛错）。
  });

  it("无法解析的值同样 → unsupported（不抛错，交给消费方分流）", () => {
    const env = loadEnv({ ...BASE, HTTPS_PROXY: "http://" });
    expect(env.outboundProxy.scheme).toBe("unsupported");
  });

  it("NO_PROXY / no_proxy 解析；NO_PROXY 优先", () => {
    expect(loadEnv({ ...BASE, NO_PROXY: ".internal,127.0.0.1" }).outboundProxy.noProxy).toBe(
      ".internal,127.0.0.1",
    );
    expect(
      loadEnv({ ...BASE, NO_PROXY: "upper", no_proxy: "lower" }).outboundProxy.noProxy,
    ).toBe("upper");
    expect(loadEnv({ ...BASE, no_proxy: "lower" }).outboundProxy.noProxy).toBe("lower");
  });
});

describe("启动日志脱敏（describeOutboundProxy）", () => {
  it("带凭据的 http 代理只输出 scheme://host:port，绝不含用户名 / 密码 / @", () => {
    const description = describeOutboundProxy({
      url: "http://alice:S3cretToken@proxy.internal:8080",
      noProxy: "",
      scheme: "http",
    });
    expect(description).toContain("http://proxy.internal:8080");
    expect(description).not.toContain("alice");
    expect(description).not.toContain("S3cretToken");
    expect(description).not.toContain("@");
    expect(description).not.toContain("S3cret");
  });

  it("https 代理同样只输出 host:port", () => {
    const description = describeOutboundProxy({
      url: "https://user:pass@proxy.internal",
      noProxy: "",
      scheme: "https",
    });
    expect(description).toContain("https://proxy.internal:443");
    expect(description).not.toContain("user");
    expect(description).not.toContain("pass");
    expect(description).not.toContain("@");
  });

  it("协议不可用时只输出协议名，连主机名都不带", () => {
    const description = describeOutboundProxy({
      url: "socks5://alice:S3cret@proxy.internal:1080",
      noProxy: "",
      scheme: "unsupported",
    });
    expect(description).toContain("socks5");
    expect(description).toContain("unsupported");
    // 那种配置本身就可疑，没有理由把主机名也写进日志。
    expect(description).not.toContain("proxy.internal");
    expect(description).not.toContain("alice");
    expect(description).not.toContain("S3cret");
  });

  it("未配置 → 明确的 not configured（显式而非隐式继承）", () => {
    expect(describeOutboundProxy({ url: null, noProxy: "", scheme: "http" })).toBe(
      "not configured (direct)",
    );
  });

  it("no_proxy 非空时附在描述里（主机名不是凭据，保留有助排障）", () => {
    const description = describeOutboundProxy({
      url: "http://proxy:8080",
      noProxy: ".internal",
      scheme: "http",
    });
    expect(description).toContain("no_proxy=.internal");
  });
});

describe("mcpTrustedPeerIdentifiers（[ID §10.1] 比较对象）", () => {
  it("缺省 → 空数组", () => {
    expect(loadEnv({ ...BASE }).mcpTrustedPeerIdentifiers).toEqual([]);
    expect(loadEnv({ ...BASE, MCP_TRUSTED_PEER_IDENTIFIERS: "" }).mcpTrustedPeerIdentifiers).toEqual([]);
    expect(loadEnv({ ...BASE, MCP_TRUSTED_PEER_IDENTIFIERS: " , " }).mcpTrustedPeerIdentifiers).toEqual([]);
  });

  it("逗号分隔 + trim", () => {
    expect(
      loadEnv({
        ...BASE,
        MCP_TRUSTED_PEER_IDENTIFIERS: " https://a.example/x , https://b.example/y ",
      }).mcpTrustedPeerIdentifiers,
    ).toEqual(["https://a.example/x", "https://b.example/y"]);
  });

  it("非 URL 条目 → 启动拒绝（fail-fast：匹配不上的防护等于没有）", () => {
    let message = "";
    try {
      loadEnv({ ...BASE, MCP_TRUSTED_PEER_IDENTIFIERS: "not-a-url" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("MCP_TRUSTED_PEER_IDENTIFIERS");
    expect(message).toContain("not an absolute URL");
  });

  it("非 http(s) scheme → 启动拒绝", () => {
    let message = "";
    try {
      loadEnv({ ...BASE, MCP_TRUSTED_PEER_IDENTIFIERS: "ftp://a.example/x" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("must be an http(s) URL");
  });

  it("合法条目全部通过（含纯 origin 形态的 issuer）", () => {
    expect(
      loadEnv({
        ...BASE,
        MCP_TRUSTED_PEER_IDENTIFIERS: "https://cloud.example.com,https://cloud.example.com/mcp",
      }).mcpTrustedPeerIdentifiers,
    ).toEqual(["https://cloud.example.com", "https://cloud.example.com/mcp"]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
