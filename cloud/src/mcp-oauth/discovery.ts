import type { Env } from "../env.js";
import { MCP_SCOPES, mcpResourceFor } from "./constants.js";

/**
 * OAuth Discovery 元数据（Phase 1.3.1-C3c-1）。
 *
 * 两份文档，字段**只描述当前已经实现的能力**：
 *
 * - RFC 9728 Protected Resource Metadata（PRM）：告诉客户端「这个资源要什么
 *   凭据、由谁签发」；
 * - RFC 8414 Authorization Server Metadata：告诉客户端「去哪里授权、换 token、
 *   撤销 token」。
 *
 * ## 为什么不声明 DCR / CIMD
 *
 * 元数据是**承诺**。`registration_endpoint` 一旦出现，客户端就会去 POST 注册；
 * `client_id_metadata_document_supported: true` 一旦出现，客户端就会把
 * `client_id` 写成一个 HTTPS URL 让服务端去抓。两者当前都没有实现——
 * 声明它们等于把一个 404 变成一个「看起来能用、实际上失败」的授权流程。
 *
 * 同理不声明 `introspection_endpoint` / `userinfo_endpoint` / `jwks_uri`
 * （HS256，没有 JWKS）。
 *
 * ## 字段来源
 *
 * 全部从 `env.baseUrl` 推导，不硬编码任何主机名：
 * `issuer`、`resource`、三个 endpoint 都必须与 JWT 的 `iss`、`aud` 逐字符一致。
 */

/** 端点路径。与 `routeMcpOAuth()` 里注册的路径**必须**一致（有测试钉住）。 */
const AUTHORIZE_PATH = "/mcp/oauth/authorize";
const TOKEN_PATH = "/mcp/oauth/token";
const REVOKE_PATH = "/mcp/oauth/revoke";

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  authorization_response_iss_parameter_supported: boolean;
}

export function buildProtectedResourceMetadata(
  env: Pick<Env, "baseUrl">,
): ProtectedResourceMetadata {
  return {
    // 资源就是 MCP 端点本身，不是站点根。访问 `/.well-known/oauth-protected-resource`
    // （根形式）时也必须是这个值——RFC 9728 的路径插入只是查找方式，不改变资源身份。
    resource: mcpResourceFor(env.baseUrl),
    authorization_servers: [env.baseUrl],
    // 与 Token Endpoint 接受的 scope 同源（`MCP_SCOPES`），避免两处各自维护。
    scopes_supported: [...MCP_SCOPES],
    // 只支持 `Authorization: Bearer`。**不声明** `body` / `query`：
    // 撤销端点已明确拒绝 Query 里的 token，元数据不能反过来说 Query 可用。
    bearer_methods_supported: ["header"],
  };
}

export function buildAuthorizationServerMetadata(
  env: Pick<Env, "baseUrl">,
): AuthorizationServerMetadata {
  return {
    // 与 JWT 的 `iss`、授权响应里的 `iss` 参数逐字符相同（env 启动时已校验形态）。
    issuer: env.baseUrl,
    authorization_endpoint: `${env.baseUrl}${AUTHORIZE_PATH}`,
    token_endpoint: `${env.baseUrl}${TOKEN_PATH}`,
    revocation_endpoint: `${env.baseUrl}${REVOKE_PATH}`,
    scopes_supported: [...MCP_SCOPES],
    // 只有授权码流程；没有 implicit / hybrid。
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Public Client：没有 client_secret，也没有 HTTP Basic。
    token_endpoint_auth_methods_supported: ["none"],
    // PKCE 强制 S256（`plain` 未实现）。
    code_challenge_methods_supported: ["S256"],
    // RFC 9207：成功与错误的授权响应都带 `iss`（有回归测试）。
    authorization_response_iss_parameter_supported: true,
  };
}
