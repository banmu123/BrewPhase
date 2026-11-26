/**
 * 授权页的语种选择与错误文案目录（Phase 1.3.3-A-R4）。
 *
 * ## 为什么单独一个模块
 *
 * `login-page.ts` 负责页面外壳，`consent-page.ts` 负责权限卡片，而**错误页
 * 的文案由 `routes/mcp-oauth.ts` 决定**——三方都要同一份语种判定。放在任何
 * 一页里都会让另外两页反过来 import 页面模块，形成「路由 import 页面实现」
 * 的倒置。所以语种与错误文案单独成模块，页面只管渲染。
 *
 * ## 语种判定
 *
 * 只在 `zh` 与 `en` 之间二选一，**默认 zh**（与改动前 `lang="zh-CN"` 一致，
 * 不因为没带头就把中文用户推到英文页）。顺序按 `Accept-Language` 的 `q` 值
 * 排序后取第一个命中 `zh*` / `en*` 的标签——尊重客户端的显式偏好，
 * 而不是「只要出现 zh 就用 zh」。
 */

export type AuthLocale = "zh" | "en";

/** 默认语种：改动前整站是 `zh-CN`，不能因为缺 header 就改变既有用户看到的语言。 */
export const DEFAULT_AUTH_LOCALE: AuthLocale = "zh";

/**
 * 从 `Accept-Language` 解析语种。
 *
 * - 无 header / 解析不出任何 zh|en → 默认值；
 * - 同时出现 zh 与 en → 按 `q` 降序取靠前的那个（`q` 缺省视为 1）；
 * - `q=0` 是「明确不接受」，跳过。
 */
export function resolveAuthLocale(acceptLanguage: string | undefined): AuthLocale {
  if (!acceptLanguage) return DEFAULT_AUTH_LOCALE;

  const entries = acceptLanguage
    .split(",")
    .map((part) => {
      const [tagRaw, ...params] = part.trim().split(";");
      const tag = (tagRaw ?? "").trim().toLowerCase();
      const qParam = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { tag, q: Number.isFinite(q) ? q : 1 };
    })
    .filter((e) => e.tag.length > 0 && e.q > 0);

  // 稳定排序：q 相同时保持客户端给出的先后（Array.sort 在 V8 对小数组稳定）。
  const ordered = [...entries].sort((a, b) => b.q - a.q);
  for (const { tag } of ordered) {
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return DEFAULT_AUTH_LOCALE;
}

/** 错误页的可选参数。目前只有客户端身份标签（可能为空串）。 */
export interface AuthErrorParams {
  /** `clientIdentifierDisplay()` 的结果：hostname 或 ≤40 字符截断的不透明 id。 */
  client?: string;
}

interface AuthErrorText {
  title: string;
  /** 函数形式：带参数的文案按语种拼装，静态文案用 `() => "…"`。 */
  message: (params: AuthErrorParams) => string;
}

/**
 * 错误键目录。
 *
 * 中文文案与改动前**逐字相同**——既有测试断言的是这些字符串，
 * 改文案属于本阶段范围，改断言不属于。
 *
 * `restart` 类提示已经内嵌在每条 message 里（「请回到发起授权的应用重新开始」），
 * 满足「告诉用户如何重新发起授权」；错误页本身**不含任何链接**——出错时没有
 * 可信的 `redirect_uri`，任何回跳都可能是钓鱼。
 */
const AUTH_ERRORS: Record<string, Record<AuthLocale, AuthErrorText>> = {
  // ---- 授权请求本身 ----
  link_invalid: {
    zh: {
      title: "授权链接无效",
      message: () => "这个授权链接已失效。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Authorization link invalid",
      message: () =>
        "This authorization link is no longer valid. Return to the app that started this authorization and try again.",
    },
  },
  link_malformed: {
    zh: {
      title: "授权链接无效",
      message: () => "这个授权链接格式不正确。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Authorization link invalid",
      message: () =>
        "This authorization link is malformed. Return to the app that started this authorization and try again.",
    },
  },
  link_expired: {
    zh: {
      title: "授权已过期",
      message: () => "这次授权已超过 10 分钟。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Authorization expired",
      message: () =>
        "This authorization has been running for more than 10 minutes. Return to the app that started it and try again.",
    },
  },
  browser_expired: {
    zh: {
      title: "浏览器会话已失效",
      message: () => "浏览器会话已失效。请回到发起授权的应用重新开始授权，不要刷新这个页面。",
    },
    en: {
      title: "Browser session expired",
      message: () =>
        "Your browser session has expired. Return to the app that started this authorization and start over — do not refresh this page.",
    },
  },
  session_mismatch: {
    zh: {
      title: "授权会话不匹配",
      message: () => "这个授权链接已在另一个浏览器中打开。请重新开始授权。",
    },
    en: {
      title: "Authorization session mismatch",
      message: () =>
        "This authorization link was opened in a different browser. Please start the authorization again.",
    },
  },

  // ---- 登录方式 ----
  provider_unsupported: {
    zh: { title: "不支持的登录方式", message: () => "这个登录方式不受支持。" },
    en: {
      title: "Sign-in method not supported",
      message: () => "This sign-in method is not supported.",
    },
  },
  provider_unsupported_consent: {
    zh: {
      title: "不支持的登录方式",
      message: () => "这次授权使用的登录方式不受支持。请重新开始授权。",
    },
    en: {
      title: "Sign-in method not supported",
      message: () =>
        "The sign-in method used for this authorization is not supported. Please start again.",
    },
  },
  provider_conflict: {
    zh: {
      title: "登录方式冲突",
      message: () => "这次授权已经开始了另一个登录方式。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Sign-in method conflict",
      message: () =>
        "This authorization already started with a different sign-in method. Return to the app that started it and try again.",
    },
  },
  providers_unavailable: {
    zh: {
      title: "登录方式不可用",
      message: () => "此服务未配置任何可用的登录方式。",
    },
    en: {
      title: "No sign-in method available",
      message: () => "No sign-in method is configured for this service.",
    },
  },

  // ---- Provider 回调 ----
  auth_incomplete: {
    zh: {
      title: "授权未完成",
      message: () => "这次授权没有完成。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Authorization not completed",
      message: () =>
        "This authorization did not complete. Return to the app that started it and try again.",
    },
  },
  auth_no_code: {
    zh: {
      title: "授权未完成",
      message: () => "这次授权没有返回授权码。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Authorization not completed",
      message: () =>
        "No authorization code was returned. Return to the app that started this authorization and try again.",
    },
  },
  auth_no_state: {
    zh: {
      title: "授权未完成",
      message: () => "这次授权缺少状态参数。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Authorization not completed",
      message: () =>
        "The state parameter is missing. Return to the app that started this authorization and try again.",
    },
  },
  not_authenticated: {
    zh: {
      title: "尚未完成登录",
      message: () => "这次授权还没有确认你的 BrewPhase 账号。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Sign-in not finished",
      message: () =>
        "Your BrewPhase account has not been confirmed for this authorization yet. Return to the app that started it and try again.",
    },
  },
  provider_not_consumed: {
    zh: {
      title: "尚未完成登录",
      message: () => "这次授权还没有完成登录。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Sign-in not finished",
      message: () =>
        "Sign-in has not finished for this authorization. Return to the app that started it and try again.",
    },
  },
  account_unavailable: {
    zh: {
      title: "账号不可用",
      message: () => "这个 BrewPhase 账号当前不可用。请联系服务管理员。",
    },
    en: {
      title: "Account unavailable",
      message: () => "This BrewPhase account is currently unavailable. Please contact the service administrator.",
    },
  },

  // ---- 同意表单 ----
  form_invalid: {
    zh: {
      title: "请求无法处理",
      message: () => "这张授权表单已失效。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Request cannot be processed",
      message: () =>
        "This authorization form is no longer valid. Return to the app that started this authorization and try again.",
    },
  },
  form_stale: {
    zh: {
      title: "表单已失效",
      message: () =>
        "这张授权表单已失效，可能是页面打开太久或在另一处重新打开了授权。请重新开始授权。",
    },
    en: {
      title: "Form expired",
      message: () =>
        "This form has expired — the page may have been open too long, or the authorization was restarted elsewhere. Please start again.",
    },
  },
  scope_invalid: {
    zh: {
      title: "权限范围无效",
      message: () => "这次提交的权限范围不在授权请求之内。请重新打开授权页面。",
    },
    en: {
      title: "Invalid permission scope",
      message: () =>
        "The permissions submitted are outside what this authorization requested. Please reopen the authorization page.",
    },
  },
  metadata_invalid: {
    zh: {
      title: "客户端信息已变更",
      message: () =>
        "无法继续这次授权：该应用的注册信息已发生变化。请回到发起授权的应用重新开始。",
    },
    en: {
      title: "Client information changed",
      message: () =>
        "This authorization cannot continue: the app's registration details changed. Return to the app that started it and try again.",
    },
  },

  // ---- 客户端注册校验 ----
  client_unverified: {
    zh: {
      title: "无法验证该客户端",
      message: (p) =>
        `无法验证该客户端${p.client ? `（${p.client}）` : ""}的身份。请回到发起授权的应用重新开始。`,
    },
    en: {
      title: "Cannot verify this client",
      message: (p) =>
        `Could not verify the identity of this client${p.client ? ` (${p.client})` : ""}. Return to the app that started this authorization and try again.`,
    },
  },
  client_unavailable: {
    zh: {
      title: "暂时无法验证客户端",
      message: (p) =>
        `暂时无法验证该客户端${p.client ? `（${p.client}）` : ""}的身份，请稍后重试。`,
    },
    en: {
      title: "Cannot verify this client right now",
      message: (p) =>
        `Could not verify this client${p.client ? ` (${p.client})` : ""} right now. Please try again in a moment.`,
    },
  },
  service_unavailable: {
    zh: { title: "服务暂时不可用", message: () => "服务暂时不可用，请稍后重试。" },
    en: {
      title: "Service temporarily unavailable",
      message: () => "The service is temporarily unavailable. Please try again shortly.",
    },
  },
};

/** 已知错误键（供测试与路由侧穷举校验）。 */
export type AuthErrorKey = keyof typeof AUTH_ERRORS;

/**
 * 取错误文案。
 *
 * 未知键走 `service_unavailable`：调用方漏传一个键时，宁可给用户一句
 * 「稍后重试」，也不要把键名或 `undefined` 渲染到页面上。
 */
export function authError(
  key: AuthErrorKey | string,
  locale: AuthLocale,
  params: AuthErrorParams = {},
): { title: string; message: string } {
  const byLocale = AUTH_ERRORS[key];
  const text = byLocale?.[locale] ?? AUTH_ERRORS.service_unavailable![locale]!;
  return { title: text.title, message: text.message(params) };
}

/**
 * 错误页底部的「下一步」提示（与 message 内嵌的提示互补，统一措辞）。
 *
 * 同样**不含任何链接**：出错时没有可信的 `redirect_uri`。
 */
export function authErrorFooter(locale: AuthLocale): string {
  return locale === "en"
    ? "Return to the app that started this connection (for example ChatGPT or another MCP client) and start the connection again."
    : "回到发起授权的应用（例如 ChatGPT 或其它 MCP 客户端），重新发起一次连接即可。";
}
