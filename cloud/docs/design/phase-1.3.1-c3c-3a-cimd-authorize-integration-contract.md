# BrewPhase Phase 1.3.1-C3c-3A — CIMD 授权接入契约与预检

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> 审查基线：`6c20908`（C3c-2-R2v 终态）
> 性质：**设计审查 / 规范对齐 / 架构决策 / 测试契约冻结**。
> **不实现接入**：本阶段不改 `/mcp/oauth/authorize` 的行为、不把
> `fetchClientMetadataDocument()` 接进真实请求链、不加迁移与依赖。
> 规范性标注约定：`[ID §x MUST]` = draft-ietf-oauth-client-id-metadata-document-03
> 的强制要求；`[RFC x]` = 已发布 RFC；`[项目策略]` = BrewPhase 自己的更严格选择，
> **不是**规范要求。

---

## 1. 规范版本与差异记录

| 项 | 值 |
|---|---|
| 文档 | `draft-ietf-oauth-client-id-metadata-document-03` |
| 状态 | **Internet-Draft**（"work in progress"，有效期 6 个月），**不是 RFC** |
| 发布日期 | 2026-11-02 |
| 过期 | 2027-05-06 |
| 作者 | Aaron Parecki (Okta), Emelia Smith |

**本项目此前文档里的版本标注有误**：`cimd.ts` 的文件头写「2025 年版本」，
R2v 之前的所有报告也只写「-03」而未记日期。本阶段已改为「2026-11-02」。

### 1.1 与 -02 的差异（只列影响实现的）

| 主题 | -03 的变化 | 对本项目的影响 |
|---|---|---|
| §5 Client Authentication | 明确 `token_endpoint_auth_methods_supported`（OpenID.RPMetadataChoices）优先；两者都缺时 **MUST** 按 `none`；**MUST NOT** 套用 RFC 7591 的 `client_secret_basic` 默认 | 现有实现「只接受 none、出现共享密钥方式即拒」符合；需补「两个字段都缺 → none」的测试 |
| §5 | 两者同时出现时 `token_endpoint_auth_method` **MUST** 属于 `..._methods_supported` | **新增判据**，当前未实现 → C3c-3B 补 |
| §5 | AS 不支持文档声明的任何认证方式时 **MUST** 以 `invalid_client` 中止 | 等价于「交集为空」，当前按 unsupported_client 拒绝，映射正确 |
| §6 | `grant_types` / `response_types` 交集为空 **MUST** `invalid_client` | 已实现「无交集即拒」，但**错误码**要到 authorize/token 层才体现（见 §4.3） |
| §4.4 | 明确 informative URI 不得要求与 `client_id` 同源 | 现有实现不要求同源，符合 |
| §10.5 | 新增 jwks 变更的处置叙述（may revoke） | 本项目不用 jwks，记为「无影响」 |

---

## 2. 当前代码结构（事实核对）

### 2.1 CIMD 抓取器的能力边界

`fetchClientMetadataDocument(clientId, deps)` 今天只做：

URL 形态校验 → DNS（全量）→ SSRF 分类 → 固定 IP 请求 → TLS → 状态/类型/大小 →
JSON → 文档字段 → 缓存策略计算 → `transient|terminal` 分类。

它**不做**：数据库读写、注册、授权、撤销、审计。`createCimdDeps()` 目前也**没有
任何调用方**（只在测试里用）。这一点在接入时必须保持——抓取器是纯函数式的边界，
副作用全部由调用方在同一事务里完成。

### 2.2 Authorize 的现状

`validateAuthorizeParams()`（`authorize-flow.ts`）只认 `mcp_oauth_clients` 里的行：

| 检查 | 现状 |
|---|---|
| `client_id` | 非空且 ≤ **512**；查不到 → `invalidRequest("client is not registered")` |
| `grant_types` | 必须含 `authorization_code` |
| `redirect_uri` | **逐字符**精确匹配注册值 |
| `scope` | 必须是 `MCP_SCOPES` 的非空子集 |
| `resource` | 必须逐字符等于 `mcpResourceFor(baseUrl)` |
| `code_challenge_method` | 只接受 `S256` |

路由 `GET /mcp/oauth/authorize` 抛错后由 `app.onError` → `respondError()` 输出
**JSON 错误**（不是 HTML 页），且**不重定向**。这一点符合草案 §6.1「失败时
MUST NOT 把用户重定向到客户端」，但用户在浏览器里会看到一段 JSON——C3c-3B 要
改成 HTML 错误页（见 §5.4）。

### 2.3 同意流程没有「跳过」路径

`consent-flow.ts` 每次授权都渲染同意页；既有 grant 只用于 **step-up** 的 scope
并集，不用于跳过同意。这直接决定了 §7 的「元数据变化」策略：`redirect_uris`
改变**不会**让一次授权静默通过——用户每次都要看到同意页。

### 2.4 表结构与约束（与接入相关的部分）

| 表 | 关键列 / 约束 |
|---|---|
| `mcp_oauth_clients` | PK `client_id`；`registration_source ∈ {pre_registered,cimd,dcr}`；`redirect_uris` 1–5；`auth_method = 'none'`；`metadata_fetched_at` / `metadata_cache_expires_at` 可空 |
| `mcp_auth_requests` | `client_id` / `redirect_uri` / `scope` / `resource` / `state` / `code_challenge` / 10 分钟 `expires_at`；**没有** `client_name`，同意页靠 LEFT JOIN 取 |
| `mcp_sessions` | `client_id`、`grant_id`、`revoked_at`、`revoked_reason CHECK ∈ {user_revoke, grant_revoked, refresh_reuse, client_revoke}` |
| `mcp_refresh_tokens` | 「同一 session 最多一条未消费」唯一索引——refresh token 的有效性由 **session 未撤销** 决定 |
| `mcp_grants` | `unique(user_id, client_id, resource)`，`revoked_at`、`epoch` |
| `auth_events` | `user_id` **可空**，`detail` jsonb |

---

## 3. 注册来源与优先级

| 现有行 | 收到 authorize | 行为 | 依据 |
|---|---|---|---|
| `pre_registered` | 任意 | **直接用该行**，永不抓取、永不覆盖 | [项目策略]；[ID §9.2] 允许预注册关联 |
| `dcr` | 任意 | 同 pre_registered（本轮不实现 DCR，也不得被 CIMD 顶掉） | [项目策略] |
| `cimd` 且 `metadata_cache_expires_at > now` | 任意 | 直接用缓存，**不发网络请求** | [ID §6.2] 允许缓存 |
| `cimd` 且已过期 | 任意 | 重新抓取（见 §4） | [ID §6] SHOULD 周期性重取 |
| 不存在，`client_id` 是合法 CIMD URL | 任意 | 抓取 → 注册 → 继续授权 | [ID §6] |
| 不存在，`client_id` 不是合法 CIMD URL | 任意 | **拒绝**，不发起任何网络请求 | [项目策略]（避免把任意字符串当 URL 抓） |

**判定顺序（C3c-3B 必须照此实现）**：

```
1. 长度：client_id > 2048 → 拒绝（不做任何解析）
2. 形态：validateClientIdentifierUrl(client_id)
     ok  → 走 CIMD 路径
     fail → 若 length > 512 → 拒绝；否则按既有 512 上限走「未注册」拒绝
3. 查 mcp_oauth_clients
     有行 → 按 registration_source 分支（pre_registered / dcr 直接使用；cimd 看缓存）
     无行 → 第 2 步 ok 才抓取，否则拒绝
```

**为什么不是「先查库再判形态」**：先查库不会错，但会让「一个不存在的
`https://…` URL」也走到「未注册」分支而无法区分「该抓」与「不该抓」。形态判断
必须在前，且必须在**原始字符串**上做。

### 3.1 `client_id` 长度的协调

| 场景 | 上限 | 理由 |
|---|---|---|
| CIMD URL（形态校验通过） | **2048**（`cimd.MAX_URL_LENGTH`） | URL 天然长；与 `validateInformationalUri` 共用同一常量 |
| 非 URL 的 `client_id` | **512**（`authorize-flow` 现值） | 预注册 id 是随机串，512 已极宽松 |
| 预注册行 | 512 | 不变；放宽只作用于 CIMD 分支，不影响既有校验 |

**不允许**为了统一而把 512 直接抬到 2048：那会让所有预注册客户端的校验一起变松。

---

## 4. 缓存状态机

```
                 ┌──────────── fetch 成功且可缓存 ────────────┐
                 ↓                                            │
ABSENT ──fetch──> FRESH ──(now > expires)──> STALE ──refetch──┤
  │                 ↑                            │            │
  │                 └──── refetch 成功 ───────────┘            │
  │                                                          │
  └── fetch 失败 ──> (不写行)                                 │
                                                             ↓
STALE/FRESH ──terminal（策略类）──> INVALID（revoked 语义，见 §5）
```

| 状态 | 判定 | 行为 |
|---|---|---|
| `ABSENT` | 无行 | 抓取；成功→写行；失败→不写行 |
| `FRESH` | `metadata_cache_expires_at > now` | 直接使用（零网络） |
| `STALE` | 有行且 `expires_at <= now` | 抓取；成功→更新；transient→**保留旧行**但当前请求中止；terminal→见 §5 |
| `INVALID` | 行被标记不可用（`metadata_cache_expires_at = epoch`） | 拒绝授权，直到下一次成功抓取 |

**`metadata_cache_expires_at = NULL` 的语义**：从未成功抓取过（理论上不该出现在
`cimd` 行上）。C3c-3B 写入时**必须**给非空值；读到 NULL 视为 `STALE`（fail-safe）。

### 4.1 重取下限（fetch floor）

即使缓存已过期，同一 `client_id` 的两次抓取间隔不得小于 **30 秒**
[项目策略]。理由：`no-cache` 的文档会把 `expires_at` 设成抓取时刻，没有下限
就是「每次授权都抓一次」，等于给对端一个放大器。低于下限时按 `STALE` 使用旧行，
但**不**更新 `metadata_fetched_at`（见 §5.1「不伪装新鲜」）。

---

## 5. transient / terminal 决策矩阵

### 5.1 transient

| 失败 | 当前请求 | 缓存行 | Session | Refresh Token | Grant | 审计 | 重试 |
|---|---|---|---|---|---|---|---|
| DNS 失败 / 无结果 | **中止**，HTML 错误页，无重定向 | 保留原行与原时间戳 | 不动 | 不动（仍有效） | 不动 | `mcp_cimd_fetch_transient`（含 kind） | 下次 authorize 再试 |
| DNS 超时 / 连接超时 / 总超时 | 同上 | 同上 | 不动 | 不动 | 不动 | 同上 | 同上 |
| 代理连接失败 / TLS 握手失败 | 同上 | 同上 | 不动 | 不动 | 不动 | 同上 | 同上 |
| 429 / 5xx | 同上 | 同上 | 不动 | 不动 | 不动 | 同上 | 遵守 `Retry-After`（若有）作为 floor |

依据：[ID §6.1]「transient failure SHOULD NOT by itself invalidate … trust or
outstanding refresh tokens」「SHOULD NOT discard previously cached valid client
metadata」；「fetching fails → SHOULD abort the authorization request」。
**注意**：`SHOULD abort` 针对的是**当前请求**，不是缓存；两者不能混。

### 5.2 terminal

| 原因 | 当前请求 | 缓存行 | Session / Refresh | Grant | 审计 |
|---|---|---|---|---|---|
| `client_id_mismatch` | 中止 | **标记不可用**（`expires_at = epoch`），保留行供取证 | **撤销该 client_id 的全部 Session**（见 §5.3） | 不动 | `mcp_client_id_mismatch`（含 revokedCount） |
| 非法 JSON / 非对象 | 中止 | 标记不可用 | 不动 [项目策略] | 不动 | `mcp_cimd_document_invalid` |
| 文档字段非法（含 redirect_uris、informational URI、长度） | 中止 | 标记不可用 | 不动 | 不动 | 同上（detail 带字段名） |
| SSRF 地址 | 中止 | 标记不可用 | 不动 | 不动 | `mcp_cimd_ssrf_blocked`（含 address，不进日志明文？见 §5.5） |
| 不支持的客户端（shared secret / 非 none / 私钥） | 中止 | 标记不可用 | 不动 | 不动 | `mcp_cimd_unsupported_client` |
| `grant_types` / `response_types` 交集为空 | 中止 | 标记不可用 | 不动 | 不动 | `mcp_cimd_unsupported_grant` |
| 3xx / 非 200 / Content-Type / 超限 | 中止 | 标记不可用 | 不动 | 不动 | `mcp_cimd_http_invalid` |
| TLS 证书失败（目标） | 中止 | 标记不可用 | 不动 | 不动 | `mcp_cimd_tls_failure` |

依据：[ID §6.1] 只有 `client_id` mismatch **SHOULD** 立即失效 refresh token；
其它 terminal 是 **MAY**（由 AS 裁量）。**本项目的裁量**：只有
`client_id_mismatch` 撤销 Session；其余 terminal 只拒绝当前请求 + 标记缓存
不可用，不动 Session / Refresh Token —— 因为「文档写坏了」不等于「已签发的
令牌必须作废」，过度撤销会把一次文档发布事故放大成全量掉线。

### 5.3 `client_id_mismatch` 的撤销语义

**范围**：该 `client_id` 下的**全部** Session（跨用户、跨设备）。理由：客户端
身份本身不再可信（文档自称属于另一个 client），任何用该身份签发的 refresh
token 都不应继续有效 [ID §6.1 SHOULD]。

**实现（C3c-3B）**：新增 `revokeMcpSessionsByClient(deps, { clientId, reason })`，
照抄 `revokeMcpSessionsByGrant` 的形状：

```sql
UPDATE mcp_sessions
   SET revoked_at = $now, revoked_reason = 'client_id_mismatch'
 WHERE client_id = $clientId AND revoked_at IS NULL
RETURNING id, user_id
```

- **单条 UPDATE**（原子），不在应用层逐行撤销——逐行会漏、也会放大事务。
- **审计一条聚合事件**：`mcp_session_revoked`，`user_id = NULL`，
  `detail = { reason, clientId, revokedCount }`。不按用户拆：跨用户撤销用单条
  事件表达「一次动作影响 N 条会话」，与 grant 级撤销的既有做法一致。
- **不动 Grant**：grant 是「用户曾同意这个 client 访问这个 resource」的记录，
  身份失效时保留它可以避免「重新授权后 epoch 重置」。若复审认为应一并失效，
  属于策略升级，需单独决策。
- **不动其它 client_id**：`WHERE client_id = $1` 是唯一判据，不用前缀/模糊匹配。
  测试必须证明「另一个 client 的 session 保持不变」。

**已知缺口（必须写进报告）**：撤销 Session 只让 refresh token 失效；**已签发的
Access Token（JWT）在过期前仍然有效**（≤15 分钟），因为资源服务器 `/mcp` 的
「按 `sid` 回查 Session」属于 1.3.2，尚未实现。这不是本阶段引入的问题，但接入
时必须记录在案。

### 5.4 错误如何呈现

| 端点 | 失败响应 | 约束 |
|---|---|---|
| `GET /authorize` | **HTML 错误页**（400/503），页面文案说明「无法验证该客户端」 | [ID §6.1 MUST NOT] 不得重定向到客户端 |
| Token / PAR | JSON `invalid_client`；transient → HTTP **503** | [ID §6.1 MUST] |

现状 `app.onError` 输出 JSON——C3c-3B 必须在 authorize 处理器里**显式**捕获
CIMD 失败并渲染 `renderErrorPage()`，不能依赖全局处理器（否则浏览器看到 JSON）。
另一个纪律：错误页**不得**回显 `client_id` 的完整 URL（可能很长且含攻击者可控
内容），只显示主机名或截断形式。

### 5.5 审计事件与隐私

- `detail` 里**不写**完整文档、不写 redirect_uri 全文、不写 IP；
- `ssrf_address` 记录被拒绝的地址是必要的取证信息（地址本身不是凭据）；
- 事件类型统一 `mcp_cimd_*` 前缀，便于按前缀检索。

---

## 6. `Cache-Control: no-store` 的处理

### 6.1 三个候选

| 方案 | 做法 | 隐私 | 多实例 | 复杂度 |
|---|---|---|---|---|
| A 拒绝 | 视为「不支持的注册形态」，`invalid_client` | 最好（不落库） | 无影响 | 最低 |
| B 写「立刻过期」的行 | 行存在但 `expires_at = now`，每次重抓 | 差（no-store 要求不存储，我们仍存了 name/uris） | 无影响 | 低 |
| C 不落库，用 `mcp_auth_requests` 快照 | 需要新列（client_name 等）| 中（仍落库） | 无影响 | 中 |
| D 进程内临时保存 | Map | 好 | **不安全**（多实例/重启丢） | 中 |

### 6.2 决策：**选 A（拒绝）**

理由：

1. `no-store` 的语义是「不要把这份响应存下来」。B/C 都必然落库（授权码流程要跨
   两个请求：authorize → token），与语义冲突。
2. D 在当前部署（`GATEWAY_EXPECTED_REPLICAS = 1`）勉强可行，但把正确性建立在
   「只有一个副本」上，与既有架构纪律相悖（`env.ts` 已经在拒绝多副本）。
3. A 的代价是「带 `no-store` 的客户端无法接入」。这类客户端在 CIMD 生态里很少
   （主流实现给 `max-age`），且失败是**显式**的（用户看到错误页），不是静默降级。

**落地**：`cache.storable === false` → C3c-3B 返回 terminal
`client_registration_unsupported`，**不写任何行**，审计
`mcp_cimd_no_store_rejected`。这是 **[项目策略]**，不是草案要求（草案没有规定
AS 必须拒绝 no-store 的客户端）。

**若未来要支持**（记录备选）：在 `mcp_oauth_clients` 增加
`metadata_ephemeral boolean not null default false`，token 端点对 ephemeral 行
强制重抓一次并比对 `redirect_uris`；需要一次迁移与一条新的并发路径，成本明显
高于收益。

---

## 7. 元数据变化（§10.5）

前提：**每次授权都经过同意页**（§2.3），不存在「有 grant 就静默通过」的路径。

| 字段 | 变化后的处理 | 依据 |
|---|---|---|
| `redirect_uris` | 更新行；**不动** Session / Refresh / Grant（既有令牌与回调无关）；下一次授权按新集合精确匹配并重新征得同意 | [ID §10.5] 允许 AS 自定 |
| `grant_types` / `response_types` | 更新行；若交集为空 → terminal（§5.2），但**不撤销既有令牌** | [ID §6 MUST] 交集为空拒绝**请求**，未要求撤销令牌 |
| `token_endpoint_auth_method(_methods_supported)` | 只接受 `none`；变成共享密钥方式 → terminal + 标记缓存不可用（不撤销令牌，除非复审要求） | [ID §4.1 MUST NOT] |
| `client_name` | 更新行（同意页立即生效） | 展示字段 |
| `client_uri` / `logo_uri` | 更新行；**从不抓取** | [ID §4.4] |
| `jwks` / `jwks_uri` | 只校验形态与「不得同时出现」，**不抓取、不用于认证**；变化无影响 | [项目策略] 只支持 `none` |

**为什么不做「元数据变化 → 撤销令牌」的通用规则**：草案把这件事留给 AS
（§10.5 全是 should/may）。本项目的风险模型是「同意页每次都出现 + redirect_uri
逐字符匹配」，令牌不依赖这些字段；通用撤销只会制造无谓的掉线。**唯一**例外是
`client_id_mismatch`（身份级别的失败）。

---

## 8. 并发与数据库一致性

| 场景 | 机制 |
|---|---|
| 两个并发首次注册同一 URL | `INSERT … ON CONFLICT (client_id) DO NOTHING` → 未插入则重读；**不**先 SELECT 再 INSERT |
| 并发刷新同一 client | **CAS**：`UPDATE … WHERE client_id = $1 AND metadata_fetched_at IS NOT DISTINCT FROM $2`；影响 0 行说明别人先写了，重读并放弃本次结果 |
| 抓取风暴 | 进程内 singleflight（**只做合并，不做正确性**）+ 30s fetch floor（§4.1） |
| 多实例 | 正确性完全由上面的 ON CONFLICT / CAS 保证；进程内 Map 只是省一次网络 |
| 旧数据覆盖新数据 | CAS 的 `metadata_fetched_at` 是版本令牌；**不用** `clock now()` 比较（时钟回拨会破坏顺序） |
| 抓取失败但并发成功 | 失败方不写任何东西（连 `metadata_fetched_at` 都不动）→ 天然不会覆盖 |

**禁止**：用「先 DELETE 再 INSERT」表达刷新（会让并发的授权读到空行）。

---

## 9. 环境变量与代理

### 9.1 现状

`createCimdDeps(env = process.env)`、`resolvePinnedProxy(hostname, env)`、
`requestPinnedHttps({ env })` 直接读 `process.env`；`Env` 里没有代理字段。
这意味着**测试与生产的代理来源不可审计**，也解释了 R2v 发现的 F10（直连用例
被宿主机 `HTTPS_PROXY` 劫持）。

### 9.2 决策

| 问题 | 决策 |
|---|---|
| 从哪读 | `loadEnv()` 统一解析成 `Env.outboundProxy = { url: string \| null, noProxy: string, scheme: "http" \| "https" \| "unsupported" }`；`process.env` 只出现在 `env.ts` |
| 允许哪些变量 | `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（含小写形式），优先级 `HTTPS_PROXY > HTTP_PROXY`，与现行 `resolveProviderFetch` 一致 |
| 大小写冲突 | 大写优先；两者都存在时以大写为准（记录一次 warn） |
| 不支持的协议（socks5） | `scheme: "unsupported"`；**Provider** 保持「warn + 直连」；**CIMD** 在抓取时直接 transient 失败（绝不直连） |
| 生产是否继承宿主机代理 | **允许**（容器化部署普遍依赖这三个变量），但必须在 `loadEnv()` 里显式读出来并记录一次启动日志；不做“隐式继承” |
| Provider 与 CIMD 是否共用 | **共用同一个 `Env.outboundProxy`**：一台机器只有一条出网路径，两套配置只会产生「provider 能通、CIMD 不能」的诡异故障 |
| 测试 | 所有 CIMD/代理测试**显式**传 `env`（3B 把 R2v 的 `env: {}` 推广到 `createCimdDeps` 的调用点），禁止依赖执行机器 |

**注入点（C3c-3B）**：

```ts
// env.ts
outboundProxy: { url: string | null; noProxy: string; scheme: "http" | "https" | "unsupported" };

// 调用方
const deps = createCimdDeps(env.outboundProxy);   // 不再默认 process.env
```

`createCimdDeps` 的默认参数**移除**（fail-fast：不传就编译不过），避免再出现
「测试漏传 → 走宿主机代理」。

---

## 10. TLS 信任锚（`ca`）的语义

### 10.1 事实（Node 官方文档，`tls.createSecureContext`）

> `ca` {string|string[]|Buffer|Buffer[]} Optionally override the trusted CA
> certificates. … **If specified, the default list would be completely replaced
> (instead of being concatenated)** by the certificates in the `ca` option.

即：传给 `tls.connect()` 的 `ca` 会**完全替换**默认信任链，不是追加。R2 的
JSDoc 把它类比成 `NODE_EXTRA_CA_CERTS`（后者是**追加**），**这个类比是错的**。

### 10.2 决策

| 问题 | 决策 |
|---|---|
| 是否保留 | 保留，但**改名为 `caOverride`**，只作为**测试注入**；生产入口不暴露 |
| 为什么保留 | HTTPS 目标的正向路径（SNI / Host / 证书校验成功）没有它就无法自动化验证；删掉只能退回「只测失败路径」 |
| 是否重命名 | 是。`ca` 太容易被读成「追加」，改名后与 Node 语义一致 |
| 代理与目标是否分开 | **分开**：`openTunnel` 的 `ca` 用于代理跳，`PinnedRequestOptions.caOverride` 用于目标跳；两者不共用一个字段（C3c-2-R2 曾因共用而漏传目标跳，已修） |
| 如何证明生产默认信任 | ① 现有测试「目标证书不受信任时拒绝」（不传 ca 时自签名必须失败）；② 新增静态检查：`createCimdDeps` 不设置 `caOverride`；③ 3B 在 code review checklist 里列一条 |
| 是否允许用户提交 CA | **绝对不允许**。任何来自 CIMD 文档或请求参数的值都不得进入 TLS 配置 |

**本阶段不改代码**（除注释）：重命名与默认参数移除在 C3c-3B 一并做，避免
半改状态。

---

## 11. 数据模型变更判断

| 需求 | 是否需要迁移 | 结论 |
|---|---|---|
| 注册 / 缓存 | 否 | 复用 `registration_source` / `metadata_fetched_at` / `metadata_cache_expires_at` |
| `no-store` | 否 | 选择拒绝（§6） |
| 撤销原因 | **是（1 条 CHECK）** | `mcp_sessions_revoked_reason_check` 增加 `client_id_mismatch`；理由：审计必须能区分「客户端主动撤销」与「服务端判定身份失效」，复用 `client_revoke` 会污染审计 |
| 抓取失败记录 | 否 | 用 `auth_events`，不加表 |
| 并发版本号 | 否 | `metadata_fetched_at` 直接做 CAS 令牌 |

迁移只改约束（`DROP CONSTRAINT` + `ADD CONSTRAINT`），不重写数据、不加列。

---

## 12. C3c-3B 实施任务拆分（顺序即依赖）

| # | 任务 | 产出 |
|---|---|---|
| 1 | `env.ts` 增加 `outboundProxy` 解析 + 启动日志；`createCimdDeps` 去掉默认参数 | 配置入口唯一化 |
| 2 | `proxy-fetch.ts`：`ca` → `caOverride`（注释 + 命名），测试跟随 | 语义修正 |
| 3 | 迁移 `0004_mcp_session_revoked_reason.sql`：扩充 CHECK | 数据模型 |
| 4 | `cimd-registry.ts`（新）：`resolveClientForAuthorize()`——形态判定、查行、缓存状态、抓取、注册、CAS 刷新 | 纯逻辑 + 注入 deps |
| 5 | `sessions.ts` 增加 `revokeMcpSessionsByClient()` | 撤销语义 |
| 6 | `authorize-flow.ts`：未注册 → 调 #4；错误 → 明确异常类型（区分 transient/terminal） | 接入点 |
| 7 | `routes/mcp-oauth.ts`：HTML 错误页（不重定向）、审计事件 | 用户可见行为 |
| 8 | token 端点：CIMD 客户端的 `invalid_client` / 503 映射（仅当实现 PAR 或 token 需要时） | 规范对齐 |
| 9 | 测试矩阵（§13 全部 22 条） | 验收 |
| 10 | AS Metadata 声明 `client_id_metadata_document_supported: true` | **最后一步**，见下 |

**声明 `client_id_metadata_document_supported` 的前置条件**（缺一不可）：

1. #1–#9 全部完成并通过全量门禁；
2. 至少一个真实客户端（ChatGPT / Grok）走通 CIMD 授权；
3. `no-store` 的拒绝行为有测试；
4. 撤销语义有测试（含「不影响其它 client」）。

在此之前 Discovery 的十字段结构**不得**增加该字段。

### 12.1 C3c-3B 明确不包含

DCR、`registration_endpoint`、`/mcp` 工具业务、Desktop 改动、无关 OAuth 重构、
真实客户端联调（属 1.3.3）。

---

## 13. 测试验收矩阵

列含义：`HTTP` = 期望响应；`DB` = `mcp_oauth_clients` 变化；`S/R/G` = Session /
Refresh / Grant 是否变化；`审计` = 是否产生事件；`重试` = 是否允许下次再试。

| # | 输入 | HTTP | DB | S/R/G | 审计 | 重试 |
|---|---|---|---|---|---|---|
| 1 | 预注册 client authorize | 302 → login | 无写入 | 无 | `authorize_started` | — |
| 2 | CIMD 缓存未过期 | 302 → login | 无写入 | 无 | 同上 | — |
| 3 | CIMD 缓存过期 + 抓取成功 | 302 | `fetched_at` / `expires_at` 更新 | 无 | 同上 + `cimd_refreshed` | — |
| 4 | 首次成功注册 | 302 | INSERT（`source=cimd`） | 无 | `cimd_registered` | — |
| 5 | 首次 transient 失败 | 503 HTML 页 | **无行** | 无 | `cimd_fetch_transient` | 是 |
| 6 | 首次 terminal 失败（文档非法） | 400 HTML 页 | **无行** | 无 | `cimd_document_invalid` | 下次可再试（仍会失败） |
| 7 | 有缓存 + transient | 503 HTML 页 | 行保留，时间戳不变 | 无 | `cimd_fetch_transient` | 是 |
| 8 | 有缓存 + transient（已有 token） | 同上 | 同上 | Refresh 仍有效 | 同上 | 是 |
| 9 | `client_id_mismatch` | 400 HTML 页 | `expires_at = epoch` | **该 client 全部 Session 撤销** | `client_id_mismatch` | 否 |
| 10 | `client_id_mismatch` 时有其它 client 的 Session | 同上 | 同上 | **其它 client 不受影响** | 同上 | — |
| 11 | 非法文档不覆盖合法缓存 | 400 | 旧行内容不变（只标 `expires_at`） | 无 | `cimd_document_invalid` | — |
| 12 | `no-store` 文档 | 400 | **无行** | 无 | `no_store_rejected` | 否 |
| 13 | 并发首次注册 ×2 | 都是 302 | 恰好 1 行 | 无 | 1 条注册 + 1 条命中 | — |
| 14 | 并发刷新（新旧交错） | 302 | 最终是新数据（CAS） | 无 | — | — |
| 15 | redirect_uri 少一个字符 | 400 | 不变 | 无 | `redirect_mismatch` | 否 |
| 16 | 非法 scope | 400 | 不变 | 无 | 同上 | 否 |
| 17 | resource 不匹配 | 400 | 不变 | 无 | 同上 | 否 |
| 18 | `code_challenge_method=plain` | 400 | 不变 | 无 | 同上 | 否 |
| 19 | CIMD 客户端带 `client_secret` 请求 token | 401 `invalid_client` | 不变 | 无 | `client_auth_rejected` | 否 |
| 20 | 直连 / 代理两种 `env` 下跑 #1–#19 | 一致 | 一致 | 一致 | 一致 | — |
| 21 | 两个客户端交替授权 | 各自的 Session / Grant 正确 | 各自行 | 互不影响 | — | — |
| 22 | 文档获取失败时检查重定向 | **没有任何 3xx 到 client** | — | — | — | — |

补充（不占编号）：

- `token_endpoint_auth_method` 与 `..._methods_supported` 同时出现但不自洽 → terminal（§1.1）；
- `client_id` 长度 2048 边界：2048 通过形态校验、2049 拒绝；
- 预注册客户端**绝不**触发网络（用注入的 `fetch` 计数断言为 0）。

---

## 14. 风险与未决问题

| # | 风险 | 处置 |
|---|---|---|
| 1 | 撤销 Session 不影响已在流通的 Access Token（≤15 分钟） | 记录在案；1.3.2 的 `/mcp` 按 `sid` 回查后闭合 |
| 2 | `no-store` 客户端无法接入 | 显式拒绝 + 用户可见错误；记录备选方案（§6.2） |
| 3 | 抓取失败导致授权不可用（对端长期挂掉） | 缓存保留 + 30s floor；不做「无限期信任旧数据」 |
| 4 | 多实例下 singleflight 失效 | 正确性由 DB 保证；性能问题留待扩容时再评估 |
| 5 | `client_id_mismatch` 跨用户撤销的审计粒度 | 单条聚合事件（`user_id = NULL`）；若审计要求按用户拆分，需要改事件模型 |
| 6 | 真实客户端未联调 | 属 1.3.3；声明 `client_id_metadata_document_supported` 之前必须完成 |
| 7 | 迁移 0004 改 CHECK 需要锁表 | 表小、`ALTER TABLE … ADD CONSTRAINT` 秒级；在维护窗口执行 |

**未决（需要复审拍板）**：

1. `client_id_mismatch` 是否也应撤销 Grant（当前：不撤销）。
2. 迁移 0004 是否接受（若否，只能用 `client_revoke` + 审计 detail 区分）。
3. `Env.outboundProxy` 是否允许生产隐式继承宿主机变量（当前：允许，但显式记录）。
