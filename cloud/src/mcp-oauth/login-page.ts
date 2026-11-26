import type { ProviderName } from "../oauth/providers.js";
import {
  DEFAULT_AUTH_LOCALE,
  authError,
  authErrorFooter,
  type AuthErrorKey,
  type AuthErrorParams,
  type AuthLocale,
} from "./auth-locale.js";

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
 * 一个可写进 CSP `form-action` 的 source 所允许的形态。
 *
 * 只收纯 Origin：`scheme://host[:port]`，host 限 ASCII 主机名字符或方括号
 * IPv6 字面量，端口限数字。刻意**不用** reg-name 的完整字符集（`!'()*+,;=`
 * 等子定界符）——其中的 `'` 会打断 CSP 自己的引号语法，`=`、`;` 会让解析器
 * 提前结束该 directive。宁可对极少数带子定界符的主机名退回 `'self'`
 * （fail-closed，跳转被拦），也不往安全头里放一个能改变 CSP 语义的字符。
 */
const CSP_FORM_ACTION_SOURCE =
  /^https?:\/\/(?:[A-Za-z0-9._~-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]+)?$/;

/**
 * 把一个候选 Origin 写成 CSP `form-action` 的**单个 source**，不合法就返回空。
 *
 * 两道闸，缺一不可：
 *
 * 1. **round-trip**：`new URL(x).origin === x`。这挡掉带 path / query /
 *    fragment 的串（会被 `origin` 规范化掉）、挡掉非 http(s) 自定义 scheme
 *    （`origin` 是字符串 `"null"`，不是可用 source）、也挡掉解析失败的串。
 * 2. **字符白名单**：round-trip 单独不够——URL 解析器会**原样保留 host 里的
 *    双引号**（`new URL('https://a.example"').origin` 等于它自己），那种串
 *    照样能通过第 1 道闸。白名单把引号、空白、CR/LF 全部拒掉。
 *
 * 返回值已保证只含白名单字符，可以直接拼进 header。
 */
function cspFormActionSource(origin: string | undefined): string {
  if (!origin) return "";
  if (!/^https?:\/\//i.test(origin)) return "";
  if (!CSP_FORM_ACTION_SOURCE.test(origin)) return "";
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return "";
  }
  if (parsed.origin !== origin) return "";
  return origin;
}

/**
 * 授权页的响应头。
 *
 * - `no-store`：授权页不能被任何缓存留存（它带着 `rid`）；
 * - `no-referrer`：跳去 Provider 时不把 `rid` 放进 Referer；
 * - `DENY`：不允许被第三方站点 iframe（点击劫持）；
 * - CSP：只允许同源样式与表单，`default-src 'none'` 让任何意外注入都失效。
 *
 * ## `formActionOrigin`：同意页为什么需要它
 *
 * 同意页是**原生表单 POST**，服务端 302 回客户端注册的 `redirect_uri`。
 * Chromium 把 `form-action` 也套用到「表单提交后的这次重定向」上——回调与
 * Cloud 不同源（哪怕只差一个端口）时，导航会被中止（`net::ERR_ABORTED`，
 * 页面留在原地），于是**授权码已签发却永远到不了客户端**：Allow 与 Deny
 * 两条路径一起卡死，看起来像授权逻辑坏了，其实是这一行 CSP。
 *
 * 所以同意页必须把**本次已验证的回调 Origin** 放进来。它来自 authorize 阶段
 * 与预注册 `redirect_uris` **逐字符比对过**的 `redirect_uri`，不是用户输入；
 * 这里再过一遍 `cspFormActionSource` 规范化，不合法就退回只允许 `'self'`
 * （fail-closed：宁可跳转被拦，也不往安全头里塞没验过的东西）。
 *
 * 登录页与错误页没有跨 Origin 的表单提交，不传这个参数即可。
 */
export function authPageHeaders(
  options: { readonly formActionOrigin?: string } = {},
): Record<string, string> {
  const extra = cspFormActionSource(options.formActionOrigin);
  const formAction = extra ? `'self' ${extra}` : "'self'";
  return {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
  };
}

/**
 * 默认授权页响应头（登录页、错误页）：`form-action` 只允许同源。
 *
 * 保持为**常量**而非每次重建，是因为这些页面没有跨 Origin 表单提交——
 * 见 `authPageHeaders` 的注释。
 */
export const AUTH_PAGE_HEADERS: Record<string, string> = authPageHeaders();

/**
 * 页面外壳（登录页、同意页、错误页共用）。
 *
 * ## 为什么三页必须共用一个外壳
 *
 * 用户在一次授权里会连续看到「登录 → 同意 → 可能的错误」。三页若各写一套
 * 样式，就会出现「同意页是品牌色、错误页是浏览器默认灰」的断裂感——而错误
 * 页恰恰是最需要可信度的一页。共用外壳同时保证：**CSP 与安全头只有一处
 * 定义**，不会出现「登录页加了 `X-Frame-Options`、同意页忘了加」的漂移。
 *
 * ## 视觉方向
 *
 * 咖啡与个人工作台的气质：暖纸底、浓缩咖啡主色、拿铁辅色；靠留白与字号
 * 层级建立秩序，不靠渐变与装饰。浅色 / 深色跟随 `prefers-color-scheme`。
 *
 * ## 硬约束（既有测试锁死，改动前先看 `tests/mcp-oauth/*`）
 *
 * - **无 JavaScript**、**无外部资源**：没有 CDN、字体、图片请求；
 *   图形只能是内联 SVG。
 * - HTML 里**不得出现** `http://`、`https://`、`src=`、`<script`——
 *   一旦出现，`consent-route` / `login-route` 的安全断言就红。
 *   所以样式、图标、文案都必须是相对路径或纯文本。
 * - 所有动态内容过 `escapeHtml()`。
 */
export interface AuthPageOptions {
  /** 页面语种；默认 `zh`（与改动前 `lang="zh-CN"` 一致）。 */
  locale?: AuthLocale;
  /** 追加到外壳样式之后的页面级样式（同一份 `<style>`，避免第二个请求）。 */
  extraCss?: string;
  /** 页面主体下方的统一说明（例如错误页的「下一步」）。 */
  footerNote?: string;
}

/**
 * BrewPhase 品牌标记：一颗咖啡豆。
 *
 * 纯内联 SVG（`viewBox` + `path`），不引用任何文件、不带 `xlink:href`、
 * 不带 `src=`——满足「不请求外部图像资源」且不触发安全断言。
 * `aria-hidden` + `focusable="false"`：它是装饰，读屏器念品牌名即可。
 */
const BRAND_MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="26" height="26">
  <path d="M12 2.6c5.19 0 9.4 4.21 9.4 9.4S17.19 21.4 12 21.4 2.6 17.19 2.6 12 6.81 2.6 12 2.6z" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M16.9 7.1c-1.9 1.2-3.2 3.1-3.6 5.4-.4 2.3.2 4.5 1.7 6.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

/**
 * 页面外壳的样式令牌。
 *
 * 用 CSS 自定义属性而不是每处写死颜色：浅/深两套主题只维护一份结构，
 * 换品牌色也只改一处。
 */
const SHELL_CSS = `
  :root {
    color-scheme: light dark;
    --bg: #f7f2ec;
    --surface: #fffdfb;
    --surface-sunken: #f1e8de;
    --ink: #2a1e16;
    --ink-muted: #6f5f53;
    --line: #e6dacd;
    --line-strong: #d3c3b1;
    --accent: #6b4226;
    --accent-ink: #fff9f3;
    --accent-soft: #f2e5d8;
    --brand: #a9713f;
    --warn-bg: #fdf3e6;
    --warn-line: #ecd2ab;
    --warn-ink: #6b4a22;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14100d;
      --surface: #1f1914;
      --surface-sunken: #272019;
      --ink: #f3ebe3;
      --ink-muted: #a99a8c;
      --line: #372e26;
      --line-strong: #4a3e33;
      --accent: #d5a679;
      --accent-ink: #241812;
      --accent-soft: #2e251d;
      --brand: #c99a6f;
      --warn-bg: #2b2116;
      --warn-line: #4e3c22;
      --warn-ink: #e7c795;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    padding: clamp(1.25rem, 4vw, 3rem) clamp(0.9rem, 4vw, 2rem) 2.5rem;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex;
    justify-content: center;
  }
  .shell { width: 100%; max-width: 30rem; display: flex; flex-direction: column; gap: 1.15rem; }
  .brand { display: flex; align-items: center; gap: .55rem; color: var(--brand); }
  .brand .mark { flex: none; }
  .brand .wordmark {
    font-size: 1.06rem; font-weight: 700; letter-spacing: .01em;
    color: var(--ink);
  }
  .brand .tagline {
    margin-left: auto; color: var(--ink-muted);
    font-size: .76rem; letter-spacing: .02em; text-align: right;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 1rem;
    padding: clamp(1.15rem, 4vw, 1.9rem);
    box-shadow: 0 1px 2px rgba(42, 30, 22, .04), 0 12px 32px -24px rgba(42, 30, 22, .45);
  }
  h1 {
    margin: 0 0 .5rem;
    font-size: clamp(1.1rem, 4.5vw, 1.32rem);
    line-height: 1.35;
    font-weight: 650;
    letter-spacing: -.01em;
    overflow-wrap: anywhere;
  }
  h2 {
    margin: 1.6rem 0 .6rem;
    font-size: .76rem; font-weight: 700; letter-spacing: .08em;
    color: var(--ink-muted);
  }
  /* 大写只给英文：中文标签里若出现品牌名（如「登录你的 BrewPhase 账号」），
     text-transform: uppercase 会把它变成 BREWPHASE，读起来像 slogan 而不是
     产品名。中文本身不受该属性影响，但混排的拉丁词会。 */
  html[lang="en"] h2 { text-transform: uppercase; letter-spacing: .09em; }
  p { margin: 0 0 .8rem; overflow-wrap: anywhere; }
  p.sub { color: var(--ink-muted); font-size: .9rem; }
  .foot {
    color: var(--ink-muted); font-size: .78rem; text-align: center;
    line-height: 1.55; padding: 0 .5rem;
  }
  a { color: var(--accent); }
  /* 键盘可达：只在键盘聚焦时显示轮廓，鼠标点击不出现多余框。 */
  :focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: .35rem;
  }
  .btn {
    display: flex; align-items: center; justify-content: center; gap: .6rem;
    width: 100%; padding: .8rem 1rem;
    border-radius: .7rem; border: 1px solid var(--line-strong);
    background: var(--surface); color: var(--ink);
    font: inherit; font-weight: 600; text-decoration: none; text-align: center;
    cursor: pointer;
    transition: background .14s ease, border-color .14s ease, transform .06s ease;
  }
  .btn:hover { background: var(--surface-sunken); border-color: var(--brand); }
  .btn:active { transform: translateY(1px); }
  .btn[aria-disabled="true"] { opacity: .55; cursor: not-allowed; }
  .btn-primary {
    background: var(--accent); border-color: var(--accent); color: var(--accent-ink);
  }
  .btn-primary:hover { background: var(--accent); filter: brightness(1.08); }
  .btn .ico { flex: none; width: 1.1rem; height: 1.1rem; }
  .stack { display: grid; gap: .6rem; }
  .notice {
    background: var(--warn-bg); border: 1px solid var(--warn-line);
    color: var(--warn-ink); border-radius: .7rem;
    padding: .8rem 1rem; font-size: .88rem;
  }
  .hint { color: var(--ink-muted); font-size: .8rem; line-height: 1.6; }
  @media (max-width: 22rem) {
    .brand .tagline { display: none; }
    .card { padding: 1.1rem .95rem; }
  }
`;

/**
 * 渲染授权页外壳。
 *
 * `title` 会同时进 `<title>` 与（调用方选择时）`<h1>`，因此必须转义——
 * 它可能包含客户端名。
 */
export function renderAuthPage(
  title: string,
  body: string,
  options: AuthPageOptions | string = {},
): string {
  // 兼容旧签名 `renderAuthPage(title, body, extraCss)`：同意页此前传的是字符串。
  const opts: AuthPageOptions = typeof options === "string" ? { extraCss: options } : options;
  const locale = opts.locale ?? DEFAULT_AUTH_LOCALE;
  const lang = locale === "en" ? "en" : "zh-CN";

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
${SHELL_CSS}
${opts.extraCss ?? ""}
</style>
</head>
<body>
<div class="shell">
  <header class="brand">
    ${BRAND_MARK}
    <span class="wordmark">BrewPhase</span>
    <span class="tagline">${escapeHtml(
      locale === "en" ? "Your Personal Data Workspace" : "你的个人数据工作台",
    )}</span>
  </header>
  <main class="card">
${body}
  </main>
  <p class="foot">${escapeHtml(
    opts.footerNote ??
      (locale === "en"
        ? "BrewPhase — your data stays on your own computer."
        : "BrewPhase — 你的数据保存在自己的电脑上。"),
  )}</p>
</div>
</body>
</html>`;
}

export interface LoginPageInput {
  rid: string;
  /** 同意页要展示的客户端名（已由调用方从库里取出）。 */
  clientName: string;
  availableProviders: readonly ProviderName[];
  /** 页面语种；默认 `zh`。 */
  locale?: AuthLocale;
}

/**
 * Provider 图标：内联 SVG，**不引用任何外部文件**。
 *
 * 两个图标都只用 `path`/`circle` 的几何数据，没有 `src=`、没有 URL——
 * 既满足「不请求外部图像资源」，也不触发既有安全断言。
 * `aria-hidden` + `focusable="false"`：按钮文字已经说明是哪个 Provider，
 * 图标重复念一遍只会让读屏器啰嗦。
 */
const PROVIDER_ICONS: Record<ProviderName, string> = {
  google: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/>
  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/>
  <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/>
  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"/>
</svg>`,
  github: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path fill="currentColor" d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z"/>
</svg>`,
};

const LOGIN_COPY: Record<
  AuthLocale,
  {
    docTitle: string;
    heading: (client: string) => string;
    lead: string;
    signInLabel: string;
    /** 只列**已配置**的 Provider：文案不能替未启用的登录方式背书。 */
    signInHint: (providers: string) => string;
    providersUnavailableNotice: string;
    providerLabel: (name: string) => string;
  }
> = {
  zh: {
    docTitle: "登录 BrewPhase",
    heading: (client) => `将 ${client} 连接到 BrewPhase`,
    lead: "你正在将 BrewPhase 个人数据连接到此应用。",
    signInLabel: "登录你的 BrewPhase 账号",
    signInHint: (providers) =>
      `BrewPhase 通过 ${providers} 验证账号身份。你不需要在此输入 ChatGPT 密码。`,
    providersUnavailableNotice:
      "当前无法完成授权。请联系 BrewPhase 服务的管理员配置 Google 或 GitHub 登录。",
    providerLabel: (name) => `使用 ${name} 继续`,
  },
  en: {
    docTitle: "Sign in to BrewPhase",
    heading: (client) => `Connect ${client} to BrewPhase`,
    lead: "You are connecting your BrewPhase personal data to this app.",
    signInLabel: "Sign in to your BrewPhase account",
    signInHint: (providers) =>
      `BrewPhase verifies your account with ${providers}. You never enter your ChatGPT password here.`,
    providersUnavailableNotice:
      "Authorization cannot continue. Ask the BrewPhase service administrator to configure Google or GitHub sign-in.",
    providerLabel: (name) => `Continue with ${name}`,
  },
};

/** 把已配置的 Provider 名串成「Google」/「Google 或 GitHub」。 */
function joinProviderNames(
  providers: readonly ProviderName[],
  locale: AuthLocale,
): string {
  const names = providers.map((p) => PROVIDER_LABELS[p] ?? p);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  const sep = locale === "en" ? " or " : " 或 ";
  return `${names.slice(0, -1).join("、")}${sep}${names[names.length - 1]!}`;
}

/**
 * 渲染 Provider 选择页。
 *
 * `rid` 会出现在链接里，但它不是凭据：真正决定「谁能继续」的是浏览器
 * Cookie 的绑定。所以即使 `rid` 被旁观者看到，也打不开下一步。
 *
 * ## 入口纪律（Phase 1.3.3-A-R4）
 *
 * 这一页**只**由 `/mcp/oauth/authorize` 发起的那次授权触发，`rid` 是该请求
 * 专属的临时标识。它不是独立登录入口：没有 OAuth 参数就拿不到 `rid`，
 * 也就没有这一页。禁止把它包装成公开登录页或官网上的「连接」按钮——
 * 那会绕过 PKCE、CSRF 与浏览器绑定。
 *
 * 登录（确认是谁）与同意（确认能读什么）是**两个动作**，不在这里合并：
 * 此页只解决前者。
 */
export function renderLoginPage(input: LoginPageInput): string {
  const locale = input.locale ?? DEFAULT_AUTH_LOCALE;
  const copy = LOGIN_COPY[locale];
  const safeRid = encodeURIComponent(input.rid);

  const heading = `<h1>${escapeHtml(copy.heading(input.clientName))}</h1>`;
  const lead = `<p class="sub">${escapeHtml(copy.lead)}</p>`;

  if (input.availableProviders.length === 0) {
    const unavailable = authError("providers_unavailable", locale);
    return renderAuthPage(
      copy.docTitle,
      `${heading}
${lead}
<h2>${escapeHtml(copy.signInLabel)}</h2>
<div class="notice"><strong>${escapeHtml(unavailable.title)}</strong><br>${escapeHtml(
        unavailable.message,
      )}</div>
<p class="hint">${escapeHtml(copy.providersUnavailableNotice)}</p>`,
      { locale },
    );
  }

  const buttons = input.availableProviders
    .map((provider) => {
      const label = copy.providerLabel(PROVIDER_LABELS[provider] ?? provider);
      const icon = PROVIDER_ICONS[provider] ?? "";
      // `rid` 进 query 前先 encodeURIComponent：它虽是 uuid，但不该假设形态。
      return `<a class="btn" href="/mcp/oauth/login?rid=${safeRid}&amp;provider=${encodeURIComponent(
        provider,
      )}">${icon}<span>${escapeHtml(label)}</span></a>`;
    })
    .join("\n");

  return renderAuthPage(
    copy.docTitle,
    `${heading}
${lead}
<h2>${escapeHtml(copy.signInLabel)}</h2>
<div class="stack">
${buttons}
</div>
<p class="hint">${escapeHtml(
      copy.signInHint(joinProviderNames(input.availableProviders, locale)),
    )}</p>`,
    { locale },
  );
}

/**
 * 通用错误页。
 *
 * 三条纪律：
 *
 * 1. **不带任何回跳链接**——出错时没有可信的 `redirect_uri`，任何「点这里
 *    重试」的链接都可能把用户送到攻击者指定的地址。
 * 2. **不展示内部标识**——没有 rid / code / session id / SQL / 堆栈；
 *    唯一的动态内容是客户端身份标签（hostname 或 ≤40 字符截断），
 *    且由调用方经 `clientIdentifierDisplay()` 先做安全裁剪。
 * 3. **说清楚怎么重新开始**——每条 message 内嵌「回到发起授权的应用」，
 *    页脚再给一次统一措辞的下一步。
 *
 * 未知错误键回落到 `service_unavailable`（在 `authError` 内部），
 * 因此这里不需要也不可能渲染出 `undefined`。
 */
export function renderErrorPage(
  key: AuthErrorKey | string,
  locale: AuthLocale = DEFAULT_AUTH_LOCALE,
  params: AuthErrorParams = {},
): string {
  const { title, message } = authError(key, locale, params);
  return renderAuthPage(
    title,
    `<h1>${escapeHtml(title)}</h1>
<div class="notice">${escapeHtml(message)}</div>`,
    { locale, footerNote: authErrorFooter(locale) },
  );
}
