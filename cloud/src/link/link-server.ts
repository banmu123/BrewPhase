import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";
import type { AppContext } from "../context.js";
import { mcpDevices } from "../db/schema.js";
import { DEVICE_TOKEN_PATTERN } from "../mcp-devices/device-token.js";
import { sha256Hex } from "../security/crypto.js";
import { admitDevice, type AdmissionFailure } from "./admission.js";
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
  /** **仅测试使用**：在精确的 await 边界暂停，用于确定性构造并发顺序。 */
  lifecycleHooks?: LinkLifecycleHooks;
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
  /**
   * **诊断/测试用**：等所有进行中的握手落定。
   *
   * 与 `shutdown()` 内部用的是同一个等待。对外暴露它的理由：并发测试
   * 必须能问「那条被取消的握手现在到底跑完了没有」，否则断言会跑在
   * 协程恢复之前——那种测试会同时对**正确**和**错误**的实现说绿
   * （第一版 T1/T3 就是这么假绿的）。
   */
  awaitHandshakes(timeoutMs?: number): Promise<void>;
  /**
   * **诊断用**：每条活动连接的生命周期事实。
   *
   * 存在的理由不是「方便调试」，而是并发正确性**必须可断言**：
   * 「没有遗漏的 hello timer / 心跳 timer」「没有 bound 但已 closing 的连接」
   * 这两条没法从外部行为观察，只能把内部事实读出来。
   * 生产代码不读它（`/ready` 只读 `connectionCount()`）。
   */
  inspect(): LinkConnectionSnapshot[];
  readonly instanceId: string;
  readonly registry: ConnectionRegistry;
}

/** 单条连接的生命周期快照（诊断用，不含任何凭据）。 */
export interface LinkConnectionSnapshot {
  connectionId: string;
  deviceId: string;
  state: LiveConnection["state"];
  closing: boolean;
  bound: boolean;
  released: boolean;
  /** 心跳定时器是否仍在跑。停机/关闭后必须为 false。 */
  heartbeatRunning: boolean;
  /** hello 超时定时器是否仍挂着。握手结束或关闭后必须为 false。 */
  helloTimeoutArmed: boolean;
}

/**
 * 连接生命周期：五个状态 + 三个**互相独立**的事实。
 *
 * 为什么不是「一个 closed 布尔」——那正是 1.2B.1 留下幽灵路由的原因：
 * `closed` 同时被当成「socket 没了」和「路由已清理」，于是
 * 「close 发生在 bind 之前」时它把后续的清理也一并短路掉了。
 *
 * | 事实 | 含义 | 谁改 |
 * |---|---|---|
 * | `state` | 对外可见的协议阶段 | 见下 |
 * | `closing` | **已决定关闭**；此后禁止任何 bind | close 事件 / 主动关 / 停机 |
 * | `bound` | registry 里**确实**存在本 connectionId 的表项 | bind 成功那一刻 |
 * | `released` | 路由已解绑（或从未需要解绑） | `releaseRoute` |
 *
 * 关键不变量：`closing && bound && !released` 是一个**必须被清理**的状态。
 * 它可能出现在「close 在 bind 之前到达、bind 随后完成」这条路径上——
 * 那条路径下 `converge()` 已经跑完（当时 `bound=false`，无事可做），
 * 所以清理只能由 **binder 自己**在恢复执行时完成。
 */
interface LiveConnection {
  ws: WebSocket;
  connectionId: string;
  /** 握手成功前为空串。 */
  userId: string;
  deviceId: string;
  heartbeat: HeartbeatController;
  helloTimeout: NodeJS.Timeout | null;
  state: "awaiting_hello" | "handshaking" | "active" | "closing" | "closed";
  /** 已决定关闭。**唯一**的 bind 准入判据之一。 */
  closing: boolean;
  /** registry 里存在本 connectionId 的表项。 */
  bound: boolean;
  /** 路由已释放。与 `bound` 分开，才不会被幂等短路挡住迟到的 bind。 */
  released: boolean;
  /** `converge()` 的幂等闸门（close / 心跳超时 / 主动断开 / 停机四条路）。 */
  convergePromise: Promise<void> | null;
}

/**
 * **仅测试使用**的生命周期钩子。
 *
 * 并发正确性没法用 `setTimeout(随机)` 验证——那样测的是调度运气。要确定性地
 * 构造「握手停在 grant 查询、此时撤销已提交」这类顺序，必须在**精确的 await
 * 边界**上能暂停。生产不传这些钩子，走的是同一条代码路径（钩子调用点是
 * `await` 一个恒等函数，不影响时序语义）。
 */
export interface LinkLifecycleHooks {
  /** 在 `verifyHandshake` 之前（其内部的数据库查询尚未发出）。 */
  beforeVerify?: (connectionId: string) => Promise<void> | void;
  /** 在加载 grant 快照之前（设备认证已通过，尚无任何路由）。 */
  beforeGrants?: (connectionId: string) => Promise<void> | void;
  /** 在准入事务之前（仍未持有行锁）。 */
  beforeAdmission?: (connectionId: string) => Promise<void> | void;
  /** 在事务**内**、已经持有行锁、bind 之前：用来构造「bind 与撤停抢锁」的顺序。 */
  insideAdmission?: (connectionId: string) => Promise<void> | void;
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
  const hooks = options.lifecycleHooks;

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
  /**
   * 停机中。与 `accepting` 分开：
   *
   * - `accepting` 只管「还接不接受新的 Upgrade」；
   * - `shuttingDown` 是**所有进行中的握手**必须看到的取消信号。
   *
   * 缺了它就有一条真实路径：`shutdown()` 里 `registry.clear()` 之后，
   * 一个卡在授权查询上的握手恢复执行并 `bind()` —— 于是停机完成时
   * `connectionCount()` 是 1，而那条连接永远不会再被处理。
   */
  let shuttingDown = false;
  /** 进行中的握手。停机时必须等它们落定再清表（见 shutdown）。 */
  const inFlightHandshakes = new Set<Promise<void>>();

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
        void converge(connection);
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
      closing: false,
      bound: false,
      released: false,
      convergePromise: null,
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
      // `closing` 已经把「已决定关闭」表达清楚了，不必再枚举状态：
      // 反过来的写法（只认 awaiting_hello / handshaking）会让一个恰好在这
      // 两个状态之间被顶替的 socket 收不到 4007 也收不到 4006。
      if (connection.closing) return;
      ctx.logger.info("link_hello_timeout", { connectionId });
      void converge(connection);
      closeWith(ws, REMOTE_CLOSE.HELLO_TIMEOUT, REMOTE_CLOSE_REASON.HELLO_TIMEOUT);
    }, helloTimeoutMs);
    connection.helloTimeout.unref?.();

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      // 已决定关闭：后续帧一律不处理。
      //
      // 这一条同时挡住两件事：close 与 message 在同一个 tick 里到达时的顺序，
      // 以及「握手被取消后，Desktop 又发了一帧」这种延迟。少了它，一个已取消
      // 的连接仍可能推进状态机。
      if (connection.closing) return;

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
      void converge(connection);
    });
  });

  // MARK: - 帧

  const onFrame = async (connection: LiveConnection, raw: string): Promise<void> => {
    // 握手进行中或正在关闭：忽略后续帧。
    //
    // 这条不是优化：`message` 事件是同步派发的，第二个 hello 可能在第一个
    // 还在 `await` 数据库时就到达。没有这道门，两个 hello 会并发执行
    // bind，而「先 bind 新的再断旧的」的原子性就没了。
    if (connection.closing || connection.state === "handshaking") return;

    if (connection.state === "awaiting_hello") {
      connection.state = "handshaking";
      onHello(connection, raw);
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
        void converge(connection);
        closeWith(connection.ws, REMOTE_CLOSE.NORMAL, "bye");
        return;
      }
      default:
        // 未知 type / 本阶段不处理的帧（req / res / cancel / grant_update_ack）
        // 一律忽略（协议 §2.2 的前向兼容规则）。1.2B.2 会在这里接 req/res。
        return;
    }
  };

  /**
   * 握手主流程。**每一个 await 之后都要重新确认自己还该继续**。
   *
   * 这不是「多检查几次更保险」，而是唯一正确的写法：`connection.closing`
   * 可能在任意一次 await 期间被 close 事件、hello 超时、顶替或停机置起，
   * 而 await 之后的代码不知道自己已经过期了。
   *
   * | await 点 | 期间可能发生 | 必须做的事 |
   * |---|---|---|
   * | `verifyHandshake`（DB） | 客户端断开 / hello 超时 | 直接收敛，**不得**继续 |
   * | `loadGrantRows`（DB） | 同上 + 停机 | 同上 |
   * | `admitDevice`（事务 + 行锁） | 撤停抢锁 | 失败即拒绝；成功后**再查一次** |
   */
  const handshake = async (connection: LiveConnection, raw: string): Promise<void> => {
    const token = tokenBySocket.get(connection.ws) ?? "";
    // token 只在这一刻需要；删掉引用，之后的任何代码路径都读不到它。
    tokenBySocket.delete(connection.ws);

    /** 本连接是否已被取消（自己关了、或者 Cloud 在停机）。 */
    const cancelled = (): boolean => connection.closing || shuttingDown;

    try {
      // ---- 第 1–8 步：认证、验签、nonce、版本 ----
      //
      // 这一步读到的设备状态是**快照**，只用于尽早拒绝便宜的错误。
      // 真正生效的判定在 `admitDevice` 的行锁内（见该文件顶部说明）。
      await hooks?.beforeVerify?.(connection.connectionId);
      if (cancelled()) return await abortHandshake(connection);

      const result = await verifyHandshake({ db: ctx.db.db, nonces, now }, { deviceToken: token, raw });
      if (cancelled()) return await abortHandshake(connection);

      if (!result.ok) {
        const mapped = mapHandshakeFailure(result.failure);
        ctx.logger.info("link_handshake_rejected", {
          connectionId: connection.connectionId,
          phase: "verify",
          kind: result.failure.kind,
          detail: result.failure.kind === "protocol" ? result.failure.detail : undefined,
        });
        return await abortHandshake(connection, mapped.code, mapped.reason);
      }

      // ---- 授权快照（锁外查，避免把行锁持有时间拉长）----
      //
      // `result.device.userId` / `.id` 是不可变列，用它查 grant 是安全的；
      // 而 `status` / `tokenExpiresAt` 会变，所以那两个不看这份快照。
      await hooks?.beforeGrants?.(connection.connectionId);
      if (cancelled()) return await abortHandshake(connection);

      const grants = await loadGrantRows(ctx.db.db, result.device.userId);
      if (cancelled()) return await abortHandshake(connection);

      // grant_ctx 每条连接重新生成：一次性引用，不落盘、不复用。
      const snapshots = toGrantSnapshots(grants, () => makeGrantContext());
      const tokenHash = sha256Hex(token);
      const admissionNow = new Date(now());

      await hooks?.beforeAdmission?.(connection.connectionId);
      if (cancelled()) return await abortHandshake(connection);

      // ---- 准入：行锁内重新验证 + bind（线性化点 = COMMIT）----
      const admission = await admitDevice(
        ctx.db.db,
        { deviceId: result.device.id, tokenHash, now: admissionNow },
        async (device) => {
          await hooks?.insideAdmission?.(connection.connectionId);

          // 锁已经拿到，但连接可能在这期间被取消。此时**不 bind**：
          // 事务提交后什么都不留，比「先 bind 再 unbound」少一次可见窗口。
          if (cancelled()) return { cancelled: true as const };

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
          // 三个事实同时更新：`bound` 一旦为 true，任何清理路径都必须解绑。
          connection.userId = device.userId;
          connection.deviceId = device.id;
          connection.bound = true;
          return { cancelled: false as const, bound };
        },
      );

      if (!admission.ok) {
        const mapped = mapAdmissionFailure(admission.failure);
        ctx.logger.info("link_handshake_rejected", {
          connectionId: connection.connectionId,
          phase: "admission",
          kind: admission.failure,
        });
        return await abortHandshake(connection, mapped.code, mapped.reason);
      }

      if (admission.value.cancelled) return await abortHandshake(connection);

      // 顶替：新连接已经生效（事务已提交），现在才处理旧的。
      if (admission.value.bound.displaced) {
        ctx.logger.info("link_superseded", {
          connectionId: admission.value.bound.displaced.connectionId,
          by: connection.connectionId,
          device: admission.value.bound.displaced.deviceId.slice(0, 8),
        });
        supersede(admission.value.bound.displaced);
      }

      // ---- 迟到的 bind：**必须在这里解绑** ----
      //
      // 这条分支就是 1.2B.1 留下幽灵路由的位置。close 事件可能在上面的
      // `await admitDevice` 期间到达，那时 `bound` 还是 false，所以
      // `converge()` 无事可做（它的幂等 promise 已经 resolve）。清理只能由
      // 恢复执行的**这里**完成——而 `releaseRoute` 有意不复用 `converge`
      // 的幂等闸门，正是为了不被那次「已经跑完的清理」短路。
      if (cancelled()) {
        ctx.logger.info("link_bind_after_close", { connectionId: connection.connectionId });
        await releaseRoute(connection);
        return await abortHandshake(connection);
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
        // 用**行锁内读到**的代数，不是 verify 阶段的旧快照。
        grant_epoch: admission.device.grantEpoch,
        grants: snapshots,
      };

      if (!sendJson(connection.ws, helloOk)) {
        // 发送失败（对端已关）：不能留一条「已 bind 但没有 socket」的路由。
        await releaseRoute(connection);
        return await abortHandshake(connection);
      }

      // 最后一道闸：`sendJson` 是同步的，但 close 事件可能在上一个 tick
      // 已经把它标成 closing（此时 readyState 仍是 OPEN 的窗口极窄，
      // 但这条判断不花钱，且让「已关闭不能进 active」成为结构事实）。
      if (cancelled()) {
        await releaseRoute(connection);
        return await abortHandshake(connection);
      }

      connection.state = "active";
      if (connection.helloTimeout) {
        clearTimeout(connection.helloTimeout);
        connection.helloTimeout = null;
      }
      connection.heartbeat.start();
      ctx.logger.info("link_established", {
        connectionId: connection.connectionId,
        device: admission.device.id.slice(0, 8),
        grants: snapshots.length,
        version: result.negotiatedVersion,
        serviceable: result.hello.serviceable,
      });
    } catch (err) {
      // 任何未预期异常（DB 抖动、钩子抛错、registry 实现抛错）都收敛到
      // 1011 + 确保路由不残留。**不能**让它冒成 unhandled rejection：
      // 那会让进程退出，而一条连接的问题不该影响整台 Gateway。
      ctx.logger.error("link_handshake_error", {
        connectionId: connection.connectionId,
        error: errorCode(err),
      });
      await releaseRoute(connection);
      await abortHandshake(connection, REMOTE_CLOSE.INTERNAL_ERROR, REMOTE_CLOSE_REASON.INTERNAL_ERROR);
    }
  };

  /**
   * 登记一次握手。停机时必须能等到它落定，否则 `registry.clear()` 之后
   * 还可能有一次 bind 把表项写回来。
   */
  const onHello = (connection: LiveConnection, raw: string): void => {
    // 先登记再挂 finally：`add` 必须在 `delete` 之前，否则一个**同步**完成的
    // 握手（例如解析就失败的帧）会让 finally 先跑，留下一个已 settle 的
    // promise 永远躺在集合里——`awaitHandshakes` 之后仍会看到它。
    const task: Promise<void> = handshake(connection, raw);
    inFlightHandshakes.add(task);
    void task.finally(() => {
      inFlightHandshakes.delete(task);
    });
  };

  /**
   * 握手被取消时的统一出口。
   *
   * 先 `converge`（清定时器、摘表、释放路由）再关 socket：反过来的话，
   * socket 的 close 事件与我们的收敛会竞争，虽然最终仍会收敛，但日志里
   * 会出现两条「关闭原因不同」的记录——排障时非常误导。
   */
  const abortHandshake = async (connection: LiveConnection, code?: number, reason?: string): Promise<void> => {
    await converge(connection);
    if (code !== undefined && reason !== undefined) closeWith(connection.ws, code, reason);
    else closeWith(connection.ws, REMOTE_CLOSE.GOING_AWAY, REMOTE_CLOSE_REASON.GOING_AWAY);
  };

  /** 顶替旧连接：`drain{grace_ms:0}` → close 4006。 */
  const supersede = (info: ConnectionInfo): void => {
    const target = live.get(info.connectionId);
    if (!target) return;
    // 标 closing 而不只是 state：`closing` 是**所有**路径共用的取消信号，
    // 只改 state 会让一个正在握手的旧连接看不到自己已被顶替。
    target.closing = true;
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

  /**
   * 释放本连接在路由表里的表项。**幂等，但不复用 `converge` 的闸门。**
   *
   * 为什么必须独立成一个函数：`converge()` 只跑一次，而「bind 晚于 close」
   * 这条路径要求**第二次**清理。用同一个 memoized promise 会让它被前一次
   * 的「无事可做」短路掉——那正是幽灵路由的成因。
   *
   * 三重身份（userId + deviceId + connectionId）由 `registry.unbind` 强制：
   * 迟到的清理不能删掉顶替它的新连接。
   */
  const releaseRoute = async (connection: LiveConnection): Promise<void> => {
    if (!connection.bound || connection.released) return;
    connection.released = true;
    try {
      await registry.unbind(connection.userId, connection.deviceId, connection.connectionId);
    } catch (err) {
      // 解绑失败 = 路由可能残留。不重试（内存实现不会抛；将来的 Redis 实现
      // 由 TTL 兜底），但必须留痕，并允许停机时的 `registry.clear()` 收尾。
      connection.released = false;
      ctx.logger.error("link_unbind_failed", {
        connectionId: connection.connectionId,
        error: errorCode(err),
      });
    }
  };

  /**
   * 连接收敛：**幂等**。清定时器、摘 live 表、释放路由。
   *
   * close 事件、心跳超时、主动断开、顶替、停机五条路都走它，所以它必须能被
   * 重复调用而不产生副作用。但它**不是**「路由已清理」的唯一判据——
   * 见 `releaseRoute` 的说明。
   */
  const converge = (connection: LiveConnection): Promise<void> => {
    if (connection.convergePromise) return connection.convergePromise;
    connection.closing = true;
    connection.state = "closing";
    connection.heartbeat.stop();
    if (connection.helloTimeout) {
      clearTimeout(connection.helloTimeout);
      connection.helloTimeout = null;
    }
    live.delete(connection.connectionId);
    connection.convergePromise = (async () => {
      await releaseRoute(connection);
      connection.state = "closed";
    })();
    return connection.convergePromise;
  };

  // MARK: - 对外

  const disconnectDevice: LinkServer["disconnectDevice"] = async (deviceId, reason) => {
    const info = await registry.lookupByDevice(deviceId);
    // 没有连接 = 正常情况（设备离线）。**不抛错**：调用方已经完成持久化，
    // 清理失败不能回滚它（安全运维 §4.1）。
    //
    // 注意：「此刻没有连接」不等于「以后不会有」——一个正在握手的连接可能
    // 在此之后才 bind。那个窗口由 `admitAndBind` 的行锁关掉：本函数的
    // UPDATE 若先提交，握手在锁内就会读到新状态并拒绝。
    if (!info) return;

    const target = live.get(info.connectionId);
    // 先删路由表项再通知：反过来会留下「表里还有、socket 已死」的窗口，
    // 期间任何请求都会打到死连接上（协议 §12.4）。
    await registry.unbind(info.userId, info.deviceId, info.connectionId);
    if (!target) return;

    // 标 closing 之后再发 bye：反过来的话，这条连接可能在「已收到 bye、
    // 尚未关闭」的窗口里被当成仍然可用（虽然本阶段不转发，但语义要正确）。
    target.closing = true;
    target.state = "closing";
    // `bound` 已由上面的 unbind 处理；把 released 置为 true，避免后续
    // converge 再解绑一次（那次会因 connectionId 已被删除而返回 false，
    // 但状态标记不该依赖「恰好是幂等的」）。
    target.released = true;
    target.heartbeat.stop();
    const code = reason === "revoked" ? REMOTE_CLOSE.DEVICE_REVOKED : REMOTE_CLOSE.DEVICE_SUSPENDED;
    const text =
      reason === "revoked" ? REMOTE_CLOSE_REASON.DEVICE_REVOKED : REMOTE_CLOSE_REASON.DEVICE_SUSPENDED;
    const bye: ByeFrame = { v: 1, type: "bye", ts: now(), reason };
    sendJson(target.ws, bye);
    closeWith(target.ws, code, text);
  };

  /**
   * 有序停机。
   *
   * 顺序里有两处**不能交换**：
   *
   * 1. `shuttingDown = true` 必须在**任何 await 之前**。它是所有进行中握手
   *    的取消信号；晚一步，那些握手就会在 clear 之后 bind 回来。
   * 2. `await waitForHandshakes()` 必须在 `registry.clear()` **之前**。
   *    清表后再等，只能看到表项被重新写回去。
   */
  const shutdown = async (): Promise<void> => {
    // 1. 停收新连接（handleUpgrade 顶部判 accepting），并通知进行中的握手取消。
    accepting = false;
    shuttingDown = true;
    // 2. 停心跳，通知所有连接。
    const targets = [...live.values()];
    for (const target of targets) {
      target.closing = true;
      target.state = "closing";
      target.heartbeat.stop();
      if (target.helloTimeout) {
        clearTimeout(target.helloTimeout);
        target.helloTimeout = null;
      }
      const drain: DrainFrame = { v: 1, ts: now(), type: "drain", reason: "shutdown", grace_ms: 0 };
      sendJson(target.ws, drain);
      const bye: ByeFrame = { v: 1, type: "bye", ts: now(), reason: "shutdown" };
      sendJson(target.ws, bye);
      // 1001 = 服务端下线，Desktop 应退避重连（协议 §9.3）。
      closeWith(target.ws, REMOTE_CLOSE.GOING_AWAY, REMOTE_CLOSE_REASON.GOING_AWAY);
    }
    // 3. 等所有**进行中的握手**落定。它们看到 shuttingDown 后会自行收敛，
    //    但收敛是异步的（要 await unbind）。不等的话，`registry.clear()`
    //    之后可能出现一次 bind。
    await waitForHandshakes(inFlightHandshakes, 1000);
    // 4. 等 socket 真正关闭，但**不无限等**：卡住的 TCP 对端不该拖住停机。
    await waitForClose(targets, 1000);
    for (const target of targets) {
      if (target.ws.readyState !== WebSocket.CLOSED) target.ws.terminate();
    }
    // 5. 逐个收敛，确保每条连接的路由都被释放（幂等，重复调用无害）。
    await Promise.all(targets.map((target) => converge(target)));
    // 6. 清表。此时 connection_count 必须归零。
    registry.clear();
    live.clear();
    // 7. 关闭 ws 服务端（不再接受 upgrade）。
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
    awaitHandshakes: (timeoutMs = 2000) => waitForHandshakes(inFlightHandshakes, timeoutMs),
    inspect: () =>
      [...live.values()].map((connection) => ({
        connectionId: connection.connectionId,
        deviceId: connection.deviceId,
        state: connection.state,
        closing: connection.closing,
        bound: connection.bound,
        released: connection.released,
        heartbeatRunning: connection.heartbeat.running(),
        helloTimeoutArmed: connection.helloTimeout !== null,
      })),
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

/**
 * 准入失败 → close code。
 *
 * 与 `mapHandshakeFailure` 分开而不是合并：两者的输入域不同，而合并会诱使
 * 有人把 `AdmissionFailure` 加进 `HandshakeFailure` 的联合类型里——
 * 那两类错误发生在完全不同的阶段（无锁预检 / 行锁内终审），混在一起会让
 * 「到底哪一步判死的」这个排障问题失去答案。
 */
function mapAdmissionFailure(failure: AdmissionFailure): { code: number; reason: string } {
  switch (failure) {
    case "revoked":
      return { code: REMOTE_CLOSE.DEVICE_REVOKED, reason: REMOTE_CLOSE_REASON.DEVICE_REVOKED };
    case "suspended":
      return { code: REMOTE_CLOSE.DEVICE_SUSPENDED, reason: REMOTE_CLOSE_REASON.DEVICE_SUSPENDED };
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

/**
 * 等一批进行中的握手落定，但有上限。
 *
 * 为什么需要：停机时 `registry.clear()` 必须发生在**所有 bind 之后**。
 * 一个卡在数据库查询上的握手若在 clear 之后恢复并 bind，表里就会多出
 * 一条指向已终止 socket 的路由，而 `connectionCount()` 会一直报 1。
 *
 * 为什么要有上限：一个永不返回的数据库查询不该把停机拖住。
 * 超时之后仍由「握手看到 `shuttingDown` 就自行收敛」兜底——那一条是
 * 结构保证，不依赖这里的等待成功。
 */
async function waitForHandshakes(tasks: ReadonlySet<Promise<unknown>>, timeoutMs: number): Promise<void> {
  if (tasks.size === 0) return;
  const all = Promise.allSettled([...tasks]);
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([all.then(() => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
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
