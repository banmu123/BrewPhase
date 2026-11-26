import { SignJWT, decodeProtectedHeader, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { randomToken } from "../security/crypto.js";

/**
 * BrewPhase Access Token（JWT / HS256）。
 *
 * - 明确固定签名算法 HS256，拒绝其他算法（含 none）；
 * - Header 带 kid，支持签名密钥轮换：签发永远用 current，验证按 kid 选 key，
 *   无 kid 时依次尝试 current → previous（向前兼容旧 Token）；
 * - claims: sub(user_id) / sid(session_id) / iss / aud / iat / exp / jti；
 * - 绝不把第三方 Provider Token 或任何敏感内容放进 JWT。
 */

export const TOKEN_AUDIENCE = "brewphase-desktop";

interface KeyEntry {
  kid: string;
  key: Uint8Array;
}

export interface JwtKeyRing {
  current: KeyEntry;
  previous: KeyEntry | undefined;
}

function toKeyEntry(secret: string): KeyEntry {
  return {
    kid: createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 8),
    key: new TextEncoder().encode(secret),
  };
}

export function createKeyRing(jwtSigningKey: string, jwtSigningKeyPrevious?: string): JwtKeyRing {
  return {
    current: toKeyEntry(jwtSigningKey),
    previous: jwtSigningKeyPrevious ? toKeyEntry(jwtSigningKeyPrevious) : undefined,
  };
}

export interface AccessTokenInput {
  userId: string;
  sessionId: string;
}

export async function signAccessToken(
  ring: JwtKeyRing,
  input: AccessTokenInput,
  options: { issuer: string; ttlSeconds: number },
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    sid: input.sessionId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: ring.current.kid })
    .setSubject(input.userId)
    .setIssuer(options.issuer)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + options.ttlSeconds)
    .setJti(randomToken(16))
    .sign(ring.current.key);
}

export interface AccessClaims {
  userId: string;
  sessionId: string;
  jti: string;
}

function keyCandidates(ring: JwtKeyRing, kid: string | undefined): KeyEntry[] {
  if (kid) {
    if (kid === ring.current.kid) return [ring.current];
    if (ring.previous && kid === ring.previous.kid) return [ring.previous];
    return [];
  }
  return ring.previous ? [ring.current, ring.previous] : [ring.current];
}

export async function verifyAccessToken(
  ring: JwtKeyRing,
  token: string,
  options: { issuer: string },
): Promise<AccessClaims> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new Error("malformed token header");
  }
  const candidates = keyCandidates(ring, header.kid);
  let lastError: unknown = new Error("no matching signing key");
  for (const candidate of candidates) {
    try {
      const { payload } = await jwtVerify(token, candidate.key, {
        issuer: options.issuer,
        audience: TOKEN_AUDIENCE,
        algorithms: ["HS256"],
        clockTolerance: 5,
      });
      const userId = payload.sub;
      const sessionId = payload.sid;
      const jti = payload.jti;
      if (typeof userId !== "string" || typeof sessionId !== "string" || typeof jti !== "string") {
        throw new Error("missing required claims");
      }
      return { userId, sessionId, jti };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
