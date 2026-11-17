# BrewPhase Remote MCP — 安全模型（Phase 1.0 设计）

> 与 `MCP_SECURITY.md`（Local MCP）互补，**不复用它的信任边界**。
> 本文只覆盖远程链路：MCP Client 授权、设备身份、Scope、Token 生命周期、
> 撤销、跨用户隔离、隐私与威胁模型。
> 架构见 `REMOTE_MCP_ARCHITECTURE.md`，协议见 `REMOTE_MCP_PROTOCOL.md`。

## 0. 三条不可让渡的前提

1. **Remote 与 Local 是两套凭据域。** `bp_mcp_*` token 永不出本机；
   Remote 用 `device_token` + MCP access token，两者互不派生、互不可换。
2. **Cloud 不持有数据，因此 Cloud 的泄露不等于数据泄露。** 这个性质必须靠
   「Gateway 不落业务数据」维持，一旦为了性能加缓存就失效。
3. **Desktop 有最终否决权。** Cloud 说允许不等于 Desktop 必须执行。

---

## 1. 信任边界

```
不可信
├─ ChatGPT / 任意远程 MCP Client
│    ├─ 可伪造任意 HTTP 请求 → 每请求验 JWT 签名 + aud + exp
│    ├─ 可重放截获的请求   → jti + 服务端去重 + 短 exp
│    └─ 可枚举 device_id   → device_id 不参与路由决策，只作提示
├─ 公网中间人
│    └─ 全链路 TLS；WSS 双向校验
├─ Cloud 运行环境（运维/日志/备份）
│    ├─ 只能看到 tool 名与状态码，看不到参数与结果
│    └─ 数据库里没有业务数据
└─ 设备凭证的持有者（若被窃取）
     └─ 私钥在 safeStorage；换机需用户重新确认

可信
├─ Desktop 主进程（唯一数据库所有者）
│    ├─ 本地开关 + 只读白名单 + scope 二次校验
│    └─ 审计唯一权威（mcp_operation_log.channel='remote'）
└─ Cloud 身份与会话服务（users / auth_sessions，现有实现）
```

**Cloud Gateway 是「半可信」**：它做第一道授权，但不是数据所有者。因此
Desktop 不能因为「Cloud 已经验过」就跳过自己的检查——两边都必须校验。

---

## 2. 五层权限模型

远程访问必须同时通过五层，任一层否决即拒绝：

| 层 | 主体 | 由谁校验 | 存储 | 粒度 |
|---|---|---|---|---|
| L1 Cloud 用户身份 | 人 | Cloud | `auth_sessions`（已有） | 账号级 |
| L2 MCP Client 授权 | AI 客户端 | Cloud | `mcp_grants`（新增） | client × user |
| L3 Desktop 设备授权 | 设备 | Cloud + Desktop | `devices`（新增） | device × user |
| L4 Tool Scope | 单次调用 | **Cloud + Desktop 各一次** | `mcp_grants.scopes` | tool 级 |
| L5 本地远程开关 | 用户 | Desktop | `local_state` | 全局 / 单设备 |

### 2.1 L1 → L2：ChatGPT 用户如何与 BrewPhase 用户关联

**唯一路径是用户在浏览器里显式登录并同意。** 不存在「用 ChatGPT 邮箱自动匹配
BrewPhase 账号」的通道。

```
ChatGPT                     Gateway                     用户浏览器
  │ GET /authorize            │                             │
  │  (client_id, redirect_uri,│                             │
  │   code_challenge, state)  │                             │
  ├──────────────────────────>│ 校验 client + redirect     │
  │                           │ 302 → /consent?tx=...       │
  │                           ├────────────────────────────>│
  │                           │                             │ 若未登录 → 走现有 Google/GitHub 登录
  │                           │                             │ 展示授权页（scope 逐项）
  │                           │<────────────────────────────┤ 用户点「允许」
  │                           │ 生成 grant（user_id,        │
  │                           │ client_id, scopes）         │
  │ 302 redirect_uri?code=... │                             │
  │<──────────────────────────┤                             │
  │ POST /token (code+verifier)                             │
  ├──────────────────────────>│ PKCE 校验 → 签 access token │
  │ access_token (aud=resource)                             │
  │<──────────────────────────┤                             │
```

铁律：

- **`user_id` 只从授权码换取，永不从请求体读。** 任何请求里出现 `user_id`
  一律忽略（不是「校验」，是「不读」）。
- **邮箱不是身份锚点。** 沿用现有 `user_identities` 的 `(provider, provider_subject)`
  唯一约束——同邮箱不自动合并用户（`cloud/src/db/schema.ts` 注释已明确）。
- **L1 会话 ≠ L2 授权。** 用户登录 Cloud 只证明「他是谁」；MCP 授权是独立
  grant，可单独撤销而不影响登录状态。

### 2.2 L2：MCP Client 授权的存储形态

```sql
mcp_grants (
  id              uuid primary key,
  user_id         uuid not null references users(id) on delete cascade,
  client_id       text not null,           -- 预注册或 DCR 得到的 client
  client_name     text not null,           -- 授权页展示用
  scopes          text[] not null,         -- 远程只读子集
  resource        text not null,           -- RFC 8707 resource indicator，绑定 Gateway URL
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  unique (user_id, client_id, resource)
)
```

- 一个用户可以有多个 grant（ChatGPT + 别的客户端），各自独立撤销。
- `resource` 参与 access token 的 `aud` 校验：token 不能拿到别的 MCP 服务上用。
- **不存** 用户对话内容、tool 参数、tool 结果。

### 2.3 L3：设备身份

设备凭证不是「一个随机字符串」，而是**密钥对**，避免 Cloud 侧数据库泄露即可冒充设备。

| 项 | 设计 |
|---|---|
| 算法 | Ed25519（`node:crypto` 原生支持，无需依赖） |
| 生成 | Desktop 首次启用远程访问时生成 |
| 私钥 | `safeStorage` 加密后存 `userData/remote/device.json`（目录 0700 / 文件 0600，先写 `.tmp` 再 rename，与 `account/credentials.ts` 同款纪律） |
| 公钥 | 注册时上传；`devices.public_key` 存 base64url |
| `device_id` | `uuid v4`，注册时 Cloud 生成并返回（不采用客户端自报，避免撞号） |
| 绑定 | `devices` 行绑定 `user_id`；换账号必须重新注册 |
| 轮换 | 支持：`POST /devices/{id}/rotate` 用旧私钥签名新公钥；旧公钥立即失效 |
| 撤销 | 用户在 Desktop 或 Web 撤销 → `revoked_at` + 断开 WSS + 清连接表 |
| 上限 | 单用户最多 5 台设备（防滥用与路由歧义） |

**注册必须由用户在场确认**：Desktop 发起注册后，Cloud 生成 6 位确认码返回，
Desktop 显示，用户在已登录的 Web 设置页输入确认码完成绑定。
纯静默注册会被「拿到 Cloud token 就能偷偷挂一台设备」利用。

### 2.4 L4：Scope 设计（远程子集）

远程第一版**只读 8 个工具、4 个 scope**：

| Scope | 工具 | 是否第一版开放 |
|---|---|---|
| `records:read` | `search_records`、`get_record` | ✅ |
| `tags:read` | `list_record_tags` | ✅ |
| `coffee:read` | `list_beans`、`list_brews`、`list_tastings` | ✅ |
| `canvas:read` | `list_canvases`、`get_canvas` | ✅ |
| `records:create` / `update`、`tags:create` | — | ❌ 不开放 |
| `canvas:write` | — | ❌ 不开放 |
| `work_context:*` | — | ❌ 不开放（个人工作上下文，远程收益最低） |
| `direction:read` / `propose` | — | ❌ 不开放 |
| `coffee:write`（不存在） | — | — |

命名沿用现有 `MCP_SCOPES` 的字符串，**但远程枚举独立定义**：

```ts
// 建议位置：Desktop/src/shared/contracts/remote.ts（新增）
export const REMOTE_SCOPES = [
  'records:read', 'tags:read', 'coffee:read', 'canvas:read'
] as const
```

理由：如果直接复用 `MCP_SCOPES`，将来给 Local 加写 scope 会**自动**出现在远程授权页上。
两个枚举之间加一条单测断言 `REMOTE_SCOPES ⊂ MCP_SCOPES` 即可保持一致，
但不会意外放宽。

### 2.5 L5：本地远程访问开关

| 状态 | 行为 |
|---|---|
| 关闭（默认） | 不建立 WSS；Cloud 侧无 connection；所有远程请求 `DEVICE_OFFLINE` |
| 打开 | 建立 WSS，Cloud 才能路由 |
| 关闭中（已有连接） | 先 `POST /devices/{id}/suspend` → Cloud 清连接表 → Desktop 断 WSS |

**默认关闭。** 用户必须主动打开，且打开时界面必须显示：「任何获得你授权的 AI
客户端都可以读取下列内容」，并逐项列出 4 个 scope 对应的具体数据。

---

## 3. Token 生命周期

### 3.1 三类 Token 对照

| | Local MCP token | MCP access token | `device_token` |
|---|---|---|---|
| 前缀 | `bp_mcp_` | JWT（无前缀） | `bp_dev_` |
| 生成方 | Desktop | Cloud Gateway | Cloud（绑定设备公钥） |
| 存储 | Desktop SQLite `mcp_clients.token_hash`（只存 sha256） | 不落库（无状态） | Cloud `devices.token_hash`（只存 sha256） |
| 生命周期 | 长期，手动撤销 | 15 分钟 | 30 天，可轮换 |
| 传递 | MCP 进程环境变量 | HTTPS `Authorization: Bearer` | WSS 握手 query/header |
| 出本机 | **永不** | 是（到 Cloud） | 是（到 Cloud） |
| 校验方 | Desktop | Cloud（+ Desktop 二次） | Cloud |

### 3.2 MCP access token（JWT）

```jsonc
{
  "iss": "https://cloud.example.com",
  "sub": "<user_id>",
  "aud": "https://cloud.example.com/mcp",   // RFC 8707 resource
  "grant_id": "<mcp_grants.id>",
  "client_id": "<client>",
  "scope": "records:read coffee:read",
  "iat": 1763400000, "exp": 1763400900,     // 15 min
  "jti": "<uuid>"
}
```

- 签名：复用现有 `sessions/jwt.ts` 的 keyring（支持 `JWT_SIGNING_KEY_PREVIOUS` 轮换）。
- **必须校验**：签名、`iss`、`aud`、`exp`、`grant` 未撤销。
- `jti` 只用于审计关联，**不做全局去重**（无状态校验的代价；防重放靠短 exp +
  服务端「同一 jti 在 5 分钟内重复出现」告警，不是硬拒绝）。

> 为什么 refresh token 也走同一套：MCP 客户端需要长期可用，15 分钟过期必须能续。
> refresh 复用现有 `auth_sessions` 的 rotation family 机制，但**独立 family**
> （`session_kind='mcp'`），MCP 的登出不撤销用户的 Desktop 登录会话。

### 3.3 `device_token`

- `bp_dev_` + `randomBytes(32).base64url`，Cloud 只存 `sha256`。
- 与 `devices` 行一一对应；轮换时旧 token 立即失效（不保留宽限）。
- **不与 `mcp_clients` 混用**：`device_id` 不能出现在 `mcp_operation_log.client_id`
  以外的任何 MCP 语义里。

---

## 4. 撤销矩阵

| 触发 | Cloud 动作 | Desktop 动作 | 生效时间 |
|---|---|---|---|
| 用户在 Web 撤销某个 MCP grant | `mcp_grants.revoked_at` + 该 grant 的 refresh family 全撤 | 无感（下次请求由 Cloud 拒） | 立即 |
| 用户在 Desktop 撤销某设备 | `devices.revoked_at` + 断开 connection + 删连接表项 | 删本地 `device.json` 私钥 | 立即 |
| 用户关闭远程开关 | `devices.status='suspended'` + 清连接表 | 断 WSS + 本地标记 | 立即 |
| 用户登出 Cloud | 该 user 全部 grant 撤销 + 全部 connection 断开 | `account-service.signOut()` 同时 `remote.disconnect()` | 立即 |
| 用户删除账号 | `users.status='deleted'`；级联删 grant/device | 同上 + 删 `remote/` | 立即 |
| 设备私钥解密失败 | — | 视为未授权，删除 device 记录并提示重新注册 | 立即 |
| Cloud 判定 refresh 重用 | 该 family 全撤（现有机制） | 收到 401 → 清凭据、断 WSS | 立即 |

**「立即」的实现要求**：Cloud 不能只依赖 access token 过期。
每次转发前必须查一次 grant 与 device 的当前状态（可用短 TTL 缓存，≤ 5 秒），
否则撤销后最多还有 15 分钟可用窗口——这在「用户点了撤销」的语义下不可接受。

---

## 5. 跨用户隔离与身份伪造防护

### 5.1 越权路径逐条封堵

| 攻击 | 为什么不可行 |
|---|---|
| 改请求体里的 `user_id` | 服务端**不读**该字段；`user_id` 只来自 JWT `sub` |
| 改 `device_id` 指向别人的设备 | 路由用 `(user_id, device_id)` 复合键；`user_id` 不匹配直接 404 而非 403（不泄露设备是否存在） |
| 用别人的 access token | JWT 签名校验失败；`aud` 不匹配；`grant_id` 不属于该 `sub` |
| 用自己账号的 token 读别人数据 | Desktop 端所有查询都以本机 SQLite 为界，没有「按 user_id 查」的入口——**Desktop 库本身就是单用户库**，这是最强的隔离 |
| 伪造 `connection_id` | 握手时 Cloud 生成，与 `(user_id, device_id)` 绑定；客户端无法指定 |
| 复用 Local MCP token 走远程 | Remote 路径不认 `bp_mcp_` 前缀，两套校验器物理分离 |

### 5.2 为什么「Desktop 是单用户库」是关键前提

Remote MCP 不需要在 SQL 层加 `where user_id = ?`——因为 Desktop 的 SQLite 里
只有一个人的数据。**任何试图给远程请求传 `user_id` 并据此过滤的设计都是错的**，
它会让「多用户库」这个错误假设渗进业务层。

正确表述：**隔离发生在 Cloud（谁能连到哪台设备），不在 SQL（查谁的行）。**

### 5.3 重放防护

| 面 | 机制 |
|---|---|
| `/authorize` | 双 State（Client State + Provider State，均只存哈希）；用后即删 |
| `/token` | 授权码 60s + 一次性 + PKCE S256 + `redirect_uri` 完全匹配；失败即焚码 |
| `/mcp`（HTTP） | access token 15 min；`jti` 记录 5 分钟窗口，重复出现触发告警并拒绝该请求 |
| WSS 请求帧 | `id` 由 Cloud 生成（uuid），Desktop 维护「已处理 id」LRU（2048 条 / 5 分钟）；重复到达直接回放上次结果（读操作天然幂等） |
| 设备握手 | 每次握手带 `nonce` + `ts`（±120s）+ Ed25519 签名；Cloud 用 `NonceStore`（复用 `sync/auth.ts` 的有界实现）判重 |

---

## 6. 数据隐私

### 6.1 Cloud 能看到什么

| 数据 | Cloud 是否可见 |
|---|---|
| 用户身份（provider subject / 邮箱） | ✅ 已有 |
| 设备（名称、平台、在线状态） | ✅ 新增 |
| 授权（哪个 client 拿到哪些 scope） | ✅ 新增 |
| **调用了哪个 tool** | ✅ 仅 tool 名 |
| **tool 参数**（搜索词、record_id） | ⚠️ **第一版不可避免**：Gateway 必须解析 args 才能转发 |
| **tool 结果**（记录正文、品鉴笔记） | ✅ 可见（在转发路径上），但**不落库、不落日志** |
| 完整业务库 | ❌ 不存在于 Cloud |

**必须诚实记录这一条**：Remote MCP 的流量经过 Cloud，Cloud 在内存里能看到
参数与结果。设计能做的是「不持久化、不进日志」，不能做「看不到」。
可选增强（Phase 1.5）：端到端加密（Desktop 生成会话密钥，Cloud 只转发密文），
但会让 Cloud 无法做结果级过滤，需要单独权衡。

### 6.2 日志纪律

在现有 `cloud/src/logger.ts` 的 `SENSITIVE_KEY_PATTERN` 基础上，MCP 事件必须额外：

- 只记 `tool`、`status`、`duration_ms`、`error_code`、`device_id`、`grant_id`
- **禁止**记 `params` / `result` / `text` / `note` / `body` / `title`
- `redact()` 的 key 正则加入：`args|params|result|content|note|body|title|search|url`
- 请求体永不进日志（现有 HTTP 日志已只记 method/path/status/duration，
  `cloud/src/app.ts` 的中间件是正确范例，照抄）

### 6.3 用户可见性

用户必须能在界面里看到，且能一键断：

1. 哪些 MCP Client 被授权，各自哪些 scope，最后一次调用时间
2. 哪些设备在线，最后活跃时间
3. 最近 N 次远程调用（tool 名 + 时间 + 成功/失败）——数据来自**本地**
   `mcp_operation_log`，不依赖 Cloud
4. 「立即断开全部远程访问」按钮

### 6.4 默认值

| 项 | 默认 |
|---|---|
| 远程访问开关 | **关** |
| 远程 scope | 空（授权时必须用户勾选） |
| 设备注册 | 需用户在场确认码 |
| 数据留存 | 无（Cloud 不存业务数据） |
| 日志留存 | 30 天（仅 tool 名与状态） |

---

## 7. 威胁模型

| # | 威胁 | 前提 | 影响 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| T1 | 恶意 MCP Client 骗取授权 | 用户点了「允许」 | 读取 4 个 scope 内的数据 | 授权页逐项列 scope + 明确「这会读取你的…」；可随时撤销 | 用户不看就点 |
| T2 | 授权码拦截 | 中间人 | 换取会话 | 全链路 TLS + PKCE + 60s + 一次性 | TLS 被破（超出范围） |
| T3 | access token 泄露 | 日志/内存 dump | 15 分钟内可读数据 | 短 exp + `aud` 绑定 + 不落库 | 15 分钟窗口 |
| T4 | device_token 泄露 | 本机文件被读 | 冒充设备上线 | 私钥 safeStorage 加密；token 只存哈希；可撤销 | 本机已被完全控制（超出范围） |
| T5 | Cloud 数据库泄露 | 拖库 | 拿到身份与设备元数据 | 无业务数据；token 只存哈希；公钥本身不是秘密 | 用户身份关联泄露 |
| T6 | 内鬼 / 运维看数据 | 有 Cloud 主机权限 | 流量里的记录正文 | 不落库不落日志；E2E 加密（Phase 1.5 可选） | 内存可见 |
| T7 | 跨用户越权 | 改 id | 读别人数据 | `user_id` 不来自请求体；`(user_id, device_id)` 复合路由；Desktop 单用户库 | — |
| T8 | 重放请求 | 截获一次请求 | 重复执行 | `jti` + `id` 去重 + 只读天然幂等 | 5 分钟窗口内首次重放可能成功 |
| T9 | 设备被撤销后仍能收请求 | 撤销时连接未清 | 越权 | 撤销 = 撤 grant + 断连 + 清路由表，三件事原子完成 | 转发途中的单条请求 |
| T10 | 伪造 Host 头 / DNS rebinding | 用户在浏览器访问恶意页 | 打到 Gateway | `hostHeaderValidationResponse` + `originValidationResponse`（SDK 已提供） | — |
| T11 | 资源耗尽 | 大量并发请求 | Gateway/Desktop 被打满 | 每 user 并发上限（4）+ 每设备并发上限（2）+ 请求体上限（256 KB）+ 严格 `limit` 上限 | — |
| T12 | 工具白名单漂移 | Cloud 与 Desktop 版本不同 | 越权调用 | 两端各存白名单 + 单测断言一致；Desktop 拒绝时返回 `TOOL_NOT_ALLOWED`（不是断连） | — |
| T13 | 本地开关关闭后仍可访问 | 只断连不撤授权 | 重连即恢复 | 关开关 = `suspended` + 清连接表；重开需用户再次确认 | — |
| T14 | 协议降级 | 中间人/旧客户端 | 绕过新校验 | 版本协商只允许 `1.x`；不支持即拒 | — |

---

## 8. 与 Local MCP 的边界（防回归）

| 要求 | 落地方式 |
|---|---|
| 不改 `bridge-server.ts` / `bridge-client.ts` / `mcp-bridge/*` 的既有分支 | Remote Agent **进程内**调 `HANDLERS`，不走 socket |
| Local token 不出本机 | `src/main/remote/` 不 import `McpClientService.authenticate`；单测断言目录依赖方向 |
| Local 的工具列表不变 | 远程白名单是**新常量**，不修改 `TOOL_DEFINITIONS` |
| Local 审计语义不变 | `mcp_operation_log.channel` 默认 `'local'`（migration 加列带默认值） |
| Windows Named Pipe 行为不变 | 零改动 |

**唯一允许触碰的既有代码**：`request-router.ts` 的 `HANDLERS` 从「模块私有常量」
改为「可注入/可导出」，以及 `routeBridgeRequest` 接受一个可选 `channel` 参数。
这两处都必须保持默认行为完全一致，并用现有 949 条单测回归。

---

## 9. 待确认

1. **是否需要 E2E 加密**：如果 ChatGPT 场景下用户能接受「Cloud 可见明文」，第一版不做；否则 Phase 1.5。
2. **DCR 是否必需**：若 ChatGPT 只支持预注册 client，可省掉 `/register` 与 `oauth_clients` 表。
3. **设备确认码的第二通道**：用户在 Web 输入 6 位码，前提是 Desktop 已登录同一账号。若用户未登录 Web，是否需要 Desktop 内直接完成？
4. **多设备时的路由策略**：同一用户两台 Desktop 在线时，是「任选一台」还是「全部广播」还是「用户指定主设备」？本文默认「用户指定主设备，其余标记备用」，需产品确认。
5. **审计留存期**：Cloud 侧 30 天是否合规要求足够。
