import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  createProxyFetch,
  openTunnel,
  parseProxyUrl,
  resolveProviderFetch,
  shouldBypassProxy,
} from "../../src/net/proxy-fetch.js";

/**
 * Provider 出网代理通道。
 *
 * 这里刻意测「机制」而不是「Google 能不能连通」：外部网络是否可达不是单测能保证的，
 * 但「CONNECT 目标是否正确」「失败是否明确」「没配代理时是否完全不动」必须钉死。
 */

describe("parseProxyUrl", () => {
  it("接受带 scheme 的 http / https 代理", () => {
    expect(parseProxyUrl("http://127.0.0.1:7900")?.port).toBe("7900");
    expect(parseProxyUrl("https://proxy.internal:8443")?.protocol).toBe("https:");
  });

  it("接受省略 scheme 的常见写法（补成 http）", () => {
    const url = parseProxyUrl("127.0.0.1:7900");
    expect(url?.protocol).toBe("http:");
    expect(url?.hostname).toBe("127.0.0.1");
    expect(url?.port).toBe("7900");
  });

  it("拒绝 SOCKS 与无法解析的值", () => {
    expect(parseProxyUrl("socks5://127.0.0.1:1080")).toBeNull();
    expect(parseProxyUrl("   ")).toBeNull();
    expect(parseProxyUrl("http://")).toBeNull();
  });
});

describe("shouldBypassProxy", () => {
  it("空 NO_PROXY 一律走代理", () => {
    expect(shouldBypassProxy("oauth2.googleapis.com", undefined)).toBe(false);
    expect(shouldBypassProxy("oauth2.googleapis.com", "")).toBe(false);
  });

  it("支持 * / 精确主机 / 后缀", () => {
    expect(shouldBypassProxy("oauth2.googleapis.com", "*")).toBe(true);
    expect(shouldBypassProxy("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(shouldBypassProxy("api.github.com", ".github.com")).toBe(true);
    expect(shouldBypassProxy("api.github.com", "*.github.com")).toBe(true);
    expect(shouldBypassProxy("api.github.com", "github.com")).toBe(true);
  });

  it("不做子串误匹配", () => {
    expect(shouldBypassProxy("evilgithub.com", "github.com")).toBe(false);
    expect(shouldBypassProxy("github.com.evil.test", "github.com")).toBe(false);
  });
});

/** CONNECT 出来的 socket 不在 `closeAllConnections()` 的管理范围内，必须自己记。 */
function trackTunnelSockets(): {
  track: (socket: net.Socket) => void;
  destroyAll: () => void;
} {
  const sockets = new Set<net.Socket>();
  return {
    track: (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {
        /* 测试里对端关闭是常态 */
      });
    },
    destroyAll: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

async function startProxy(
  onConnect: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void,
): Promise<{ url: string; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(405).end();
  });
  const tunnels = trackTunnelSockets();
  server.on("connect", (req, socket, head) => {
    seen.push(String(req.url));
    tunnels.track(socket as net.Socket);
    onConnect(req, socket as net.Socket, head as Buffer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        tunnels.destroyAll();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe("openTunnel", () => {
  it("把 CONNECT 发到目标主机的正确 host:port，并透传隧道内的字节", async () => {
    // 本地回显服务：隧道建立后客户端发什么就回什么。
    const echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
    const echoPort = (echo.address() as AddressInfo).port;

    const proxy = await startProxy((_req, socket) => {
      const upstream = net.connect(echoPort, "127.0.0.1", () => {
        socket.pipe(upstream).pipe(socket);
      });
      // 隧道被 destroy 时不会走 'end'，upstream 需要自己收尾，否则 echo 关不掉。
      socket.once("close", () => upstream.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });

    try {
      const tunnel = await openTunnel(new URL(proxy.url), { host: "127.0.0.1", port: echoPort });
      const reply = await new Promise<string>((resolve) => {
        tunnel.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
        tunnel.write("ping");
      });
      expect(reply).toBe("ping");
      expect(proxy.seen).toEqual([`127.0.0.1:${echoPort}`]);
      tunnel.destroy();
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  });

  it("代理拒绝 CONNECT（407）时抛出明确错误", async () => {
    const proxy = await startProxy((_req, socket) => {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    });
    try {
      await expect(openTunnel(new URL(proxy.url), { host: "example.test", port: 443 })).rejects.toThrow(
        /proxy CONNECT rejected \(407\)/,
      );
    } finally {
      await proxy.close();
    }
  });
});

/**
 * 测试用自签名证书（`tests/fixtures/`）。
 *
 * 只用于本地代理的 TLS 握手：客户端把它当**信任锚**传进去时握手成功，不传时
 * 必须被拒——这两种结果正是要钉的判据。生产代码没有任何关闭校验的开关。
 */
const FIXTURES = new URL("../fixtures/", import.meta.url);
const TEST_KEY = readFileSync(new URL("self-signed-127.0.0.1.key.pem", FIXTURES), "utf8");
const TEST_CERT = readFileSync(new URL("self-signed-127.0.0.1.pem", FIXTURES), "utf8");

async function startTlsProxy(
  onConnect: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void,
): Promise<{ url: string; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT });
  const tunnels = trackTunnelSockets();
  server.on("connect", (req, socket, head) => {
    seen.push(String(req.url));
    tunnels.track(socket as net.Socket);
    onConnect(req, socket as net.Socket, head as Buffer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        tunnels.destroyAll();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe("openTunnel 的 HTTPS 代理（R1-1）", () => {
  it("先与代理完成 TLS 握手，再发 CONNECT", async () => {
    const proxy = await startTlsProxy((_req, socket) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    try {
      const tunnel = await openTunnel(
        new URL(proxy.url),
        { host: "93.184.216.34", port: 443 },
        2000,
        { ca: TEST_CERT },
      );
      // 代理侧看到的是 CONNECT，说明握手完成之后才发的请求。
      expect(proxy.seen).toEqual(["93.184.216.34:443"]);
      tunnel.destroy();
    } finally {
      await proxy.close();
    }
  });

  it("自签名证书默认被拒绝，且不会退回直连", async () => {
    let directConnections = 0;
    const target = net.createServer(() => {
      directConnections += 1;
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
    const targetPort = (target.address() as AddressInfo).port;

    const proxy = await startTlsProxy((_req, socket) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    try {
      // 不传 ca：证书链不可信，必须在握手阶段失败。
      await expect(
        openTunnel(new URL(proxy.url), { host: "127.0.0.1", port: targetPort }, 2000),
      ).rejects.toThrow(/certificate|self[- ]signed|CERT/i);
      // 握手没完成 → CONNECT 根本没发出去。
      expect(proxy.seen).toEqual([]);
      expect(directConnections).toBe(0);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("代理凭据只发给代理，不进入隧道", async () => {
    const targetReceived: string[] = [];
    const echo = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => targetReceived.push(chunk.toString("utf8")));
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
    const echoPort = (echo.address() as AddressInfo).port;

    let proxyAuth: string | undefined;
    const proxy = await startProxy((req, socket) => {
      proxyAuth = req.headers["proxy-authorization"] as string | undefined;
      const upstream = net.connect(echoPort, "127.0.0.1", () => {
        socket.pipe(upstream).pipe(socket);
      });
      socket.once("close", () => upstream.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });

    try {
      const proxyUrl = new URL(proxy.url);
      proxyUrl.username = "alice";
      proxyUrl.password = "s3cret";
      const tunnel = await openTunnel(proxyUrl, { host: "127.0.0.1", port: echoPort });

      await new Promise<void>((resolve) => {
        tunnel.once("data", () => resolve());
        tunnel.write("ping");
      });
      expect(proxyAuth).toBe(`Basic ${Buffer.from("alice:s3cret", "utf8").toString("base64")}`);
      // 隧道里只有业务字节：凭据没有跟着进去。
      expect(targetReceived.join("")).toBe("ping");
      tunnel.destroy();
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  });

  it("IPv6 目标的 CONNECT authority 保留方括号", async () => {
    const proxy = await startProxy((_req, socket) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    try {
      const tunnel = await openTunnel(new URL(proxy.url), { host: "::1", port: 443 }, 2000);
      expect(proxy.seen).toEqual(["[::1]:443"]);
      tunnel.destroy();
    } finally {
      await proxy.close();
    }
  });

  it("已带方括号的 IPv6 不会被重复加括号", async () => {
    const proxy = await startProxy((_req, socket) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    try {
      const tunnel = await openTunnel(new URL(proxy.url), { host: "[::1]", port: 443 }, 2000);
      expect(proxy.seen).toEqual(["[::1]:443"]);
      tunnel.destroy();
    } finally {
      await proxy.close();
    }
  });

  it("代理拒绝 CONNECT 时不会偷偷直连目标", async () => {
    let directConnections = 0;
    const target = net.createServer(() => {
      directConnections += 1;
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
    const targetPort = (target.address() as AddressInfo).port;

    const proxy = await startProxy((_req, socket) => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    try {
      await expect(
        openTunnel(new URL(proxy.url), { host: "127.0.0.1", port: targetPort }),
      ).rejects.toThrow(/proxy CONNECT rejected \(502\)/);
      expect(directConnections).toBe(0);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});

describe("createProxyFetch", () => {
  it("https 请求经代理发出（代理拒绝时不会偷偷直连成功）", async () => {
    const proxy = await startProxy((_req, socket) => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    try {
      const proxied = createProxyFetch(new URL(proxy.url));
      await expect(proxied("https://oauth2.googleapis.com/token", { method: "POST" })).rejects.toThrow(
        /proxy CONNECT rejected \(502\)/,
      );
      expect(proxy.seen).toEqual(["oauth2.googleapis.com:443"]);
    } finally {
      await proxy.close();
    }
  });

  it("明文 HTTP 走绝对形式请求，响应被包装成标准 Response", async () => {
    const target = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
    const targetPort = (target.address() as AddressInfo).port;

    // 这个「代理」直接应答明文请求，只用来断言绝对形式 URL 被送对了。
    const seenPaths: string[] = [];
    const proxyServer = http.createServer((req, res) => {
      seenPaths.push(String(req.url));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", () => resolve()));
    const proxyPort = (proxyServer.address() as AddressInfo).port;

    try {
      const proxied = createProxyFetch(new URL(`http://127.0.0.1:${proxyPort}`));
      const response = await proxied(`http://127.0.0.1:${targetPort}/demo?x=1`, { method: "POST", body: "a=1" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(seenPaths).toEqual([`http://127.0.0.1:${targetPort}/demo?x=1`]);
    } finally {
      proxyServer.closeAllConnections?.();
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
      target.closeAllConnections?.();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});

describe("Provider 通道的代理协议一致性", () => {
  it("明文目标不会经 HTTPS 代理发送（明确失败，不发明文）", async () => {
    const proxied = createProxyFetch(new URL("https://127.0.0.1:1"));
    await expect(proxied("http://127.0.0.1:3000/health")).rejects.toThrow(
      /plaintext HTTP cannot be sent through an HTTPS proxy/,
    );
  });
});

describe("resolveProviderFetch", () => {
  const baseFetch = (() => Promise.resolve(new Response("direct"))) as typeof fetch;

  it("没有任何代理变量时返回原生 fetch（默认行为不变）", () => {
    expect(resolveProviderFetch({}, baseFetch)).toBe(baseFetch);
    expect(resolveProviderFetch({ HTTPS_PROXY: "  " }, baseFetch)).toBe(baseFetch);
  });

  it("不支持的代理类型回退直连", () => {
    expect(resolveProviderFetch({ HTTPS_PROXY: "socks5://127.0.0.1:1080" }, baseFetch)).toBe(baseFetch);
  });

  it("配了代理时 Provider 主机走隧道，NO_PROXY 命中的主机仍直连", async () => {
    const proxied = resolveProviderFetch(
      { HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1" },
      baseFetch,
    );
    expect(proxied).not.toBe(baseFetch);
    // 命中原生 fetch：直接拿到 "direct"。
    expect(await (await proxied("http://127.0.0.1:3000/health")).text()).toBe("direct");
    // 未命中：会去连 127.0.0.1:1 的代理并失败——证明它没走直连。
    await expect(proxied("https://oauth2.googleapis.com/token")).rejects.toBeTruthy();
  });
});
