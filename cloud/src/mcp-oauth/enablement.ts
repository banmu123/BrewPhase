import type { Env } from "../env.js";
import { MCP_BROWSER_SESSION_KEY_MIN_BYTES } from "./constants.js";

/**
 * MCP 浏览器授权能力的**启用边界**（Phase 1.3.1-C2a）。
 *
 * 这一层要解决的是一个具体矛盾：
 *
 * - 浏览器授权 Cookie 必须有签名密钥，否则不能工作（也不能降级成不签名）；
 * - 但 Cloud 同时服务 Desktop 登录，把密钥设成**进程级必填**会让「只跑
 *   `/oauth/*` 的部署」因为一个尚未启用的能力而起不来——那是把新功能的门禁
 *   变成旧功能的故障。
 *
 * 所以判定放在**能力边界**上：`createApp()` 只在全部检查通过时注册
 * `/mcp/oauth/*` 路由组。密钥不合格 → 那组路由根本不存在（404），
 * 而不是「存在但每次 500」或「存在但用临时密钥」。
 *
 * 三条拒绝理由都必须**不给任何密钥片段**，因为它们会进日志。
 */

export type McpOAuthDisabledReason =
  | "missing_browser_session_key"
  | "browser_session_key_too_short"
  | "browser_session_key_reused_from_jwt";

export type McpOAuthEnablement =
  | { enabled: true }
  | { enabled: false; reason: McpOAuthDisabledReason };

/**
 * 判定 MCP OAuth 路由是否可注册。
 *
 * 检查顺序即日志里的原因优先级：先「有没有」，再「够不够长」，最后
 * 「是不是复用了 JWT 密钥」。
 */
export function resolveMcpOAuthEnablement(env: Env): McpOAuthEnablement {
  const key = env.mcpBrowserSessionKey;
  // 空串归入「未配置」而不是「过短」：`MCP_BROWSER_SESSION_KEY=` 是 .env.example
  // 里的默认形态，把它报成「长度不足」会让运维去数长度，而真正的问题是没填。
  if (!key || key.length === 0) {
    return { enabled: false, reason: "missing_browser_session_key" };
  }

  // 按 UTF-8 **字节**数判，不按字符数：多字节口令的长度不等于它的熵。
  if (Buffer.byteLength(key, "utf8") < MCP_BROWSER_SESSION_KEY_MIN_BYTES) {
    return { enabled: false, reason: "browser_session_key_too_short" };
  }

  // 与 JWT 签名密钥相同 → 拒绝启用（不是拒绝启动）。
  //
  // 为什么必须拒绝：Cookie 签名与 token 签名共用一把密钥，会让「拿到其中一个
  // 的签名输入」变成「能伪造另一个」。这不是理论问题——两者的签名格式都是
  // HMAC-SHA256(base64url)，只靠调用方记得「别混用」是撑不住的。
  if (key === env.jwtSigningKey) {
    return { enabled: false, reason: "browser_session_key_reused_from_jwt" };
  }

  return { enabled: true };
}
