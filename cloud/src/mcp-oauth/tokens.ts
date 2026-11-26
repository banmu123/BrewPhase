import { SignJWT, decodeProtectedHeader, jwtVerify } from "jose";
import { randomToken } from "../security/crypto.js";
import type { JwtKeyRing } from "../sessions/jwt.js";
import { formatScopeClaim, parseScopeClaim, type McpScope } from "./constants.js";

/**
 * MCP Access Token（JWT / HS256）——**独立于 Desktop 登录 Token**。
 *
 * ## 为什么必须另起一套方法，而不是给 `signAccessToken` 加参数
 *
 * Desktop 登录 token 的 `aud` 是常量 `brewphase-desktop`，而 MCP token 的
 * `aud` 必须是真实的资源 URI（`<BASE_URL>/mcp`）。把两者塞进同一个函数会
 * 出现两种坏结果：要么 `aud` 变成调用方可选（一次传错就跨域可用），要么
 * 函数内部要判断「这是哪个场景」（凭据的判定不该由调用方的意图决定）。
 *
 * 密钥可以共用：两者都是同一个 Cloud 进程签发与校验，共享 `JwtKeyRing`
 * 让密钥轮换只有一处。**隔离靠 `aud` + `iss` 的强制校验**，不靠密钥分离——
 * 而校验失败的两种情形在测试里都逐条钉住了（双向）。
 *
 * ## Claims
 *
 * | claim | 含义 |
 * |---|---|
 * | `sub` | 用户 id |
 * | `sid` | `mcp_sessions.id`（跨刷新不变，撤销即失效的落点） |
 * | `iss` | `BASE_URL` |
 * | `aud` | `MCP_RESOURCE`（= `BASE_URL + "/mcp"`） |
 * | `iat` / `exp` | 15 分钟窗口（沿用 `ACCESS_TOKEN_TTL_SECONDS`） |
 * | `jti` | 16 字节随机值。**token 级标识，不是请求去重键** |
 * | `client_id` | 签发它的 OAuth 客户端（= Session 的 `client_id`） |
 * | `scope` | 空格分隔，= `issued_scope ∩ grant.scopes` |
 *
 * **有** `client_id`（设计 §8.1）：它不参与 `/mcp` 的授权判定（那里的归属靠
 * `sid` 回查 Session），但撤销端点必须能回答「这枚 token 属于哪个客户端」——
 * 否则任何拿到别人 Access Token 的调用方都能试出它是否有效。C1 实现时曾把
 * 这一条省掉，C3b-R2 按设计补回。
 */

export interface McpAccessTokenInput {
  userId: string;
  /** `mcp_sessions.id`。 */
  sessionId: string;
  /** `mcp_sessions.client_id`：签发这枚 token 的公开客户端标识。 */
  clientId: string;
  /** 必须是 `issued_scope ∩ grant.scopes`；调用方负责求交集。 */
  scope: readonly string[];
}

export interface McpAccessTokenOptions {
  /** `BASE_URL`（不含尾斜杠）。 */
  issuer: string;
  /** `MCP_RESOURCE`（= `issuer + "/mcp"`）。 */
  resource: string;
  /** 沿用 `env.accessTokenTtlSeconds`（600–900）。 */
  ttlSeconds: number;
  /** 可注入时钟（测试跨过期边界用；生产不传）。 */
  now?: (() => Date) | undefined;
}

export interface McpAccessClaims {
  userId: string;
  sessionId: string;
  /** 已校验的客户端归属（`client_id` claim）。 */
  clientId: string;
  jti: string;
  /** 已校验过的 scope 列表（保序、去重、全部在 `MCP_SCOPES` 内）。 */
  scope: McpScope[];
  issuedAt: number;
  expiresAt: number;
}

/**
 * 固定文案的验证失败。
 *
 * 不暴露「是签名不对 / 是 aud 不对 / 是 kid 不认识」：那三类对外都是
 * 「这个 token 不能用」，区分它们只对攻击者有用（可以拿来判断服务器
 * 处于轮换的哪一侧）。具体原因留在 message 里供服务端日志使用，
 * 但**不含任何密钥材料**。
 */
export class McpTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTokenError";
  }
}

export async function signMcpAccessToken(
  ring: JwtKeyRing,
  input: McpAccessTokenInput,
  options: McpAccessTokenOptions,
): Promise<string> {
  // 先校验再签名：一个非法 scope 的 token 一旦签发出去就无法收回。
  const scopes = parseScopeClaim(formatScopeClaim(input.scope));
  if (scopes === null) {
    throw new McpTokenError("refusing to sign a token with an empty or unknown scope");
  }

  if (input.clientId.length === 0) {
    throw new McpTokenError("refusing to sign a token without a client id");
  }

  const issuedAt = Math.floor((options.now ? options.now() : new Date()).getTime() / 1000);
  return await new SignJWT({
    sid: input.sessionId,
    client_id: input.clientId,
    scope: formatScopeClaim(scopes),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: ring.current.kid })
    .setSubject(input.userId)
    .setIssuer(options.issuer)
    .setAudience(options.resource)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + options.ttlSeconds)
    .setJti(randomToken(16))
    .sign(ring.current.key);
}

/**
 * 按 `kid` 选候选密钥（与 Desktop 的 `verifyAccessToken` 同一策略）。
 *
 * 没有 `kid` 时依次尝试 current → previous：那是轮换期的向前兼容。
 * **有不认识的 `kid` 时直接失败**，绝不「回退到 current 试一试」——
 * 那会让轮换期的旧 token 与伪造 token 表现得一样。
 */
function keyCandidates(ring: JwtKeyRing, kid: string | undefined) {
  if (kid) {
    if (kid === ring.current.kid) return [ring.current];
    if (ring.previous && kid === ring.previous.kid) return [ring.previous];
    return [];
  }
  return ring.previous ? [ring.current, ring.previous] : [ring.current];
}

function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpTokenError(`missing or invalid ${name} claim`);
  }
  return value;
}

export async function verifyMcpAccessToken(
  ring: JwtKeyRing,
  token: string,
  options: {
    issuer: string;
    resource: string;
    /** 时钟容差（秒）。与 Desktop 的 5 秒一致。 */
    clockToleranceSeconds?: number | undefined;
  },
): Promise<McpAccessClaims> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new McpTokenError("malformed token header");
  }
  // 算法必须**恰好**是 HS256。`jwtVerify` 的 `algorithms` 已经拦了 `none`
  // 与 RS256，这里再判一次是因为 header 是攻击者可控的第一块数据。
  if (header.alg !== "HS256") {
    throw new McpTokenError("unsupported token algorithm");
  }

  const candidates = keyCandidates(ring, header.kid);
  let lastError: unknown = new McpTokenError("no matching signing key");

  for (const candidate of candidates) {
    try {
      const { payload } = await jwtVerify(token, candidate.key, {
        issuer: options.issuer,
        // `audience` 由 jose 强制执行：Desktop 的 token（aud=brewphase-desktop）
        // 会在这里直接失败——这就是双向隔离的落点。
        audience: options.resource,
        algorithms: ["HS256"],
        clockTolerance: options.clockToleranceSeconds ?? 5,
      });

      const userId = assertNonEmptyString(payload.sub, "sub");
      const sessionId = assertNonEmptyString(payload.sid, "sid");
      const clientId = assertNonEmptyString(payload.client_id, "client_id");
      const jti = assertNonEmptyString(payload.jti, "jti");
      if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
        throw new McpTokenError("missing or invalid iat/exp claim");
      }
      if (typeof payload.scope !== "string") {
        throw new McpTokenError("missing or invalid scope claim");
      }
      const scope = parseScopeClaim(payload.scope);
      if (scope === null) {
        throw new McpTokenError("scope claim is empty or contains an unknown scope");
      }

      return {
        userId,
        sessionId,
        clientId,
        jti,
        scope,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
