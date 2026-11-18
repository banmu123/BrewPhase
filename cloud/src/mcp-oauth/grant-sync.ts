import type { AppContext } from "../context.js";
import { orderMcpScopes } from "./constants.js";

/**
 * Grant → 在线 Desktop 的同步收口（Phase 1.3.1-C2b）。
 *
 * ## 它在整条链路里的位置
 *
 * ```
 * ① mcp_grants / mcp_auth_codes / mcp_auth_requests  ── 一个事务，提交
 * ② 本模块：把 grant 增量发给在线设备，等 ack          ── 提交之后才做
 * ③ 302 回客户端带 code
 * ```
 *
 * **顺序不可交换，也不可回滚**：数据库里的授权与设备是否在线是两个独立的
 * 生命周期。设备离线时授权依然成立（下次握手时 `hello_ok` 会按数据库重建
 * 快照），因为同步失败去回滚数据库，会让「设备刚好断线」变成「用户点了
 * 同意却没授权」——那是最糟的一种失败。
 *
 * ## 为什么只看 `inspectForwarder()`
 *
 * 路由层不该看到 socket、`ConnectionRegistry` 或 `grant_ctx`。转发层已经
 * 维护了「每条连接装了哪些 grant」的全部事实，`inspect()` 是它的只读投影。
 * 这里据此回答三个问题：这个用户有没有在线连接 / 那条连接装没装这条 grant /
 * 装的那份 scope 与数据库是否一致。
 *
 * 选取规则是「**当前用户的任意一条连接**」：Phase 1.3 是单设备模型，
 * 多设备（`is_primary`、用户选择）属 1.4。这里不发明「选哪台」的策略。
 */

export type GrantSyncStatus =
  | "skipped_no_link"
  | "skipped_offline"
  | "skipped_installed"
  | "installed"
  | "replaced"
  | "failed";

export interface GrantSyncResult {
  status: GrantSyncStatus;
  /** 失败原因（来自转发层），只用于日志与审计，不进 HTTP 响应。 */
  reason?: string;
  deviceId?: string;
}

export interface GrantSyncInput {
  userId: string;
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: readonly string[];
  /** **单条 grant** 的版本，不是设备级 `grant_epoch`。 */
  epoch: number;
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  const left = orderMcpScopes(a);
  const right = orderMcpScopes(b);
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

/**
 * 把一条已提交的 grant 同步到在线设备。
 *
 * **永不抛错**：调用方已经拿到了一个有效的授权码，任何同步异常都不能让它
 * 变成 500（那样客户端永远拿不到 code）。失败只记录，路由由转发层自己的
 * fail-closed 规则处理——未 ack 的 ctx 本来就不可派发。
 */
export async function syncGrantToOnlineDevice(
  ctx: AppContext,
  input: GrantSyncInput,
): Promise<GrantSyncResult> {
  const link = ctx.link;
  if (!link) return { status: "skipped_no_link" };

  let connections;
  try {
    connections = link.inspectForwarder().connections;
  } catch {
    // 诊断接口本身出错也不该影响授权结果。
    return { status: "failed", reason: "inspect_failed" };
  }

  const connection = connections.find((entry) => entry.userId === input.userId);
  if (!connection) return { status: "skipped_offline" };

  const deviceId = connection.deviceId;
  const slot = connection.grants.find((entry) => entry.grantId === input.grantId);

  // 已安装且 scope 一致 → 不重复发帧。
  //
  // 重复 install 在转发层会被当成「同一条 grant 再装一次」并先卸旧 ctx，
  // 也就是一次无谓的 revoke + install 往返；更糟的是它会把设备级
  // `grant_epoch` 白涨一格。scope 没变就什么都不做，是唯一正确的选择。
  if (slot?.installed === true && sameScopes(slot.scopes, input.scopes)) {
    return { status: "skipped_installed", deviceId };
  }

  const grant = {
    grantId: input.grantId,
    clientId: input.clientId,
    clientName: input.clientName,
    scopes: [...input.scopes],
    epoch: input.epoch,
  };

  try {
    const outcome = slot
      ? await link.replaceGrant({ deviceId, grant, reason: "scope_changed" })
      : await link.installGrant({ deviceId, grant });
    if (outcome.ok) {
      return { status: slot ? "replaced" : "installed", deviceId };
    }
    // `sync_lag` / `ack_timeout` / `rejected` / `offline` 都**不能**被当成
    // 「已经装好」。转发层已经把该连接或该 grant 置为不可路由，这里只负责
    // 如实记账。
    return { status: "failed", reason: outcome.reason, deviceId };
  } catch {
    // **不记录异常消息**：它的来源是转发层的序列化/网络栈，无法保证不含
    // 帧内容（帧里有 grant_ctx 与 scope）。失败原因用固定枚举即可定位。
    return { status: "failed", reason: "exception", deviceId };
  }
}
