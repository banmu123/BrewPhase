import { escapeHtml, renderAuthPage } from "./login-page.js";
import type { McpScope } from "./constants.js";

/**
 * 同意页（Phase 1.3.1-C2b）。
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
 */

const SCOPE_LABELS: Record<McpScope, string> = {
  "records:read": "读取你的记录",
  "tags:read": "读取你的标签",
  "coffee:read": "读取你的咖啡数据",
  "canvas:read": "读取你的画布",
};

/**
 * 每个 scope 的用户可理解说明。
 *
 * **只描述读取**。这四个 scope 都是只读的；文案里出现「修改」「删除」会
 * 让用户以为应用能写数据——那是最严重的一类误导。
 */
const SCOPE_DESCRIPTIONS: Record<McpScope, string> = {
  "records:read": "读取你的记录、正文、笔记和标签",
  "tags:read": "读取你的标签列表",
  "coffee:read": "读取你的咖啡豆、冲煮与品鉴记录",
  "canvas:read": "读取你的画布和画布节点",
};

const CONSENT_CSS = `
  .client { font-weight: 600; }
  ul.scopes { list-style: none; margin: 0 0 1.25rem; padding: 0; display: grid; gap: .6rem; }
  ul.scopes li {
    background: #fff; border: 1px solid #ddd3c9; border-radius: .6rem;
    padding: .7rem .85rem;
  }
  ul.scopes label { display: grid; grid-template-columns: auto 1fr; gap: .2rem .6rem; cursor: pointer; }
  ul.scopes input { margin: .3rem 0 0; width: 1.05rem; height: 1.05rem; accent-color: #7a4b2a; }
  ul.scopes .name { font-weight: 600; }
  ul.scopes .desc { grid-column: 2; color: #6b5f56; font-size: .82rem; }
  ul.scopes .code { grid-column: 2; color: #98897c; font: .75rem ui-monospace, SFMono-Regular, monospace; }
  ul.scopes .badge { color: #6b5f56; font-size: .75rem; font-weight: 400; margin-left: .35rem; }
  ul.scopes input:disabled + .name { color: #6b5f56; }
  .actions { display: flex; gap: .6rem; margin-top: .35rem; }
  .actions button {
    flex: 1; padding: .75rem 1rem; border-radius: .6rem; font: inherit;
    font-weight: 600; cursor: pointer; border: 1px solid #ddd3c9; background: #fff; color: inherit;
  }
  .actions button.primary { background: #7a4b2a; border-color: #7a4b2a; color: #fff; }
  .actions button.deny { background: transparent; }
  .hint { color: #6b5f56; font-size: .8rem; margin: .9rem 0 0; }
  @media (prefers-color-scheme: dark) {
    ul.scopes li { background: #221b16; border-color: #3a2f27; }
    ul.scopes .desc, .hint { color: #a89b90; }
    ul.scopes .code { color: #8a7c70; }
    .actions button { background: #221b16; border-color: #3a2f27; }
    .actions button.primary { background: #c58f63; border-color: #c58f63; color: #17120f; }
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
}

/**
 * 渲染同意页。
 *
 * Step-up 的「已授予」项用 `checked disabled`：`disabled` 的复选框**不会**
 * 被浏览器提交，所以服务端收到的只有用户真正勾选的新增项，最终 scope 由
 * 服务端把已有 scope 并回来（`decideConsent` 的 union）。这样即使页面被
 * 篡改，也不可能把已授予的权限「取消」掉。
 */
export function renderConsentPage(input: ConsentPageInput): string {
  const items = input.scopes
    .map((row) => {
      const label = escapeHtml(SCOPE_LABELS[row.scope]);
      const description = escapeHtml(SCOPE_DESCRIPTIONS[row.scope]);
      const scope = escapeHtml(row.scope);
      const checked = row.granted ? " checked disabled" : " checked";
      const badge = row.granted ? `<span class="badge">已授予</span>` : "";
      return `<li>
  <label>
    <input type="checkbox" name="scope" value="${scope}"${checked}>
    <span class="name">${label}${badge}</span>
    <span class="desc">${description}</span>
    <span class="code">${scope}</span>
  </label>
</li>`;
    })
    .join("\n");

  const hostLine = input.redirectHost
    ? `授权完成后你会回到 <strong>${escapeHtml(input.redirectHost)}</strong>。`
    : "授权完成后你会回到发起授权的应用。";

  /**
   * 身份行与回调行**分开渲染、各带标签**（§16.2 纪律 1）。
   * `clientIdentifierHost` 为空（§16 的「解析失败」行）时整行不渲染，
   * 回调行不受影响。两个值都只作纯文本，**不做链接**（纪律 2）。
   * 客户端名已由 `<h1>` 展示，这里只补身份域名本身。
   */
  const identityLine = input.clientIdentifierHost
    ? `<p class="sub">你正在授权给 <strong>${escapeHtml(input.clientIdentifierHost)}</strong>。</p>`
    : "";

  return renderAuthPage(
    "授权 BrewPhase 访问",
    `<h1><span class="client">${escapeHtml(input.clientName)}</span> 请求读取你的 BrewPhase 数据</h1>
${identityLine}
<p class="sub">${hostLine}</p>
<form method="post" action="/mcp/oauth/consent">
  <input type="hidden" name="rid" value="${escapeHtml(input.rid)}">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
  <ul class="scopes">
${items}
  </ul>
  <div class="actions">
    <button type="submit" name="decision" value="deny" class="deny">拒绝</button>
    <button type="submit" name="decision" value="allow" class="primary">允许</button>
  </div>
</form>
<p class="hint">未勾选的权限不会被授予。至少保留一项权限才能允许；取消全部勾选视为拒绝。</p>`,
    CONSENT_CSS,
  );
}
