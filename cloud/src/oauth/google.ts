import { jwtVerify, createRemoteJWKSet } from "jose";
import { sha256Hex, constantTimeEqual } from "../security/crypto.js";
import { serverError } from "../security/errors.js";
import type { ProviderAdapter, ProviderIdentity } from "./provider.js";

/**
 * Google OpenID Connect。
 *
 * 权限严格限制为 openid email profile；使用 access_type=online（不向 Google
 * 索取 refresh token，登录后不再持有任何 Provider Token）。
 *
 * ID Token 验证（jose + Google JWKS）：
 * - RS256 签名（远程 JWKS）、issuer、audience、过期时间；
 * - nonce：用事务中保存的 nonce 哈希比对（对 ID Token 的 nonce claim 取哈希后
 *   恒定时间比较，满足「库中只存哈希」的同时完成校验）。
 */

const GOOGLE_SCOPE = "openid email profile";

export interface GoogleProviderConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  issuer: string;
}

export function createGoogleProvider(
  config: GoogleProviderConfig,
  fetchImpl: typeof fetch = fetch,
): ProviderAdapter {
  // 远程 JWKS 在首次验证时懒加载并缓存
  let jwksCache: ReturnType<typeof createRemoteJWKSet> | undefined;

  const jwks = () => {
    jwksCache ??= createRemoteJWKSet(new URL(config.jwksUrl));
    return jwksCache;
  };

  const fetchWithTimeout: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(10_000) });

  return {
    name: "google",

    buildAuthorizeUrl({ cloudRedirectUri, combinedState, nonce }) {
      const url = new URL(config.authUrl);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", cloudRedirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", GOOGLE_SCOPE);
      url.searchParams.set("state", combinedState);
      if (nonce) url.searchParams.set("nonce", nonce);
      url.searchParams.set("access_type", "online");
      return url.toString();
    },

    async exchangeAndVerify({ code, cloudRedirectUri, expectedNonceHash }) {
      const tokenResp = await fetchWithTimeout(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: cloudRedirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenResp.ok) {
        throw serverError("Google token endpoint rejected the authorization code");
      }
      const tokenData = (await tokenResp.json()) as { id_token?: string; error?: string };
      if (!tokenData.id_token) {
        throw serverError("Google did not return an ID token");
      }

      let verified: { sub: unknown; nonce: unknown; email: unknown; email_verified: unknown; name: unknown; picture: unknown };
      try {
        const result = await jwtVerify(tokenData.id_token, jwks(), {
          issuer: config.issuer,
          audience: config.clientId,
          algorithms: ["RS256"],
          clockTolerance: 60,
        });
        verified = result.payload as typeof verified;
      } catch {
        // 签名 / issuer / audience / 过期 任一失败都不能信任该身份
        throw serverError("Google ID token verification failed");
      }

      if (typeof verified.sub !== "string" || verified.sub.length === 0) {
        throw serverError("Google ID token is missing sub claim");
      }

      if (typeof verified.nonce !== "string" || expectedNonceHash.length === 0) {
        throw serverError("Google ID token nonce verification failed");
      }
      if (!constantTimeEqual(sha256Hex(verified.nonce), expectedNonceHash)) {
        throw serverError("Google ID token nonce mismatch");
      }

      const email =
        typeof verified.email === "string" && verified.email.length > 0 ? verified.email : null;
      const emailVerified = verified.email_verified === true;

      const identity: ProviderIdentity = {
        subject: verified.sub,
        email,
        emailVerified,
        displayName: typeof verified.name === "string" ? verified.name : "",
        avatarUrl:
          typeof verified.picture === "string" && verified.picture.length > 0
            ? verified.picture
            : null,
      };
      return identity;
    },
  };
}
