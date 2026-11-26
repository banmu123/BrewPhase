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

/** `compose.yaml` 里 `${POSTGRES_USER:-brewphase}` / `${POSTGRES_DB:-brewphase_cloud}` 的默认值。 */
const POSTGRES_DEFAULT_USER = "brewphase";
const POSTGRES_DEFAULT_DB = "brewphase_cloud";

/** Compose 把 DATABASE_URL 指向的**服务名**与端口。 */
const POSTGRES_COMPOSE_HOST = "db";
const POSTGRES_COMPOSE_PORT = "5432";

/**
 * 拼进 `postgres://` 之后仍然逐字符不变的字符集。
 *
 * 这三个值（user / password / db）在 `compose.yaml` 里是**字符串拼接**，
 * 没有 URL 编码，所以只接受「编码前后同形」的子集。
 */
const URL_SAFE_VALUE = /^[A-Za-z0-9._~-]+$/;

/** `parsePostgresUrl` 的结果：一份完整的连接信息，而不是单个字段。 */
interface ParsedPostgresUrl {
  username: string;
  password: string;
  hostname: string;
  /** 空串表示 URL 里没写端口（postgres 的默认即 5432）。 */
  port: string;
  pathname: string;
  search: string;
}

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
function parsePostgresUrl(raw: string): ParsedPostgresUrl | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    return {
      username: url.username,
      password: url.password,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
    };
  } catch {
    return null;
  }
}

/**
 * `BREWPHASE_DOMAIN` 必须是**裸主机名**，且与 `BASE_URL` 的 host 逐字一致。
 *
 * 为什么两者必须对得上：Caddy 用 `BREWPHASE_DOMAIN` 决定申请哪张证书、接受哪个
 * Host；Cloud 用 `BASE_URL` 生成 JWT `iss`、Provider 回调地址与 Discovery issuer。
 * 两者不一致时的表现是「证书签下来了，但回调 404 / issuer 对不上」——HTTPS 检查
 * 与 `/health` 都发现不了。
 *
 * 比较规则：
 * - 大小写不敏感（DNS 本身不区分），但**不做后缀匹配**——
 *   `evil-api.phase.commitbrew.com` 不能因为「以同域名结尾」而通过；
 * - 允许尾部根点（`api.example.com.` 与 `api.example.com` 等价），只剥一个。
 */
function inspectBrewphaseDomain(
  raw: string | undefined,
  baseHostname: string | null,
): PreflightProblem | null {
  if (!raw || raw.trim().length === 0) {
    return {
      code: "brewphase_domain_missing",
      message:
        "BREWPHASE_DOMAIN is not set — Caddy uses it to pick the certificate and the Host it answers for, so it must be declared explicitly.",
    };
  }

  const value = raw.trim();
  // 这些字符要么说明填成了 URL，要么说明带上了端口；两种都不是裸主机名。
  // 单独判 `:` 而不是靠 URL 解析：`https://x` 与 `x:8443` 都会被解析成「有个 host」，
  // 从而掩盖真正的配置错误。
  if (/[:/?#@\s]/.test(value)) {
    return {
      code: "brewphase_domain_invalid",
      message:
        "BREWPHASE_DOMAIN must be a bare hostname — no scheme, path, query, fragment, userinfo or port.",
    };
  }

  const normalized = value.toLowerCase().replace(/\.$/, "");
  const labels = normalized.split(".");
  const labelOk = (label: string): boolean =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);

  if (normalized.length === 0 || normalized.length > 253) {
    return {
      code: "brewphase_domain_invalid",
      message: "BREWPHASE_DOMAIN must be a valid hostname (1-253 characters).",
    };
  }
  // 单标签名（`api`）拿不到公网证书：ACME 不会给无点的名字签发。
  if (labels.length < 2 || !labels.every(labelOk)) {
    return {
      code: "brewphase_domain_invalid",
      message:
        "BREWPHASE_DOMAIN must be a fully-qualified hostname (dot-separated labels, letters/digits/hyphen, no leading or trailing hyphen).",
    };
  }

  // BASE_URL 自身有问题时已经报过了，这里不再叠一条「不一致」——
  // 那会让运维以为只要改域名就能修好。
  if (baseHostname === null) return null;

  const baseNormalized = baseHostname.toLowerCase().replace(/\.$/, "");
  if (baseNormalized !== normalized) {
    return {
      code: "brewphase_domain_mismatch",
      message: `BREWPHASE_DOMAIN ("${normalized}") does not match the hostname of BASE_URL ("${baseNormalized}") — Caddy would serve a different name than the issuer and the OAuth callbacks.`,
    };
  }
  return null;
}

/**
 * `DATABASE_URL` 的完整校验。
 *
 * `compose.yaml` 用字符串拼接生成它：
 *   postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
 * 所以这里逐段核对「解析出来的连接信息」是否就是 Compose 实际配置的那一套。
 * 只比口令是不够的：host / port / user / db 任一被改，服务一样能启动，只是连到
 * 别的地方（或根本连不上），而预检只看单个变量发现不了。
 *
 * 纪律：错误信息只描述**哪个字段、什么期望**，不回显 URL、不回显口令。
 */
function inspectDatabaseUrl(input: EnvInput): PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  const push = (code: string, message: string): void => {
    problems.push({ code, message });
  };

  const raw = input.DATABASE_URL;
  if (!raw || raw.trim().length === 0) {
    push("database_url_missing", "DATABASE_URL is not set.");
    return problems;
  }

  // `#` 必须查原始串：WHATWG 对非特殊 scheme 会**静默丢弃** fragment，
  // 于是 `postgres://u:p#x@db/...` 看起来「解析成功」，口令其实被截断了。
  if (raw.includes("#")) {
    push(
      "database_url_hash_unexpected",
      "DATABASE_URL must not contain a fragment (#) — it is silently dropped by the URL parser.",
    );
  }

  const parsed = parsePostgresUrl(raw);
  if (parsed === null) {
    push(
      "database_url_invalid",
      "DATABASE_URL is not a parseable postgres:// or postgresql:// URL.",
    );
    return problems;
  }

  // `${VAR:-default}`：未设置**或为空**才回落默认值（不 trim，与 compose 逐字一致）。
  const pgUser =
    input.POSTGRES_USER === undefined || input.POSTGRES_USER === ""
      ? POSTGRES_DEFAULT_USER
      : input.POSTGRES_USER;
  const pgDb =
    input.POSTGRES_DB === undefined || input.POSTGRES_DB === ""
      ? POSTGRES_DEFAULT_DB
      : input.POSTGRES_DB;
  const pgPassword = input.POSTGRES_PASSWORD;

  if (parsed.username === "") {
    push(
      "database_url_user_missing",
      "DATABASE_URL must embed a non-empty username (compose always writes POSTGRES_USER).",
    );
  } else if (parsed.username !== pgUser) {
    push(
      "database_url_user_mismatch",
      "DATABASE_URL username does not match POSTGRES_USER — the app would authenticate as a different role.",
    );
  }

  // 不能因为「解析不出 password」就跳过——那正是最容易被漏掉的配置。
  if (parsed.password === "") {
    push(
      "database_url_password_missing",
      "DATABASE_URL must embed a non-empty password (compose always writes POSTGRES_PASSWORD).",
    );
  } else if (pgPassword !== undefined && pgPassword !== "" && parsed.password !== pgPassword) {
    push(
      "database_url_password_mismatch",
      "DATABASE_URL password does not match POSTGRES_PASSWORD — the app would connect with a different credential than the database is configured with.",
    );
  }

  if (parsed.hostname !== POSTGRES_COMPOSE_HOST) {
    push(
      "database_url_host_mismatch",
      `DATABASE_URL hostname must be "${POSTGRES_COMPOSE_HOST}" (the compose service name, not localhost or a container IP).`,
    );
  }

  // 空串表示没写端口，postgres 默认就是 5432——语义正确，不算错。
  if (parsed.port !== "" && parsed.port !== POSTGRES_COMPOSE_PORT) {
    push(
      "database_url_port_unsupported",
      `DATABASE_URL must use port ${POSTGRES_COMPOSE_PORT}; compose publishes no database port to the host.`,
    );
  }

  if (parsed.search !== "") {
    push(
      "database_url_query_unexpected",
      "DATABASE_URL must not carry a query string — connection parameters belong in the deploy config, not in this hand-built URL.",
    );
  }

  // 路径必须**恰好**是数据库名：多一段（`/brewphase_cloud/extra`）或少了都
  // 说明拼接结果与 POSTGRES_DB 不一致。
  if (parsed.pathname !== `/${pgDb}`) {
    push(
      "database_url_name_mismatch",
      "DATABASE_URL database name does not match POSTGRES_DB.",
    );
  }

  return problems;
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

  // 端口放在最后判：`https://127.0.0.1:3000` 的病根是「用了 IP 字面量」，
  // 先报端口会把人引去改端口，改完照样不合法。
  // 只发布 80/443，带别的端口意味着「部署者以为服务在 8443」，而 Caddy 并不监听它。
  // WHATWG 会把显式 `:443` 归一成空串，所以 `port !== ""` 等价于「非默认端口」。
  if (url.port !== "") {
    return {
      code: "base_url_port_unsupported",
      message:
        "BASE_URL must use the default https port — compose publishes only 80/443, so an explicit port cannot be reached.",
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

  // ---- 3. BREWPHASE_DOMAIN 必须与 BASE_URL 指向同一个名字 ----
  // Caddy 用域名签证书、决定接受哪个 Host；Cloud 用 BASE_URL 生成 iss 与回调。
  // 两者不一致时 HTTPS 检查与 /health 都发现不了，只有 OAuth 回调会 404。
  const baseHostname = (() => {
    if (!input.BASE_URL || input.BASE_URL.trim().length === 0) return null;
    try {
      return new URL(input.BASE_URL.trim()).hostname;
    } catch {
      return null;
    }
  })();
  const domainProblem = inspectBrewphaseDomain(input.BREWPHASE_DOMAIN, baseHostname);
  if (domainProblem) problems.push(domainProblem);

  // ---- 4. 数据库 ----
  // 先判 user / db 的「拼进 URL 是否安全」，再判 DATABASE_URL 各段是否与它们一致。
  // 顺序很重要：不安全的值会让 URL 解析结果本身变形，先报根因才不会误导。
  const pgUser =
    input.POSTGRES_USER === undefined || input.POSTGRES_USER === ""
      ? POSTGRES_DEFAULT_USER
      : input.POSTGRES_USER;
  const pgDb =
    input.POSTGRES_DB === undefined || input.POSTGRES_DB === ""
      ? POSTGRES_DEFAULT_DB
      : input.POSTGRES_DB;
  if (!URL_SAFE_VALUE.test(pgUser)) {
    push(
      "postgres_user_unsafe_chars",
      "POSTGRES_USER contains characters that break a hand-built postgres:// URL (allowed: A-Z a-z 0-9 . _ ~ -).",
    );
  }
  if (!URL_SAFE_VALUE.test(pgDb)) {
    push(
      "postgres_db_unsafe_chars",
      "POSTGRES_DB contains characters that break a hand-built postgres:// URL (allowed: A-Z a-z 0-9 . _ ~ -).",
    );
  }

  /**
   * ---- 4b. PostgreSQL 口令 ----
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
    if (!URL_SAFE_VALUE.test(pgPassword)) {
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

  // ---- 4c. DATABASE_URL 逐段核对 ----
  // 一条语句拿到 host / port / user / password / db 的全部偏差，不再只比口令。
  problems.push(...inspectDatabaseUrl(input));

  // ---- 5. 基础密钥强度 ----
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
    "  BASE_URL                       = https origin (public host, default port, no path/query/fragment)",
    "  BREWPHASE_DOMAIN               = bare hostname, identical to the hostname of BASE_URL",
    "  DATABASE_URL                   = set (host=db, port=5432, user/password/db match POSTGRES_*)",
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
