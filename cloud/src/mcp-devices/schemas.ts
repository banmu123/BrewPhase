import { z } from "zod";

/**
 * Remote MCP 设备的请求/响应契约（协议 §3.2–§3.5）。
 *
 * 校验只放在这一处：路由层不写第二套长度/正则判断，否则「文档说 A、
 * 代码校验 B」这类分歧迟早出现。
 */

/** 裸 32 字节 Ed25519 公钥的 base64url：43 字符，无填充。 */
const RAW_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

export const registerDeviceSchema = z.object({
  name: z.string().min(1).max(80),
  platform: z.string().min(1).max(32),
  public_key: z.string().regex(RAW_PUBLIC_KEY),
  app_version: z.string().min(1).max(64),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const confirmDeviceSchema = z.object({
  confirm_code: z.string().regex(/^\d{6}$/),
});

/**
 * 领取请求体。
 *
 * `claim_secret` **只允许出现在这里**——不放 URL、不放进 header 名、不放 cookie。
 * 所以这个 schema 只接受 body 传入，路由层不从 query 读取任何东西。
 */
export const claimCredentialsSchema = z.object({
  claim_secret: z.string().min(16).max(128),
});

/** 设备列表 DTO：**逐字段白名单**，绝不把 ORM 行直接返回。 */
export interface DeviceSummary {
  id: string;
  name: string;
  platform: string;
  status: string;
  public_key: string;
  grant_epoch: number;
  created_at: string;
  token_issued_at: string | null;
  token_expires_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

/**
 * 对外 DTO 的唯一构造点。
 *
 * 刻意**不用** `{...row, tokenHash: undefined}` 之类的写法：漏掉一个字段
 * 就等于泄漏一次 `token_hash` / `confirm_code_hash` / `claim_secret_hash`。
 * 这里是白名单，新增列默认不出现。
 */
export function toDeviceSummary(row: {
  id: string;
  name: string;
  platform: string;
  status: string;
  publicKey: string;
  grantEpoch: number;
  createdAt: Date;
  tokenIssuedAt: Date | null;
  tokenExpiresAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}): DeviceSummary {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    status: row.status,
    public_key: row.publicKey,
    grant_epoch: row.grantEpoch,
    created_at: row.createdAt.toISOString(),
    token_issued_at: row.tokenIssuedAt?.toISOString() ?? null,
    token_expires_at: row.tokenExpiresAt?.toISOString() ?? null,
    last_seen_at: row.lastSeenAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
  };
}

/** `public_key` 解码后是否恰好 32 字节（正则只保证字符集，不保证解码长度）。 */
export function rawPublicKeyByteLength(base64url: string): number {
  return Buffer.from(base64url, "base64url").length;
}
