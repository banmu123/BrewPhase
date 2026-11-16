import { serverError } from "../security/errors.js";
import type { ProviderAdapter, ProviderIdentity } from "./provider.js";

/**
 * GitHub OAuth Authorization Code Flow（服务端）。
 *
 * 与 Google 的关键差异（按官方文档实现，不做统一假设）：
 * - 没有 OIDC ID Token；用 Client Secret 在服务端换 access_token 后调用
 *   GET /user 获取资料，provider_subject 用 GitHub 数字用户 ID；
 * - 不申请任何 repo 权限（scope 留空 = 只读公开资料）；
 * - 邮箱可能隐藏/为空，email 不作必填身份字段，email_verified 恒为 false
 *   （公开资料邮箱不视为已验证）；
 * - access_token 只存在于 Cloud 内存中用于取资料，绝不返回给 Desktop。
 */

export interface GithubProviderConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  apiBase: string;
}

interface GithubUserProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
}

export function createGithubProvider(
  config: GithubProviderConfig,
  fetchImpl: typeof fetch = fetch,
): ProviderAdapter {
  const fetchWithTimeout: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(10_000) });

  return {
    name: "github",

    buildAuthorizeUrl({ cloudRedirectUri, combinedState }) {
      const url = new URL(config.authUrl);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", cloudRedirectUri);
      url.searchParams.set("state", combinedState);
      // 不设置 scope：GitHub 默认只读公开资料（无仓库权限）
      return url.toString();
    },

    async exchangeAndVerify({ code, cloudRedirectUri }) {
      const tokenResp = await fetchWithTimeout(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: cloudRedirectUri,
        }),
      });
      if (!tokenResp.ok) {
        throw serverError("GitHub token endpoint rejected the authorization code");
      }
      const tokenData = (await tokenResp.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      const accessToken = tokenData.access_token;
      if (!accessToken) {
        throw serverError("GitHub did not return an access token");
      }

      const userResp = await fetchWithTimeout(`${config.apiBase}/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "BrewPhase-Cloud",
        },
      });
      if (!userResp.ok) {
        throw serverError("GitHub user API request failed");
      }
      const profile = (await userResp.json()) as GithubUserProfile;
      if (typeof profile.id !== "number" || !Number.isInteger(profile.id)) {
        throw serverError("GitHub profile is missing numeric id");
      }

      const identity: ProviderIdentity = {
        subject: String(profile.id),
        email: typeof profile.email === "string" && profile.email.length > 0
          ? profile.email
          : null,
        emailVerified: false,
        displayName: typeof profile.name === "string" && profile.name ? profile.name : profile.login,
        avatarUrl: typeof profile.avatar_url === "string" && profile.avatar_url
          ? profile.avatar_url
          : null,
      };
      return identity;
    },
  };
}
