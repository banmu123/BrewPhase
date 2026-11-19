import { describe, expect, it, vi } from "vitest";
import {
  BodySizeLimiter,
  PINNED_REQUEST_HEADERS,
  authorityHost,
  declaredLengthExceeds,
  pinnedLookup,
  resolvePinnedProxy,
} from "../../src/net/proxy-fetch.js";

/**
 * CIMD 固定目标请求的**机制**测试（Phase 1.3.1-C3c-2）。
 *
 * 不建立真实 TLS 连接（那需要证书），只钉住三件在任何环境下都必须成立的事：
 * 字节上限真的在流式累计、lookup 只返回被钉死的地址、代理选择不会静默绕过。
 */

const LIMIT = 5 * 1024;

describe("BodySizeLimiter（流式字节上限）", () => {
  it("恰好等于上限时通过", () => {
    const limiter = new BodySizeLimiter(LIMIT);
    expect(limiter.push(Buffer.alloc(LIMIT))).toBe(true);
    expect(limiter.exceeded).toBe(false);
    expect(limiter.bytesRead).toBe(LIMIT);
    expect(limiter.toBuffer().byteLength).toBe(LIMIT);
  });

  it("超出 1 字节就判定超限（单块）", () => {
    const limiter = new BodySizeLimiter(LIMIT);
    expect(limiter.push(Buffer.alloc(LIMIT))).toBe(true);
    expect(limiter.push(Buffer.alloc(1))).toBe(false);
    expect(limiter.exceeded).toBe(true);
    expect(limiter.bytesRead).toBe(LIMIT + 1);
  });

  it("分块传输：逐块累计，不是只看第一块", () => {
    const limiter = new BodySizeLimiter(LIMIT);
    // 6 块 × 1 KiB = 6144 > 5 KiB；前 5 块收下，第 6 块触发。
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.push(Buffer.alloc(1024))).toBe(true);
    }
    expect(limiter.exceeded).toBe(false);
    expect(limiter.push(Buffer.alloc(1024))).toBe(false);
    expect(limiter.exceeded).toBe(true);
    // 超限块不会被计入已收下的 body。
    expect(limiter.toBuffer().byteLength).toBe(LIMIT);
  });

  it("没有 Content-Length 也能拒绝（限制与头部无关）", () => {
    const limiter = new BodySizeLimiter(LIMIT);
    let chunks = 0;
    while (limiter.push(Buffer.alloc(200)) && chunks < 1000) chunks += 1;
    expect(limiter.exceeded).toBe(true);
    expect(chunks).toBeLessThan(1000);
  });

  it("服务端谎报 Content-Length 时仍按真实字节拒绝", () => {
    // 声明只有 10 字节：预检放行。
    expect(declaredLengthExceeds("10", LIMIT)).toBe(false);
    // 实际流下来 6 KiB：累计判定必须触发。
    const limiter = new BodySizeLimiter(LIMIT);
    expect(limiter.push(Buffer.alloc(6000))).toBe(false);
    expect(limiter.exceeded).toBe(true);
  });
});

describe("declaredLengthExceeds（声明值预检）", () => {
  it("缺失 / 非数字（含分块传输）视为未知，不拦", () => {
    expect(declaredLengthExceeds(undefined, LIMIT)).toBe(false);
    expect(declaredLengthExceeds("abc", LIMIT)).toBe(false);
    expect(declaredLengthExceeds("", LIMIT)).toBe(false);
  });

  it("超限立即拦，正好等于上限放行", () => {
    expect(declaredLengthExceeds(String(LIMIT + 1), LIMIT)).toBe(true);
    expect(declaredLengthExceeds(String(LIMIT), LIMIT)).toBe(false);
  });

  it("数组形式取第一个值（重复 Content-Length 不放大上限）", () => {
    expect(declaredLengthExceeds([String(LIMIT + 1), "1"], LIMIT)).toBe(true);
  });
});

describe("pinnedLookup（DNS Pinning）", () => {
  it("all 形态返回数组：连接只会拿到被钉死的地址", () => {
    const lookup = pinnedLookup("93.184.216.34", 4);
    const callback = vi.fn();
    lookup("client.example.com", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("非 all 形态返回 (address, family)", () => {
    const lookup = pinnedLookup("2606:4700:4700::1111", 6);
    const callback = vi.fn();
    lookup("client.example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "2606:4700:4700::1111", 6);
  });

  it("忽略 hostname：传什么域名都只返回钉死的 IP（不会触发第二次解析）", () => {
    const lookup = pinnedLookup("93.184.216.34", 4);
    const first = vi.fn();
    const second = vi.fn();
    lookup("a.example.com", { all: true }, first);
    lookup("evil.internal", { all: true }, second);
    expect(first.mock.calls[0]?.[1]).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(second.mock.calls[0]?.[1]).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});

describe("resolvePinnedProxy", () => {
  it("没有代理配置 → 直连", () => {
    expect(resolvePinnedProxy("client.example.com", {})).toBeNull();
  });

  it("配置代理 → 走代理（大小写变量名都认）", () => {
    expect(resolvePinnedProxy("client.example.com", { HTTPS_PROXY: "http://127.0.0.1:7900" })?.port).toBe(
      "7900",
    );
    expect(resolvePinnedProxy("client.example.com", { https_proxy: "http://127.0.0.1:7901" })?.port).toBe(
      "7901",
    );
  });

  it("NO_PROXY 命中 → 直连", () => {
    expect(
      resolvePinnedProxy("client.example.com", {
        HTTPS_PROXY: "http://127.0.0.1:7900",
        NO_PROXY: ".example.com",
      }),
    ).toBeNull();
  });

  it("不支持的代理类型必须抛错，绝不静默绕过", () => {
    // Provider 通道在这种情况下会回退直连；CIMD 不行——那等于 DNS Pinning 失效。
    expect(() => resolvePinnedProxy("client.example.com", { HTTPS_PROXY: "socks5://127.0.0.1:1080" })).toThrow(
      /refusing to bypass the proxy/,
    );
  });
});

describe("CONNECT authority", () => {
  it("IPv6 加方括号，IPv4 与域名原样", () => {
    expect(authorityHost("2606:4700::1", 6)).toBe("[2606:4700::1]");
    expect(authorityHost("93.184.216.34", 4)).toBe("93.184.216.34");
    expect(authorityHost("[2606:4700::1]", 6)).toBe("[2606:4700::1]");
  });
});

describe("请求头纪律", () => {
  it("只带 Accept，没有任何用户相关头", () => {
    expect(Object.keys(PINNED_REQUEST_HEADERS)).toEqual(["accept"]);
    expect(PINNED_REQUEST_HEADERS.accept).toBe("application/json");
  });
});
