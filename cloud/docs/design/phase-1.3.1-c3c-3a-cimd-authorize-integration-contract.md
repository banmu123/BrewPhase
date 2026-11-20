# BrewPhase Phase 1.3.1-C3c-3A — CIMD 授权接入契约与预检

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> 初版基线：`6c20908`（C3c-2-R2v 终态）
> **R1 修订基线：`b45809f`**（C3c-3A 终态）
> 性质：**设计审查 / 规范对齐 / 架构决策 / 测试契约冻结**。
> **不实现接入**：本阶段不改 `/mcp/oauth/authorize` 的行为、不把
> `fetchClientMetadataDocument()` 接进真实请求链、不加迁移与依赖。
> 规范性标注约定：`[ID §x MUST]` = draft-ietf-oauth-client-id-metadata-document-03
> 的强制要求；`[RFC x]` = 已发布 RFC；`[项目策略]` = BrewPhase 自己的更严格选择，
> **不是**规范要求。修订记录见 §17。

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
R2v 之前的所有报告也只写「-03」而未记日期。C3c-3A 已改为「2026-11-02」。

### 1.1 与 -02 的差异（只列影响实现的）

| 主题 | -03 的变化 | 对本项目的影响 |
|---|---|---|
| §5 Client Authentication | 明确 `token_endpoint_auth_methods_supported`（OpenID.RPMetadataChoices）优先；两者都缺时 **MUST** 按 `none`；**MUST NOT** 套用 RFC 7591 的 `client_secret_basic` 默认 | 现有实现「只接受 none、出现共享密钥方式即拒」符合；需补「两个字段都缺 → none」的测试 |
| §5 | 两者同时出现时 `token_endpoint_auth_method` **MUST** 属于 `..._methods_supported` | **新增判据**，当前未实现 → C3c-3B 补 |
| §5 | AS 不支持文档声明的任何认证方式时 **MUST** 以 `invalid_client` 中止 | 等价于「交集为空」，当前按 unsupported_client 拒绝，映射正确 |
| §6 | `grant_types` / `response_types` 交集为空 **MUST** `invalid_client` | 已实现「无交集即拒」，但**错误码**要到 authorize/token 层才体现（见 §5.5） |
| §4.4 | 明确 informative URI 不得要求与 `client_id` 同源 | 现有实现不要求同源，符合 |
| §10.5 | 新增 jwks 变更的处置叙述（may revoke） | 本项目不用 jwks，记为「无影响」 |

### 1.2 R1 新增引用的规范条款

| 条款 | 原文强度 | 内容 | 本项目怎么用 |
|---|---|---|---|
| §10.1 | **SHOULD** | AS 应拒绝「等于自身 issuer 标识符、或等于与之有信任关系的 AS / RS 标识符」的 Client Identifier URL；比较用 RFC 3986 §6.2.1 的**简单字符串比较** | 实现为 terminal 拒绝（§3.2）。**比 SHOULD 更硬是[项目策略]**，方向与规范一致 |
| §10.6 | SHOULD | 授权界面应展示 `client_id` 的 hostname，与抓取到的客户端信息并列；抓取失败时它是用户唯一的辨别依据 | 同意页新增 `clientIdentifierHost`（§16） |
| §10.9 | **MUST** | 若要展示 `logo_uri`：必须预取（MUST prefetch）、必须从受信服务器提供（MUST serve from trusted servers）、展示前必须校验为有效图像（MUST verify） | 本项目**不展示远程 logo**，因此不触发该 MUST；继续不抓取 `logo_uri` |
| §6.2 | MAY | AS 可以限流，即使导致抓取频率低于 Cache-Control 要求 | 只作为 fetch floor 的依据；**不得**据此把过期文档当有效（§4.1） |
| §4.2 | **MUST** | 授权请求中的 redirect URL 必须是已注册值的**精确匹配**（简单字符串比较）；CIMD 文档的 `redirect_uris` 就是「已注册」集合 | 同意阶段必须按**最新**注册值复核，含 POST 事务内复核（§8.3） |
| §6.1 | SHOULD / MUST NOT | mismatch **SHOULD** 立即使相关 refresh token 失效；抓取失败 **SHOULD** 中止当前请求；失败时 **MUST NOT** 重定向到客户端 | §5.2 / §5.3 / §5.5 |

---

## 2. 当前代码结构（事实核对）

### 2.1 CIMD 抓取器的能力边界

`fetchClientMetadataDocument(clientId, deps)` 今天只做：

URL 形态校验 → DNS（全量）→ SSRF 分类 → 固定 IP 请求 → TLS → 状态/类型/大小 →
JSON → 文档字段 → 缓存策略计算 → `transient|terminal` 分类。

它**不做**：数据库读写、注册、授权、撤销、审计。`createCimdDeps()` 目前也**没有
任何调用方**（只在测试里用）。接入时必须保持——抓取器是纯函数式的边界，副作用
全部由调用方在同一事务里完成。

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
**JSON 错误**（不是 HTML 页），且**不重定向**。这符合 [ID §6.1 MUST NOT]，但用户
在浏览器里会看到一段 JSON——C3c-3B 要改成 HTML 错误页（§5.5）。

### 2.3 同意流程没有「跳过」路径

`consent-flow.ts` 每次授权都渲染同意页；既有 grant 只用于 **step-up** 的 scope
并集，不用于跳过同意。

### 2.4 Grant 的继承、epoch 与撤销后的行为（R1 新增事实核对）

这三条是本轮修订的直接依据，逐条来自代码：

| 事实 | 代码位置 | 后果 |
|---|---|---|
| 同意页只把**未撤销**的 Grant 当作「已授予」 | `consent-flow.ts` GET/POST 的 `isNull(mcpGrants.revokedAt)` 过滤 | Grant 一旦被撤销，复选框全部回到未勾选，用户必须重新选择 |
| step-up 只从**未撤销**的 Grant 继承 scope | 同上 | 撤销后重新授权不会继承旧 scope |
| `ON CONFLICT DO UPDATE` 的 epoch 规则：active 且 scope 未变 → **不变**；否则 → **+1** | `consent-flow.ts` 的 `case when revoked_at is null and scopes = excluded.scopes then epoch else epoch + 1 end` | 只撤 Session 不撤 Grant 时，重新授权走「scope 未变」分支 → **epoch 不变 → Desktop 侧以 `(grantId, epoch)` 为键的授权上下文被原样复用** |
| `mcp_grants.epoch` 与 `mcp_devices.grant_epoch` 是两个字段 | `db/schema.ts` 注释 | 本轮只动 `mcp_grants.epoch`，不碰设备级字段 |

**这正是 R1 要把 Grant 一起撤销的原因**：不是「多撤一点更安全」，而是「不撤 Grant
就存在一条把旧授权静默继承、且版本号不变的路径」。

### 2.5 表结构与约束（与接入相关的部分）

| 表 | 关键列 / 约束 |
|---|---|
| `mcp_oauth_clients` | PK `client_id`；`registration_source ∈ {pre_registered,cimd,dcr}`；`redirect_uris` 1–5；`auth_method = 'none'`；`metadata_fetched_at` / `metadata_cache_expires_at` 可空 |
| `mcp_auth_requests` | `client_id` / `redirect_uri` / `scope` / `resource` / `state` / `code_challenge` / 10 分钟 `expires_at`；**没有** `client_name`，同意页靠 LEFT JOIN 取 |
| `mcp_sessions` | `client_id`、`grant_id`、`revoked_at`、`revoked_reason CHECK ∈ {user_revoke, grant_revoked, refresh_reuse, client_revoke}` |
| `mcp_refresh_tokens` | 「同一 session 最多一条未消费」唯一索引——refresh token 的有效性由 **session 未撤销** 决定 |
| `mcp_grants` | `unique(user_id, client_id, resource)`，`revoked_at`、`epoch ≥ 1` |
| `mcp_auth_codes` | 60 秒、只存哈希、`redirect_uri` 随码固化 |
| `auth_events` | `user_id` **可空**，`detail` jsonb |

---

## 3. 注册来源与优先级

| 现有行 | 收到 authorize | 行为 | 依据 |
|---|---|---|---|
| `pre_registered` | 任意 | **直接用该行**，永不抓取、永不覆盖 | [项目策略]；[ID §9.2] 允许预注册关联 |
| `dcr` | 任意 | 同 pre_registered（本轮不实现 DCR，也不得被 CIMD 顶掉） | [项目策略] |
| `cimd` 且 `metadata_cache_expires_at > now` | 任意 | 直接用缓存，**不发网络请求** | [ID §6.2] 允许缓存 |
| `cimd` 且已过期 | 任意 | 按 §4.1 的冷却规则处理 | [ID §6] SHOULD 周期性重取 |
| 不存在，`client_id` 是合法 CIMD URL | 任意 | 抓取 → 注册 → 继续授权 | [ID §6] |
| 不存在，`client_id` 不是合法 CIMD URL | 任意 | **拒绝**，不发起任何网络请求 | [项目策略]（避免把任意字符串当 URL 抓） |

**判定顺序（C3c-3B 必须照此实现）**：

```
1. 硬上限：client_id > 2048 → 拒绝（不解析、不查库）
2. 按**原始字符串**查 mcp_oauth_clients（主键命中）
     命中 pre_registered / dcr
          → 直接使用该行（不判形态、不判身份冲突、不抓取、不覆盖）
     命中 cimd
          → 身份冲突检查（§3.2）→ 缓存四态（§4）
     未命中
          → 3. 形态：validateClientIdentifierUrl(client_id)
                ok   → 身份冲突检查（§3.2）→ 抓取 → 注册
                fail → 拒绝（未注册；非 URL 的 client_id 必须先预注册）
```

**必须先查库、再判形态**（R1 修正了初稿的顺序错误）：预注册客户端的 `client_id`
**本来就不是 URL**（`brewphase-desktop` 这类随机串）。初稿把形态校验放在查库之前，
一旦形态不合格就走「未注册 → 拒绝」，等于**把所有预注册客户端全部拒掉**。正确顺序
是「按原始字符串查库」优先：命中就用，未命中才需要判断「这个值是否值得抓」。

**为什么身份冲突检查也在查库之后**：它回答的是「这个 URL 值会不会冒充我们自己」，
只对**自动抓取的标识**有意义。`pre_registered` / `dcr` 的 client_id 由人工或注册
流程产生，即便字符串恰好等于 issuer 也不该被一条 CIMD 规则拒绝。

**形态判断仍在原始字符串上做**：`https://h/a/..`、`https://h/%2e%2e` 这类值在
`new URL()` 之后看不出问题（C3c-1-R1 / C3c-2 的同一个教训），所以形态校验必须在
原始串上，且只在「未命中 + 准备抓取」这条分支上生效。

### 3.1 `client_id` 长度的协调

| 场景 | 上限 | 理由 |
|---|---|---|
| 所有 `client_id`（第一道硬上限） | **2048**（`cimd.MAX_URL_LENGTH`） | 在查库之前执行；超过这个长度只可能是构造出来的输入 |
| CIMD URL（形态校验通过） | 2048 | URL 天然长；与 `validateInformationalUri` 共用同一常量 |
| 预注册 id | **512**（创建时约束） | 预注册 id 是随机串，512 已极宽松；**authorize 不再预先按 512 拒绝**——查库命中就说明它是我们自己建的，长度应由创建路径保证 |
| 未命中 + 形态不合格 | 512（仅用于诊断） | 拒绝理由里说明「非 URL 且过长」，不承担独立判定作用 |

**为什么把 512 从 authorize 的预检查里拿掉**：它是初稿顺序错误的另一半。预注册 id
不满足 URL 形态，若先按 512 / 形态拒绝，查库根本没机会发生（§3 的顺序说明）。
512 仍然是**创建**预注册客户端时的约束，只是不再放在会误伤既有行的位置。

**不允许**为了统一而把 512 直接抬到 2048：那会让所有预注册客户端的校验一起变松。

### 3.2 Client Identifier URL 的身份冲突检查（R1 新增，[ID §10.1 SHOULD]）

`validateClientIdentifierUrl()` 只回答「形态是否合格」，不回答「这个值会不会冒充
我们自己」。新增一个**纯函数**，放在形态校验之后、DNS 解析之前：

```ts
// cimd.ts：纯函数，不读 env、不发网络、不写库
export function conflictsWithTrustedIdentifier(
  clientId: string,
  trusted: readonly string[],
): boolean {
  // 逐字符比较：不做大小写折叠、不补默认端口、不去尾斜杠
  return trusted.some((identifier) => identifier === clientId);
}
```

| 必须与哪些标识符比对 | 强度 | 说明 |
|---|---|---|
| AS issuer（`env.baseUrl`） | §10.1 SHOULD → 本项目 terminal 拒绝[项目策略] | C3c-1-R1 已要求 issuer 只能是纯 origin；client_id 必须有非根路径，正常不会相等，但 `https://host/mcp` 这类值必须挡 |
| MCP resource（`mcpResourceFor(env.baseUrl)`） | 同上 | 令牌的 `aud` 就是这个值；client_id 与它相同会让 `aud` 语义混淆（§10.1 的 token confusion） |
| `Env.mcpTrustedPeerIdentifiers`（默认空数组） | 同上（预留） | 将来接第二个 AS / RS 时只改配置，不改判据 |

四条纪律：

1. **原始字符串精确比较**：`https://h:443/mcp` 与 `https://h/mcp` 视为不同。§10.1
   明确要求简单字符串比较；本项目的 `issuer` / `resource` 比较也都是逐字符的——
   在这里做归一化反而会造出「拒绝的字符串」与「当成自己的字符串」两套判据。
2. **在 DNS 之前**：一个必然被拒的值不该打开 DNS / 连接面（§10.7 的 SSRF 面）。
3. **terminal**：`client_id_conflict`，不写数据库行、不产生 `mcp_oauth_clients` 记录。
4. **只作用于「要不要抓取」**：判据在查库之后、DNS 之前（§3 的判定顺序第 4 步）。
   `pre_registered` / `dcr` 行直接使用，**不经过**这条检查——预注册 client_id 由人工
   核验，即便字符串与 issuer 相同，也不该被一条 CIMD 规则拒绝。`cimd` 行在刷新前
   也要过这条检查：若部署改了 `BASE_URL`，既有行可能「变成」与 issuer 相同。

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
STALE/FRESH ──terminal（策略类）──> INVALID ──refetch 成功──> FRESH
```

| 状态 | 判定 | 数据库表示 |
|---|---|---|
| `ABSENT` | 无行 | — |
| `FRESH` | `metadata_cache_expires_at > now` | 正常时间戳 |
| `STALE` | 有行且 `expires_at <= now`，且不等于哨兵值 | 正常时间戳 |
| `INVALID` | `metadata_cache_expires_at` 等于**哨兵** `1970-01-01T00:00:00Z` | `new Date(0)` |

**哨兵值的必要性**：`INVALID` 与「自然过期」在时间比较上无法区分（都 ≤ now）。
用精确的 epoch 值作哨兵，配合 `no-cache` 的 `expires_at = fetched_at`（永远不会
等于 1970），两者可区分且不需要新列。写入时必须用 `new Date(0)` 而不是
`to_timestamp(0)` 之类的数据库表达式，保证逐字符可比。

**`metadata_cache_expires_at = NULL` 的语义**：从未成功抓取过（理论上不该出现在
`cimd` 行上）。C3c-3B 写入非 `cimd` 行时为 NULL；`cimd` 行读到 NULL 视为 `STALE`
（fail-safe）。

### 4.1 重取下限（fetch floor）与「冷却窗口内绝不使用过期文档」

**R1 修正了初版的一处危险默认值**：初版写「低于下限时按 `STALE` 使用旧行」。
那等于「只要在 30 秒内，就把一份已经过期、且我们不打算再验证的文档当作有效」。
[ID §6.2 MAY] 只允许**减少抓取次数**，从未允许**使用过期数据完成授权**。

| 状态 | 距上次抓取 | 行为 | 网络 | 结果 |
|---|---|---|---|---|
| `FRESH` | — | 直接使用 | 无 | 继续授权 |
| `STALE` | < 30s | **不使用旧文档** | 无 | `transient`（`cache_stale_cooldown`）→ 503 |
| `STALE` | ≥ 30s | 重新抓取 | 有 | 成功 → FRESH；失败 → §5.1 / §5.2 |
| `INVALID` | < 30s | 直接拒绝（记住 terminal 结论） | 无 | 400 |
| `INVALID` | ≥ 30s | 重新抓取（唯一自愈路径） | 有 | 成功 → FRESH；失败 → 再标 INVALID |
| `ABSENT` | — | 抓取 | 有 | 成功 → 写行；失败 → 不写行 |

三条纪律：

1. **floor 只约束「要不要发网络请求」，不授权任何状态转换。** 冷却窗口内既不放行，
   也不把 `metadata_fetched_at` 往后写（§5.1「不伪装新鲜」）。
2. **`INVALID` 优先于 floor**：`INVALID` 永远不能回退成「用旧文档」；floor 只限制
   它多久可以再试一次。否则一次终端失败会被冷却窗口「洗白」。
3. **`no-cache` 单独处理**：`parseCimdCachePolicy()` 给 `no-cache` 的 `ttlMs = 0`，
   这类行**永久处于 `STALE`**。按上表，它们每次授权都要成功抓取一次；30 秒内的
   第二次授权会拿到 503。这是刻意的——`no-cache` 的语义是「复用前必须验证」，
   而本项目没有 revalidation 通道（不处理 ETag / If-None-Match），只能重抓。

**为什么不做 stale-while-revalidate**：备选方案「最多容忍 5 分钟 stale」已评估并
否决——它要引入额外常量、额外测试，换来的只是一次重试，而代价是把「未知是否
被改过的 `redirect_uris` 集合」用于签发授权码。风险取向不允许。

---

## 5. transient / terminal 决策矩阵

### 5.1 transient

| 失败 | 当前请求 | 缓存行 | Session | Refresh Token | Grant | 审计 | 重试 |
|---|---|---|---|---|---|---|---|
| DNS 失败 / 无结果 | **中止**，HTML 错误页，无重定向 | 保留原行与原时间戳 | 不动 | 不动（仍有效） | 不动 | `mcp_cimd_fetch_transient`（含 kind） | 下次 authorize 再试 |
| DNS 超时 / 连接超时 / 总超时 | 同上 | 同上 | 不动 | 不动 | 不动 | 同上 | 同上 |
| 代理连接失败 / TLS 握手失败 | 同上 | 同上 | 不动 | 不动 | 不动 | 同上 | 同上 |
| 429 / 5xx | 同上 | 同上 | 不动 | 不动 | 不动 | 同上 | 遵守 `Retry-After`（若有）作为 floor |
| 冷却窗口内命中过期的 `STALE` | 中止 | 不动（**不写时间戳**） | 不动 | 不动 | 不动 | 同上（`kind=cooldown`） | 冷却结束后可试 |

依据：[ID §6.1]「transient failure SHOULD NOT by itself invalidate … trust or
outstanding refresh tokens」「SHOULD NOT discard previously cached valid client
metadata」；「fetching fails → SHOULD abort the authorization request」。
**注意**：`SHOULD abort` 针对的是**当前请求**，不是缓存；两者不能混。

### 5.2 terminal

| 原因 | 当前请求 | 缓存行 | Session / Refresh | Grant | 审计 |
|---|---|---|---|---|---|
| `client_id_mismatch` | 中止 | **标记 INVALID**（`expires_at = epoch`），保留行供取证 | **撤销该 client_id 的全部 Session**（§5.3） | **撤销该 client_id 的全部 Grant，epoch + 1**（§5.3） | `mcp_client_id_mismatch`（含 Grant / Session 两个计数） |
| `client_id_conflict`（§3.2） | 中止 | 不写行（本来就不该有行） | 不动 | 不动 | `mcp_cimd_client_id_conflict` |
| 非法 JSON / 非对象 | 中止 | 标记 INVALID | 不动[项目策略] | 不动 | `mcp_cimd_document_invalid` |
| 文档字段非法（含 redirect_uris、informational URI、长度） | 中止 | 标记 INVALID | 不动 | 不动 | 同上（detail 带字段名） |
| SSRF 地址 | 中止 | 标记 INVALID | 不动 | 不动 | `mcp_cimd_ssrf_blocked` |
| 不支持的客户端（shared secret / 非 none / 私钥） | 中止 | 标记 INVALID | 不动 | 不动 | `mcp_cimd_unsupported_client` |
| `grant_types` / `response_types` 交集为空 | 中止 | 标记 INVALID | 不动 | 不动 | `mcp_cimd_unsupported_grant` |
| 3xx / 非 200 / Content-Type / 超限 | 中止 | 标记 INVALID | 不动 | 不动 | `mcp_cimd_http_invalid` |
| TLS 证书失败（目标） | 中止 | 标记 INVALID | 不动 | 不动 | `mcp_cimd_tls_failure` |
| `no-store` | 中止 | **不写行** | 不动 | 不动 | `mcp_cimd_no_store_rejected` |

依据：[ID §6.1] 只有 `client_id` mismatch **SHOULD** 立即失效 refresh token；
其它 terminal 是 **MAY**（由 AS 裁量）。**本项目的裁量**：只有
`client_id_mismatch` 撤销 Session **与 Grant**；其余 terminal 只拒绝当前请求 +
标记缓存不可用，不动 Session / Refresh Token / Grant —— 因为「文档写坏了」不等于
「已签发的令牌必须作废」，过度撤销会把一次文档发布事故放大成全量掉线。

### 5.3 `client_id_mismatch` 的撤销语义（R1 修订：Grant 与 Session 一起撤销）

**范围**：该 `client_id` 下的**全部** Grant 与**全部未撤销** Session（跨用户、跨设备、
跨 resource）。三层理由：

1. 客户端身份本身不再可信（文档自称属于另一个 client），任何用该身份签发的 refresh
   token 都不应继续有效 [ID §6.1 SHOULD]；
2. **只撤 Session 不够**：同意页会把仍然 active 的 Grant 渲染成「已授予且禁用的
   复选框」，`decideConsent()` 的 step-up 还会把它的 scope 并进新 Grant——身份恢复
   后用户上一次的授权会被**静默继承**，用户看不到自己重新授予了什么；
3. 若不撤 Grant，重新授权时 `ON CONFLICT` 走「scope 未变」分支，`epoch` **不变**，
   Desktop 侧以 `(grantId, epoch)` 为键的授权上下文被原样复用（§2.4）。

**实现（C3c-3B）**：新增 `revokeMcpGrantsAndSessionsByClient(tx, { clientId, now, reason })`，
在**一个事务**里两条 UPDATE，顺序固定 **Grant → Session**：

```sql
-- 1) Grant：撤销 + 版本 +1（同一条语句，不先读后写）
UPDATE mcp_grants
   SET revoked_at = $now,
       epoch      = epoch + 1
 WHERE client_id = $clientId
   AND revoked_at IS NULL
RETURNING id, user_id;

-- 2) Session：只撤销这个 client 的、尚未撤销的
UPDATE mcp_sessions
   SET revoked_at = $now,
       revoked_reason = 'client_id_mismatch'
 WHERE client_id = $clientId
   AND revoked_at IS NULL
RETURNING id, user_id;
```

| 约束 | 做法 |
|---|---|
| 跨用户 | 不加 `user_id` 条件：身份失效是 client 级判断，与具体用户无关 |
| 不误伤其它 client | `WHERE client_id = $1` 是唯一判据；禁止前缀 / `LIKE` / 模糊匹配 |
| 不误伤其它 resource | **不加** `resource` 条件：同一身份下任何 resource 的授权都应失效（令牌的 `aud` 依赖这个身份） |
| 不删行 | 两条都是 `UPDATE`；`RETURNING` 只用于计数与审计，不做逐行删除 |
| epoch 递增 | 撤销时就 `+1`，不等下次授权。下次授权时 `consent-flow` 的 upsert 因 `revoked_at IS NOT NULL` 会再 `+1`，因此**旧 epoch 永不被重用**（单调即可，不要求恰好 +1 一次） |
| 锁顺序 | Grant 行永远在 Session 行之前——与 `createMcpSessionInTransaction`（`SELECT grant … FOR UPDATE` → `INSERT session`）、`rotateMcpRefreshToken`（refresh → session）一致，不形成环 |
| 事务边界 | 两条 UPDATE + 一条审计**同事务**：审计失败即整体回滚，不能出现「Session 撤了、Grant 没撤」 |

**审计**：**一条聚合事件**，不是两条（完整命名表见 §15）：

```json
{ "eventType": "mcp_client_id_mismatch",
  "userId": null,
  "detail": { "clientId": "<逐字符原值>", "reason": "client_id_mismatch",
              "revokedGrantCount": 2, "revokedSessionCount": 3 } }
```

- `user_id = NULL`：这是一次跨用户的系统动作，挂到任何单个用户名下都是错误归因；
- 计数为 0 时也要写（`0` 本身就是「这次身份失效没有影响任何既有授权」的证据）；
- **不**额外写 `mcp_session_revoked`：那个名字保留给「用户 / 客户端主动撤销」路径
  （`revokeMcpSessionsByGrant` 仍在用）。两条路径的语义不能混在一个事件名下。

**取证保留**：`mcp_oauth_clients` 行保留（只把 `metadata_cache_expires_at` 置为
epoch），`mcp_grants` / `mcp_sessions` 保留撤销时间与原因，不删除任何行——事后要能
回答「哪些用户的哪些授权因为这次 mismatch 失效」。

**已知缺口（必须写进报告）**：撤销 Session 只让 refresh token 失效；**已签发的
Access Token（JWT）在过期前仍然有效**（≤15 分钟），因为资源服务器 `/mcp` 的
「按 `sid` 回查 Session」属于 1.3.2，尚未实现。Grant 撤销同理不回收已签发 access
token 里的 `scope`。

### 5.4 撤销之后再次授权会发生什么（R1 新增）

这一节回答「撤销是不是等于永久拉黑」。答案是**不是**，但恢复路径必须显式：

```
第 1 次授权：grant(epoch=1, revoked_at=null) + session
   ↓ mismatch
撤销：grant(epoch=2, revoked_at=t0) + session(revoked_at=t0)
   ↓ 下一次 authorize：INVALID + floor 已过 → 重新抓取
抓取成功且文档合法 → 行更新为 FRESH（registration_source 仍为 cimd）
   ↓ consent GET：无 active grant → 复选框全空
用户重新勾选 → consent POST：ON CONFLICT(revoked_at 非空) → epoch=3, revoked_at=null
```

四条由此确定的判据：

1. **旧权限不会自动恢复**：撤销把 Grant 置为 revoked，step-up 与「已授予」显示都
   依赖 `revoked_at IS NULL`，所以用户必须重新选择。
2. **epoch 单调递增**：1 → 2（撤销）→ 3（重新授权），旧上下文（epoch 1）不可能被
   复用。
3. **重新授权不需要管理员介入**：只要文档恢复合法，用户自己就能走完。
4. **`client_id_mismatch` 不是终态封禁**：如果对端把文档改回正确的 `client_id`，
   下一次抓取会成功。是否要「永久拉黑」某个 client_id 属于运维策略，本轮不做。

### 5.5 错误如何呈现

| 端点 | 失败响应 | 约束 |
|---|---|---|
| `GET /authorize` | **HTML 错误页**（400/503），文案说明「无法验证该客户端」 | [ID §6.1 MUST NOT] 不得重定向到客户端 |
| Consent GET / POST（注册已变） | **HTML 错误页**（400），并删除该 auth request | [ID §4.2 MUST] 回调必须是注册值的精确匹配；[§6.1 MUST NOT] 不重定向 |
| Token / PAR | JSON `invalid_client`；transient → HTTP **503** | [ID §6.1 MUST] |

现状 `app.onError` 输出 JSON——C3c-3B 必须在 authorize 与 consent 处理器里**显式**
捕获 CIMD 失败并渲染 `renderErrorPage()`，不能依赖全局处理器（否则浏览器看到 JSON）。
另一条纪律：错误页**不得**回显 `client_id` 的完整 URL（可能很长且含攻击者可控内容），
只显示主机名或截断形式（与 §16 同一套渲染规则）。

---

## 6. `Cache-Control: no-store` 的处理

### 6.1 三个候选

| 方案 | 做法 | 隐私 | 多实例 | 复杂度 |
|---|---|---|---|---|
| A 拒绝 | 视为「不支持的注册形态」，`invalid_client` | 最好（不落库） | 无影响 | 最低 |
| B 写「立刻过期」的行 | 行存在但 `expires_at = now`，每次重抓 | 差（no-store 要求不存储，我们仍存了 name/uris） | 无影响 | 低 |
| C 不落库，用 `mcp_auth_requests` 快照 | 需要新列（client_name 等） | 中（仍落库） | 无影响 | 中 |
| D 进程内临时保存 | Map | 好 | **不安全**（多实例 / 重启丢） | 中 |

### 6.2 决策：**选 A（拒绝）**（R1 维持不变）

1. `no-store` 的语义是「不要把这份响应存下来」。B/C 都必然落库（授权码流程要跨
   两个请求：authorize → token），与语义冲突。
2. D 在当前部署（`GATEWAY_EXPECTED_REPLICAS = 1`）勉强可行，但把正确性建立在
   「只有一个副本」上，与既有架构纪律相悖（`env.ts` 已经在拒绝多副本）。
3. A 的代价是「带 `no-store` 的客户端无法接入」。这类客户端在 CIMD 生态里很少
   （主流实现给 `max-age`），且失败是**显式**的（用户看到错误页），不是静默降级。

**落地**：`cache.storable === false` → terminal `client_registration_unsupported`，
**不写任何行**，审计 `mcp_cimd_no_store_rejected`。这是 **[项目策略]**——草案没有
规定 AS 必须拒绝 no-store 的客户端。

**备选（记录，不实现）**：给 `mcp_oauth_clients` 加 `metadata_ephemeral boolean`，
token 端点对 ephemeral 行强制重抓一次并比对 `redirect_uris`。需要一次迁移与一条新的
并发路径，成本明显高于收益。

---

## 7. 元数据变化（§10.5）

前提：**每次授权都经过同意页**（§2.3），不存在「有 grant 就静默通过」的路径。
**注意本节的边界**：这里说的是**正常刷新**得到的合法文档；`client_id_mismatch`
走 §5.3，会撤销 Grant 与 Session。

| 字段 | 变化后的处理 | 依据 |
|---|---|---|
| `redirect_uris` | 更新行；**不动**既有 Session / Refresh / Grant；下一次授权按新集合精确匹配并重新征得同意；**已签发的授权码不追溯**（回调合法性在签发时刻判定） | [ID §10.5] 允许 AS 自定；[§4.2 MUST] 精确匹配 |
| `grant_types` / `response_types` | 更新行；若交集为空 → terminal（§5.2），但**不撤销既有令牌** | [ID §6 MUST] 交集为空拒绝**请求**，未要求撤销令牌 |
| `token_endpoint_auth_method(_methods_supported)` | 只接受 `none`；变成共享密钥方式 → terminal + 标记 INVALID（不撤销令牌） | [ID §4.1 MUST NOT] |
| `client_name` | 更新行（同意页立即生效） | 展示字段 |
| `client_uri` / `logo_uri` | 更新行；**从不抓取、从不渲染远程图片**（§10.9 的三个 MUST 因此不触发） | [ID §4.4] / [ID §10.9] |
| `jwks` / `jwks_uri` | 只校验形态与「不得同时出现」，**不抓取、不用于认证**；变化无影响 | [项目策略] 只支持 `none` |

**为什么不做「元数据变化 → 撤销令牌」的通用规则**：草案把这件事留给 AS
（§10.5 全是 should / may）。本项目的风险模型是「同意页每次都出现 + redirect_uri
逐字符匹配」，令牌不依赖这些字段；通用撤销只会制造无谓的掉线。**唯一**例外是
`client_id_mismatch`（身份级别的失败）。

---

## 8. 并发与数据库一致性

### 8.1 写入契约

| 场景 | 机制 |
|---|---|
| 两个并发首次注册同一 URL | `INSERT … ON CONFLICT (client_id) DO NOTHING` → 未插入则重读；**不**先 SELECT 再 INSERT |
| 并发刷新同一 client | **CAS**：`UPDATE … WHERE client_id = $1 AND metadata_fetched_at IS NOT DISTINCT FROM $2`；影响 0 行说明别人先写了 → 重读并放弃本次结果 |
| 抓取风暴 | 进程内 singleflight（**只做合并，不做正确性**）+ 30s fetch floor（§4.1） |
| 多实例 | 正确性完全由 ON CONFLICT / CAS 保证；进程内 Map 只是省一次网络 |
| 旧数据覆盖新数据 | CAS 的 `metadata_fetched_at` 是版本令牌；**不用** `now()` 比较（时钟回拨会破坏顺序） |
| 抓取失败但并发成功 | 失败方不写任何东西（连 `metadata_fetched_at` 都不动）→ 天然不会覆盖 |

**禁止**：用「先 DELETE 再 INSERT」表达刷新（会让并发的授权读到空行）。

### 8.2 CAS 令牌的时间精度（R1 新增，实测）

`metadata_fetched_at` 是 `timestamptz`（PostgreSQL 内部精度 **微秒**），Drizzle 用
`mode: "date"` 映射成 JavaScript `Date`（精度 **毫秒**）。两者精度不同，所以
「拿数据库生成的时间戳当版本令牌」是一条真实的踩坑路径。

**实测（真实 PostgreSQL 16 + Drizzle + postgres.js 3.4.9，2026-11-20）**：

| 场景 | 操作 | 结果 |
|---|---|---|
| A | 写入 `new Date("…10:00:00.123Z")` → 读回 → 用读回值 CAS | 读回 `…10:00:00.123Z`，**精确相等**；CAS 命中 **1** 行 |
| B | `UPDATE … SET metadata_fetched_at = now()`（存 `.260007`）→ 读回被截断成 `.260` → 用该值 CAS | CAS 命中 **0** 行（**必然失配**） |
| C | 同一旧令牌两次 CAS（新→旧交错） | 第一次 **1** 行、第二次 **0** 行；最终值是新数据，**失败者没有覆盖** |
| D | `eq(col, date)`（走列编码器） | 命中 1 行，可用 |

结论与纪律：

1. **允许**用 `metadata_fetched_at` 做 CAS 令牌——**前提是每次写入的都是毫秒精度的
   JavaScript `Date`**（`readClock(deps)` 的产物）。此时「写入值 = 读回值 = 下次比较值」，
   往返无损。
2. **禁止**让数据库 `now()`（或 `defaultNow()`）写这一列后再把它当 CAS 令牌：
   微秒会在 JS 侧被截断，同一个值永远比不中（场景 B）。
3. **禁止**把裸 `Date` 塞进 Drizzle 的 `sql` 模板：postgres.js 3.4.9 会抛
   `ERR_INVALID_ARG_TYPE`（实测）。CAS 谓词必须写成
   `is not distinct from ${value.toISOString()}::timestamptz`，或改用 `eq(col, value)`
   （走列编码器）。这条要写进 3B 的实现注释，否则第一次联调就会炸。
4. **失败者必须重读**：CAS 影响 0 行时不重试写、不合并自己的结果，直接返回
   「本次刷新被更新的结果取代」。要区分「0 行因为版本变了」与「0 行因为行被删」，
   重读一次即可。
5. **首次并发注册**仍由 `ON CONFLICT DO NOTHING` 保护，与 CAS 无关。

**备选（记录，不实现）**：新增 `metadata_version BIGINT NOT NULL DEFAULT 1`，
刷新时 `SET metadata_version = metadata_version + 1 WHERE metadata_version = $2`。
它能彻底消除时间精度问题，代价是一次迁移（加列 + 回填 + 改三处查询）与一整套新
测试。**本轮不采用**，因为场景 A 已证明现有方案在「只写 JS Date」的前提下是精确的；
若 3B 实现中发现任何一处仍在用 `now()` 写该列，再升级到这个方案。

### 8.3 待完成授权请求 × 元数据刷新的竞态（R1 新增）

#### 问题

`mcp_auth_requests` 在 authorize 阶段固化 `client_id` / `redirect_uri` / `scope` /
`resource` / `code_challenge`，之后可能被另一个请求触发的 CIMD 刷新改变注册集合：

```
t0  A: GET /authorize（redirect_uri=R，当时合法）→ 建 auth request（pending）
t1  B: GET /authorize（同 client）→ 缓存过期 → 刷新 → 新文档删除了 R
t2  A: GET /mcp/oauth/consent（rid）→ 渲染同意页
t3  A: POST /mcp/oauth/consent → 签发授权码（redirect_uri=R）
t4  A: 302 → R（一个已经不在这份注册里的回调）
```

**当前代码的真实缺口**（R1 核对）：`allowConsent()` 的事务只对
`mcp_auth_requests` 行加 `FOR UPDATE`；它随后读 `mcp_oauth_clients` **只取
`client_name`，不校验 `redirect_uris`，也不加锁**。token 端点同样只比对
`mcp_auth_codes.redirect_uri`，从不读 `mcp_oauth_clients`。所以 t3 会成功。

#### 冻结的判据

「这次授权请求是否仍然可以继续」= 三条件同时成立，全部以**当前**注册行为准：

| # | 条件 | 依据 |
|---|---|---|
| 1 | `mcp_oauth_clients` 行存在 | 客户端被删就没有可授权的对象 |
| 2 | `auth_request.redirect_uri` ∈ `client.redirect_uris`（逐字符） | [ID §4.2 MUST] 精确匹配 |
| 3 | `client.grant_types` 含 `authorization_code` | [ID §6 MUST] 交集非空 |

`response_types` 不落库（无对应列），只在文档校验阶段要求含 `code`；注册行本身
不含该字段，因此不作为运行时复核项——这一点必须在 3B 的注释里写明，避免有人误以为
漏了一条。

#### 三个检查点

| 检查点 | 加锁 | 失败行为 |
|---|---|---|
| Consent **GET** | 不加锁（纯读） | 删除该 auth request，渲染 400 HTML 错误页 |
| Consent **POST**（同一事务内） | `mcp_auth_requests` `FOR UPDATE` → `mcp_oauth_clients` `FOR SHARE` | 回滚事务、删除 auth request、400，**不签发授权码、不 upsert Grant** |
| **授权码签发** | 与上面同一个事务 | 三者是同一提交：检查通过才有 code |

**为什么 POST 必须加锁、不能只再查一次**：READ COMMITTED 下普通 `SELECT` 只看语句
开始时的快照；刷新可以在「我们查完」与「我们插码」之间提交，于是码仍然按旧集合
签发。`FOR SHARE` 与刷新的 `UPDATE` 冲突，把这段窗口关掉。

**为什么是 `FOR SHARE` 而不是 `FOR UPDATE`**：只需要「在事务期间不允许这行被改」，
不需要排他；`FOR SHARE` 让同一 client 的多个用户并发同意（不同 auth request）互不
阻塞，只与刷新串行。

**为什么不加 `SKIP LOCKED` 之类的乐观变体**：这里要的是「等刷新提交后读到新值」，
不是「跳过被锁的行」；跳过会让检查落空。

#### 锁顺序与死锁分析

全局锁序（所有路径都必须沿这个方向取锁，不允许反向）：

```
mcp_auth_requests  ≺  mcp_oauth_clients  ≺  mcp_grants  ≺  mcp_sessions
        mcp_auth_codes  ≺  mcp_grants
        mcp_refresh_tokens  ≺  mcp_sessions
```

逐路径核对：

| 路径 | 取锁顺序 | 是否符合 |
|---|---|---|
| Consent POST | `auth_requests(U)` → `oauth_clients(S)` → `grants(UPSERT)` → `auth_codes(INSERT)` | ✅ 沿 DAG 向下 |
| Token 兑换 | `auth_codes(U)` → `grants(U)` → `sessions(INSERT)` → `refresh_tokens(INSERT)` | ✅ |
| Refresh 轮换 | `refresh_tokens(U)` → `sessions(U)` | ✅ |
| mismatch 撤销（§5.3） | `grants(U)` → `sessions(U)` | ✅ |
| CIMD 注册 / 刷新 | `oauth_clients(U)` 单表 | ✅ 无后继 |
| 既有 grant 撤销 | `grants(U)` → `sessions(U)` | ✅ |

**没有环**：所有边都指向 DAG 的下游，任何路径都不会「先拿下游再要上游」。因此
「A 持 clients 等 grants、B 持 grants 等 clients」这种经典死锁不会出现。

**一条容易被忽略的边**：Consent POST 在持 `grants` 锁时 **INSERT** `auth_codes`，
而 Token 兑换是「先锁 `auth_codes` 再要 `grants`」。这看起来像反向边，实际上不是：
INSERT 的是**新的随机哈希行**，不与任何正在被锁的授权码行冲突（60 秒 TTL、单次
使用、32 字节随机），所以不产生等待。若将来引入「同码重发」或「按 client 扫
auth_codes」的逻辑，必须重新评估这条边。

#### 并发时序（证明不会死锁）

```
时刻  请求 B（刷新）                 请求 A（consent POST）
t1    UPDATE mcp_oauth_clients
      WHERE client_id=c            （持 clients 行锁）
t2                                   BEGIN
                                     SELECT auth_requests FOR UPDATE（持 auth_req 锁）
t3                                   SELECT oauth_clients FOR SHARE  → 等 B
t4    COMMIT（clients 行锁释放）
t5                                   FOR SHARE 拿到锁，读到 B 提交后的新 redirect_uris
t6                                   校验失败 → ROLLBACK（含删除 auth request）→ 400
```

反向顺序（A 先持 auth_req、B 只持 clients）同样不会成环：B 从不需要 auth_req。
两条路径的交集只有 clients 一行，且都按「auth_req → clients」方向取锁。

#### 边界：授权码已经签发之后

授权码一旦签发（POST 已提交），就不再受注册变化影响：

- token 端点**不**复核 `redirect_uri` 是否仍在注册集合里——回调合法性在签发时刻
  判定，事后删除一个回调不应让已完成的授权追溯失效；
- token 端点**会**复核注册行存在且 `grant_types` 仍含 `authorization_code`
  （单行 PK 读，不加锁）。失败映射为 `invalid_client` [ID §6.1 MUST]。这条是
  一致性检查，不是安全屏障，60 秒窗口内的偏差不带来额外权限。

---

## 9. 环境变量与代理

### 9.1 现状

`createCimdDeps(env = process.env)`、`resolvePinnedProxy(hostname, env)`、
`requestPinnedHttps({ env })` 直接读 `process.env`；`Env` 里没有代理字段。这意味着
**测试与生产的代理来源不可审计**，也解释了 R2v 发现的 F10（直连用例被宿主机
`HTTPS_PROXY` 劫持）。

### 9.2 决策

| 问题 | 决策 |
|---|---|
| 从哪读 | `loadEnv()` 统一解析成 `Env.outboundProxy = { url: string \| null, noProxy: string, scheme: "http" \| "https" \| "unsupported" }`；`process.env` 只出现在 `env.ts` |
| 允许哪些变量 | `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（含小写形式），优先级 `HTTPS_PROXY > HTTP_PROXY`，与现行 `resolveProviderFetch` 一致 |
| 大小写冲突 | 大写优先；两者都存在时以大写为准（记录一次 warn） |
| 不支持的协议（socks5） | `scheme: "unsupported"`；**Provider** 保持「warn + 直连」；**CIMD** 在抓取时直接 transient 失败（绝不直连） |
| 生产是否继承宿主机代理 | **允许**（容器化部署普遍依赖这三个变量），但必须在 `loadEnv()` 里显式读出来、脱敏记录一次启动日志；不做「隐式继承」 |
| Provider 与 CIMD 是否共用 | **共用同一个 `Env.outboundProxy`**：一台机器只有一条出网路径，两套配置只会产生「provider 能通、CIMD 不能」的诡异故障 |
| 测试 | 所有 CIMD / 代理测试**显式**传 `env`（3B 把 R2v 的 `env: {}` 推广到 `createCimdDeps` 调用点），禁止依赖执行机器 |
| 受信对端标识符 | 新增 `Env.mcpTrustedPeerIdentifiers: readonly string[]`（默认 `[]`），只用于 §3.2 的身份冲突检查；来自配置，不来自任何网络输入 |

**注入点（C3c-3B）**：

```ts
// env.ts
outboundProxy: { url: string | null; noProxy: string; scheme: "http" | "https" | "unsupported" };
mcpTrustedPeerIdentifiers: readonly string[];

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

即：传给 `tls.connect()` 的 `ca` 会**完全替换**默认信任链，不是追加。C3c-2-R2 的
JSDoc 把它类比成 `NODE_EXTRA_CA_CERTS`（后者是**追加**），**那个类比是错的**。

### 10.2 决策

| 问题 | 决策 |
|---|---|
| 是否保留 | 保留，但**改名为 `caOverride`**，只作为**测试注入**；生产入口不暴露 |
| 为什么保留 | HTTPS 目标的正向路径（SNI / Host / 证书校验成功）没有它无法自动化验证；删掉只能退回「只测失败路径」 |
| 是否重命名 | 是。`ca` 太容易被读成「追加」，改名后与 Node 语义一致 |
| 代理与目标是否分开 | **分开**：`openTunnel` 的 `ca` 用于代理跳，`PinnedRequestOptions.caOverride` 用于目标跳；两者不共用一个字段（C3c-2-R2 曾因共用而漏传目标跳，已修） |
| 如何证明生产默认信任 | ① 现有测试「目标证书不受信任时拒绝」（不传时自签名必须失败）；② 静态检查：`createCimdDeps` 不设置 `caOverride`；③ 3B 的 review checklist 显式列一条 |
| 是否允许用户提交 CA | **绝对不允许**。任何来自 CIMD 文档或请求参数的值都不得进入 TLS 配置 |

**本阶段不改代码**（除已完成的注释修正）：重命名与默认参数移除在 C3c-3B 一并做，
避免半改状态。

---

## 11. 数据模型变更判断

| 需求 | 是否需要迁移 | 结论 |
|---|---|---|
| 注册 / 缓存 | 否 | 复用 `registration_source` / `metadata_fetched_at` / `metadata_cache_expires_at` |
| `no-store` | 否 | 选择拒绝（§6） |
| `INVALID` 状态 | 否 | 复用 `metadata_cache_expires_at = epoch` 哨兵（§4） |
| 撤销原因 | **是（1 条 CHECK）** | `mcp_sessions_revoked_reason_check` 增加 `client_id_mismatch`；理由：审计必须能区分「客户端主动撤销」与「服务端判定身份失效」，复用 `client_revoke` 会污染审计 |
| Grant 撤销 + epoch | **否** | `mcp_grants` 已有 `revoked_at` 与 `epoch`；`epoch + 1` 不需要新列 |
| 身份冲突的受信列表 | 否 | 配置项 `Env.mcpTrustedPeerIdentifiers`，不入库 |
| 抓取失败记录 | 否 | 用 `auth_events`，不加表 |
| 并发版本号 | 否 | `metadata_fetched_at` 直接做 CAS 令牌（§8.2 已实测） |

迁移只改约束（`DROP CONSTRAINT` + `ADD CONSTRAINT`），不重写数据、不加列。

---

## 12. C3c-3B 实施任务拆分（顺序即依赖）

| # | 任务 | 产出 |
|---|---|---|
| 1 | `env.ts`：`outboundProxy` 解析 + 启动脱敏日志 + `mcpTrustedPeerIdentifiers`；`createCimdDeps` 去掉默认参数 | 配置入口唯一化 |
| 2 | `proxy-fetch.ts`：`ca` → `caOverride`（命名 + 注释 + 测试跟随） | 语义修正 |
| 3 | 迁移 `0004_mcp_session_revoked_reason.sql`：CHECK 增加 `client_id_mismatch` | 数据模型 |
| 4 | `cimd.ts`：`conflictsWithTrustedIdentifier()`（纯函数）；`grantTypes` 默认值改为 `["authorization_code"]`；`response_types` 默认 `["code"]` | 判据与默认值 |
| 5 | `cimd-registry.ts`（新）：`resolveClientForAuthorize()`——长度 → 形态 → 身份冲突 → 查行 → 缓存四态 → floor → 抓取 → 注册 / CAS | 纯逻辑 + 注入 deps |
| 6 | `sessions.ts`：`revokeMcpGrantsAndSessionsByClient()`（Grant → Session，epoch + 1，单条聚合审计） | 撤销语义 |
| 7 | `consent-flow.ts`：GET / POST 复核最新注册（POST 内 `FOR SHARE`）+ 失败删 auth request | 关闭 §8.3 的竞态 |
| 8 | `authorize-flow.ts`：未注册 → 调 #5；错误映射 `invalid_client`；显式异常类型（transient / terminal） | 接入点 |
| 9 | `routes/mcp-oauth.ts`：HTML 错误页（不重定向）+ 审计事件（§15 命名） | 用户可见行为 |
| 10 | token 端点：`invalid_client` / 503 映射；**未声明 `refresh_token` 的客户端不签发 refresh token**，refresh 端点为它返回 `unauthorized_client` | 规范对齐 |
| 11 | `consent-page.ts`：`clientIdentifierHost`（§16） | 反钓鱼 |
| 12 | 测试矩阵（§13 全部 44 条） | 验收 |
| 13 | 文档：`REMOTE_MCP_PHASE_1_3_DESIGN.md` §7 补「已接入」状态 | 文档一致 |

### 12.1 C3c-3B 明确不包含

DCR、`registration_endpoint`、`/mcp` 工具业务、Desktop 改动、无关 OAuth 重构、
真实客户端联调（属 1.3.3）、**以及 `client_id_metadata_document_supported` 的声明**。

### 12.2 与 1.3.3 的依赖关系（R1 修正）

初版把「声明能力」放在 3B 的第 10 步，同时又要求「至少一个真实客户端走通」作为
前置条件——而真实客户端联调被安排到 1.3.3。这是个**循环依赖**：3B 等联调、联调等
3B。修正如下：

| 阶段 | 交付 | `client_id_metadata_document_supported` |
|---|---|---|
| **C3c-3B** | 完整接入 + 全部测试；能力**已实现但不声明** | **`false`**（字段不出现在 AS Metadata 里） |
| **Phase 1.3.3** | 至少一个真实客户端（ChatGPT / Grok）走通：authorize → CIMD 拉取 → 同意 → code 兑换 → refresh → revoke；并验证 transient / terminal 故障与客户端实际读取 Discovery 的行为 | 仍为 `false` |
| **最终启用**（单独提交） | 只改 Discovery 的一个字段 + 一条测试 | 改为 `true` |

**为什么必须这样切**：元数据是承诺。声明 `true` 之后，客户端会按 CIMD 路径发起
请求；如果真实链路没验证过，故障会以「用户无法登录」的形式出现在客户端侧，而我们
这边只看到一堆 4xx。**声明是最后一步，且是独立提交**，出问题时可单独 revert。

---

## 13. 测试验收矩阵

列含义：`HTTP` = 期望响应；`DB` = `mcp_oauth_clients` 变化；`G` = Grant；
`S/R` = Session / Refresh；`审计` = 产生的事件；`重试` = 是否允许下次再试。

### 13.1 注册与缓存

| # | 输入 | HTTP | DB | G | S/R | 审计 | 重试 |
|---|---|---|---|---|---|---|---|
| 1 | 预注册 client（`client_id` **非 URL**）authorize | 302 → login | 无写入 | 无 | 无 | `authorize_started` | — |
| 2 | CIMD 缓存未过期（FRESH） | 302 → login | 无写入 | 无 | 无 | 同上 | — |
| 3 | 缓存过期 + 抓取成功（STALE→FRESH） | 302 | `fetched_at` / `expires_at` 更新 | 无 | 无 | `mcp_cimd_refreshed` | — |
| 4 | 首次成功注册 | 302 | INSERT（`source=cimd`） | 无 | 无 | `mcp_cimd_registered` | — |
| 5 | 首次 transient 失败 | 503 | **无行** | 无 | 无 | `mcp_cimd_fetch_transient` | 是 |
| 6 | 首次 terminal 失败（文档非法） | 400 | **无行** | 无 | 无 | `mcp_cimd_document_invalid` | 下次仍失败 |
| 7 | 有缓存 + transient | 503 | 行保留，时间戳不变 | 无 | 无 | `mcp_cimd_fetch_transient` | 是 |
| 8 | 有缓存 + transient（已有 token） | 同上 | 同上 | 不变 | Refresh 仍有效 | 同上 | 是 |
| 9 | **STALE + 冷却窗口内（< 30s）** | **503**（`cache_stale_cooldown`） | 时间戳**不变** | 无 | 无 | `mcp_cimd_fetch_transient`（kind=cooldown） | 30s 后 |
| 10 | **INVALID + 冷却窗口内** | **400** | 不变 | 无 | 无 | 不新增 | 30s 后 |
| 11 | **INVALID + 冷却已过 + 抓取成功** | 302 | 恢复为 FRESH | 无 | 无 | `mcp_cimd_refreshed` | — |
| 12 | **INVALID + 冷却已过 + 抓取失败** | 400 / 503 | 仍 INVALID | 无 | 无 | 对应 terminal / transient | 下次 |
| 13 | **`no-cache` 文档（ttl=0）** | 302（当次抓取成功） | `expires_at = fetched_at` | 无 | 无 | `mcp_cimd_registered` + `refreshed` | 每次都要抓 |
| 14 | **`no-cache` + 30s 内第二次授权** | **503** | 不变 | 无 | 无 | kind=cooldown | 30s 后 |
| 15 | `no-store` 文档 | 400 | **无行** | 无 | 无 | `mcp_cimd_no_store_rejected` | 否 |

### 13.2 `client_id_mismatch` 与撤销

| # | 输入 | HTTP | DB | G | S/R | 审计 | 重试 |
|---|---|---|---|---|---|---|---|
| 16 | `client_id_mismatch`（该 client 有 1 个 Grant、2 个 Session） | 400 | INVALID | **撤销，`epoch + 1`** | **2 条 Session 撤销** | `mcp_client_id_mismatch`（`count=1/2`） | 否 |
| 17 | 同上，但另有其它 client 的 Grant / Session | 同上 | 同上 | **其它 client 完全不受影响** | 同上 | 同上（计数只含本 client） | — |
| 18 | 同上，但该 client 有**多个 resource** 的 Grant | 同上 | 同上 | **所有 resource 的 Grant 都被撤销** | 同上 | 同上 | — |
| 19 | 同上，但该 client 无任何 Grant / Session | 同上 | INVALID | 无变化 | 无变化 | 事件仍写（两个计数为 0） | — |
| 20 | mismatch 后重新抓到合法文档 → 用户再次同意 | 302 → 302 | 恢复 FRESH | **新建 epoch = 旧 + 2，`revoked_at = null`** | 新建 Session | `registered` / `refreshed` | — |
| 21 | 撤销后 consent GET | — | — | 复选框**全部未勾选**（无 active grant） | — | — | — |
| 22 | 撤销事务中审计写入失败 | 500 | 回滚 | **回滚** | **回滚** | 无 | 是 |

### 13.3 待完成授权请求 × 刷新竞态（§8.3）

| # | 输入 | HTTP | 说明 |
|---|---|---|---|
| 23 | A 建 pending；B 刷新删除 A 的 `redirect_uri`；A GET consent | **400** | 不渲染同意页；该 auth request 被删除；无新增授权码 |
| 24 | 同上，A 直接 POST consent | **400** | **无授权码行、Grant 不变、无 302 到 R** |
| 25 | A GET 通过（R 仍合法）→ B 刷新删除 R → A POST | **400** | 证明 POST 复核生效（只在 GET 查是不够的） |
| 26 | A GET 通过 → B 刷新把 `grant_types` 改为不含 `authorization_code` → A POST | **400** | 条件 3 生效 |
| 27 | A POST 与 B 刷新并发（B 持 clients 行锁） | 两者都完成，无死锁 | A 等在 `FOR SHARE` 上，B 提交后 A 读到新值并拒绝 |
| 28 | 授权码已签发后刷新删除 R，再兑换 | **200** | 回调合法性在签发时刻判定，**不追溯** |

### 13.4 文档字段、默认值与身份冲突

| # | 输入 | HTTP | 说明 |
|---|---|---|---|
| 29 | CIMD 文档 `client_id` = AS issuer | 400 | `mcp_cimd_client_id_conflict`；**无 DNS、无网络**（用 resolver 计数断言为 0） |
| 30 | CIMD 文档 `client_id` = MCP resource | 400 | 同上 |
| 31 | `grant_types` 缺失 | 302 | 存 `["authorization_code"]`；**不签发 refresh token**（token 响应无 `refresh_token`） |
| 32 | `response_types` 缺失 | 302 | 按 `["code"]` 处理（不落库，仅文档校验通过） |
| 33 | `grant_types` 只声明 `client_credentials` | 400 | `invalid_client`（映射见 §5.5） |
| 34 | `grant_types` 含 `refresh_token` | 302 | 正常签发 refresh token；refresh 可用 |

### 13.5 既有边界的回归

| # | 输入 | HTTP | 说明 |
|---|---|---|---|
| 35 | redirect_uri 少一个字符 | 400 | 逐字符匹配不变 |
| 36 | 非法 scope / resource 不匹配 / `code_challenge_method=plain` | 400 | 三道既有校验不变 |
| 37 | CIMD 客户端带 `client_secret` 请求 token | 401 `invalid_client` | 不变 |
| 38 | 直连 / 代理两种 `env` 下跑 #1–#37 | 一致 | 证明不依赖执行机器 |
| 39 | 两个客户端交替授权 | 各自 Session / Grant 正确 | 状态隔离 |
| 40 | 文档获取失败时检查响应 | **没有任何 3xx 到 client** | [§6.1 MUST NOT] |
| 41 | **CAS 精度**：JS Date 写入 → 读回 → CAS | 命中 1 行 | 真实 PG，非 mock |
| 42 | **CAS 精度**：`now()` 写入 → 读回 → CAS | 命中 0 行（负向断言） | 证明禁止用 `now()` |
| 43 | **CAS 并发**：两个刷新持同一旧令牌 | 一个 1 行、一个 0 行，最终是新值 | 失败者不覆盖 |
| 44 | 同意页展示 | `clientIdentifierHost` 与 `redirectHost` **各自独立** | 见 §16 |

补充（不占编号）：

- `token_endpoint_auth_method` 与 `..._methods_supported` 同时出现但不自洽 → terminal；
- `client_id` 长度 2048 边界：2048 通过形态校验、2049 拒绝；
- 预注册客户端**绝不**触发网络（注入的 fetch 计数断言为 0）。

---

## 14. 风险与未决问题

| # | 风险 | 处置 |
|---|---|---|
| 1 | 撤销 Session / Grant 不影响已在流通的 Access Token（≤15 分钟） | 记录在案；1.3.2 的 `/mcp` 按 `sid` 回查后闭合 |
| 2 | `no-store` 客户端无法接入 | 显式拒绝 + 用户可见错误；备选方案记录在 §6.2 |
| 3 | `no-cache` 客户端在 30 秒内无法二次授权 | 刻意 fail-closed；文案要让用户知道「稍后重试」 |
| 4 | 抓取失败导致授权不可用（对端长期挂掉） | 缓存保留 + 冷却；不做「无限期信任旧数据」 |
| 5 | 多实例下 singleflight 失效 | 正确性由 DB 保证；性能问题留待扩容评估 |
| 6 | mismatch 跨用户撤销的审计粒度 | 单条聚合事件（`user_id = NULL`）；若审计要求按用户拆分，需改事件模型 |
| 7 | 真实客户端未联调 | 属 1.3.3；能力声明留到联调之后（§12.2） |
| 8 | 迁移 0004 改 CHECK 需要锁表 | 表小、`ALTER TABLE … ADD CONSTRAINT` 秒级；维护窗口执行 |
| 9 | 撤销 Grant 会让用户重选权限 | 这是**预期行为**（§5.4）；文案要说清「因为无法验证该应用」 |
| 10 | CAS 依赖「只写 JS Date」这条纪律 | 由 §8.2 的负向测试（#42）钉住；若有人改用 `now()` 会立刻转红 |

**未决**：无。初版遗留的三个待拍板项已在 R1 关闭（见 §17）：

1. `client_id_mismatch` 是否撤销 Grant → **撤销**（§5.3）。
2. 迁移 0004 → **接受**（§11）。
3. 生产是否允许继承宿主机代理变量 → **允许，但必须显式解析 + 脱敏记录**（§9.2）。

---

## 15. 审计事件命名表（R1 新增）

统一前缀 `mcp_cimd_*`（抓取 / 注册相关）与 `mcp_client_*`（身份级动作）。所有事件
`user_id = NULL`，因为 CIMD 的判定先于「这次请求属于谁」。

| 事件 | 触发 | detail 字段 | 备注 |
|---|---|---|---|
| `mcp_cimd_registered` | 首次注册成功 | `clientId`, `source` | 不含文档内容 |
| `mcp_cimd_refreshed` | CAS 刷新成功 | `clientId`, `changed[]`（字段名，不含值） | 旧值不入库 |
| `mcp_cimd_fetch_transient` | transient（含冷却命中） | `clientId`, `kind`, `retryAfterMs?` | 不写完整错误栈 |
| `mcp_cimd_document_invalid` | JSON / 字段非法 | `clientId`, `field` | 不写文档、不写 redirect_uri 全文 |
| `mcp_cimd_unsupported_client` | 共享密钥 / 非 none / 私钥材料 | `clientId`, `reason` | 不写密钥内容 |
| `mcp_cimd_unsupported_grant` | 交集为空 | `clientId`, `declaredGrantCount`, `declaredResponseCount` | 只记数量，不记原始数组 |
| `mcp_cimd_http_invalid` | 3xx / 非 200 / Content-Type / 超限 | `clientId`, `status`, `kind` | 不含响应体 |
| `mcp_cimd_ssrf_blocked` | 命中特殊用途地址 | `clientId`, `address` | 地址是取证必需，不是凭据 |
| `mcp_cimd_tls_failure` | 目标 TLS 失败 | `clientId`, `code` | 不含证书内容 |
| `mcp_cimd_no_store_rejected` | `no-store` | `clientId` | 项目策略 |
| `mcp_cimd_client_id_conflict` | §3.2 身份冲突 | `clientId`, `matched`（`issuer` / `resource` / `peer`） | `matched` 是枚举，不回显受信值 |
| `mcp_client_id_mismatch` | §5.3 身份失效 | `clientId`, `reason`, `revokedGrantCount`, `revokedSessionCount` | **唯一**的 mismatch 事件 |

**命名冲突的消歧（初版遗留）**：

| 名字 | 是什么 | 不是什么 |
|---|---|---|
| `client_id_mismatch` | `mcp_sessions.revoked_reason` 的**取值**（DB 约束） | **不是**审计事件名；不要用它写 `auth_events` |
| `mcp_client_id_mismatch` | 审计**事件**名（§5.3） | 不是 DB 值 |
| `mcp_session_revoked` | 「用户 / 客户端主动撤销」路径的事件 | **不**用于 mismatch（否则两条语义混在一起） |

**禁止写入 `detail` 的内容**：完整 CIMD 文档、完整 `redirect_uri`、代理 URL 的凭据
部分、任何 Authorization / Cookie / refresh token。

---

## 16. 同意页的客户端身份展示（R1 新增，[ID §10.6 SHOULD]）

### 16.1 现状

`consent-page.ts` 只渲染 `clientName` 与 `redirectHost`（来自
`auth_request.redirect_uri` 的 `host`）。**没有**独立展示 `client_id` 的 hostname。

### 16.2 冻结的字段与渲染规则

```ts
interface ConsentView {
  clientName: string;
  /** client_id 的 hostname；预注册的非 URL id 用截断标识代替。 */
  clientIdentifierHost: string;
  /** 授权后要跳回的 host（含端口）。与上面**互相独立**。 */
  redirectHost: string;
}
```

| 输入 | `clientIdentifierHost` | 说明 |
|---|---|---|
| `client_id` 是 URL（CIMD） | `new URL(clientId).hostname` | WHATWG 已做 lowercase + IDN → punycode；**不回译 Unicode**（避免同形字钓鱼） |
| `client_id` 是 IPv6 字面量 | 保留方括号形式（`[::1]`） | `URL.hostname` 的原样输出 |
| `client_id` 不是 URL（预注册） | 截断到 40 字符 + `…` | 不回显超长内容；**不**尝试解析成 host |
| 解析失败（理论上不发生） | 空字符串 → 该行不渲染 | 不影响后续判据 |

渲染纪律：

1. **两个字段必须分别渲染、分别加标签**：客户端身份域名（「你正在授权给」）与
   回调域名（「授权完成后你会回到」）。**禁止**把 `redirectHost` 当作 client_id 的
   host 展示，也禁止合并成一行。
2. **只用纯文本，不做链接**：`client_id` / `client_uri` 都不渲染成 `<a href>`，
   避免用户点击到未经验证的远程页面。
3. **统一 `escapeHtml`**：与现有 `clientName` / `redirectHost` 相同，任何进入模板的
   值都过一遍。
4. **不显示远程 logo**：`logo_uri` 既不抓取也不渲染；[ID §10.9 MUST] 的三个前置
   条件（预取 / 受信服务器提供 / 内容校验）一个都没做，就不能显示。
5. **不在错误页回显完整 client_id**：错误页与同意页共用同一套 host 渲染规则
   （§5.5）。

### 16.3 已知取舍

- Punycode 可读性差（`xn--…`），但比展示 Unicode 更安全——同形字攻击正是靠
  视觉相似。是否在 host 下方补一行「国际化域名」提示，属 1.3.3 的 UI 评估。
- 预注册 id 截断到 40 字符后可能不足以区分两个相似 id；这类客户端本来就只用于
  内部，风险可接受。

---

## 17. 修订历史

### R1（2026-11-20，基线 `b45809f`）

| # | 修订 | 原因 |
|---|---|---|
| 1 | §5.2 / §5.3：`client_id_mismatch` 由「只撤 Session」改为「**Grant + Session 一起撤**」，Grant `epoch + 1`，审计合并为一条带两个计数的事件 | 只撤 Session 会让旧 Grant 继续 active → 同意页显示为已授予、step-up 继承 scope、`epoch` 不变 → 旧授权被静默复用（§2.4 的代码事实） |
| 2 | §4.1：冷却窗口内不再「使用旧 STALE」，改为 fail-closed（503）；`INVALID` 优先于 floor；`no-cache` 明确为「永久 STALE、每次重抓」 | 初版把 [§6.2 MAY]（限流）误用成「可以用过期文档」 |
| 3 | §8.3（新增）：待完成授权请求 × 元数据刷新的竞态；Consent GET / POST 双检查，POST 在事务内 `FOR SHARE` 锁注册行；给出锁序与死锁分析 | 当前 `allowConsent()` 只锁 `mcp_auth_requests`，读 clients 不校验 `redirect_uris`；token 也不读注册表 → 会按已删除的回调签发授权码 |
| 4 | §3.2（新增）：Client Identifier URL 的身份冲突检查（issuer / resource / 预留 peer 列表），原始字符串精确比较，DNS 之前，terminal | [ID §10.1 SHOULD] 未实现；令牌 `aud` 混淆风险 |
| 5 | §8.2（新增）：CAS 时间精度的实测结论与三条纪律（只写 JS Date；禁止 `now()`；禁止裸 Date 进 `sql` 模板） | 初版只说「用 `metadata_fetched_at` 做 CAS」，没证明精度，也没发现 postgres.js 不接受裸 Date |
| 6 | §12.2（新增）：3B 不声明 `client_id_metadata_document_supported`；能力声明独立提交，排在 1.3.3 之后 | 初版把「声明」放在 3B 最后一步，却要求「真实客户端联调」作前置 → 循环依赖 |
| 7 | §15（新增）：统一审计事件命名表，并消歧 `client_id_mismatch`（DB 值）与 `mcp_client_id_mismatch`（事件名） | 文档里三个名字混用 |
| 8 | §16（新增）：同意页 `clientIdentifierHost` 与 `redirectHost` 分离的渲染规则 | [ID §10.6 SHOULD] 未实现；当前页面只有 redirectHost |
| 9 | §13：验收矩阵从 22 条扩到 44 条（新增撤销、竞态、冷却、默认值、身份冲突、CAS 精度、同意页展示） | 新判据需要可验收 |
| 10 | §14：三个未决项全部关闭 | 复审已拍板 |
| 11 | §3 / §3.1：判定顺序改为「**先查库、再判形态**」；512 从 authorize 的预检查降为创建时约束 | 初稿把形态校验放在查库之前，而预注册 `client_id` 本来就不是 URL → 会把**所有预注册客户端**拒掉（复审时发现的 High） |
