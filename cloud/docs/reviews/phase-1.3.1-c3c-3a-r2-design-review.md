# BrewPhase Phase 1.3.1-C3c-3A-R2 — CIMD 缓存失效与待处理授权一致性（第三轮审查）

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> 审查基线：`0ffd0cf4a8036ded0c42e8226ab158329a384f1b`（C3c-3A-R1 终态，本地 = 远程）
> 上一轮报告：`phase-1.3.1-c3c-3a-r1-design-review.md`（**原文保留，不覆盖**）
> 设计正文（已修订 v3）：`docs/design/phase-1.3.1-c3c-3a-cimd-authorize-integration-contract.md`
> 性质：**第三轮独立设计审查与状态一致性闭环**。**没有生产逻辑改动、没有测试改动、
> 没有迁移、没有依赖变更、未改 Desktop、未声明 CIMD 能力。**
> 实测：真实 PostgreSQL 16（`brewphase-cloud-test-pg:54329`）临时探针 P0–P7，
> **执行后已删除**，对测试库的写入已逐条清理（复核：残留 0 行）。

---

## 1. 实际 HEAD 与基线

| 项 | 值 | 核对方式 |
|---|---|---|
| 分支 | `feature/remote-mcp` | `git branch --show-current` |
| 本地 HEAD | `0ffd0cf` | `git log -1` |
| 远程 HEAD | `0ffd0cf4a8036ded0c42e8226ab158329a384f1b` | `git fetch origin` + `git rev-parse origin/feature/remote-mcp` |
| 工作区 | 干净 | `git status --short`（空） |

提交链：`139731f`（C3c-2）→ `cb2e68c`/`92148bf`（R1）→ `326dcf1`/`502cbe7`（R2）
→ `6c20908`（R2v）→ `b45809f`（C3c-3A）→ `0ffd0cf`（C3c-3A-R1）。本轮以 `0ffd0cf`
为审查基线，**未回退任何远程提交**。

### 1.1 重读的代码与文档（不采信上一轮摘要）

代码：`cimd.ts`（全文，含 `validateCimdDocument` / `fetchClientMetadataDocument`）、
`authorize-flow.ts`、`consent-flow.ts`（GET / POST 逐行）、`sessions.ts`
（`createMcpSessionInTransaction` 的 Grant `FOR UPDATE`、`rotateMcpRefreshToken`）、
`token-flow.ts`（兑换与 refresh）、`routes/mcp-oauth.ts`（consent 两个 handler 与
失败出口）、`db/schema.ts`（`mcp_oauth_clients` / `mcp_auth_requests` /
`mcp_auth_codes` / `mcp_grants` / `mcp_sessions` / `mcp_refresh_tokens`）、
`db/audit.ts`（`AuthEventType` 全集）、`env.ts`、`net/proxy-fetch.ts`。

文档：`draft-ietf-oauth-client-id-metadata-document-03` 原文（§3 / §5 / §6 /
§6.1 / §6.2 / §9.1 / §9.2 / §10.1 / §10.5）、RFC 7591 §2 / §2.1 原文、
上一轮设计与两份审查报告、`REMOTE_MCP_PHASES_ROADMAP.md`、`REMOTE_MCP_INDEX.md`。

### 1.2 与任务书的核对

1. 任务书给的基线 `0ffd0cf` —— 一致（本地 = 远程）。
2. 任务书要求「保留此前两个版本的设计与审查历史」—— 已保留：设计文档 §17 分
   R1 / R2 两段记录；R1 报告原文不动（本轮只在其头部加一条「被 R2 修订」的指引）。
3. 任务书「44 条旧测试矩阵保留」—— §13.1–§13.5 原样保留（编号 1–44），
   R2 只追加 45–71。

---

## 2. 独立发现的问题

| # | 级别 | 问题 | 代码 / 文档根因 | 处置 |
|---|---|---|---|---|
| **F1** | **High** | **INVALID 可被迟到的成功刷新复活成 FRESH**。R1 的 CAS 只比 `metadata_fetched_at`，而 terminal INVALID 只改 `metadata_cache_expires_at`、**不推进 `metadata_fetched_at`** → 一个持有旧 `metadata_fetched_at` 的迟到成功，其 CAS 仍然命中，把已提交的 INVALID 覆盖成 FRESH | 设计 §8.1 写 `WHERE metadata_fetched_at IS NOT DISTINCT FROM $2`；§5.2 只写「标记 INVALID（expires_at = epoch）」 | **推翻 R1 D13**：唯一 CAS 令牌改为新增列 `metadata_version`（§8.1 / §8.2）；真实 PG **P1 复现缺陷、P2 证明修复** |
| **F2** | **High** | **Consent GET / POST 不查 INVALID**：R1 三条件（行存在 / `redirect_uri` ∈ 注册表 / `grant_types` 含 `authorization_code`）在 terminal 后**全部仍然成立**——INVALID 不清 `redirect_uris`、不删行 → 待处理授权照常签发授权码并 302 到旧回调 | 设计 §8.3 只有三条件；`consent-flow.ts` 的 `allowConsent()` 读 `mcp_oauth_clients` 只取 `client_name` | 判据扩为**四条件**（新增 `metadata_cache_expires_at ≠ epoch`），GET / POST 都查；**STALE 放行、只拒 INVALID**（§8.3） |
| **F3** | Medium | Token Endpoint 对**非 mismatch terminal** 的旧授权码策略未定：malformed / SSRF 会标 INVALID 但**不撤 Grant**，于是旧 code 照常可兑换——任务书要求明确「已完成的 code」与「pending consent」是否不同信任阶段 | 设计 §8.3 边界只写了「不追溯回调 + 复核注册存在与 authorization_code」 | 新增 **§8.4**：三信任阶段；非 mismatch terminal **不阻断**兑换（不查 INVALID / 版本）；mismatch 由 Grant 撤销天然拦截 |
| **F4** | Medium | `grant_types` / `response_types` **只各自求交集、不查交叉一致性**：`grant=[refresh_token]` + `response=[code]` 两数组都含受支持值却被接受，而该组合自相矛盾（code 只能由 `authorization_code` 产生） | `cimd.ts` L708–719 两个独立 `.some(...)`，无关联检查 | 新增 **§5.6**：RFC 7591 §2.1 交叉规则；默认值先于检查；该组合 → terminal |
| **F5** | Medium | 身份冲突检查按 `registration_source` 一刀切：`pre_registered` / `dcr` **完全跳过** §10.1 比较 → 一个人工预注册的 URL id 若等于 issuer / resource，会造成 token confusion 却不被拒 | 设计 §3.2 纪律 4「pre_registered / dcr 直接使用，不经过这条检查」 | 改为按 **client_id 形态**（URL 形态一律查），与来源无关（§3.2 纪律 4） |
| **F6** | Low | terminal 是否推进 `metadata_fetched_at` 未定：若不推进，§4.1 的「INVALID + <30s 直接拒绝」在常见情形下（上次成功抓取早已 >30s）**永远走不到** | §5.2 只写「标记 INVALID」，未写 fetched_at | §8.2 明确：**成功与 terminal 都写 `fetched_at = now`**（记录尝试、起算 floor）；transient 不写 |
| **F7** | Low | 缺少「consent 因 metadata invalid 被拒」的审计事件，无法回答任务书要求的「审计能说明授权请求因 metadata invalid 被拒」 | `audit.ts` 的 `AuthEventType` 只有 `mcp_consent_allowed/denied/csrf_mismatch` | 新增 `mcp_consent_metadata_invalid`（§15；`event_type` 是 text 无 CHECK，**不需迁移**） |
| **F8** | Info | 迁移 0004 的必要性被实测确认：当前 `mcp_sessions_revoked_reason_check` **拒绝** `client_id_mismatch` 取值 | schema CHECK 只含 4 个旧值 | **P7 实测**：写入即 `23514` 违反约束 → 3B 必须先落 0004 才能实现 mismatch 撤销 |

**F1 / F2 是本轮的两个 High**，都产生真实后果：F1 让一次已提交的终端失效被
静默撤销；F2 让身份已失效的客户端继续走完待处理授权。两者都已关闭。

---

## 3. 真实 PostgreSQL 实测证据（P0–P7）

**环境**：真实 PostgreSQL 16（容器 `brewphase-cloud-test-pg`，54329）+ postgres.js
3.4.9 + 真实的 `mcp_oauth_clients` / `mcp_grants` / `mcp_sessions` /
`mcp_auth_requests` / `mcp_auth_codes` 表。**不是 mock。** 临时探针脚本执行后已删除，
fixture 行已清理（残留 0）。

| 探针 | 操作 | 实测输出 | 证明什么 |
|---|---|---|---|
| P0 | `to_regclass('mcp_oauth_clients')` | 命中 | 测试库 schema 已迁移 |
| **P1a** | 行 `(fetched=T0, expires=E0)`；B `UPDATE SET expires=epoch WHERE fetched=T0`（R1 式 INVALID，不推进 fetched） | **hit=1** | INVALID 条件更新本身成功 |
| **P1b** | 紧接 A `UPDATE SET fetched=T1, expires=E1 WHERE fetched=T0` | **hit=1** | **F1 缺陷复现**：迟到成功 CAS 覆盖 INVALID |
| **P1c** | 读回终态 | `expires = …11:00:30Z`（= E1） | 终态被写成 **FRESH**，INVALID 已死 |
| **P2a** | 行 `(version=1)`；B `UPDATE SET version=version+1, expires=epoch WHERE version=1` | **hit=1** | 版本 CAS 的 INVALID 更新成功 |
| **P2b** | A `UPDATE SET version=version+1, … WHERE version=1` | **hit=0** | **F1 修复**：迟到成功命中 0 行 |
| **P2c** | 读回终态 | `version=2, expires=epoch` | **INVALID 存活**，未被复活 |
| **P3a** | 两事务持同一 `version=1` 各自 `UPDATE … WHERE version=1` | 第二个 `wait_event_type='Lock'`、`pg_blocking_pids=[第一个]` | 真实行锁等待（不是 sleep 猜的） |
| **P3b** | 提交后计数 | `tx1=1, tx2=0` | **并发只有一个写入者获胜** |
| **P3c** | 读回 | `version=2` | 版本只递增一次 |
| **P4a** | 终端事务持 `mcp_oauth_clients` 排他锁；Consent 事务 `FOR SHARE` | Consent 阻塞（`blockers=[终端]`、`wait=transactionid`） | §8.3 的 `FOR SHARE` 确实与终端 `UPDATE` 冲突 |
| **P4b** | 终端提交后 | 两事务均返回 | **无死锁** |
| **P4c** | Consent 读到的 `expires` | `epoch` | Consent 读到**已提交的 INVALID** → 会拒绝 |
| **P5a** | 终端 `clients → grants → sessions`；兑换 `auth_codes → grants` | 兑换在 grant 行上等待终端 | §8.4 锁序真实交错 |
| **P5b** | 终端提交后 | 兑换读到 `grant.revoked_at` 非空 | 兑换会因 Grant 已撤而拒绝；**无死锁** |
| **P6** | 同一 client 两用户并发 Consent（各自 auth_request + `FOR SHARE` + 各自 grant 行） | 两两都成功、`err=null` | `FOR SHARE` 兼容、并发同意无死锁 |
| **P7** | 向 `mcp_sessions` 写 `revoked_reason='client_id_mismatch'` | `23514 violates mcp_sessions_revoked_reason_check` | **迁移 0004 必需**（F8） |

**P1 是本轮最关键的证据**：它把任务书 §2 描述的竞态在真实 PostgreSQL 上跑成了
「迟到成功命中 1 行、终态 FRESH」，而不是纸面推演。P2 用同一张表、同一套时序、
只把 CAS 令牌换成 `metadata_version`，结果变成「命中 0 行、INVALID 存活」。

---

## 4. 规范对齐（R2 新增部分）

标注：`MUST` / `SHOULD` 为原文强度；`[项目策略]` 是本地更严格选择。

| 条款 | 强度 | 内容 | R2 结论 |
|---|---|---|---|
| [ID §6] | **MUST** | `grant_types` / `response_types` 与 AS 支持集交集为空 → `invalid_client` | 已实现；错误码在 authorize 层由 3B 映射（沿用 R1） |
| [RFC 7591 §2] | — | `grant_types` 缺省 `["authorization_code"]`；`response_types` 缺省 `["code"]` | 当前 `cimd.ts` L725 缺省仍是 `["authorization_code","refresh_token"]` → **3B 改**（§5.6） |
| [RFC 7591 §2.1] | SHOULD | 服务器应阻止客户端注册进不一致的 grant/response 组合 | **R2 新增**交叉规则（§5.6）；`[refresh_token]/[code]` → terminal |
| [ID §10.1] | **SHOULD** | 拒绝等于自身 issuer / 受信 AS/RS 标识的 **Client Identifier URL** | R2 修正适用范围：按**形态**而非 `registration_source`（§3.2） |
| [ID §6.1] | SHOULD / MUST NOT | mismatch **SHOULD** 立即使 refresh 失效；失败 **MUST NOT** 重定向到客户端 | 沿用 R1；R2 补：token 端点的 `invalid_client` 只在「本次 token 请求触发的抓取失败」时适用，本项目 token 端点**不抓取**，故不触发 |
| [ID §4.2] | **MUST** | 授权请求的 redirect URL 必须是已注册值的**精确匹配** | Consent 四条件之 3（GET / POST 都查） |
| [ID §6.2] | MAY | 可限流，即使低于 Cache-Control 要求 | 沿用 30s floor；**不**授权使用过期数据完成**新**授权；in-flight consent 放行 STALE 是另一回事（§8.3） |

**没有发现新的 MUST 违反**；R2 的三处「SHOULD → [项目策略] terminal」方向与
规范一致（更严格）。

---

## 5. 已冻结的决策（本轮关闭，不再留待复审）

| # | 决策 | 出处 |
|---|---|---|
| D1 | **唯一 CAS 令牌 = `metadata_version BIGINT NOT NULL DEFAULT 1`**（新增列，迁移 0005）；`metadata_fetched_at` 降级为 floor / 取证时间戳 | §8.1 / §8.2 |
| D2 | **每条 `mcp_oauth_clients` 的 UPDATE 必须 `metadata_version = metadata_version + 1`**（不变量 + 扫描测试） | §8.1 |
| D3 | CAS 0 行（成功或 terminal）→ **一律丢弃结果**，不重试写、不合并、不撤销；重读仅用于区分「版本变了 / 行没了」 | §8.1 / §8.2 |
| D4 | **mismatch 的撤销权 = 版本失效权**：CAS 命中 1 行才在同一事务撤销 Grant → Session → 审计；被拒的 mismatch **一个都不撤** | §8.1 / §8.4 |
| D5 | 成功与 terminal **都写 `metadata_fetched_at = now`**（起算 floor）；transient 与冷却拒绝**不写** | §8.2 |
| D6 | **Consent 四条件**（行存在 / `≠ epoch` / redirect ∈ 注册表 / `grant_types` ∋ `authorization_code`）；GET 与 POST 都查 | §8.3 |
| D7 | **STALE 放行 in-flight consent、只拒 INVALID**（否则 `no-cache` 永远走不完） | §8.3 |
| D8 | **不存 `mcp_auth_requests.metadata_version` 快照**（方案 B）；按字段而非按版本拒绝 | §8.3 方案选择 |
| D9 | Consent 失败删 auth request + 审计 **`mcp_consent_metadata_invalid`** | §8.3 / §15 |
| D10 | **三个信任阶段**：pending consent（严格四条件）→ 已签发 code（结构校验）→ 已签发凭据（不受非 mismatch INVALID 影响） | §8.4 |
| D11 | 非 mismatch 的 terminal（malformed / SSRF / …）**不阻断**旧 auth code 兑换；**不查** INVALID / 版本 / `redirect_uri` 是否仍注册 | §8.4 |
| D12 | mismatch 后旧 code 兑换**必然失败**（Grant 已撤 → `createMcpSessionInTransaction` 拒），且兑换**不写 `mcp_grants`** → 无「重建 Grant 绕过撤销」路径 | §8.4 |
| D13 | `grant_types` / `response_types` 缺省按 RFC 7591 §2；**`[refresh_token]`/`[code]` 拒绝**；空数组 ≠ 省略 | §5.6 |
| D14 | 身份冲突按 **client_id 形态**适用：URL 形态（含预注册）一律比对 issuer / resource / peer；不透明 id 豁免 | §3.2 |
| D15 | 迁移 **0004**（CHECK）与 **0005**（`metadata_version`）都属 3B；本轮只提出不实施 | §11 |
| D16 | 3B **不声明** `client_id_metadata_document_supported`（沿用 R1 D17） | §12.2 |

---

## 6. 被排除的方案（含本轮新增）

| 方案 | 为什么排除 |
|---|---|
| **方案 A：复合 CAS（`fetched_at` + `expires_at`）** | 主竞态可挡，但**同毫秒**两次写值相同 → 可能双双命中，「只有一个版本获胜」无法结构性断言；且仍耦合 R1 已实测的微秒截断 / 裸 `Date` 抛错两类驱动坑。P3 表明版本 CAS 才是确定单写者 |
| **方案 A′：只让 INVALID 推进 `metadata_fetched_at`（不加列）** | 能挡住 P1 的主竞态，但把正确性绑在「fetch floor ≥30s 保证 fetched_at 不碰撞」这条**派生不变量**上——floor 一旦被改成 0 或被旁路就静默失效；时钟回拨仍可让新值等于旧值 |
| **Consent 存 `metadata_version` 快照（任务书方案 A）** | 对纯展示字段（`client_name` 等）误拒；`no-cache` 下每次 authorize 都递增版本 → 并发授权互相踩版本，第一个用户的 consent 被第二个用户的刷新误拒（违反「不能让每次授权永远无法走完」）；且换不来额外有效性覆盖（四条件已完整） |
| Consent 要求每步 FRESH | `no-cache`（`ttl=0`）永久 STALE → 授权**永远走不完**，任务书明令禁止 |
| 非 mismatch terminal 也撤销 Grant / Session | 超出 [ID §6.1]（只有 mismatch 是 SHOULD，其余 MAY），把文档事故放大成全量掉线（沿用 R1 D6） |
| 非 mismatch terminal 阻断旧 code 兑换（查 INVALID） | 与「INVALID 不撤 Refresh Token」割裂（refresh 活着、59 秒的 code 却换不了）；consent 已验四条件、code 绑定签发时 redirect_uri + PKCE；[ID §6.1] 的 abort 针对**授权请求**而非已完成兑换 |
| mismatch 后允许兑换、靠「重建 Grant」恢复 | D12：兑换不写 `mcp_grants`，结构上不存在该路径；Grant 已撤 → 必然 `invalid_grant` |
| 用进程内 Map / 单例状态存版本 | 任务书 §7 明令禁止；多实例与重启都会失效 |
| 用 `now()` 比较做并发控制 | 时钟回拨让旧数据覆盖新数据（沿用 R1） |
| 身份冲突只在 fetch前做、预注册跳过 | F5：预注册 URL id 等于 issuer / resource 仍会 token confusion |

---

## 7. PostgreSQL 锁顺序与事务交错（任务书 §7）

### 7.1 全局锁序（R2 增补后）

```
mcp_auth_requests  ≺  mcp_oauth_clients  ≺  mcp_grants  ≺  mcp_sessions
        mcp_auth_codes  ≺  mcp_grants
        mcp_refresh_tokens  ≺  mcp_sessions
```

`metadata_version` 只在 `mcp_oauth_clients` 单表递增，**不引入新边**。

### 7.2 五个问题的逐条回答

| # | 问题 | 结论 |
|---|---|---|
| 1 | 终端 INVALID 是否先锁 clients、再锁 grants、再锁 sessions？ | **是**。CAS `UPDATE mcp_oauth_clients`（U，命中 1 行才继续）→ `UPDATE mcp_grants`（U）→ `UPDATE mcp_sessions`（U）→ 审计，**同一事务**（§8.1）。P4 / P5 实测该顺序无死锁 |
| 2 | Consent POST 是否先锁 auth_requests、再锁 clients？ | **是**。`auth_requests(U)` → `oauth_clients(S)` → `grants(UPSERT)` → `auth_codes(I)`（§8.3） |
| 3 | 是否存在 client → auth_request 的反向锁？ | **否**。authorize 读 `oauth_clients` 是**无锁普通 SELECT**（不入锁图）随后 INSERT 新行；终端 / 刷新路径完全不碰 `auth_requests`；只有 Consent 是 `auth_requests → clients` |
| 4 | 是否存在 session → grant 的反向锁？ | **否**。`rotateMcpRefreshToken` 对 grants 只做**无锁普通 SELECT**；持有 session 行锁时从不反向要 grant。创建与撤销路径都是 `grant → session` |
| 5 | 是否出现 `FOR SHARE` 与 `UPDATE` 组合中的等待环？ | **否**。两者在 `clients` 上是 S/U 冲突，但只有**单向等待**：Consent 等终端（Consent 已持 `auth_requests`，终端不需要它）；终端等 Consent（终端首锁是 `clients`，不持任何 Consent 需要的锁）。P4 / P6 实测无 `40P01` |

### 7.3 四条真实事务交错（P4 / P5 / P6 实测，非推演）

**交错 1 — 终端 INVALID vs Consent POST（P4）**

```
时刻  终端事务 T                                Consent 事务 C
t1    BEGIN
t2    UPDATE mcp_oauth_clients                 BEGIN
      SET expires=epoch WHERE client_id=c      SELECT mcp_auth_requests … FOR UPDATE（持 auth_req）
      （持 clients 排他锁）
t3                                    SELECT mcp_oauth_clients … FOR SHARE → 等 T
t4    UPDATE mcp_grants …（持 grants）
t5    UPDATE mcp_sessions …（持 sessions）
t6    COMMIT（释放 clients/grants/sessions）
t7                                    FOR SHARE 拿到锁 → 读到 expires=epoch
t8                                    四条件之 2 失败 → ROLLBACK（含删行）→ 400
```
实测：t3 处 `wait_event_type='Lock'`、`pg_blocking_pids=[T]`；两事务均完成。

**交错 2 — 终端 INVALID vs Token 兑换（P5）**

```
时刻  终端事务 T                                兑换事务 E
t1    BEGIN → UPDATE clients（排他）
t2    UPDATE mcp_grants …（持 grant G）         BEGIN → SELECT auth_codes … FOR UPDATE（持 code）
t3                                    SELECT mcp_grants … FOR UPDATE → 等 T
t4    （gate）COMMIT
t5                                    拿到 G → 读到 revoked_at 非空 → invalid_grant → 回滚
```
反向（E 先拿 G）：E 建 Session 并提交 → T 拿 G 后撤销该 client **全部** Grant 与
**全部** Session（含刚建的）→ 无存活会话。**两种线性化都正确，无死锁。**

**交错 3 — 两个并发刷新（P3 / P1–P2 语义）**

```
A、B 都读 version=V（事务外）→ 各自网络抓取（无事务）
A: BEGIN → UPDATE … SET version=V+1 WHERE version=V → 命中 1 行 → COMMIT
B: BEGIN → UPDATE … SET version=V WHERE version=V → 等 A 的行锁 → A 提交后
   READ COMMITTED EPQ 重评 → version 已是 V+1 → 0 行 → 丢弃结果（不写、不撤销）
```
实测 P3a：B 确实阻塞；P3b：`tx1=1, tx2=0`。

**交错 4 — 同一 client 两用户并发 Consent（P6）**

```
C1: auth_req1(U) → clients(S) → grant1(UPSERT) → code1(I)
C2: auth_req2(U) → clients(S) → grant2(UPSERT) → code2(I)
```
`FOR SHARE` 兼容、grant 行按 `(user,client,resource)` 不同 → 两两成功，无死锁（实测 `err=null`）。

**结论**：所有新增路径（版本 CAS、终端撤销、Consent 四条件、兑换、轮换）都沿
DAG 向下取锁；`metadata_version` 不产生新边；`FOR SHARE` / `UPDATE` 只有单向等待。
**不存在需要进程内 Map 才能保证的正确性**——正确性完全由 DB 行锁 + 版本 CAS 承担。

---

## 8. C3c-3B 施工顺序（R2 修订）

```
1  配置收口 (env.outboundProxy + mcpTrustedPeerIdentifiers, createCimdDeps 去默认参数)
2  TLS 语义 (ca → caOverride)
3  迁移 0004（revoked_reason 增 client_id_mismatch）   ← P7 已证必需
4  迁移 0005（mcp_oauth_clients 加 metadata_version）  ← R2 新增，必须先于任何版本 CAS
5  cimd.ts（conflictsWithTrustedIdentifier + grant/response 默认值 + §5.6 交叉检查）
6  cimd-registry（长度 → 形态 → 身份冲突[含预注册 URL] → 缓存四态 → floor → 抓取 → 注册/版本 CAS）
7  revokeMcpGrantsAndSessionsByClient（**与版本 CAS 同事务**，CAS 命中 1 行才撤）
8  consent-flow（GET/POST **四条件** + FOR SHARE + 失败删行 + mcp_consent_metadata_invalid）
9  authorize-flow 接入（错误映射 invalid_client）
10 路由 HTML 错误页 + 审计（§15 命名）
11 token 端点（invalid_client/503 + refresh_token gating + **旧码按 §8.4 不查 INVALID**）
12 consent-page（clientIdentifierHost）
13 测试矩阵 **71 条**（§13 全部）
14 文档同步
```

**两道额外闸门（§12.1）**：① 迁移 0005 落地前不得写版本 CAS（列还不存在）；
② Consent 四条件与 Token 旧码策略必须与版本 CAS **同一批**接入，不得只接其一。

**能力声明仍不在列表里**（3B 不声明，见 §12.2 / D16）。

---

## 9. 验收矩阵

共 **71 条**，分九组（R1 的 44 条原样保留，编号 1–44；R2 新增 27 条，45–71）：

| 组 | 编号 | 条数 | 覆盖 |
|---|---|---:|---|
| 13.1 注册与缓存 | 1–15 | 15 | 预注册 / FRESH / STALE / 冷却 / INVALID / `no-cache` / `no-store` |
| 13.2 mismatch 与撤销 | 16–22 | 7 | Grant + Session 双撤、跨 client 隔离、多 resource、零命中、重置后 epoch、审计回滚 |
| 13.3 竞态 | 23–28 | 6 | GET 拒、POST 拒、GET/POST 之间刷新、grant_types 变化、并发不死锁、签发后不追溯 |
| 13.4 字段与默认值 | 29–34 | 6 | 身份冲突、默认 grant/response、非法 grant |
| 13.5 既有边界 + CAS | 35–44 | 10 | 逐字符匹配、scope/resource/PKCE、代理一致性、CAS 精度与并发、同意页字段 |
| **13.6 A：CAS 与 INVALID 竞争** | **45–50** | **6** | 成功 vs mismatch、mismatch vs 迟到成功、malformed vs 成功、INVALID 不复活、CAS 拒绝不误撤、并发单写者 |
| **13.7 B：Pending Consent** | **51–58** | **8** | mismatch/INVALID 后 POST、version 不一致、GET/POST 之间 refresh·redirect·grant_types、INVALID 恢复后、no-cache 全流程、并发 POST |
| **13.8 C：Token Endpoint** | **59–63** | **5** | mismatch 后旧 code 失败、其他 terminal 后旧 code 确定行为、Grant 撤销不能重建 Session、refresh 未声明不签发/不轮换 |
| **13.9 D：规范一致性** | **64–71** | **8** | 默认值、独立交集、交叉约束、非法组合、issuer/resource 冲突、预注册 URL 冲突、不透明 id 豁免 |

每条新增用例都写明：初始数据库状态、事务 A/B 的准确操作顺序、预期最终数据库状态、
HTTP 返回、Grant / Session / Auth Code / Refresh Token 变化、审计事件、是否允许重试。
**A 组全部要求真实 PostgreSQL + 行锁 + `pg_stat_activity` / `pg_blocking_pids` 断言，
禁止 mock。**

---

## 10. 范围合规

| 检查 | 结果 |
|---|---|
| 生产 authorize / consent / token / revoke 逻辑 | **未改** |
| CIMD 抓取器接入生产链路 | **未接**（`createCimdDeps` 仍无调用方） |
| 数据库迁移 | **无新增文件**（0004 / 0005 只是设计，未写入 `src/db/migrations/`） |
| 真实 Schema | **未改**（探针未加列；P7 只读 CHECK 行为） |
| 依赖（`package.json` / lockfile） | **未动** |
| 测试代码 | **未改**（探针是临时脚本，已删除） |
| Desktop 生产代码 | **未改** |
| `client_id_metadata_document_supported` | **未声明** |
| 既有 44 条测试断言 | **未删、未弱化**（§13.1–13.5 原样） |
| 远程提交 | **未回退**（基线 `0ffd0cf`） |

本轮实测只用临时探针（执行后删除）；对测试库的写入限于 fixture 行，结尾已删除
并复核残留 0。

---

## 11. 仍未解决的问题

| # | 问题 | 归属 |
|---|---|---|
| 1 | 撤销 Session / Grant 不影响已签发的 Access Token（≤15 分钟） | 1.3.2 `/mcp` 按 `sid` 回查 |
| 2 | 代理主机名 DNS 查询无注入点（沿用 C3c-2-R2 结论） | 记录即可 |
| 3 | `no-cache` 客户端 30 秒内无法二次 authorize | 刻意 fail-closed；1.3.3 观察真实客户端是否用 `no-cache` |
| 4 | Punycode 展示可读性 | 1.3.3 UI 评估 |
| 5 | 是否「永久拉黑」反复 mismatch 的 client_id | 运营策略 |
| 6 | 迁移 0004 / 0005 需维护窗口（0004 改 CHECK 短暂锁表、0005 加列瞬时） | 发布流程 |
| 7 | **R2 新增**：Consent 放行 STALE，可能基于「最近一次抓取」的 `redirect_uris` 完成授权 | 已记录为风险 11：授权请求 10 分钟 TTL + authorize 成功时行必 FRESH → 数据最多 `ttl+10min` 旧，且条件 3 实时复核；`no-cache` 必须放行 |
| 8 | **R2 新增**：非 mismatch terminal 后 60 秒内的旧 code 仍可兑换 | 已记录为风险 12：信任阶段不同（§8.4），窗口仅 60 秒，且与「INVALID 不撤 Refresh」一致 |
| 9 | **R2 新增**：`[refresh_token]/[code]` 组合按 [RFC 7591 §2.1] SHOULD → [项目策略] terminal | 方向与规范一致（更严格）；若真实客户端被此规则挡下，1.3.3 反馈后可复议 |

---

## 12. 结论

- **F1 / F2 是两处会产生真实后果的 High**：F1 让已提交的 INVALID 被迟到成功
  复活（P1 真实复现），F2 让身份已失效的客户端走完待处理授权。两者都已关闭，
  且都有可执行判据与验收用例。
- **CAS 方案被推翻并重建**：`metadata_fetched_at` → `metadata_version`。这不是
  「补丁」而是把 CAS 从时间戳语义换成整数语义，同时消除 R1 已实测的两类驱动层坑
  对正确性的耦合。代价是迁移 0005（本轮只提出）。
- **Consent 判据从三条件扩到四条件并选定了唯一方案**（方案 B，不存快照列），
  附完整性论证（四条件覆盖全部授权有效性列）与 no-cache 完整流程。
- **Token 旧码策略给出唯一答案**（三信任阶段）：非 mismatch 不阻断、mismatch
  由 Grant 撤销天然拦截，且兑换不写 `mcp_grants` → 无绕过路径。
- **规范对齐新增 3 条**（RFC 7591 §2 默认值与 §2.1 交叉、§10.1 适用范围修正），
  方向全部更严格，无 MUST 违反。
- **锁序经真实 PostgreSQL 交错验证**（P4/P5/P6），四条反向路径全部排除，
  `metadata_version` 不引入新边。
- **范围合规**：未改生产逻辑、未改测试、未加迁移文件、未改 Schema、未改依赖、
  未动 Desktop、未声明能力、未回退远程提交、44 条旧矩阵原样保留。

**建议：允许进入 C3c-3B。** 3B 的第 3、4 步（迁移 0004 / 0005）与第 7、8 步
（撤销函数 / Consent 四条件）现在都有确定写法与真实 PG 证据，不需要再设计。

**本轮停止在 C3c-3A-R2，未开始 C3c-3B。**
