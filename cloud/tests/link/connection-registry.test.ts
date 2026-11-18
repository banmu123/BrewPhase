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
