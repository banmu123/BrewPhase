# 隐私政策差距审计（Phase 1.3.3-A-R4）

> 日期：2026-11-22 · 基线 `cd899d6`
> 配套：`cloud/docs/release/chatgpt-directory-readiness.md`
>
> **本轮只做审计与列出待办，不改 `docs/privacy.html`、不虚构 Terms 条款、
> 不把未完成的法律页面标记为发布就绪。**
>
> 状态取值：`PASS` / `FAIL` / `NOT VERIFIED` / `NOT APPLICABLE`

---

## 0. 结论

`docs/privacy.html`（生效日期 2026-10-10）描述的是**纯本地、无账号、无网络**
的桌面应用。这个描述在**当时是准确的**，但 Cloud OAuth 与 Remote MCP 落地后
已经**不再准确**——其中三条是**事实性错误**（`FAIL`），不是措辞问题：

1. 「不注册、不登录、没有账号体系」——现在有 Google/GitHub 登录与 `users` 表；
2. 「本应用的核心功能没有任何网络请求」——Remote MCP 的工具调用**必然**出网；
3. 「不进入任何由我们控制的服务器」——OAuth 会话、设备、授权状态**确实在** Cloud 上。

此外还有**发布阻断项**：Privacy Policy URL 当前 404、Terms 页面不存在。

---

## 1. 实际数据路径（审计事实）

### 1.1 Cloud 持久化了什么

13 张表，**全部**是身份 / 会话 / 设备 / 授权 / 审计
（`cloud/src/db/schema.ts`；迁移 `0000` / `0001` / `0003`）：

| 类别 | 表 | 关键字段 |
|---|---|---|
| 账号 | `users` | `id`、`status`、`display_name`、`avatar_url`、时间戳（`:26-42`） |
| 账号 | `user_identities` | `provider`(google\|github)、`provider_subject`、`email`(可空)、`email_verified`（`:44-70`） |
| 会话 | `auth_sessions` | `refresh_token_hash`、`token_family`、`device_name`、`user_agent`、`ip_hash`（`:72-104`） |
| 设备 | `mcp_devices` | `name`、`platform`、`public_key`、`status`、各类哈希、`last_seen_at`（`:197-268`） |
| 授权 | `mcp_grants` | `client_id`、`client_name`、`scopes[]`、`resource`、`epoch`（`:281-325`） |
| 授权 | `mcp_oauth_clients` | `client_id`、`client_name`、`client_uri`、`redirect_uris[]`、`registration_source`（`:354-427`） |
| 授权 | `mcp_auth_requests` / `mcp_auth_codes` / `mcp_sessions` / `mcp_refresh_tokens` | rid、scope、resource、各类哈希、`ip_hash`、`user_agent` |
| 审计 | `auth_events` | `event_type`、`user_id`、`provider`、`session_id`、`ip_hash`、`detail jsonb`（`:148-169`） |
| OAuth | `oauth_transactions` / `oauth_codes` | Desktop 登录用的 state/code 哈希 |

**业务数据（记录 / 咖啡 / 画布）不入 Cloud**：

- `grep coffee|canvas|records` 在 `cloud/src` 只命中 scope 名、工具描述、白名单
  （`mcp-http/tools.ts`、`mcp-oauth/constants.ts`、`link/schemas.ts`），
  **无表、无写入**；
- `cloud/src` 内 `grep writeFile|createWriteStream|appendFile` **0 命中**；
- Cloud 侧对工具 payload 的唯一处理是**内存** registry
  （`link/forwarder.ts:1027-1039` → `link/request-registry.ts:206-224` 全是 `Map`）；
  `requestHash` 只用于在途去重，**不落库**（`forwarder.ts:1003-1007`）；
- 唯一的 DB 写是 `mcp_devices.grant_epoch` 与 `last_seen_at`
  （`forwarder.ts:627-636`、`link/link-server.ts:1380`）；
- 日志**不记** arguments 与结果正文（`mcp-http/handler.ts:62-66,77-80,193`）。

### 1.2 网络传输

- **工具调用的请求与响应经由 Cloud 转发**（HTTP `/mcp` → `handler.ts:180-191`
  → `link.dispatchToolCall` → `forwarder.ts:920+` → Desktop）。
  Cloud 是在线时的**中转与准入裁决点**，不是存储。
- OAuth 流程本身产生出网：Provider 登录（Google/GitHub）、PRM/AS 元数据、
  token 交换、WSS 长连接。
- **Desktop 离线时远程读取无法完成**（返回 `DEVICE_OFFLINE`，非空结果）。

### 1.3 Desktop 侧凭据

`Desktop/src/main/account/credentials.ts`：单文件 + Electron `safeStorage`
加密（macOS Keychain / Windows DPAPI），信封 `{version:1, alg:"safeStorage-v1"}`
（`:68-72,158`），路径 `<userData>/account/credentials.json`（`:22-24`），
权限 `0600`/`0700`、临时文件 + rename（`:83-84,160-166`）。
内容：`provider`、`userId`、`displayName`、`avatarUrl`、`createdAt`、`refreshToken`
（`:41-49`）。**明文只在主进程内存**，`save()` 立即加密。

### 1.4 审计日志

- Cloud `auth_events`：只记事件类型与最小上下文，**不记明文 token/code/secret**，
  IP 走 pepper 哈希（`cloud/src/db/audit.ts:4-9`）；
- Desktop `mcp_operation_log`（**本地 SQLite**，`Desktop/src/main/database/migrations.ts:341-352`）：
  `client_id`、`tool_name`、`entity_type`、`entity_id`、`success`、`error_code`、
  `idempotency_key`、`created_at`——**没有 arguments、没有结果正文**；
- Desktop `mcp_idempotency`（`:354-363`）：`request_digest`（哈希）用于去重。

---

## 2. 与现行政策冲突的条目（`FAIL`）

以下每条都是**事实性错误**，不是措辞优化。行号基于当前 `docs/privacy.html`。

| # | 位置 | 原文（节选） | 为什么不再成立 | 严重度 |
|---|---|---|---|---|
| 1 | `:105`（zh-data）<br>`:191`（en） | 「本应用**不要求任何个人信息**：不注册、不登录、没有账号体系。」<br>「The app **requires no personal information**: no sign-up, no login, no accounts.」 | Remote MCP 授权**必须**先用 Google 或 GitHub 登录；Cloud 建 `users` + `user_identities`（存 `display_name`、`avatar_url`、`email`、`provider_subject`） | **高** |
| 2 | `:113`（zh）<br>`:199`（en） | 「以上数据不含姓名、邮箱、电话号码、位置、设备标识符或任何可用于识别你身份的信息。」 | `user_identities.email`、`users.display_name`/`avatar_url` **就是**身份信息；`mcp_devices` 存设备名与平台 | **高** |
| 3 | `:119`（zh-store）<br>`:205`（en） | 「所有数据保存在**你设备上本应用的沙盒目录**中，不进入任何由我们控制的服务器」<br>「There is no developer-controlled server」 | 存在 Cloud：账号、会话、设备、授权、审计 13 张表（§1.1）。**业务数据仍不入云**，但「不进入任何服务器」是错的 | **高** |
| 4 | `:128`（zh-ml）<br>`:214`（en） | 「本应用的分析功能完全在设备上运行，**不联网**」 | 分析本身确实仍离线（这条**保留**），但同段落的绝对化表述会让读者以为整机不联网 | 中（需限定范围） |
| 5 | `:139`（zh-network）<br>`:225`（en） | 「**本应用的核心功能没有任何网络请求**——飞行模式下可完整使用。不存在遥测、使用统计、广告、崩溃上报或远程配置」 | Remote MCP 是**核心功能**且必须出网（OAuth + WSS + 工具转发）。后半句（无遥测/广告/崩溃上报/第三方 SDK）**仍然成立**，应保留 | **高** |
| 6 | `:142-143`（zh）<br>`:228-229`（en） | 「唯一的可选例外」= Ollama | 现在**不止一个**例外 | 中 |
| 7 | `:168`（zh-children）<br>`:254`（en） | 「本应用不收集任何用户的数据（如上所述…）」 | 依赖第 1/3 条的错误前提 | 中 |
| 8 | `:87`（header） | 「生效日期：2026 年 10 月 10 日」 | 内容已变，需改期 | 低 |

> **仍然准确、必须保留的表述**：Ollama 例外（`:142-143`）、端侧分析与 Core ML
> （`:126-135`）、iCloud 备份由 Apple 机制处理（`:121`）、导出 JSON/CSV 在本机生成
> （`:122`）、无遥测/广告/崩溃上报/第三方 SDK（`:139` 后半）、儿童条款的「不分年龄」
> 原则（`:166-170`）。

---

## 3. 需要更新的政策章节

按 `docs/privacy.html` 现有结构（zh 段 `:98-180`、en 段 `:184-266`），
**中英两段必须同步改**，且 nav（`:88-95`）需加锚点。

| 章节 | 现有 section id | 需要做什么 | 状态 |
|---|---|---|---|
| 关于本政策 | `#zh-about` / en | 补一句「含可选的 Remote MCP 云端协作能力（默认关闭）」 | 待改 |
| 我们处理哪些数据 | `#zh-data` / en | **重写**：区分「核心本地数据」与「启用 Remote MCP 后的账号/设备/授权数据」；逐项列出 §1.1 的字段类别；明确 `email`/`display_name`/`avatar_url` 来自你选择的 Google/GitHub | 待改 |
| 数据存储与保留 | `#zh-store` / en | **重写**：本地沙盒数据 vs Cloud 数据分开写；Cloud 存什么、不存什么（**不存业务数据**）；保留期与删除方式（撤销授权 / 删除账号 / `DELETE /mcp-devices/{id}`） | 待改 |
| 设备上的分析与预测 | `#zh-ml` / en | 基本保留，把「不联网」限定为「本节的分析功能不联网」 | 待改（限定范围） |
| 网络行为 | `#zh-network` / en | **重写**：列出启用 Remote MCP 后的实际出网（Provider 登录、OAuth 元数据与 token、WSS、工具调用转发）；保留「无遥测/广告/崩溃上报/第三方 SDK」；Ollama 从「唯一例外」改为「另一个可选例外」 | 待改 |
| **账号与第三方登录（新增）** | — | 新增章节：Google/GitHub 登录如何工作、Cloud 存哪些账号字段、如何登出与删除 | **新增** |
| **Remote MCP 与你的数据（新增）** | — | 新增章节：授权流程（逐项勾选）、数据流 `ChatGPT → Cloud → Desktop → Cloud → ChatGPT`、只读边界、Cloud 不落盘业务内容、Desktop 离线不可用、如何撤销 | **新增** |
| 系统权限 | `#zh-permissions` / en | 复核：Remote MCP 是否引入新系统权限（预计无） | 待核 |
| 你的控制权 | `#zh-rights` / en | 补：撤销授权、删除设备、删除 Cloud 账号数据的入口 | 待改 |
| 儿童隐私 | `#zh-children` / en | 修正依赖第 1/3 条的绝对化表述 | 待改 |
| 政策更新 / 联系我们 | `#zh-updates` / `#zh-contact` | 更新生效日期；联系方式仍为 GitHub Issues | 待改 |

---

## 4. 发布阻断项

| 项 | 状态 | 证据 |
|---|---|---|
| Privacy Policy URL 可访问 | **`FAIL`** | `Tools/Privacy-Compliance-Report.md:43-49`：`https://banmu123.github.io/BrewPhase/privacy.html` 当前 **404（GitHub Pages 未启用）**。上架前必须先启用 Pages 并确认 200 |
| Terms URL | **`FAIL`** | 未找到独立公开页面。**不得虚构条款**，也不得在目录表里标为就绪；需要真实起草与法务确认 |
| Developer Identity | `NOT VERIFIED` | 需确认 OpenAI Platform 个人或企业认证 |
| Domain Verification | `NOT VERIFIED` | 待 OpenAI Portal |

---

## 5. 本轮明确不做

- 不修改 `docs/privacy.html`（改写涉及事实陈述与法律措辞，需与 Terms 一并定稿）；
- 不创建 Terms 页面、不写占位条款；
- 不把 Privacy Policy / Terms 标为发布就绪；
- 不为上架而调整任何数据收集行为——**先如实记录现状，再决定要不要改行为**。

---

## 6. 建议的下一轮顺序

1. 按 §3 改写 `docs/privacy.html`（中英同步）+ 启用 GitHub Pages（解 §4 的 404）；
2. 起草 Terms（或明确在目录表里标 `NOT VERIFIED` 直到有真实页面）；
3. 与 `chatgpt-directory-readiness.md` 的 §6 清单一起复核，避免两份文档口径不一致。

---

## 2026-11-27 正式发版前安全审计补充（security/pre-release-hardening）

审计基线 `edf60c1`，报告见 `docs/security/PRE_RELEASE_SECURITY_AUDIT.md`。本轮在
上文 3 条 FAIL 之外**新确认**的隐私/披露不一致（已在上表基础上补充修复）：

1. 桌面端无 JSON/CSV 导出（政策承诺的是 iOS 能力，文档未区分平台）→ 已在
   privacy.html 增加「桌面端补充说明」章节（zh/en 双语）。
2. 桌面端存在政策未披露的**本地网络监听**：LAN 同步服务（47821，TLS）、
   MCP bridge（named pipe / unix socket）、Chrome bridge —— 已并入桌面端补充说明。
   其中 LAN 同步已在本轮完成 **TLS + 证书 pinning** 改造（协议 v2，见
   SYNC_PROTOCOL.md §0），明文凭证/内容传输问题已修复。
3. 「卸载会删除全部数据」在 Windows 不成立（`deleteAppDataOnUninstall: false`）→
   已并入桌面端补充说明。
4. 链接元数据抓取（og:image / YouTube / GitHub providers）向第三方出站 →
   已并入桌面端补充说明。
5. Remote MCP 经 Cloud 转发时 Cloud 技术上可接触请求参数与结果（不落库）→
   已并入桌面端补充说明，措辞与转发架构一致，不做「Cloud 完全不可见」的宣称。

**仍然未修复的披露事项**（发布前需要产品决策）：
- Privacy Policy URL 实际 404 / 无 Terms 页（上文已记录的发布阻断项）；
- 政策页面尚未区分 iOS 与 Desktop 两个产品的适用范围（本轮只在文档内加了
  补充章节，正式发布前建议把 privacy.html 拆分或改为双产品页）。
