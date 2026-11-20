import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * 统一错误模型。业务代码只抛 AppError，由 app.ts 的 onError 统一序列化为：
 *   { "error": "<oauth-style code>", "error_description": "..." }
 * 生产环境不回传内部细节与堆栈。
 */

export type ErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_client"
  | "unauthorized_client"
  | "invalid_scope"
  | "unsupported_grant_type"
  | "unsupported_token_type"
  | "invalid_token"
  | "unsupported_provider"
  | "provider_not_configured"
  | "access_denied"
  | "account_suspended"
  | "rate_limited"
  | "server_error"
  // ---- Remote MCP 设备管理（Phase 1.2A，协议 §3.2–§3.5）----
  | "invalid_public_key"
  | "device_limit"
  | "device_exists"
  | "device_not_found"
  | "already_active"
  | "confirm_expired"
  | "invalid_confirm_code"
  | "claim_mismatch"
  | "credentials_already_issued"
  | "invalid_device_state"
  /**
   * device_token 认证失败（不存在 / 未领取 / 已过期 / 形态不符）。
   *
   * 与 `invalid_token`（用户 access token）分开：两条凭据域物理分离，
   * 合成一个码会让「Desktop 拿用户 token 去连 WSS」这类错误看起来像
   * 「登录过期」，排障方向从一开始就是错的。
   */
  | "device_unauthorized";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** 是否允许把 description 暴露给客户端（默认允许，描述均写成非敏感文案）。 */
  readonly expose: boolean;
  /** 附加安全事件信息（仅服务端日志/审计用）。 */
  readonly meta?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    status: number,
    description: string,
    options?: { expose?: boolean; meta?: Record<string, unknown>; cause?: unknown },
  ) {
    super(description, { cause: options?.cause });
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.expose = options?.expose ?? true;
    this.meta = options?.meta;
  }
}

export const invalidRequest = (description: string, meta?: Record<string, unknown>) =>
  new AppError("invalid_request", 400, description, { meta });

export const invalidGrant = (description: string, meta?: Record<string, unknown>) =>
  new AppError("invalid_grant", 400, description, { meta });

/**
 * 客户端身份不成立（Phase 1.3.1-C3a）。
 *
 * 本服务只有公共客户端（`token_endpoint_auth_method = none`），所以这里
 * **不是**「client_secret 错了」，而是「这次请求声称的 client 与凭据归属
 * 的 client 不是同一个」。401 而不是 400：语义上属于认证/绑定失败，
 * 且 OAuth 2.1 的 `invalid_client` 就是 401。
 */
export const invalidClient = (description = "client is not valid") =>
  new AppError("invalid_client", 401, description);

/**
 * 客户端**没有被授权使用**这个授权方式（Phase 1.3.1-C3c-3B-3，设计 §8.4）。
 *
 * 与 `invalid_client` 分开：后者是「身份不成立」（行不存在 / 绑定不符），
 * 这里是「身份成立，但注册的 `grant_types` 不含所请求的那一种」——RFC 6749
 * §5.2 的 `unauthorized_client`。400 而不是 401：请求格式没问题，是授权范围
 * 不允许（同 `invalid_scope` 的取向）。
 */
export const unauthorizedClient = (description = "client is not authorized to use this grant type") =>
  new AppError("unauthorized_client", 400, description);

/**
 * 请求的 scope 超出已有授权（Phase 1.3.1-C3a）。
 *
 * 与 `invalid_request` 分开：它能让客户端知道「参数语法没问题，是权限范围
 * 越界了」，从而正确地降级重试，而不是去改请求格式。
 */
export const invalidScope = (description = "requested scope exceeds the authorization") =>
  new AppError("invalid_scope", 400, description);

/** 未实现的 Grant（Phase 1.3.1-C3a）。文案只列已支持的两个取值。 */
export const unsupportedGrantType = () =>
  new AppError(
    "unsupported_grant_type",
    400,
    "grant_type must be authorization_code or refresh_token",
  );

/**
 * Token 是真的，但本端点不支持按这个类型撤销（Phase 1.3.1-C3b）。
 *
 * RFC 7009 §2.2.1 为这种情况定义了 `unsupported_token_type`，HTTP 400。
 * 它与「无效 Token」是两回事：后者必须回 200（否则端点变成存在性探针），
 * 而这里客户端需要知道「换一种凭据再试」——本项目的撤销单位是 Session，
 * 对应的凭据是 Refresh Token。
 */
export const unsupportedTokenType = () =>
  new AppError(
    "unsupported_token_type",
    400,
    "only refresh tokens can be revoked at this endpoint",
  );

export const invalidToken = (description = "Invalid or expired access token") =>
  new AppError("invalid_token", 401, description);

export const unsupportedProvider = (provider: string) =>
  new AppError("unsupported_provider", 400, `Unsupported provider: ${provider}`);

export const providerNotConfigured = (provider: string) =>
  new AppError("provider_not_configured", 400, `Provider ${provider} is not configured`);

export const accountSuspended = () =>
  new AppError("account_suspended", 403, "This account cannot sign in");

export const rateLimited = (retryAfterSeconds: number) =>
  new AppError("rate_limited", 429, "Too many requests, slow down", {
    meta: { retryAfterSeconds },
  });

export const serverError = (description = "Internal server error") =>
  new AppError("server_error", 500, description, { expose: false });

// ---- Remote MCP 设备管理 ----
//
// 所有 description 都是**固定文案**：不含请求体、不含任何 secret 片段、
// 不拼接用户输入。这样即使某天这些错误被原样回显，也不会成为泄漏通道。

export const invalidPublicKey = () =>
  new AppError("invalid_public_key", 400, "public_key must be base64url of 32 bytes");

export const deviceLimitReached = () =>
  new AppError("device_limit", 429, "too many devices for this account");

export const deviceExists = () =>
  new AppError("device_exists", 409, "this device is already registered");

/**
 * 「不存在」与「不是你的」返回**同一个** 404。
 *
 * 分开会把设备 id 变成一条存在性探针：攻击者持任意账号即可枚举别人的
 * 设备 id（uuid 虽难猜，但一旦从别处泄漏就能确认归属）。
 */
export const deviceNotFound = () => new AppError("device_not_found", 404, "device not found");

export const alreadyActive = () => new AppError("already_active", 409, "device is already active");

export const confirmExpired = () =>
  new AppError("confirm_expired", 410, "confirmation window has expired");

export const invalidConfirmCode = () =>
  new AppError("invalid_confirm_code", 400, "invalid confirmation code");

/** 固定文案：不回显 claim_secret，也不区分「格式不对」与「值不对」。 */
export const claimMismatch = () => new AppError("claim_mismatch", 403, "claim rejected");

export const credentialsAlreadyIssued = () =>
  new AppError("credentials_already_issued", 409, "credentials were already issued");

/**
 * 状态机不允许的转换（撤销后 resume、重复 suspend 等）。
 *
 * 用 409 而不是 400：请求本身合法，只是与当前状态冲突。
 */
export const invalidDeviceState = (description: string) =>
  new AppError("invalid_device_state", 409, description);

/**
 * device_token 认证失败。**固定文案**，不区分四种原因：
 * token 不存在 / 从未领取 / 已过期 / 形态不符。
 *
 * 区分会给出两条探针：「这个 token 存在吗」（404 vs 401）与
 * 「它是不是刚过期」（不同的 description）。前者能枚举已领取的 token 形态，
 * 后者能告诉攻击者「再等一会就轮换窗口了」。
 */
export const deviceUnauthorized = () =>
  new AppError("device_unauthorized", 401, "device credentials rejected");

export interface ErrorBody {
  error: ErrorCode;
  error_description?: string;
}

export function serializeError(err: unknown, isProduction: boolean): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        error: err.code,
        error_description: err.expose ? err.message : undefined,
      },
    };
  }
  if (!isProduction && err instanceof Error) {
    // 开发环境保留可诊断信息，但仍不序列化堆栈到响应体。
    return { status: 500, body: { error: "server_error", error_description: err.message } };
  }
  return { status: 500, body: { error: "server_error" } };
}

/** 供 onError 使用：统一响应 + Retry-After 头。 */
export function respondError(c: Context, err: unknown, isProduction: boolean): Response {
  const { status, body } = serializeError(err, isProduction);
  const headers: Record<string, string> = {};
  if (err instanceof AppError && err.code === "rate_limited" && err.meta) {
    const retry = (err.meta as { retryAfterSeconds?: number }).retryAfterSeconds;
    if (typeof retry === "number") headers["Retry-After"] = String(Math.ceil(retry));
  }
  return c.json(body, status as ContentfulStatusCode, headers);
}
