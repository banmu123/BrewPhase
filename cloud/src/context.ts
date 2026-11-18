import type { Hono } from "hono";
import type { DbHandle } from "./db/client.js";
import type { Env } from "./env.js";
import type { JwtKeyRing, AccessClaims } from "./sessions/jwt.js";
import type { Logger } from "./logger.js";
import type { ProviderMap } from "./oauth/providers.js";
import type { DispatchToolCallInput, Forwarder, GrantSyncOutcome } from "./link/forwarder.js";
import type { DispatchResult } from "./link/request-registry.js";

export type AppHono = Hono<{ Variables: { authClaims: AccessClaims } }>;

/**
 * 应用级依赖：由 app.ts 装配，路由层只依赖这个接口（便于测试注入）。
 *
 * `link` 与 `instanceId` 都是**可选**的：
 *
 * - `link` 只在真正的 Gateway 进程里存在（测试与纯 HTTP 场景不需要）。
 *   设备暂停/撤销的「清理连接」这一步由它提供；为 `undefined` 时路由层
 *   跳过清理——那正是「只跑 HTTP 的测试」想要的语义（没有连接可清）。
 * - `instanceId` 每次启动生成，`/ready` 用它暴露「我是不是另一台实例」。
 */
export interface AppContext {
  env: Env;
  db: DbHandle;
  providers: ProviderMap;
  logger: Logger;
  keyRing: JwtKeyRing;
  link?: LinkControl;
  instanceId?: string;
}

/**
 * 路由层需要的**唯一**连接控制面。
 *
 * 刻意只暴露三个方法：`disconnectDevice`（suspend / revoke 之后清连接）、
 * `rotateConnection`（轮换之后让旧连接退场）与 `connectionCount`（`/ready`）。
 * 路由层不该看到 `bind` / `lookup` / 心跳——那些属于连接层，混进来就会长出
 * 「HTTP 路由直接操作 socket」的代码。
 */
export interface LinkControl {
  readonly instanceId: string;
  connectionCount(): number;
  disconnectDevice(deviceId: string, reason: "suspended" | "revoked"): Promise<void>;
  /**
   * 凭据轮换后让旧连接退场（`bye(rotated)` + close 4010）。
   *
   * **必须在数据库事务提交之后调用**：反过来（先断连接再改库）会留下
   * 「旧连接已死、旧凭据仍然有效」的窗口，攻击者可以拿旧 token 重新握手。
   */
  rotateConnection(deviceId: string): Promise<boolean>;
  /**
   * 派发一次工具调用（协议运行时 §6.1）。
   *
   * 这是 Phase 1.3 的 `/mcp` 端点**唯一**会用的入口。刻意只收「语义参数」
   * （用户、grant、工具、参数、截止时间），**不暴露** connectionId / grant_ctx /
   * socket ——那三样一旦出现在签名里，路由层就会开始「顺手拿连接做点别的」，
   * 而所有跨用户校验都在这一层之后。
   *
   * `userId` **只能**来自已验证的 MCP JWT `sub`。从请求体读它等于把授权
   * 交给调用方自己声明。
   */
  dispatchToolCall(input: DispatchToolCallInput): Promise<DispatchResult>;
  /**
   * 把一条 grant 增量下发给在线设备并等待 ack。
   *
   * Phase 1.3 的 OAuth 授权/撤销路径会调用它。**未 ack 前该 grant 不可路由**
   * （协议 §6.5.2 规则 2），所以调用方必须先落库再调这里，不能反过来。
   */
  installGrant(input: Parameters<Forwarder["installGrant"]>[0]): Promise<GrantSyncOutcome>;
  /** 撤销一条 grant：**先停路由** → 发帧 → 等 ack。 */
  revokeGrant(input: Parameters<Forwarder["revokeGrant"]>[0]): Promise<GrantSyncOutcome>;
  /** scope 变更：旧 ctx revoke → ack → 新 ctx install → ack。 */
  replaceGrant(input: Parameters<Forwarder["replaceGrant"]>[0]): Promise<GrantSyncOutcome>;
  /**
   * **只读诊断**：每条连接当前的授权同步状态。
   *
   * 授权路径（Phase 1.3.1-C2b）用它回答「这个用户有没有在线设备、那条连接
   * 装的是哪一份 scope」。它是 `Forwarder["inspect"]` 的投影，不含 socket、
   * 不含 `grant_ctx` 以外的任何凭据。
   *
   * 单独暴露这一条而不是整个 `Forwarder`：路由层一旦拿到转发层实例，
   * 就会开始「顺手 dispatch 一下」——那会让 `/mcp` 的准入校验被绕过。
   */
  inspectForwarder(): ReturnType<Forwarder["inspect"]>;
}
