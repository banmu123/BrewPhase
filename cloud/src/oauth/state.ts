import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { oauthTransactions } from "../db/schema.js";
import { sha256Hex, randomToken } from "../security/crypto.js";
import type { ProviderName } from "../users/identity-service.js";

/**
 * OAuth Transaction：一次授权流程的短期状态。
 *
 * 双 State 设计（完全独立，绝不混用）：
 * - Client State：Desktop 生成并本地校验；Cloud 只存哈希，用于防篡改校验。
 * - Provider State：Cloud 生成并在这里校验；只存哈希。
 *
 * 明文回传问题：Cloud 在最终重定向时必须把「原始 Client State」原样回传给
 * Desktop（否则 Desktop 无法比对）。为满足「数据库只存 State 哈希」，Client
 * State 明文通过 Provider 的 state 参数透传：provider_state = PR + "." + CS
 * （base64url 字母表不含 "."，按第一个 "." 切分安全）。Provider 原样回显 state，
 * Cloud 用哈希校验 PR 有效性、用哈希校验 CS 未被篡改，再把 CS 原样回传。
 */

export const CLIENT_STATE_PATTERN = /^[A-Za-z0-9\-_]{32,128}$/;

export interface CreatedTransaction {
  transactionId: string;
  /** 发给 Provider 的 state：PR.CS */
  combinedProviderState: string;
  /** 发给 Google 的明文 nonce（只在 authorize URL 中出现一次，库中仅存哈希） */
  nonce: string | undefined;
}

export interface CreateTransactionInput {
  provider: ProviderName;
  clientState: string;
  codeChallenge: string;
  redirectUri: string;
  ttlSeconds: number;
}

export async function createOauthTransaction(
  db: Database,
  input: CreateTransactionInput,
): Promise<CreatedTransaction> {
  const providerState = randomToken(32);
  const nonce = input.provider === "google" ? randomToken(32) : undefined;
  const now = new Date();
  const inserted = await db
    .insert(oauthTransactions)
    .values({
      provider: input.provider,
      clientStateHash: sha256Hex(input.clientState),
      providerStateHash: sha256Hex(providerState),
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      nonceHash: nonce ? sha256Hex(nonce) : "",
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
    })
    .returning({ id: oauthTransactions.id });
  const row = inserted[0];
  if (!row) throw new Error("failed to create oauth transaction");
  return {
    transactionId: row.id,
    combinedProviderState: `${providerState}.${input.clientState}`,
    nonce,
  };
}

export interface ResolvedTransaction {
  id: string;
  provider: string;
  codeChallenge: string;
  redirectUri: string;
  nonceHash: string;
  clientState: string;
}

/**
 * 用 Provider 回显的 state 解析事务。任何失败（未知哈希、provider 不匹配、
 * 过期、client state 被篡改）都返回 null，并尽量删除已落库的事务行。
 */
export async function resolveTransactionByProviderState(
  db: Database,
  provider: ProviderName,
  combinedState: string,
): Promise<ResolvedTransaction | undefined> {
  const dotIndex = combinedState.indexOf(".");
  if (dotIndex <= 0) return undefined;
  const providerState = combinedState.slice(0, dotIndex);
  const clientState = combinedState.slice(dotIndex + 1);
  if (providerState.length < 32) return undefined;

  const rows = await db
    .select()
    .from(oauthTransactions)
    .where(eq(oauthTransactions.providerStateHash, sha256Hex(providerState)))
    .limit(1);
  const row = rows[0];
  if (!row || row.provider !== provider) return undefined;

  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(oauthTransactions).where(eq(oauthTransactions.id, row.id));
    return undefined;
  }

  // Client State 完整性：Provider 必须原样回显；被篡改即判定事务不可信
  if (sha256Hex(clientState) !== row.clientStateHash) {
    await db.delete(oauthTransactions).where(eq(oauthTransactions.id, row.id));
    return undefined;
  }

  return {
    id: row.id,
    provider: row.provider,
    codeChallenge: row.codeChallenge,
    redirectUri: row.redirectUri,
    nonceHash: row.nonceHash,
    clientState,
  };
}

export async function deleteTransaction(db: Database, transactionId: string): Promise<void> {
  await db.delete(oauthTransactions).where(eq(oauthTransactions.id, transactionId));
}
