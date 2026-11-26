import { z } from "zod";

/**
 * Remote Link Protocol v1 的 Cloud 侧线格式（协议 §1 / §2 / §4 / §5）。
 *
 * ## 为什么这个文件里有两个「必须一致」的清单
 *
 * `allowed_tools` 与 `helloSigningPayload` 都必须与 **Desktop** 逐字节一致，
 * 但 Cloud **不能** import Desktop 的源码（`cloud/` 是独立发布单元，
 * 引过去会把桌面端的构建产物拖进服务端）。
 *
 * 因此做法是：两边各自实现，再用一份**共享 golden fixture**
 * （`fixtures/remote-mcp/hello-v1.json`）在两端测试里逐项比对。
 * 「两边各写一份然后互相证明自己正确」不算证据；对同一份固定向量
 * 得出同一个结果才算。
 */

// MARK: - 常量

/** 协议主版本。第一版双方都只实现 1，但协商必须走区间公式。 */
export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_MIN_VERSION = 1;
export const REMOTE_MAX_VERSION = 1;

/**
 * WSS 子协议（协议 §4.1）。
 *
 * 它不是装饰：协商失败会在**进入帧层之前**就被拒。也正因为它在 HTTP 头里，
 * `device_token` 绝不能塞进这里——反向代理会记 `Sec-WebSocket-Protocol`。
 */
export const REMOTE_WS_SUBPROTOCOL = "brewphase.remote.v1";

/** 连接路径。精确匹配，不接受前缀/尾斜杠/查询串以外的变体。 */
export const REMOTE_LINK_PATH = "/device-link";

/** 单帧上限：1 MiB。Cloud 只能比 `hello_ok` 里声明的更紧，不能更松。 */
export const REMOTE_MAX_FRAME_BYTES = 1024 * 1024;

/** 心跳周期与空闲上限（协议 §5.1）。 */
export const REMOTE_HEARTBEAT_MS = 20_000;
export const REMOTE_IDLE_TIMEOUT_MS = 60_000;

/**
 * 连接级在途请求上限（`hello_ok.max_inflight`）。
 *
 * Phase 1.2B.1 只下发；1.2B.2.2 起 Cloud 自己**真正执行**这个限制
 * （`request-registry.ts`）。Desktop 在 pong 里上报的 `inflight` 只是提示，
 * 不参与限流判断——那是被限流方自己报的数。
 */
export const REMOTE_MAX_INFLIGHT = 2;

/**
 * 每用户 / 每设备的在途请求上限（安全运维的并发预算，不是协议字段）。
 *
 * 为什么用户级(4) > 设备级(2)：第一版每用户只有一条连接（协议 §4.6），
 * 所以用户级的上限实际上永远不会先命中——它存在是为了 Phase 1.4 支持
 * 多设备并行时**不需要再改一遍调度代码**。少写一层的代价是：等那一天到来时，
 * 限流逻辑会被迫在「已经在跑热路径」上重构。
 */
export const REMOTE_USER_MAX_INFLIGHT = 4;
export const REMOTE_DEVICE_MAX_INFLIGHT = 2;

/** Gateway 侧排队预算：超过就 `DEVICE_BUSY`，不让调用方无限等（协议运行时 §7.2）。 */
export const REMOTE_QUEUE_BUDGET_MS = 2_000;

/**
 * 队列长度上限。
 *
 * 有上限才有意义：没有它，一次设备卡死会让云端的待发帧无限堆积，
 * 而每一个都持有一个 deadline 定时器——那是一个把「设备慢」放大成
 * 「Gateway OOM」的放大器。
 */
export const REMOTE_QUEUE_MAX = 32;

/** 单次工具调用的默认执行预算（写进 `deadline_ms`）。 */
export const REMOTE_TOOL_BUDGET_MS = 15_000;

/** 硬上限：任何 `clientDeadline` 都不能把预算推到这之外（协议运行时 §7.2）。 */
export const REMOTE_HARD_DEADLINE_MS = 30_000;

/**
 * `grant_update` 等待 ack 的上限。
 *
 * 超时的后果很重（整台设备停服），所以这个值不能太小；但它也**不能**是
 * 无限——「无法确认撤销已生效」必须有一个明确的收敛点，否则 Cloud 会永久
 * 停在「不确定」状态里继续路由。
 */
export const REMOTE_GRANT_ACK_TIMEOUT_MS = 3_000;

/**
 * 业务错误码（协议运行时 §9.1，**唯一权威表**）。
 *
 * 19 个。Cloud 只产生其中一部分（它不产生 `INVALID_ARGUMENTS` 这类
 * Desktop 侧执行错误），但常量表保持完整：`res.error.code` 的校验必须
 * 用**全集**，否则 Desktop 报一个新码时 Cloud 会把它误判成畸形帧。
 */
export const REMOTE_ERROR_CODES = [
  "DEVICE_OFFLINE",
  "DEVICE_UNAUTHORIZED",
  "DEVICE_REVOKED",
  "DEVICE_SUSPENDED",
  "REMOTE_DISABLED",
  "DEVICE_BUSY",
  "USER_MISMATCH",
  "GRANT_CONTEXT_INVALID",
  "GRANT_REVOKED",
  "SCOPE_DENIED",
  "TOOL_NOT_ALLOWED",
  "INVALID_ARGUMENTS",
  "NOT_FOUND",
  "REQUEST_TIMEOUT",
  "REQUEST_CANCELLED",
  "REQUEST_TOO_LARGE",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "PROTOCOL_VIOLATION",
  "INTERNAL_ERROR",
] as const;
export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number];

/**
 * 工具 → 所需 scope（与 Desktop `REMOTE_TOOL_SCOPES` 逐项相同）。
 *
 * Cloud 侧保留这份映射是**必须**的：派发前的 scope 判定不能等 Desktop 做
 * （那样「不该发出去的请求」已经离开了 Cloud）。两处都保留不是冗余——
 * Cloud 的判据是「这条授权够不够派发」，Desktop 的判据是「本机愿意执行什么」。
 */
export const REMOTE_TOOL_SCOPES: Record<RemoteToolName, RemoteScope> = {
  search_records: "records:read",
  get_record: "records:read",
  list_record_tags: "tags:read",
  list_beans: "coffee:read",
  list_brews: "coffee:read",
  list_tastings: "coffee:read",
  list_canvases: "canvas:read",
  get_canvas: "canvas:read",
};

/** 该工具是否属于远程面（`REMOTE_TOOLS` 常量内）。 */
export function isRemoteTool(tool: string): tool is RemoteToolName {
  return (REMOTE_TOOLS as readonly string[]).includes(tool);
}

/** 工具所需 scope；未知工具返回 `null`。 */
export function scopeForTool(tool: string): RemoteScope | null {
  return isRemoteTool(tool) ? REMOTE_TOOL_SCOPES[tool] : null;
}

/** 错误码的可重试性（与 Desktop `isRetryableRemoteError` 同一张表）。 */
export function isRetryableRemoteError(code: RemoteErrorCode): boolean {
  return (
    code === "DEVICE_OFFLINE" ||
    code === "DEVICE_BUSY" ||
    code === "REQUEST_TIMEOUT" ||
    code === "INTERNAL_ERROR"
  );
}

/** 握手时限：连接建立后 5 秒内必须收到 `hello`（协议 §4.2）。 */
export const REMOTE_HELLO_TIMEOUT_MS = 5_000;

/** `hello.ts` 与本机时钟的最大偏差（协议 §4.3 第 5 步）。 */
export const REMOTE_MAX_CLOCK_SKEW_MS = 120_000;

/** nonce 去重窗口（协议 §4.3 第 7 步）。 */
export const REMOTE_NONCE_WINDOW_MS = 120_000;

/**
 * 远程第一版工具面：8 个只读工具（协议 §4.4）。
 *
 * **写死**。不从任何「工具定义」派生出这个清单——派生会让 Desktop 端新增
 * 一个本地工具就自动扩张远程面，也就等于 Cloud 能间接扩大自己在设备上的权限
 * （安全 §2.7.7）。顺序与协议一致，测试逐项比对。
 */
export const REMOTE_TOOLS = [
  "search_records",
  "get_record",
  "list_record_tags",
  "list_beans",
  "list_brews",
  "list_tastings",
  "list_canvases",
  "get_canvas",
] as const;
export type RemoteToolName = (typeof REMOTE_TOOLS)[number];

/** 远程可授出的 scope：4 个，全部只读。grant 的 scopes 必须被过滤到这个集合内。 */
export const REMOTE_SCOPES = ["records:read", "tags:read", "coffee:read", "canvas:read"] as const;
export type RemoteScope = (typeof REMOTE_SCOPES)[number];

/**
 * WSS close code（协议 §9.3）。
 *
 * **4xxx 一律不重连**，1001 / 1011 / 4008 / 4011 是技术性关闭必须重连。
 * 混淆会导致撤销后无限重连风暴。Cloud 侧只发送其中一部分（它不会发 4004
 * 之外那些「Desktop 专用」的码，但常量表保持完整，便于日志对照）。
 */
export const REMOTE_CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  INTERNAL_ERROR: 1011,
  UNAUTHORIZED: 4001,
  VERSION_UNSUPPORTED: 4002,
  DEVICE_REVOKED: 4003,
  USER_MISMATCH: 4004,
  DEVICE_SUSPENDED: 4005,
  SUPERSEDED: 4006,
  HELLO_TIMEOUT: 4007,
  HEARTBEAT_TIMEOUT: 4008,
  PROTOCOL_VIOLATION: 4009,
  CREDENTIALS_ROTATED: 4010,
  MAINTENANCE: 4011,
} as const;

/**
 * 关闭原因文案。
 *
 * **固定、短小、不含任何敏感信息**：close reason 会原样出现在 Desktop 的
 * 日志与界面上，也可能出现在中间设备的日志里。所以这里没有 device_id、
 * 没有 token 片段、没有版本号细节——排障需要的细节走 Cloud 自己的日志。
 */
export const REMOTE_CLOSE_REASON = {
  UNAUTHORIZED: "unauthorized",
  VERSION_UNSUPPORTED: "version unsupported",
  DEVICE_REVOKED: "device revoked",
  DEVICE_SUSPENDED: "device suspended",
  SUPERSEDED: "superseded",
  /** 凭据已轮换：旧连接必须退场，客户端用新凭据立刻重连一次（不按退避）。 */
  CREDENTIALS_ROTATED: "credentials rotated",
  HELLO_TIMEOUT: "hello timeout",
  HEARTBEAT_TIMEOUT: "heartbeat timeout",
  PROTOCOL_VIOLATION: "protocol violation",
  GOING_AWAY: "going away",
  INTERNAL_ERROR: "internal error",
} as const;

// MARK: - base64url 严格解码

const BASE64URL_CHARS = /^[A-Za-z0-9_-]+$/;

/**
 * 严格解码 base64url：**长度、字符集、规范位**三项都查。
 *
 * `Buffer.from(text, "base64url")` 是宽松的——它会忽略非法字符、接受非规范
 * 的末尾填充位。三个必须自己做的检查：
 *
 * 1. 字符集：否则 `"!!!!"` 会安静地解成空 Buffer；
 * 2. 解码长度：`"43 个合法字符"` 仍可能解出 31/33 字节（末位字符携带多余 bit）；
 * 3. **重新编码必须逐字符相同**：这一步才真正挡住「非规范编码」。
 *    没有它，同一个公钥可以有多种文本表示，`token_hash`/公钥比对会出现
 *    「字节相同、字符串不同」的分歧。
 *
 * 任何一项不过都返回 `null`，由调用方统一映射成 PROTOCOL_VIOLATION。
 */
export function decodeBase64UrlStrict(text: string, expectedBytes: number): Buffer | null {
  // 运行时再判一次类型：这个函数会被「来自网络的帧」直接喂入，
  // 而 TypeScript 的类型在运行时不存在。缺字段（undefined）若直接走到
  // `text.length` 会抛 TypeError，调用方一 catch 就成了「验签失败」——
  // 行为上没错，但错误分类会从「帧不合规」变成「内部异常」。
  if (typeof text !== "string" || text.length === 0) return null;
  if (!BASE64URL_CHARS.test(text)) return null;
  const buf = Buffer.from(text, "base64url");
  if (buf.length !== expectedBytes) return null;
  if (buf.toString("base64url") !== text) return null;
  return buf;
}

// MARK: - 帧

/**
 * 帧信封。**只用来读 `v` 与 `type`**，其余字段交给各帧自己的闭合 schema。
 *
 * 先读信封再严格解析，是为了把两类错误分开：
 * - `v` 不受支持 → **4002**（版本不兼容，双方都合法）；
 * - 形状非法（未知键 / 类型错 / 缺字段） → **4009**（帧格式非法）。
 *
 * 混用这两个码会让排障方向从一开始就是错的：4002 提示「该升级/回滚」，
 * 4009 提示「有人在说协议之外的话」。
 */
export const frameEnvelopeSchema = z
  .object({ v: z.number().int(), type: z.string().min(1).max(64) })
  .passthrough();
export type FrameEnvelope = z.infer<typeof frameEnvelopeSchema>;

/** 字段值不得含换行：规范串是「换行 + `=`」分隔的，值里带换行会造成规范歧义。 */
const noLineBreak = (field: string) =>
  z
    .string()
    .min(1)
    .refine((value) => !/[\n\r]/.test(value), { message: `${field} must not contain line breaks` });

/**
 * `hello`（Desktop → Cloud，协议 §4.2）。
 *
 * **闭合键集**（`.strict()`）：未知键一律拒绝。这不是洁癖——`hello` 是唯一
 * 进入签名规范串的帧，多一个字段就意味着「签名覆盖什么」这件事在两端不一致。
 * 将来要加字段，必须同时定义 `brewphase.remote.hello.v2` 前缀。
 */
export const helloSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("hello"),
    ts: z.number().int(),
    device_id: noLineBreak("device_id").max(128),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    min_version: z.number().int().positive(),
    max_version: z.number().int().positive(),
    app_version: noLineBreak("app_version").max(64),
    platform: noLineBreak("platform").max(32),
    capabilities: z.array(noLineBreak("capability").max(64)).max(16),
    serviceable: z.boolean(),
    sig: z.string().min(1).max(512),
  })
  .strict()
  .refine((value) => value.min_version <= value.max_version, {
    message: "min_version must not exceed max_version",
  });
export type Hello = z.infer<typeof helloSchema>;

/** 参与签名的字段（**除 `sig` 外全部**），顺序即规范串顺序。 */
export type HelloSigningInput = Omit<Hello, "sig">;

/**
 * 规范串（协议 §4.2.1，**唯一实现**；与 Desktop `helloSigningPayload` 逐字节相同）。
 *
 * ```
 * brewphase.remote.hello.v1
 * v=1
 * type=hello
 * ts=1763400000123
 * device_id=…
 * nonce=…
 * min_version=1
 * max_version=1
 * app_version=0.1.5
 * platform=darwin
 * capabilities=cancel,drain,tools.call
 * serviceable=true
 * ```
 *
 * 四条不可动的理由：
 * 1. 首行是**域分隔**。没有它，同一把私钥在别处（例如将来的 rotate）签的
 *    消息可能与 hello 在字节上同形，形成跨协议签名复用；
 * 2. `min_version` / `max_version` / `capabilities` **必须在签名内**。
 *    不在的话，一条被改过的帧可以让 Cloud 以为这台设备只支持更老的版本，
 *    从而关掉它本可用的保护；
 * 3. 值不得含换行（否则两组不同字段可能产生同一段字节）；
 * 4. 字段集在 v1 内冻结。
 */
export function helloSigningPayload(input: HelloSigningInput): Buffer {
  const text = [
    "brewphase.remote.hello.v1",
    `v=${input.v}`,
    `type=${input.type}`,
    `ts=${input.ts}`,
    `device_id=${assertNoSeparators("device_id", input.device_id)}`,
    `nonce=${assertNoSeparators("nonce", input.nonce)}`,
    `min_version=${input.min_version}`,
    `max_version=${input.max_version}`,
    `app_version=${assertNoSeparators("app_version", input.app_version)}`,
    `platform=${assertNoSeparators("platform", input.platform)}`,
    `capabilities=${[...input.capabilities]
      .sort()
      .map((capability) => assertNoSeparators("capabilities", capability))
      .join(",")}`,
    `serviceable=${input.serviceable ? "true" : "false"}`,
  ].join("\n");
  return Buffer.from(text, "utf8");
}

function assertNoSeparators(field: string, value: string): string {
  if (/[\n\r]/.test(value)) throw new Error(`${field} must not contain line breaks`);
  return value;
}

/** `pong`（Desktop → Cloud，协议 §5.1）。`seq` 必须回显最后一次 `ping` 的值。 */
export const pongSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("pong"),
    ts: z.number().int(),
    seq: z.number().int().nonnegative(),
    inflight: z.number().int().nonnegative(),
  })
  .strict();
export type Pong = z.infer<typeof pongSchema>;

/** `status`（Desktop → Cloud）。**提示帧**，Cloud 不得据此跳过自己的 grant/scope 校验。 */
export const statusFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("status"),
    ts: z.number().int(),
    serviceable: z.boolean(),
    reason: z.string().max(64).optional(),
  })
  .strict();

/** `bye`（双向）。收到即视为对端要走了。 */
export const byeSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("bye"),
    ts: z.number().int(),
    reason: z.string().max(64).optional(),
  })
  .strict();

// MARK: - 出站帧

export interface GrantSnapshot {
  grant_ctx: string;
  grant_id: string;
  client_id: string;
  client_name: string;
  /** 已过滤到 `REMOTE_SCOPES` 之内；可能为空数组（授权存在但无一可用）。 */
  scopes: RemoteScope[];
  bound_user_id: string;
  epoch: number;
}

/**
 * `hello_ok`（Cloud → Desktop，协议 §4.4）。
 *
 * 字段集合必须与 Desktop 的 `remoteHelloOkSchema` 一致。三条禁止：
 * - **没有** `serviceable`（那是 Desktop 的自报状态，方向不可反）；
 * - **没有** `device_token` / 任何凭证；
 * - `allowed_tools` 只能是上面写死的 8 个，不接受任何动态扩张。
 */
export interface HelloOk {
  v: 1;
  type: "hello_ok";
  ts: number;
  connection_id: string;
  instance_id: string;
  server_time: number;
  heartbeat_ms: number;
  idle_timeout_ms: number;
  max_inflight: number;
  max_frame_bytes: number;
  allowed_tools: string[];
  grant_epoch: number;
  grants: GrantSnapshot[];
}

export interface PingFrame {
  v: 1;
  type: "ping";
  ts: number;
  seq: number;
}

export interface DrainFrame {
  v: 1;
  type: "drain";
  ts: number;
  reason: string;
  grace_ms: number;
}

export interface ByeFrame {
  v: 1;
  type: "bye";
  ts: number;
  reason: string;
}

/**
 * `req`（Cloud → Desktop，协议运行时 §6.1）。
 *
 * 字段集与 Desktop `remoteReqSchema` 逐项相同。三条禁止（都是「两个事实来源」
 * 的老问题）：
 *
 * - **没有** `user_id` / `grant_id` / `client_id` / `scopes`：身份与授权只在
 *   `grant_ctx` 指向的上下文里，请求帧同时带「引用」和「自报身份」时，
 *   实现者一定会误用后者；
 * - **没有** `connection_id`：那是连接层的事实，帧里带一份就有了两个真相；
 * - `grant_ctx` 只能由 Cloud 从**当前连接**的上下文映射得到，不接受调用方指定。
 */
export interface ReqFrame {
  v: 1;
  type: "req";
  id: string;
  ts: number;
  tool: string;
  arguments: unknown;
  request_hash: string;
  /** **绝对** epoch 毫秒（相对超时会在每一跳累积误差）。 */
  deadline_ms: number;
  grant_ctx: string;
  trace?: { mcp_request_id?: string; received_at?: number };
}

/** `cancel`（Cloud → Desktop，协议运行时 §7.5）。 */
export interface CancelFrame {
  v: 1;
  type: "cancel";
  id: string;
  ts: number;
  reason: string;
}

/** `grant_update`（Cloud → Desktop，协议运行时 §6.5.2）。 */
export interface GrantUpdateFrame {
  v: 1;
  type: "grant_update";
  ts: number;
  /** **设备级**代数，单调递增。不是单 grant 的 `epoch`。 */
  grant_epoch: number;
  op: "install" | "revoke";
  grant?: GrantSnapshot;
  grant_ctx?: string;
  reason?: string;
}

/**
 * `res`（Desktop → Cloud，协议运行时 §6.3）。
 *
 * `ok:true` 必须带 `data`（哪怕是 `null`），`ok:false` 必须带 `error`。
 * 用 `refine` 而不是 `optional` 的直觉写法，是因为「`ok:true` 但没有 data」
 * 会被下游当成「执行成功、结果为空」——那是一个**静默的错答案**。
 */
export const resSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("res"),
    id: z.string().min(1).max(128),
    ts: z.number().int(),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.enum(REMOTE_ERROR_CODES),
        message: z.string().max(400),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
    meta: z
      .object({
        duration_ms: z.number().int().nonnegative(),
        cached: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .refine((value) => (value.ok ? value.data !== undefined : value.error !== undefined), {
    message: "ok requires data; failure requires error",
  });
export type ResFrame = z.infer<typeof resSchema>;

/** `grant_update_ack`（Desktop → Cloud，协议运行时 §6.5.2）。 */
export const grantUpdateAckSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("grant_update_ack"),
    ts: z.number().int(),
    grant_epoch: z.number().int().nonnegative(),
    applied: z.boolean(),
    reason: z.string().max(64),
  })
  .strict();
export type GrantUpdateAck = z.infer<typeof grantUpdateAckSchema>;

/**
 * 版本区间协商（协议 §1.1 的公式，唯一实现）。
 *
 * 返回双方共同支持的最高版本；无交集返回 `null`（调用方 close 4002）。
 * 注意返回值是 `hi` 而不是 `min(max_version, CLOUD_MAX)`——后者少了
 * `max(c_min, s_min)` 那一半，会让「客户端下限高于服务端上限」这种情况
 * 得到一个不存在的版本号。
 */
export function negotiateVersion(
  clientMin: number,
  clientMax: number,
  serverMin: number = REMOTE_MIN_VERSION,
  serverMax: number = REMOTE_MAX_VERSION,
): number | null {
  if (clientMin > clientMax) return null;
  if (serverMin > serverMax) return null;
  const lo = Math.max(clientMin, serverMin);
  const hi = Math.min(clientMax, serverMax);
  return lo > hi ? null : hi;
}

/** scope 白名单过滤。未知 scope **丢弃**而不是让整个 grant 失败。 */
export function filterScopes(scopes: readonly string[]): RemoteScope[] {
  const allowed = new Set<string>(REMOTE_SCOPES);
  const out: RemoteScope[] = [];
  for (const scope of scopes) {
    // 去重：数据库里重复的 scope 会让 Desktop 的 scope 集合语义变得不可预测。
    if (allowed.has(scope) && !out.includes(scope as RemoteScope)) out.push(scope as RemoteScope);
  }
  return out;
}
