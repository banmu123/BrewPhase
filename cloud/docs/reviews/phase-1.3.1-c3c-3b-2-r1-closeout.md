# BrewPhase Phase 1.3.1-C3c-3B-2-R1 — CIMD Registry 实现收尾与并发抓取一致性修正

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> **基线 HEAD：`a55976c6577365867d8cc901e2d5e439b3c66850`**（C3c-3B-2 终态，本地 = 远程，
> `git ls-remote origin feature/remote-mcp` 核实一致）。
> 本阶段交付提交 SHA 以 `git log -1 --format=%H` 为准（见最终交付报告）。
> 上一轮报告：`phase-1.3.1-c3c-3b-2-registry-review.md`（其结论不改写，差异见该文 §13）。
> 性质：**小范围修正轮**——元数据持久化、ABSENT mismatch 审计、singleflight、
> no-store 频率边界、时间语义。**不重新实现 Registry**。
> **未接入** authorize / Consent / Token 生产路由；**未改** Desktop；**未声明** CIMD 能力。

---

## 1. 实际 HEAD 与基线

| 项 | 值 | 核对方式 |
|---|---|---|
| 分支 | `feature/remote-mcp` | `git branch --show-current` |
| 开始前 HEAD | `a55976c6577365867d8cc901e2d5e439b3c66850` | `git rev-parse HEAD` = 任务书基线 |
| 远程 HEAD（开始前） | `a55976c6577365867d8cc901e2d5e439b3c66850` | `git ls-remote origin feature/remote-mcp`（`git fetch` 因网络瞬断失败，ls-remote 直连核实） |
| 工作区（开始前） | 干净 | `git status --porcelain -uall` 为空 |

重读的代码与文档：`cimd-registry.ts`、`cimd.ts`、`sessions.ts`、`audit.ts`、
`schema.ts`（含 `client_uri` / `logo_uri` 与「`client_id` 不建外键」注释）、
`cimd-registry.test.ts`、设计契约（§4 / §4.1 / §5.2 / §5.3 / §6 / §7 / §8.1 /
§8.2 / §8.5）、3B-2 审查报告。**未覆盖或回退任何已通过的测试。**

---

## 2. 修改文件清单

| 文件 | 变更 |
|---|---|
| `cloud/src/mcp-oauth/cimd-registry.ts` | ① 首次 INSERT 与成功刷新 UPDATE 持久化 `client_uri` / `logo_uri`（省略即 NULL）；② ABSENT mismatch 显式审计分支；③ `InMemorySingleflight` + `processWideSingleflight` + `fetchViaSingleflight`；④ 已有行 `no-store` 接入负面冷却 + reason 统一（`CooldownReason`）；⑤ 完成时刻 `completedAt` 贯通（`metadata_fetched_at` / 冷却 / 返回值 `cacheState`）；⑥ 成功刷新清除冷却 |
| `cloud/src/mcp-oauth/sessions.ts` | `mcp_client_id_mismatch` 审计 detail 增 `absent: false` / `casApplied: true`（与 ABSENT 路径成对） |
| `cloud/tests/mcp-oauth/cimd-registry.test.ts` | 42 → **64** 条（新增 5 组 22 条）；`makeDeps` 可注入 singleflight；三个 barrier 用例改为两个独立实例（原语义，断言加强为 `request=2`）；helper 扩展（`seedCimdClient` 支持两列、`scriptFetcher` / `noStoreResponse` / `noCacheResponse` / `waitForWaiters` / `uriRowOf` / `registrationRowCount`） |
| `cloud/docs/design/phase-1.3.1-c3c-3a-cimd-authorize-integration-contract.md` | 追加 §5.3 / §6.2 / §7 / §8.1 / §8.2 / §8.5 的 R1 落地说明、**§13.11（#75–#91）**、**§17 C3c-3B-2-R1 修订记录** |
| `cloud/docs/reviews/phase-1.3.1-c3c-3b-2-registry-review.md` | 尾部追加 §13 修订记录（原结论不改写） |
| `cloud/docs/reviews/phase-1.3.1-c3c-3b-2-r1-closeout.md` | **新增**（本文件） |
| `Desktop/docs/REMOTE_MCP_PHASES_ROADMAP.md` | §3.29 |
| `Desktop/docs/REMOTE_MCP_INDEX.md` | §40 |

**未改**：`cimd.ts` 校验规则、`discovery.ts`、`routes/*`、authorize / consent /
token 生产逻辑、Consent 页面、迁移文件、`package.json` / lockfile、Desktop 生产代码。

---

## 3. client_uri / logo_uri 实际落库证据

**修正点**（两条写路径，均在 `cimd-registry.ts`）：

1. `registerFreshClient()` 首次 INSERT：`clientUri: outcome.metadata.clientUri ?? null`、
   `logoUri: outcome.metadata.logoUri ?? null`。
2. `applySuccessOnExistingRow()` 版本 CAS UPDATE：同样两字段——**新文档省略即写
   `null`**，不保留上一份文档的值。CAS 谓词不变（`client_id` + 旧 `metadata_version`），
   版本仍 `metadata_version + 1`。

**真实 PostgreSQL 测试证据**（`client_uri / logo_uri 持久化` 组，4 条）：

| 用例 | 落库断言 |
|---|---|
| 首次注册含两列 | `select client_uri, logo_uri …` 读回两值精确相等；`resolve` 只被调用 **1 次**且参数 = `client_id` 主机名（**不解析 logo 主机名**） |
| 刷新改变两列 | 新值入库、`metadata_version = 2` |
| 刷新省略两列 | 两列均为 `NULL`、`version = 2` |
| 其它元数据未变 | 两列清空**恰好**一次 `version+1`（不是 `database_error`、不重复写）；`client_name` / `redirect_uris` 不变；随后 FRESH 命中不再联网、版本停在 2 |

**不渲染、不抓取**：设计 §7 补充与 §16 已钉死——两列只是字符串；同意页不请求
远程图片（本阶段未改 Consent 页面，也不存在读取 `logoUri` 的渲染代码，全库
grep 确认 `logoUri` 只出现在 schema / cimd / registry / 测试）。

---

## 4. ABSENT mismatch 审计方案及测试

**问题**：已有行路径有「CAS 命中 → 同事务撤销 + 唯一 `mcp_client_id_mismatch`」，
但 ABSENT 首次注册走 `registerFreshClient()`，`auditEventForCimdFailure`
(`"client_id_mismatch")` 返回 `null` → **首次注册的 mismatch 没有任何审计**。

**选定方案**（任务书 §三.3 二选一，明确记录）：**复用 `mcp_client_id_mismatch`
并记录零撤销计数**，不用独立事件名：

```json
{ "eventType": "mcp_client_id_mismatch", "userId": null,
  "detail": { "clientId": "<原值>", "reason": "client_id_mismatch",
              "absent": true, "casApplied": false,
              "revokedGrantCount": 0, "revokedSessionCount": 0 } }
```

- **理由**：mismatch 是同一类**身份失效信号**，安全查询必须一次拿到全部命中；
  两种情形由 detail 的**结构化字段**区分（`absent` / `casApplied` / 计数），
  不靠 detail 文本匹配，§15「只走枚举」纪律不被破坏。
- 既有行路径的 detail 相应补 `absent: false` / `casApplied: true`（计数为真值），
  一条查询即可分辨「CAS 获胜后的真撤销」与「无行、零撤销的首次 mismatch」。

**边界遵守**：无注册行 → 无 CAS 可执行 → **不伪造 CAS 成功**、**不撤销任何
Grant / Session**（绝不声称完成既有撤销）、**不写注册行**（不产生 INVALID 行）、
不匹配文档不入库；审计走 `deps.audit`（生产形态 = `recordAuthEvent`，非阻断）。

**孤儿边界调查**（任务书 §三.7）：`mcp_grants` / `mcp_sessions` 刻意**不**给
`client_id` 建外键（`mcpOauthClients` 上方长注释：注册缓存不是归属主体，删行
不该连带删授权）→「注册行被删除、Grant / Session 遗留」是**可能且被接受**的
形态。ABSENT mismatch 对这些孤儿**不撤销**（没有 CAS 就没有撤销权），只以
零计数审计如实记录；清理属运维 / 后续阶段。已写入设计 §5.3。

**测试**（`ABSENT mismatch 审计` 组 3 条 + 既有强化）：

| 用例 | 断言 |
|---|---|
| 不写行 / 400 / 冷却 / 审计调用 | `count(mcp_oauth_clients)=0`；400 `client_id_mismatch`；冷却记 `{reason:"client_id_mismatch"}`；audit spy 收到事件且 detail 含零计数三字段 |
| 审计持久化 | 用**生产写入器**（`recordAuthEvent(handle.db, …)`）→ `auth_events` 查得 1 行、`user_id` NULL、`absent=true`、`casApplied=false`、计数 0 |
| 不误报撤销（孤儿） | 无注册行但有 2 Grant + 1 Session：`revoked=0/0`、epoch 仍 `[1,1]`、审计计数 0、零注册行 |
| 既有行仍是 CAS+撤销+审计同事务 | 既有「审计与撤销原子提交」用例**强化**为同时断言 `absent=false`、`casApplied=true`、计数 2/2 |
| CAS 失败零撤销零审计 | 既有用例原样通过（持锁事务 + `pg_stat_activity`） |

---

## 5. singleflight 并发设计与测试结果

**设计**（`InMemorySingleflight`，严格落在设计 §8.1「只做合并，不做正确性」一侧）：

| 维度 | 实现 |
|---|---|
| 合并粒度 | **只包 `fetchClientMetadataDocument`**，key = `client_id`；两条路径（已有行重抓 / ABSENT 首次）共用 |
| 作用范围取舍 | 不包整个解析流程 → 不涉及请求级安全上下文合并（解析只依赖 `client_id` + 共享 deps）；ABSENT 的 `INSERT … ON CONFLICT DO NOTHING → 读胜者行` **原样保留** |
| 正确性 | **DB 版本 CAS 仍是唯一仲裁**：共享抓取后每个等待者仍各自进入 `WHERE client_id = ? AND metadata_version = ?` → **至多一个提交者**，其余 0 行按 §8.5 fail-closed（成功方 503 / mismatch 方按自身结果 400 零写入）。**绝不**用 Map 代替 CAS |
| 生命周期 | Promise resolve / reject 都立即从 Map 删除（`finally` + 「只删仍指向自己的条目」）；抓取的生命周期由 store 持有，`CimdFetcherDeps` **无**调用方级 `AbortSignal` → 任何单个等待者的失败都不可能中止共享抓取 |
| 不同 key | 独立条目，互不阻塞（key 级 Map） |
| 注入 | `deps.singleflight?`；省略 → `processWideSingleflight`（进程级默认，生产路径）；测试注入独立实例隔离用例，或用**两个实例模拟两个进程**（那时只剩 DB CAS 裁决） |
| 抛错 | `fetchClientMetadataDocument` 契约不抛异常；防御注入实现的意外抛错 → 所有等待者同一 transient 503，Map 已清理 |
| 多实例 | 语义不变：Map 只省网络；跨实例仍由 ON CONFLICT + 版本 CAS 保证 |

**真实 PostgreSQL + 可控 fetcher 测试**（`singleflight` 组 **8 条**，全部通过）：

| 用例 | 关键断言（非 Map-only） |
|---|---|
| 同 `client_id` 并发只抓一次 | 屏障挂起 + `waitForWaiters` 确保双方都读到 v1 → **`request`=1、`resolve`=1**；恰一个提交者（v→2）、另一个 503 `cas_superseded`；**赢家 `metadataVersion` = 库中已提交版本**（等待者不读未提交状态）；完成后 Map 清零 |
| 不同 `client_id` 不阻塞 | A 抓取在飞时，B **当场**完成注册（A 未释放）；Map 只剩 A |
| 抛异常 / reject 清理 | store 层 reject → Map 0；registry 层注入 `monotonic` 抛错 → 503 `transport_error`、Map 0、零注册行、零冷却 |
| mismatch 只撤一次 | 共享抓取 1 次 → **epoch 恰为 `[2,2]`（不是 3）**、审计恰 1 条、2/2 撤销、行 INVALID、version 2 |
| 并发 transient 共享 | `request`=1，两个等待者同为 503；零行、零冷却、Map 清零 |
| transient 不污染下次 | 上次 503 后 Map/冷却均空 → 下次重新抓取并**成功注册**（`request`=2） |
| 省略参数走进程级默认 | 两个不带 `singleflight` 字段的 deps（生产形态）→ `request`=1；`processWideSingleflight.size` 最终 0 |
| 两实例不合并 / 同实例合并 | 两 store 同 key → `fn` 跑 2 次；单 store 同 key → 跑 1 次 |

**非合并写入者的 CAS 仲裁**仍由既有三个 barrier 用例证明（各自独立 store、
`request`=2、恰一个提交者）——这是「版本 CAS 仍能防止多实例或非 singleflight
写入竞争」的直接证据。

**运行结果**：Registry 套件 **64 passed**，3 连跑稳定。

---

## 6. no-store 频率限制策略

**选定：扩展进程内负面冷却**（不是依赖 IP 限流），依据与边界（设计 §6.2 补充 +
§8.5 边界三落地）：

| 项 | 策略 |
|---|---|
| 缺口 | 已有 cimd 行 + 新响应 `no-store` → 拒绝当前请求但**不写行、不更新 `metadata_fetched_at`、不推进版本** → 30s floor 管不到 → 下一次请求可能**立刻重抓** |
| 复用 | 与 ABSENT 同一个 `NegativeCooldownStore`：`Map<clientId, { at, reason }>`，**只存时间戳 + 枚举**（无响应正文、无 Header，不违反 §6） |
| TTL / 容量 / 时钟 | 30s（与 floor 同值）· 10 000 上限先清过期再逐出最旧 · 时钟注入 · 成功刷新后 `clear`（`applySuccessOnExistingRow` 也新增清除） |
| 冷却命中 | **不发网络、不放行**，直接 terminal；**不与 ABSENT 混淆**——只在「行仍在、floor 已过、即将发网络」时查询，命中不改变行状态，FRESH 行在查冷却之前就直接使用 |
| reason 统一 | ABSENT 首次、已有行、以及两者冷却命中 —— **一律** `client_registration_unsupported`（`CooldownReason` 类型放宽一格）。修正前 ABSENT 冷却记 `unsupported_client`、返回 `client_registration_unsupported`，同一失败两种分类 |
| 不做的 | 不存 no-store 内容、不写缓存行、不伪造 FRESH、不改 `no-cache` 的 30s floor |
| 为什么不只靠 IP 限流 | 限流按 IP（30 次 / 60s，进程内），**多 IP 攻击者聚合可超限**（§8.5 边界三残留风险）；按 `client_id` 收敛必须有这层冷却 |
| 多实例 | 单实例部署即全局；Phase 1.4 扩容与限流、singleflight 一起换共享存储 |

**测试**（`no-store 刷新边界` 组 4 条）：行零改动（版本 / 两时间戳逐字节断言）+
冷却无正文哨兵 + 审计 `absent=false`；冷却命中不发网络、同 reason、400；
冷却过期 → 重抓成功 → 版本推进、FRESH、冷却清空；ABSENT 首次与命中同 reason
（并修正既有快照用例的 reason 断言）。

---

## 7. 缓存时间边界测试

**冻结语义**（设计 §8.2 新增说明）：

- **判定「要不要抓」用请求开始时刻**（四态 + floor 都在抓取前决策）；
- **`metadata_fetched_at` 记抓取完成时刻**（成功与 terminal 都是；transient 与
  冷却拒绝不写）——floor 因此是「距上次尝试**完成** ≥ 30s」；
- **`cacheExpiresAt` 由 fetcher 时钟在响应解析后计算**（完成时刻 + ttl）；
- **返回值 `cacheState` 用完成时刻比较**——用开始时间会让 `no-cache`（ttl=0，
  expires = 完成时刻）被误判 `fresh`；
- 「刚完成验证的新鲜度」（本次写库结果）与「库中缓存当前状态」（后续读行）分开。

**注入时钟测试**（`时间语义` 组 3 条）：

| 用例 | 断言 |
|---|---|
| 开始时未过期、完成时已到期（`no-cache` + 抓取期间时钟 +5s） | 返回 `cacheState = "stale"`（**旧实现会误判 fresh**）；`metadata_fetched_at = 完成时刻`、`cacheExpires_at = 完成时刻` |
| floor 以开始时刻判定 | `fetched_at` 距 floor 29.5s → 503 不发网络、时间戳不动；+1s 跨过 floor → 才发网络 |
| fetch 横跨 floor（+25s 抓取，10s 后再请求） | `fetched_at = 完成时刻`：距**开始** 35s（≥30，若记开始时刻会放行）、距**完成** 10s（<30）→ **503，不发网络**（直接证明 floor 从完成时刻起算） |

**§六.1 缓存四态复验**（既有用例原样通过）：FRESH 不联网 · STALE floor 内 503 /
外重抓 · INVALID 内 400 / 外仅成功自愈 · `no-cache` ttl=0 永久 STALE · `no-store`
不存正文（快照哨兵断言）。

---

## 8. 真实 PostgreSQL 执行结果

- 全部 Registry 用例跑在真实 PG（`brewphase-cloud-test-pg`）上；`beforeEach`
  `resetDb`。
- 并发编排仍是**真锁真事务**：屏障 / 阻塞 fetcher、持锁事务（`holdVersionBump`）、
  `pg_stat_activity` / `pg_blocking_pids` 断言——**没有**用 mock 模拟行锁或顺序；
  singleflight 的 join 时序用 `waitForWaiters`（轮询 store 观测）确保「读行在
  join 之前」，不是 sleep 碰运气。
- 撤销 / 审计回滚、CAS 0 行、行锁等待、审计失败整事务回滚：既有用例原样通过。
- **结果：`cimd-registry.test.ts` 64 passed（3 连跑稳定）；无一用例删除、跳过
  或弱化断言。**

---

## 9. 全套 TypeScript / ESLint / Vitest 结果

| # | 门禁 | 实际执行 | 结果 |
|---|---|---|---|
| 1 | 类型检查 | `cd cloud && npx tsc --noEmit` | ✅ 无输出（0 error） |
| 2 | Lint | `cd cloud && npx eslint src tests` | ✅ 无输出（0 error / 0 warning） |
| 3 | Registry 测试 | `npx vitest run tests/mcp-oauth/cimd-registry.test.ts` | ✅ **64 passed**（3 连跑稳定） |
| 4 | CIMD 校验层 | `npx vitest run tests/mcp-oauth/cimd.test.ts` | ✅ **217 passed** |
| 5 | 完整套件 | `npx vitest run` | ✅ **1465 passed / 67 files**（本轮基线 1443 → **+22**，= 新增用例数） |
| 6 | 真实 PG 并发测试 | 含于 #3（CAS 竞争 / 撤销 / 行锁组原样 + singleflight 组） | ✅ 见 §8 |
| 7 | singleflight 测试 | 含于 #3（8 条） | ✅ 见 §5 |
| 8 | ABSENT mismatch 审计 | 含于 #3（3 条 + 强化 2 条） | ✅ 见 §4 |
| 9 | no-store 冷却边界 | 含于 #3（4 条） | ✅ 见 §6 |
| 10 | `client_uri` / `logo_uri` 写入与清空 | 含于 #3（4 条） | ✅ 见 §3 |
| 11 | `.update(mcpOauthClients)` 版本递增守卫 | 守卫测试 + `grep` | ✅ **2 处，均带 `metadata_version + 1`** |
| 12 | raw SQL 更新扫描 | `grep -rniE "update.*mcp_oauth_clients" src/` | ✅ **0 处**；`metadataFetchedAt` 出现在 WHERE / `eq()` 比较 **0 处** |

**失败项：无。** 未通过删除 / 跳过 / 弱化测试取得结果；未用 mock 替代需要验证的
PG 事务、CAS、行锁与审计回滚。

**§六.4 既有保护复验**（全部原样通过）：不透明预注册 ID 先查库后判 URL ·
URL 形态预注册做身份冲突检查 · grant/response 真正过滤 · 审计只基于 reason 枚举 ·
生产读 `metadata_version` 走 Drizzle · 不用 `metadata_fetched_at` 作 CAS ·
抓取只经 `fetchClientMetadataDocument`（DNS Pinning，无普通 fetch）·
Desktop 零改动 · `discovery.ts` 未改（**未声明** `client_id_metadata_document_supported`）。

---

## 10. 未解决风险

| # | 风险 | 归属 |
|---|---|---|
| 1 | singleflight / 冷却 / 限流都是**进程内**结构，多实例不共享（正确性不受影响：DB CAS / ON CONFLICT 裁决） | Phase 1.4 换共享存储 |
| 2 | ABSENT mismatch 对**孤儿** Grant / Session 不撤销（无注册行即无 CAS 撤销权）——审计如实记零计数 | 运维 / 后续阶段显式清理策略 |
| 3 | ABSENT mismatch 审计走 `deps.audit`（非阻断）：写入瞬时失败会被吞掉（与其它非事务审计同一取向）；持久化用例已验证生产写入器路径 | 可接受的既有纪律 |
| 4 | `no-store` 客户端 30 秒内无法二次 authorize（沿用 R2 风险 2/3） | 1.3.3 观察 |
| 5 | Consent 四条件 / §8.5 边界二、authorize 接入、Token 旧码策略、consent-page host 展示均未开始 | C3c-3B-3 |
| 6 | 迁移 0004 / 0005 需维护窗口 | 发布流程 |

---

## 11. 下一阶段建议（C3c-3B-3）

按设计 §12 #8–#14：

1. **Consent 流程**：GET / POST 四条件复核 + §8.5 边界二提交语义（校验失败分支
   「只做清理 + 审计并**提交**」，DB 异常仍回滚）；`mcp_consent_metadata_invalid` 落点。
2. **`authorize-flow.ts` 接入** `resolveClientForAuthorize`：`invalid_client` / 503
   映射、HTML 错误页（不重定向）；这是 Registry 的**第一个**生产调用点——届时
   `deps` 必须注入 `cooldown` 与（省略即默认的）`singleflight`，并确认 `now`
   单一时钟源。
3. **Token Endpoint**：`invalid_client` / 503；`refresh_token` gating；旧授权码
   按 §8.4（不查 INVALID / 版本）。
4. **`consent-page.ts` `clientIdentifierHost`**（§16）——`logo_uri` 仍**不渲染**。
5. **Discovery 能力声明**留到 1.3.3 真实客户端联调之后。

**完成后停止；不自行接入 Consent / Token / authorize 生产链路。**
