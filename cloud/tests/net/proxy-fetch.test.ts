import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  createProxyFetch,
  directOutboundProxy,
  openTunnel,
  parseProxyUrl,
  requestPinnedHttps,
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
        { caOverride: TEST_CERT },
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

/**
 * 目标侧 TLS 的端到端证据（R2-1）。
 *
 * 证书是 `tests/fixtures/` 里的自签名证书（SAN 含 `DNS:localhost` 与
 * `IP:127.0.0.1`）。客户端只有在显式传入 `ca` 时才信任它——这正好用来证明
 * 「验证是开的」：同样的连接，传 ca 成功、不传必须失败。
 */
async function startTlsTarget(): Promise<{
  port: number;
  seen: { sni?: string; host?: string };
  close: () => Promise<void>;
}> {
  const seen: { sni?: string; host?: string } = {};
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    seen.host = req.headers.host;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  // 证书验证失败时客户端会中断握手，服务端会抛 tlsClientError；测试里忽略即可。
  server.on("tlsClientError", () => {});
  server.on("secureConnection", (socket) => {
    seen.sni = (socket as unknown as { servername?: string }).servername;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** 真把 CONNECT 打到 authority 上的 HTTPS 代理（TLS 隧道 + 透传）。 */
async function startTunnelingTlsProxy(): Promise<{
  url: string;
  seen: string[];
  close: () => Promise<void>;
}> {
  const seen: string[] = [];
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT });
  const tunnels = trackTunnelSockets();
  server.on("connect", (req, socket, head) => {
    const authority = String(req.url);
    seen.push(authority);
    tunnels.track(socket as net.Socket);
    const split = authority.lastIndexOf(":");
    const host = authority.slice(0, split);
    const port = Number(authority.slice(split + 1));
    const upstream = net.connect({ host, port }, () => {
      if (head && head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket as net.Socket);
    });
    socket.once("close", () => upstream.destroy());
    upstream.on("error", () => (socket as net.Socket).destroy());
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        tunnels.destroyAll();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe("目标侧 TLS 与 SNI / Host（R2-1 端到端）", () => {
  it("直连 pinned IP：SNI 与 Host 用原始域名，证书按域名验证", async () => {
    const target = await startTlsTarget();
    try {
      const response = await requestPinnedHttps({
        url: new URL(`https://localhost:${target.port}/oauth/client.json`),
        pinnedAddress: "127.0.0.1",
        addressFamily: 4,
        maxBodyBytes: 5 * 1024,
        caOverride: TEST_CERT,
        totalTimeoutMs: 4000,
        // 显式传直连代理：proxy 是必传参数，任何配了宿主机 HTTPS_PROXY 的
        // 机器都不会把「直连」测试偷换成「经系统代理」，直连分支从此有人测到。
        proxy: directOutboundProxy(),
      });
      expect(response.status).toBe(200);
      expect(response.body.toString("utf8")).toBe('{"ok":true}');
      // 连接打到 127.0.0.1，但 SNI 与 Host 都是原始域名。
      expect(target.seen.sni).toBe("localhost");
      expect(target.seen.host).toBe(`localhost:${target.port}`);
    } finally {
      await target.close();
    }
  });

  it("目标证书不受信任时拒绝（没有「宽松模式」可用）", async () => {
    const target = await startTlsTarget();
    try {
      await expect(
        requestPinnedHttps({
          url: new URL(`https://localhost:${target.port}/oauth/client.json`),
          pinnedAddress: "127.0.0.1",
          addressFamily: 4,
          maxBodyBytes: 5 * 1024,
          totalTimeoutMs: 4000,
          proxy: directOutboundProxy(),
          // 不传 ca：自签名证书必须被拒。
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/CERT|VERIFY/) });
      expect(target.seen.host).toBeUndefined();
    } finally {
      await target.close();
    }
  });

  it("HTTPS 代理 + pinned IP CONNECT + 原始域名 TLS 全链路", async () => {
    const target = await startTlsTarget();
    const proxy = await startTunnelingTlsProxy();
    try {
      const response = await requestPinnedHttps({
        url: new URL(`https://localhost:${target.port}/oauth/client.json`),
        pinnedAddress: "127.0.0.1",
        addressFamily: 4,
        maxBodyBytes: 5 * 1024,
        caOverride: TEST_CERT,
        totalTimeoutMs: 4000,
        proxy: { url: proxy.url, noProxy: "", scheme: "http" },
      });
      expect(response.status).toBe(200);
      // CONNECT 的目标是 pinned IP，不是域名。
      expect(proxy.seen).toEqual([`127.0.0.1:${target.port}`]);
      // 隧道内的 TLS 仍按原始域名做 SNI / 证书校验。
      expect(target.seen.sni).toBe("localhost");
      expect(target.seen.host).toBe(`localhost:${target.port}`);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("代理证书不受信任时在握手阶段失败，不会发出 CONNECT", async () => {
    const proxy = await startTunnelingTlsProxy();
    try {
      await expect(
        requestPinnedHttps({
          url: new URL("https://localhost:443/oauth/client.json"),
          pinnedAddress: "127.0.0.1",
          addressFamily: 4,
          maxBodyBytes: 5 * 1024,
          totalTimeoutMs: 2000,
          proxy: { url: proxy.url, noProxy: "", scheme: "http" },
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/CERT|VERIFY/) });
      expect(proxy.seen).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("HTTPS 代理路径上，隧道内目标证书校验独立生效（altname 不匹配也拒绝）", async () => {
    // 两跳的证书主体必须能分离，才能单独钉住「目标那一跳的校验没被丢掉」：
    // 代理跳按 IP 直连（不发 SNI），测试证书的 SAN 含 IP:127.0.0.1 → 信任锚下成功；
    // 目标跳按域名校验，证书 SAN 不含 other.example.com → 必须失败。
    // 若有人把隧道内 TLS 的校验关掉或丢掉 ca，这条测试就会转红。
    const target = await startTlsTarget();
    const proxy = await startTunnelingTlsProxy();
    try {
      await expect(
        requestPinnedHttps({
          url: new URL(`https://other.example.com:${target.port}/oauth/client.json`),
          pinnedAddress: "127.0.0.1",
          addressFamily: 4,
          maxBodyBytes: 5 * 1024,
          caOverride: TEST_CERT,
          totalTimeoutMs: 4000,
          proxy: { url: proxy.url, noProxy: "", scheme: "http" },
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/CERT|ALTNAME|VERIFY|TLS/),
      });
      // 代理跳成功（CONNECT 已发出），失败必须发生在隧道内的目标 TLS。
      expect(proxy.seen).toEqual([`127.0.0.1:${target.port}`]);
      expect(target.seen.host).toBeUndefined();
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it("总超时会销毁仍在建连的代理 socket（不会挂在后台）", async () => {
    // 黑洞代理：接受 TCP，永不回应 CONNECT，也永不发数据。
    const accepted: net.Socket[] = [];
    const proxy = net.createServer((socket) => {
      accepted.push(socket);
      socket.resume();
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const proxyPort = (proxy.address() as AddressInfo).port;

    try {
      await expect(
        requestPinnedHttps({
          url: new URL("https://localhost/oauth/client.json"),
          pinnedAddress: "93.184.216.34",
          addressFamily: 4,
          maxBodyBytes: 5 * 1024,
          // 连接超时故意长于总预算：由总定时器先触发。
          connectTimeoutMs: 5_000,
          totalTimeoutMs: 150,
          proxy: { url: `http://127.0.0.1:${proxyPort}`, noProxy: "", scheme: "http" },
        }),
      ).rejects.toThrow(/timed out \(total\)/);

      await new Promise((resolve) => setTimeout(resolve, 200));
      const open = await new Promise<number>((resolve) => {
        proxy.getConnections((_error, count) => resolve(count));
      });
      expect(open).toBe(0);
      expect(accepted.every((socket) => socket.destroyed)).toBe(true);
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});

describe("各阶段超时（R2-2）", () => {
  it("CONNECT 阶段超时：黑洞代理不回 200 时必须报错并断开", async () => {
    const accepted: net.Socket[] = [];
    const proxy = net.createServer((socket) => {
      accepted.push(socket);
      socket.resume(); // 读走 CONNECT 请求，但永不回应
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const proxyPort = (proxy.address() as AddressInfo).port;

    try {
      await expect(
        requestPinnedHttps({
          url: new URL("https://localhost/oauth/client.json"),
          pinnedAddress: "93.184.216.34",
          addressFamily: 4,
          maxBodyBytes: 5 * 1024,
          connectTimeoutMs: 120,
          // 总预算远大于连接超时，确保是 CONNECT 阶段先超时。
          totalTimeoutMs: 4_000,
          proxy: { url: `http://127.0.0.1:${proxyPort}`, noProxy: "", scheme: "http" },
        }),
      ).rejects.toThrow(/proxy CONNECT timed out after 120ms/);

      await new Promise((resolve) => setTimeout(resolve, 150));
      const open = await new Promise<number>((resolve) => {
        proxy.getConnections((_error, count) => resolve(count));
      });
      expect(open).toBe(0);
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("代理 TCP 连接超时：不可达地址按连接超时结束", async () => {
    // RFC 5737 TEST-NET-1：文档保留、不应被路由。连接会一直停在 SYN 阶段，
    // 正好用来验证 `connectToProxy` 的连接超时（而不是总超时兜底）。
    await expect(
      requestPinnedHttps({
        url: new URL("https://localhost/oauth/client.json"),
        pinnedAddress: "93.184.216.34",
        addressFamily: 4,
        maxBodyBytes: 5 * 1024,
        connectTimeoutMs: 150,
        // 总预算远大于连接超时：若不是连接超时生效，会报 timed out (total)。
        totalTimeoutMs: 5_000,
        proxy: { url: "http://192.0.2.1:81", noProxy: "", scheme: "http" },
      }),
    ).rejects.toThrow(/proxy connection timed out after 150ms/);
  });

  it("慢速响应体：总预算耗尽时按 timeout 结束，不会无限等下去", async () => {
    const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      // 每 100ms 吐一个字节：永远读不完那个 JSON。
      const timer = setInterval(() => res.write(" "), 100);
      res.on("close", () => clearInterval(timer));
    });
    server.on("tlsClientError", () => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      await expect(
        requestPinnedHttps({
          url: new URL(`https://localhost:${port}/oauth/client.json`),
          pinnedAddress: "127.0.0.1",
          addressFamily: 4,
          maxBodyBytes: 5 * 1024,
          caOverride: TEST_CERT,
          connectTimeoutMs: 1_000,
          totalTimeoutMs: 300,
          proxy: directOutboundProxy(), // 直连路径：必须与环境代理隔离（理由见上文）。
        }),
      ).rejects.toThrow(/timed out \(total\)/);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("总超时会销毁仍在 TLS 握手中的代理隧道（目标侧吞掉 ClientHello 也不泄漏）", async () => {
    // 这条测试针对的窗口：CONNECT 已经拿到 200、隧道 socket 已交还给
    // createConnection，但目标 TLS 握手尚未完成。此时 socket 既不属于
    // request（callback 还没回调），openTunnel 的 abort 监听也已移除——
    // 总预算在这里耗尽的话，必须有人收掉这条连接。
    const accepted: net.Socket[] = [];
    const hole = net.createServer((socket) => {
      accepted.push(socket);
      socket.resume(); // 吞掉 ClientHello，永不回应
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => hole.listen(0, "127.0.0.1", () => resolve()));
    const holePort = (hole.address() as AddressInfo).port;

    const tunnels: net.Socket[] = [];
    const proxy = http.createServer((_req, res) => res.writeHead(405).end());
    proxy.on("connect", (_req, socket, _head) => {
      tunnels.push(socket as net.Socket);
      const upstream = net.connect(holePort, "127.0.0.1", () => {
        (socket as net.Socket).write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => (socket as net.Socket).destroy());
      (socket as net.Socket).on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const proxyPort = (proxy.address() as AddressInfo).port;

    try {
      await expect(
        requestPinnedHttps({
          url: new URL("https://localhost/oauth/client.json"),
          pinnedAddress: "127.0.0.1",
          addressFamily: 4,
          maxBodyBytes: 5 * 1024,
          // 连接超时故意远大于总预算：由总定时器先触发，且触发点落在 TLS 握手窗口。
          connectTimeoutMs: 10_000,
          totalTimeoutMs: 300,
          proxy: { url: `http://127.0.0.1:${proxyPort}`, noProxy: "", scheme: "http" },
        }),
      ).rejects.toThrow(/timed out \(total\)/);

      await new Promise((resolve) => setTimeout(resolve, 500));
      const open = await new Promise<number>((resolve) => {
        hole.getConnections((_error, count) => resolve(count));
      });
      expect(open).toBe(0);
      expect(accepted.every((socket) => socket.destroyed)).toBe(true);
      expect(tunnels.every((socket) => socket.destroyed)).toBe(true);
    } finally {
      for (const socket of accepted) socket.destroy();
      for (const socket of tunnels) socket.destroy();
      await new Promise<void>((resolve) => hole.close(() => resolve()));
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
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

  it("未配置代理时返回原生 fetch（默认行为不变）", () => {
    expect(resolveProviderFetch(directOutboundProxy(), baseFetch)).toBe(baseFetch);
    expect(resolveProviderFetch(directOutboundProxy(".example.com"), baseFetch)).toBe(baseFetch);
  });

  it("不支持的代理类型回退直连（Provider 语义；CIMD 走 resolvePinnedProxy 硬失败）", () => {
    expect(
      resolveProviderFetch(
        { url: "socks5://127.0.0.1:1080", noProxy: "", scheme: "unsupported" },
        baseFetch,
      ),
    ).toBe(baseFetch);
  });

  it("配了代理时 Provider 主机走隧道，NO_PROXY 命中的主机仍直连", async () => {
    const proxied = resolveProviderFetch(
      { url: "http://127.0.0.1:1", noProxy: "127.0.0.1", scheme: "http" },
      baseFetch,
    );
    expect(proxied).not.toBe(baseFetch);
    // 命中原生 fetch：直接拿到 "direct"。
    expect(await (await proxied("http://127.0.0.1:3000/health")).text()).toBe("direct");
    // 未命中：会去连 127.0.0.1:1 的代理并失败——证明它没走直连。
    await expect(proxied("https://oauth2.googleapis.com/token")).rejects.toBeTruthy();
  });
});
