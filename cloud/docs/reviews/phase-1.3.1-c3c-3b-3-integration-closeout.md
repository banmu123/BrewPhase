# BrewPhase Phase 1.3.1-C3c-3B-3 — Remote MCP OAuth 生产链路接入

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> **基线 HEAD：`2328a8998b3acfb9a1433e987a5960ec22ac7442`**（C3c-3B-2-R1 终态，
> 开始前 `git fetch` + `git ls-remote` 核实本地 = 远程 = 基线，工作区干净）。
> 交付提交 SHA 以 `git log -1 --format=%H` 为准（见最终交付报告）。
> 协议依据：设计契约 v3 + §8.5 三个边界 + C3c-3B-3 修订（§3.1 / §5.5 / §8.3 /
> §8.4 / §16 / §13.12）。
> **未新增迁移、未新增依赖、未改 Desktop、未声明
> `client_id_metadata_document_supported`、未改写任何历史审查结论。**

---

## 1. 实际修改文件

**生产代码（8）**

| 文件 | 变更 |
|---|---|
| `cloud/src/routes/mcp-oauth.ts` | ① authorize：语法预检 → **Registry** → 参数校验 → 建行（顺序不可调换）；② `registryFailurePage()`：Registry 失败 → HTML 400/503/500（不重定向、只显示 `clientIdentifierDisplay` 形式）；③ Registry 依赖装配：`cooldown` / singleflight 进程级共享（**每次请求只重建薄壳、按请求读 `ctx.cimdFetcher`**）；④ consent GET / POST 失败出口处理 `metadata_invalid`（**只渲染 400，不重复删行 / 重复审计**）；⑤ `tokenResponse` 按 gating 省略 `refresh_token` 字段；⑥ `CONSENT_FAILURE_MESSAGES` 增 `metadata_invalid` |
| `cloud/src/mcp-oauth/consent-flow.ts` | 四条件 `evaluateMetadataConditions()`（1 行存在 / 2 非 epoch / 3 redirect 逐字符 / 4 含 `authorization_code`）；`readConsentRow` LEFT JOIN 扩展注册行投影；**GET**：纯读复核，失败 → `commitMetadataRejection()`（删行 + `mcp_consent_metadata_invalid` **同一事务提交**）；**POST allow**：`FOR UPDATE(auth_requests) → FOR SHARE(oauth_clients) → 四条件 → 才进入 grant upsert / code / 删行`，拒绝分支**正常提交**（不 throw、不回滚副作用）；**deny / 空 scope** 路径同样受四条件约束（invalid 一律 400 不 302）；`ConsentRequest.clientIdentifierHost` |
| `cloud/src/mcp-oauth/consent-page.ts` | 新增 `clientIdentifierDisplay()`（http(s) → `URL.hostname`，IPv6 保留方括号；http 形态解析失败 → `""`；不透明 id → ≤40 字符 + `…`）；`ConsentPageInput.clientIdentifierHost`；身份行与回调行**分别带标签**渲染、`escapeHtml`、无链接、无 logo |
| `cloud/src/mcp-oauth/token-flow.ts` | code 兑换事务内：单行 PK 读注册行 → 不存在 / 不含 `authorization_code` → **`invalid_client`**（消费授权码之前）；按 `grant_types` 传 `issueRefreshToken`；refresh 兑换**轮换之前**复核：行缺失 → `invalid_client`、未声明 → **`unauthorized_client`**（旧代零消费）；`IssuedTokens.refreshToken?` |
| `cloud/src/mcp-oauth/sessions.ts` | `CreateMcpSessionInput.issueRefreshToken?`（缺省 `true` 仅服务内部/测试；生产唯一调用点显式传入）；未声明时不插 `mcp_refresh_tokens` 行、`refreshToken` 为 `undefined`——**响应与库同一分支** |
| `cloud/src/mcp-oauth/authorize-flow.ts` | 移除 `client_id > 512` 预检（§3.1：长度与查库优先归 Registry；512 仍是创建预注册 id 的约束） |
| `cloud/src/security/errors.ts` | 新增 `unauthorized_client` 错误码 + `unauthorizedClient()`（400） |
| `cloud/src/db/audit.ts` | `AuthEventType` 增 `mcp_consent_metadata_invalid`（§15：`rid` / `clientId` / `stage` / `condition`） |
| `cloud/src/context.ts` | `AppContext.cimdFetcher?`（测试注入点；生产不设置） |

**测试（7 改 + 3 新）**

| 文件 | 变更 |
|---|---|
| `tests/mcp-oauth/consent-metadata.test.ts` | **新增 19 条**（四条件 / S1–S7 / 真实锁 / STALE 放行 / 同意页展示） |
| `tests/mcp-oauth/authorize-registry.test.ts` | **新增 12 条**（查找顺序 / 失败处置 / 错误页 / 路由级 CAS 并发） |
| `tests/mcp-oauth/token-registration.test.ts` | **新增 14 条**（结构校验 / 不回溯 / gating / 轮换回归） |
| `tests/mcp-oauth/authorize-route.test.ts` | 1 条按 §5.5 改为 HTML 断言（未注册 client：**预期行为变更**，其余断言保留并加强：不重定向、不回显存在性文案、不建行） |
| `tests/helpers/mcp-oauth-app.ts` | harness 增 `cimdFetcher` 注入 |
| `tests/helpers/mcp-consent.ts` | `seedConsentRow` 自带注册行（`ON CONFLICT DO NOTHING`，四条件条件 1 的前置） |
| `tests/mcp-oauth/{absolute-expiry,grant-race,refresh-token-service,session-lifecycle}.test.ts` | `refreshToken` 变可选后的 `!` 断言（默认路径必发；语义不变） |

**文档（4）**：设计契约（§12 状态、§13.12、§17 C3c-3B-3 修订）、本报告、
`REMOTE_MCP_PHASES_ROADMAP.md` §3.30、`REMOTE_MCP_INDEX.md` §41。

**未改**：迁移文件（仍为 0000–0005）、`package.json` / lockfile、Desktop 任何
生产代码、`discovery.ts`、DCR、OAuth Provider 登录流程、authorize/consent/token
之外的路由语义、冻结的 CAS 与撤销语义。

---

## 2. 测试覆盖矩阵

### 2.1 Consent（`consent-metadata.test.ts` 19 条 + 既有 34 文件回归）

| 覆盖项 | 用例（§13.12 #） |
|---|---|
| 条件 1 失败（行不存在） | GET：#92（删行 + 审计 `condition=1 stage=consent` + 不渲染）；POST：#93（零 Code/Grant/Session） |
| 条件 2 失败（INVALID） | S1 GET：#94；S2 POST（**已撤 Grant 不恢复、epoch 不动**）：#95；S3（terminal 非 mismatch，Grant 集合不变）：#96；deny 不 302：#101 |
| 条件 2 恢复 | S4（INVALID → FRESH 后旧 pending **通过**，版本递增过也通过）：#97 |
| 条件 3 失败 | S5 POST：#99；S5 GET：#99（`stage=consent`） |
| 条件 4 失败 | S6 POST / GET：#100 |
| 版本语义 | 仅 `client_name` 变化（version+1）→ GET + POST 都允许：#98（**按字段不按版本**） |
| STALE 放行 | `no-cache` 永久 STALE 全流程 authorize → GET → POST：#105 |
| GET invalid 持久化 | 删行与审计均落 `auth_events`（真实写入器断言 `detail` 四字段 + `user_id`）：#92/#94/#99/#100 |
| POST invalid 提交语义 | 拒绝分支正常提交（删行 + 审计持久）、零副作用、无 302：#93/#95/#96 |
| 两用户并发 POST（S7） | google + github 两个身份同 client：双 302、双 code、双 grant、无死锁：#102 |
| `FOR SHARE` 真实阻塞 | U 锁持事务 → `pg_stat_activity` 观测 `wait_event_type='Lock'` + `pg_blocking_pids` → 提交后读到 epoch → 400：#104 |
| `FOR SHARE` 兼容性 | S 锁持有时 POST **不被阻塞**（判别 `FOR SHARE` ≠ `FOR UPDATE`）：#103 |
| 同意页展示 | 双标签、无 `<a href>`、无 logo、hostname / `[::1]` / 40 截断：#106 |

### 2.2 Authorize（`authorize-registry.test.ts` 12 条 + 既有 24 条回归）

| 覆盖项 | 用例（#） |
|---|---|
| 预注册不透明 ID 通过（零网络） | #107 |
| URL 形态预注册 = issuer → 冲突（DNS 前零网络、不建行） | #108 |
| 未注册 CIMD 首次注册（`request=1`、v=1、`source=cimd`） | #109 |
| FRESH 命中零网络 | #110 |
| STALE floor 内 → **503 HTML**；INVALID floor 内 → **400 HTML**（零网络、零 auth request） | #111 |
| terminal（malformed）/ transient（HTTP 503）→ 零注册行、零 auth request | #112 |
| 错误页不重定向、只显 hostname、完整 URL / 路径 / 查询串不出现 | #113 |
| 参数错误仍 JSON 且不触发抓取 | #114 |
| **路由级 CAS**：并发同 client → `request=1`（singleflight 合并）、一条 302 + 一条 **503 fail-closed**、恰一条 auth request、`version=2`、Map 清理 | #115 |
| 先查库后判 URL 形态（回归） | #107（不透明 id 不被 URL 校验误拒） |
| Registry 既有 64 条（CAS 边界 / 撤销 / 冷却 / singleflight / 时间语义） | 全部原样通过 |

### 2.3 Token（`token-registration.test.ts` 14 条 + 既有 token 组回归）

| 覆盖项 | 用例（#） |
|---|---|
| 注册客户端正常兑换（回归） | #116 前置 |
| 注册行缺失 → `invalid_client`，**code 未消费** | #116 |
| 不含 `authorization_code` → `invalid_client`，**code 未消费** | #116 |
| 签发后 `redirect_uris` 移除 → **仍 200**（签发时刻策略） | #117 |
| 非 mismatch INVALID → **仍 200**、Grant 未撤 | #117 |
| mismatch 撤销 Grant → `invalid_grant`、code 未消费、Grant 不复活 | #118 |
| 未声明 `refresh_token` → 响应无字段 + **库中零行** + Session 照常 | #119 |
| 未声明后 refresh 兑换 → `unauthorized_client`、旧代零消费 | #120 |
| 注册行删除后 refresh → `invalid_client`、旧代零消费 | #120 |
| 声明后轮换照常（旧代消费 / 新代签发） | #121 |
| PKCE / redirect / 同码重放仍 `invalid_grant` | #122 |

**既有测试处置**：无删除、无跳过、无弱化。唯一改动是 authorize「未注册
client」用例的响应形态断言（JSON → HTML）——这是 §5.5 要求的**预期行为
变更**，其原有不变量（400、不建行、不回显存在性判断）全部保留并新增
「不重定向 / content-type HTML」断言。

---

## 3. 门禁实际结果

```text
$ cd cloud && npx tsc --noEmit
（无输出，0 error）

$ cd cloud && npx eslint src tests
（无输出，0 error / 0 warning）

$ cd cloud && npx vitest run tests/mcp-oauth
 Test Files  34 passed (34)
      Tests  877 passed (877)

$ cd cloud && npx vitest run
 Test Files  70 passed (70)
      Tests  1511 passed (1511)      ← 基线 1465 → +46（新增 45 + 1 条改断言不计数）

$ 三个新文件 + Registry 连跑 ×3
      Tests  109 passed (109)        ← 稳定（含 FOR SHARE / 并发 / 路由级 CAS）
```

一致性扫描（§8.4）：

| 门禁 | 结果 |
|---|---|
| `.update(mcpOauthClients)` | **2 处，均带 `metadata_version + 1`** |
| raw SQL `update mcp_oauth_clients` | **0 处** |
| `metadata_fetched_at` 作 CAS 比较 | **0 处** |
| CIMD 抓取入口 | 仅 `cimd-registry.ts` 调 `fetchClientMetadataDocument`；无普通 `fetch` |
| Registry 测试 | **64 条完整保留** |
| 迁移文件 | **无新增**（仍 0000–0005） |
| 依赖 | `package.json` / lockfile **未改** |
| Desktop 生产代码 | **未改** |
| Discovery 能力声明 | `client_id_metadata_document_supported` **仍未声明**（仅注释提及） |
| OAuth Provider 登录流程 | 未改（`/oauth/*` 与 mock 适配器契约不动） |

**失败项：无。** 未以删除 / 跳过 / 弱化测试取得结果；并发用例全部使用真实
事务、真实行锁与 `pg_stat_activity` / `pg_blocking_pids`，不以 sleep 证明并发。

---

## 4. 未解决的风险与边界

| # | 风险 / 边界 | 归属 |
|---|---|---|
| 1 | **能力仍未声明**：CIMD 全链路已实现并测试，但 Discovery 不输出 `client_id_metadata_document_supported`（§12.2：真实客户端联调后单独提交启用） | Phase 1.3.3 |
| 2 | deny 路径的四条件是**无锁读 + 原子删行/审计**：检查与删行之间注册行翻转的窗口里，最坏结果是「晚一次拒绝」（不签发任何凭据）；allow 路径由 `FOR SHARE` 关死 | 已记录，可接受 |
| 3 | code 兑换的注册行复核是**单行 PK 读、不加锁**（§8.4 明确）：60 秒窗口内注册行变化不追溯——这是设计决定，不是缺口 | 设计冻结 |
| 4 | `InMemoryNegativeCooldown` / singleflight / 限流均为进程内结构，多实例不共享（正确性由 DB CAS 保证） | Phase 1.4 换共享存储 |
| 5 | 已签发 Access Token（≤15 分钟）不被 mismatch 撤销（依赖 `/mcp` 按 `sid` 回查，属 1.3.2） | 既有风险 §14-1 |
| 6 | `clientIdentifierHost` 对不透明 id 只做 40 字符截断展示——展示层信息，不参与任何判据 | §16 已定 |
| 7 | 迁移 0004 / 0005 仍需维护窗口发布（前一轮遗留） | 发布流程 |

---

## 5. 下一阶段建议

1. **Phase 1.3.3 真实客户端联调**（ChatGPT / Grok）：authorize → CIMD 拉取 →
   同意 → code 兑换 → refresh → revoke 全链路；验证 transient / terminal 故障
   行为与客户端读取 Discovery 的方式。联调通过后**单独提交**启用
   `client_id_metadata_document_supported`（§12.2）。
2. **Phase 1.4**：`cooldown` / singleflight / 限流换共享存储（接口不变）。
3. **1.3.2**：`/mcp` 按 `sid` 回查 Session，闭合「已签发 Access Token 不随
   mismatch 失效」的窗口。
4. 运维侧：孤儿 Grant / Session（注册行删除后遗留，`client_id` 刻意无外键）
   的显式清理策略。

**完成后停止，等待独立审核；不合并 main、不改写历史、不提前启用 Discovery 能力。**
