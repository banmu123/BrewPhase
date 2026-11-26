import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";

/**
 * 单实例运维约束（协议 §12.2，任务书 §12）。
 *
 * 这些断言的对象是**启动行为**：不是「会不会警告」，而是「能不能起来」。
 * 多副本下的 Remote 故障形态是随机的 `DEVICE_OFFLINE`（设备明明在线），
 * 那种错误在日志里没有任何异常，只能靠「起不来」来防。
 */

const BASE: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/db",
  BASE_URL: "http://127.0.0.1:3000",
};

describe("GATEWAY_EXPECTED_REPLICAS", () => {
  it("缺省为 1", () => {
    const env = loadEnv({ ...BASE });
    expect(env.gateway.expectedReplicas).toBe(1);
  });

  it("显式 1 可以启动", () => {
    const env = loadEnv({ ...BASE, GATEWAY_EXPECTED_REPLICAS: "1" });
    expect(env.gateway.expectedReplicas).toBe(1);
  });

  it("大于 1 → 拒绝启动，并说明需要 Phase 1.4 的共享路由表", () => {
    for (const value of ["2", "3", "10"]) {
      expect(() => loadEnv({ ...BASE, GATEWAY_EXPECTED_REPLICAS: value })).toThrow(
        /GATEWAY_EXPECTED_REPLICAS must be 1/,
      );
      expect(() => loadEnv({ ...BASE, GATEWAY_EXPECTED_REPLICAS: value })).toThrow(/Redis/);
    }
  });

  it("非整数 / 非正数 → 环境校验失败", () => {
    for (const value of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => loadEnv({ ...BASE, GATEWAY_EXPECTED_REPLICAS: value }), `值 ${value}`).toThrow(
        /GATEWAY_EXPECTED_REPLICAS/,
      );
    }
  });

  it("不因为「配置了但看起来像 1」而静默降级：只有精确的 1 通过", () => {
    expect(() => loadEnv({ ...BASE, GATEWAY_EXPECTED_REPLICAS: "01" })).not.toThrow();
    expect(() => loadEnv({ ...BASE, GATEWAY_EXPECTED_REPLICAS: " 1 " })).not.toThrow();
    expect(() => loadEnv({ ...BASE, GATEWAY_EXPECTED_REPLICAS: "1 " })).not.toThrow();
  });
});

describe("WSS Host 白名单", () => {
  it("缺省从 BASE_URL 推导（含端口，比较时会剥掉）", () => {
    const env = loadEnv({ ...BASE, BASE_URL: "https://cloud.brewphase.app" });
    expect(env.gateway.allowedHosts).toEqual(["cloud.brewphase.app"]);
  });

  it("显式配置优先，可按逗号给多个", () => {
    const env = loadEnv({
      ...BASE,
      GATEWAY_ALLOWED_HOSTS: "cloud.brewphase.app, gw.internal:8443 ,",
    });
    expect(env.gateway.allowedHosts).toEqual(["cloud.brewphase.app", "gw.internal:8443"]);
  });

  it("显式配置为空 → 回退到 BASE_URL 推导（不是「不校验」）", () => {
    const env = loadEnv({ ...BASE, GATEWAY_ALLOWED_HOSTS: "   ", BASE_URL: "https://a.example" });
    expect(env.gateway.allowedHosts).toEqual(["a.example"]);
  });
});
