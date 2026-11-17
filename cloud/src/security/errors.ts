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
  | "invalid_token"
  | "unsupported_provider"
  | "provider_not_configured"
  | "access_denied"
  | "account_suspended"
  | "rate_limited"
  | "server_error";

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
