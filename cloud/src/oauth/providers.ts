import type { Env } from "../env.js";
import { createGithubProvider } from "./github.js";
import { createGoogleProvider } from "./google.js";
import type { ProviderAdapter, ProviderIdentity } from "./provider.js";

export type { ProviderAdapter, ProviderIdentity };
export type { BuildAuthorizeUrlParams, ExchangeAndVerifyParams } from "./provider.js";

export type ProviderName = "google" | "github";

export const PROVIDER_NAMES: readonly ProviderName[] = ["google", "github"];

export function isProviderName(value: string): value is ProviderName {
  return value === "google" || value === "github";
}

/** provider → 适配器。凭据未配置的 provider 不注册（dev 环境允许部分启用）。 */
export type ProviderMap = Partial<Record<ProviderName, ProviderAdapter>>;

export function createProviders(env: Env, fetchImpl: typeof fetch = fetch): ProviderMap {
  const map: ProviderMap = {};
  if (env.googleClientId && env.googleClientSecret) {
    map.google = createGoogleProvider(
      {
        clientId: env.googleClientId,
        clientSecret: env.googleClientSecret,
        authUrl: env.googleAuthUrl,
        tokenUrl: env.googleTokenUrl,
        jwksUrl: env.googleJwksUrl,
        issuer: env.googleIssuer,
      },
      fetchImpl,
    );
  }
  if (env.githubClientId && env.githubClientSecret) {
    map.github = createGithubProvider(
      {
        clientId: env.githubClientId,
        clientSecret: env.githubClientSecret,
        authUrl: env.githubAuthUrl,
        tokenUrl: env.githubTokenUrl,
        apiBase: env.githubApiBase,
      },
      fetchImpl,
    );
  }
  return map;
}
