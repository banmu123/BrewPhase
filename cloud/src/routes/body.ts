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

export function sessionMetaFromRequest(c: Context, env: Env): SessionMeta {
  const ip = clientIp(c, env.trustProxy);
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
