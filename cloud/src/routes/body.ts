import type { Context } from "hono";
import { z } from "zod";
import { clientIp } from "../security/rate-limit.js";
import { hashIp } from "../security/crypto.js";
import { invalidRequest } from "../security/errors.js";
import type { SessionMeta } from "../sessions/session-service.js";
import type { Env } from "../env.js";

/**
 * 请求体解析：同时接受 JSON 与 form-urlencoded（OAuth 习惯）。
 * 只提取字符串字段，未知/非字符串字段忽略，由各端点的 zod schema 收口。
 */
export async function readStringFields(c: Context): Promise<Record<string, string>> {
  const contentType = c.req.header("content-type") ?? "";
  let raw: unknown = null;

  if (contentType.includes("application/json")) {
    raw = await c.req.json().catch(() => null);
  } else if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const parsed = await c.req.parseBody().catch(() => null);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    }
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidRequest("request body must be a JSON object or form-encoded fields");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * 请求体解析：**保留字段类型**，只用于含数字字段的端点（如 rotate 的 `ts`）。
 *
 * 为什么不能复用 `readStringFields`：它按「OAuth 表单习惯」只收字符串，
 * 于是 `{"ts": 1763400000000}` 里的 ts 会被丢掉，schema 随即报「缺字段」。
 * 那会把一个类型正确的请求判成畸形请求——而错误码会说 `invalid_request`，
 * 完全指错方向。
 *
 * 与 `readStringFields` 共享同一条纪律：**不记录任何 body 内容**。
 */
export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw invalidRequest("request body must be JSON");
  }
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidRequest("request body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

export function sessionMetaFromRequest(c: Context, env: Env): SessionMeta {
  const ip = clientIp(c, env.trustProxy, env.trustProxyHops);
  return {
    userAgent: c.req.header("user-agent") ?? "",
    ipHash: hashIp(env.sessionTokenPepper, ip),
  };
}

export const tokenRequestSchema = z.object({
  code: z.string().min(1).max(512),
  code_verifier: z.string().min(43).max(128),
  redirect_uri: z.string().min(1).max(512),
});

export const refreshTokenSchema = z.object({
  refresh_token: z.string().min(16).max(256),
});

/** 请求参数校验失败 → 400 invalid_request（而不是泄漏 zod 细节的 500）。 */
export function parseOr400<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw invalidRequest("malformed request parameters");
  }
  return result.data;
}
