import type { Context } from "hono";
import type { AppContext, AppHono } from "../context.js";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "../mcp-oauth/discovery.js";

/**
 * OAuth Discovery 路由（Phase 1.3.1-C3c-1）。
 *
 * 只在 MCP OAuth **已启用**时注册（`resolveMcpOAuthEnablement()`，见 app.ts）。
 * 未启用时这三条路由根本不存在——不能对外声明一个实际不可用的授权服务器。
 *
 * 三条都是 GET、无认证、无 Cookie、不读数据库、不写审计：
 * - `/.well-known/oauth-protected-resource`（RFC 9728 根形式）
 * - `/.well-known/oauth-protected-resource/mcp`（RFC 9728 路径插入形式）
 * - `/.well-known/oauth-authorization-server`（RFC 8414）
 *
 * 两条 PRM 返回**同一份**文档：路径插入只改变「客户端怎么找到它」，
 * 不改变「资源是什么」。
 */
export function routeMcpDiscovery(app: AppHono, ctx: AppContext): void {
  const prm = (c: Context) => c.json(buildProtectedResourceMetadata(ctx.env));

  app.get("/.well-known/oauth-protected-resource", prm);
  app.get("/.well-known/oauth-protected-resource/mcp", prm);

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(buildAuthorizationServerMetadata(ctx.env)),
  );
}
