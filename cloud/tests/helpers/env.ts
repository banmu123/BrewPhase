import type { Env } from "../../src/env.js";
import { DEFAULT_MAX_BUCKETS } from "../../src/security/rate-limit.js";
import { directOutboundProxy } from "../../src/net/proxy-fetch.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://brewphase:brewphase@127.0.0.1:54329/brewphase_cloud_test";

/**
 * 测试用 Env 覆盖：`rateLimit` 允许**部分**覆盖。
 *
 * `Partial<Env>` 会把嵌套的 `rateLimit` 当成整体必填，导致每个只想改 maxAuth
 * 的用例都得把 maxBuckets 一起抄一遍。这里只放宽这一层，其余字段语义不变。
 */
export type TestEnvOverrides = Omit<Partial<Env>, "rateLimit"> & {
  rateLimit?: Partial<Env["rateLimit"]>;
};

/** 构造完整测试 Env（不读 process.env，避免测试相互污染）。 */
export function makeTestEnv(overrides: TestEnvOverrides = {}): Env {
  const base: Env = {
    nodeEnv: "test",
    isProduction: false,
    port: 3999,
    baseUrl: "http://127.0.0.1:3999",
    databaseUrl: TEST_DATABASE_URL,

    googleClientId: "test-google-client-id",
    googleClientSecret: "test-google-client-secret",
    githubClientId: "test-github-client-id",
    githubClientSecret: "test-github-client-secret",

    jwtSigningKey: "test-jwt-signing-key-0123456789abcdef0123456789abcdef",
    jwtSigningKeyPrevious: undefined,
    sessionTokenPepper: "test-session-pepper-0123456789abcdef",
    // 测试环境给一个固定值：Cookie 相关的用例需要可复现的签名，
    // 而「未配置」这条路径由专门的用例显式传 undefined 覆盖。
    mcpBrowserSessionKey: "test-mcp-browser-session-key-0123456789abcdef",

    accessTokenTtlSeconds: 900,
    refreshSessionTtlSeconds: 30 * 24 * 3600,
    oauthTransactionTtlSeconds: 300,
    oauthCodeTtlSeconds: 60,

    rateLimit: {
      windowMs: 60_000,
      maxAuthorize: 30,
      maxToken: 20,
      maxAuth: 30,
      maxBuckets: DEFAULT_MAX_BUCKETS,
    },

    corsOrigins: [],
    trustProxy: false,
    trustProxyHops: 1,
    logLevel: "error",

    // 测试默认直连：绝不继承执行机器的 `HTTPS_PROXY`（R2v-F10 的根因）。
    // 需要代理语义的用例显式覆盖这两项。
    outboundProxy: directOutboundProxy(),
    mcpTrustedPeerIdentifiers: [],

    gateway: {
      // 单实例约束（协议 §12.2）。测试里恒为 1：多实例没有实现，
      // 而「把它设成 2 让测试通过」会让这条约束彻底失去意义。
      expectedReplicas: 1,
      // 集成测试的服务器监听 127.0.0.1:<随机端口>，Host 就是这个名字。
      // 端口在 normalizeHost 里被剥掉，所以这里只需 hostname。
      allowedHosts: ["127.0.0.1"],
    },

    googleAuthUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    googleTokenUrl: "https://oauth2.googleapis.com/token",
    googleJwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    googleIssuer: "https://accounts.google.com",
    githubAuthUrl: "https://github.com/login/oauth/authorize",
    githubTokenUrl: "https://github.com/login/oauth/access_token",
    githubApiBase: "https://api.github.com",
  };
  return {
    ...base,
    ...overrides,
    rateLimit: { ...base.rateLimit, ...(overrides.rateLimit ?? {}) },
  };
}
