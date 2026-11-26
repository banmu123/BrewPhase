import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  BodySizeLimiter,
  PINNED_REQUEST_HEADERS,
  authorityHost,
  declaredLengthExceeds,
  directOutboundProxy,
  pinnedLookup,
  readPinnedResponse,
  readResponseBody,
  resolvePinnedProxy,
  type ResponseHeadLike,
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

describe("readResponseBody（真实读取路径，R1-5）", () => {
  it("恰好 5120 字节允许", async () => {
    const stream = Readable.from([Buffer.alloc(LIMIT, 0x61)]);
    const result = await readResponseBody(stream, LIMIT);
    expect(result.bodyTooLarge).toBe(false);
    expect(result.bytesRead).toBe(LIMIT);
    expect(result.body.byteLength).toBe(LIMIT);
    expect(result.destroyedEarly).toBe(false);
  });

  it("5121 字节失败，且不把半截 body 交给上层", async () => {
    const stream = Readable.from([Buffer.alloc(LIMIT + 1, 0x61)]);
    const result = await readResponseBody(stream, LIMIT);
    expect(result.bodyTooLarge).toBe(true);
    expect(result.destroyedEarly).toBe(true);
    // 关键：超限时 body 必须是空的——否则上层可能拿它去 JSON.parse。
    expect(result.body.byteLength).toBe(0);
    expect(stream.destroyed).toBe(true);
  });

  it("超限后立即停止消费：不再向数据源请求更多字节", async () => {
    // `Readable.from([...])` 在读完时会自己 destroy，光看 `destroyed` 分不出
    // 「我们主动销毁」和「它自己读完了」。这里用按需生产的源：销毁后 `_read`
    // 不再被调用，`produced` 应当立刻停止增长。
    let produced = 0;
    const stream = new Readable({
      read() {
        produced += 1;
        if (produced > 1000) {
          this.push(null);
          return;
        }
        this.push(Buffer.alloc(1024, 0x61));
      },
    });

    const result = await readResponseBody(stream, LIMIT);
    expect(result.bodyTooLarge).toBe(true);

    // 5 KiB 上限意味着最多读几次 _read（含预读）就该停手；没有 destroy 时
    // 源会被一路读到 EOF（这里是 1000 次）。
    expect(produced).toBeLessThan(50);
    const atOverflow = produced;
    await new Promise((resolve) => setImmediate(resolve));
    expect(produced).toBe(atOverflow);
    expect(stream.destroyed).toBe(true);
    stream.destroy();
  });

  it("分块传输逐块累计，超限后不再消费后面的块", async () => {
    const stream = Readable.from([Buffer.alloc(3000), Buffer.alloc(3000), Buffer.alloc(3000)]);
    const result = await readResponseBody(stream, LIMIT);
    expect(result.bodyTooLarge).toBe(true);
    // 6000 而不是 9000：第三块没有被读。
    expect(result.bytesRead).toBe(6000);
    expect(stream.destroyed).toBe(true);
  });

  it("没有 Content-Length 时同样生效（纯字节累计）", async () => {
    const stream = Readable.from([Buffer.alloc(4096), Buffer.alloc(4096)]);
    const result = await readResponseBody(stream, LIMIT);
    expect(result.bodyTooLarge).toBe(true);
    expect(result.bytesRead).toBe(8192);
  });

  it("按 byteLength 计算，不按字符串长度", async () => {
    // 2048 个三字节 UTF-8 字符：String.length = 2048，实际 6144 字节。
    const text = "咖".repeat(2048);
    const body = Buffer.from(text, "utf8");
    expect(text.length).toBe(2048);
    expect(body.byteLength).toBe(6144);

    const stream = Readable.from([body]);
    const result = await readResponseBody(stream, LIMIT);
    expect(result.bodyTooLarge).toBe(true);
    expect(result.bytesRead).toBe(6144);
  });

  it("流错误向上抛，不被当成「读完了」", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("socket reset"));
      },
    });
    await expect(readResponseBody(stream, LIMIT)).rejects.toThrow(/socket reset/);
  });
});

describe("readPinnedResponse（预检 + 读取）", () => {
  function fakeResponse(options: {
    status?: number;
    headers?: Record<string, string | string[] | undefined>;
    chunks?: Buffer[];
  }) {
    const state = { destroyed: false, dataListeners: 0 };
    const stream = Readable.from(options.chunks ?? []);
    const response: ResponseHeadLike = {
      statusCode: options.status ?? 200,
      headers: options.headers ?? {},
      on: (event: "data", listener: (chunk: Buffer) => void) => {
        if (event === "data") state.dataListeners += 1;
        return stream.on(event, listener);
      },
      once: (event: "end" | "error", listener: (...args: never[]) => void) =>
        stream.once(event, listener as never),
      destroy: () => {
        state.destroyed = true;
        stream.destroy();
      },
    };
    return { response, state };
  }

  it("Content-Length 预检超限：不建立读取循环，直接销毁", async () => {
    const { response, state } = fakeResponse({
      headers: { "content-length": String(LIMIT + 1) },
      chunks: [Buffer.alloc(LIMIT + 1)],
    });
    const result = await readPinnedResponse(response, LIMIT);
    expect(result.bodyTooLarge).toBe(true);
    expect(result.body.byteLength).toBe(0);
    expect(state.destroyed).toBe(true);
    // 没有挂 data 监听：明知超限就不该开始读。
    expect(state.dataListeners).toBe(0);
  });

  it("Content-Length 低报时仍按真实字节拒绝", async () => {
    const { response } = fakeResponse({
      headers: { "content-length": "10" },
      chunks: [Buffer.alloc(6000)],
    });
    const result = await readPinnedResponse(response, LIMIT);
    expect(result.bodyTooLarge).toBe(true);
  });

  it("没有 Content-Length 时走累计路径", async () => {
    const { response } = fakeResponse({
      headers: {},
      chunks: [Buffer.alloc(1024), Buffer.alloc(1024)],
    });
    const result = await readPinnedResponse(response, LIMIT);
    expect(result.bodyTooLarge).toBe(false);
    expect(result.body.byteLength).toBe(2048);
    expect(result.status).toBe(200);
  });

  it("合法响应原样带出 status / headers / body", async () => {
    const { response } = fakeResponse({
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "max-age=60" },
      chunks: [Buffer.from('{"ok":true}', "utf8")],
    });
    const result = await readPinnedResponse(response, LIMIT);
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.body.toString("utf8")).toBe('{"ok":true}');
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
    expect(resolvePinnedProxy("client.example.com", directOutboundProxy())).toBeNull();
  });

  it("配置代理 → 走代理（http / https 都认）", () => {
    expect(
      resolvePinnedProxy("client.example.com", {
        url: "http://127.0.0.1:7900",
        noProxy: "",
        scheme: "http",
      })?.port,
    ).toBe("7900");
    expect(
      resolvePinnedProxy("client.example.com", {
        url: "https://127.0.0.1:7901",
        noProxy: "",
        scheme: "https",
      })?.port,
    ).toBe("7901");
  });

  it("NO_PROXY 命中 → 直连", () => {
    expect(
      resolvePinnedProxy("client.example.com", {
        url: "http://127.0.0.1:7900",
        noProxy: ".example.com",
        scheme: "http",
      }),
    ).toBeNull();
  });

  it("不支持的代理类型必须抛错，绝不静默绕过", () => {
    // Provider 通道在这种情况下会回退直连；CIMD 不行——那等于 DNS Pinning 失效。
    expect(() =>
      resolvePinnedProxy("client.example.com", {
        url: "socks5://127.0.0.1:1080",
        noProxy: "",
        scheme: "unsupported",
      }),
    ).toThrow(/refusing to bypass the proxy/);
  });

  it("socks5 + NO_PROXY 命中仍然抛错（协议不可用先于 NO_PROXY 判定）", () => {
    // 判定顺序：协议不可用**先于** NO_PROXY。否则「代理配错 + 恰好命中
    // NO_PROXY」会被当成合法直连，DNS Pinning 在无人察觉下失效。
    expect(() =>
      resolvePinnedProxy("client.example.com", {
        url: "socks5://127.0.0.1:1080",
        noProxy: ".example.com",
        scheme: "unsupported",
      }),
    ).toThrow(/refusing to bypass the proxy/);
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
