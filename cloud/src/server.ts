import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import type { AppContext, AppHono } from "./context.js";
import type { LinkServer } from "./link/index.js";

/**
 * HTTP + WSS 的**唯一**装配点。
 *
 * 生产入口 `index.ts` 与集成测试都走这里。这不是为了测试方便才抽出来的——
 * 「生产用一套 upgrade 逻辑、测试用另一套 Mock Gateway」正是 Phase 1.1B 里
 * 付出过代价的那种结构：两边都能自证正确，合起来却握不上手。
 *
 * ## 为什么不开第二个服务
 *
 * Hono 的 `serve()` 支持注入 `createServer`，而 Node 的 `upgrade` 事件本来就
 * 挂在同一个 `http.Server` 上。所以 WSS 与 HTTP 共享端口、共享 TLS 终止点、
 * 共享反向代理配置。再起一个端口意味着：反代要配两条规则、防火墙要开两个洞、
 * 而「wss://host/device-link」与「https://host/mcp-devices」会落在不同进程上，
 * 单实例前提立刻失效。
 */
export interface CloudServer {
  /** 实际监听端口（`port: 0` 时由内核分配）。 */
  port: number;
  /** 底层 http.Server（停机时由 close() 处理，一般不直接用）。 */
  raw: HttpServer;
  /** 有序停机：先关 WSS（含在途连接），再关 HTTP，最后返回。 */
  close(): Promise<void>;
}

export function startCloudServer(options: {
  app: AppHono;
  ctx: AppContext;
  link: LinkServer;
  port: number;
  hostname?: string;
}): Promise<CloudServer> {
  const { app, ctx, link } = options;

  return new Promise<CloudServer>((resolve, reject) => {
    let httpServer: HttpServer | null = null;
    try {
      const server = serve(
        {
          fetch: app.fetch,
          port: options.port,
          hostname: options.hostname,
          /**
           * 这里拿到的就是最终会被 `listen()` 的那个实例。
           * `@hono/node-server` 只会调用它一次，并把同一个 `requestListener`
           * 传进来，所以 upgrade 与普通请求落在同一个 socket 上。
           */
          createServer: ((serverOptions: unknown, listener: unknown) => {
            const created = createHttpServer(
              serverOptions as Parameters<typeof createHttpServer>[0],
              listener as Parameters<typeof createHttpServer>[1],
            );
            link.attach(created);
            httpServer = created;
            return created;
          }) as unknown as typeof createHttpServer,
        },
        (info) => {
          ctx.logger.info("server_listening", {
            port: info.port,
            env: ctx.env.nodeEnv,
            instanceId: link.instanceId,
            expectedReplicas: ctx.env.gateway.expectedReplicas,
            allowedHosts: ctx.env.gateway.allowedHosts,
          });
          resolve({
            port: info.port,
            raw: httpServer as unknown as HttpServer,
            close: async () => {
              await link.shutdown();
              const target = httpServer;
              if (!target) return;
              await new Promise<void>((done) => {
                target.close(() => done());
                // keep-alive 的 HTTP 连接不会因为 close() 而结束；
                // 不主动断开会把停机拖到超时。
                target.closeAllConnections?.();
              });
            },
          });
        },
      );
      // serve() 在监听失败时会把错误抛到 'error' 事件上。
      server.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}
