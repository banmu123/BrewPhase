import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";
import type { AppContext } from "../context.js";
import { mcpDevices } from "../db/schema.js";
import { DEVICE_TOKEN_PATTERN } from "../mcp-devices/device-token.js";
import {
  createMemoryConnectionRegistry,
  type ConnectionInfo,
  type ConnectionRegistry,
} from "./connection-registry.js";
import {
  loadGrantRows,
  makeConnectionId,
  makeGrantContext,
  makeInstanceId,
  toGrantSnapshots,
  verifyHandshake,
  type HandshakeFailure,
} from "./handshake.js";
import { createHeartbeat, type HeartbeatController } from "./heartbeat.js";
import { NonceStore } from "./nonce-store.js";
import {
  byeSchema,
  pongSchema,
  REMOTE_CLOSE,
  REMOTE_CLOSE_REASON,
  REMOTE_HEARTBEAT_MS,
  REMOTE_HELLO_TIMEOUT_MS,
  REMOTE_IDLE_TIMEOUT_MS,
  REMOTE_LINK_PATH,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_MAX_INFLIGHT,
  REMOTE_TOOLS,
  REMOTE_WS_SUBPROTOCOL,
  statusFrameSchema,
  type ByeFrame,
  type DrainFrame,
  type HelloOk,
  type PingFrame,
} from "./schemas.js";

/**
 * Cloud 的 WSS 接入层（协议 §4.1 / §5 / §11.2 / §12）。
 *
 * ## 职责边界（这个文件**只**做这些）
 *
 * - HTTP Upgrade 的预检（path / Host / Origin / 子协议 / token 形态）；
 * - 每条连接的状态机（等 hello → 握手 → 活跃 → 关闭）与定时器；
 * - `hello_ok` 的构造与下发；
 * - 心跳的接线；
 * - 与 ConnectionRegistry 的联动。
 *
 * 认证与验签在 `handshake.ts`，nonce 在 `nonce-store.ts`，心跳节拍在
 * `heartbeat.ts`，路由表在 `connection-registry.ts`。拆开的理由很实际：
 * 它们各自需要不同的夹具（固定时钟、固定密钥、固定 fixture），混在一个
 * 文件里就只能整片跳过。
 *
 * ## Upgrade 拒绝 vs Close frame（两者**不是**一回事）
 *
 * | 阶段 | 手段 | 例子 |
 * |---|---|---|
 * | Upgrade **之前** | HTTP 响应 + 销毁 socket | path 不对、Host 不对、缺子协议、没有 token |
 * | Upgrade **之后** | WebSocket close frame + close code | 验签失败、版本无交集、被顶替、心跳超时 |
 *
 * 混用会导致两种常见错误：对未升级的 socket 发 close frame（对端只看到
 * 一段乱码的 HTTP 响应），或者对已升级的连接回 401（客户端把它当网络错误
 * 无限重连）。
 */

export type DisconnectReason = "suspended" | "revoked";

export interface LinkServerOptions {
  ctx: AppContext;
  /** 允许的 `Host` 头（hostname 或 hostname:port）。空数组 = 不校验（**仅测试**）。 */
  allowedHosts: string[];
  /**
   * 允许的 `Origin`。
   *
   * Electron 主进程的 `net.WebSocket` **不发** Origin（Spike 已确认），
   * 所以「没有 Origin」必须放行。而一旦有 Origin，它就代表浏览器上下文，
   * 必须命中白名单——否则任何网页都能拿本地 device_token 去连。
   */
  allowedOrigins?: string[];
  registry?: ConnectionRegistry;
  nonces?: NonceStore;
  instanceId?: string;
  helloTimeoutMs?: number;
  heartbeatMs?: number;
  idleTimeoutMs?: number;
  /** monotonic 毫秒（测试注入）。 */
  nowMono?: () => number;
  /** epoch 毫秒（测试注入：golden fixture 的 ts 是固定值）。 */
  now?: () => number;
}

export interface LinkServer {
  /** 挂到已有 HTTP Server 上（**同一端口**，不开第二个服务）。 */
  attach(server: HttpServer): void;
  /** 直接处理一次 upgrade（测试与自定义装配用；生产走 attach）。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** 有序停机：停收新连接 → 停心跳 → drain/bye/close → 清表。 */
  shutdown(): Promise<void>;
  /** 设备被暂停/撤销后的连接清理（route 层在**持久化之后**调用）。 */
  disconnectDevice(deviceId: string, reason: DisconnectReason): Promise<void>;
  connectionCount(): number;
  readonly instanceId: string;
  readonly registry: ConnectionRegistry;
}

interface LiveConnection {
  ws: WebSocket;
  connectionId: string;
  /** 握手成功前为空串。 */
  userId: string;
  deviceId: string;
  heartbeat: HeartbeatController;
  helloTimeout: NodeJS.Timeout | null;
  state: "awaiting_hello" | "handshaking" | "active" | "closing";
  /** `onClosed` 的幂等闸门（close 事件、心跳超时、主动断开三条路都会进来）。 */
  closed: boolean;
}

export function createLinkServer(options: LinkServerOptions): LinkServer {
  const { ctx } = options;
  const registry = options.registry ?? createMemoryConnectionRegistry();
  const nonces = options.nonces ?? new NonceStore();
  const instanceId = options.instanceId ?? makeInstanceId();
  const allowedHosts = options.allowedHosts.map(normalizeHost).filter((host) => host.length > 0);
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => origin.toLowerCase()));
  const helloTimeoutMs = options.helloTimeoutMs ?? REMOTE_HELLO_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatMs ?? REMOTE_HEARTBEAT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? REMOTE_IDLE_TIMEOUT_MS;
  const nowMono = options.nowMono ?? (() => performance.now());
  const now = options.now ?? (() => Date.now());

  /**
   * `maxPayload` 是**传输层**硬上限：ws 在解析帧头时就能发现超限并停止读取，
   * 不会先把 100 MiB 收进内存再交给业务层解析。ws 的默认值是 100 MiB，太宽松。
   */
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: REMOTE_MAX_FRAME_BYTES,
    handleProtocols: (protocols) =>
      protocols.has(REMOTE_WS_SUBPROTOCOL) ? REMOTE_WS_SUBPROTOCOL : false,
  });

  /** 活跃 socket 表。registry 记的是**路由**，这里记的是**传输对象**。 */
  const live = new Map<string, LiveConnection>();
  /**
   * 握手期间暂存的 token。
   *
   * 不挂在 `LiveConnection` 上：那个对象活到连接结束（可能数天），而 token
   * 只需要在握手那一瞬间用一次。WeakMap + 握手后立即 delete，让引用在
   * GC 能回收时立刻消失，也避免「顺手在别处读 connection.token」。
   */
  const tokenBySocket = new WeakMap<WebSocket, string>();
  let accepting = true;

  // MARK: - Upgrade 预检

  const rejectUpgrade = (socket: Duplex, status: number, message: string): void => {
    if (socket.destroyed) return;
    // 最小 HTTP 响应。**不回显任何请求头**（Authorization 就在里面）。
    const body = `${JSON.stringify({ error: message })}\n`;
    socket.write(
      `HTTP/1.1 ${status} ${httpStatusText(status)}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body,
    );
    socket.destroy();
  };

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!accepting) return rejectUpgrade(socket, 503, "shutting_down");

    // ---- path：精确匹配，且**不接受查询串** ----
    //
    // 拒绝一切 query 是刻意的：`?token=…` 会被反向代理的 access log 记下来。
    // 「协议层不允许 query」让这条泄漏路径在结构上不存在，而不是靠 review 保证。
    const rawUrl = req.url ?? "";
    const suffixAt = rawUrl.search(/[?#]/);
    const pathname = suffixAt === -1 ? rawUrl : rawUrl.slice(0, suffixAt);
    const suffix = suffixAt === -1 ? "" : rawUrl.slice(suffixAt);
    if (pathname !== REMOTE_LINK_PATH) return rejectUpgrade(socket, 404, "not_found");
    if (suffix.length > 0) return rejectUpgrade(socket, 400, "query_not_allowed");

    // ---- Host ----
    //
    // 只看 `Host`，**绝不看 `X-Forwarded-Host`**：后者是客户端可写的，信任它
    // 等于把 Host 校验变成装饰。反代要传真实主机名，应当改写 `Host`。
    //
    // 比较忽略端口：端口不是安全边界（连接已经落在监听者身上），
    // DNS rebinding 的判据是 hostname。
    if (allowedHosts.length > 0) {
      const host = normalizeHost(req.headers.host ?? "");
      if (!host || !allowedHosts.includes(host)) return rejectUpgrade(socket, 403, "host_not_allowed");
    }

    // ---- Origin ----
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin.length > 0 && !allowedOrigins.has(origin.toLowerCase())) {
      return rejectUpgrade(socket, 403, "origin_not_allowed");
    }

    // ---- 子协议 ----
    const offered = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (!offered.includes(REMOTE_WS_SUBPROTOCOL)) {
      return rejectUpgrade(socket, 400, "subprotocol_required");
    }

    // ---- token 形态 ----
    //
    // 只做形态检查（无状态、同步）。哈希查库属于握手第 2 步：它要读数据库，
    // 而 upgrade 阶段没有连接上下文可以做超时与审计，把 IO 放这里会让
    // 一个慢查询卡住整个 upgrade 队列。
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!DEVICE_TOKEN_PATTERN.test(token)) return rejectUpgrade(socket, 401, "unauthorized");

    wss.handleUpgrade(req, socket, head, (ws) => {
      tokenBySocket.set(ws, token);
      wss.emit("connection", ws);
    });
  };

  // MARK: - 连接

  wss.on("connection", (ws: WebSocket) => {
    // ws 在「消息超过 maxPayload」时会自己 `close(1009)`。协议要求 4009，
    // 而且 1009 不在 Desktop 的「不重连」集合里 —— 一个客户端 bug 会变成
    // 无限重连风暴。所以在这一层把传输码翻译成协议码。
    mapOversizeClose(ws);

    const connectionId = makeConnectionId();
    const heartbeat = createHeartbeat({
      heartbeatMs,
      idleTimeoutMs,
      now: nowMono,
      send: (frame: PingFrame) => sendJson(ws, frame),
      onTimeout: (code, reason) => {
        ctx.logger.info("link_heartbeat_timeout", { connectionId });
        // 先收敛（清路由与定时器），再关 socket：只关 socket 的话，registry
        // 里会留一条指向死连接的路由，而 close 事件是异步的。
        void onClosed(connection);
        closeWith(ws, code, reason);
      },
    });

    const connection: LiveConnection = {
      ws,
      connectionId,
      userId: "",
      deviceId: "",
      heartbeat,
      helloTimeout: null,
      state: "awaiting_hello",
      closed: false,
    };
    live.set(connectionId, connection);

    // 'error' 必须有监听器，否则 Node 会把它当未捕获异常直接崩进程。
    ws.on("error", (err) => {
      if (isOversizeError(err)) {
        ctx.logger.info("link_frame_too_large", { connectionId });
        return;
      }
      ctx.logger.warn("link_socket_error", { connectionId, error: errorCode(err) });
    });

    // 超时未发 hello → 4007。不能让没完成握手的 socket 无限占用资源。
    connection.helloTimeout = setTimeout(() => {
      if (connection.state !== "awaiting_hello" && connection.state !== "handshaking") return;
      ctx.logger.info("link_hello_timeout", { connectionId });
      void onClosed(connection);
      closeWith(ws, REMOTE_CLOSE.HELLO_TIMEOUT, REMOTE_CLOSE_REASON.HELLO_TIMEOUT);
    }, helloTimeoutMs);
    connection.helloTimeout.unref?.();

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      // 协议 §2：只允许 UTF-8 文本帧。
      if (isBinary) {
        ctx.logger.warn("link_binary_frame", { connectionId });
        closeWith(ws, REMOTE_CLOSE.PROTOCOL_VIOLATION, REMOTE_CLOSE_REASON.PROTOCOL_VIOLATION);
        return;
      }
      const raw = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data).toString("utf8");
      void onFrame(connection, raw);
    });

    ws.on("close", () => {
      void onClosed(connection);
    });
  });

  // MARK: - 帧

  const onFrame = async (connection: LiveConnection, raw: string): Promise<void> => {
    // 握手进行中或正在关闭：忽略后续帧。
    //
    // 这条不是优化：`message` 事件是同步派发的，第二个 hello 可能在第一个
    // 还在 `await` 数据库时就到达。没有这道门，两个 hello 会并发执行
    // bind，而「先 bind 新的再断旧的」的原子性就没了。
    if (connection.state === "handshaking" || connection.state === "closing") return;

    if (connection.state === "awaiting_hello") {
      connection.state = "handshaking";
      await onHello(connection, raw);
      return;
    }

    // ---- 活跃连接 ----
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // 建立连接后收到不可解析的帧 → 4009（无法回话，连接上下文已不可信）。
      ctx.logger.warn("link_unparsable_frame", { connectionId: connection.connectionId });
      closeWith(connection.ws, REMOTE_CLOSE.PROTOCOL_VIOLATION, REMOTE_CLOSE_REASON.PROTOCOL_VIOLATION);
      return;
    }
    const type = json && typeof json === "object" ? (json as { type?: unknown }).type : undefined;
    switch (type) {
      case "pong": {
        const parsed = pongSchema.safeParse(json);
        if (!parsed.success) {
          // 畸形 pong **不算**心跳回应：它无法证明对端按协议在应答。
          ctx.logger.warn("link_malformed_pong", { connectionId: connection.connectionId });
          return;
        }
        if (!connection.heartbeat.onPong(parsed.data.seq)) return;
        await registry.touch(connection.userId, connection.deviceId, connection.connectionId, nowMono());
        // 只有有效 pong 才推进 last_seen_at（协议 §5.1）。
        await recordLastSeen(ctx, connection.deviceId);
        return;
      }
      case "status": {
        const parsed = statusFrameSchema.safeParse(json);
        if (!parsed.success) {
          ctx.logger.warn("link_malformed_status", { connectionId: connection.connectionId });
          return;
        }
        // 提示帧：只更新可见性，**不**用它跳过任何授权判断（§4.4.1）。
        await registry.setServiceable(
          connection.userId,
          connection.deviceId,
          connection.connectionId,
          parsed.data.serviceable,
        );
        return;
      }
      case "bye": {
        const parsed = byeSchema.safeParse(json);
        if (parsed.success) ctx.logger.info("link_client_bye", { connectionId: connection.connectionId });
        void onClosed(connection);
        closeWith(connection.ws, REMOTE_CLOSE.NORMAL, "bye");
        return;
      }
      default:
        // 未知 type / 本阶段不处理的帧（req / res / cancel / grant_update_ack）
        // 一律忽略（协议 §2.2 的前向兼容规则）。1.2B.2 会在这里接 req/res。
        return;
    }
  };

  const onHello = async (connection: LiveConnection, raw: string): Promise<void> => {
    const token = tokenBySocket.get(connection.ws) ?? "";
    // token 只在这一刻需要；删掉引用，之后的任何代码路径都读不到它。
    tokenBySocket.delete(connection.ws);

    const result = await verifyHandshake({ db: ctx.db.db, nonces, now }, { deviceToken: token, raw }).catch(
      (err: unknown) => {
        ctx.logger.error("link_handshake_error", {
          connectionId: connection.connectionId,
          error: errorCode(err),
        });
        return null;
      },
    );

    if (!result) {
      void onClosed(connection);
      closeWith(connection.ws, REMOTE_CLOSE.INTERNAL_ERROR, REMOTE_CLOSE_REASON.INTERNAL_ERROR);
      return;
    }
    if (!result.ok) {
      const mapped = mapHandshakeFailure(result.failure);
      ctx.logger.info("link_handshake_rejected", {
        connectionId: connection.connectionId,
        kind: result.failure.kind,
        detail: result.failure.kind === "protocol" ? result.failure.detail : undefined,
      });
      void onClosed(connection);
      closeWith(connection.ws, mapped.code, mapped.reason);
      return;
    }

    // ---- 构造 hello_ok：先查授权，再 bind，**最后**才发 ----
    //
    // 顺序不可交换：先发 hello_ok 再 bind 的话，Desktop 会在「Cloud 已经
    // 认为握手完成」之后的一小段时间里查不到路由——而那恰好是它最可能
    // 立刻开始工作的时刻（协议 §12.4）。
    const device = result.device;
    let grants;
    try {
      grants = await loadGrantRows(ctx.db.db, device.userId);
    } catch (err) {
      ctx.logger.error("link_grant_load_failed", {
        connectionId: connection.connectionId,
        error: errorCode(err),
      });
      void onClosed(connection);
      closeWith(connection.ws, REMOTE_CLOSE.INTERNAL_ERROR, REMOTE_CLOSE_REASON.INTERNAL_ERROR);
      return;
    }

    // grant_ctx 每条连接重新生成：一次性引用，不落盘、不复用。
    const snapshots = toGrantSnapshots(grants, () => makeGrantContext());

    connection.userId = device.userId;
    connection.deviceId = device.id;

    const bound = await registry.bind(
      {
        userId: device.userId,
        deviceId: device.id,
        connectionId: connection.connectionId,
        instanceId,
        serviceable: result.hello.serviceable,
      },
      nowMono(),
    );

    // 顶替：新连接已经生效，现在才处理旧的。
    if (bound.displaced) {
      ctx.logger.info("link_superseded", {
        connectionId: bound.displaced.connectionId,
        by: connection.connectionId,
        device: bound.displaced.deviceId.slice(0, 8),
      });
      supersede(bound.displaced);
    }

    const helloOk: HelloOk = {
      v: 1,
      type: "hello_ok",
      ts: now(),
      connection_id: connection.connectionId,
      instance_id: instanceId,
      server_time: now(),
      heartbeat_ms: heartbeatMs,
      idle_timeout_ms: idleTimeoutMs,
      max_inflight: REMOTE_MAX_INFLIGHT,
      max_frame_bytes: REMOTE_MAX_FRAME_BYTES,
      // 写死的 8 个只读工具，与协议 §4.4 逐项一致。
      allowed_tools: [...REMOTE_TOOLS],
      grant_epoch: device.grantEpoch,
      grants: snapshots,
    };

    if (!sendJson(connection.ws, helloOk)) {
      // 发送失败（对端已关）：不能留一条「已 bind 但没有 socket」的路由。
      void onClosed(connection);
      closeWith(connection.ws, REMOTE_CLOSE.GOING_AWAY, REMOTE_CLOSE_REASON.GOING_AWAY);
      return;
    }

    connection.state = "active";
    if (connection.helloTimeout) {
      clearTimeout(connection.helloTimeout);
      connection.helloTimeout = null;
    }
    connection.heartbeat.start();
    ctx.logger.info("link_established", {
      connectionId: connection.connectionId,
      device: device.id.slice(0, 8),
      grants: snapshots.length,
      version: result.negotiatedVersion,
      serviceable: result.hello.serviceable,
    });
  };

  /** 顶替旧连接：`drain{grace_ms:0}` → close 4006。 */
  const supersede = (info: ConnectionInfo): void => {
    const target = live.get(info.connectionId);
    if (!target) return;
    target.state = "closing";
    target.heartbeat.stop();
    const drain: DrainFrame = {
      v: 1,
      type: "drain",
      ts: now(),
      reason: "superseded",
      grace_ms: 0,
    };
    sendJson(target.ws, drain);
    // 4006 = 被另一台设备顶替。Desktop 收到后**不重连**（协议 §9.3）。
    closeWith(target.ws, REMOTE_CLOSE.SUPERSEDED, REMOTE_CLOSE_REASON.SUPERSEDED);
  };

  /** 收敛连接：幂等。清定时器、清路由（带 connectionId 比对）、摘表。 */
  const onClosed = async (connection: LiveConnection): Promise<void> => {
    if (connection.closed) return;
    connection.closed = true;
    connection.state = "closing";
    connection.heartbeat.stop();
    if (connection.helloTimeout) {
      clearTimeout(connection.helloTimeout);
      connection.helloTimeout = null;
    }
    live.delete(connection.connectionId);
    if (connection.userId) {
      // **必须带 connectionId**：迟到的 close 回调不能删掉顶替它的新连接。
      await registry.unbind(connection.userId, connection.deviceId, connection.connectionId);
    }
  };

  // MARK: - 对外

  const disconnectDevice: LinkServer["disconnectDevice"] = async (deviceId, reason) => {
    const info = await registry.lookupByDevice(deviceId);
    // 没有连接 = 正常情况（设备离线）。**不抛错**：调用方已经完成持久化，
    // 清理失败不能回滚它（安全运维 §4.1）。
    if (!info) return;

    const target = live.get(info.connectionId);
    // 先删路由表项再通知：反过来会留下「表里还有、socket 已死」的窗口，
    // 期间任何请求都会打到死连接上（协议 §12.4）。
    await registry.unbind(info.userId, info.deviceId, info.connectionId);
    if (!target) return;

    target.state = "closing";
    target.heartbeat.stop();
    const code = reason === "revoked" ? REMOTE_CLOSE.DEVICE_REVOKED : REMOTE_CLOSE.DEVICE_SUSPENDED;
    const text =
      reason === "revoked" ? REMOTE_CLOSE_REASON.DEVICE_REVOKED : REMOTE_CLOSE_REASON.DEVICE_SUSPENDED;
    const bye: ByeFrame = { v: 1, type: "bye", ts: now(), reason };
    sendJson(target.ws, bye);
    closeWith(target.ws, code, text);
  };

  const shutdown = async (): Promise<void> => {
    // 1. 停收新连接（handleUpgrade 顶部判 accepting）。
    accepting = false;
    // 2. 停心跳，通知所有连接。
    const targets = [...live.values()];
    for (const target of targets) {
      target.state = "closing";
      target.heartbeat.stop();
      if (target.helloTimeout) {
        clearTimeout(target.helloTimeout);
        target.helloTimeout = null;
      }
      const drain: DrainFrame = { v: 1, type: "drain", ts: now(), reason: "shutdown", grace_ms: 0 };
      sendJson(target.ws, drain);
      const bye: ByeFrame = { v: 1, type: "bye", ts: now(), reason: "shutdown" };
      sendJson(target.ws, bye);
      // 1001 = 服务端下线，Desktop 应退避重连（协议 §9.3）。
      closeWith(target.ws, REMOTE_CLOSE.GOING_AWAY, REMOTE_CLOSE_REASON.GOING_AWAY);
    }
    // 3. 等 socket 真正关闭，但**不无限等**：卡住的 TCP 对端不该拖住停机。
    await waitForClose(targets, 1000);
    for (const target of targets) {
      if (target.ws.readyState !== WebSocket.CLOSED) target.ws.terminate();
      target.closed = true;
    }
    // 4. 清表。此时 connection_count 必须归零。
    registry.clear();
    live.clear();
    // 5. 关闭 ws 服务端（不再接受 upgrade）。
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };

  return {
    attach(server: HttpServer) {
      server.on("upgrade", (req, socket, head) => {
        handleUpgrade(req, socket, head);
      });
    },
    handleUpgrade,
    shutdown,
    disconnectDevice,
    connectionCount: () => registry.count(),
    instanceId,
    registry,
  };
}

// MARK: - 工具函数

/**
 * `Host` 归一：去端口、去 IPv6 括号、转小写。
 *
 * 只保留 hostname 是刻意的（见 handleUpgrade 的注释）。
 */
function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.lastIndexOf(":");
  // 只有一个冒号才是 `host:port`；多个冒号是裸 IPv6（无括号），原样保留。
  if (colon !== -1 && trimmed.indexOf(":") === colon) return trimmed.slice(0, colon);
  return trimmed;
}

/**
 * 把 ws 的「超限 = 1009」翻译成协议要求的 4009。
 *
 * 为什么必须翻译：`1009` 不在 Desktop 的「不重连」集合里
 * （`NO_RECONNECT_CLOSE_CODES` 只有 4xxx）。一个序列化 bug 导致的大帧
 * 会让 Desktop 无限退避重连，而协议规定这种情况「不重连，是客户端 bug」。
 *
 * 为什么只能在这一层做：ws 的 receiver 在发现超限时**同步**调用
 * `websocket.close(1009)`，我们的 `error` 监听器在那之后才跑，那时 close
 * frame 已经发出去了。所以在实例上包一层 close，是唯一能在 frame 出去之前
 * 改写 code 的位置。
 */
function mapOversizeClose(ws: WebSocket): void {
  const original = ws.close.bind(ws);
  ws.close = ((code?: number, reason?: string | Buffer) => {
    if (code === 1009) return original(REMOTE_CLOSE.PROTOCOL_VIOLATION, REMOTE_CLOSE_REASON.PROTOCOL_VIOLATION);
    return original(code, reason);
  }) as WebSocket["close"];
}

function sendJson(ws: WebSocket, frame: unknown): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

function closeWith(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
  }
}

function mapHandshakeFailure(failure: HandshakeFailure): { code: number; reason: string } {
  switch (failure.kind) {
    case "revoked":
      return { code: REMOTE_CLOSE.DEVICE_REVOKED, reason: REMOTE_CLOSE_REASON.DEVICE_REVOKED };
    case "suspended":
      return { code: REMOTE_CLOSE.DEVICE_SUSPENDED, reason: REMOTE_CLOSE_REASON.DEVICE_SUSPENDED };
    case "version":
      return { code: REMOTE_CLOSE.VERSION_UNSUPPORTED, reason: REMOTE_CLOSE_REASON.VERSION_UNSUPPORTED };
    case "nonce_capacity":
      // 容量耗尽既不是重放也不是凭据错误。1011（内部错误）让 Desktop 退避
      // 重连；若报 4001，它会**清掉本地私钥**——那是最坏的结果。
      return { code: REMOTE_CLOSE.INTERNAL_ERROR, reason: REMOTE_CLOSE_REASON.INTERNAL_ERROR };
    case "protocol":
    case "unauthorized":
    default:
      return { code: REMOTE_CLOSE.UNAUTHORIZED, reason: REMOTE_CLOSE_REASON.UNAUTHORIZED };
  }
}

function isOversizeError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
  );
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return err instanceof Error ? err.name : "unknown";
}

function httpStatusText(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}

/** 只在有效 pong 之后更新 `last_seen_at`（协议 §5.1）。失败只记日志。 */
async function recordLastSeen(ctx: AppContext, deviceId: string): Promise<void> {
  try {
    await ctx.db.db.update(mcpDevices).set({ lastSeenAt: new Date() }).where(eq(mcpDevices.id, deviceId));
  } catch (err) {
    ctx.logger.warn("link_last_seen_update_failed", { error: errorCode(err) });
  }
}

async function waitForClose(targets: readonly LiveConnection[], timeoutMs: number): Promise<void> {
  if (targets.length === 0) return;
  await new Promise<void>((resolve) => {
    let remaining = targets.length;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const done = (): void => {
      remaining -= 1;
      if (remaining <= 0) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    for (const target of targets) {
      if (target.ws.readyState === WebSocket.CLOSED) {
        done();
        continue;
      }
      target.ws.once("close", done);
    }
  });
}
