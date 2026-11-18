import type { ProviderName } from "../oauth/providers.js";

/**
 * 登录选择页（Phase 1.3.1-C2a）。
 *
 * 三个刻意的约束：
 *
 * 1. **没有 JavaScript**。整页只有链接与表单，因此不存在 XSS 的可执行面，
 *    也没有 toPhishing 的脚本注入点。
 * 2. **没有外部资源**。不引 CDN、不引字体、不引图标——一个授权页去拉第三方
 *    资源，等于把「用户在哪个 MCP 服务上授权」这件事告诉第三方。
 * 3. **所有动态内容都转义**。`escapeHtml` 是唯一的插值通道。
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

const PROVIDER_LABELS: Record<ProviderName, string> = {
  google: "Google",
  github: "GitHub",
};

/**
 * 授权页的响应头。
 *
 * - `no-store`：授权页不能被任何缓存留存（它带着 `rid`）；
 * - `no-referrer`：跳去 Provider 时不把 `rid` 放进 Referer；
 * - `DENY`：不允许被第三方站点 iframe（点击劫持）；
 * - CSP：只允许同源样式与表单，`default-src 'none'` 让任何意外注入都失效。
 */
export const AUTH_PAGE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

/**
 * 页面外壳（登录页与同意页共用）。
 *
 * 共用同一个 `<style>` 与同一套响应头，是为了让两个页面在视觉上属于同一次
 * 流程；更重要的是，**只有一处**定义 CSP 与安全头，就不会出现「登录页加了
 * `X-Frame-Options`、同意页忘了加」这种漂移。
 */
export function renderAuthPage(title: string, body: string, extraCss = ""): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 2rem 1rem; min-height: 100vh;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f5f2ee; color: #241c17;
    display: flex; align-items: flex-start; justify-content: center;
  }
  main { width: 100%; max-width: 26rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .35rem; }
  p.sub { margin: 0 0 1.5rem; color: #6b5f56; font-size: .875rem; }
  ul.providers { list-style: none; margin: 0; padding: 0; display: grid; gap: .65rem; }
  ul.providers a {
    display: block; padding: .8rem 1rem; border-radius: .6rem;
    background: #fff; color: inherit; text-decoration: none;
    border: 1px solid #ddd3c9; font-weight: 600;
  }
  ul.providers a:hover { border-color: #a8907c; }
  .notice {
    padding: .8rem 1rem; border-radius: .6rem; background: #fff4e5;
    border: 1px solid #e8c79a; font-size: .875rem;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #17120f; color: #f0e8e1; }
    p.sub { color: #a89b90; }
    ul.providers a { background: #221b16; border-color: #3a2f27; }
    .notice { background: #2d2213; border-color: #4d3a1d; }
  }
${extraCss}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export interface LoginPageInput {
  rid: string;
  /** 同意页要展示的客户端名（已由调用方从库里取出）。 */
  clientName: string;
  availableProviders: readonly ProviderName[];
}

/**
 * 渲染 Provider 选择页。
 *
 * `rid` 会出现在链接里，但它不是凭据：真正决定「谁能继续」的是浏览器
 * Cookie 的绑定。所以即使 `rid` 被旁观者看到，也打不开下一步。
 */
export function renderLoginPage(input: LoginPageInput): string {
  const safeClient = escapeHtml(input.clientName);
  const safeRid = encodeURIComponent(input.rid);

  const heading = `<h1>使用 ${safeClient} 连接 BrewPhase</h1>`;

  if (input.availableProviders.length === 0) {
    return renderAuthPage(
      "登录方式不可用",
      `${heading}
<p class="sub">此服务未配置任何可用的登录方式。</p>
<div class="notice">当前无法完成授权。请联系 BrewPhase 服务的管理员配置 Google 或 GitHub 登录。</div>`,
    );
  }

  const items = input.availableProviders
    .map(
      (provider) =>
        `<li><a href="/mcp/oauth/login?rid=${safeRid}&amp;provider=${encodeURIComponent(provider)}">使用 ${escapeHtml(
          PROVIDER_LABELS[provider] ?? provider,
        )} 继续</a></li>`,
    )
    .join("\n");

  return renderAuthPage(
    "登录 BrewPhase",
    `${heading}
<p class="sub">继续前需要确认你的 BrewPhase 账号。授权完成后可以选择这个应用可以读取哪些数据。</p>
<ul class="providers">
${items}
</ul>`,
  );
}

/** 通用错误页（不带任何回跳链接：出错时没有可信的 redirect_uri）。 */
export function renderErrorPage(title: string, message: string): string {
  return renderAuthPage(
    title,
    `<h1>${escapeHtml(title)}</h1>
<div class="notice">${escapeHtml(message)}</div>`,
  );
}
