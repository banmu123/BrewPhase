import {
  isValidLocalCallbackUri,
} from "../security/crypto.js";
import { invalidRequest, unsupportedProvider } from "../security/errors.js";
import { CLIENT_STATE_PATTERN } from "./state.js";

/**
 * /oauth/authorize 入口校验。这里是整个授权流程的唯一入口：
 * - provider 只允许 google / github；
 * - client state 必须是 32–128 位 base64url 随机值（Desktop 生成 256 bit）；
 * - PKCE 只接受 S256（challenge = base64url(SHA256(verifier))，固定 43 字符）；
 * - redirect_uri 严格限定 http://127.0.0.1:<port>/callback。
 * 校验失败一律 400 JSON（此时没有任何可信 redirect_uri，不允许重定向）。
 */

const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/;

export interface AuthorizeInput {
  provider: "google" | "github";
  clientState: string;
  codeChallenge: string;
  redirectUri: string;
}

export function validateAuthorizeInput(query: {
  provider?: string;
  state?: string;
  code_challenge?: string;
  redirect_uri?: string;
}): AuthorizeInput {
  const provider = query.provider;
  if (provider !== "google" && provider !== "github") {
    throw unsupportedProvider(provider ?? "(missing)");
  }

  const clientState = query.state;
  if (!clientState || !CLIENT_STATE_PATTERN.test(clientState)) {
    throw invalidRequest("state must be a 32-128 character base64url random value");
  }

  const codeChallenge = query.code_challenge;
  if (!codeChallenge || !S256_CHALLENGE_PATTERN.test(codeChallenge)) {
    throw invalidRequest("code_challenge must be a 43-character S256 base64url value");
  }

  const redirectUri = query.redirect_uri;
  if (!redirectUri || !isValidLocalCallbackUri(redirectUri)) {
    throw invalidRequest("redirect_uri must be http://127.0.0.1:<port>/callback");
  }

  return { provider, clientState, codeChallenge, redirectUri };
}
