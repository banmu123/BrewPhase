import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../helpers/harness.js";
import {
  accessTokenFor,
  claimViaApi,
  confirmViaApi,
  createTestUser,
  postJson,
  registerViaApi,
  SENTINEL_CLAIM,
  SENTINEL_DEVICE_TOKEN,
} from "../helpers/mcp-devices.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";

/**
 * 凭据与日志安全（安全运维 §6.2）。
 *
 * ## 为什么哨兵要放在**非秘密**字段里
 *
 * 如果把它塞进 `claim_secret`，那它被脱敏是理所当然的（字段名叫 secret），
 * 测不出任何东西。放在 `name` / `platform` / `app_version` 这些「看起来无害、
 * 因此最容易被直接写进日志」的字段里，才能真的验证「请求体一律不入日志」。
 *
 * ## 这一组用例的实际价值
 *
 * 它抓的是最容易发生的那类事故：有人在排查问题时把 `c.req.json()` 加进
 * 日志上下文。那种改动会让所有功能测试继续通过，只有哨兵会红。
 */

let h: Harness;
let userId: string;
let token: string;
let captured: string[];

/** 收集所有 console 输出（createLogger 最终走 console）。 */
function captureConsole(): void {
  captured = [];
  const push = (...args: unknown[]): void => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "info").mockImplementation(push);
  vi.spyOn(console, "warn").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
}

beforeEach(async () => {
  resetRateLimiter();
  captureConsole();
  // logLevel=debug 才能把 info 级别的 request 日志也收进来——否则
  // 「日志里没有哨兵」这条断言会因为根本没输出日志而平凡成立。
  h = await createHarness({ logLevel: "debug" });
  userId = await createTestUser(h);
  token = await accessTokenFor(h, userId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function allLogs(): string {
  return captured.join("\n");
}

describe("请求体与凭证不入日志", () => {
  it("注册请求里的哨兵不出现在日志中", async () => {
    await postJson(h, "/mcp-devices/register", token, {
      name: SENTINEL_CLAIM,
      platform: SENTINEL_DEVICE_TOKEN,
      public_key: Buffer.alloc(32, 3).toString("base64url"),
      app_version: SENTINEL_CLAIM,
    });
    const logs = allLogs();
    expect(logs).not.toContain(SENTINEL_CLAIM);
    expect(logs).not.toContain(SENTINEL_DEVICE_TOKEN);
    // 但请求本身确实被记录了（否则这条断言没意义）
    expect(logs).toContain("http_request");
    expect(logs).toContain("/mcp-devices/register");
  });

  it("Authorization 头不出现在日志中", async () => {
    await registerViaApi(h, token);
    expect(allLogs()).not.toContain(token);
    expect(allLogs()).not.toContain("Bearer");
  });

  it("claim_secret 与 device_token 明文都不出现在日志中", async () => {
    const device = await registerViaApi(h, token);
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const claimed = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    const body = (await claimed.json()) as { device_token: string };

    const logs = allLogs();
    expect(logs).not.toContain(device.claimSecret);
    expect(logs).not.toContain(device.confirmCode);
    expect(logs).not.toContain(body.device_token);
  });

  it("失败的 claim 也不把 claim_secret 写进日志或响应", async () => {
    const device = await registerViaApi(h, token);
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const resp = await claimViaApi(h, token, device.deviceId, `${SENTINEL_CLAIM}-wrong-secret`);
    const text = await resp.clone().text();

    expect(resp.status).toBe(403);
    expect(text).not.toContain(SENTINEL_CLAIM);
    expect(allLogs()).not.toContain(SENTINEL_CLAIM);
    // 固定文案，不回显任何片段
    expect((JSON.parse(text) as { error_description: string }).error_description).toBe(
      "claim rejected",
    );
  });
});

describe("错误响应不回显任何 secret", () => {
  it("注册失败的响应里没有请求体内容", async () => {
    const resp = await postJson(h, "/mcp-devices/register", token, {
      name: SENTINEL_CLAIM,
      platform: SENTINEL_DEVICE_TOKEN,
      public_key: "short",
      app_version: "0.1.5",
    });
    expect(resp.status).toBe(400);
    const text = await resp.text();
    expect(text).not.toContain(SENTINEL_CLAIM);
    expect(text).not.toContain(SENTINEL_DEVICE_TOKEN);
  });

  it("claim 错误的响应不含 claim_secret 片段", async () => {
    const device = await registerViaApi(h, token);
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const resp = await claimViaApi(
      h,
      token,
      device.deviceId,
      `${device.claimSecret.slice(0, 8)}-tampered-tampered`,
    );
    const text = await resp.text();
    expect(text).not.toContain(device.claimSecret.slice(0, 8));
  });

  it("重复领取的响应里没有第一次发出的 token", async () => {
    const device = await registerViaApi(h, token);
    await confirmViaApi(h, token, device.deviceId, device.confirmCode);
    const first = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    const firstToken = ((await first.json()) as { device_token: string }).device_token;

    const second = await claimViaApi(h, token, device.deviceId, device.claimSecret);
    const text = await second.text();
    expect(text).not.toContain(firstToken);
    expect(text).not.toContain("bp_dev_");
  });
});
