import { describe, expect, it } from "vitest";
import {
  checkRemoteMcpEnv,
  runRemoteMcpPreflight,
  type PreflightProblem,
} from "../../src/scripts/preflight-remote-mcp.js";

/**
 * Remote MCP 部署预检（Phase 1.3.3-A-R5）。
 *
 * 这一层的失败会让部署在**起服务之前**停住，所以断言的是「失败原因是否可读、
 * 是否覆盖了任务书列的每一项」，而不是「函数返回非空」——后者用一个永远失败
 * 的实现也能过。
 *
 * 安全纪律同样在这里钉住：**任何输出都不得包含 Secret 的值**。
 * 每个用例都用一个哨兵值，然后断言它从未出现在结果里。
 */

/** 一个合法的生产配置基线；各用例只覆盖自己关心的那一项。 */
function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    BASE_URL: "https://api.phase.commitbrew.com",
    DATABASE_URL: "postgres://brewphase:REAL_TEST_PG_PASSWORD_0123456789@db:5432/brewphase_cloud",
    POSTGRES_PASSWORD: "REAL_TEST_PG_PASSWORD_0123456789",
    JWT_SIGNING_KEY: "SENTINEL_JWT_KEY_0123456789abcdefghij",
    SESSION_TOKEN_PEPPER: "SENTINEL_PEPPER_0123456789",
    GOOGLE_CLIENT_ID: "SENTINEL_GOOGLE_ID.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "SENTINEL_GOOGLE_SECRET",
    GITHUB_CLIENT_ID: "SENTINEL_GITHUB_ID",
    GITHUB_CLIENT_SECRET: "SENTINEL_GITHUB_SECRET",
    MCP_BROWSER_SESSION_KEY: "SENTINEL_MCP_BROWSER_KEY_0123456789",
    GATEWAY_EXPECTED_REPLICAS: "1",
    ...overrides,
  };
}

function codes(problems: PreflightProblem[]): string[] {
  return problems.map((p) => p.code);
}

/** 断言任何 Secret 哨兵都没被打印出来。 */
function expectNoSecretLeak(problems: PreflightProblem[]): void {
  const blob = JSON.stringify(problems);
  for (const sentinel of [
    "SENTINEL_JWT_KEY",
    "SENTINEL_PEPPER",
    "SENTINEL_GOOGLE",
    "SENTINEL_GITHUB",
    "SENTINEL_MCP_BROWSER",
    "REAL_TEST_PG_PASSWORD",
  ]) {
    expect(blob, `预检输出泄漏了 ${sentinel}`).not.toContain(sentinel);
  }
}

describe("checkRemoteMcpEnv：基础项", () => {
  it("合法配置 → 无问题", () => {
    expect(checkRemoteMcpEnv(validEnv())).toEqual([]);
  });

  it("NODE_ENV 非 production → 拒绝（否则 loadEnv 不会执行生产校验）", () => {
    const problems = checkRemoteMcpEnv(validEnv({ NODE_ENV: "development" }));
    expect(codes(problems)).toContain("node_env_not_production");
  });

  it("BASE_URL 缺失 / 非法 / 非 https / 带 path / 回环，各自给出独立原因", () => {
    expect(codes(checkRemoteMcpEnv(validEnv({ BASE_URL: undefined })))).toContain(
      "base_url_missing",
    );
    expect(codes(checkRemoteMcpEnv(validEnv({ BASE_URL: "not a url" })))).toContain(
      "base_url_invalid",
    );
    expect(codes(checkRemoteMcpEnv(validEnv({ BASE_URL: "http://api.example.com" })))).toContain(
      "base_url_not_https",
    );
    expect(
      codes(checkRemoteMcpEnv(validEnv({ BASE_URL: "https://api.example.com/oauth" }))),
    ).toContain("base_url_not_origin");
    expect(
      codes(checkRemoteMcpEnv(validEnv({ BASE_URL: "https://api.example.com/?x=1" }))),
    ).toContain("base_url_not_origin");
    expect(
      codes(checkRemoteMcpEnv(validEnv({ BASE_URL: "https://api.example.com/#f" }))),
    ).toContain("base_url_not_origin");
    // 127.0.0.1 同时满足「回环」与「IP 字面量」——报更精确的那一个。
    expect(codes(checkRemoteMcpEnv(validEnv({ BASE_URL: "https://127.0.0.1:3000" })))).toContain(
      "base_url_ip_literal",
    );
    expect(codes(checkRemoteMcpEnv(validEnv({ BASE_URL: "https://localhost" })))).toContain(
      "base_url_not_public",
    );
  });

  it("BASE_URL 允许尾斜杠（loadEnv 会归一，不该误报成带 path）", () => {
    expect(checkRemoteMcpEnv(validEnv({ BASE_URL: "https://api.phase.commitbrew.com/" }))).toEqual(
      [],
    );
  });

  it("BASE_URL 拒绝 IP 字面量（IPv4 / IPv6）——公网部署必须有域名", () => {
    for (const bad of ["https://192.168.1.5", "https://10.0.0.1", "https://[fd00::1]", "https://8.8.8.8"]) {
      const found = codes(checkRemoteMcpEnv(validEnv({ BASE_URL: bad })));
      expect(found, bad).toContain("base_url_ip_literal");
      // 不该被误报成「回环」或「带 path」——原因要指向真正的问题。
      expect(found, bad).not.toContain("base_url_not_origin");
    }
  });

  it("BASE_URL 拒绝非公网用途域名（localhost / .local / .internal / .test）", () => {
    const cases: Array<[string, string]> = [
      ["https://localhost", "base_url_not_public"],
      ["https://api.localhost", "base_url_not_public"],
      ["https://brewphase.local", "base_url_not_public"],
      ["https://db.internal", "base_url_not_public"],
      ["https://staging.test", "base_url_not_public"],
      ["https://nas.home", "base_url_not_public"],
      ["https://router.lan", "base_url_not_public"],
    ];
    for (const [bad, expected] of cases) {
      const found = codes(checkRemoteMcpEnv(validEnv({ BASE_URL: bad })));
      expect(found, bad).toContain(expected);
    }
    // 合法公网域名仍然通过（不能把检查做得过宽到拒绝一切）。
    expect(checkRemoteMcpEnv(validEnv({ BASE_URL: "https://api.phase.commitbrew.com" }))).toEqual([]);
    expect(checkRemoteMcpEnv(validEnv({ BASE_URL: "https://sub.domain.example.org" }))).toEqual([]);
  });

  it("POSTGRES_PASSWORD：缺失 / 过短 / 占位值 / 含 URL 保留字符", () => {
    expect(codes(checkRemoteMcpEnv(validEnv({ POSTGRES_PASSWORD: undefined })))).toContain(
      "postgres_password_missing",
    );
    expect(codes(checkRemoteMcpEnv(validEnv({ POSTGRES_PASSWORD: "" })))).toContain(
      "postgres_password_missing",
    );
    expect(codes(checkRemoteMcpEnv(validEnv({ POSTGRES_PASSWORD: "x".repeat(15) })))).toContain(
      "postgres_password_too_short",
    );
    // 示例文件里的占位口令：模板照抄不改就上线。
    expect(
      codes(checkRemoteMcpEnv(validEnv({ POSTGRES_PASSWORD: "change-me-strong-password" }))),
    ).toContain("postgres_password_placeholder");
    expect(codes(checkRemoteMcpEnv(validEnv({ POSTGRES_PASSWORD: "password" })))).toContain(
      "postgres_password_placeholder",
    );
    // 含保留字符：`/` 会让 new URL() 直接抛错，`@` 会被改写成 %40。
    for (const bad of ["ab/cd_password_01234567", "ab@cdpassword01234567", "ab:cdpassword01234567", "ab cd password 01234", "pass#word0123456789"]) {
      expect(
        codes(checkRemoteMcpEnv(validEnv({ POSTGRES_PASSWORD: bad }))),
        bad,
      ).toContain("postgres_password_unsafe_chars");
    }
    // URL 安全子集（含 base64url 的 - _）通过。
    // 注意要同时改 DATABASE_URL：两侧口令必须一致，否则会正确地报 mismatch。
    const urlSafe = "Ab3_-~.zXY0123456789";
    expect(
      checkRemoteMcpEnv(
        validEnv({
          POSTGRES_PASSWORD: urlSafe,
          DATABASE_URL: `postgres://brewphase:${urlSafe}@db:5432/brewphase_cloud`,
        }),
      ),
    ).toEqual([]);
  });

  it("DATABASE_URL 与 POSTGRES_PASSWORD 必须指向同一个口令", () => {
    // 口令被改写 / 只改一侧：服务会用另一个凭据连库。
    const mismatched = checkRemoteMcpEnv(
      validEnv({ DATABASE_URL: "postgres://brewphase:OTHER_PASSWORD_0123456789@db:5432/x" }),
    );
    expect(codes(mismatched)).toContain("database_url_password_mismatch");

    // 含 `/` 的口令拼进 URL 后无法解析 → 必须明确报 invalid，而不是假装成功。
    const unparseable = checkRemoteMcpEnv(
      validEnv({
        POSTGRES_PASSWORD: "ab/cd_password_01234567",
        DATABASE_URL: "postgres://brewphase:ab/cd_password_01234567@db:5432/x",
      }),
    );
    expect(codes(unparseable)).toContain("postgres_password_unsafe_chars");
    expect(codes(unparseable)).toContain("database_url_invalid");

    // 完全一致 → 通过。
    expect(checkRemoteMcpEnv(validEnv())).toEqual([]);
  });

  it("DATABASE_URL 缺失 → 拒绝", () => {
    expect(codes(checkRemoteMcpEnv(validEnv({ DATABASE_URL: undefined })))).toContain(
      "database_url_missing",
    );
    expect(codes(checkRemoteMcpEnv(validEnv({ DATABASE_URL: "   " })))).toContain(
      "database_url_missing",
    );
  });

  it("密钥缺失与过短分别报告", () => {
    expect(codes(checkRemoteMcpEnv(validEnv({ JWT_SIGNING_KEY: undefined })))).toContain(
      "jwt_key_missing",
    );
    // 31 字符 → 过短；32 字符 → 通过。
    expect(codes(checkRemoteMcpEnv(validEnv({ JWT_SIGNING_KEY: "x".repeat(31) })))).toContain(
      "jwt_key_too_short",
    );
    expect(
      checkRemoteMcpEnv(validEnv({ JWT_SIGNING_KEY: "x".repeat(32) })),
    ).toEqual([]);

    expect(codes(checkRemoteMcpEnv(validEnv({ SESSION_TOKEN_PEPPER: undefined })))).toContain(
      "pepper_missing",
    );
    expect(codes(checkRemoteMcpEnv(validEnv({ SESSION_TOKEN_PEPPER: "x".repeat(15) })))).toContain(
      "pepper_too_short",
    );
    expect(
      checkRemoteMcpEnv(validEnv({ SESSION_TOKEN_PEPPER: "x".repeat(16) })),
    ).toEqual([]);
  });

  it("Provider 凭据必须成对齐全（三种残缺形态各有原因）", () => {
    // 只有 ID 没有 secret：authorize 会 302，回调必然失败——最难查的一种。
    expect(
      codes(checkRemoteMcpEnv(validEnv({ GOOGLE_CLIENT_SECRET: undefined }))),
    ).toContain("google_client_secret_missing");
    // 只有 secret 没有 ID：Provider 根本不会出现在登录页。
    expect(codes(checkRemoteMcpEnv(validEnv({ GOOGLE_CLIENT_ID: undefined })))).toContain(
      "google_client_id_missing",
    );
    // 两个都没有。
    expect(
      codes(
        checkRemoteMcpEnv(
          validEnv({ GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined }),
        ),
      ),
    ).toContain("github_client_id_missing");
    // 两组都齐全才通过。
    expect(checkRemoteMcpEnv(validEnv())).toEqual([]);
  });

  it("MCP_BROWSER_SESSION_KEY：缺失 / 过短 / 复用 JWT 密钥", () => {
    expect(
      codes(checkRemoteMcpEnv(validEnv({ MCP_BROWSER_SESSION_KEY: undefined }))),
    ).toContain("mcp_browser_session_key_missing");
    // 空串与缺失等价（`.env.example` 的默认形态就是 `KEY=`）。
    expect(
      codes(checkRemoteMcpEnv(validEnv({ MCP_BROWSER_SESSION_KEY: "" }))),
    ).toContain("mcp_browser_session_key_missing");

    // 31 字节 → 过短；32 字节 → 通过。
    expect(
      codes(checkRemoteMcpEnv(validEnv({ MCP_BROWSER_SESSION_KEY: "x".repeat(31) }))),
    ).toContain("mcp_browser_session_key_too_short");
    expect(
      checkRemoteMcpEnv(validEnv({ MCP_BROWSER_SESSION_KEY: "x".repeat(32) })),
    ).toEqual([]);

    // 复用 JWT 密钥：两个密钥都必须**不等于**对方——这里用同一个值。
    const shared = "SENTINEL_SHARED_KEY_0123456789abcdef";
    const problems = checkRemoteMcpEnv(
      validEnv({ JWT_SIGNING_KEY: shared, MCP_BROWSER_SESSION_KEY: shared }),
    );
    expect(codes(problems)).toContain("mcp_browser_session_key_reused_from_jwt");
    // 且 JWT 自身长度是达标的，确保失败原因确实是「复用」而不是「太短」。
    expect(codes(problems)).not.toContain("jwt_key_too_short");
  });

  it("UTF-8 字节口径：31 个多字节字符可能超过 31 字节，按字节判", () => {
    // 每个 '中' 是 3 字节：31 个 = 93 字节 > 32 → 通过。
    // 若按字符数判会误报过短，这正是 enablement 用字节的原因。
    expect(checkRemoteMcpEnv(validEnv({ MCP_BROWSER_SESSION_KEY: "中".repeat(31) }))).toEqual([]);
    // 10 个 '中' = 30 字节 < 32 → 拒绝。
    expect(
      codes(checkRemoteMcpEnv(validEnv({ MCP_BROWSER_SESSION_KEY: "中".repeat(10) }))),
    ).toContain("mcp_browser_session_key_too_short");
  });

  it("GATEWAY_EXPECTED_REPLICAS ≠ 1 → 拒绝", () => {
    expect(codes(checkRemoteMcpEnv(validEnv({ GATEWAY_EXPECTED_REPLICAS: "2" })))).toContain(
      "gateway_replicas_not_single",
    );
    expect(codes(checkRemoteMcpEnv(validEnv({ GATEWAY_EXPECTED_REPLICAS: "3" })))).toContain(
      "gateway_replicas_not_single",
    );
    // 未设置时由 loadEnv 默认成 1，这里不误报。
    expect(checkRemoteMcpEnv(validEnv({ GATEWAY_EXPECTED_REPLICAS: undefined }))).toEqual([]);
  });

  it("返回**全部**问题，而不是第一个就停", () => {
    const problems = checkRemoteMcpEnv({
      NODE_ENV: "development",
      BASE_URL: "http://127.0.0.1:3000",
      // DATABASE_URL / 密钥 / Provider / MCP key 全缺
      GATEWAY_EXPECTED_REPLICAS: "2",
    });
    const found = codes(problems);
    // 一次拿到完整清单，省一轮部署窗口。
    expect(found).toContain("node_env_not_production");
    expect(found).toContain("base_url_not_https");
    expect(found).toContain("database_url_missing");
    expect(found).toContain("jwt_key_missing");
    expect(found).toContain("pepper_missing");
    expect(found).toContain("google_client_id_missing");
    expect(found).toContain("github_client_id_missing");
    expect(found).toContain("mcp_browser_session_key_missing");
    expect(found).toContain("gateway_replicas_not_single");
    expect(found.length).toBeGreaterThanOrEqual(9);
  });

  it("任何输出都不含 Secret 值（成功与失败两侧都要查）", () => {
    expectNoSecretLeak(checkRemoteMcpEnv(validEnv()));
    expectNoSecretLeak(checkRemoteMcpEnv(validEnv({ JWT_SIGNING_KEY: undefined })));
    expectNoSecretLeak(
      checkRemoteMcpEnv({
        NODE_ENV: "development",
        BASE_URL: "http://127.0.0.1:3000",
        JWT_SIGNING_KEY: "SENTINEL_JWT_KEY_0123456789abcdefghij",
        MCP_BROWSER_SESSION_KEY: "SENTINEL_JWT_KEY_0123456789abcdefghij",
      }),
    );
  });
});

describe("runRemoteMcpPreflight：三层裁决", () => {
  it("基础项没过就不再往下（不被 loadEnv 的重复报错淹没）", () => {
    const problems = runRemoteMcpPreflight({ NODE_ENV: "development" });
    expect(codes(problems)).toContain("node_env_not_production");
    // 不应出现 loadEnv 的包装前缀——那说明走了第二层。
    expect(JSON.stringify(problems)).not.toContain("[env] invalid configuration");
  });

  it("loadEnv 拒绝时归一成 env_rejected，且不泄漏值", () => {
    // GATEWAY_EXPECTED_REPLICAS=2 由 loadEnv 权威拒绝（env.ts:456）。
    // 基础项里 replicas 检查会先命中，所以这里换一个只在 loadEnv 层暴露的
    // 形态：把基础项全部补齐，再让 BASE_URL 走通，用非法的 PORT 触发 Zod 失败。
    const problems = runRemoteMcpPreflight(validEnv({ PORT: "not-a-port" }));
    expect(codes(problems)).toEqual(["env_rejected"]);
    const message = problems[0]!.message;
    expect(message).toContain("[env]");
    // Zod 错误只列变量名与原因，不得出现任何值。
    expect(message).not.toContain("SENTINEL");
    expect(message).not.toContain("postgres://");
  });

  it("全部通过 → 空数组（此时 MCP OAuth 路由会被注册）", () => {
    expect(runRemoteMcpPreflight(validEnv())).toEqual([]);
  });

  it("MCP 密钥缺失时，即便其它项全对也会失败", () => {
    const problems = runRemoteMcpPreflight(validEnv({ MCP_BROWSER_SESSION_KEY: undefined }));
    expect(codes(problems)).toEqual(["mcp_browser_session_key_missing"]);
  });
});
