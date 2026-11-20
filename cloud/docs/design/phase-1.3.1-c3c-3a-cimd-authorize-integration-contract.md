# BrewPhase Phase 1.3.1-C3c-3A — CIMD 授权接入契约与预检

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> 初版基线：`6c20908`（C3c-2-R2v 终态）
> **R1 修订基线：`b45809f`**（C3c-3A 终态）
> **R2 修订基线：`0ffd0cf`**（C3c-3A-R1 终态；本轮为**第三轮独立设计审查**）
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
          → client_id 为 URL 形态：先过身份冲突检查（§3.2），命中即拒
          → client_id 为不透明串：直接使用该行（不判形态、不抓取、不覆盖）
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

**为什么身份冲突检查也在查库之后**（R2 修正适用范围）：它回答的是「这个值会不会
冒充我们自己」。R1 曾以 `registration_source` 一刀切——`pre_registered` / `dcr`
直接跳过。R2 改为**按 client_id 形态**判定：URL 形态的值（无论来源）都要过
§3.2 的比较，因为 [ID §10.1] 的 token confusion 风险来自「client_id 字符串等于受信
标识符」这一**协议层事实**，与它怎么注册进来无关（§3.2 纪律 4）。不透明 id 不经过
检查——它在构造上不可能等于 URL 形态的 issuer / resource。

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
4. **按 client_id 形态适用，不按 `registration_source` 绕过**（R2 修正，[ID §10.1]）：
   判据在查库之后、DNS 之前（§3 的判定顺序第 2 步）作用于**所有 URL 形态的
   client_id**——包括人工预注册的 URL id。不透明 id（原始串不含 `://`，如
   `brewphase-desktop`）不经过本检查：[ID §10.1] 的对象是 Client Identifier URL，
   且不透明串在构造上不可能等于 URL 形态的受信标识符。**不能仅凭
   `registration_source` 就跳过 token confusion 检查**：预注册 URL id 若等于
   issuer / resource / 受信 AS/RS，同样必须拒绝。`cimd` 行在刷新前也要过这条检查：
   若部署改了 `BASE_URL`，既有行可能「变成」与 issuer 相同。

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

> **R2 补充（版本语义）**：上表除 `client_id_conflict` 与 `no_store_rejected`
> （两者**不写行**）外，任何「标记 INVALID」的 terminal 都必须在**同一事务**里
> 执行 `metadata_version = metadata_version + 1`（§8.1 / §8.2）。这是「INVALID
> 不可被迟到请求复活」的结构保证；只改 `metadata_cache_expires_at` 不推进版本
> 会留下被旧版本成功刷新覆盖的窗口（§8.2 实测 P1）。

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
| Consent GET / POST（注册已变 / INVALID） | **HTML 错误页**（400），并删除该 auth request + 审计 `mcp_consent_metadata_invalid` | [ID §4.2 MUST] 回调必须是注册值的精确匹配；[§6.1 MUST NOT] 不重定向；§8.3 四条件 |
| Token / PAR | JSON `invalid_client`；transient → HTTP **503** | [ID §6.1 MUST] |

现状 `app.onError` 输出 JSON——C3c-3B 必须在 authorize 与 consent 处理器里**显式**
捕获 CIMD 失败并渲染 `renderErrorPage()`，不能依赖全局处理器（否则浏览器看到 JSON）。
另一条纪律：错误页**不得**回显 `client_id` 的完整 URL（可能很长且含攻击者可控内容），
只显示主机名或截断形式（与 §16 同一套渲染规则）。

### 5.6 `grant_types` / `response_types` 交叉一致性（R2 新增）

CIMD -03 §6 只要求两个数组**各自**与 AS 支持集的交集非空（空则 `invalid_client`）。
RFC 7591 §2.1 进一步要求服务器 SHOULD 防止客户端注册进**不一致**的组合
（原文：*a server supporting these fields SHOULD take steps to ensure that a client
cannot register itself into an inconsistent state*）。两者是**不同**的要求：

| 要求 | 来源 | 强度 | 本项目实现 |
|---|---|---|---|
| 每个数组与 AS 支持集交集非空，否则 `invalid_client` | [ID §6] | **MUST** | 已实现（各自 `.some(...)`） |
| 两个数组之间的关联不得矛盾 | [RFC 7591 §2.1] | SHOULD → [项目策略] terminal | **R2 新增**（下表） |

**适用范围**：只在**文档校验阶段**（`validateCimdDocument`）执行。注册行不落
`response_types`（无列），因此运行时（authorize / consent / token）只复核
`grant_types`（§8.3 条件 4），不做交叉复核——与 §8.3「`response_types` 不落库」
的说明一致。

#### 默认值先于交叉检查（RFC 7591 §2）

| 字段 | 缺省（**省略**时） | 空数组 `[]` |
|---|---|---|
| `grant_types` | `["authorization_code"]` | 交集为空 → `invalid_client`（省略 ≠ 空） |
| `response_types` | `["code"]` | 交集为空 → `invalid_client` |

默认值必须在求交集与交叉检查**之前**套用；`undefined` 走默认、`[]` 走拒绝，
两者不可混。

#### 交叉规则（BrewPhase 只支持授权码流程）

设 `G` = 套用默认后的 `grant_types`，`R` = 套用默认后的 `response_types`：

1. `R ∋ code` ⇒ `G ∋ authorization_code`（RFC 7591 §2.1「vice versa」方向）。
2. `G ∋ authorization_code` ⇒ `R ∋ code`（表格正向；对本项目被 §6 的交集检查
   subsume——AS 的 `response_types_supported = ["code"]`，`R` 不含 `code` 时交集必空）。
3. `refresh_token` 对 `R` **无**要求（RFC 7591 §2.1 表：`refresh_token → (none)`）。
4. `implicit` / `token` 不受支持（交集必空），不单列规则。

违反规则 1 → 文档自相矛盾 → **terminal `document`**（标记 INVALID + 审计
`mcp_cimd_unsupported_grant`，`detail.reason = "inconsistent_combination"`）。

#### 判定表

| grant_types | response_types | 预期 | 机制 |
|---|---|---|---|
| 缺失 | 缺失 | 默认 `["authorization_code"]` / `["code"]` → **允许**；不签发 refresh token | 默认 + §6 ✓ + 交叉 ✓ |
| `[authorization_code]` | `[code]` | **允许** | §6 ✓ + 交叉 ✓ |
| `[authorization_code]` | `[token]` | **拒绝** `invalid_client` | §6 `response_types` 交集 ∅（交叉亦拒） |
| `[refresh_token]` | `[code]` | **拒绝**（不兼容组合；不得被当作完整授权码流程） | 交叉规则 1 违反 |
| `[authorization_code, refresh_token]` | `[code]` | **允许**；refresh_token 显式声明 → 签发 refresh token | §6 ✓ + 交叉 ✓ |
| `[client_credentials]` | `[code]` | `invalid_client` | §6 `grant_types` 交集 ∅ |
| `[authorization_code]` | 缺失 → `[code]` | 允许 | 默认 + ✓ |
| `[authorization_code]` | `[]` | `invalid_client` | §6 交集 ∅（空数组 ≠ 省略） |

**为什么 `[refresh_token]` / `[code]` 必须拒绝**：`response_types` 含 `code`
声明「本客户端在授权端点接收 code」，而 code 只能由 `authorization_code` grant
产生。只声明 `refresh_token` 的客户端没有任何取得首个 code 的途径——组合自相
矛盾。[RFC 7591 §2.1] 要求阻止这类注册；本项目按 [项目策略] 直接 terminal，
而不是放行后在 authorize 层再拒（放行会得到一条「永远换不到 token」的死注册）。
这正是任务书要求的「不能因为两个数组各自存在一个受支持值，就接受二者之间
实际上不兼容的组合」。

**实现落点（C3c-3B，`cimd.ts`）**：`grantTypes` 缺省改为 `["authorization_code"]`
（替换当前第 725 行的 `["authorization_code","refresh_token"]`）；`responseTypes`
缺省 `["code"]`；在 §6 的两个交集检查之后追加规则 1 的交叉检查。

#### C3c-3B-2 补充：交集必须**真正过滤**，且错误分类独立（3B-1 遗留 #1 / #3）

3B-1 只用 `.some()` 判交集非空，却把**原始数组**放进 `metadata.grantTypes`。
这不正确：原始数组可能含 `client_credentials` 这类不受支持的值，入库会撞
`mcp_oauth_clients` 的 `grant_types <@ [...]` CHECK，让注册在别处炸掉。
**不得**靠放宽数据库 CHECK 来迁就。

| 要求 | 做法 |
|---|---|
| 真正的交集过滤 | `grantTypes = declared.filter(t => SUPPORTED_GRANT_TYPES.has(t))`；`responseTypes` 同理 |
| 交集为空 → 拒绝 | 过滤后 `length === 0` 即拒（与「过滤后非空」是同一件事的两面） |
| 空数组 ≠ 省略 | `undefined` 走缺省；`[]` 过滤后长度 0 → 拒（不被缺省洗白） |
| 交叉一致性用**过滤后**的有效数组 | 先过滤、再判 `R ∋ code ⇒ G ∋ authorization_code` |
| `metadata` 只存有效值 | `metadata.grantTypes = [...过滤后的 grantTypes]` |
| **错误分类独立** | 交集为空 / 交叉不一致 → `unsupported_grant`；普通字段格式错误 → `document`。**禁止靠匹配 detail 文本决定审计事件**（见 §15） |

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

### 8.1 写入契约（R2 修订：唯一 CAS 令牌 = `metadata_version`）

| 场景 | 机制 |
|---|---|
| 两个并发首次注册同一 URL | `INSERT … ON CONFLICT (client_id) DO NOTHING` → 未插入则重读；**不**先 SELECT 再 INSERT |
| **任何**元数据状态变化（成功刷新 / terminal INVALID / mismatch） | **版本 CAS**：`UPDATE … SET metadata_version = metadata_version + 1, … WHERE client_id = $1 AND metadata_version = $2`；**0 行 = 别人先写了 → 丢弃本次结果**（成功与 terminal 一律丢弃，不重试写、不合并） |
| mismatch 撤销 | 必须在**同一事务**里：CAS UPDATE 命中 **1 行** → 才撤销 Grant → 撤销 Session → 写审计；CAS 0 行 → **一个都不做**（§8.4） |
| 抓取风暴 | 进程内 singleflight（**只做合并，不做正确性**）+ 30s fetch floor（§4.1） |
| 多实例 | 正确性完全由 ON CONFLICT / 版本 CAS 保证（DB 是唯一真值）；进程内 Map 只是省一次网络 |
| 旧数据覆盖新数据 | CAS 令牌是整数 `metadata_version`；**不依赖任何时间比较**（时钟回拨无关） |
| 抓取失败但并发成功 | 失败方不写任何东西（连 `metadata_version` 都不动）→ 天然不会覆盖 |

**不变量（C3c-3B 必须有测试盯住）**：对 `mcp_oauth_clients` 的**每一条** `UPDATE`
都必须带 `metadata_version = metadata_version + 1`。做法与 `absolute_expires_at`
的守卫相同——剥注释后扫描全部 `.update(mcpOauthClients)` 调用，凡缺版本递增即转红。

> **C3c-3B-2 补充（3B-1 遗留 #2）**：CAS 的 `WHERE` **必须同时**包含
> `client_id` 与读取时的旧 `metadata_version`——
> `WHERE client_id = ? AND metadata_version = ?`。
> 只写 `WHERE metadata_version = ?` 会把**任何**恰好同版本的行一起更新（另一个
> 客户端也是 version=1 时被误伤）。3B-1 的迁移测试正是这样写的，已修正为
> 造两个 `client_id`、相同版本的行来钉住「只影响目标客户端」。
> 后续 Registry 的**每一处**版本 CAS 都必须走同一个 `casWhere(clientId, version)` 谓词。

**禁止**：用「先 DELETE 再 INSERT」表达刷新（会让并发的授权读到空行）；
用进程内 Map / 单例状态充当版本（多实例与重启都会失效，§7 明令禁止）。

### 8.2 CAS 令牌的选择与实测（R2 推翻 R1 的 `metadata_fetched_at` 方案）

> **R2 说明**：本节标题下的「时间精度」论证已随 `metadata_version` 的采用而
> 降级为历史记录——CAS 令牌不再是时间戳，精度不再是正确性前提。原文（R1 的
> 微秒 / 毫秒实测与三条纪律）保留在下表之后作为「若仍要写 `metadata_fetched_at`
> 时必须遵守」的参考，**不再是 CAS 的前置条件**。

R1 用 `metadata_fetched_at` 当 CAS 令牌、INVALID 只改 `metadata_cache_expires_at`。
**这条组合有一个真实缺口**：INVALID 不推进 `metadata_fetched_at`，于是一个持有
旧 `metadata_fetched_at` 的迟到成功刷新，其 CAS 仍然命中，把已提交的 INVALID
重新写成 FRESH。

**真实 PostgreSQL 16 实测（2026-11-20，`brewphase-cloud-test-pg`，非 mock）**：

| 探针 | 操作 | 结果 |
|---|---|---|
| **P1（复现 R1 缺陷）** | 行 `(fetched=T0, expires=E0)`；B：`UPDATE SET expires=epoch WHERE fetched=T0`（INVALID，不推进 fetched）→ 1 行；A：`UPDATE SET fetched=T1, expires=E1 WHERE fetched=T0` | A **命中 1 行** → 终态被写成 FRESH，**INVALID 被复活** |
| **P2（R2 修复）** | 行 `(version=1)`；B：`UPDATE SET version=version+1, expires=epoch WHERE version=1` → 1 行；A：`UPDATE SET version=version+1, … WHERE version=1` | A **命中 0 行** → INVALID 存活（`version=2, expires=epoch`） |
| **P3（并发单写者）** | 两个事务持同一 `version=1` 各自 `UPDATE … WHERE version=1` | 第二个事务确实在等行锁（`pg_stat_activity.wait_event_type='Lock'`、`pg_blocking_pids` 指向第一个）；提交后 **tx1=1 行、tx2=0 行**，`version` 只递增到 2 |

#### 方案对比（任务书 §2.1 要求的六个维度）

| 维度 | 方案 A：复合 CAS（`fetched_at` + `expires_at`） | 方案 B：`metadata_version`（**采用**） |
|---|---|---|
| 事务正确性 | 主竞态可挡（INVALID 改了 `expires_at`，复合条件失配）；但**同一毫秒**的两次写可能都命中（值相同） | 结构性单写者：版本严格递增，同毫秒也确定只有一个赢（P3） |
| 微秒 / 毫秒精度 | 依赖「只写毫秒 JS Date」纪律（R1 §8.2 的 F5 / F10 踩坑面仍在） | 整数，**无精度问题** |
| 时钟回拨 | 等值比较不受回拨影响，但回拨可让新值等于旧值（值域碰撞） | **完全不依赖时钟** |
| 并发更新 | 通常一个赢；同毫秒 / 回拨下可能两个都赢 | 恒一个赢 |
| CAS 冲突处理 | 0 行 → 重读 | 0 行 → 重读（同） |
| 数据库迁移成本 | 0 | **1 次**（加列 + `DEFAULT 1`，无需回填；C3c-3B 提出，本轮不实施） |

**决策：采用方案 B。** 理由：任务书要求「并发刷新只有一个版本获胜」是**可断言**
的不变量，方案 A 在同毫秒 / 时钟回拨下无法结构性保证；方案 B 同时消除 R1 已实测
过的两类驱动层坑（微秒截断、裸 `Date` 抛错）对 CAS 的耦合。

#### `metadata_fetched_at` 的新角色

版本成为 CAS 令牌后，`metadata_fetched_at` **降级**为「最近一次**确定性**抓取
尝试的时间」，只服务两个用途：

1. **fetch floor**（§4.1 的 30 秒下限）：成功与 terminal 都写 `= now`（记录尝试），
   transient **不写**（§5.1「保留原行与原时间戳」）；冷却窗口内的拒绝也不写。
2. **取证**：回答「最后一次抓取尝试在何时」。

它**不再是** CAS 令牌，因此精度不再是正确性前提（仍建议写 JS `Date` 以保持单一时钟源，
但 `now()` 也不再导致 CAS 失配）。**哨兵 `metadata_cache_expires_at = epoch` 仍是
INVALID 的唯一判据**，与版本正交：版本回答「这次写基于哪个状态」，哨兵回答
「当前是否 INVALID」。

#### 唯一状态机（任务书 §3 要求）

```
状态 = (metadata_version, metadata_cache_expires_at)

ABSENT ──INSERT(ON CONFLICT)──> (version=1, FRESH|STALE)
FRESH  ──now > expires（无写）──> STALE
STALE  ──fetch 成功，CAS version=V──> (V+1, FRESH)        expires = fetched + ttl
STALE  ──terminal，CAS version=V──> (V+1, INVALID)        expires = epoch（+ mismatch 则撤销）
STALE  ──transient，不写──> STALE 不变
INVALID──floor < 30s，不抓──> INVALID 不变（400）
INVALID──floor ≥ 30s，fetch 成功，CAS version=V──> (V+1, FRESH)   ← 唯一自愈路径
INVALID──floor ≥ 30s，terminal，CAS version=V──> (V+1, INVALID)
```

三条冻结判据：

1. **持有当前版本者获胜**；任何基于旧版本的写（成功**或** terminal）一律 0 行、
   一律丢弃。INVALID 一旦提交，只有「先读到 INVALID 版本、过 floor、再成功抓取」
   的**新**观察才能恢复 FRESH——迟到的旧成功**不能**复活缓存（P2）。
2. **mismatch 的撤销权 = 版本失效权**：只有 CAS 命中 1 行，才在同一事务里撤销
   Grant / Session 并写审计；CAS 被拒的 mismatch **不撤销任何东西**（P5 反向亦证）。
3. **版本只增不减、只由 DB 递增**：应用层不得传入期望的绝对版本以外的值；
   进程内 singleflight 只合并请求，不参与判定。

   > **C3c-3B-2 澄清（3B-1 遗留 #4）**：数据库 `CHECK (metadata_version >= 1)`
   > **只保证版本为正数**，**不能**阻止「把 5 改成 3」这类递减写入——**不得**
   > 把该 CHECK 描述成「数据库已保证版本单调递增」。单调性完全由**应用层**
   > 的版本 CAS 承担：每条 `mcp_oauth_clients` 的 UPDATE 必须
   > `SET metadata_version = metadata_version + 1`，且 `WHERE` **同时**包含
   > `client_id` 与读取时的旧 `metadata_version`；CAS 0 行即丢弃本次抓取结果。
   > 「所有更新入口都遵守该 CAS」由**应用层守卫测试**扫描保证（见 §8.1 不变量）。

**为什么不能只测成功刷新之间的竞争**（任务书 §2.2）：成功 vs mismatch、
mismatch vs 迟到成功、INVALID vs 迟到成功是**三条不同的边**，R1 的 CAS 只在
「成功 vs 成功」上验证过。P1 恰恰证明缺口出在「INVALID 不推进令牌」，而不是
成功刷新之间。

#### 附：R1 的时间精度实测（保留作历史，不再是 CAS 前置条件）

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
   往返无损。**（R2：该前提已不再需要——CAS 令牌是 `metadata_version`。）**
2. **禁止**让数据库 `now()`（或 `defaultNow()`）写这一列后再把它当 CAS 令牌：
   微秒会在 JS 侧被截断，同一个值永远比不中（场景 B）。**（R2：该列已不作 CAS，
   但为单一时钟源仍建议写 JS `Date`。）**
3. **禁止**把裸 `Date` 塞进 Drizzle 的 `sql` 模板：postgres.js 3.4.9 会抛
   `ERR_INVALID_ARG_TYPE`（实测）。若仍要对时间戳做等值比较，谓词必须写成
   `is not distinct from ${value.toISOString()}::timestamptz`，或改用 `eq(col, value)`
   （走列编码器）。**版本 CAS 不涉及时间戳，无此约束。**
4. **失败者必须重读**：CAS 影响 0 行时不重试写、不合并自己的结果，直接返回
   「本次刷新被更新的结果取代」。要区分「0 行因为版本变了」与「0 行因为行被删」，
   重读一次即可。
5. **首次并发注册**仍由 `ON CONFLICT DO NOTHING` 保护，与 CAS 无关。

**备选（R1 记录、R2 已采纳）**：新增 `metadata_version BIGINT NOT NULL DEFAULT 1`，
刷新与 terminal 都 `SET metadata_version = metadata_version + 1 WHERE metadata_version = $2`。
它消除了时间精度与时钟回拨的全部耦合，代价是一次迁移（加列 + 无回填 + 改三处
查询）与一整套新测试。**R2 已把它定为唯一方案**（见上文方案对比与决策）。

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

#### 冻结的判据（R2 扩为**四条**，GET / POST 都必须全查）

「这次授权请求是否仍然可以继续」= 四条件同时成立，全部以**当前**注册行为准：

| # | 条件 | 依据 |
|---|---|---|
| 1 | `mcp_oauth_clients` 行存在 | 客户端被删就没有可授权的对象 |
| 2 | **`metadata_cache_expires_at` 不等于 INVALID 哨兵 `epoch`**（`NULL` 视为非 INVALID） | **R2 High**：已处于 INVALID 的 CIMD 客户端**不得**完成待处理授权（§4 状态机） |
| 3 | `auth_request.redirect_uri` ∈ `client.redirect_uris`（逐字符） | [ID §4.2 MUST] 精确匹配 |
| 4 | `client.grant_types` 含 `authorization_code` | [ID §6 MUST] 交集非空 |

**条件 2 是 R2 补的 High 缺口**：R1 只查 1/3/4，而 terminal INVALID **不清空**
`redirect_uris` / `grant_types`，也不删行——旧回调与旧 grant 类型都还在，于是
1/3/4 全过、授权照常签发。必须显式看 INVALID 哨兵。

`response_types` 不落库（无对应列），只在文档校验阶段（§5.6）要求含 `code`；
注册行本身不含该字段，因此不作为运行时复核项——这一点必须在 3B 的注释里写明，
避免有人误以为漏了一条。**交叉一致性（§5.6）同理只在文档校验阶段做**，运行时
只复核 `grant_types`（条件 4）。

#### 方案选择：不存 metadata 版本快照（方案 B——任务书 §3.2 的唯一选择）

任务书给出三个候选。**选定方案 B**：不给 `mcp_auth_requests` 加快照列，
Consent GET / POST 每次**重新验证当前缓存状态与全部相关字段**（上表四条）。

| 候选 | 结论 | 理由 |
|---|---|---|
| A：存 `metadata_version` 到 `mcp_auth_requests`，POST 比对 `===` | **否决** | ① 会对**纯展示字段**（`client_name` / `client_uri` / `logo_uri`）的变更误拒——它们不影响授权有效性，同意页本就实时读当前值；② `no-cache`（`ttl=0`）下**每次 authorize 都抓取、版本必递增**，同一客户端的并发授权会互相踩版本，把第一个用户的 consent 用第二个用户的刷新误拒（任务书明令「不能让每次授权永远无法走完」）；③ 多一列 + 一次迁移，却换不来任何额外的有效性覆盖 |
| B：不加列，四条件实时复核 | **采用** | 见下「完整性」 |
| C：其他 | 不需要 | B 已完整 |

**完整性论证（为什么四条件足够）**：`mcp_oauth_clients` 中影响**授权有效性**的列
只有三处，全部被覆盖——`redirect_uris`（条件 3）、`grant_types`（条件 4）、
`metadata_cache_expires_at` 的 INVALID 哨兵（条件 2；它同时覆盖一切 terminal
后果，含 `token_endpoint_auth_method` 变非法 → terminal → INVALID）。其余列均不
影响有效性：`client_name` / `client_uri` / `logo_uri` 是展示字段（同意页实时读）、
`metadata_fetched_at` 只服务 floor、`registration_source` / `created_at` /
`client_id` 不可变。**因此「版本变了」不等于「授权失效了」——按版本拒绝会误伤，
按字段拒绝才精确。**

**「metadata version 不一致」如何体现（任务书 §8-B）**：方案 B 不在 consent 层比对
版本，但版本变化仍可观测（`mcp_oauth_clients.metadata_version`）。测试 #53 断言
「版本因 INVALID 递增 → POST 拒绝」；反向断言「版本因仅 `client_name` 变化递增、
行仍 FRESH → POST 通过」。两条合起来钉住「按字段而非按版本」这条判据。

**为什么允许 STALE 继续、只拒绝 INVALID**（任务书 §3.2）：consent 跨多个 HTTP
请求（authorize → login → callback → GET → POST），最长 10 分钟。若要求每步都
FRESH，`no-cache` 文档（`ttl=0`，**永久 STALE**）将永远走不完授权——任务书明令
禁止。自然过期只说明「最近没重新验证」，不说明文档变了；而**授权相关的字段**
（`redirect_uris` / `grant_types`）已由条件 3 / 4 实时复核，`INVALID` 由条件 2
实时拦截。因此：**FRESH 与 STALE 都放行，只有 INVALID 拒绝。**

#### 三个检查点

| 检查点 | 加锁 | 失败行为 |
|---|---|---|
| Consent **GET** | 不加锁（纯读） | 删除该 auth request + 审计 `mcp_consent_metadata_invalid`，渲染 400 HTML 错误页 |
| Consent **POST**（同一事务内） | `mcp_auth_requests` `FOR UPDATE` → `mcp_oauth_clients` `FOR SHARE` → 四条件复核 | 回滚事务、删除 auth request、400 + 审计，**不签发授权码、不 upsert Grant** |
| **授权码签发** | 与上面同一个事务 | 四者是同一提交：检查通过才有 code |

**为什么 POST 必须加锁、不能只再查一次**：READ COMMITTED 下普通 `SELECT` 只看语句
开始时的快照；刷新可以在「我们查完」与「我们插码」之间提交，于是码仍然按旧集合
签发。`FOR SHARE` 与刷新的 `UPDATE` 冲突，把这段窗口关掉（P4 实测：FOR SHARE
确实在终端事务持锁时阻塞，提交后读到 `expires=epoch`）。

**为什么是 `FOR SHARE` 而不是 `FOR UPDATE`**：只需要「在事务期间不允许这行被改」，
不需要排他；`FOR SHARE` 让同一 client 的多个用户并发同意（不同 auth request）互不
阻塞，只与刷新串行（P6 实测：两用户并发 Consent 均成功、无死锁）。

**为什么不加 `SKIP LOCKED` 之类的乐观变体**：这里要的是「等刷新提交后读到新值」，
不是「跳过被锁的行」；跳过会让检查落空。

#### 七个必须覆盖的时序（任务书 §3.1）

| # | 时序 | 预期 |
|---|---|---|
| S1 | INVALID 先发生，Consent GET 后发生 | GET：条件 2 失败 → 删行 + 审计 + 400，**不渲染同意页** |
| S2 | Consent GET 先完成，INVALID 在 GET 与 POST 之间发生 | POST：条件 2 失败 → 回滚 + 删行 + 400；**无授权码、无 Grant、不恢复已撤 Grant、不加 Scope、不 302**；其它 client 不受影响；审计说明因 metadata invalid 被拒 |
| S3 | terminal document invalid（**非** mismatch）后，旧 pending request 提交 | 同 S2（文档 terminal 同样标 INVALID，条件 2 拦截；且不撤销 Grant） |
| S4 | INVALID 恢复为 FRESH 后，旧 pending request 再提交 | **通过**（四条件当前值全过）：Grant upsert（已撤 → `epoch+1`、`revoked_at=null`）、签发 code、302。这是 §5.4 的合法恢复路径 |
| S5 | redirect_uri 已删除，但 metadata 仍 FRESH | 条件 3 失败 → 拒绝（删除的回调不得再用，[ID §4.2]） |
| S6 | grant_types 已不含 `authorization_code` | 条件 4 失败 → 拒绝（防御纵深；CIMD 路径下这种文档会先被 §5.6 判 terminal → 条件 2 也会拦） |
| S7 | 多用户针对同一 client 并发 Consent POST | 各锁各自 auth_request、`FOR SHARE` 兼容、grant 行按 `(user,client,resource)` 不同 → 全部成功，无死锁（P6） |

**主时序（任务书 §3.1 的 A/B 交错）**：A 建 pending → A 打开 GET → B 刷新发现
mismatch → 标 INVALID + 撤销 Grant/Session + COMMIT → A POST。预期：**POST 拒绝**
（条件 2），不新增 Grant、不恢复已撤 Grant、不加 Scope、不插 auth code、不 302、
不影响其它 client，审计能说明「授权请求因 metadata invalid 被拒」。

#### `no-cache` 下的完整授权流程（任务书 §3.2 / §8-B）

```
T0  客户端 authorize（no-cache 文档）
    → 行 STALE（ttl=0）→ floor 已过 → 成功抓取
    → version+1, fetched_at=T0, expires=T0（= fetched_at，仍 STALE）
    → 302 → login
T1  用户登录 → callback → 写 user_id → 302 consent?rid=
T2  GET consent：行 STALE → 条件 2 通过（非 epoch）→ 渲染同意页
T3  POST consent：四条件通过 → upsert grant + 插 code + 删行 → 302 redirect?code=
T4  客户端 token 兑换（§8.4）
```

**结论**：一次授权可以在「同一份刚成功获取、写进 DB 行的文档快照」上完成——
consent 不重新抓取，只读 DB 行。若期间有**并发抓取**更新了该行（另一个 authorize
触发的刷新），条件 2/3/4 会在 POST 事务内用 `FOR SHARE` 读到新值并复核：
授权相关字段变了就拒绝，没变就继续。**「重新开始一次授权」与「继续完成已经开始
的授权」是两条不同路径**：

| | 重新开始（新 authorize） | 继续完成（in-flight consent） |
|---|---|---|
| 缓存要求 | 走 §4.1：FRESH 用缓存 / STALE 重抓（<30s 503）/ INVALID 重抓或 400 | **允许 FRESH 与 STALE**，只拒绝 INVALID（四条件） |
| 网络 | 可能发起抓取 | **不抓取**，只读 DB 行 |
| 失败处置 | 当前请求中止，不建 auth request | 删 auth request + 400，不签发 code |

#### 锁顺序与死锁分析

全局锁序（所有路径都必须沿这个方向取锁，不允许反向）：

```
mcp_auth_requests  ≺  mcp_oauth_clients  ≺  mcp_grants  ≺  mcp_sessions
        mcp_auth_codes  ≺  mcp_grants
        mcp_refresh_tokens  ≺  mcp_sessions
```

**R2 增补的不变量**：`metadata_version` 只在 `mcp_oauth_clients` 单表上递增，
不引入新边；终端 INVALID 的顺序是 `clients(U) → grants(U) → sessions(U)`，
与 Consent POST 的 `auth_requests(U) → clients(S) → grants(U) → auth_codes(I)`
在 `clients` 上以 **S vs U** 冲突、但两者都先取 `auth_requests` 或都不取
（终端不碰 `auth_requests`），因此只有**单向等待**、无环。

逐路径核对：

| 路径 | 取锁顺序 | 是否符合 |
|---|---|---|
| Consent POST | `auth_requests(U)` → `oauth_clients(S)` → `grants(UPSERT)` → `auth_codes(INSERT)` | ✅ 沿 DAG 向下 |
| Token 兑换 | `auth_codes(U)` → `grants(U)` → `sessions(INSERT)` → `refresh_tokens(INSERT)` | ✅ |
| Refresh 轮换 | `refresh_tokens(U)` → `sessions(U)` | ✅ |
| mismatch / 终端 INVALID 撤销（§5.3 / §8.1） | `oauth_clients(U)` → `grants(U)` → `sessions(U)` | ✅（R2：clients 先于 grants） |
| CIMD 注册 / 刷新 | `oauth_clients(U)` 单表 | ✅ 无后继 |
| 既有 grant 撤销 | `grants(U)` → `sessions(U)` | ✅ |

**没有环**：所有边都指向 DAG 的下游，任何路径都不会「先拿下游再要上游」。因此
「A 持 clients 等 grants、B 持 grants 等 clients」这种经典死锁不会出现。

**四条反向路径检查（任务书 §7）**：

| 疑问 | 结论 |
|---|---|
| 是否存在 client → auth_request 的反向锁？ | **否**。authorize 读 `oauth_clients` 是**无锁普通 SELECT**（不入锁图），随后 INSERT 新 `auth_requests` 行；Consent 才是 `auth_requests → clients`。终端 / 刷新路径完全不碰 `auth_requests`。 |
| 是否存在 session → grant 的反向锁？ | **否**。`rotateMcpRefreshToken` 对 grants 只做**无锁普通 SELECT**；持有 session 行锁时从不反向要 grant。创建路径与撤销路径都是 `grant → session`。 |
| 终端 INVALID 是否 clients → grants → sessions？ | **是**（§8.1）。CAS 先拿 `clients(U)`，命中 1 行后才 `grants(U)` → `sessions(U)`，同事务。 |
| Consent POST 是否 auth_requests → clients？ | **是**（§8.3）。`auth_requests(U)` → `clients(S)` → `grants` → `auth_codes(I)`。 |
| `FOR SHARE` 与 `UPDATE` 是否有等待环？ | **否**。两者在 `clients` 上是 S/U 冲突，但只有**单向等待**：Consent 等终端（Consent 已持 `auth_requests`，终端不需要它）；终端等 Consent（终端首锁是 `clients`，不持任何 Consent 需要的锁）。P4 / P6 实测无 `40P01`。 |

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

> **R2 实测（P4，真实 PG 16）**：终端事务先持 `mcp_oauth_clients` 排他锁，
> Consent 事务在 `FOR SHARE` 上阻塞（`pg_stat_activity.wait_event_type='Lock'`、
> `pg_blocking_pids` 指向终端事务）；终端提交后 Consent 读到 `expires=epoch`
> （INVALID）→ 拒绝。**两事务均完成，无 `40P01`。**

### 8.4 Token Endpoint 对旧授权码的策略（R2 新增）

R1 只规定「已签发授权码不追溯回调变化 + 复核注册存在与 `authorization_code` +
mismatch 撤销 Grant/Session」。R2 补齐**其它 terminal** 情况下旧授权码的确切行为。

#### 核心结论：三个信任阶段（任务书 §4 要求明确）

**「已完成用户同意并签发的 code」与「仍在 pending 状态的 consent」是不同的信任
阶段。** pending consent 严格按当前态拒绝（§8.3 四条件）；已签发的 code 代表一次
**已经发生**的用户同意，其兑换只做**结构校验**，不回溯缓存状态。

**兑换不检查缓存 INVALID、不检查 metadata 版本**，理由三条：

1. **consent 已经验过**：code 只可能在四条件全过（非 INVALID）的那一刻签发；
   code 绑定**签发时已校验**的 `redirect_uri` + PKCE，兑换不依赖文档当前内容。
2. **与已签发凭据一致**：非 mismatch 的 INVALID **不撤销** Session / Refresh
   （§5.2）——既然后台的长期凭据继续有效，就没有理由单独掐断一个 60 秒的 code。
   反向（查 INVALID）会造成「refresh token 活着、59 秒的 code 却换不了」的割裂。
3. **[ID §6.1] 的 abort 针对授权请求**，不是已完成的兑换；token 端点的
   `invalid_client` 只在「本次 token 请求触发的抓取失败」时适用——本项目 token
   端点**不发起抓取**（只单行 PK 读注册表），该 MUST 不触发。

**`client_id_mismatch` 不是特例，但结果是失败**：mismatch 已在同一事务撤销该
client 的全部 Grant（§5.3），而兑换路径的 `createMcpSessionInTransaction` 对 Grant
取 `FOR UPDATE` 并要求 `revoked_at IS NULL` → **必然 `invalid_grant`**。兑换
**不写 `mcp_grants`**（那是 consent 的职责），因此**不存在**「通过重建 Grant 绕过
撤销」的路径。竞态两种线性化都正确（P5 实测无死锁）：

```
情形一（兑换先拿 grant 锁）：兑换读到 active → 建 Session → COMMIT
        → 终端撤销拿到 grant 锁 → 撤销该 client 全部 Grant + 全部 Session（含刚建的）
情形二（终端先拿 grant 锁）：终端撤销 Grant/Session → COMMIT
        → 兑换恢复，读到 revoked → invalid_grant → 回滚（code 未消费）
```

#### 五种情况的逐项判定

| # | 情况 | 允许兑换 | 查 INVALID | 查版本 | 查 `grant_types` | 查 Grant revoked | 新 Session | 签 Refresh | 审计 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 有效 metadata 下签发 code，兑换 | ✅ | 否 | 否 | ✅ 含 `authorization_code` | ✅ 未撤 | ✅ | 若显式声明 `refresh_token` | `mcp_session_created` |
| 2 | 之后刷新发现 **malformed document**（terminal → INVALID，**不撤** Grant） | ✅ | **否** | 否 | ✅ | ✅ 未撤 | ✅ | 若声明 | `mcp_session_created` |
| 3 | 之后刷新发现 **SSRF / trust failure**（terminal → INVALID，**不撤** Grant） | ✅ | **否** | 否 | ✅ | ✅ 未撤 | ✅ | 若声明 | `mcp_session_created` |
| 4 | 之后刷新发现 **client_id_mismatch**（INVALID + **撤销全部 Grant/Session**） | ❌ | （隐含） | 否 | — | ✅ **已撤 → `invalid_grant`** | ❌ | ❌ | 无新增（mismatch 已写 `mcp_client_id_mismatch`） |
| 5 | 用先前 code 兑换（通用入口） | 按上表 | 按上表 | 按上表 | 按上表 | 按上表 | 按上表 | 按上表 | 按上表 |

补充判据：

- **不查 `redirect_uri` 是否仍注册**（签发时刻判定，沿用 R1 D10 / §8.3 边界）。
- **失败审计**：兑换失败**不写新审计事件**（固定 `invalid_grant` 文案，避免给
  探针信号）；mismatch 场景的身份事件已由 `mcp_client_id_mismatch` 记录。
- **refresh_token gating**：只有 `grant_types` **显式**含 `refresh_token` 才签发
  与轮换（§12 #10）；未声明的客户端兑换拿不到 refresh token，refresh 端点对它
  返回 `unauthorized_client`。

#### 锁顺序（任务书 §7）

```
终端 INVALID / mismatch：mcp_oauth_clients(U) ≺ mcp_grants(U) ≺ mcp_sessions(U)
Token 兑换：             mcp_auth_codes(U)   ≺ mcp_grants(U) ≺ mcp_sessions(I) ≺ mcp_refresh_tokens(I)
```

两者在 `mcp_grants → mcp_sessions` 上**同向**，`mcp_auth_codes` 与
`mcp_oauth_clients` 不相交 → 无等待环。P5 实测：兑换在 grant 行上等待终端事务，
终端提交后兑换读到 `grant.revoked_at` 非空，两事务均完成。

#### 边界：授权码已经签发之后（R2 细化为「信任阶段」）

授权码一旦签发（POST 已提交），就不再受注册变化影响——但它与「仍在 pending 的
consent」是**两个不同的信任阶段**（任务书 §4）：

| 阶段 | 含义 | 受什么约束 |
|---|---|---|
| **pending consent** | 授权**尚未**发生 | 严格当前态：四条件（§8.3），INVALID / 字段变化即拒 |
| **已签发授权码（≤60s）** | 用户**已同意**，码是完成兑换的凭据 | 结构校验：码有效 + Grant 未撤 + 注册行存在 + `grant_types` 含 `authorization_code`（§8.4）；**不**查缓存 INVALID / 版本 |
| **已签发凭据（Session / Refresh）** | 长期身份与续期凭据 | 不受非 mismatch 的 INVALID 影响；只受显式撤销影响 |

**因此 token 端点的复核项**（沿用 R1，R2 不改）：

- **不**复核 `redirect_uri` 是否仍在注册集合——回调合法性在**签发时刻**判定，
  事后删除一个回调不应让已完成的授权追溯失效；
- **会**复核注册行存在且 `grant_types` 仍含 `authorization_code`（单行 PK 读，
  不加锁）。失败映射为 `invalid_client` [ID §6.1 MUST]。这条是**一致性**检查，
  不是安全屏障，60 秒窗口内的偏差不带来额外权限。

**R2 明确不复核缓存 INVALID / metadata 版本**，理由与完整策略见 **§8.4**。

### 8.5 C3c-3B-1 冻结的三个实施边界（R2 后续实施说明）

以下三条是 C3c-3A-R2 留下的**歧义**，必须在 C3c-3B-1 编码前冻结。
它们是 C3c-3B-2（registry / consent / token 接入）的直接输入，后续阶段照此执行。

#### 边界一：CAS 失败后的请求处理

R2 §8.1 规定「CAS 0 行 → 丢弃本次结果」，但没有说清**失败方的当前请求**怎么收场。

| 情形 | 数据库动作 | 当前请求的处置 |
|---|---|---|
| **成功刷新 CAS 失败**（0 行） | **不写任何东西**；若需重读，只以**数据库当前行**为权威状态，**绝不合并 / 使用失败请求携带的旧 metadata** | **fail-closed**：返回**可重试的暂时性错误（503 transient）**；**不创建授权请求**、不使用自身抓取结果继续授权 |
| **mismatch CAS 失败**（0 行） | **不撤销** Grant / Session、**不写** `mcp_client_id_mismatch` 成功审计 | 按**自身抓取结果**拒绝当前请求（400 terminal）；**不得污染已经获胜的数据库状态** |
| **行已删除**（0 行且重读无行） | 不写 | 判定为「注册行已消失」→ authorize 层按未注册处理（400）；**不重新 INSERT、不重试写** |
| **版本已变化**（0 行且重读到新版本） | 不写 | 同「成功刷新失败」：丢弃自身结果，**503 fail-closed** |
| **数据库异常**（连接 / 约束 / 超时） | **整事务 ROLLBACK** | 500（固定文案，不泄 SQL / 表名）；**不得**留下半成品状态 |

**为什么成功刷新失败必须 503、而不是「用自己抓的结果继续」**：那个结果对应的是
**已经过时的版本**。用它建授权请求等于把「我以为的当前状态」当成权威——而权威只
可能是数据库当前行（任务书 §二.1）。503 让客户端重试，重试会基于**新版本**重新
抓取，拿到真正权威的状态。

**为什么 mismatch 失败仍按自身结果拒绝（400）而不是 503**：mismatch 的结论是
「这份文档自称属于别的 client」，它对**当前这次请求**依然成立（我们刚抓到它），
所以拒绝当前请求是诚实的；但它**不拥有失效权**（CAS 0 行 = 别人已用更新版本确认
了状态），因此一个字节都不写。

**测试矩阵落点**：#45（成功 CAS 失败 → 503）、#46（mismatch CAS 失败 → 400 且
零撤销）、#72（行已删除）、#73（数据库异常）、#74（重读只作权威、不合并旧结果）。

#### 边界二：Consent POST 失败时的事务边界

R2 §8.3 规定四条件复核，但没有说清**失败分支的持久化语义**。

1. **顺序**：四条件检查必须**先于** Grant upsert 与授权码插入——任何一条不满足，
   就根本不进入写入阶段。
2. **零副作用**：因 metadata invalid 被拒绝时，**不产生** Grant、**不产生**授权码、
   **不产生** Session。
3. **持久化语义**：删除 pending auth request 与写入 `mcp_consent_metadata_invalid`
   审计**必须真正提交**。**禁止**「在一个事务里删行 + 写审计，然后把该事务整体
   rollback」——那会把删除与审计一起吞掉：授权请求永远留在表里（用户每次重试都
   撞同一堵墙），审计里也查不到它为什么被拒。
4. **推荐实现**：校验失败分支在**持有必要锁**（`mcp_auth_requests` `FOR UPDATE` →
   `mcp_oauth_clients` `FOR SHARE`）的情况下，**只执行**「清理授权请求 + 写审计」，
   然后**提交**这次拒绝；**不执行**任何 Grant / Code 写入。
5. **数据库异常仍然正常 rollback**（第 4 条只针对「校验不通过」这条路径；连接断 /
   约束冲突不得被当成「拒绝已提交」）。

**为什么不能「先写拒绝、再回滚」**：Consent POST 的失败出口目前有两种语义——
`csrf_mismatch` 是「删行 + 审计 + 400」（要提交），`not_found` / `expired` 是
「回滚 + 400」。若把 metadata invalid 也塞进「回滚」那类，删行与审计会一起消失。

**测试落点**（C3c-3B-2 补）：auth request 最终被删除；审计记录持久存在；无授权码；
Grant / Session 逐字段不变；并发 POST 不会重复消费同一个授权请求。

#### 边界三：ABSENT 首次 terminal 失败的抓取频率

R2 §4.1 的 30 秒 fetch floor 依赖 `metadata_fetched_at`，而 ABSENT（首次、无注册
行）抓取失败**不写行**——因此 **ABSENT 不受 30 秒 floor 保护**。任务书 §二.3 要求
先查现有限流，**不得默认 ABSENT 已受保护**。

**结论：Cloud OAuth authorize 入口已有可靠的按 IP 限流。**

| 维度 | 实际情况 |
|---|---|
| **位置** | `routes/mcp-oauth.ts` 的 `limiter`（`rateLimit({ name: "mcp-oauth", ... })`），挂在 `GET /mcp/oauth/authorize`、`/login`、`/callback/:provider`、`GET|POST /mcp/oauth/consent` |
| **粒度** | **按客户端 IP**（`clientKey()`：`TRUST_PROXY` 关闭时只用 socket 地址；开启时从 `X-Forwarded-For` 右端跳过 `TRUST_PROXY_HOPS` 取值，且必须是合法 IP 字面量，否则回退 socket 地址） |
| **窗口 / 上限** | 固定窗口 `rateLimit.windowMs`（默认 **60 000 ms**）内最多 `rateLimit.maxAuthorize`（默认 **30** 次）；可用 `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_AUTHORIZE` 配置 |
| **多实例语义** | **进程内 `Map`**（`rate-limit.ts` 的 `buckets`），**不跨实例共享**。当前部署由启动断言强制 `GATEWAY_EXPECTED_REPLICAS = 1`（单实例），因此它是**全局限流**；Phase 1.4 解除单副本时**必须**换成共享存储（接口不变） |
| **桶上限** | `maxBuckets = DEFAULT_MAX_BUCKETS = 10 000`；超限来源进入**按端点共享**的 overflow 桶，内存不会被无限建桶打爆 |

**因此**：ABSENT 首次 terminal 失败的出网频率，**按来源 IP 被限死在 30 次 / 60 秒**。
这不是 30 秒 floor（后者按 `client_id`），但足以挡住「单 IP 反复用不存在的
client_id 打抓取」的放大。

**残留风险（明确记录，不在本阶段处理）**：拥有大量源 IP 的攻击者在聚合上可超过
30 次 / 分钟，此时只受 `maxBuckets` 的 overflow 桶约束。要按 `client_id` 收敛，
需要一个**最小负面结果冷却**。

**设计好的最小冷却（本阶段只定策略、不实现——`cimd-registry.ts` 属 C3c-3B-2，
届时才有调用点）**：

| 项 | 设计 |
|---|---|
| 形态 | 进程内 `Map<clientId, terminalAt>`，TTL 30 秒（与 fetch floor 同值） |
| 存什么 | **只存时间戳与「发生过 terminal」这一事实**——**绝不存响应内容**，因此不违反 `no-store`（§6） |
| 判定 | ABSENT + terminal 失败后 30 秒内，同一 `client_id` 直接返回 terminal，**不发起第二次抓取** |
| 为什么允许进程内 | 与 `rate-limit.ts` 同一类：**短生命周期的运行态运营数据**，不是授权状态或会话存储（规格禁止的是用内存保存授权 / 会话这类必须持久化的状态） |
| 多实例 | 与限流同语义：单实例下即全局；Phase 1.4 需共享存储 |
| **本阶段** | **不实现**（无调用点）；C3c-3B-2 落地 registry 时按上表实现并补测试 |

**三条纪律**：① **不得**默认 ABSENT 已受 30 秒 floor 保护；② **不得**为了冷却把
`no-store` 的响应内容存下来；③ **不得**在本阶段未经评估就加缓存表。

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
| 并发版本号 | **是（1 列，R2）** | `metadata_version BIGINT NOT NULL DEFAULT 1` 作唯一 CAS 令牌（§8.1 / §8.2；P1–P3 实测）；C3c-3B 提出迁移 `0005`，本轮不实施 |

R1 的结论是「迁移只改约束（`DROP CONSTRAINT` + `ADD CONSTRAINT`），不重写数据」；
**R2 在此之上增补一列**（`metadata_version`，见下）——它是 CAS 正确性的前提，
不是可选项。

> **R2 数据模型增补（C3c-3B 实施，本轮只提出不实施）**：
>
> | 迁移 | 内容 | 依据 |
> |---|---|---|
> | `0004_mcp_session_revoked_reason.sql` | `mcp_sessions_revoked_reason_check` 增 `client_id_mismatch`（R1 已接受） | §5.3；P7 实测当前 CHECK 拒绝该取值 |
> | `0005_mcp_metadata_version.sql`（**R2 新增**） | `mcp_oauth_clients` 加 `metadata_version BIGINT NOT NULL DEFAULT 1`；可选 `CHECK (metadata_version >= 1)` | §8.1 / §8.2 唯一 CAS 令牌 |

`metadata_version` **不需要回填**：`DEFAULT 1` 对既有行即刻生效，且既有行从未被
版本化写过，从 1 起算语义正确（「第 1 个版本」）。加列是 `ALTER TABLE … ADD COLUMN`
带默认值，PG 11+ 为 metadata 操作、瞬时完成，不重写表。

---

## 12. C3c-3B 实施任务拆分（顺序即依赖）

> **C3c-3B-1 已完成 #1–#5（配置收口、TLS 语义、迁移 0004、迁移 0005、`cimd.ts`
> 纯校验）与 #14（文档）。#6–#13 属 C3c-3B-2 及之后——`cimd-registry.ts`、
> Grant/Session 联动撤销、Consent 四条件、authorize 接入、HTML 错误页、
> token gating、同意页身份展示均**尚未实现**。**

| # | 任务 | 产出 | 状态 |
|---|---|---|---|
| 1 | `env.ts`：`outboundProxy` 解析 + 启动脱敏日志 + `mcpTrustedPeerIdentifiers`；`createCimdDeps` 去掉默认参数 | 配置入口唯一化 | ✅ C3c-3B-1 |
| 2 | `proxy-fetch.ts`：`ca` → `caOverride`（命名 + 注释 + 调用方 + 测试跟随） | 语义修正 | ✅ C3c-3B-1 |
| 3 | 迁移 `0004_mcp_session_revoked_reason.sql`：CHECK 增加 `client_id_mismatch` | 数据模型（P7 已证当前 CHECK 拒绝） | ✅ C3c-3B-1 |
| 4 | **迁移 `0005_mcp_metadata_version.sql`（R2 新增）**：`mcp_oauth_clients` 加 `metadata_version BIGINT NOT NULL DEFAULT 1`（`CHECK >= 1`），**无回填** | 唯一 CAS 令牌（§8.1 / §8.2） | ✅ C3c-3B-1 |
| 5 | `cimd.ts`：`conflictsWithTrustedIdentifier()` / `isUrlShapedClientId()` / `clientIdConflictsWithTrusted()`（纯函数）；`grantTypes` 缺省 `["authorization_code"]`；`responseTypes` 缺省 `["code"]`；**§5.6 规则 1 交叉一致性检查**；`fetchClientMetadataDocument` 支持 `trustedIdentifiers`（DNS 之前） | 判据、默认值、交叉约束、身份冲突 | ✅ C3c-3B-1 |
| 6 | `cimd-registry.ts`（新）：`resolveClientForAuthorize()`——长度 → 形态 → 身份冲突（**URL 形态，含预注册**，§3.2）→ 查行 → 缓存四态 → floor → 抓取 → 注册 / **版本 CAS**；**边界一（§8.5）的 CAS 失败处置**；ABSENT 负面冷却 | 纯逻辑 + 注入 deps | ✅ C3c-3B-2 |
| 7 | `sessions.ts`：`revokeMcpGrantsAndSessionsByClient()`（Grant → Session，epoch + 1，单条聚合审计），**必须与版本 CAS 同一事务**（CAS 命中 1 行才撤） | 撤销语义（§8.1） | ✅ C3c-3B-2 |
| 8 | `consent-flow.ts`：GET / POST **四条件**复核（POST 内 `FOR SHARE`）+ 失败删 auth request + 审计 `mcp_consent_metadata_invalid`；**边界二（§8.5）的提交语义** | 关闭 §8.3 的竞态与 **INVALID 缺口** | ⬜ C3c-3B-2 |
| 9 | `authorize-flow.ts`：未注册 → 调 #6；错误映射 `invalid_client`；显式异常类型（transient / terminal） | 接入点 | ⬜ C3c-3B-2 |
| 10 | `routes/mcp-oauth.ts`：HTML 错误页（不重定向）+ 审计事件（§15 命名） | 用户可见行为 | ⬜ C3c-3B-2 |
| 11 | token 端点：`invalid_client` / 503 映射；**未声明 `refresh_token` 的客户端不签发 refresh token**，refresh 端点为它返回 `unauthorized_client`；**旧授权码按 §8.4（不查 INVALID / 版本）** | 规范对齐 + 信任阶段 | ⬜ C3c-3B-2 |
| 12 | `consent-page.ts`：`clientIdentifierHost`（§16） | 反钓鱼 | ⬜ C3c-3B-2 |
| 13 | 测试矩阵（§13 全部条目，含 R2 新增 A–D 四组与 §13.10） | 验收 | 🟡 3B-1 完成迁移 / CIMD / 配置三组；**3B-2 完成 Registry / CAS 竞争 / 撤销 / 负面冷却四组**；consent / token 随 #8–#11 |
| 14 | 文档：本文件（含 §8.5 后续实施说明）+ R2/3B-1 审查报告 + 路线图 / 索引 | 文档一致 | ✅ C3c-3B-1 |

### 12.1 C3c-3B 明确不包含

DCR、`registration_endpoint`、`/mcp` 工具业务、Desktop 改动、无关 OAuth 重构、
真实客户端联调（属 1.3.3）、**以及 `client_id_metadata_document_supported` 的声明**。

**3B 的两道额外闸门（R2）**：① 迁移 `0005`（`metadata_version`）落地前，任何
`mcp_oauth_clients` 的 UPDATE 都还没有版本递增——**必须先加列再写 CAS**，否则
CAS 谓词引用不存在的列；② Consent 四条件与 Token 旧码策略（§8.3 / §8.4）必须与
版本 CAS **同一批**接入，不得只接其一（只接 Consent 会漏掉「INVALID 被迟到成功
复活」，只接 CAS 会漏掉「pending 授权穿过 INVALID」）。

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

**共 71 条**：R1 冻结的 44 条（§13.1–§13.5）**原样保留**，R2 新增 27 条
（§13.6–§13.9，编号 45–71）。每条新增用例都写明初始数据库状态、事务 A/B 的
准确操作顺序、预期最终数据库状态、HTTP 返回、Grant / Session / Auth Code /
Refresh Token 变化、审计事件、是否允许重试。

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
| 42 | **CAS 精度**：`now()` 写入 → 读回 → CAS | 命中 0 行（负向断言） | 证明禁止用 `now()`（R2：该列已不作 CAS，此条降级为 `metadata_fetched_at` 写入纪律回归） |
| 43 | **CAS 并发**：两个刷新持同一旧令牌 | 一个 1 行、一个 0 行，最终是新值 | 失败者不覆盖 |
| 44 | 同意页展示 | `clientIdentifierHost` 与 `redirectHost` **各自独立** | 见 §16 |

补充（不占编号）：

- `token_endpoint_auth_method` 与 `..._methods_supported` 同时出现但不自洽 → terminal；
- `client_id` 长度 2048 边界：2048 通过形态校验、2049 拒绝；
- 预注册客户端**绝不**触发网络（注入的 fetch 计数断言为 0）。

### 13.6 R2 新增 A：Cache CAS 与 INVALID 竞争（真实 PostgreSQL）

列含义沿用 §13；`A/B` = 两个并发事务的准确操作顺序。**全部要求真实 PG + 行锁 +
`pg_stat_activity` / `pg_blocking_pids` 断言，禁止 mock。**

| # | 初始 DB | A / B 顺序 | 预期终态 | HTTP | G / S / C / R | 审计 | 重试 |
|---|---|---|---|---|---|---|---|
| 45 | cimd 行 `version=V`、FRESH、有 1 Grant 2 Session | A 读 V 发起成功抓取（未返回）→ B 读 V 抓到 mismatch → B `UPDATE version=V+1, expires=epoch WHERE version=V` 命中 → 撤销 → COMMIT → A 迟到，`UPDATE … WHERE version=V` | **A 命中 0 行**；行仍 INVALID（`version=V+1, expires=epoch`） | **A → 503 transient（fail-closed、可重试；不建授权请求、不使用自身抓取结果）**；B → 400 | G/S 已被 B 撤销、不复活 | `mcp_client_id_mismatch` | **A 侧可重试**（B 侧否） |
| 46 | 同上 | B 读 V 发起 mismatch（未返回）→ A 读 V 成功抓取 → A `UPDATE version=V+1 … WHERE version=V` **命中并 COMMIT**（A 赢得该版本）→ B 迟到，`UPDATE … WHERE version=V` | **B 命中 0 行** → **不撤销任何 Grant/Session、不写 mismatch 成功审计**；行 FRESH | **A → 302（它赢得 CAS，正常使用自己的结果）**；**B → 400（按自身 mismatch 结果拒绝当前请求，但零 DB 写入）** | **G/S 完全不变**（CAS 拒绝的 mismatch 不得误撤） | 无 `mcp_client_id_mismatch` | 否 |
| 47 | 同 45 | A 成功抓取 vs B **malformed document** terminal（不撤 Grant） | 恰好一个 `version+1`；若 B 先提交 → INVALID、G 不动；若 A 先提交 → FRESH、B 丢弃 | 各自按其结果 | 依谁先提交 | 对应 terminal 事件 / `refreshed` | 否 |
| 48 | 行已 INVALID（`version=V+1, expires=epoch`） | 迟到的旧成功（持有 `version=V`）执行 `UPDATE … WHERE version=V` | **0 行**，`expires` 仍 `epoch` | — | 不变 | 无 | 否 |
| 49 | 同 45 | mismatch 的 CAS 被拒（0 行）→ **不得撤销** | Grant/Session `revoked_at` 保持原值 | 400 | 不变 | 无 `mcp_client_id_mismatch` | 否 |
| 50 | 行 `version=V` | 两个并发刷新（成功 vs 成功）持同一 `V` 各自 CAS | **恰好一个 1 行、一个 0 行**；`version=V+1` 只递增一次 | 各自 | 不变 | `mcp_cimd_refreshed` 恰 1 条 | 否 |

**P1–P3 已在本轮实测**（见 §8.2）：P1 复现 R1 缺陷（迟到成功覆盖 INVALID）；
P2 证明版本 CAS 使迟到成功命中 0 行；P3 证明并发单写者 + 真实行锁等待。

### 13.7 R2 新增 B：Pending Consent 一致性

| # | 初始 DB | 顺序 | 预期 | HTTP | G / S / C / R | 审计 | 重试 |
|---|---|---|---|---|---|---|---|
| 51 | pending auth_request；cimd 行 FRESH、Grant active | B 触发 mismatch → INVALID + 撤销 → COMMIT → A POST consent | 条件 2 拒绝 | **400** | **无新 Grant、不复活已撤 Grant、不加 Scope、无 auth code、无 302**；其它 client 不变 | `mcp_consent_metadata_invalid` | 否（删行） |
| 52 | 同上（但 terminal 是 **malformed**，不撤 Grant） | B 标 INVALID → A POST | 条件 2 拒绝 | **400** | Grant **不**被撤（malformed 不撤）、无 code | `mcp_consent_metadata_invalid` | 否 |
| 53 | pending（authorize 时 `version=V`） | B 刷新使 `version=V+1` 且结果 INVALID → A POST | 版本已变 + 条件 2 → 拒绝 | **400** | 同 51 | `mcp_consent_metadata_invalid` | 否 |
| 54 | pending，GET 已渲染（行 FRESH） | **refresh 在 GET 与 POST 之间**删掉 A 的 `redirect_uri` → A POST | 条件 3 拒绝 | **400** | 无 code、无 Grant 变化 | `mcp_consent_metadata_invalid`（`condition=3`） | 否 |
| 55 | 同上 | refresh 在 GET/POST 之间把 `grant_types` 改为不含 `authorization_code` → A POST | 条件 4 拒绝 | **400** | 同上 | 同上（`condition=4`） | 否 |
| 56 | pending；INVALID 已发生且**已恢复 FRESH**（`version` 已两次递增，字段仍匹配） | A POST（旧 pending request） | 四条件当前值全过 → **通过** | **302** | Grant upsert（已撤 → `epoch+1`、`revoked_at=null`）+ 新 auth code | `mcp_consent_allowed` + `mcp_auth_code_issued` | — |
| 57 | `no-cache` 文档（`ttl=0`）：authorize 时抓取成功 → 行 `expires=fetched_at`（STALE） | 登录 → GET（STALE，条件 2 过）→ POST（四条件过） | **完整授权走通** | GET 200 / POST **302** | Grant + auth code | `mcp_consent_allowed` | — |
| 58 | pending；行 FRESH | **两用户**针对同一 client 并发 POST | 两两都成功（`FOR SHARE` 兼容、grant 行不同） | 两个 302 | 各自 Grant/code | 各 1 条 allowed | — |

**53 是「metadata version 不一致」的落点**：方案 B 不存快照列，因此版本变化通过
「变化是否触及授权相关字段」体现——触及（如 INVALID）即拒绝，未触及（仅
`client_name` 变化）则放行。另加一条反向断言：`version` 递增但仅 `client_name`
变化、行仍 FRESH → POST **通过**（证明四条件的精确性，不误伤）。

### 13.8 R2 新增 C：Token Endpoint 对旧授权码

| # | 初始 DB | 顺序 | 预期 | HTTP | G / S / C / R | 审计 | 重试 |
|---|---|---|---|---|---|---|---|
| 59 | 有效 metadata 下签发 code（60s 内） | 之后刷新发现 **mismatch** → INVALID + 撤销 Grant/Session → 用户用旧 code 兑换 | **失败**（Grant 已撤 → `createMcpSessionInTransaction` 拒） | **400 `invalid_grant`** | 无新 Session、无 Refresh；**不重建 Grant**；code 回滚未消费 | 无新增（mismatch 已记 `mcp_client_id_mismatch`） | 否 |
| 60 | 同上，但 terminal 是 **malformed / SSRF**（INVALID，**不撤** Grant） | 用户用旧 code 兑换 | **成功**（信任阶段不同，§8.4） | **200** | 新 Session + Refresh（若声明 `refresh_token`） | `mcp_session_created` | — |
| 61 | Grant 已被 mismatch 撤销 | 任何路径尝试兑换旧 code | 失败，**不得**通过重建 Grant 绕过 | 400 `invalid_grant` | 无 | 同 59 | 否 |
| 62 | 客户端 `grant_types=["authorization_code"]`（**未声明** `refresh_token`），code 已签发 | 兑换成功 | 兑换成功但**响应无 `refresh_token`**；随后 refresh 端点为它返回 `unauthorized_client` | 200 / 401 | 有 Session、**无 Refresh 行** | `mcp_session_created` | — |
| 63 | 同 62 | 用伪造的 refresh token 轮换 | **不得继续轮换**（未声明即不签发，自然无有效 token） | 401 `unauthorized_client` | 不变 | 无 | 否 |

### 13.9 R2 新增 D：规范一致性（grant / response 与身份冲突）

| # | 输入 | 预期 | 说明 |
|---|---|---|---|
| 64 | 文档缺 `grant_types`、缺 `response_types` | 允许；存 `["authorization_code"]`；**不签发 refresh token** | RFC 7591 §2 默认（§5.6） |
| 65 | `grant_types` 与 AS 交集非空、`response_types` 与 AS 交集非空，但组合 `grant=[refresh_token]` / `response=[code]` | **拒绝**（terminal `document` → INVALID） | §5.6 规则 1；「不能因各自有受支持值就接受不兼容组合」 |
| 66 | `grant=[authorization_code]` / `response=[token]` | `invalid_client` | §6 `response_types` 交集 ∅ |
| 67 | `grant=[client_credentials]` / `response=[code]` | `invalid_client` | §6 `grant_types` 交集 ∅ |
| 68 | `grant=[authorization_code]` / `response=[]`（空数组） | `invalid_client` | 空数组 ≠ 省略（§5.6 默认值表） |
| 69 | CIMD 文档 `client_id` = AS issuer / MCP resource / 受信 peer | `client_id_conflict`，**无 DNS**（resolver 计数 0） | §3.2（既有，#29/#30 回归） |
| 70 | **`pre_registered` 且 `client_id` 为 URL 形态、等于 issuer / resource / peer** | **拒绝 `client_id_conflict`**（R2 新增：不再按 `registration_source` 绕过） | §3.2 纪律 4 |
| 71 | `pre_registered` **不透明** id（`brewphase-desktop`）authorize | 允许、**零网络**（fetch 计数 0） | §3.2 不透明豁免 |

### 13.10 R2-3B-1 追加：CAS 失败后的确定性处置（边界一）

对应 §8.5 边界一。编号接在 71 之后，**不重排** §13.6–§13.9 的既有编号。

| # | 初始 DB | 顺序 | 预期 | HTTP | G / S / C / R | 审计 | 重试 |
|---|---|---|---|---|---|---|---|
| 72 | cimd 行 `version=V`，随后**注册行被删除** | A 读 V 发起成功抓取（未返回）→ 行被删 → A 迟到，`UPDATE … WHERE client_id=c AND version=V` | **0 行**；重读**无行** → 判定为「注册行已消失」，**不重新 INSERT、不重试写** | **400**（authorize 层按未注册 / 行不存在） | 无变化 | 无 | 否 |
| 73 | cimd 行 `version=V` | A 读 V → 抓取成功 → CAS UPDATE 期间**数据库异常**（连接断 / 约束冲突） | **整事务 ROLLBACK**，库里不留半成品（`version` 不变、无授权请求） | **500**（固定文案，不泄 SQL / 表名） | 无变化 | 无（或仅 `mcp_audit_failed` 类） | 是 |
| 74 | cimd 行 `version=V` | A 读 V → 抓取成功 → CAS 0 行（B 已推进到 V+1）→ A **重读当前行** | 重读结果**只作为权威状态**用于诊断 / 分支，**绝不与 A 自身的抓取结果合并**，也**不用它继续授权** | **503 transient**（fail-closed） | 无变化 | 无 | 是 |

**74 的判据**：失败请求携带的 metadata 对应的是**过时版本**。任何「拿重读到的新行
+ 自己抓的旧文档拼一拼」的实现都必须转红——权威只能是数据库当前行，而当前行的
结论应通过**重新发起一次抓取**（基于新版本）得到，不是复用旧结果。

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
| 10 | CAS 依赖「只写 JS Date」这条纪律 | **R2 已解除**：CAS 令牌改为 `metadata_version`（整数），精度不再是前提；`metadata_fetched_at` 只服务 floor 与取证（§8.2） |
| 11 | **R2 新增**：Consent 放行 STALE，可能基于「最近一次抓取」的 `redirect_uris` 完成授权 | 授权请求自身有 10 分钟 TTL，且 authorize 成功时行必为 FRESH → 数据最多 `ttl + 10min` 旧；`redirect_uris` 由条件 3 实时复核；`no-cache` 必须放行 STALE（§8.3） |
| 12 | **R2 新增**：非 mismatch 的 terminal 后，已签发的旧 auth code 仍可兑换（≤60s） | 信任阶段不同（§8.4）：consent 已验四条件、code 绑定签发时的 redirect_uri + PKCE；且与「INVALID 不撤 Refresh Token」一致。窗口仅 60 秒 |
| 13 | **R2 新增**：`metadata_version` 迁移 0005 与 0004 同属 3B，两次 ALTER | 0004 改 CHECK（秒级锁表）、0005 加列（metadata 级、瞬时）；表小，合并到一个维护窗口执行 |

**未决**：无。初版遗留的三个待拍板项已在 R1 关闭（见 §17）：

1. `client_id_mismatch` 是否撤销 Grant → **撤销**（§5.3）。
2. 迁移 0004 → **接受**（§11）。
3. 生产是否允许继承宿主机代理变量 → **允许，但必须显式解析 + 脱敏记录**（§9.2）。

R2 关闭的决策（见 §17 R2 表）：

4. CAS 令牌 → **`metadata_version`**（新增列，迁移 0005；R1 的 `metadata_fetched_at` 方案被推翻）。
5. Consent 是否存 metadata 版本快照 → **不存**（方案 B：四条件实时复核；完整性论证见 §8.3）。
6. 非 mismatch terminal 后旧授权码 → **允许兑换**（信任阶段不同，§8.4）。
7. `[refresh_token]`/`[code]` 组合 → **拒绝**（§5.6）。
8. 预注册 URL id 的身份冲突 → **照查**（按形态不按来源，§3.2）。

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
| `mcp_cimd_unsupported_grant` | 交集为空 **或交叉不一致（R2）** | `clientId`, `declaredGrantCount`, `declaredResponseCount`, `reason`（`empty_intersection` / `inconsistent_combination`） | 只记数量与枚举，不记原始数组 |

> **C3c-3B-2 补充（3B-1 遗留 #3）**：审计映射**只走 `CimdFailureReason` 枚举**
> （`auditEventForCimdFailure()`），**禁止**通过匹配错误 `detail` 文本来决定事件名。
> 因此 grant / response 类失败必须有**独立**的 reason `unsupported_grant`
> （区别于普通字段格式的 `document`），否则审计层只能去读 detail 文本——那是禁止的。
| `mcp_cimd_http_invalid` | 3xx / 非 200 / Content-Type / 超限 | `clientId`, `status`, `kind` | 不含响应体 |
| `mcp_cimd_ssrf_blocked` | 命中特殊用途地址 | `clientId`, `address` | 地址是取证必需，不是凭据 |
| `mcp_cimd_tls_failure` | 目标 TLS 失败 | `clientId`, `code` | 不含证书内容 |
| `mcp_cimd_no_store_rejected` | `no-store` | `clientId` | 项目策略 |
| `mcp_cimd_client_id_conflict` | §3.2 身份冲突 | `clientId`, `matched`（`issuer` / `resource` / `peer`） | `matched` 是枚举，不回显受信值 |
| `mcp_client_id_mismatch` | §5.3 身份失效 | `clientId`, `reason`, `revokedGrantCount`, `revokedSessionCount` | **唯一**的 mismatch 事件 |
| `mcp_consent_metadata_invalid` | **R2 新增**：Consent GET / POST 因四条件失败（INVALID / 字段变化）被拒 | `rid`, `clientId`, `stage`（`consent` / `consent_submit`）, `condition`（1–4） | `user_id` 可取（行内已有）；说明「授权请求因 metadata invalid 被拒」 |

> `mcp_consent_metadata_invalid` 是 `auth_events.event_type` 的**新取值**；
> 该列是 text 且无 CHECK，**加取值不需要迁移**（与既有 `mcp_consent_*` 同理）。

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

### R2（2026-11-20，基线 `0ffd0cf`）

| # | 修订 | 原因 |
|---|---|---|
| 1 | **§8.1 / §8.2（推翻 R1 D13）**：唯一 CAS 令牌从 `metadata_fetched_at` 改为新增列 **`metadata_version`**；`metadata_fetched_at` 降级为 floor / 取证时间戳；INVALID 必须 `version+1` | R1 只改 `expires_at` 不推进令牌 → **迟到成功可把已提交的 INVALID 复活成 FRESH**（P1 实测复现）；方案 A 复合 CAS 在同毫秒 / 时钟回拨下无法结构性保证「只有一个写入者」（P3） |
| 2 | **§8.3（High）**：Consent 判据由三条件扩为**四条件**，新增 **`metadata_cache_expires_at ≠ epoch`（INVALID）**；明确 **STALE 放行、只拒 INVALID**；新增七个时序 S1–S7 与 no-cache 完整流程 | terminal INVALID 不清 `redirect_uris` / `grant_types` 也不删行 → R1 三条件全过、待处理授权照常签发 |
| 3 | **§8.4（新增）**：Token Endpoint 对旧授权码的五情况策略；明确 **pending consent 与已签发 code 是不同信任阶段**；非 mismatch 的 terminal **不阻断**兑换、不查 INVALID / 版本；mismatch 由 Grant 撤销天然拦截 | 任务书 §4 要求给出唯一策略，且「不能把所有 terminal 粗暴升级为全量撤销」 |
| 4 | **§5.6（新增）**：`grant_types` / `response_types` 交叉一致性（RFC 7591 §2.1）；默认值先于检查；`[refresh_token]/[code]` 拒绝 | 两数组各自有受支持值 ≠ 组合兼容；任务书 §5 表 |
| 5 | **§3.2 纪律 4（修订）**：身份冲突检查按 **client_id 形态**（URL 形态一律查）而非 `registration_source` | 预注册 URL id 等于 issuer / resource 仍会 token confusion；任务书 §6 |
| 6 | **§11 / §12（修订）**：数据模型增补迁移 `0005`（`metadata_version`）；3B 任务表重排（版本 CAS、四条件、交叉检查、旧码策略） | 落实上述决策；迁移本轮只提出不实施 |
| 7 | **§13（扩展）**：44 → **71 条**，新增 A（CAS 竞争 6）、B（Consent 8）、C（Token 5）、D（规范 8）四组 | 任务书 §8 要求；每条含初始态 / 事务顺序 / 终态 / HTTP / G·S·C·R / 审计 / 重试 |
| 8 | **§8.3 锁序 / §8.4**：补四条反向路径检查与终端 `clients → grants → sessions` 顺序；P4/P5/P6 真实 PG 交错实测 | 任务书 §7 要求真实事务交错，不只写「没有死锁」 |
| 9 | **§14（新增风险 11–13）**、**§15**（`mcp_consent_metadata_invalid` 事件、`mcp_cimd_unsupported_grant` 增 `reason`） | 新判据需要审计落点与风险记录 |

### C3c-3B-1（2026-11-20，基线 `3b0ff0a`）

本阶段是**实施**轮（基础设施 / 迁移 / CIMD 纯校验层），不是设计推翻。
对设计正文的修订如下：

| # | 修订 | 原因 |
|---|---|---|
| 1 | **§8.5（新增）**：冻结三个实施边界——① CAS 失败后的请求处理（成功刷新失败 → 503 fail-closed 不建授权请求；mismatch 失败 → 400 但零撤销；行已删除 / 版本变化 / DB 异常各自的确定处置）；② Consent POST 失败分支的持久化语义（清理 + 审计必须**提交**，禁止整体 rollback）；③ ABSENT 首次 terminal 失败的抓取频率（**不受 30 秒 floor 保护**，由 authorize 按 IP 限流兜底 + 设计好的最小负面冷却） | R2 留下的三处歧义，任务书 §二要求编码前冻结 |
| 2 | **§13.6 #45 / #46 修正**：#45 迟到成功的 HTTP 由「302」改为「**503 transient（fail-closed、不建授权请求、不使用自身抓取结果）**」；#46 明确 A 是**赢得 CAS** 才 302、B 是**按自身结果 400 但零 DB 写入** | #45 原文一边规定 CAS 失败、一边让该请求用自身结果返回 302，自相矛盾 |
| 3 | **§13.10（新增）**：#72（行已删除）、#73（数据库异常）、#74（重读只作权威、不合并旧结果） | 边界一要求的确定性处置需要可验收用例 |
| 4 | **§9.2 / §10.2 / §11 / §12 状态更新**：`outboundProxy`、`mcpTrustedPeerIdentifiers`、`caOverride`、迁移 0004 / 0005、`cimd.ts` 纯校验**已在本阶段落地** | 从「设计」变为「已实现」，供 3B-2 直接引用 |

**本阶段未改**：§3 / §4 / §5 / §6 / §7 / §8.1–§8.4 / §13.1–§13.9 的判据与语义
（R2 冻结结论原样保留）。

### C3c-3B-2（2026-11-20，基线 `2511bf7`）

本阶段交付 **CIMD Registry、缓存状态机、版本 CAS 与 Grant/Session 联动撤销**，
并修复 3B-1 的四个遗留问题。对设计正文的修订：

| # | 修订 | 原因 |
|---|---|---|
| 1 | **§5.6 新增「交集必须真正过滤」**：`grantTypes` / `responseTypes` 用 `.filter()` 与 AS 支持集求真交集，`metadata` 只存有效值；空数组 ≠ 省略；交叉一致性用过滤后的数组；**错误分类独立**（`unsupported_grant` vs `document`） | 3B-1 遗留 #1：原实现只 `.some()` 判非空却存原始数组，含 `client_credentials` 的文档会撞 DB CHECK |
| 2 | **§8.1 新增 CAS 谓词约束**：`WHERE` **必须同时**含 `client_id` 与旧 `metadata_version`；每处版本 CAS 走同一 `casWhere(clientId, version)` | 3B-1 遗留 #2：原迁移测试只写 `WHERE metadata_version = 1`，会误伤同版本的其它客户端 |
| 3 | **§15 新增审计映射纪律**：只走 `CimdFailureReason` 枚举（`auditEventForCimdFailure()`），**禁止匹配 detail 文本**；grant/response 类用独立 reason `unsupported_grant` | 3B-1 遗留 #3：`document` 被「字段非法」与「交集/交叉」共用，审计层无法区分 |
| 4 | **§8.2 判据 3 补充**：`CHECK (metadata_version >= 1)` **只保证正数、不保证单调**；单调性由应用层版本 CAS 承担，守卫测试扫描全部更新入口 | 3B-1 遗留 #4：不得把 CHECK 描述成「数据库已保证版本单调递增」 |
| 5 | **§12 状态更新**：#6（`cimd-registry.ts`）、#7（`revokeMcpGrantsAndSessionsByClient`）标记为本阶段完成；新增 ABSENT 负面冷却与版本递增守卫测试 | 从「设计」变为「已实现」 |

**本阶段未改**：authorize / consent / token / revoke 生产逻辑、`discovery.ts`
（未声明能力）、Desktop、迁移文件（0004 / 0005 沿用 3B-1 的产物）、依赖。
