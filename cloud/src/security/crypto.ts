import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 生成高强度随机值（base64url，无填充）。bytes=32 → 256 bit 熵。 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 带域分隔 + 服务端 pepper 的哈希，用于 refresh token 与 IP 的最小化存储。 */
export function pepperedSha256Hex(pepper: string, domain: string, value: string): string {
  return createHash("sha256")
    .update(`${domain}:${pepper}:${value}`, "utf8")
    .digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // 长度不同也要消耗一次比较，避免提前返回的时序信号。
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// ---------- PKCE (RFC 7636, S256) ----------

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidPkceVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}

/** BASE64URL-ENCODE(SHA256(ASCII(code_verifier))) */
export function pkceChallengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function verifyPkce(verifier: string, expectedChallenge: string): boolean {
  if (!isValidPkceVerifier(verifier)) return false;
  return constantTimeEqual(pkceChallengeFromVerifier(verifier), expectedChallenge);
}

// ---------- redirect_uri 白名单 ----------

/**
 * 只允许 Desktop 的本机回调形态：http://127.0.0.1:<port>/callback
 * 严格拒绝任意域名、公网 IP、localhost 变体、带查询/片段/userinfo 的 URL。
 */
const LOCAL_CALLBACK_PATTERN = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/callback$/;

export function isValidLocalCallbackUri(redirectUri: string): boolean {
  const m = LOCAL_CALLBACK_PATTERN.exec(redirectUri);
  if (!m) return false;
  const port = Number(m[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// ---------- IP 最小化记录 ----------

export function hashIp(pepper: string, ip: string): string {
  if (!ip) return "";
  return pepperedSha256Hex(pepper, "ip", ip);
}
