import type { ProviderName } from "../users/identity-service.js";

/**
 * Provider 适配器契约。Google / GitHub 的协议差异全部封装在各自实现里，
 * 回调编排层只依赖这个接口。
 */

export interface ProviderIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
}

export interface BuildAuthorizeUrlParams {
  /** Cloud 暴露给 Provider 的回调地址（注册在 Provider 控制台） */
  cloudRedirectUri: string;
  /** PR.CS 组合 state（对 Provider 完全不透明） */
  combinedState: string;
  /** Google OIDC nonce；GitHub 不使用 */
  nonce?: string | undefined;
}

export interface ExchangeAndVerifyParams {
  /** Provider 回调带来的授权码（只能在 Cloud 侧使用） */
  code: string;
  /** 必须与 authorize 阶段提交给 Provider 的 redirect_uri 完全一致 */
  cloudRedirectUri: string;
  /** Google：事务中存的 nonce 哈希；GitHub 为空串 */
  expectedNonceHash: string;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  buildAuthorizeUrl(params: BuildAuthorizeUrlParams): string;
  /** 交换授权码并验证身份；失败抛 AppError。 */
  exchangeAndVerify(params: ExchangeAndVerifyParams): Promise<ProviderIdentity>;
}
