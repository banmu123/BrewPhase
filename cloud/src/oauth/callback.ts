import { randomToken, sha256Hex } from "../security/crypto.js";
import { AppError } from "../security/errors.js";
import { recordAuthEvent } from "../db/audit.js";
import type { Database } from "../db/client.js";
import { oauthCodes } from "../db/schema.js";
import { findOrCreateUserWithIdentity } from "../users/user-service.js";
import { isProviderName, type ProviderMap } from "./providers.js";
import { consumeOauthTransaction } from "./state.js";

/**
 * Provider 回调编排：原子消费 Transaction（双 State / Provider / CS 完整性校验）
 * → 交换并验证第三方身份 → 映射/创建 BrewPhase 用户 → 签发一次性授权码 →
 * 重定向回 Desktop 本机回调。
 *
 * 事务在身份交换之前即被原子消费（条件 DELETE RETURNING）：并发重复回调只有
 * 一个请求能进入后续流程，**同一个事务最多签发一条授权码**。消费后任何失败
 * （Provider 交换失败 / 账户不可用 / 非预期异常）都不会复活事务，失败路径用
 * 消费行中已通过 authorize 校验的 redirect_uri 以 OAuth error 重定向。
 *
 * 错误重定向约定：事务无效（state 错误 / 重放 / 已消费 / 过期 / 被篡改 /
 * provider 不匹配）时抛错走统一 JSON 错误页，绝不重定向到任何未知地址
 * （防开放重定向）。
 *
 * Provider Token 的生命周期只在本函数调用栈内：用于换取身份后即被丢弃，
 * 不落库、不返回 Desktop、不打日志。
 */

export interface CallbackDeps {
  db: Database;
  providers: ProviderMap;
  /** Cloud 对外基地址，用于拼 Provider 注册的回调 URL */
  baseUrl: string;
  oauthCodeTtlSeconds: number;
}

export interface CallbackInput {
  provider: string;
  code: string | undefined;
  state: string | undefined;
}

export interface CallbackMeta {
  ipHash: string;
}

export interface CallbackOutcome {
  redirectUrl: string;
}

function buildRedirect(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function handleProviderCallback(
  deps: CallbackDeps,
  input: CallbackInput,
  meta: CallbackMeta,
): Promise<CallbackOutcome> {
  const provider = input.provider;
  if (!isProviderName(provider)) {
    throw new AppError("invalid_grant", 400, "Unknown provider");
  }
  const adapter = deps.providers[provider];
  if (!adapter) {
    throw new AppError("invalid_grant", 400, "Provider is not configured");
  }
  if (!input.state) {
    throw new AppError("invalid_grant", 400, "Missing state parameter");
  }

  // 原子消费：state 错误 / 重放 / 已消费 / 过期 / 被篡改 / provider 不匹配
  // 都在此处被拒绝（400 JSON，不重定向）。成功的请求独占该事务。
  const transaction = await consumeOauthTransaction(deps.db, provider, input.state);
  if (!transaction) {
    await recordAuthEvent(deps.db, {
      eventType: "login_failed",
      provider: provider,
      ipHash: meta.ipHash,
      detail: { reason: "invalid_provider_state" },
    });
    throw new AppError("invalid_grant", 400, "Invalid or expired OAuth state");
  }

  // 事务已被本请求独占；失败路径不再需要清理，只需用消费行里已校验的
  // redirect_uri / client_state 以 OAuth error 重定向回 Desktop。
  const failWithRedirect = (errorCode: string, description: string): CallbackOutcome => ({
    redirectUrl: buildRedirect(transaction.redirectUri, {
      error: errorCode,
      error_description: description,
      state: transaction.clientState,
    }),
  });

  try {
    if (!input.code) {
      await recordAuthEvent(deps.db, {
        eventType: "login_failed",
        provider: provider,
        ipHash: meta.ipHash,
        detail: { reason: "provider_denied" },
      });
      return failWithRedirect("access_denied", "Provider denied the authorization request");
    }

    // Provider 授权码只能在 Cloud 侧使用；换取身份后 Provider Token 随栈帧销毁
    const providerIdentity = await adapter.exchangeAndVerify({
      code: input.code,
      cloudRedirectUri: `${deps.baseUrl}/oauth/callback/${provider}`,
      expectedNonceHash: transaction.nonceHash,
    });

    // 身份映射 / 用户创建 + 一次性授权码签发，同一事务内完成
    const outcome = await deps.db.transaction(async (tx) => {
      const resolved = await findOrCreateUserWithIdentity(tx, {
        provider: provider,
        subject: providerIdentity.subject,
        email: providerIdentity.email,
        emailVerified: providerIdentity.emailVerified,
        displayName: providerIdentity.displayName,
        avatarUrl: providerIdentity.avatarUrl,
      });

      if (resolved.user.status !== "active") {
        throw new AppError("account_suspended", 403, "This account cannot sign in");
      }

      const code = randomToken(32);
      const now = new Date();
      await tx.insert(oauthCodes).values({
        codeHash: sha256Hex(code),
        userId: resolved.user.id,
        transactionId: transaction.id,
        codeChallenge: transaction.codeChallenge,
        redirectUri: transaction.redirectUri,
        expiresAt: new Date(now.getTime() + deps.oauthCodeTtlSeconds * 1000),
      });

      await recordAuthEvent(tx, {
        eventType: "login_success",
        userId: resolved.user.id,
        provider: provider,
        ipHash: meta.ipHash,
        detail: { createdUser: resolved.created, identityId: resolved.identity.id },
      });

      return {
        redirectUrl: buildRedirect(transaction.redirectUri, {
          code,
          state: transaction.clientState,
        }),
      };
    });

    return outcome;
  } catch (err) {
    if (err instanceof AppError) {
      await recordAuthEvent(deps.db, {
        eventType: "login_failed",
        provider: provider,
        ipHash: meta.ipHash,
        detail: { reason: err.code },
      });
      return failWithRedirect(
        err.code === "account_suspended" ? "access_denied" : "server_error",
        err.expose ? err.message : "Provider sign-in failed",
      );
    }
    // 非预期程序错误：不做用户拒绝伪装，事务保持已消费状态，交给 onError 统一 500
    throw err;
  }
}
