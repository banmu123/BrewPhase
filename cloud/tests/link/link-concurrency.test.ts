import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";
import { mcpDevices, users } from "../../src/db/schema.js";
import { sha256Hex } from "../../src/security/crypto.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import { signAccessToken } from "../../src/sessions/jwt.js";
import { helloSigningPayload, REMOTE_CLOSE, type Hello } from "../../src/link/schemas.js";
import {
  createMemoryConnectionRegistry,
  type ConnectionRegistry,
} from "../../src/link/connection-registry.js";
import { connect, createLinkHarness, type LinkHarness } from "../helpers/link-server.js";

/**
 * 握手生命周期与设备准入的**并发**测试（Phase 1.2B.1.2）。
 *
 * ## 为什么这一组不能靠 sleep
 *
 * 竞态的本质是「两个操作在某个 await 点上交错」。用 `setTimeout(随机)`
 * 去碰那种交错，测的是调度运气：机器快的时候可能永远碰不到，机器慢的时候
 * 可能碰到别的交错 —— 于是它既会假绿，也会偶发红。
 *
 * 这里用**可控 Deferred**：在精确的 await 边界挂住协程，等测试把另一条
 * 路径完整跑完（不是「跑一会儿」），再放行。这样每条用例只有一个确定的
 * 交错顺序，失败能被复现。
 *
 * 唯一的例外是 T3 的 hello 超时：它必须等真实的 60ms 定时器。那不是模拟
 * 竞态，而是等一个真实的超时事件。
 */

// MARK: - 原语

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 等一个可观察条件成立（只用于等真实事件，不用于「制造」并发）。 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met: ${label}`);
}

// MARK: - 设备与 hello 构造

const FIXTURE = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "remote-mcp", "hello-v1.json"),
    "utf8",
  ),
) as { hello: Hello };

function freshKey(): { privateKey: KeyObject; publicKeyRaw: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64url");
  return { privateKey, publicKeyRaw: raw };
}

interface Seeded {
  deviceId: string;
  userId: string;
  deviceToken: string;
  privateKey: KeyObject;
}

async function seedUser(h: LinkHarness, name = "Concurrency"): Promise<string> {
  const rows = await h.ctx.db.db.insert(users).values({ displayName: name }).returning({ id: users.id });
  return rows[0]?.id as string;
}

async function seedDevice(
  h: LinkHarness,
  overrides: { userId?: string; key?: ReturnType<typeof freshKey>; status?: string } = {},
): Promise<Seeded> {
  const userId = overrides.userId ?? (await seedUser(h));
  const key = overrides.key ?? freshKey();
  const deviceToken = `bp_dev_${randomBytes(24).toString("base64url")}`;
  const rows = await h.ctx.db.db
    .insert(mcpDevices)
    .values({
      userId,
      name: "concurrency",
      platform: "darwin",
      publicKey: key.publicKeyRaw,
      status: overrides.status ?? "active",
      confirmCodeHash: "unused",
      claimSecretHash: "unused",
      expiresAt: new Date(Date.now() + 300_000),
      tokenHash: sha256Hex(deviceToken),
      tokenIssuedAt: new Date(),
      tokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
    })
    .returning({ id: mcpDevices.id });
  return { deviceId: rows[0]?.id as string, userId, deviceToken, privateKey: key.privateKey };
}

function freshNonce(): string {
  return randomBytes(16).toString("base64url");
}

function buildHello(device: Seeded, overrides: Partial<Hello> = {}): Hello {
  const base: Hello = {
    ...FIXTURE.hello,
    ts: Date.now(),
    nonce: freshNonce(),
    device_id: device.deviceId,
    serviceable: true,
    ...overrides,
  };
  const { sig: _sig, ...signingInput } = base;
  const sig = cryptoSign(null, helloSigningPayload(signingInput), device.privateKey).toString("base64url");
  return { ...base, sig };
}

/** 打开一条连接并发出 hello，返回 ws 与 close 信息。 */
async function openAndHello(
  h: LinkHarness,
  device: Seeded,
  overrides: Partial<Hello> = {},
): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
  const conn = await connect(h, { token: device.deviceToken });
  if (!conn.ok) throw new Error(`upgrade failed with ${conn.rejection.status}`);
  conn.ws.send(JSON.stringify(buildHello(device, overrides)));
  return { ws: conn.ws, closed: conn.closeInfo };
}

// MARK: - 断言

/**
 * 「没有幽灵路由」的三重断言。
 *
 * 只查一个地方不够：`lookupByDevice` 为空但 `connectionCount()` 是 1
 * 意味着表里有一条属于别人的记录（同样致命，只是被顶替过）。
 *
 * 先等 `inspect()` 收敛：`closeWith()` 只发 close frame，socket 真正关闭
 * 要等对端回 shut 握手，而 `live` 表是在 close **事件**里删的。
 * 不等待就断言，测的是「关闭帧已发出」而不是「连接已收敛」。
 */
async function expectNoRoute(h: LinkHarness, deviceId: string): Promise<void> {
  await waitFor(() => h.link.inspect().length === 0, `connection ${deviceId} converged`);
  expect(await h.link.registry.lookupByDevice(deviceId)).toBeNull();
  expect(h.link.connectionCount()).toBe(0);
  expect(h.link.inspect()).toHaveLength(0);
}

async function deviceStatus(h: LinkHarness, deviceId: string): Promise<string> {
  const rows = await h.ctx.db.db
    .select({ status: mcpDevices.status })
    .from(mcpDevices)
    .where(eq(mcpDevices.id, deviceId));
  return rows[0]?.status as string;
}

async function userToken(h: LinkHarness, userId: string): Promise<string> {
  return await signAccessToken(
    h.ctx.keyRing,
    { userId, sessionId: "00000000-0000-4000-8000-000000000001" },
    { issuer: h.ctx.env.baseUrl, ttlSeconds: 900 },
  );
}

async function httpSuspend(h: LinkHarness, device: Seeded): Promise<Response> {
  const token = await userToken(h, device.userId);
  return await fetch(`http://127.0.0.1:${h.server.port}/mcp-devices/${device.deviceId}/suspend`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

async function httpRevoke(h: LinkHarness, device: Seeded): Promise<Response> {
  const token = await userToken(h, device.userId);
  return await fetch(`http://127.0.0.1:${h.server.port}/mcp-devices/${device.deviceId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * 包一层 registry，**记录 bind 是否发生过**。
 *
 * 为什么需要它：只断言「最终没有路由」无法区分两种实现——
 * （a）取消后根本不 bind；（b）照样 bind，随后再解绑。
 * 两者的终态相同，但 (b) 会让一条已死的连接短暂出现在路由表里
 * （本阶段不转发所以无害，1.2B.2 之后就是一个可能被派发到的死连接）。
 * 任务书 T1 明确要求「不得 bind」，所以这里断言的是**调用次数**，
 * 不是终态。
 */
function countingRegistry(): { registry: ConnectionRegistry; bindCalls: string[]; unbindCalls: string[] } {
  const inner = createMemoryConnectionRegistry();
  const bindCalls: string[] = [];
  const unbindCalls: string[] = [];
  return {
    bindCalls,
    unbindCalls,
    registry: {
      ...inner,
      bind: async (entry, nowMono) => {
        const result = await inner.bind(entry, nowMono);
        bindCalls.push(entry.connectionId);
        return result;
      },
      unbind: async (userId, deviceId, connectionId) => {
        unbindCalls.push(connectionId);
        return await inner.unbind(userId, deviceId, connectionId);
      },
    },
  };
}

beforeEach(() => {
  // 限流桶是模块级共享的；并发用例里每条会打 1–2 次设备接口，
  // 不重置会在整个文件跑到一半时撞上 429。
  resetRateLimiter();
});

// MARK: - T1–T4：连接在握手期间消失

describe("T1–T4 握手期间连接消失", () => {
  let h: LinkHarness | null = null;

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it("T1：hello 验证前客户端断开，随后查询才执行 → 不得 bind", async () => {
    const gate = deferred();
    const entered = deferred();
    const counting = countingRegistry();
    h = await createLinkHarness({
      registry: counting.registry,
      lifecycleHooks: {
        beforeVerify: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);
    const { ws, closed } = await openAndHello(h, device);

    await entered.promise;
    // 此刻 verifyHandshake 的数据库查询还**没有**发出。
    // 客户端断开：close 事件 → converge（此时 bound=false，无事可做）。
    ws.terminate();
    await closed;
    await waitFor(() => h!.link.inspect().length === 0, "connection converged");

    // 放行：verify 现在才真正查库，并返回「设备是 active」。
    gate.resolve();
    // **必须等协程真的跑完**，否则断言会落在它恢复之前。
    await h.link.awaitHandshakes();

    // 它必须仍然拒绝建立路由——device 快照有效不等于连接还活着。
    await waitFor(() => h!.link.inspect().length === 0, "no connection resurrected");
    await expectNoRoute(h, device.deviceId);
    // 结构断言：**根本没有**尝试过 bind。
    expect(counting.bindCalls).toHaveLength(0);
  });

  it("T2：grant 查询前断开，随后查询才执行 → 不得残留 registry", async () => {
    const gate = deferred();
    const entered = deferred();
    const counting = countingRegistry();
    h = await createLinkHarness({
      registry: counting.registry,
      lifecycleHooks: {
        beforeGrants: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);
    const { ws, closed } = await openAndHello(h, device);

    await entered.promise;
    expect(h.link.inspect()[0]?.helloTimeoutArmed).toBe(true);
    ws.terminate();
    await closed;

    gate.resolve();
    await h.link.awaitHandshakes();
    await expectNoRoute(h, device.deviceId);
    expect(counting.bindCalls).toHaveLength(0);
  });

  it("T3：hello 超时先发生，随后握手查询才返回 → 不得进入 active", async () => {
    const gate = deferred();
    const entered = deferred();
    const counting = countingRegistry();
    h = await createLinkHarness({
      registry: counting.registry,
      helloTimeoutMs: 40,
      lifecycleHooks: {
        beforeGrants: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);
    const { closed } = await openAndHello(h, device);

    await entered.promise;
    // 真实超时事件（不是模拟竞态）。
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(REMOTE_CLOSE.HELLO_TIMEOUT);

    gate.resolve();
    await h.link.awaitHandshakes();

    await expectNoRoute(h, device.deviceId);
    // 定时器必须已被清掉：inspect 为空即代表没有残留的活动连接。
    expect(h.link.inspect()).toHaveLength(0);
    expect(counting.bindCalls).toHaveLength(0);
  });

  it("T4：握手途中 Cloud shutdown → 最终连接数为 0", async () => {
    const gate = deferred();
    const entered = deferred();
    const counting = countingRegistry();
    h = await createLinkHarness({
      registry: counting.registry,
      lifecycleHooks: {
        beforeGrants: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);
    const { closed } = await openAndHello(h, device);

    await entered.promise;
    // shutdown 在第一个 await 之前就把 shuttingDown 置为 true。
    const shutdownPromise = h.server.close();
    gate.resolve();
    await closed;
    await shutdownPromise;

    expect(h.link.connectionCount()).toBe(0);
    expect(h.link.inspect()).toHaveLength(0);
    expect(await h.link.registry.lookupByDevice(device.deviceId)).toBeNull();
    // 关键：停机之后**没有**任何 bind 落到了表上。
    expect(counting.bindCalls).toHaveLength(0);
    h = null; // 已关闭，afterEach 不用再关
  });
});

// MARK: - T5–T8：握手与撤停的线性化

describe("T5–T8 设备撤停与握手准入", () => {
  let h: LinkHarness | null = null;

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it("T5：验证通过、bind 之前 suspend → 设备 suspended 且无在线连接", async () => {
    const gate = deferred();
    const entered = deferred();
    h = await createLinkHarness({
      lifecycleHooks: {
        beforeAdmission: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);
    const { closed } = await openAndHello(h, device);

    await entered.promise;
    // 此时还没有任何路由，所以 cleanupConnection 查不到连接（这正是 P2 的入口）。
    expect(await h.link.registry.lookupByDevice(device.deviceId)).toBeNull();
    const resp = await httpSuspend(h, device);
    expect(resp.status).toBe(200);
    expect(await deviceStatus(h, device.deviceId)).toBe("suspended");

    gate.resolve();
    const closeInfo = await closed;
    // 准入在行锁内读到 suspended → 4005。
    expect(closeInfo.code).toBe(REMOTE_CLOSE.DEVICE_SUSPENDED);

    await expectNoRoute(h, device.deviceId);
    expect(await deviceStatus(h, device.deviceId)).toBe("suspended");
  });

  it("T6：验证通过、bind 之前 revoke → 设备 revoked 且无在线连接", async () => {
    const gate = deferred();
    const entered = deferred();
    h = await createLinkHarness({
      lifecycleHooks: {
        beforeAdmission: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);
    const { closed } = await openAndHello(h, device);

    await entered.promise;
    const resp = await httpRevoke(h, device);
    expect(resp.status).toBe(200);
    expect(await deviceStatus(h, device.deviceId)).toBe("revoked");

    gate.resolve();
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(REMOTE_CLOSE.DEVICE_REVOKED);

    await expectNoRoute(h, device.deviceId);

    // 撤销后旧 token 再次握手仍然失败（且不残留路由）。
    const second = await openAndHello(h, device);
    const secondClose = await second.closed;
    expect(secondClose.code).toBe(REMOTE_CLOSE.DEVICE_REVOKED);
    await expectNoRoute(h, device.deviceId);
  });

  /**
   * 等 Postgres 报告「有一个会话正在等锁」。
   *
   * 为什么这是**确定性**判据而不是时间里瞎猜：`pg_stat_activity` 的
   * `wait_event_type = 'Lock'` 是数据库自己给出的状态——只要握手的
   * `SELECT ... FOR UPDATE` 已经持有行锁、且 suspend 的 UPDATE 已经到达，
   * 就必然出现这一行。没有行锁时它**永远不会**出现，所以「等到超时」
   * 就是「互斥不存在」的证明。
   *
   * 这也顺带证明了锁的作用域是对的：如果握手锁错了行（例如锁 users），
   * suspend 的 UPDATE 不会被阻塞，这里同样等不到。
   */
  async function waitForLockWaiter(h: LinkHarness, label: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let observed = 0;
    while (Date.now() < deadline) {
      const rows = await h.ctx.db.sql<{ n: number }[]>`
        select count(*)::int as n
          from pg_stat_activity
         where datname = current_database()
           and wait_event_type = 'Lock'`;
      observed = rows[0]?.n ?? 0;
      if (observed > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no lock waiter appeared: ${label}（说明握手没有持有设备行锁）`);
  }

  it("T7：握手先持锁、随后 suspend → suspend 被锁阻塞；提交后连接被关闭 4005", async () => {
    const gate = deferred();
    const entered = deferred();
    h = await createLinkHarness({
      lifecycleHooks: {
        insideAdmission: async () => {
          // 事务已开始、`SELECT ... FOR UPDATE` 已拿到行锁。
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);
    const { ws, closed } = await openAndHello(h, device);

    await entered.promise;
    // suspend 的 UPDATE 必须排队等这把行锁——它**不可能**先提交。
    const suspendPromise = httpSuspend(h, device);
    // 直接向数据库求证「确实有一个事务在等锁」。
    await waitForLockWaiter(h, "T7");

    gate.resolve();
    const resp = await suspendPromise;
    expect(resp.status).toBe(200);
    // 握手先完成（bind + commit），所以 suspend 的清理能查到这条连接。
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(REMOTE_CLOSE.DEVICE_SUSPENDED);
    expect(closeInfo.reason).toBe("device suspended");

    await expectNoRoute(h, device.deviceId);
    expect(await deviceStatus(h, device.deviceId)).toBe("suspended");
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("T8：握手先持锁、随后 revoke → revoke 被锁阻塞；提交后 close 4003", async () => {
    const gate = deferred();
    const entered = deferred();
    h = await createLinkHarness({
      lifecycleHooks: {
        insideAdmission: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);
    const { closed } = await openAndHello(h, device);

    await entered.promise;
    const revokePromise = httpRevoke(h, device);
    await waitForLockWaiter(h, "T8");

    gate.resolve();
    const resp = await revokePromise;
    expect(resp.status).toBe(200);
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(REMOTE_CLOSE.DEVICE_REVOKED);

    await expectNoRoute(h, device.deviceId);
    expect(await deviceStatus(h, device.deviceId)).toBe("revoked");
  });

  it("T5/T8 的补强：撤停后不存在「DB 已停、路由还在」的第三种状态", async () => {
    // 同一台设备连续做两轮，确保不会因为第一轮的残留影响第二轮判定。
    h = await createLinkHarness();
    const device = await seedDevice(h);

    for (const reason of ["suspend", "revoke"] as const) {
      const conn = await connect(h, { token: device.deviceToken });
      if (!conn.ok) throw new Error("upgrade failed");
      if (reason === "suspend") {
        // 第一轮：在线时暂停
        conn.ws.send(JSON.stringify(buildHello(device)));
        const ok = await conn.next((f) => f.type === "hello_ok");
        expect(ok.type).toBe("hello_ok");
        await httpSuspend(h, device);
        const closed = await conn.closeInfo;
        expect(closed.code).toBe(REMOTE_CLOSE.DEVICE_SUSPENDED);
      } else {
        // 第二轮：已暂停的设备再握手必须被拒（不会因为上一轮而复活）
        conn.ws.send(JSON.stringify(buildHello(device)));
        const closed = await conn.closeInfo;
        expect(closed.code).toBe(REMOTE_CLOSE.DEVICE_SUSPENDED);
      }
      const status = await deviceStatus(h, device.deviceId);
      const route = await h.link.registry.lookupByDevice(device.deviceId);
      // 不变量：只要状态不是 active，路由就必须为空。
      if (status !== "active") expect(route).toBeNull();
      expect(h.link.connectionCount()).toBe(0);
    }
  });
});

// MARK: - T9：迟到 bind

describe("T9 bind 延迟期间关闭", () => {
  let h: LinkHarness | null = null;

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  /** 把 registry.bind 改成「等闸门」再委托给内存实现，并记录 bind/unbind 调用。 */
  function gatedRegistry(): {
    registry: ConnectionRegistry;
    entered: Deferred;
    gate: Deferred;
    bindCalls: string[];
    unbindCalls: string[];
  } {
    const inner = createMemoryConnectionRegistry();
    const entered = deferred();
    const gate = deferred();
    const bindCalls: string[] = [];
    const unbindCalls: string[] = [];
    const registry: ConnectionRegistry = {
      ...inner,
      bind: async (entry, nowMono) => {
        entered.resolve();
        await gate.promise;
        const result = await inner.bind(entry, nowMono);
        bindCalls.push(entry.connectionId);
        return result;
      },
      unbind: async (userId, deviceId, connectionId) => {
        unbindCalls.push(connectionId);
        return await inner.unbind(userId, deviceId, connectionId);
      },
    };
    return { registry, entered, gate, bindCalls, unbindCalls };
  }

  it("T9b：bind 卡住时 Cloud shutdown → 停机必须等它落定，最终计数为 0", async () => {
    const gated = gatedRegistry();
    h = await createLinkHarness({ registry: gated.registry });
    const device = await seedDevice(h);
    const { closed } = await openAndHello(h, device);

    await gated.entered.promise;
    // 此刻握手已经通过准入检查、正卡在 bind 里。
    //
    // 停机必须**等它落定**再 `registry.clear()`。不等的话，clear 之后
    // bind 才把表项写回来，`connection_count` 会永远停在 1。
    const shutdownPromise = h.server.close();

    // 给 shutdown 一点时间推进到「等握手」那一步（它自己有 1s 上限，
    // 这里只等 30ms 是为了让下面的断言落在「还在等」而不是「已经放行」）。
    await new Promise((resolve) => setTimeout(resolve, 30));
    gated.gate.resolve();

    await closed;
    await shutdownPromise;

    expect(gated.bindCalls).toHaveLength(1);
    // 关键：bind 写过表，但停机收尾把它清掉了。
    expect(h.link.connectionCount()).toBe(0);
    expect(await h.link.registry.lookupByDevice(device.deviceId)).toBeNull();
    h = null;
  });

  it("T9：bind 卡住时客户端关闭 → bind 完成后仍必须解绑（幽灵路由回归锁）", async () => {
    const gated = gatedRegistry();
    h = await createLinkHarness({ registry: gated.registry });
    const device = await seedDevice(h);
    const { ws, closed } = await openAndHello(h, device);

    // 握手已经走到 bind，且卡在那里。
    await gated.entered.promise;
    expect(gated.bindCalls).toHaveLength(0);
    expect(await h.link.registry.lookupByDevice(device.deviceId)).toBeNull();

    ws.terminate();
    await closed;

    // **必须等 converge 真正跑完**，而不是「close 事件已到达」。
    //
    // `closeInfo` 与 link-server 的 `ws.on("close")` 是两个独立监听器，
    // 它们谁先 resolve 不影响 `converge()` 是否已经执行过——而这条用例的
    // 全部意义就在于「converge 已跑、bind 还没完成」这个瞬间。
    // `inspect()` 读的是 live 表，只有 `converge()` 会把人从里面删掉，
    // 所以「inspect 为空」是 converge 已执行的**结构证据**。
    await waitFor(() => h!.link.inspect().length === 0, "converge ran before bind");
    // 此刻 bound 还是 false，所以 converge 无法解绑——这正是 P1 的窗口。
    expect(gated.unbindCalls).toHaveLength(0);
    expect(gated.bindCalls).toHaveLength(0);

    // 放行 bind：路由会被建立，但连接已经死了。
    gated.gate.resolve();

    // 正确实现会在 bind 返回后**自己**解绑。等的是 unbind 这次调用，
    // 不是「count 变成 0」——后者在 bind 之前就已经是 0，等待会立刻返回，
    // 断言随即跑在 bind 与 unbind 之间（这条用例第一版就是这么假绿的）。
    await waitFor(() => gated.unbindCalls.length === 1, "late bind released");

    expect(gated.bindCalls).toHaveLength(1);
    // 解绑的必须是**同一条**连接：既不能漏，也不能删别人的。
    expect(gated.unbindCalls[0]).toBe(gated.bindCalls[0]);

    expect(await h.link.registry.lookupByDevice(device.deviceId)).toBeNull();
    expect(h.link.connectionCount()).toBe(0);
    expect(h.link.inspect()).toHaveLength(0);
  });
});

// MARK: - T10：顶替与迟到 close

describe("T10 顶替与迟到 close", () => {
  let h: LinkHarness | null = null;

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it("T10：新连接顶替后，旧连接的迟到 close 不能删掉新路由", async () => {
    h = await createLinkHarness();
    const device = await seedDevice(h);

    const first = await connect(h, { token: device.deviceToken });
    if (!first.ok) throw new Error("upgrade failed");
    first.ws.send(JSON.stringify(buildHello(device)));
    const firstHelloOk = await first.next((f) => f.type === "hello_ok");

    // 同一台设备再连一次（新 nonce）→ 顶替
    const second = await connect(h, { token: device.deviceToken });
    if (!second.ok) throw new Error("upgrade failed");
    second.ws.send(JSON.stringify(buildHello(device)));
    const secondHelloOk = await second.next((f) => f.type === "hello_ok");

    const firstClose = await first.closeInfo;
    expect(firstClose.code).toBe(REMOTE_CLOSE.SUPERSEDED);

    // 旧连接的 close 回调已经跑过；新路由必须还在。
    const info = await h.link.registry.lookupByDevice(device.deviceId);
    expect(info?.connectionId).toBe(secondHelloOk.connection_id);
    expect(info?.connectionId).not.toBe(firstHelloOk.connection_id);
    expect(h.link.connectionCount()).toBe(1);

    // 现在让**新的**那条也关掉，路由才该消失。
    second.ws.close(1000);
    await second.closeInfo;
    await waitFor(() => h!.link.connectionCount() === 0, "second released");
    expect(await h.link.registry.lookupByDevice(device.deviceId)).toBeNull();
  });

  it("T10b：旧连接卡在握手且已被关闭 → 释放后不得顶替已上线的新连接", async () => {
    const gate = deferred();
    const entered = deferred();
    // 只挂住**第一条**连接：用一个「已经用过」的本地标记，而不是判断
    // connectionId（它由服务端生成，测试不该依赖其形态）。
    let stalledOnce = false;
    h = await createLinkHarness({
      lifecycleHooks: {
        beforeGrants: async () => {
          if (stalledOnce) return;
          stalledOnce = true;
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);

    const stalled = await openAndHello(h, device);
    await entered.promise;

    // 这条连接在**尚未 bind** 时就被客户端放弃。它不会被「顶替」——
    // 注册表里根本没有它的表项，所以没有 displaced 可谈。
    stalled.ws.terminate();
    await stalled.closed;

    // 第二条连接（同设备）完整握手 → 成为唯一路由
    const live = await connect(h, { token: device.deviceToken });
    if (!live.ok) throw new Error("upgrade failed");
    live.ws.send(JSON.stringify(buildHello(device)));
    const helloOk = await live.next((f) => f.type === "hello_ok");

    // 放行被挂住的第一条：它恢复后必须看到自己已被取消，
    // 既不能 bind，也不能把新连接顶掉。
    gate.resolve();
    await h.link.awaitHandshakes();

    const info = await h.link.registry.lookupByDevice(device.deviceId);
    expect(info?.connectionId).toBe(helloOk.connection_id);
    expect(h.link.connectionCount()).toBe(1);
  });
});

// MARK: - 准入本身的负例

describe("准入终审（行锁内重验）", () => {
  let h: LinkHarness | null = null;

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it("token_expires_at 在握手期间过期 → 拒绝", async () => {
    const gate = deferred();
    const entered = deferred();
    h = await createLinkHarness({
      lifecycleHooks: {
        beforeAdmission: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);
    const { closed } = await openAndHello(h, device);

    await entered.promise;
    // 在准入事务之前把 token 置为过期（模拟长时间的 DB 排队）。
    await h.ctx.db.db
      .update(mcpDevices)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpDevices.id, device.deviceId));

    gate.resolve();
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(REMOTE_CLOSE.UNAUTHORIZED);
    await expectNoRoute(h, device.deviceId);
  });

  it("token_hash 在握手期间被轮换 → 拒绝", async () => {
    const gate = deferred();
    const entered = deferred();
    h = await createLinkHarness({
      lifecycleHooks: {
        beforeAdmission: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    });
    const device = await seedDevice(h);
    const { closed } = await openAndHello(h, device);

    await entered.promise;
    await h.ctx.db.db
      .update(mcpDevices)
      .set({ tokenHash: sha256Hex(`bp_dev_${randomBytes(24).toString("base64url")}`) })
      .where(eq(mcpDevices.id, device.deviceId));

    gate.resolve();
    const closeInfo = await closed;
    expect(closeInfo.code).toBe(REMOTE_CLOSE.UNAUTHORIZED);
    await expectNoRoute(h, device.deviceId);
  });

  it("正常路径仍然成功（准入没有把好路径一起拦掉）", async () => {
    h = await createLinkHarness();
    const device = await seedDevice(h);
    const conn = await connect(h, { token: device.deviceToken });
    if (!conn.ok) throw new Error("upgrade failed");
    conn.ws.send(JSON.stringify(buildHello(device)));
    const helloOk = await conn.next((f) => f.type === "hello_ok");
    expect(helloOk.type).toBe("hello_ok");
    expect(h.link.connectionCount()).toBe(1);
    const snap = h.link.inspect()[0];
    expect(snap?.state).toBe("active");
    expect(snap?.bound).toBe(true);
    expect(snap?.heartbeatRunning).toBe(true);
    expect(snap?.helloTimeoutArmed).toBe(false);
  });
});
