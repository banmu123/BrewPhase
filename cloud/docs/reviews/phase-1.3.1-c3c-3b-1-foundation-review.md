# BrewPhase Phase 1.3.1-C3c-3B-1 — 基础设施、数据库迁移与 CIMD 纯校验层

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> 基线提交：`3b0ff0aafe166ad01e550888239cee0f48920854`（C3c-3A-R2 终态，本地 = 远程）
> 上一轮报告：`phase-1.3.1-c3c-3a-r2-design-review.md`
> 协议依据：`docs/design/phase-1.3.1-c3c-3a-cimd-authorize-integration-contract.md` **v3（R2 + §8.5）**
> 性质：**实施轮**——环境配置收口、TLS 语义修正、迁移 0004/0005、`cimd.ts` 纯校验层。
> **未接入** authorize / consent / token 生产链路；**未实现** `cimd-registry.ts`；
> **未声明** `client_id_metadata_document_supported`；**未改** Desktop 生产代码。

---

## 1. 实际 HEAD 与基线

| 项 | 值 | 核对方式 |
|---|---|---|
| 分支 | `feature/remote-mcp` | `git branch --show-current` |
| 开始前 HEAD | `3b0ff0aafe166ad01e550888239cee0f48920854` | `git rev-parse HEAD` = 任务书给定基线 |
| 远程 HEAD（开始前） | `3b0ff0aafe166ad01e550888239cee0f48920854` | `git fetch origin` + `git rev-parse origin/feature/remote-mcp` |
| 工作区（开始前） | 干净 | `git status --short` 为空 |

提交链：`… → 0ffd0cf`（C3c-3A-R2）`→ 3b0ff0a`（本轮基线）。**未回退任何远程提交。**

### 1.1 重读的代码与文档

代码：`env.ts`、`net/proxy-fetch.ts`、`mcp-oauth/cimd.ts`、`app.ts`、`db/schema.ts`、
`db/client.ts`、`db/migrations/*`、`security/rate-limit.ts`、`routes/mcp-oauth.ts`、
`mcp-oauth/enablement.ts`。
测试：`tests/db/migrations.test.ts`、`tests/mcp-oauth/{cimd,schema}.test.ts`、
`tests/net/{proxy-fetch,pinned-request}.test.ts`、`tests/env/*`、`tests/helpers/*`。

文档：设计契约 v3（含 R2 与 §8.5）、R2 / R1 / 初版三份审查报告、
`REMOTE_MCP_PHASES_ROADMAP.md`、`REMOTE_MCP_INDEX.md`、RFC 7591 §2 / §2.1、
draft-…-03 §3 / §5 / §6 / §10.1。

---

## 2. 三个边界的最终决策（任务书 §二）

三项结论已写入设计 **§8.5「C3c-3B-1 冻结的三个实施边界」**，后续阶段直接照做。

### 2.1 边界一：CAS 失败后的请求处理

| 情形 | 数据库动作 | 当前请求的处置 |
|---|---|---|
| **成功刷新 CAS 失败**（0 行） | 不写；重读只以**数据库当前行**为权威，**绝不合并 / 使用失败请求的旧 metadata** | **fail-closed → 503 transient（可重试）**；**不创建授权请求**、不用自身结果继续授权 |
| **mismatch CAS 失败**（0 行） | **不撤销** Grant / Session、**不写** `mcp_client_id_mismatch` 成功审计 | 按**自身抓取结果**拒绝（400 terminal）；**零 DB 写入**，不污染已获胜状态 |
| **行已删除**（0 行且重读无行） | 不写 | 判定「注册行已消失」→ 400；**不重新 INSERT、不重试写** |
| **版本已变化** | 不写 | 同成功刷新失败：**503 fail-closed** |
| **数据库异常** | **整事务 ROLLBACK** | 500（固定文案，不泄 SQL）；不留半成品 |

**为什么成功刷新失败是 503 而不是「用自己的结果继续」**：那个结果对应**过时版本**。
用它建授权请求 = 把「我以为的当前状态」当权威，而权威只能是数据库当前行。
503 让客户端重试，重试基于**新版本**重新抓取，拿到真正权威的状态。

**为什么 mismatch 失败仍是 400 而不是 503**：mismatch 的结论（「这份文档自称属于
别的 client」）对**当前这次请求**依然成立（我们刚抓到它），拒绝当前请求是诚实的；
但它**不拥有失效权**（CAS 0 行 = 别人已用更新版本确认状态），所以一个字节都不写。

**对设计矩阵的修正**：#45 原文一边规定「迟到成功 CAS 失败」、一边让该请求
「302 且缓存不复活」——自相矛盾（用了自身过时结果）。已改为 **A → 503 fail-closed、
不建授权请求**。#46 明确 A 是**赢得 CAS** 才 302、B 是**按自身结果 400 但零 DB 写入**。
新增 **#72（行已删除）/ #73（数据库异常）/ #74（重读只作权威、不合并旧结果）**。

### 2.2 边界二：Consent POST 失败时的事务边界

1. **顺序**：四条件检查**先于** Grant upsert 与授权码插入——任一不满足即不进入写入阶段。
2. **零副作用**：metadata invalid 拒绝不产生 Grant / 授权码 / Session。
3. **持久化语义**：删除 pending auth request + 写 `mcp_consent_metadata_invalid`
   **必须提交**。**禁止**「事务内删行 + 审计，然后整体 rollback」——那会把删除与
   审计一起吞掉（授权请求永远留在表里、审计里也查不到拒因）。
4. **推荐实现**：失败分支在**持有必要锁**（`auth_requests` `FOR UPDATE` →
   `oauth_clients` `FOR SHARE`）时**只执行**「清理 + 审计」，然后**提交**拒绝；
   不执行任何 Grant / Code 写入。
5. **数据库异常仍正常 rollback**（第 4 条只针对「校验不通过」路径）。

**依据**：Consent POST 现有两种失败语义——`csrf_mismatch` 是「删行 + 审计 + 400」
（提交），`not_found`/`expired` 是「回滚 + 400」。metadata invalid 必须走**提交**语义，
否则删行与审计一起消失。

**本阶段状态**：Consent 接入属 C3c-3B-2（任务 #8），本阶段只冻结语义。

### 2.3 边界三：ABSENT 首次 terminal 失败的抓取频率

**ABSENT 不受 30 秒 floor 保护**（无行 → 无 `metadata_fetched_at`）。任务书要求先查
现有限流、不得默认已受保护。结论：**已有可靠的按 IP 限流**。

| 维度 | 实际情况 |
|---|---|
| **位置** | `routes/mcp-oauth.ts` 的 `limiter` = `rateLimit({ name: "mcp-oauth", max: maxAuthorize, windowMs, trustProxy, trustedHops, maxBuckets })`，挂在 `GET /mcp/oauth/authorize`、`/login`、`/callback/:provider`、`GET|POST /mcp/oauth/consent` |
| **粒度** | **按客户端 IP**（`clientKey()`：`TRUST_PROXY` 关时用 socket 地址；开时从 XFF 右端跳 `TRUST_PROXY_HOPS` 取值，且必须是合法 IP 字面量，否则回退 socket 地址） |
| **窗口 / 上限** | 固定窗口 `windowMs` 默认 **60 000 ms**，`maxAuthorize` 默认 **30**（`RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_AUTHORIZE` 可配） |
| **多实例语义** | **进程内 `Map`**（`rate-limit.ts` 的 `buckets`），**不跨实例共享**。启动断言强制 `GATEWAY_EXPECTED_REPLICAS = 1` → 单实例下即**全局**；Phase 1.4 解除单副本时**必须**换共享存储（接口不变） |
| **桶上限** | `DEFAULT_MAX_BUCKETS = 10 000`，超限来源进**按端点共享**的 overflow 桶 |

**因此**：ABSENT 首次 terminal 失败的出网频率，**按来源 IP 限死在 30 次 / 60 秒**。
这不是按 `client_id` 的 30 秒 floor，但足以挡住「单 IP 反复用不存在的 client_id 打抓取」。

**残留风险**：多源 IP 攻击者聚合上可超过 30/分，只受 overflow 桶约束。

**设计好的最小冷却（本阶段只定策略、不实现——`cimd-registry.ts` 属 3B-2，届时才有调用点）**：

| 项 | 设计 |
|---|---|
| 形态 | 进程内 `Map<clientId, terminalAt>`，TTL 30 秒 |
| 存什么 | **只存时间戳 + 「发生过 terminal」这一事实**——**绝不存响应内容**，不违反 `no-store` |
| 判定 | ABSENT + terminal 后 30 秒内同 `client_id` 直接返回 terminal，不再抓 |
| 为何允许进程内 | 与 `rate-limit.ts` 同类：**短生命周期运行态运营数据**，非授权 / 会话状态 |
| 多实例 | 同限流语义（单实例即全局；1.4 需共享存储） |
| **本阶段** | **不实现**（无调用点） |

**三条纪律**：① 不得默认 ABSENT 已受 floor 保护；② 不得为冷却存 `no-store` 响应内容；
③ 不得本阶段未经评估就加缓存表。

---

## 3. 本阶段交付

### 3.1 环境配置收口（任务 §三.1）

| 项 | 落点 |
|---|---|
| `Env.outboundProxy` | `env.ts`：`{ url: string \| null, noProxy: string, scheme: "http" \| "https" \| "unsupported" }`，由 `loadEnv()` **唯一**解析 |
| 变量与优先级 | `HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy`；`NO_PROXY > no_proxy`；空白串视为未配置 |
| 大小写冲突 | 大写胜出；两者**取值不同**时 `warn` 一次（`… wins`） |
| 不支持协议 | `scheme: "unsupported"`（`url` 保留原文）；Provider **warn + 直连**，CIMD **硬失败**（`resolvePinnedProxy` 抛错，先于 `NO_PROXY` 判定） |
| 启动日志脱敏 | `describeOutboundProxy()` → http(s) 只输出 `scheme://host:port`；unsupported **只输出协议名**（连主机名都不带）；由 `createContextFromProcessEnv()` 每进程记一次（`loadEnv` 保持纯函数） |
| `mcpTrustedPeerIdentifiers` | `Env.mcpTrustedPeerIdentifiers: readonly string[]`，逗号分隔 + trim；**fail-fast** 校验每条为绝对 http(s) URL |
| `createCimdDeps` | 签名改为 `createCimdDeps(proxy: OutboundProxy)`，**无默认参数**（漏传编译不过） |
| 消除重复解析 | `resolveProviderFetch(proxy, …)`、`resolvePinnedProxy(host, proxy)`、`PinnedRequestOptions.proxy` 全部消费 `Env.outboundProxy`；`process.env` 只剩 `loadEnv(process.env)` 一个入口 |

### 3.2 TLS 语义修正（任务 §三.2）

- `TunnelOptions.ca` → **`caOverride`**（代理跳）
- `PinnedRequestOptions.ca` → **`caOverride`**（目标跳；仍**分别**是两个字段，不共用）
- 注释改为明确表达 Node 的**替换**语义（"completely replaced (instead of being concatenated)"）
- 调用方与测试全部跟随（`ca: TEST_CERT` → `caOverride: TEST_CERT`）
- **未改 TLS 校验强度**：无 `rejectUnauthorized` 字段、无关闭校验的入口；
  `rejectUnauthorized: true` 保持；不传 `caOverride` 时自签名证书仍必须被拒（既有测试）
- **`createCimdDeps` 不设置 `caOverride`**（生产入口走系统默认 CA 信任链）——
  由静态源码断言钉住（见 §5）

### 3.3 迁移 0004 / 0005（任务 §三.3 / §三.4）

由 `drizzle-kit generate --name …` 从 `schema.ts` 生成（保证 journal / 快照一致）：

**`0004_mcp_session_revoked_reason.sql`**
```sql
ALTER TABLE "mcp_sessions" DROP CONSTRAINT "mcp_sessions_revoked_reason_check";--> statement-breakpoint
ALTER TABLE "mcp_sessions" ADD CONSTRAINT "mcp_sessions_revoked_reason_check"
  CHECK ("mcp_sessions"."revoked_reason" is null or "mcp_sessions"."revoked_reason" in
         ('user_revoke', 'grant_revoked', 'refresh_reuse', 'client_revoke', 'client_id_mismatch'));
```
- 保留全部既有合法取值，只**增加** `client_id_mismatch`
- 不改既有撤销语义、不删历史数据
- journal `idx 4` + `0004_snapshot.json`

**`0005_mcp_metadata_version.sql`**
```sql
ALTER TABLE "mcp_oauth_clients" ADD COLUMN "metadata_version" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD CONSTRAINT "mcp_oauth_clients_metadata_version_check"
  CHECK ("mcp_oauth_clients"."metadata_version" >= 1);
```
- **无回填**：`DEFAULT 1` 对既有行即刻生效（PG 11+ metadata 级操作、不重写表）
- 新插入默认 1；CHECK 拒 0 / 负数
- journal `idx 5` + `0005_snapshot.json`
- **同步更新 Drizzle Schema**：`metadataVersion: bigint("metadata_version", { mode: "number" }).notNull().default(1)` + `check(… >= 1)`

### 3.4 `cimd.ts` 纯校验层（任务 §三.5）

| 变更 | 说明 |
|---|---|
| `conflictsWithTrustedIdentifier(clientId, trusted)` | 纯函数、逐字符比较、不读 env / 不发网络（设计 §3.2 原签名） |
| `isUrlShapedClientId(clientId)` | 形态闸门：原始串是否含 `scheme://`（不做 WHATWG 解析） |
| `clientIdConflictsWithTrusted(clientId, trusted)` | **组合谓词**：URL 形态才比较；不透明 id 跳过。fetch 与 3B-2 registry 共用 |
| `grant_types` 缺省 | 省略 → `["authorization_code"]`（替换原 `["authorization_code","refresh_token"]`） |
| `response_types` 缺省 | 省略 → `["code"]` |
| 空数组 ≠ 省略 | `[]` 走 §6 交集为空拒绝，**不被缺省值洗白** |
| 交叉一致性（§5.6 规则 1） | `R ∋ code ⇒ G ∋ authorization_code`，违反 → terminal `document` |
| `fetchClientMetadataDocument` | 新增可选 `options.trustedIdentifiers`；**在 `validateClientIdentifierUrl` 之后、DNS 之前**做冲突检查 |
| `CimdFailureReason` | 新增 `"client_id_conflict"` |
| `createCimdDeps(proxy)` | 移除 `= process.env` 默认参数；不设置 `caOverride` |

---

## 4. Schema 与 Drizzle bigint 映射（任务 §四.4 要求实测）

**实测**（真实 PostgreSQL 16 + postgres.js 3.4.9 + Drizzle 0.45.4，2026-11-20）：

| 读取路径 | `metadata_version` 读回 | `typeof` |
|---|---|---|
| **裸 `handle.sql`**（postgres.js 直读 `int8`） | `"1"` | **`string`** |
| **Drizzle `db.select`**（列映射器 `mode: "number"`） | `1` | **`number`** |
| Drizzle 读回 `+1` 后 | `2` | `number` |
| Drizzle 条件 UPDATE（`where metadataVersion = <number>`） | 命中 1 行 → 返回 `3` | `number` |

**结论与决定**：

1. **采用 `bigint(..., { mode: "number" })` → JS `number`**（不是 `bigint`）。
   理由：它是从 1 起、每次 +1 的计数器，永不会接近 `Number.MAX_SAFE_INTEGER`；
   用 `number` 与项目里其它计数（`epoch`、`generation`）保持同一运行时类型，
   避免「有的地方 number、有的地方 bigint」的隐式转换与 `===` 踩坑。
2. **生产读路径必须走 Drizzle**（`db.select` / `.returning()`）。裸 `handle.sql`
   读到的是**字符串** `"1"`，`version === 1` 会**静默失败**——这正是任务书
   「避免运行时类型不一致」的落点，已由迁移测试的双路径断言钉住。
3. **写路径**：Drizzle `eq(metadataVersion, <number>)` 作 CAS 谓词经实测命中正确；
   `set({ metadataVersion: sql\`metadata_version + 1\` })` 走 SQL 表达式。
4. `metadata_fetched_at` **不再**作 CAS 令牌（R2 已推翻）；本阶段未引入任何
   用它做等值比较的代码。

**不变量扫描（任务 §四.4）**：全仓 `.update(mcpOauthClients)` 调用数 = **0**
（`mcp_oauth_clients` 尚无任何 UPDATE 路径——registry 属 3B-2）。因此
「每条 UPDATE 必须 `version+1`」目前**无违反路径**；3B-2 落地 registry 时必须
按 §8.1 实现，并补「剥注释后扫描全部 `.update(mcpOauthClients)`」的守卫测试。

---

## 5. CIMD 纯函数变更与测试覆盖

### 5.1 变更清单

见 §3.4。全部是**纯函数 / 文档校验**，未接入 authorize。

### 5.2 本阶段测试（任务 §四 要求的三组）

| 组 | 文件 | 覆盖 |
|---|---|---|
| **迁移与 Schema** | `tests/db/migrations.test.ts`（新增 describe，3 条） | 迁移前已存在行 → `metadata_version = 1` 且只多一列；新行默认 1；CHECK 拒 0/负数；版本 CAS 单写者（Drizzle 条件 UPDATE 命中 1 / 0 行）；bigint 双路径映射；`client_id_mismatch` 合法 + 旧值可用 + 非法值被拒 |
| **CIMD 纯校验** | `tests/mcp-oauth/cimd.test.ts`（新增 2 个 describe，12 条） | 缺省 grant/response；空数组 ≠ 省略；仅 `authorization_code`（不带 refresh）；`authorization_code + refresh_token`；`refresh_token + code` 拒（含省略 response 的隐式 `code`）；空交集；issuer/resource/peer 冲突；预注册 URL id 冲突；不透明 id 放行；**冲突检查在 DNS 与网络之前**（`resolve`/`request` 计数 = 0）；不传信任列表时行为不变 |
| **配置与 TLS** | `tests/env/env-proxy.test.ts`（新文件，16 条）+ `tests/net/*`（跟随改名） | 直连 / 显式 http / https / 缺失 / 非法（socks5、`http://`）/ 大小写优先与冲突告警 / `NO_PROXY`；启动日志脱敏（凭据 `@`、密码、unsupported 主机名一律不出现）；`mcpTrustedPeerIdentifiers` 缺省 / 解析 / 非 URL 拒 / 非 http(s) 拒；直连与代理行为；`caOverride` 校验行为（不传必须拒自签名） |

**既有测试的三处修订（均为 R2 契约要求，非弱化）**：

| 文件 | 原断言 | 新断言 | 依据 |
|---|---|---|---|
| `cimd.test.ts` | `grant=[refresh_token]/response=[code]` **放行** | **拒绝**（`inconsistent grant_types/response_types`） | R2 §5.6 推翻旧结论 |
| `cimd.test.ts` | 缺省 `grantTypes = ["authorization_code","refresh_token"]` | **`["authorization_code"]`** | RFC 7591 §2 + R2 §5.6 |
| `schema.test.ts` | 「revoked_reason **四个**已知原因」+ 循环 4 个 | 「**五个**」+ 循环含 `client_id_mismatch` | 迁移 0004 |

> 三条都是**按契约变严或修正**（拒绝更严格、缺省更符合 RFC、覆盖增加），
> **没有删除或弱化任何既有断言**。

---

## 6. 门禁实测（任务 §六）

| # | 门禁 | 实际执行 | 结果 |
|---|---|---|---|
| 1 | Cloud 类型检查 | `cd cloud && npx tsc --noEmit` | ✅ 无输出（0 error） |
| 2 | Cloud lint | `cd cloud && npx eslint src tests` | ✅ 无输出（0 error / 0 warning） |
| 3 | 相关单元测试 | `npx vitest run tests/env/env-proxy.test.ts tests/db/migrations.test.ts tests/mcp-oauth/cimd.test.ts` | ✅ **248 passed / 3 files** |
| 4 | 迁移测试（真实 PG） | 同上（`tests/db/migrations.test.ts` 走真实 PostgreSQL 16） | ✅ 0004 / 0005 全部通过（含加列后旧行默认值、CHECK 拒绝、单写者 CAS） |
| 5 | journal / Schema 一致性 | `drizzle-kit generate` 产出 journal `idx 4/5` + `0004/0005_snapshot.json`；`npx tsc --noEmit` 通过 | ✅ 一致 |
| 6 | 版本递增约束扫描 | `grep -rn "\.update(mcpOauthClients)" src/` | ✅ **0 处**（尚无 UPDATE 路径；3B-2 落地时必须带 `version+1` 并补守卫测试） |
| 7 | Desktop 生产代码无改动 | `git status --porcelain -uall` | ✅ 无任何 `Desktop/` 文件 |
| 8 | 未声明 CIMD 能力 | `git diff --name-only` 不含 `discovery.ts`；`grep client_id_metadata_document_supported src/` | ✅ 未声明、未改动 |
| 9 | git diff 无越界修改 | 见 §7 文件清单 | ✅ 仅 cloud 源码 / 测试 / 迁移 / 文档 |

**完整测试套件**（额外执行）：

```
cd cloud && npx vitest run
→ Test Files  66 passed (66)
  Tests       1397 passed (1397)      # 基线 1355 / 65 files → +42 / +1 file
```

**全部命令与结果**：

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过（无输出） |
| `npx eslint src tests` | 通过（无输出） |
| `npx vitest run` | **1397 passed / 66 files**，0 failed |
| `npx drizzle-kit generate --name mcp_session_revoked_reason` | 生成 `0004_mcp_session_revoked_reason.sql` |
| `npx drizzle-kit generate --name mcp_metadata_version` | 生成 `0005_mcp_metadata_version.sql` |
| 失败项 | **无** |

---

## 7. 修改文件清单

**源码（6）**

| 文件 | 变更 |
|---|---|
| `cloud/src/env.ts` | 新增代理 6 变量 + `MCP_TRUSTED_PEER_IDENTIFIERS` 解析；`Env.outboundProxy` / `Env.mcpTrustedPeerIdentifiers`；`resolveOutboundProxy()` / `parseTrustedPeerIdentifiers()` |
| `cloud/src/net/proxy-fetch.ts` | 新增 `OutboundProxy` / `OutboundProxyScheme` / `directOutboundProxy()` / `describeOutboundProxy()`；`TunnelOptions.ca`→`caOverride`、`PinnedRequestOptions.ca`→`caOverride`；`resolveProviderFetch(proxy,…)` / `resolvePinnedProxy(host,proxy)` / `PinnedRequestOptions.proxy` 消费统一配置 |
| `cloud/src/mcp-oauth/cimd.ts` | `createCimdDeps(proxy)` 去默认参数；`isUrlShapedClientId` / `conflictsWithTrustedIdentifier` / `clientIdConflictsWithTrusted`；grant/response 缺省 + 交叉一致性；`fetchClientMetadataDocument` 的 `trustedIdentifiers`（DNS 前）；`CimdFailureReason` + `client_id_conflict` |
| `cloud/src/app.ts` | `resolveProviderFetch(env.outboundProxy)`；启动记一次脱敏 `outbound_proxy` 日志 |
| `cloud/src/db/schema.ts` | `metadataVersion`（`bigint mode:"number"` + `CHECK >= 1`）；`revoked_reason` CHECK 增 `client_id_mismatch` |
| `cloud/src/db/migrations/{0004,0005}_*.sql` + `meta/{_journal,0004_snapshot,0005_snapshot}` | 迁移与快照（drizzle-kit 生成） |

**测试（7）**

| 文件 | 变更 |
|---|---|
| `cloud/tests/env/env-proxy.test.ts` | **新文件**（16 条：代理解析 / 脱敏 / trusted peer 格式） |
| `cloud/tests/db/migrations.test.ts` | 新增 describe（3 条：0004 / 0005） |
| `cloud/tests/mcp-oauth/cimd.test.ts` | 新增 2 describe（12 条）；修订 2 条既有断言（缺省值、交叉拒绝） |
| `cloud/tests/mcp-oauth/schema.test.ts` | revoked_reason 四 → 五个原因 |
| `cloud/tests/net/proxy-fetch.test.ts` | `ca`→`caOverride`、`env`→`proxy`、`resolveProviderFetch` 签名 |
| `cloud/tests/net/pinned-request.test.ts` | `resolvePinnedProxy` 签名 + socks5×NO_PROXY 顺序用例 |
| `cloud/tests/helpers/env.ts` | 测试 `Env` 补 `outboundProxy`（直连）/ `mcpTrustedPeerIdentifiers` |

**文档（4）**：设计契约（§8.5 / §12 / §13.6 / §13.10 / §17）、本报告、
`REMOTE_MCP_PHASES_ROADMAP.md`、`REMOTE_MCP_INDEX.md`。

**未改**：任何 Desktop 文件、`discovery.ts`、authorize / consent / token / revoke
生产逻辑、`package.json` / lockfile、既有 1355 条测试断言（除上述 3 条契约修订）。

---

## 8. 未解决问题

| # | 问题 | 归属 |
|---|---|---|
| 1 | `mcp_oauth_clients` 尚无任何 UPDATE 路径，「每条 UPDATE 必须 `version+1`」的守卫测试**无法在本阶段落地** | C3c-3B-2（registry 落地时补「剥注释扫描」测试） |
| 2 | Consent 失败分支的「提交语义」只冻结在 §8.5，**未实现、未测试** | C3c-3B-2（任务 #8） |
| 3 | ABSENT 负面冷却只有设计，**未实现**（无调用点） | C3c-3B-2（registry 内实现，按 §8.5 边界三） |
| 4 | `CimdFailureReason` 中「交集为空」与「字段非法」目前**都是 `document`**，而 §15 审计要求两者映射到不同事件（`mcp_cimd_unsupported_grant` vs `mcp_cimd_document_invalid`）——单靠 `reason` 无法区分 | C3c-3B-2 落地审计层时需引入可区分判据（如独立 `unsupported_grant` reason 或结构化 sub-reason） |
| 5 | 测试矩阵 74 条中，仅迁移 / CIMD / 配置三组已在本阶段实现；#6–#12 相关用例（registry、consent、token）**未写** | C3c-3B-2 |
| 6 | `no-cache` 客户端 30 秒内无法二次 authorize（沿用 R2 风险 3） | 1.3.3 观察 |
| 7 | 迁移 0004 改 CHECK 会短暂锁表 | 发布流程（与 0005 合并维护窗口） |

---

## 9. 下一阶段建议（C3c-3B-2）

按设计 §12 的 #6–#12 顺序，**必须先做 #6（registry）**，因为 #7–#11 都依赖它：

1. **`cimd-registry.ts`**：`resolveClientForAuthorize()`——长度 → 形态 → 身份冲突
   （URL 形态，含预注册，复用 `clientIdConflictsWithTrusted`）→ 查行 → 缓存四态 →
   floor → 抓取 → 注册 / **版本 CAS**；**实现 §8.5 边界一**（成功刷新失败 503、
   mismatch 失败 400 零撤销、行已删除 / DB 异常的确定处置）；实现 §8.5 边界三的
   ABSENT 负面冷却。
2. **`revokeMcpGrantsAndSessionsByClient()`**：与版本 CAS **同一事务**，CAS 命中
   1 行才撤（§8.1）。
3. **`consent-flow.ts` 四条件 + §8.5 边界二提交语义**：失败分支只「清理 + 审计」
   后提交，不写 Grant / Code。
4. **authorize / 路由 HTML 错误页 / token gating / consent-page**（#9–#12）。
5. **守卫测试**：`.update(mcpOauthClients)` 扫描必须带 `version+1`；Consent 失败
   分支的「删行 + 审计已提交」；ABSENT 冷却不存响应内容。
6. **解决 §8-4**：为审计映射引入可区分 `CimdFailureReason`（或结构化 sub-reason）。

**本阶段到此为止，未开始 C3c-3B-2。**
