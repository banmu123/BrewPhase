import { describe, expect, it } from "vitest";
import { createMemoryConnectionRegistry } from "../../src/link/connection-registry.js";

/**
 * 路由表的九条边界（任务书 §8 的测试清单）。
 *
 * 这一组几乎全是**顺序**问题：`bind` 新连接与 `unbind` 旧连接的先后、
 * 迟到 close 回调、并发 bind。每条都对应一个会让「在线设备收不到请求」
 * 的真实故障。
 */

function entry(overrides: Partial<Parameters<ReturnType<typeof createMemoryConnectionRegistry>["bind"]>[0]> = {}) {
  return {
    userId: "u1",
    deviceId: "d1",
    connectionId: "c1",
    instanceId: "gw_test",
    serviceable: true,
    ...overrides,
  };
}

describe("ConnectionRegistry", () => {
  it("bind 后能查到，unbind 后查不到", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry(), 1000);
    expect(await registry.lookup("u1", "d1")).toMatchObject({
      userId: "u1",
      deviceId: "d1",
      connectionId: "c1",
    });
    expect(registry.count()).toBe(1);

    expect(await registry.unbind("u1", "d1", "c1")).toBe(true);
    expect(await registry.lookup("u1", "d1")).toBeNull();
    expect(registry.count()).toBe(0);
  });

  it("重复 unbind 是幂等的（第二次返回 false，不抛错）", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry(), 1000);
    expect(await registry.unbind("u1", "d1", "c1")).toBe(true);
    expect(await registry.unbind("u1", "d1", "c1")).toBe(false);
  });

  it("bind 新连接会返回被顶替的旧连接", async () => {
    const registry = createMemoryConnectionRegistry();
    const first = await registry.bind(entry({ connectionId: "c1" }), 1000);
    expect(first.displaced).toBeNull();

    const second = await registry.bind(entry({ connectionId: "c2" }), 2000);
    expect(second.displaced).toMatchObject({ connectionId: "c1" });
    expect(await registry.lookup("u1", "d1")).toMatchObject({ connectionId: "c2" });
  });

  it("同用户第二台设备上线：旧设备的 lookup 返回 null（不能借到新连接）", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry({ deviceId: "d1", connectionId: "c1" }), 1000);
    const second = await registry.bind(entry({ deviceId: "d2", connectionId: "c2" }), 2000);

    expect(second.displaced).toMatchObject({ deviceId: "d1" });
    expect(await registry.lookup("u1", "d1")).toBeNull();
    expect(await registry.lookup("u1", "d2")).toMatchObject({ connectionId: "c2" });
    // 单用户单连接：count 恒为 1
    expect(registry.count()).toBe(1);
  });

  it("旧连接的迟到 close 不会删掉新连接（connectionId 比对）", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry({ connectionId: "c1" }), 1000);
    await registry.bind(entry({ connectionId: "c2" }), 2000);

    // 旧连接的 close 回调现在才到
    expect(await registry.unbind("u1", "d1", "c1")).toBe(false);
    expect(await registry.lookup("u1", "d1")).toMatchObject({ connectionId: "c2" });
  });

  it("deviceId 不匹配的 unbind 也不会删（换设备后旧回调同样危险）", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry({ deviceId: "d2", connectionId: "c2" }), 2000);
    expect(await registry.unbind("u1", "d1", "c2")).toBe(false);
    expect(await registry.lookup("u1", "d2")).not.toBeNull();
  });

  it("两个并发 bind 最终只保留一个（同步写入，没有交错窗口）", async () => {
    const registry = createMemoryConnectionRegistry();
    const [a, b] = await Promise.all([
      registry.bind(entry({ connectionId: "c1" }), 1000),
      registry.bind(entry({ connectionId: "c2" }), 1001),
    ]);
    // 恰好一个看到「顶替」，另一个是第一个写入者。
    const displacedCount = [a, b].filter((r) => r.displaced !== null).length;
    expect(displacedCount).toBe(1);
    expect(registry.count()).toBe(1);
    const current = await registry.lookup("u1", "d1");
    expect(["c1", "c2"]).toContain(current?.connectionId);
  });

  it("touch 只接受当前连接的续约（旧心跳定时器不能续新连接的命）", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry({ connectionId: "c1" }), 1000);
    expect(await registry.touch("u1", "d1", "c1", 5000)).toBe(true);
    expect((await registry.lookup("u1", "d1"))?.lastPongAtMono).toBe(5000);

    await registry.bind(entry({ connectionId: "c2" }), 6000);
    expect(await registry.touch("u1", "d1", "c1", 7000)).toBe(false);
    expect((await registry.lookup("u1", "d1"))?.lastPongAtMono).toBeNull();
  });

  it("setServiceable 只改提示位，不影响路由", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry(), 1000);
    expect(await registry.setServiceable("u1", "d1", "c1", false)).toBe(true);
    const info = await registry.lookup("u1", "d1");
    expect(info?.serviceable).toBe(false);
    // 不可服务 ≠ 不可路由：1.2B.1 不做派发，但路由表本身不该因此丢连接。
    expect(info).not.toBeNull();
  });

  it("listByUser 返回该用户唯一的一条", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry({ userId: "u1", deviceId: "d1", connectionId: "c1" }), 1000);
    await registry.bind(entry({ userId: "u2", deviceId: "d2", connectionId: "c2" }), 1000);

    expect(await registry.listByUser("u1")).toHaveLength(1);
    expect((await registry.listByUser("u1"))[0]?.deviceId).toBe("d1");
    expect(await registry.listByUser("nobody")).toEqual([]);
  });

  it("clear 之后 count 归零（Cloud 重启/停机后的语义）", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry({ userId: "u1", deviceId: "d1", connectionId: "c1" }), 1000);
    await registry.bind(entry({ userId: "u2", deviceId: "d2", connectionId: "c2" }), 1000);
    expect(registry.count()).toBe(2);
    registry.clear();
    expect(registry.count()).toBe(0);
    expect(await registry.lookupByUser("u1")).toBeNull();
  });
});

/**
 * `rotating` 的连接级语义（Phase 1.2B.2.1）。
 *
 * 这一组的核心是**两个不同的问题不能共用一个答案**：
 *
 * | 问题 | 方法 | rotating 时 |
 * |---|---|---|
 * | 「能不能往这台设备派发？」 | `lookup` | `null`（不可路由） |
 * | 「它还有连接对象吗？」 | `lookupByDevice` | 有（要能关掉它） |
 *
 * 合并成一个方法就会二选一地错：要么把请求发给一条凭据已失效的连接，
 * 要么在轮换时找不到 socket、只能等心跳超时。
 */
describe("ConnectionRegistry · rotating", () => {
  it("markRotating 后 lookup 返回 null，但 lookupByDevice 仍能找到", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry(), 1000);
    expect(await registry.lookup("u1", "d1")).not.toBeNull();

    expect(await registry.markRotating("d1", "c1")).toBe(true);

    expect(await registry.lookup("u1", "d1")).toBeNull();
    const info = await registry.lookupByDevice("d1");
    expect(info).not.toBeNull();
    expect(info?.rotating).toBe(true);
    // 表项仍在：connectionCount 反映的是「有连接对象」，不是「可路由」。
    expect(registry.count()).toBe(1);
  });

  it("markRotating 必须 connectionId 匹配（否则会误标刚重连的新连接）", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry({ connectionId: "c1" }), 1000);
    expect(await registry.markRotating("d1", "c2")).toBe(false);
    // 没被误标。
    expect((await registry.lookup("u1", "d1"))?.rotating).toBe(false);
    expect(await registry.lookup("u1", "d1")).not.toBeNull();
  });

  it("markRotating 对不存在的连接返回 false（离线轮换不伪造状态）", async () => {
    const registry = createMemoryConnectionRegistry();
    expect(await registry.markRotating("d1", "c1")).toBe(false);
    expect(registry.count()).toBe(0);
  });

  it("rotating 的旧连接不算「被顶替」：新连接 bind 时不得再发 4006", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry({ connectionId: "c1" }), 1000);
    await registry.markRotating("d1", "c1");

    const result = await registry.bind(entry({ connectionId: "c2" }), 2000);
    // 旧连接正在按 4010 退场，客户端按 4010 编排；再来一个 4006 只会让它
    // 收到两个矛盾的关闭原因。
    expect(result.displaced).toBeNull();
    expect((await registry.lookup("u1", "d1"))?.connectionId).toBe("c2");
  });

  it("rotating 之后旧 connectionId 的 unbind 不影响新连接", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry({ connectionId: "c1" }), 1000);
    await registry.markRotating("d1", "c1");
    await registry.bind(entry({ connectionId: "c2" }), 2000);

    expect(await registry.unbind("u1", "d1", "c1")).toBe(false);
    expect((await registry.lookup("u1", "d1"))?.connectionId).toBe("c2");
  });

  it("重新 bind 同一设备会清掉 rotating 标记（新连接是健康的）", async () => {
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry({ connectionId: "c1" }), 1000);
    await registry.markRotating("d1", "c1");
    await registry.bind(entry({ connectionId: "c2" }), 2000);

    const info = await registry.lookup("u1", "d1");
    expect(info?.rotating).toBe(false);
    expect(info?.connectionId).toBe("c2");
  });

  it("rotating 只影响 lookup：心跳与 serviceable 续约仍然照常", async () => {
    // rotating 不是「把连接对象作废」，只是「不可路由」。如果连 touch 都被
    // 挡住，这条正在退场的连接会在日志里刷出一串假的心跳超时，
    // 把真正的故障淹掉。
    const registry = createMemoryConnectionRegistry();
    await registry.bind(entry(), 1000);
    await registry.markRotating("d1", "c1");

    expect(await registry.touch("u1", "d1", "c1", 5000)).toBe(true);
    expect(await registry.setServiceable("u1", "d1", "c1", false)).toBe(true);
    expect((await registry.lookupByDevice("d1"))?.lastPongAtMono).toBe(5000);
  });
});
