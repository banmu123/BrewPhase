import type { DbHandle } from "../../src/db/client.js";
import type { McpOAuthDeps } from "../../src/mcp-oauth/sessions.js";
import { seedClient, seedGrant, seedUser } from "./oauth-db.js";

/**
 * MCP OAuth 服务层测试夹具（Phase 1.3.1-B）。
 *
 * 与 `oauth-db.ts` 的分工：那边只用裸 SQL 验证**表结构**，这里提供
 * 「真实 PostgreSQL + 可注入时钟 + 一条可用 Grant」的最小环境，供服务层用。
 */

/** 独立的测试 pepper。真实部署里与 Desktop 共用同一个值，哈希域不同。 */
export const MCP_TEST_PEPPER = "mcp-test-pepper-0123456789abcdef";

export interface TestClock {
  now: () => Date;
  current: () => Date;
  advance: (ms: number) => void;
  set: (value: Date) => void;
}

/**
 * 可推进的时钟。
 *
 * 90 天绝对期限必须能「跨 4 个 30 天窗口」，真实等待不可能，sleep 也不确定。
 * 服务把 `now` 作为依赖注入正是为了这个——它不是测试便利，而是设计 §9.9
 * 明确要求的「时钟来源全部由注入的 now 给出」。
 */
export function makeClock(start: Date): TestClock {
  let value = new Date(start.getTime());
  return {
    now: () => new Date(value.getTime()),
    current: () => new Date(value.getTime()),
    advance: (ms: number) => {
      value = new Date(value.getTime() + ms);
    },
    set: (next: Date) => {
      value = new Date(next.getTime());
    },
  };
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface McpOAuthFixture {
  userId: string;
  clientId: string;
  grantId: string;
  clock: TestClock;
  deps: McpOAuthDeps;
  db: DbHandle["db"];
  sql: DbHandle["sql"];
}

/**
 * 造一条「用户 + client + 未撤销 grant」，并返回带时钟的服务依赖。
 *
 * Grant 用两个 scope（`records:read` / `coffee:read`），这样「交集成什么」
 * 才有东西可断言。
 */
export async function seedMcpOAuthFixture(
  handle: DbHandle,
  options: {
    start?: Date;
    scopes?: string[];
    userId?: string;
    /** 单独为「另一个 grant」造场景时传它，避免撞 (user, client, resource) 唯一索引。 */
    clientId?: string;
  } = {},
): Promise<McpOAuthFixture> {
  const clock = makeClock(options.start ?? new Date("2026-01-01T00:00:00.000Z"));
  const userId = options.userId ?? (await seedUser(handle.sql, "mcp-oauth-user"));
  const clientId = options.clientId ?? `client-${Math.random().toString(36).slice(2, 10)}`;
  await seedClient(handle.sql, { clientId });
  const grantId = await seedGrant(handle.sql, userId, {
    clientId,
    scopes: options.scopes ?? ["records:read", "coffee:read"],
  });

  return {
    userId,
    clientId,
    grantId,
    clock,
    db: handle.db,
    sql: handle.sql,
    deps: { db: handle.db, pepper: MCP_TEST_PEPPER, now: clock.now },
  };
}
