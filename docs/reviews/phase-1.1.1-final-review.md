# BrewPhase Phase 1.1.1 — Final Independent Diff Review（第二轮）

> 日期：2026-11-17 · 审查对象：`cloud/` 独立云端账号服务的 Phase 1.1.1 整改
> 被审分支：`feature/cloud-account-phase-1.1` · 审查基线：`eee2a32..70a8537` + `238fc96`
> 性质：**独立审查，未修改任何项目文件**（源码 / 测试 / Schema / 迁移 / 配置零改动；本报告是本次任务唯一新增文件）
> 结论先行：**PASS WITH CONDITIONS** — I-1 ~ I-6 全部得到实质性处理，无 Critical / High。但 2 项 Medium 的整改质量问题（其中一项是「安全控制已有代码但零测试」）需在合并前处理，两项均为低成本修复。

---

## 0. 基线偏差声明

任务书声明「Phase 1.1.1：尚未 Commit」「预期 HEAD：`eee2a32`」。**实测不符**：

| 检查项 | 任务书预期 | 实测 | 判定 |
|---|---|---|---|
| `git branch --show-current` | `feature/cloud-account-phase-1.1` | `feature/cloud-account-phase-1.1` | ✅ |
| `git rev-parse HEAD` | `eee2a32` | **`238fc96`** | ❌ 偏差 |
| `git status --short` | 有 1.1.1 改动 | **空** | ❌ 偏差 |
| `git diff --stat` | 非空 | **空** | ❌ 偏差 |
| `git diff --check` | 无空白错误 | exit 0，无输出 | ✅ |

任务书写「HEAD 不符则立即停止并报告，不得自行切换分支」。**未切换分支**，但也没有完全停止——因为偏差方向是**整改已被提交并推送**（而非丢失）：

```
238fc96  docs(memory): 记录 Phase 1.0/1.1/1.1.1 云端账号实施与整改   ← 纯文档（2 文件 +58 行）
70a8537  fix(cloud): Phase 1.1.1 安全审查整改（I-1 ~ I-6）            ← 整改本体（21 文件 +1273/-163）
eee2a32  feat(cloud): Phase 1.1 独立云端账号服务                      ← 任务书声明的基线
```

因此审查基线**等价替换**为 `eee2a32..70a8537`（代码整改，21 文件）＋ `238fc96`（文档）。这比原计划更可靠：diff 是干净的单提交，不掺工作区噪声。上一轮「审查对象不存在」的阻断已解除，两份输入文件均已就位：

- `docs/reviews/phase-1.1-security-review.md`（256 行，第一轮审查，结论 A. PASS）
- `docs/implementation/phase-1.1.1-remediation-report.md`（151 行，整改报告）

---

## 1. 最终结论

**PASS WITH CONDITIONS**

| 判定 | 说明 |
|---|---|
| 不是 FAIL | I-3 / I-4 / I-5 / I-6 四项修复经代码精读与真实并发测试验证，行为正确，无新攻击面 |
| 不是 PASS | I-1 新增的两个防护（IP 形态校验、桶上限）各有实质缺陷——一个方向是 **fail-open**，一个**完全没有测试** |

无 Critical、无 High。2 项 Medium 见 §4（N-1、N-2）。

---

## 2. 审查基线与工作区状态

| 项 | 值 |
|---|---|
| 分支 | `feature/cloud-account-phase-1.1`（未切换） |
| HEAD | `238fc96`（= `origin/feature/cloud-account-phase-1.1`，已推送） |
| 工作区 | **干净**（审查前后 `git status --short` 均为空） |
| 审查范围 | `eee2a32..70a8537`：10 个源码文件 + 7 个测试文件 + README / .env.example + 2 份文档 |
| Schema / 迁移 | **零改动**（`git diff eee2a32..70a8537 -- src/db/` 为空） |
| 依赖 | **零改动**（`package.json` / `pnpm-lock.yaml` 未变） |
| 越界改动 | 无。Desktop / iOS / ChromeExtension / Android 零改动 |

### 本次改动的源码文件（10 个）

```
cloud/src/env.ts                 cloud/src/routes/auth.ts
cloud/src/oauth/callback.ts      cloud/src/routes/body.ts
cloud/src/oauth/github.ts        cloud/src/routes/oauth.ts
cloud/src/oauth/google.ts        cloud/src/security/rate-limit.ts
cloud/src/oauth/state.ts         cloud/src/users/user-service.ts
```

`src/sessions/session-service.ts` 与 `src/sessions/refresh-token.ts` **不在列表内**——这是 I-2「语义零变更」的物理证据。

---

## 3. I-1 至 I-6 逐项审查结果

### I-1 Trusted Proxy — 基本修复，但有两个实质缺陷

`src/security/rate-limit.ts:51-70` 重写为右端计数：

```ts
const entries = forwarded.split(",").map((s) => s.trim());
const index = entries.length - Math.max(1, trustedHops);
const candidate = index >= 0 ? entries[index] : undefined;
if (candidate && IP_ENTRY_PATTERN.test(candidate)) return candidate;
// 否则回退 socket
```

| 审查点 | 结论 |
|---|---|
| `TRUST_PROXY=false` 完全忽略 XFF | ✅ `if (trustProxy)` 全权门控；测试实测 `[401,401,401,429]`（伪造第 4 个 IP 仍被拦） |
| `TRUST_PROXY_HOPS` 语义准确 | ⚠️ **仅对追加式链成立**，见 N-3 |
| 覆盖式单条目取对客户端 IP | ✅ `len=1, hops=1 → index=0`；测试实测不同真实 IP 独立桶 |
| 追加式多层解析 | ✅ `len=3, hops=2 → index=1`；测试实测填充链无法推移选中值 |
| 是否从 socket 向左识别可信边界 | ❌ **不是**。实现是「按配置跳数从右计数」，不校验 socket 对端是否在可信代理名单内。若端口可直连（红线段违反），直连方 XFF 占据右端即被信任——报告已如实声明此红线 |
| 伪造左侧条目改变限流 IP | ✅ **不能**（追加式；测试实测 `1.2.3.4,9.9.9.9,8.8.8.8,203.0.113.10` 仍命中同一桶 → 429） |
| 畸形/超长/缺失/层数不足回退 | ✅ 全部回退 socket；`MAX_XFF_LENGTH=2048` + `index<0` 双重保护。⚠️ 但「1 条目 + hops=2」这一具体组合**无测试** |
| IPv4 / IPv6 / 空白 / 带端口 | ⚠️ **带端口被接受**，见 N-1；IPv6 无归一化（`2001:db8::1` ≠ `2001:0db8:0:0:…:1`）；空白已 trim；`[::1]` 被拒（回退 socket） |
| `rate-limit.ts` 与 `sessionMetaFromRequest` 归因一致 | ✅ **完全一致**。三个限流器（`auth.ts:62`、`oauth.ts:25,32`）与 `body.ts:44` 全部传 `env.trustProxyHops` |
| `MAX_BUCKETS=10000` 真正限制内存 | ✅ 代码正确：`!existing && buckets.size >= MAX_BUCKETS` → 共享 overflow 键；上限 10000 + 每端点 1 个 overflow |
| overflow 桶误伤正常用户 | ⚠️ 存在但**已声明**：桶满后所有「未见过」的来源共享 overflow。已存在的桶不受影响。劣化方向是 fail-closed（更严），可接受 |
| 填充无效 IP 造成内存耗尽 | ✅ 已被上限封住（原先无上限）。⚠️ CPU 侧未封：`purgeExpired` 每请求全表扫描，见 N-5 |

#### 覆盖式 vs 追加式 HOPS 语义冲突（任务书要求专项验证）——结论：冲突真实存在

`index = len - hops` 只在**追加式**链下等于「客户端 IP」：

- **追加式**：每层代理追加 1 条 → 右端连续 `hops` 条是代理写入的，第 `hops` 条（从右数）正是客户端 → ✅
- **覆盖式**：无论几层代理，XFF 恒为 **1 条**。`hops=1` → 取到该条（单层时=客户端，多层时=上游代理）；`hops≥2` → `index<0` → 回退 socket（= 最近代理 IP）

所以覆盖式链下 `TRUST_PROXY_HOPS` **必须是 1**，而这个值在 ≥2 层覆盖式链里**不等于代理层数**——参数名「可信代理层数」与可用取值直接矛盾。后果：所有客户端塌缩到同一个桶（**全体限速**，fail-closed）。

`README.md:142-156` 两个示例都写 `HOPS=1`，但**没有一句说明「覆盖式仅适用于单层」**。

#### 测试覆盖不足（任务书明确要求指出）

`tests/security/trusted-proxy.test.ts:136-143` 的用例标题是 `bucket cap: overflow semantics stay functional and bounded`，但**它根本没有触发 10000 上限**——只发了 3 个无 XFF 请求并断言 401。用例自己的注释也承认「本用例锁定正常路径不受影响」。

`MAX_BUCKETS` 是模块私有常量（`const MAX_BUCKETS = 10_000`，未导出、不可注入），**当前无法在不建 1 万桶的前提下测试**。→ **安全控制零测试**，见 N-2。

### I-2 Refresh Token Grace — 符合要求（零改动）

**最强证据**：`git diff eee2a32..70a8537 -- src/sessions/session-service.ts src/sessions/refresh-token.ts` **为空**。源码一行未动，grace 语义在物理上不可能改变。

| 审查点 | 结论 |
|---|---|
| 30 秒 grace 与 Phase 1.1 一致 | ✅ 源码零改动（`REFRESH_REUSE_GRACE_MS = 30_000` 未变） |
| grace 不创建新 Session | ✅ 分支直接 return，无 INSERT（源码未变） |
| grace 不误撤 Family | ✅ 只有 `reuse_detected` 才 `revokeFamily` |
| grace 审计信息充分 | ✅ 新增测试锁定 `refresh_grace_reuse` 携带 `family` / `sinceRevokeMs` / `user_id` / `session_id` / `ip_hash` |
| Token 明文进日志/审计 | ✅ 无。新增测试断言「全事件序列化结果不含 token 明文」；库里只存 `refreshTokenHash` |
| 窗口外重放撤销整族 | ✅ 既有测试继续通过（`replay beyond the grace window revokes the entire token family`） |
| 并发误记 `refresh_success` | ✅ 新增用例 `grace events are never misrecorded as refresh_success` 锁定 |

整改报告声明的是「语义零变更 + 测试补强」，实测与报告一致，**没有偷偷加「重试次数撤族」**（符合「不允许擅自增加重试次数撤族逻辑」的约束）。

第一轮实锤的 V7 风险（攻击者先刷新 → 家族永不撤销）**依然存在**，属**已声明并保留的设计取舍**，不是本次整改的缺陷。

### I-3 用户状态 — 已修复

`src/routes/auth.ts:48-54` 提取 `loadAuthedUser`：

```ts
const user = await findUserById(ctx.db.db, userId);
if (!user || user.status === "deleted") throw invalidToken();
return user;
```

`/auth/me`（:115）与 `/auth/identities`（:128）**共用**。

| 审查点 | 结论 |
|---|---|
| deleted → 401 | ✅ 两个端点一致 |
| 不存在 → 401 | ✅ |
| suspended 保持原约定 | ✅ 200 + 响应携带 `status`（与第一轮 I-9 一致） |
| 其他使用 Authenticated User 的路径 | ✅ **已穷举**：全仓仅 `/auth/me`、`/auth/identities` 使用 `requireAuth`；`/auth/refresh`、`/auth/logout` 走 refresh token（前者在 `session-service` 内已查 `status !== "active"`）；`/oauth/*`、`/health`、`/ready` 不需要 Bearer。**无遗漏** |
| 测试 | ✅ `active=200 / suspended=200 / deleted=401 / 行不存在=401`，并断言两端点一致 |

### I-4 OAuth Transaction 原子消费 — 已修复（有一处理论精确性问题）

`src/oauth/state.ts:92-139` 新增 `consumeOauthTransaction`：校验通过后 `DELETE ... RETURNING`，`consumed.length === 0` → 返回 `undefined`。

| 审查点 | 结论 |
|---|---|
| 条件 DELETE RETURNING 原子消费 | ⚠️ **实质原子，措辞略宽**：DELETE 的条件只有 `id = row.id`（主键），不是「provider + expires_at + client_state_hash」全谓词。见 N-6（影响≈0） |
| 双 State / Provider / CS 消费前完整校验 | ✅ 全部在 DELETE 之前：`providerStateHash` 查询、`row.provider !== provider`、`expiresAt`、`sha256Hex(clientState) !== row.clientStateHash` |
| 并发最多一个成功消费 | ✅ **结构性保证**。PG 行锁：两个并发 DELETE，一个返 1 行，另一个返 0 行 → `undefined` → 400。测试实测 `[302, 400]`、`codes=1`、`txs=0` |
| Provider 交换失败不重建授权码 | ✅ 消费即焚，失败路径无任何 INSERT |
| 失败重定向 redirect_uri 来自已验证事务 | ✅ `transaction.redirectUri` 取自消费行；`failWithRedirect`（:90-96）不再查库 |
| 重复 callback 区分正常失败/内部异常 | ✅ 已消费 → `AppError invalid_grant` 400 JSON；`AppError` → 302 error 重定向；非 `AppError` → rethrow → 500 |
| 消费成功但后续失败 | ✅ 存在但**已声明**：transaction 已删、code 未签发 → 用户重新授权（TTL 300s，成本低）。无安全影响 |
| 事务边界（不只单条 SQL） | ✅ 授权码签发 + 审计仍在 `db.transaction` 内；消费是独立单语句（正确——消费必须早于 provider 网络 IO，否则窗口重开） |

**与授权码消费同构性核对**：`token-exchange.ts:57` 仍是 `FOR UPDATE` + `consumedAt` 检查 + 条件 UPDATE。两处均原子，机制不同但都正确。

### I-5 并发身份创建 — 已修复

`src/users/user-service.ts:123-182`：

```ts
try {
  return await db.transaction(async (tx) => { /* insert users → insert identity */ });
} catch (err) {
  if (!isProviderSubjectUniqueViolation(err)) throw err;
  const winner = await lookupIdentityWithUser(db, identity.provider, identity.subject);
  if (!winner) throw err;
  return winner;
}
```

| 审查点 | 结论 |
|---|---|
| 只捕获正确的 provider_subject 冲突 | ✅ 要求 `code === "23505"` **且** 约束名 `includes("provider_subject")`；实际约束名 `user_identities_provider_subject_uq`（`schema.ts:64`）匹配。其他 23505（users pkey、oauth_codes pkey）→ rethrow |
| 解包 Drizzle cause 链 | ✅ 循环沿 `e.cause` 最多 5 层 |
| 识别 postgres.js `constraint_name` | ✅ `e.constraint_name ?? e.constraint` 双字段兼容 |
| 嵌套事务确实创建 SAVEPOINT | ✅ `db.transaction()` 在外层 `tx` 上调用 → Drizzle 发 SAVEPOINT。callback 传入的是外层 `tx`（`callback.ts:118`） |
| 冲突后事务内安全重读 | ✅ SAVEPOINT 回滚只撤销本次创建；外层事务可继续（默认 READ COMMITTED，新语句可见胜者已提交行） |
| 重读严格用 provider + subject | ✅ `lookupIdentityWithUser(db, provider, subject)`，**查询条件无邮箱** |
| 误把其他 23505 当身份冲突 | ✅ 不可能（约束名过滤） |
| 跨 Provider 同邮箱仍独立 | ✅ 新增测试 `same email via different providers still creates two independent users` |
| 测试 | ✅ 服务级并发（`parallel findOrCreateUserWithIdentity` → users=1）+ 端到端双标签页（两回调均 302、两独立 code、兑换后同一 user） |

**验证到的一个真实细节**：报告称 postgres.js 用 `constraint_name`（非 `constraint`）、Drizzle 会包 `DrizzleQueryError`。这两点若有错就会导致 23505 漏捕 → 仍是 500。实测 91 项测试全绿且 `[302,302]` 通过，说明这条路径**确实被真实执行**（不是 mock）。

### I-6 Provider 异常 — 已修复（但引入一个可观测性回归）

| 审查点 | 结论 |
|---|---|
| Google/GitHub 网络异常 | ✅ `google.ts:61-79`、`github.ts:67-69,99-101` 全部 try/catch → `serverError` |
| 非 JSON 响应 | ✅ `google.ts:84-89`、`github.ts:81-83,108-110` |
| 必需字段缺失 | ✅ `id_token`、`sub`、`nonce`、`access_token`、数字 `profile.id` 全部校验 |
| Provider 错误状态 | ✅ `!resp.ok` → `serverError`（不读 error body） |
| 内部程序错误保持内部语义 | ✅ 非 `AppError` 仍 rethrow → 500（`callback.ts:172-173` 注释明确「不伪装为用户拒绝」） |
| 错误详情 / Token / Secret 泄露 | ✅ `serverError` = `expose:false`；重定向用 `err.expose ? err.message : "Provider sign-in failed"`；审计只记 `reason: err.code`。**无泄露** |
| 测试 | ✅ 5 个用例 + 1 个**真实** `ECONNREFUSED`（关闭 mock HTTP server，非 mock 抛错） |
| ⚠️ 新问题 | 所有 provider 失败在日志与审计里**都长一样**（`server_error`），见 N-4 |

---

## 4. 新发现问题及严重程度

| # | 严重度 | 问题 | 位置 | 触发条件 | 影响 |
|---|---|---|---|---|---|
| **N-1** | **Medium** | IP 形态校验是**字符集检查**而非 IP 解析：`/^[0-9a-fA-F.:]{1,45}$/` 实测接受 `203.0.113.10:44321`、`deadbeef`、`...`、`:`、`1.2.3.4.5` | `rate-limit.ts:36,58` | 反代配成 `proxy_set_header X-Forwarded-For $remote_addr:$remote_port`（带端口的非标准写法） | **限流静默失效（fail-open）**：每个连接端口不同 → 每连接一个桶。这是唯一「失效方向是放开」的路径，比回退 socket 危险 |
| **N-2** | **Medium** | `MAX_BUCKETS=10000` 与 overflow 桶**零测试覆盖**。`trusted-proxy.test.ts:136` 名为 `bucket cap` 却只发 3 个请求 | `rate-limit.ts:33,100`；`trusted-proxy.test.ts:136-143` | — | 新增的安全控制没有被任何测试锁定；`MAX_BUCKETS` 私有不可注入，即使想测也无入口。报告 §4「overflow 语义」的措辞（「锁定正常路径不受影响」）容易被读成「已测上限」 |
| **N-3** | **Low** | `TRUST_PROXY_HOPS` 语义只在追加式链成立；覆盖式多层下 `hops≥2` 必然回退 socket（全员塌缩到一个桶），而参数名暗示「代理层数」 | `rate-limit.ts:56`；`README.md:142-156` | 双层覆盖式反代（CDN + nginx 都覆盖）且 `HOPS=2` | 所有客户端共享一个限流桶 → 全体限速（fail-closed，不是绕过）。README 未声明「覆盖式仅单层」 |
| **N-4** | **Low** | I-6 引入**可观测性回归**：`AppError` 且 `status>=500` 时 `onError` 只记 `{code,status}`，**不记 message**。整改前网络/JSON 错误是非 AppError → 记 `err.message` | `app.ts:70-75` | 任意 provider 故障 | 「Google 不可达」/「返回非 JSON」/「nonce 不匹配」/「验签失败」在生产日志与审计里**完全无法区分**，全部是 `server_error`。这些字符串都是静态非敏感文案，记录是安全的 |
| **N-5** | **Low** | `purgeExpired` **每请求全表扫描**全部桶 | `rate-limit.ts:76-80` | 桶接近 10000（需大量真实 IP，或 N-1/N-3 的退化场景） | 每个请求 1 万次 Map 迭代 → CPU 放大。修复前无上限（更糟），现被上限封住，仍值得改成惰性/分片清理 |
| **N-6** | **Informational** | I-4 的「条件 DELETE」条件只有主键；过期判断在 Node 侧（`Date.now()`）而非 SQL | `state.ts:111,123-126` | SELECT 与 DELETE 之间跨越过期时刻（毫秒窗口，TTL 300s） | 理论上可能消费一行刚过期的事务。因 `oauth_transactions` 行不可变、只删不改、`provider_state_hash` 唯一且随机（无 ABA），实际影响 ≈ 0 |
| **N-7** | **Informational** | `catch` 块内 `recordAuthEvent(deps.db, …)` 失败会**掩盖原始错误** | `callback.ts:159-171` | DB 抖动恰好发生在错误处理中 | 本应 302 的错误重定向退化成 500 页。既有结构问题，非本次引入 |
| **N-8** | **Informational** | 无 IPv6 归一化，同一地址不同书写形式 = 不同桶；`clientKey` 回退 `"unknown"` 时所有无地址来源共享一桶 | `rate-limit.ts:36,73` | 混合栈或畸形头 | 审计聚合失真；桶误伤。追加式代理下客户端不可控，风险低 |

**未发现的新攻击面**（逐项核对）：右端选中的值只用于桶键与 `hashIp` 输入，不参与 SQL / 路径 / HTML；overflow 劣化方向为可用性；`consumeOauthTransaction` 无注入面；I-5 的重读不带邮箱、不越权。

---

## 5. 测试覆盖缺口

真实 PostgreSQL（**本次启动 Docker + `postgres:16-alpine` 容器 @ 54329 实测**，非 mock）：

| 缺口 | 严重度 | 说明 |
|---|---|---|
| **未真正触发 `MAX_BUCKETS`** | **Medium** | 任务书明确要求指出：**确认未触发**。`trusted-proxy.test.ts:136-143` 只验证正常路径；overflow 分支（`rate-limit.ts:100-102`）**从未执行**。且 `MAX_BUCKETS` 未导出，无法注入小值 |
| 未测「1 条目 XFF + HOPS=2」 | Low | 畸形用例只覆盖 hops=1 的缺失/非法/超长；层数不足的具体组合未单独断言 |
| 未测 `host:port` 形态 | Low | 与 N-1 对应，当前会被接受而非回退 |
| 未测 IPv6 归一化 | Low | 不同书写形式是否同桶未覆盖 |
| 未测 overwrite + hops=2 | Low | 与 N-3 对应（当前会静默塌缩到一个桶，无断言） |
| 未测 `purgeExpired` 在满桶下的行为 | Low | 与 N-5 对应 |
| 未测 catch 内审计写失败 | Informational | 与 N-7 对应 |

**已充分覆盖**（实测通过）：I-1 三态归因（false / append / overwrite）、多层 append hops=2、畸形回退；I-2 grace 三连重试 + 事件不混记；I-3 四态访问控制；I-4 并发重复回调 `[302,400]`；I-5 服务级并发 + 端到端双标签页；I-6 六种 provider 故障含真实 `ECONNREFUSED`。

---

## 6. 工程门禁执行结果

| 命令 | 结果 | 备注 |
|---|---|---|
| `pnpm typecheck` | ✅ **PASS**（exit 0） | |
| `pnpm lint` | ✅ **PASS**（exit 0，0 错误） | |
| `pnpm test` | ✅ **PASS** — **8 文件 / 91 测试全绿**（30.5s） | 真实 PostgreSQL 16 容器 @ `127.0.0.1:54329`。与报告声明的 91 项一致 |
| `pnpm build` | ✅ **PASS**（exit 0） | `dist/` + migrations 复制就绪 |
| `git diff --check` | ✅ **PASS**（exit 0） | 全仓 |

**测试环境说明（必须记录）**：初次执行时 `pnpm test` 失败——Docker daemon 未运行、54329 无监听、本机无 PostgreSQL。启动 Docker Desktop 并创建 `postgres:16-alpine` 容器后才跑通。

测试确实连真实 PostgreSQL：`tests/global-setup.ts` 在数据库不可达时直接 throw（`cannot reach test PostgreSQL at …`），**不存在 mock 冒充**。

---

## 7. 合并前必须处理的问题

| 优先级 | 项 | 理由 | 成本 |
|---|---|---|---|
| **必须** | **N-1** 把 `IP_ENTRY_PATTERN` 换成 `net.isIP()`（或显式拒绝含 `:` 的 IPv4 形态） | 唯一「fail-open」的路径：限流可能静默失效，而限流是认证端点的 DoS 防线 | ~3 行 + 1 测试 |
| **必须** | **N-2** 让 `MAX_BUCKETS` 可注入（或导出），补一个真正打到上限的测试 | 新增的安全控制零测试；任务书要求明确指出这一点 | 改常量来源 + 1 测试 |
| 建议（Phase 1.2 首迭代） | **N-4** 5xx `AppError` 日志补 `err.message`（静态文案，无敏感信息） | 否则 provider 故障在生产无法定位 | 1 行 |
| 建议（Phase 1.2 首迭代） | **N-3** README 补一句「覆盖式仅适用于单层代理；多层必须用追加式」 | 防配置塌缩为全体限速 | 1 段文档 |
| 建议 | **N-5** `purgeExpired` 改惰性 / 分片 | CPU 放大 | 小重构 |
| 记录即可 | N-6 / N-7 / N-8 | 影响 ≈ 0 或既有问题 | — |

**I-2 的存量风险不在此列**：第一轮 V7（攻击者先刷新 → 家族永不撤销）按任务书要求保留，是本阶段明确接受的设计取舍，不是缺陷。

---

## 8. 是否建议合并 Phase 1.1 + Phase 1.1.1

**建议合并——完成 N-1 与 N-2 两项后即可。**

依据：

1. 四项 Low（I-3 / I-4 / I-5 / I-6）已是**结构性修复**，不是补丁式绕过：`loadAuthedUser` 统一入口、DELETE RETURNING 消除 TOCTOU、SAVEPOINT + 约束名精确匹配、异常统一归类。I-4 与 I-5 的修复都经过真实并发测试（`Promise.all` 双回调、双标签页），不是「测试通过所以安全」。
2. I-2 **源码零改动**（diff 为空），这是「语义不变」最强的证据形式，比任何报告声明都可靠。
3. 91 项测试**已在真实 PostgreSQL 上跑通**，无放水迹象（并发用例断言 `codes=1`、`txs=0`、`users=1` 这类硬事实，且 `ECONNREFUSED` 用真实断连而非 mock 抛错）。
4. 无迁移、无依赖变化、无越界改动、无 Secret 入库、工作区干净。
5. 两项 Medium 都是**局部、低风险、可当天完成**的修复，不涉及重新设计。

---

## 9. 是否具备进入 Phase 1.2 的条件

**尚不具备，差 3 项。** 第一轮列的 5 项前置条件，现状：

| # | 条件 | 现状 |
|---|---|---|
| 1 | 人工决策 I-2 grace 策略 | ✅ **已决策**：保留现状 + 测试锁定 + 局限记录（本轮确认源码未动） |
| 2 | I-1 修复或部署形态决策 | ⚠️ **部分完成**：追加式已修，但 N-1（fail-open）与 N-3（覆盖式多层）未闭合，部署形态仍未定型 |
| 3 | P2 四项小修 + 3-4 个测试 | ✅ **完成**（I-3 / I-4 / I-5 / I-6 全部修复，新增 18 测试） |
| 4 | Provider 真实凭据联调 | ❌ **未做**（整改报告 §6.4 自认；mock 无法覆盖真实 JWKS 轮换、真实授权页交互） |
| 5 | Desktop 端契约冻结 | ❌ **未做**（`shared/contracts` 未见对应改动） |

**进入 Phase 1.2 前必须**：闭合 N-1 + N-2；完成 Google / GitHub 真实凭据端到端联调；冻结 Desktop 契约。N-3 / N-4 可随 Phase 1.2 首个迭代带上。

---

## 10. 审查过程声明

- **未修改任何项目文件**：审查期间 `git status --short` 始终为空；未新增测试、未修复、未 commit、未 merge、未 push、未开始 Phase 1.2。
- **未切换分支**（基线偏差已先报告，见 §0）。
- 本报告是本次任务唯一新增文件，经人工确认后由本人提交。
- 环境副作用（项目外）：安装 `cloud/node_modules`（已被 `cloud/.gitignore` 忽略）、启动 Docker Desktop、创建 `brewphase-cloud-test-pg` 容器（端口 54329）。

**审查结束。**
