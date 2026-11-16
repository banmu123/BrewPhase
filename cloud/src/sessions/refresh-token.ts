import { pepperedSha256Hex, randomToken } from "../security/crypto.js";

/**
 * Refresh Token：Opaque、256 bit 以上随机值（base64url 43 字符）。
 * 数据库只存 SHA-256(pepper 域分隔) 哈希；明文只出现在响应与客户端内存。
 */

export function generateRefreshToken(): string {
  return randomToken(32);
}

export function refreshTokenHash(pepper: string, rawToken: string): string {
  return pepperedSha256Hex(pepper, "refresh-token", rawToken);
}

/**
 * 重放宽限窗口：同一 refresh token 在被合法轮换后的极短时间内再次到达
 * （典型场景是客户端并发重试），按「已被轮换」拒绝但不撤销整族，
 * 避免把正常并发请求误判为攻击。超过窗口的重放按重用处理。
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;
