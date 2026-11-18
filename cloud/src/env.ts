import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DEFAULT_MAX_BUCKETS } from "./security/rate-limit.js";

/**
 * 统一环境变量入口。所有配置必须经过这里校验，禁止在业务代码里直接读 process.env。
 *
 * 生产环境（NODE_ENV=production）强制要求真实密钥；开发/测试环境缺失密钥时
 * 生成临时随机值并告警，方便本地只跑 /health 与 /ready。
 */

const rawSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  BASE_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  JWT_SIGNING_KEY: z.string().optional(),
  JWT_SIGNING_KEY_PREVIOUS: z.string().optional(),
  SESSION_TOKEN_PEPPER: z.string().optional(),

  /**
   * 浏览器授权 Cookie（`bp_mcp_bs`）的签名密钥。≥32 字节，独立于 JWT 密钥。
   *
   * **可选，且刻意不参与启动断言**：Cloud 目前同时服务 Desktop 登录
   * （`/oauth/*` 与 `/auth/*`）。把这条设成必填会让「只跑 Desktop 登录的
   * 部署」因为一个尚未启用的 MCP 能力而起不来——那是把新功能的门禁
   * 变成了旧功能的故障。
   *
   * 正确纪律是：**C2 挂载 `/mcp/oauth/*` 路由时，缺这个值就不注册那些路由**
   * （fail-closed 在能力边界上，而不是在整个进程上）。本阶段只提供
   * `assertBrowserSessionKey()`，谁用它谁负责。
   */
  MCP_BROWSER_SESSION_KEY: z.string().optional(),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  OAUTH_TRANSACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OAUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(60),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_AUTHORIZE: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_MAX_TOKEN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_MAX_AUTH: z.coerce.number().int().positive().default(30),

  CORS_ORIGINS: z.string().default(""),
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // 可信代理层数：XFF 右端跳过 N 个条目后取客户端 IP（默认 1 = 单层反代）
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(5).default(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /**
   * 期望的 Gateway 副本数（协议 §12.2）。
   *
   * **只允许 1**。WSS 连接只存在于某一台实例的内存里，两个副本各自维护
   * 一份路由表，于是「设备连到 A、请求打到 B」表现为 `DEVICE_OFFLINE`
   * ——看起来像设备掉线，实际是部署错误。
   *
   * 这在应用层**无法技术强制**（运维仍可能误配），所以这里是「启动断言 +
   * 就绪探测里的 instance_id」两层约束，而不是一个能自动纠正的东西。
   */
  GATEWAY_EXPECTED_REPLICAS: z.coerce.number().int().positive().default(1),

  /**
   * WSS Upgrade 允许的 `Host`（逗号分隔）。
   *
   * 留空时从 `BASE_URL` 的 host 推导——正常部署只有这一个公网主机名。
   * 只有「反代不改写 Host 且后端需要接受另一个名字」时才需要显式配。
   *
   * **绝不用 `X-Forwarded-Host` 兜底**：那是客户端可写的。
   */
  GATEWAY_ALLOWED_HOSTS: z.string().default(""),

  // Provider 端点覆盖（测试/私有化部署用）
  GOOGLE_AUTH_URL: z.string().url().optional(),
  GOOGLE_TOKEN_URL: z.string().url().optional(),
  GOOGLE_JWKS_URL: z.string().optional(),
  GOOGLE_ISSUER: z.string().optional(),
  GITHUB_AUTH_URL: z.string().url().optional(),
  GITHUB_TOKEN_URL: z.string().url().optional(),
  GITHUB_API_BASE: z.string().optional(),
});

export type Env = {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  port: number;
  baseUrl: string;
  databaseUrl: string;

  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  githubClientId: string | undefined;
  githubClientSecret: string | undefined;

  jwtSigningKey: string;
  jwtSigningKeyPrevious: string | undefined;
  sessionTokenPepper: string;
  /**
   * 浏览器授权 Cookie 的签名密钥。`undefined` = 该能力未配置。
   *
   * 与 `jwtSigningKey` 分开：共用一个密钥会让「Cookie 签名」与「token 签名」
   * 互为伪装面（拿到其中一个就能伪造另一个的签名输入）。
   */
  mcpBrowserSessionKey: string | undefined;

  accessTokenTtlSeconds: number;
  refreshSessionTtlSeconds: number;
  oauthTransactionTtlSeconds: number;
  oauthCodeTtlSeconds: number;

  rateLimit: {
    windowMs: number;
    maxAuthorize: number;
    maxToken: number;
    maxAuth: number;
    /** 桶数量硬上限（生产恒为 DEFAULT_MAX_BUCKETS，仅供测试注入小值）。 */
    maxBuckets: number;
  };

  corsOrigins: string[];
  trustProxy: boolean;
  /** XFF 右端跳过的可信代理条目数（1 = 单层反代）。 */
  trustProxyHops: number;
  logLevel: "debug" | "info" | "warn" | "error";

  /** Remote MCP 单实例约束与 WSS 主机白名单（协议 §12.2）。 */
  gateway: {
    expectedReplicas: number;
    allowedHosts: string[];
  };

  googleAuthUrl: string;
  googleTokenUrl: string;
  googleJwksUrl: string;
  googleIssuer: string;
  githubAuthUrl: string;
  githubTokenUrl: string;
  githubApiBase: string;
};

function warn(message: string): void {
  console.warn(`[env] ${message}`);
}

function enforceProductionSecrets(
  input: Record<string, string | undefined>,
  baseUrl: string,
): void {
  const problems: string[] = [];
  const jwtKey = input.JWT_SIGNING_KEY;
  if (!jwtKey) {
    problems.push("JWT_SIGNING_KEY is required in production");
  } else if (jwtKey.length < 32) {
    problems.push("JWT_SIGNING_KEY must be at least 32 characters");
  }
  const pepper = input.SESSION_TOKEN_PEPPER;
  if (!pepper) {
    problems.push("SESSION_TOKEN_PEPPER is required in production");
  } else if (pepper.length < 16) {
    problems.push("SESSION_TOKEN_PEPPER must be at least 16 characters");
  }
  if (!input.GOOGLE_CLIENT_ID || !input.GOOGLE_CLIENT_SECRET) {
    problems.push("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are required in production");
  }
  if (!input.GITHUB_CLIENT_ID || !input.GITHUB_CLIENT_SECRET) {
    problems.push("GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are required in production");
  }
  // 用解析后的值判断：BASE_URL 有 http://localhost:3000 的默认值，若只看原始输入，
  // 生产环境漏配 BASE_URL 会静默把 JWT iss 与 Provider 回调指向 localhost。
  if (!baseUrl.startsWith("https://")) {
    problems.push("BASE_URL must be an explicitly set https URL in production");
  }
  if (problems.length > 0) {
    throw new Error(
      `[env] refusing to start in production:\n  - ${problems.join("\n  - ")}`,
    );
  }
}

export function loadEnv(input: Record<string, string | undefined>): Env {
  let parsed: z.infer<typeof rawSchema>;
  try {
    parsed = rawSchema.parse(input);
  } catch (error) {
    // 默认的 ZodError 只给一行 JSON，本地起服务时几乎无法定位。这里翻译成
    // 「变量名 + 原因」的清单，并且只列变量名，绝不回显任何值。
    if (error instanceof z.ZodError) {
      const problems = error.issues.map((issue) => {
        const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${field}: ${issue.message}`;
      });
      throw new Error(
        `[env] invalid configuration — check cloud/.env or the process environment:\n  - ${problems.join("\n  - ")}`,
      );
    }
    throw error;
  }

  if (parsed.NODE_ENV === "production") {
    enforceProductionSecrets(input, parsed.BASE_URL.replace(/\/+$/, ""));
  }

  let jwtSigningKey = parsed.JWT_SIGNING_KEY;
  if (!jwtSigningKey) {
    if (parsed.NODE_ENV === "production") {
      throw new Error("[env] JWT_SIGNING_KEY missing"); // 不可达，双保险
    }
    jwtSigningKey = randomBytes(48).toString("base64");
    warn(`JWT_SIGNING_KEY not set — generated an ephemeral key. Sessions will not survive restarts.`);
  }

  let sessionTokenPepper = parsed.SESSION_TOKEN_PEPPER;
  if (!sessionTokenPepper) {
    if (parsed.NODE_ENV === "production") {
      throw new Error("[env] SESSION_TOKEN_PEPPER missing"); // 不可达，双保险
    }
    sessionTokenPepper = randomBytes(32).toString("base64");
    warn(`SESSION_TOKEN_PEPPER not set — generated an ephemeral pepper.`);
  }

  // Access Token TTL 钳制在 10–15 分钟。
  const accessTtl = Math.min(900, Math.max(600, parsed.ACCESS_TOKEN_TTL_SECONDS));
  if (accessTtl !== parsed.ACCESS_TOKEN_TTL_SECONDS) {
    warn(`ACCESS_TOKEN_TTL_SECONDS clamped to ${accessTtl} (allowed range 600-900).`);
  }

  const corsOrigins = parsed.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const baseUrl = parsed.BASE_URL.replace(/\/+$/, "");

  /**
   * 单实例启动断言（协议 §12.2）。
   *
   * 拒绝启动而不是「警告后照跑」：多副本下 Remote 会以 `DEVICE_OFFLINE`
   * 的形式随机失败，那种故障最难查——设备明明在线、日志里也没有错误，
   * 只有大约一半的请求会「设备离线」。宁可起不来。
   */
  if (parsed.GATEWAY_EXPECTED_REPLICAS !== 1) {
    throw new Error(
      `[env] GATEWAY_EXPECTED_REPLICAS must be 1 for Remote MCP Phase 1.2–1.3.\n` +
        `  Got ${parsed.GATEWAY_EXPECTED_REPLICAS}. A shared routing table (Phase 1.4 / Redis)\n` +
        `  is required before running more than one replica: WSS connections live in a single\n` +
        `  process's memory, so a request landing on another replica shows up as DEVICE_OFFLINE.`,
    );
  }

  // WSS 的 Host 白名单：显式配置优先，否则从 BASE_URL 推导（正常部署只有一个公网名）。
  const allowedHosts = parsed.GATEWAY_ALLOWED_HOSTS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (allowedHosts.length === 0) {
    try {
      allowedHosts.push(new URL(baseUrl).host.toLowerCase());
    } catch {
      // BASE_URL 已被 zod 校验为 url，这里不可达；留空等于「不校验」，
      // 由 createLinkServer 的注释说明为什么空数组只在测试里可以接受。
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    isProduction: parsed.NODE_ENV === "production",
    port: parsed.PORT,
    baseUrl,
    databaseUrl: parsed.DATABASE_URL,

    googleClientId: parsed.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    githubClientId: parsed.GITHUB_CLIENT_ID,
    githubClientSecret: parsed.GITHUB_CLIENT_SECRET,

    jwtSigningKey,
    jwtSigningKeyPrevious: parsed.JWT_SIGNING_KEY_PREVIOUS,
    sessionTokenPepper,
    // 长度不足的情况**不在这里报错**：那会在开发环境把整进程拦下。
    // 真正使用它的地方（assertBrowserSessionKey）会 fail-closed。
    mcpBrowserSessionKey: parsed.MCP_BROWSER_SESSION_KEY,

    accessTokenTtlSeconds: accessTtl,
    refreshSessionTtlSeconds: parsed.REFRESH_SESSION_TTL_SECONDS,
    oauthTransactionTtlSeconds: parsed.OAUTH_TRANSACTION_TTL_SECONDS,
    oauthCodeTtlSeconds: parsed.OAUTH_CODE_TTL_SECONDS,

    rateLimit: {
      windowMs: parsed.RATE_LIMIT_WINDOW_MS,
      maxAuthorize: parsed.RATE_LIMIT_MAX_AUTHORIZE,
      maxToken: parsed.RATE_LIMIT_MAX_TOKEN,
      maxAuth: parsed.RATE_LIMIT_MAX_AUTH,
      // 刻意不从环境变量读：桶上限是防御性常量，不该被部署配置放大。
      maxBuckets: DEFAULT_MAX_BUCKETS,
    },

    corsOrigins,
    trustProxy: parsed.TRUST_PROXY,
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    logLevel: parsed.LOG_LEVEL,

    gateway: {
      expectedReplicas: parsed.GATEWAY_EXPECTED_REPLICAS,
      allowedHosts,
    },

    googleAuthUrl:
      parsed.GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
    googleTokenUrl: parsed.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
    googleJwksUrl: parsed.GOOGLE_JWKS_URL ?? "https://www.googleapis.com/oauth2/v3/certs",
    googleIssuer: parsed.GOOGLE_ISSUER ?? "https://accounts.google.com",
    githubAuthUrl: parsed.GITHUB_AUTH_URL ?? "https://github.com/login/oauth/authorize",
    githubTokenUrl: parsed.GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token",
    githubApiBase: parsed.GITHUB_API_BASE ?? "https://api.github.com",
  };
}

export function isProviderConfigured(env: Env, provider: "google" | "github"): boolean {
  if (provider === "google") {
    return Boolean(env.googleClientId && env.googleClientSecret);
  }
  return Boolean(env.githubClientId && env.githubClientSecret);
}
