/**
 * Remote MCP 专用部署预检（Phase 1.3.3-A-R5）。
 *
 * ## 为什么是「专用预检」而不是把密钥改成全局必填
 *
 * `MCP_BROWSER_SESSION_KEY` 在 `loadEnv` 里是**可选**的，这是原有设计：
 * Cloud 同时承担 Desktop 登录服务（`/oauth/*`、`/auth/*`），把 MCP 的密钥
 * 设成进程级必填，会让「只跑登录」的部署因为一个尚未启用的能力起不来
 * （`src/app.ts:110-118` 记录了这条取舍）。**本轮不改 `loadEnv`，也不改
 * `resolveMcpOAuthEnablement()` 的语义。**
 *
 * 但反过来说：一台**要提供 Remote MCP 的**服务器，如果 `MCP_BROWSER_SESSION_KEY`
 * 没配，`app.ts` 只会打一条 `mcp_oauth_disabled` warn 然后照常启动——
 * `/mcp`、`/.well-known/*`、`/mcp/oauth/*` 全部 404，而健康检查仍然 200。
 * 那是最难查的一类故障：进程活着、端口开着、就是没有 MCP。
 *
 * 所以把「部署这台机器的人」需要知道的全部前提，收敛成一个**必须先跑**的
 * 显式步骤。预检失败 → 非零退出 → 部署流程不继续。
 *
 * ## 三条纪律
 *
 * 1. **绝不输出任何 Secret 的值**：所有 message 只描述「哪个变量、什么问题」，
 *    不拼接变量内容。合法配置的输出同样只有变量名与判定结果。
 * 2. **不为通过检查提供任何默认值**：预检只读、只判，不写 `process.env`。
 * 3. **不放宽既有校验**：能复用的判定一律复用——`GATEWAY_EXPECTED_REPLICAS`
 *    与生产密钥强度由 `loadEnv()` 权威裁决，MCP 密钥启用由
 *    `resolveMcpOAuthEnablement()` 权威裁决。本文件只补「部署前」这一层，
 *    并把失败原因用人话讲清楚。
 *
 * 运行：`pnpm preflight:remote-mcp`（源码）/ `node dist/scripts/preflight-remote-mcp.js`（镜像内）。
 */
import { loadEnv } from "../env.js";
import { loadLocalEnvFile } from "../env-file.js";
import { resolveMcpOAuthEnablement } from "../mcp-oauth/enablement.js";
import { MCP_BROWSER_SESSION_KEY_MIN_BYTES } from "../mcp-oauth/constants.js";

/** 单条预检失败。`code` 供测试断言，`message` 供人读。 */
export interface PreflightProblem {
  code: string;
  message: string;
}

/** `process.env` 的最小形状（纯函数依赖，便于测试注入）。 */
export type EnvInput = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * 示例文件里的占位口令——它们出现在模板里是给「照抄不改」的人看的，
 * 出现在生产配置里就是事故。命中即拒绝，且**不回显口令本身**。
 */
const PLACEHOLDER_SECRETS = new Set([
  "change-me-strong-password",
  "change-me",
  "changeme",
  "password",
  "passw0rd",
  "secret",
  "postgres",
  "brewphase",
  "admin",
  "example",
  "123456",
  "test",
]);

/**
 * 解析 `postgres://user:pass@host:port/db`。
 *
 * 用 `new URL()` 而不是手写正则：非特殊 scheme 也会解析 authority，
 * 于是 `username` / `password` / `hostname` / `port` 都由同一套 WHATWG
 * 规则给出——与「拼接后再被别人解析」的行为一致，才能发现口令被改写。
 *
 * 口令里含 `/` 时 `new URL()` 直接抛错，这里返回 `null` 交给调用方报
 * `database_url_invalid`（那正是预检要抓的配置错误）。
 */
function parsePostgresUrl(raw: string): { password?: string } | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    return { password: url.password === "" ? undefined : url.password };
  } catch {
    return null;
  }
}

/**
 * 非公网用途的主机后缀（RFC 6761/6762 保留域 + 常见内网后缀）。
 *
 * 这些域名**不可能**是「公网部署」：`.local` 是 mDNS、`.internal` 是内网、
 * `.test` 保留给测试、`localhost` 是本机。它们能通过 `new URL()` 解析，
 * 也会通过 `assertIssuerBaseUrl`，所以必须在预检这一层单独挡掉——
 * 否则一台配了 `https://brewphase.local` 的机器会「预检通过」，然后
 * Provider 回调与证书签发全部失败。
 */
const NON_PUBLIC_SUFFIXES = [".local", ".internal", ".test", ".localhost", ".home", ".lan"];

/**
 * 判断 `BASE_URL` 是否为「公网 HTTPS Origin」。
 *
 * - 必须是 `https://`（JWT `iss`、Provider 回调、Discovery issuer 全部来自它）；
 * - 必须是**纯 Origin**：没有 path（除单个 `/`）、没有 query、没有 fragment。
 *   带 path 的 issuer 会让 `/.well-known/*` 的拼接结果与实际路由对不上；
 * - **拒绝 IP 字面量**（IPv4 与 IPv6）：公网部署必须有域名——裸 IP 拿不到
 *   匹配的证书，Provider 控制台的回调登记也不该绑死一个会变的地址；
 * - **拒绝非公网用途域名**（回环、`.local` / `.internal` / `.test` 等）。
 *
 * 注意尾斜杠：`loadEnv` 会 `replace(/\/+$/,"")` 归一，所以这里也允许
 * `https://host/`，不把它误判成「带 path」。
 *
 * DNS 是否真的解析、证书是否签得出来，由独立的部署检查负责
 * （`deploy/README.md` 的 HTTPS 与 smoke test），预检不做网络请求。
 */
function inspectBaseUrl(raw: string | undefined): PreflightProblem | null {
  if (!raw || raw.trim().length === 0) {
    return { code: "base_url_missing", message: "BASE_URL is not set." };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { code: "base_url_invalid", message: "BASE_URL is not a valid URL." };
  }
  if (url.protocol !== "https:") {
    return {
      code: "base_url_not_https",
      message: "BASE_URL must be an https origin in production (it is also the JWT iss).",
    };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return {
      code: "base_url_not_origin",
      message: "BASE_URL must be a bare origin — no path, query or fragment.",
    };
  }
  if (url.username || url.password) {
    return { code: "base_url_userinfo", message: "BASE_URL must not contain userinfo." };
  }

  const hostname = url.hostname.toLowerCase();

  // IP 字面量：IPv6 在 URL 里带方括号，IPv4 是点分十进制。
  if (hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return {
      code: "base_url_ip_literal",
      message:
        "BASE_URL must use a public domain name, not an IP literal (no matching certificate, and Provider callbacks must not be bound to a mutable address).",
    };
  }
  if (LOOPBACK_HOSTS.has(hostname)) {
    return {
      code: "base_url_not_public",
      message: "BASE_URL points at a loopback host; a public deployment needs a real hostname.",
    };
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return {
      code: "base_url_not_public",
      message: "BASE_URL points at a localhost name; a public deployment needs a real hostname.",
    };
  }
  const badSuffix = NON_PUBLIC_SUFFIXES.find((suffix) => hostname.endsWith(suffix));
  if (badSuffix) {
    return {
      code: "base_url_not_public",
      message: `BASE_URL uses the reserved/non-public suffix "${badSuffix}"; a public deployment needs a real public hostname.`,
    };
  }
  return null;
}

/**
 * 部署前置检查（纯函数，不读 `process.env`、不改任何东西）。
 *
 * 覆盖任务书 §3.1 的全部条目。返回**全部**问题而不是第一个——
 * 运维一次性拿到完整清单，比「改一个、再跑一次」省一轮部署窗口。
 */
export function checkRemoteMcpEnv(input: EnvInput): PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  const push = (code: string, message: string): void => {
    problems.push({ code, message });
  };

  // ---- 1. 生产模式 ----
  // 非 production 时 loadEnv 不会执行 enforceProductionSecrets，预检也就
  // 无法代表真实部署。宁可拒绝，也不让 staging 配置冒充通过。
  if (input.NODE_ENV !== "production") {
    push("node_env_not_production", "NODE_ENV must be 'production' for a Remote MCP deployment.");
  }

  // ---- 2. BASE_URL ----
  const baseUrlProblem = inspectBaseUrl(input.BASE_URL);
  if (baseUrlProblem) problems.push(baseUrlProblem);

  // ---- 3. 数据库 ----
  if (!input.DATABASE_URL || input.DATABASE_URL.trim().length === 0) {
    push("database_url_missing", "DATABASE_URL is not set.");
  }

  /**
   * ---- 3b. PostgreSQL 口令 ----
   *
   * `compose.yaml` 用**字符串拼接**生成 `DATABASE_URL`：
   *   postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
   * 没有 URL 编码，所以口令里只要有一个保留字符，拼出来的 URL 就不再指向
   * 预期的库——实测 `openssl rand -base64 24` 会产出 `/`，`new URL()`
   * 直接抛 `Invalid URL`；含 `@` 时更隐蔽：解析器会把口令**改写**成
   * `ab%40cd`，看起来能解析、拿到的口令却不是配置里那个。
   *
   * 因此这里只接受 URL 安全子集，并拒绝占位口令。
   */
  const pgPassword = input.POSTGRES_PASSWORD;
  if (!pgPassword || pgPassword.trim().length === 0) {
    push(
      "postgres_password_missing",
      "POSTGRES_PASSWORD is not set — compose refuses to start without it, and preflight must not either.",
    );
  } else {
    if (pgPassword.length < 16) {
      push("postgres_password_too_short", "POSTGRES_PASSWORD must be at least 16 characters.");
    }
    // 只允许 URL 安全子集：字母数字 + `. _ ~ -`。这些字符不需要编码，
    // 拼进 postgres:// URL 后 `new URL()` 解析出的口令与配置逐字相同。
    if (!/^[A-Za-z0-9._~-]+$/.test(pgPassword)) {
      push(
        "postgres_password_unsafe_chars",
        "POSTGRES_PASSWORD contains characters that break a hand-built postgres:// URL (allowed: A-Z a-z 0-9 . _ ~ -). Generate one with: openssl rand -hex 32",
      );
    }
    if (PLACEHOLDER_SECRETS.has(pgPassword)) {
      push(
        "postgres_password_placeholder",
        "POSTGRES_PASSWORD is a well-known placeholder — generate a real one with: openssl rand -hex 32",
      );
    }
  }

  // ---- 3c. DATABASE_URL 必须与 POSTGRES_PASSWORD 指向同一个口令 ----
  //
  // 这条把「Compose 注入的 DATABASE_URL」与「db 服务实际使用的口令」对上：
  // 两者任一侧被改而另一侧没跟上，表现是服务起来但连不上库（或连到别的库），
  // 而预检只看单个变量是发现不了的。
  if (input.DATABASE_URL && pgPassword) {
    const parsed = parsePostgresUrl(input.DATABASE_URL);
    if (parsed === null) {
      push(
        "database_url_invalid",
        "DATABASE_URL is not a parseable postgres:// URL.",
      );
    } else if (parsed.password !== undefined && parsed.password !== pgPassword) {
      push(
        "database_url_password_mismatch",
        "DATABASE_URL password does not match POSTGRES_PASSWORD — the app would connect with a different credential than the database is configured with.",
      );
    }
  }

  // ---- 4/5. 基础密钥强度 ----
  // 只判长度与是否复用，**绝不回显值**。
  const jwt = input.JWT_SIGNING_KEY;
  if (!jwt || jwt.length === 0) {
    push("jwt_key_missing", "JWT_SIGNING_KEY is not set.");
  } else if (jwt.length < 32) {
    push("jwt_key_too_short", "JWT_SIGNING_KEY must be at least 32 characters.");
  }
  const pepper = input.SESSION_TOKEN_PEPPER;
  if (!pepper || pepper.length === 0) {
    push("pepper_missing", "SESSION_TOKEN_PEPPER is not set.");
  } else if (pepper.length < 16) {
    push("pepper_too_short", "SESSION_TOKEN_PEPPER must be at least 16 characters.");
  }

  // ---- 6/7. Provider 凭据成对齐全 ----
  // 只配一半比完全不配更难查：authorize 会 302 到 Provider，
  // 回调却因为缺 secret 失败，用户看到的是「登录后报错」。
  for (const [idVar, secretVar] of [
    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  ] as const) {
    const hasId = Boolean(input[idVar] && input[idVar]!.trim().length > 0);
    const hasSecret = Boolean(input[secretVar] && input[secretVar]!.trim().length > 0);
    if (hasId && !hasSecret) {
      push(
        `${secretVar.toLowerCase()}_missing`,
        `${secretVar} is not set while ${idVar} is — OAuth callbacks will fail after redirect.`,
      );
    } else if (!hasId && hasSecret) {
      push(
        `${idVar.toLowerCase()}_missing`,
        `${idVar} is not set while ${secretVar} is — the provider will never be offered.`,
      );
    } else if (!hasId && !hasSecret) {
      push(
        `${idVar.toLowerCase()}_missing`,
        `${idVar} and ${secretVar} are both required in production.`,
      );
    }
  }

  // ---- 8. MCP 浏览器会话密钥长度（按 UTF-8 字节，与 enablement 同口径）----
  const mcpKey = input.MCP_BROWSER_SESSION_KEY;
  if (!mcpKey || mcpKey.length === 0) {
    push(
      "mcp_browser_session_key_missing",
      `MCP_BROWSER_SESSION_KEY is not set — without it the /mcp, /.well-known/* and /mcp/oauth/* routes are never registered (Remote MCP would be a 404 while /health still returns 200).`,
    );
  } else if (Buffer.byteLength(mcpKey, "utf8") < MCP_BROWSER_SESSION_KEY_MIN_BYTES) {
    push(
      "mcp_browser_session_key_too_short",
      `MCP_BROWSER_SESSION_KEY must be at least ${MCP_BROWSER_SESSION_KEY_MIN_BYTES} UTF-8 bytes.`,
    );
  }

  // ---- 9. MCP 密钥不得复用 JWT 密钥 ----
  // 与 enablement 同一条规则：两者都是 HMAC-SHA256(base64url)，
  // 共用会让「拿到其中一个的签名输入」变成「能伪造另一个」。
  // 这里提前报一次是为了让**部署前**就失败，而不是等服务起完才在日志里看到。
  if (mcpKey && jwt && mcpKey === jwt) {
    push(
      "mcp_browser_session_key_reused_from_jwt",
      "MCP_BROWSER_SESSION_KEY must be different from JWT_SIGNING_KEY.",
    );
  }

  // ---- 10. 单副本 ----
  // WSS 的 ConnectionRegistry 是进程内状态；多副本会让请求落到没有连接的
  // 实例上，表现成「设备明明在线却 DEVICE_OFFLINE」。
  const replicas = input.GATEWAY_EXPECTED_REPLICAS;
  if (replicas !== undefined && replicas !== "" && replicas !== "1") {
    push(
      "gateway_replicas_not_single",
      "GATEWAY_EXPECTED_REPLICAS must be 1 — the WSS routing table is in-process (Phase 1.4 / Redis is not implemented).",
    );
  }

  return problems;
}

/**
 * 完整预检：基础项 → `loadEnv()`（权威裁决生产密钥与单副本）→ MCP 启用判定。
 *
 * 分三层是为了让失败原因**可读**：`loadEnv` 的 Zod 错误只列变量名，
 * `resolveMcpOAuthEnablement` 只给枚举 reason，而部署者需要知道
 * 「这个变量要多长、为什么不能复用」。
 *
 * 任何一层抛错都归一成 `PreflightProblem[]`，由调用方决定退出码。
 */
export function runRemoteMcpPreflight(input: EnvInput): PreflightProblem[] {
  const problems = checkRemoteMcpEnv(input);
  // 基础项没过就不再往下：loadEnv 在 NODE_ENV=production 下会抛
  // enforceProductionSecrets，那时的报错与上面重复，反而淹没真正的原因。
  if (problems.length > 0) return problems;

  let env;
  try {
    env = loadEnv(input);
  } catch (err) {
    // loadEnv 的错误消息只含变量名与原因（见 env.ts:386-397），不含任何值。
    return [
      {
        code: "env_rejected",
        message: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  const enablement = resolveMcpOAuthEnablement(env);
  if (!enablement.enabled) {
    problems.push({
      code: `mcp_oauth_${enablement.reason}`,
      message:
        "MCP OAuth enablement check failed — the /mcp and /mcp/oauth/* routes would not be registered. " +
        `reason=${enablement.reason}`,
    });
  }

  // 单副本由 loadEnv 权威裁决（>1 直接抛）。这里再确认一次解析结果，
  // 让「配置没进 loadEnv」这种意外也逃不过预检。
  if (env.gateway.expectedReplicas !== 1) {
    problems.push({
      code: "gateway_replicas_not_single",
      message: "GATEWAY_EXPECTED_REPLICAS resolved to something other than 1.",
    });
  }

  return problems;
}

/** 成功时打印的摘要。**只有变量名与判定**，没有任何值。 */
function printSummary(): void {
  const lines = [
    "[preflight:remote-mcp] all checks passed:",
    "  NODE_ENV                       = production",
    "  BASE_URL                       = https origin (public host, no path/query/fragment)",
    "  DATABASE_URL                   = set (parses, password matches POSTGRES_PASSWORD)",
    "  POSTGRES_PASSWORD              = set (>=16 chars, URL-safe, not a placeholder)",
    "  JWT_SIGNING_KEY                = set (>=32 chars)",
    "  SESSION_TOKEN_PEPPER           = set (>=16 chars)",
    "  GOOGLE_CLIENT_ID / SECRET      = both set",
    "  GITHUB_CLIENT_ID / SECRET      = both set",
    `  MCP_BROWSER_SESSION_KEY        = set (>=${MCP_BROWSER_SESSION_KEY_MIN_BYTES} bytes, distinct from JWT_SIGNING_KEY)`,
    "  GATEWAY_EXPECTED_REPLICAS      = 1",
    "  MCP OAuth enablement           = enabled (/mcp, /.well-known/*, /mcp/oauth/* will be registered)",
    "[preflight:remote-mcp] OK",
  ];
  console.log(lines.join("\n"));
}

function main(): void {
  /**
   * 本地演练时补上 `.env`，否则 `BASE_URL is not set` 这种反馈毫无信息量。
   *
   * 生产是 no-op：`loadLocalEnvFile()` 在 `NODE_ENV=production` 直接返回
   * （`src/env-file.ts:14`），镜像里也已被 `.dockerignore` 排除。所以这里
   * **不会**把开发配置带进生产——生产必须由部署环境显式注入。
   */
  loadLocalEnvFile();

  const problems = runRemoteMcpPreflight(process.env);
  if (problems.length > 0) {
    console.error("[preflight:remote-mcp] FAILED — fix the following before deploying:");
    for (const p of problems) {
      console.error(`  - [${p.code}] ${p.message}`);
    }
    console.error("[preflight:remote-mcp] aborting (non-zero exit).");
    process.exit(1);
  }
  printSummary();
  process.exit(0);
}

// 只有被直接执行时才跑 main：被测试 import 时不产生副作用。
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("preflight-remote-mcp.js") ||
    process.argv[1].endsWith("preflight-remote-mcp.ts"));
if (invokedDirectly) {
  main();
}
