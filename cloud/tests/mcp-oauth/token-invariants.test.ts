import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Token Endpoint 的**静态不变量**（Phase 1.3.1-C3a）。
 *
 * ## 为什么这三条必须用源码扫描
 *
 * | 不变量 | 为什么行为测试测不到 |
 * |---|---|
 * | 授权码消费是条件 UPDATE | 行锁 + 前置检查已经把它变成**不可达的纵深防御**：`FOR UPDATE` 之后没有第二个事务能改这一行，所以去掉 `consumed_at IS NULL` / `expires_at > now` 之后所有用例仍然全绿 |
 * | 授权码读取带 `FOR UPDATE` | 去掉之后并发兑换仍然只有一个成功——因为后面的条件 UPDATE 自己也拿行锁。差异只在「阻塞发生在哪条语句」，不可观测 |
 * | Session 创建与授权码消费同事务 | 只有把「消费」单独提交、再让 Session 失败，才会露出半成功；正常路径下两种写法等价 |
 *
 * 这三条不是「更弱的测试」，而是对**实现结构**的断言：它们防的正是「某天
 * 有人觉得这两条条件是冗余的，顺手删掉」。冗余是刻意的——它是锁之外的第二
 * 道判据，也是将来改隔离级别时唯一还站着的那道。
 */

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("授权码消费的判据", () => {
  it("读取带 FOR UPDATE（并发兑换的串行化点）", () => {
    const src = read("src/mcp-oauth/token-flow.ts");
    expect(src).toContain("mcpAuthCodes.codeHash, codeHash");
    expect(src).toContain('.for("update")');
  });

  it("消费是条件 UPDATE：consumed_at IS NULL + 未过期", () => {
    const src = read("src/mcp-oauth/token-flow.ts");
    const start = src.indexOf("const consumed = await tx");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 700);
    expect(block).toContain("isNull(mcpAuthCodes.consumedAt)");
    expect(block).toContain("gt(mcpAuthCodes.expiresAt, input.now)");
    expect(block).toContain("returning(");
  });

  it("命中行数必须恰好为 1", () => {
    const src = read("src/mcp-oauth/token-flow.ts");
    expect(src).toContain("if (consumed.length !== 1) throw invalidGrant(CODE_INVALID_MESSAGE);");
  });
});

describe("Session 创建的事务边界", () => {
  it("调用事务内版本，而不是自带事务的包装", () => {
    const src = read("src/mcp-oauth/token-flow.ts");
    expect(src).toContain("createMcpSessionInTransaction(tx,");
    // 去掉这一条就等于「Session 在另一个事务里提交」——半成功的入口。
    expect(src).not.toMatch(/await createMcpSession\(/);
  });

  it("整个兑换包在一个 transaction 里", () => {
    const src = read("src/mcp-oauth/token-flow.ts");
    expect(src).toContain("const issued = await deps.db.transaction(async (tx) => {");
  });
});

describe("凭据的存储形态", () => {
  it("第一代 Refresh Token 只写哈希", () => {
    const src = read("src/mcp-oauth/sessions.ts");
    expect(src).toContain("tokenHash: mcpRefreshTokenHash(deps.pepper, rawToken)");
    // 不允许把明文写进 tokenHash。
    expect(src).not.toContain("tokenHash: rawToken");
  });

  it("Refresh 轮换的哈希域不变（mcp-refresh）", () => {
    const src = read("src/mcp-oauth/sessions.ts");
    expect(src).toContain('const MCP_REFRESH_HASH_DOMAIN = "mcp-refresh"');
  });
});
