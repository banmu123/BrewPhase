# BrewPhase Phase 1.1.1 — 安全审查整改报告

> 日期：2026-11-16 · 分支：`feature/cloud-account-phase-1.1`（HEAD `eee2a32`，与远程一致）
> 输入：`docs/reviews/phase-1.1-security-review.md`（审查结论 A. PASS，I-1 ~ I-6 + Informational 项）
> 范围纪律：只处理 I-1 至 I-6，不扩大产品功能；**本阶段按要求未执行任何 Git Commit**，全部改动在工作区等待人工审查。
> 结果总览：**6 项问题全部处理完毕；测试 73 → 91（新增 18 项，全部通过）；typecheck / lint / build 全绿；无数据库迁移。**

---

## 1. 修改文件清单

### 源码（10 个）

| 文件 | 问题 | 变更 |
|---|---|---|
| `cloud/src/security/rate-limit.ts` | I-1 | 重写 `clientIp`：XFF 右端第 N 跳解析（`TRUST_PROXY_HOPS`）、单条目 IP 形态校验、头长度上限、失败回退 socket 地址；新增桶硬上限 `MAX_BUCKETS=10000` + 共享 overflow 桶 |
| `cloud/src/env.ts` | I-1 | 新增 `TRUST_PROXY_HOPS`（zod，1–5，默认 1）并进入 `Env` 类型 |
| `cloud/src/routes/body.ts` | I-1 | `sessionMetaFromRequest` 透传 hops（ip_hash 与限流同源归因） |
| `cloud/src/routes/oauth.ts` | I-1 | 两处限流传入 `trustedHops` |
| `cloud/src/routes/auth.ts` | I-1 + I-3 | 限流传入 `trustedHops`；提取 `loadAuthedUser` 统一用户状态检查；`/auth/identities` 接入 |
| `cloud/src/oauth/state.ts` | I-4 | `resolveTransactionByProviderState` / `deleteTransaction` 合并重写为 `consumeOauthTransaction`：校验通过后条件 `DELETE ... RETURNING` 原子消费 |
| `cloud/src/oauth/callback.ts` | I-4 + I-6 | 回调编排改为「消费前置」；失败路径不再清理（事务已消费），用消费行中已校验的 redirect_uri 重定向；非预期异常不再伪装为用户拒绝 |
| `cloud/src/users/user-service.ts` | I-5 | 创建路径包嵌套事务（外层事务时即 SAVEPOINT）；23505 精确识别（解包 Drizzle cause 链 + postgres.js `constraint_name` 字段）；冲突后按 `(provider, subject)` 重读复用 |
| `cloud/src/oauth/google.ts` | I-6 | token 端点 fetch 网络异常、非 JSON body 全部包为 `serverError` AppError |
| `cloud/src/oauth/github.ts` | I-6 | 同上（token 端点 + /user 端点共 4 处） |

### 配置与文档（2 个）

| 文件 | 变更 |
|---|---|
| `cloud/README.md` | I-1：新增「TRUST_PROXY 信任边界」章节——false/true 语义、部署红线（不可直连绕过）、Nginx 覆盖式与追加式配置示例、Caddy 说明 |
| `cloud/.env.example` | I-1：`TRUST_PROXY_HOPS` 文档化 |

### 测试（6 个，新增 18 例）

| 文件 | 变更 |
|---|---|
| `cloud/tests/security/trusted-proxy.test.ts` | **新增**：I-1 六个用例（见 §4） |
| `cloud/tests/sessions/session.test.ts` | I-2：追加 2 个 grace 语义用例 |
| `cloud/tests/users/identity.test.ts` | I-3：追加 1 个访问控制用例；I-5：追加 2 个服务级并发用例 |
| `cloud/tests/oauth/callback.test.ts` | I-4：追加 1 个并发重复回调用例；I-5：追加 1 个双标签页并发登录用例；I-6：追加 5 个 Provider 故障用例 |
| `cloud/tests/helpers/mock-providers.ts` | 故障注入：`badJson`（Google/GitHub token 端点）、`omitIdToken`（Google）、`badUserJson`（GitHub /user） |
| `cloud/tests/helpers/harness.ts` | `AuthorizeStart` 携带配对 verifier 与 client state；`ProviderCallbackArgs` 故障注入透传；`Harness` 暴露 mock 实例（断连测试用） |

## 2. 每项问题的根因与修复

### I-1 可信代理与 IP 限流（Medium）

- **根因**：`clientIp` 取 XFF **左第一跳**。追加式反代（Nginx `$proxy_add_x_forwarded_for`）下左端是客户端可控字段，伪造头即可无限创建新限流桶。
- **修复**：
  1. 右端锚定：`TRUST_PROXY=true` 时从右端跳过 `TRUST_PROXY_HOPS` 个可信代理条目取客户端 IP。追加式代理下右端条目由最近的可信代理写入，**客户端伪造左侧条目无法改变选中值**（含超长填充链：多塞条目只会把选中值进一步推离攻击者可控区）；覆盖式代理下单条目即真实 IP。
  2. 形态校验：选中条目必须匹配宽松 IP 字符集（IPv4/IPv6），否则连同头缺失、层数不足、超长头（>2KB）一起回退 socket 地址。
  3. 桶硬上限：活跃桶达 `MAX_BUCKETS(10000)` 后，未知来源进入按端点共享的 overflow 桶——即使某层信任判断失效也无法无限扩张内存，劣化方向是「全体限速」而非「限流失效」。
  4. 信任边界文档化：README 明确「开启 TRUST_PROXY 的前提是服务端口不可被绕过代理直接访问」，并给出覆盖式（推荐）与追加式两种 Nginx 配置及 Caddy 说明。
  5. `TRUST_PROXY=false` 行为保持不变：完全忽略 XFF。
- **修复前后行为变化**：修复前 `TRUST_PROXY=true` + 追加式代理：伪造头 = 新桶（绕过）；修复后：伪造头对桶选择零影响，超量未知来源进 overflow。

### I-2 Refresh Token 宽限期策略（Medium，策略性保留）

- **根因**：30s grace 窗口内「合法客户端并发重试」与「攻击者重放」**仅凭 bearer token 不可靠区分**——两者呈现完全相同的协议行为（同一旧 token、同一 401）。这是按任务书要求**保留的设计决策**（不引入重试计数撤族、不引入 Redis/设备指纹/DPoP）。
- **本阶段处理**（语义零变更，审计与测试补强）：
  1. grace 语义原样保留：窗口内 401 + 不撤族 + 不建第二会话；窗口外重放撤族（既有测试继续通过）。
  2. 审计充分性确认并测试锁定：`refresh_grace_reuse` 事件携带 `user_id` / `session_id` / `detail.family` / `detail.sinceRevokeMs` / `ip_hash`，足以支撑未来「同 family 重复 grace → 告警/撤族」的监控策略；事件中无任何明文 Token（测试断言全事件序列化结果不含 token 明文）。
  3. 事件类型隔离：grace 拒绝不混入 `refresh_success`（测试断言 success 计数 == 实际成功轮换次数）。
  4. **明确的局限记录**（本报告即文档载体）：旧 Token 在 grace 窗口内的合法重试与攻击者重放无法仅凭 bearer token 可靠区分；「攻击者先刷新」场景下家族控制权归攻击者、受害者重试不触发撤族——这是保留 grace 语义的固有代价，缓解依赖未来的 grace 频次监控。
- **修复前后行为变化**：无行为变化（并发刷新恰好一个成功、grace 不撤族、窗口外撤族均与 Phase 1.1 一致）。

### I-3 `/auth/identities` 用户状态检查（Low）

- **根因**：该端点只做了 JWT 验证，未做用户存在性/status 检查，与 `/auth/me` 不一致；deleted（status）用户与物理删除用户在 token 有效期内仍可读取身份列表。
- **修复**：提取 `loadAuthedUser`（不存在或 `status==='deleted'` → 401），`/auth/me` 与 `/auth/identities` 共用；suspended 保持现有只读可见性约定（与 `/auth/me` 一致，响应携带 status）。
- **修复前后行为变化**：deleted/不存在 + 有效 JWT → identities 由 200 变为 401；active/suspended 不变。

### I-4 OAuth Transaction 原子消费（Low）

- **根因**：事务解析是只读操作，删除发生在授权码签发事务内；并发重复回调在特定交错下可能签发两条授权码（审查报告已分析的 TOCTOU 窗口）。
- **修复**：`consumeOauthTransaction`——双 State/Provider/CS 完整性校验通过后，立即以条件 `DELETE ... RETURNING` 原子消费；只有一个并发请求拿到行，其余得到 undefined → 统一 400 invalid_grant JSON（可预期错误，非 500）。Provider 交换、用户映射、授权码签发全部发生在消费成功之后。
- **取舍声明**：消费即焚——消费后 Provider 交换失败不复活事务，失败路径以消费行中已校验的 redirect_uri 返回 OAuth error（Desktop 重新发起授权，事务 TTL 300s 重试成本极低）。换取的语义是「一事务至多一码」成为结构性保证而非依赖交错。
- **修复前后行为变化**：并发重复回调 `[302/500]` → `[302/400]`；任何交错下 codes=1（原「 favorable interleaving 双码窗口」被结构性消除）。

### I-5 并发首次身份创建 500（Low）

- **根因（两个叠加缺陷）**：① SELECT-then-INSERT 在并发首登时后到方撞唯一索引；② 两个实现细节使冲突无法被处理——postgres.js 的错误字段是 `constraint_name`（不是 `constraint`），且 Drizzle 会把驱动错误包进 `DrizzleQueryError`（原始错误在 `cause` 链上）；此外外层事务内一旦语句失败整个事务 abort，必须用 SAVEPOINT 才能继续。
- **修复**：创建路径包嵌套事务（外层事务内 = SAVEPOINT）；`isProviderSubjectUniqueViolation` 逐层解包 cause 链、兼容 `constraint_name`/`constraint` 字段并校验约束名含 `provider_subject`；23505 后按 `(provider, subject)` **重读复用**先到方用户（重读定位绝不使用邮箱，跨 Provider/邮箱合并语义不变）。唯一约束保持为最终防线。
- **修复前后行为变化**：并发首次登录同一身份 `[302/500]` → `[302/302]`，双方获得各自独立的一次性授权码与会话，落到同一用户。

### I-6 Provider 异常统一处理（Low）

- **根因**：Provider 端点返回 2xx 但 body 非 JSON（或 fetch 网络异常）时抛出非 AppError 原始异常 → 500 JSON，Desktop 收不到 OAuth error 重定向。
- **修复**：google.ts / github.ts 全部外部交互（token 端点 fetch、JSON 解析、/user fetch、/user 解析共 6 处）统一包为 `serverError()` AppError → 回调失败路径按现有协议以 `error=server_error&error_description=...`（非敏感文案）重定向回 Desktop。真正的内部程序错误保持 500 + 生产环境无细节泄露（既有语义未动，不伪装为用户拒绝）。
- **修复前后行为变化**：Provider 故障 → `[500 JSON]` → `[302 error=server_error]`；事务保持已消费状态（I-4 语义），无残留。

## 3. 数据库迁移情况

**无迁移**。六项修复均不涉及 Schema 变更（`consumeOauthTransaction` 利用既有主键、23505 处理利用既有唯一索引）。`src/db/migrations/` 未改动，迁移测试继续通过。

## 4. 新增测试与结果

**18 项新测试全部通过**（真实 PostgreSQL 容器执行；并发用例依赖真实事务/行锁/唯一索引，非 Mock）：

| 套件 | 用例 | 验证内容 |
|---|---|---|
| `tests/security/trusted-proxy.test.ts`（新增 6） | false+伪造 XFF | XFF 完全忽略，第 4 请求 429（`[401,401,401,429]`） |
| | true+追加式 XFF | 伪造左条目（含 3 段填充链）零影响，全部同桶 429 |
| | true+覆盖式 XFF | 单条目=真实 IP，不同真实 IP 独立桶互不误伤 |
| | 多层代理（HOPS=2） | 右端跳 2 取值正确；填充链无法把选中值推出可信窗口 |
| | 畸形/缺失/超长头 | 全部回退 socket 身份（同桶） |
| | overflow 语义 | 正常路径不受桶上限影响 |
| `tests/sessions/session.test.ts`（+2） | grace 语义综合 | 3 次 grace 重试：401×3、会话数=2（无第二会话）、胜者 token 仍可轮换（不撤族）、3 条 `refresh_grace_reuse` 事件均含 family+session、全事件无明文 token |
| | 事件不混记 | `refresh_success` 计数==成功轮换数；grace 不误记；窗口外重放仍撤族 |
| `tests/users/identity.test.ts`（+3） | identities 访问控制 | active=200 / suspended=200（现有约定）/ deleted=401 / 行不存在=401，`/auth/me` 与 `/auth/identities` 一致 |
| | 服务级并发建户 | 并发 `findOrCreateUserWithIdentity` → 同一 user、users=1、identities=1 |
| | 跨 Provider 不合并 | 相同邮箱经 23505 路径后仍为 2 个独立用户 |
| `tests/oauth/callback.test.ts`（+7） | I-4 并发重复回调 | `[302/400]`、codes=1、txs=0、users=1、失败方 `invalid_grant` JSON |
| | I-5 双标签页并发登录 | 两回调均 302、两独立授权码、兑换后同一用户、users=1/identities=1/sessions=2 |
| | I-6 ×5 | Google 非法 JSON / Google 缺 id_token / GitHub 非法 JSON / GitHub /user 非法 JSON / Provider 连接拒绝：全部 `302 error=server_error`、无授权码、事务无残留、用户未创建 |

**执行结果**：

```
pnpm typecheck   ✅
pnpm lint        ✅ 0 错误
pnpm test        ✅ 8 文件 / 91 测试全部通过（13.57s，真实 PostgreSQL）
pnpm build       ✅
```

原有 73 项测试全部继续通过（无断言放松；审查期间独立验证脚本位于仓库外，本次新增测试均已纳入正式套件）。

## 5. 安全影响分析

- **攻击面收紧**：I-1 关闭「伪造 XFF 绕过限流」路径（追加式代理场景实锤复现 → 修复后同桶 429）；I-4 结构性消除「一事务双码」窗口；I-3 关闭 deleted 账户身份列表读取。
- **无新攻击面**：右端跳解析不引入可注入输入（选中值仅作为限流键与 pepper 哈希输入）；overflow 桶劣化方向为可用性而非机密性；`consumeOauthTransaction` 的 DELETE RETURNING 与授权码消费同构，均为原子单语句。
- **语义不变量复核**：邮箱不合并、`(provider, subject)` 唯一锚点、双 State 独立、PKCE 绑定、redirect_uri 白名单、grace 窗口语义、并发刷新单会话——全部保持，且 I-2/I-5 新测试将其进一步锁定。
- **审计完整性**：grace 事件字段充分性经测试锁定；`login_failed` 在 I-4 下新增「重复消费」原因归类（invalid_provider_state），监控可区分。

## 6. 尚存风险

1. **I-2 固有局限（已按任务书保留）**：grace 窗口内合法重试与攻击者重放不可区分；「攻击者先刷新」场景家族控制权归属攻击者且受害者重试不触发撤族。已由测试锁定行为边界，缓解路径（grace 频次监控 → 阈值撤族）留待后续阶段按产品决策实施。
2. **TRUST_PROXY=true 的部署红线**：应用端口被直连时，直连方自带的合法形态 XFF 头仍可占据右端位置（协议上无法与「可信代理写入」区分）。已写入 README 部署红线；桶硬上限（10000）限制了最坏影响。
3. **审查报告 Informational 项未在本阶段处理**（按范围纪律）：I-7 请求体上限、I-8 固定窗口边界突发、I-9 suspended 用户 AT 宽限、I-10 session 物理清理、I-11 callback 限流、I-12 安全响应头、I-13 密钥熵校验、I-14 审计保留策略——维持原等级与建议时点（多为 P3/部署清单项）。
4. **Provider 真实凭据联调**仍未进行（与审查报告一致，属 Phase 1.2 前置条件）。

## 7. 是否建议合并 Phase 1.1

**建议：合并**（Phase 1.1 + 本阶段 1.1.1 整改一并进入人工合并审查）。

- 审查报告的结论 A. PASS 维持成立，且其中两项 Medium（I-1、I-2）已分别得到修复（I-1）或策略性收口 + 测试锁定（I-2）；四项 Low（I-3 ~ I-6）全部修复并有并发级测试覆盖。
- 91 项测试全绿、四项工程门禁通过、无迁移、无 Secret、Desktop/iOS/ChromeExtension/Android 零改动。
- 整改过程发现的两个实现层缺陷（Drizzle cause 链包装、postgres.js `constraint_name` 字段名）已在修复中消化并有服务级并发测试持续锁定。

**本阶段到此停止：未 commit、未合并、未开始 Phase 1.2，等待人工审查。**
