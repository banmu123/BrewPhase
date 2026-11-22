import { escapeHtml, renderAuthPage } from "./login-page.js";
import { DEFAULT_AUTH_LOCALE, type AuthLocale } from "./auth-locale.js";
import type { McpScope } from "./constants.js";

/**
 * 同意页（Phase 1.3.1-C2b；R4 重设计）。
 *
 * ## 三个刻意的约束（与登录页一致）
 *
 * 1. **没有 JavaScript**。整页只有一个 `<form>`。没有脚本就没有脚本注入面，
 *    也不需要为「渲染后再说」写任何兜底逻辑。
 * 2. **没有外部资源**。一个授权页去拉 CDN，等于把「用户在哪个 MCP 服务上
 *    授权」告诉第三方。
 * 3. **所有动态内容都转义**。客户端名、回调域名、scope 都来自数据库/请求，
 *    统一走 `escapeHtml`。
 *
 * ## 这份 HTML 里有什么、没有什么
 *
 * | 有 | 没有 |
 * |---|---|
 * | `rid`（授权请求 id，不是凭据） | 用户 id、grant id、session id |
 * | CSRF 明文（一次性，藏表单里） | 授权码、access token、refresh token |
 * | 客户端名、回调域名 | 客户端内部参数、Provider 身份信息 |
 *
 * ## 结构契约（`tests/helpers/mcp-consent.ts` 依赖，改动前先看）
 *
 * - `<input type="hidden" name="csrf" value="…">` 与 `name="rid"` **逐字保留**；
 * - 每个权限是 `<input type="checkbox" name="scope" value="<scope>" …>`，
 *   属性串里用空格分隔 `checked` / `disabled`（解析器按 `/\schecked/` 判定）。
 *
 * ## R4 重设计要解决的问题
 *
 * 原页面是一串同级复选框：用户看不出「哪个应用」「回到哪」「只读」，
 * 也看不到数据到底怎么走。现在拆成四块——授权对象、只读声明、权限卡片、
 * 数据流——让「允许什么」在点按钮之前就能被完整读完。
 */

/**
 * 每个 scope 的用户可理解说明。
 *
 * **只描述读取**。这四个 scope 都是只读的；文案里出现「修改」「删除」会
 * 让用户以为应用能写数据——那是最严重的一类误导。
 *
 * 文案按任务书 R4 逐条给出（卡片式、可分条读），与 `SCOPE_TITLES` 的卡片标题
 * 分工：标题用于一眼认出是哪类数据，卡片文案用于逐条确认读到什么。
 */
const SCOPE_DESCRIPTIONS: Record<McpScope, readonly string[]> = {
  "records:read": ["读取已保存的记录。", "读取标题、正文、笔记和标签。"],
  "tags:read": ["读取个人记录中的标签列表。"],
  "coffee:read": ["读取咖啡豆、烘焙信息。", "读取冲煮记录。", "读取品鉴记录。"],
  "canvas:read": ["读取画布与画布节点。", "读取对应节点的关联摘要和位置。"],
};

/**
 * 卡片标题与图标。
 *
 * 标题是「英文名 — 中文名」：scope 代码本身是英文（`records:read`），
 * 用户却要一眼认出这是哪类数据，两个名字并排最省一次心智转换。
 */
const SCOPE_TITLES: Record<McpScope, { zh: string; en: string }> = {
  "records:read": { zh: "Records — 个人记录", en: "Records — personal records" },
  "tags:read": { zh: "Tags — 标签", en: "Tags" },
  "coffee:read": { zh: "Coffee — 咖啡数据", en: "Coffee data" },
  "canvas:read": { zh: "Canvas — 个人画布", en: "Canvas — personal canvases" },
};

/**
 * 每类数据的内联 SVG 图标。
 *
 * 只用 `path` / `rect` 几何数据：没有 `src=`、没有 `xlink:href`、没有外部
 * 引用——既满足「不请求外部图像资源」，也不触发既有安全断言
 * （`consent-route` 断言整页不含 `src=`）。
 */
const SCOPE_ICONS: Record<McpScope, string> = {
  "records:read": `<svg class="card-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M6 3.5h8.2L18.5 8v12.5H6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M14 3.8V8.3h4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M8.6 12.4h6.6M8.6 15.4h6.6M8.6 18h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`,
  "tags:read": `<svg class="card-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M4 4.8h7.4l8.1 7.2-7.4 7.2L4 11.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <circle cx="8.6" cy="9.4" r="1.4" fill="currentColor"/>
</svg>`,
  "coffee:read": `<svg class="card-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M5.5 8.5h10v6a4.5 4.5 0 0 1-4.5 4.5h-1a4.5 4.5 0 0 1-4.5-4.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M15.5 10h1.8a2.4 2.4 0 0 1 0 4.8h-1.8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M8.4 5.6c.9-.7.9-1.6 0-2.3M11.6 5.6c.9-.7.9-1.6 0-2.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`,
  "canvas:read": `<svg class="card-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <rect x="3.8" y="4.6" width="16.4" height="14.8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="9" cy="10" r="1.6" fill="currentColor"/>
  <circle cx="15.2" cy="14.4" r="1.6" fill="currentColor"/>
  <path d="M10.2 11.2l3.8 2.2" fill="none" stroke="currentColor" stroke-width="1.5"/>
</svg>`,
};

interface ConsentCopy {
  docTitle: string;
  heading: string;
  appLabel: string;
  identityLabel: string;
  callbackLabel: string;
  readOnlyBadge: string;
  readOnlyLead: string;
  readOnlyBullets: readonly string[];
  permissionsTitle: string;
  flowTitle: string;
  flowLead: string;
  flowSteps: readonly string[];
  flowBullets: readonly string[];
  grantedBadge: string;
  deny: string;
  allow: string;
  hint: string;
}

const CONSENT_COPY: Record<AuthLocale, ConsentCopy> = {
  zh: {
    docTitle: "授权 BrewPhase 访问",
    heading: "授权应用读取你的 BrewPhase 数据",
    appLabel: "申请连接的应用",
    identityLabel: "应用身份域名",
    callbackLabel: "授权完成后回到",
    readOnlyBadge: "仅查看权限",
    readOnlyLead: "READ-ONLY ACCESS — 这个版本只能读取，不能改动你的数据。",
    readOnlyBullets: [
      "不能创建记录。",
      "不能修改或删除 Coffee 数据。",
      "不能修改或删除 Canvas。",
      "最终实际权限仍以你的勾选与 Cloud 授权为准。",
    ],
    permissionsTitle: "这个应用将可以读取",
    flowTitle: "你的数据怎么流动",
    flowLead: "你的数据保存在 BrewPhase Desktop 本地。当 ChatGPT 发起读取请求时：",
    flowSteps: ["ChatGPT", "BrewPhase Cloud", "你的 Desktop", "BrewPhase Cloud", "ChatGPT"],
    flowBullets: [
      "Cloud 负责身份校验、授权判定与请求转发。",
      "Cloud 不保存你的业务数据——记录、咖啡与画布都留在本机。",
      "工具调用的请求与响应会经过 Cloud 转发，业务内容不会写入 Cloud 存储。",
      "Desktop 离线时，远程读取无法完成。",
    ],
    grantedBadge: "已授予",
    deny: "拒绝",
    allow: "允许访问",
    hint: "未勾选的权限不会被授予。至少保留一项权限才能允许；取消全部勾选视为拒绝。",
  },
  en: {
    docTitle: "Authorize BrewPhase access",
    heading: "Authorize access to your BrewPhase data",
    appLabel: "App requesting access",
    identityLabel: "App identity domain",
    callbackLabel: "You will return to",
    readOnlyBadge: "Read-only access",
    readOnlyLead: "READ-ONLY ACCESS — this version can read your data but never change it.",
    readOnlyBullets: [
      "It cannot create records.",
      "It cannot modify or delete Coffee data.",
      "It cannot modify or delete Canvas.",
      "Your final permissions are the ones you tick and Cloud authorizes.",
    ],
    permissionsTitle: "This app will be able to read",
    flowTitle: "How your data moves",
    flowLead: "Your data stays on your BrewPhase Desktop. When ChatGPT asks to read it:",
    flowSteps: ["ChatGPT", "BrewPhase Cloud", "Your Desktop", "BrewPhase Cloud", "ChatGPT"],
    flowBullets: [
      "Cloud verifies identity, decides authorization and forwards the request.",
      "Cloud does not store your business data — records, coffee and canvas stay on this computer.",
      "Tool calls are forwarded through Cloud; their contents are never written to Cloud storage.",
      "When the Desktop is offline, remote reads cannot complete.",
    ],
    grantedBadge: "Granted",
    deny: "Deny",
    allow: "Allow access",
    hint: "Unticked permissions are not granted. Keep at least one to allow; unticking everything counts as a denial.",
  },
};

const CONSENT_CSS = `
  .app-head { display: flex; align-items: flex-start; gap: .8rem; }
  .app-avatar {
    flex: none; width: 2.6rem; height: 2.6rem; border-radius: .75rem;
    background: var(--accent-soft); color: var(--accent);
    display: grid; place-items: center; font-weight: 700; font-size: 1.05rem;
  }
  .app-meta { min-width: 0; }
  .app-name { font-weight: 650; font-size: 1.02rem; overflow-wrap: anywhere; }
  .fact {
    display: grid; gap: .1rem; padding: .7rem .85rem; margin-top: .7rem;
    background: var(--surface-sunken); border: 1px solid var(--line);
    border-radius: .7rem; font-size: .85rem;
  }
  .fact dt { color: var(--ink-muted); font-size: .74rem; letter-spacing: .04em; text-transform: uppercase; }
  .fact dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .badge-readonly {
    display: inline-flex; align-items: center; gap: .4rem;
    padding: .3rem .6rem; border-radius: 999px;
    background: var(--accent-soft); color: var(--accent);
    font-size: .72rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  }
  .readonly ul { margin: .55rem 0 0; padding-left: 1.05rem; }
  .readonly li { color: var(--ink-muted); font-size: .85rem; margin-bottom: .2rem; }
  .perm-list { display: grid; gap: .6rem; margin: 0; padding: 0; list-style: none; }
  .perm {
    display: grid; grid-template-columns: auto 1fr; gap: .1rem .7rem;
    padding: .8rem .85rem; border: 1px solid var(--line);
    border-radius: .8rem; background: var(--surface); cursor: pointer;
    transition: border-color .14s ease, background .14s ease;
  }
  .perm:hover { border-color: var(--brand); }
  .perm input { grid-row: 1 / span 3; width: 1.1rem; height: 1.1rem; margin-top: .2rem; accent-color: var(--accent); }
  .perm-top { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .card-ico { width: 1.05rem; height: 1.05rem; color: var(--brand); flex: none; }
  .perm-name { font-weight: 650; }
  .perm-desc { grid-column: 2; color: var(--ink-muted); font-size: .84rem; line-height: 1.55; }
  .perm-desc span { display: block; }
  .perm-code {
    grid-column: 2; margin-top: .35rem; color: var(--brand);
    font: .72rem ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .badge-granted {
    font-size: .68rem; font-weight: 700; letter-spacing: .05em;
    color: var(--ink-muted); border: 1px solid var(--line-strong);
    border-radius: 999px; padding: .1rem .45rem;
  }
  .perm:has(input:disabled) { background: var(--surface-sunken); cursor: default; }
  .perm:has(input:disabled) .perm-name { color: var(--ink-muted); }
  .flow {
    margin-top: .3rem; padding: .85rem; border-radius: .8rem;
    background: var(--surface-sunken); border: 1px solid var(--line);
  }
  .flow-chain {
    display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .45rem;
    font-size: .8rem; font-weight: 650; color: var(--accent); margin-bottom: .55rem;
  }
  .flow-chain .arrow { color: var(--ink-muted); font-weight: 400; }
  .flow ul { margin: 0; padding-left: 1.05rem; }
  .flow li { color: var(--ink-muted); font-size: .82rem; line-height: 1.55; margin-bottom: .18rem; }
  .actions { display: flex; gap: .65rem; margin-top: 1.15rem; }
  .actions .btn { flex: 1; }
  .actions .btn-allow { flex: 1.6; }
  .hint { color: var(--ink-muted); font-size: .79rem; line-height: 1.6; margin-top: .8rem; }
  @media (max-width: 24rem) {
    .actions { flex-direction: column-reverse; }
    .actions .btn, .actions .btn-allow { flex: none; width: 100%; }
  }
`;

export interface ConsentScopeRow {
  scope: McpScope;
  /** Step-up 时已经授予过：显示为已勾选、不可取消。 */
  granted: boolean;
}

/**
 * `client_id` 的**安全展示形式**（设计 §16.2 / §5.5：错误页与同意页共用同一套
 * host 渲染规则）。
 *
 * | 输入 | 结果 |
 * |---|---|
 * | URL 形态（http/https） | `URL.hostname`——WHATWG 已 lowercase + IDN→punycode；IPv6 保留方括号（`[::1]`） |
 * | http(s) 形态但解析失败（理论上不发生） | 空字符串（该行不渲染） |
 * | 不透明预注册 id | 截断到 40 字符 + `…`（不回显超长内容、不尝试解析成 host） |
 *
 * **只返回纯文本**：调用方一律过 `escapeHtml`，且**不得**渲染成链接。
 * 完整的 `client_id` URL（可能很长、含攻击者可控的路径 / 查询串）**绝不**
 * 进入任何页面或错误文案。
 */
export function clientIdentifierDisplay(clientId: string): string {
  try {
    const url = new URL(clientId);
    if (url.protocol === "http:" || url.protocol === "https:") {
      // hostname 为空 = 形态上是 http(s) 但不是合法 URL（如 `http://`）→ 空串。
      return url.hostname;
    }
  } catch {
    // 解析失败：继续按「不是 URL」处理（不透明 id 就是解析失败的常态）。
  }
  if (/^https?:\/\//i.test(clientId)) {
    // 以 http(s):// 开头却解析不出 host → §16 的「解析失败」行：空字符串。
    return "";
  }
  return clientId.length > 40 ? `${clientId.slice(0, 39)}…` : clientId;
}

export interface ConsentPageInput {
  rid: string;
  csrf: string;
  clientName: string;
  /**
   * 客户端**身份**域名（`client_id` 的 host；不透明 id 用截断标识）。
   *
   * 与 `redirectHost` **互相独立、分别渲染**（§16.2 纪律 1）：把回调域名当成
   * 客户端身份展示，会让用户把「回到哪里」误认成「授权给了谁」。
   */
  clientIdentifierHost: string;
  /** 回调地址的 host（不展示完整 URI）。 */
  redirectHost: string;
  scopes: readonly ConsentScopeRow[];
  /** 页面语种；默认 `zh`。 */
  locale?: AuthLocale;
}

/**
 * 渲染同意页。
 *
 * Step-up 的「已授予」项用 `checked disabled`：`disabled` 的复选框**不会**
 * 被浏览器提交，所以服务端收到的只有用户真正勾选的新增项，最终 scope 由
 * 服务端把已有 scope 并回来（`decideConsent` 的 union）。这样即使页面被
 * 篡改，也不可能把已授予的权限「取消」掉。
 *
 * **只改视觉、不改语义**：R4 只重排版式，`checked` / `disabled` 的组合、
 * scope 值、隐藏域、表单 action 与提交参数全部保持原样——权限语义由
 * `decideConsent` 在服务端重新计算，页面永远不是权威。
 */
export function renderConsentPage(input: ConsentPageInput): string {
  const locale = input.locale ?? DEFAULT_AUTH_LOCALE;
  const copy = CONSENT_COPY[locale];

  const permissions = input.scopes
    .map((row) => {
      const title = escapeHtml(SCOPE_TITLES[row.scope][locale === "en" ? "en" : "zh"]);
      const icon = SCOPE_ICONS[row.scope] ?? "";
      const scope = escapeHtml(row.scope);
      // 属性串必须是 ` checked disabled` / ` checked`（解析器按空白前缀判定）。
      const attrs = row.granted ? " checked disabled" : " checked";
      const badge = row.granted
        ? `<span class="badge-granted">${escapeHtml(copy.grantedBadge)}</span>`
        : "";
      const lines = SCOPE_DESCRIPTIONS[row.scope]
        .map((line) => `<span>${escapeHtml(line)}</span>`)
        .join("");
      return `<li>
  <label class="perm">
    <input type="checkbox" name="scope" value="${scope}"${attrs}>
    <span class="perm-top">${icon}<span class="perm-name">${title}</span>${badge}</span>
    <span class="perm-desc">${lines}</span>
    <span class="perm-code">${scope}</span>
  </label>
</li>`;
    })
    .join("\n");

  /**
   * 身份行与回调行**分开渲染、各带标签**（§16.2 纪律 1）。
   * `clientIdentifierHost` 为空（§16 的「解析失败」行）时整行不渲染，
   * 回调行不受影响。两个值都只作纯文本，**不做链接**（纪律 2）。
   *
   * 回调只显示 host：完整 `redirect_uri` 可能带路径与查询串，且那是
   * 「回到哪」而非「授权给谁」——两者并排但各带标签，避免用户混淆。
   */
  const identityFact = input.clientIdentifierHost
    ? `<div class="fact">
  <dt>${escapeHtml(copy.identityLabel)}</dt>
  <dd>${escapeHtml(input.clientIdentifierHost)}</dd>
</div>`
    : "";
  const callbackFact = `<div class="fact">
  <dt>${escapeHtml(copy.callbackLabel)}</dt>
  <dd>${escapeHtml(input.redirectHost || (locale === "en" ? "the app that started this" : "发起授权的应用"))}</dd>
</div>`;

  const readOnlyBullets = copy.readOnlyBullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("");
  const flowSteps = copy.flowSteps
    .map((s, i) =>
      i === 0
        ? `<span>${escapeHtml(s)}</span>`
        : `<span class="arrow" aria-hidden="true">→</span><span>${escapeHtml(s)}</span>`,
    )
    .join("");
  const flowBullets = copy.flowBullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("");

  const initial = escapeHtml((input.clientName.trim()[0] ?? "B").toUpperCase());

  return renderAuthPage(
    copy.docTitle,
    `<div class="app-head">
  <span class="app-avatar" aria-hidden="true">${initial}</span>
  <span class="app-meta">
    <span class="app-name">${escapeHtml(input.clientName)}</span>
    <p class="sub" style="margin:.15rem 0 0">${escapeHtml(copy.appLabel)}</p>
  </span>
</div>
<h1>${escapeHtml(copy.heading)}</h1>
${identityFact}
${callbackFact}

<div class="readonly" style="margin-top:1.35rem">
  <span class="badge-readonly">${escapeHtml(copy.readOnlyBadge)}</span>
  <p class="sub" style="margin:.5rem 0 0">${escapeHtml(copy.readOnlyLead)}</p>
  <ul>${readOnlyBullets}</ul>
</div>

<h2>${escapeHtml(copy.permissionsTitle)}</h2>
<form method="post" action="/mcp/oauth/consent">
  <input type="hidden" name="rid" value="${escapeHtml(input.rid)}">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
  <ul class="perm-list">
${permissions}
  </ul>

  <h2>${escapeHtml(copy.flowTitle)}</h2>
  <div class="flow">
    <p class="sub" style="margin:0 0 .55rem">${escapeHtml(copy.flowLead)}</p>
    <p class="flow-chain">${flowSteps}</p>
    <ul>${flowBullets}</ul>
  </div>

  <div class="actions">
    <button type="submit" name="decision" value="deny" class="btn">${escapeHtml(copy.deny)}</button>
    <button type="submit" name="decision" value="allow" class="btn btn-primary btn-allow">${escapeHtml(
      copy.allow,
    )}</button>
  </div>
</form>
<p class="hint">${escapeHtml(copy.hint)}</p>`,
    { locale, extraCss: CONSENT_CSS },
  );
}
