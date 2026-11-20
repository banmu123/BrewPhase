# BrewPhase Phase 1.3.1-C3c-3B-2 — CIMD Registry、缓存状态机、版本 CAS 与 Grant/Session 联动撤销

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> **基线 HEAD：`2511bf7a031115a13ce9fb48c7a44c00a36da227`**（C3c-3B-1 终态，本地 = 远程）
> 本阶段交付 HEAD 以 `git log -1 --format=%H` 为准（见最终交付报告）。
> 上一轮报告：`phase-1.3.1-c3c-3b-1-foundation-review.md`
> 协议依据：设计契约 **v3**（R2 + §8.5 实施边界）+ §5.6 / §8.1 / §8.2 / §15 的 C3c-3B-2 补充
> 性质：**实施轮**——Registry 状态管理、缓存四态、版本 CAS、mismatch 联动撤销、ABSENT 负面冷却。
> **未接入** `/mcp/oauth/authorize`、Consent、Token 生产链路；**未改** Desktop；**未声明** CIMD 能力。

---

## 1. 实际 HEAD 与基线

| 项 | 值 | 核对方式 |
|---|---|---|
| 分支 | `feature/remote-mcp` | `git branch --show-current` |
| 开始前 HEAD | `2511bf7a031115a13ce9fb48c7a44c00a36da227` | `git rev-parse HEAD` = 任务书给定基线 |
| 远程 HEAD（开始前） | `2511bf7a031115a13ce9fb48c7a44c00a36da227` | `git fetch origin` + `git rev-parse origin/feature/remote-mcp` |
| 工作区（开始前） | 干净 | `git status --porcelain -uall` 为空 |

提交链：`… → 3b0ff0a`（C3c-3B-1）`→ 2511bf7`（本轮基线）。**未回退任何远程提交。**

### 1.1 重读的代码与文档

代码：`cimd.ts`、`cimd-registry.ts`（本轮新建前的依赖面）、`sessions.ts`、
`consent-flow.ts`、`token-flow.ts`、`authorize-flow.ts`、`db/schema.ts`、`db/audit.ts`、
`db/migrations/*`、`env.ts`、`net/proxy-fetch.ts`、`security/rate-limit.ts`、
`routes/mcp-oauth.ts`。
测试：`tests/db/migrations.test.ts`、`tests/mcp-oauth/{cimd,schema}.test.ts`、
`tests/net/*`、`tests/helpers/*`。

文档：设计契约 v3（含 §5.6 / §8.1 / §8.2 / §8.5 / §15 的 3B-2 补充）、
3B-1 / R2 / R1 三份审查报告、`REMOTE_MCP_PHASES_ROADMAP.md`、`REMOTE_MCP_INDEX.md`、
RFC 7591 §2 / §2.1、draft-…-03 §3 / §4 / §6 / §10.1。

---

## 2. 修复 3B-1 的四个遗留问题（任务书 §二）

| # | 问题 | 修法 | 设计落点 |
|---|---|---|---|
| **1** | `validateCimdDocument` 只 `.some()` 判交集非空，却把**原始数组**放进 `metadata.grantTypes` —— 含 `client_credentials` 的文档会撞 `grant_types <@ [...]` 的 DB CHECK | 与 AS 支持集**真正过滤**：`declared.filter(t => SUPPORTED_GRANT_TYPES.has(t))`；交集为空（过滤后长度 0）拒绝；空数组 ≠ 省略；交叉一致性用**过滤后**数组；`metadata` 只存有效值 | §5.6「交集必须真正过滤」 |
| **2** | 迁移测试的 CAS 只写 `WHERE metadata_version = 1`，会误伤同版本的其它客户端 | 造**两个 `client_id`、相同 version=1** 的行；CAS 改 `WHERE client_id = ? AND metadata_version = ?`；断言 A 变 B 不变、A 用旧版本再 CAS 命中 0 行 | §8.1「CAS 谓词约束」 |
| **3** | `CimdFailureReason` 中「交集为空」与「字段非法」**都是 `document`**，审计层无法区分 → 只能去匹配 detail 文本（禁止） | 新增独立 reason **`unsupported_grant`**；`auditEventForCimdFailure()` **只走枚举**映射；grant/response → `mcp_cimd_unsupported_grant`，普通字段 → `mcp_cimd_document_invalid` | §5.6 + §15 |
| **4** | `CHECK (metadata_version >= 1)` 被隐含描述成「保证单调递增」 | 明确：CHECK **只保证正数**；单调性由**应用层版本 CAS** 承担；`WHERE` 同时含 `client_id` 与旧版本；CAS 失败不写；**应用层守卫测试**扫描全部更新入口 | §8.2 判据 3 补充 |

**新增测试**：
- `cimd.test.ts`「交集过滤」describe（5 条）：`authorization_code + client_credentials` 过滤后保留 1 个；三值过滤后保留 2 个；`code + token` 只留 `code`；**过滤结果写入真实表不撞 DB CHECK**；仅 unsupported 时拒绝。
- `migrations.test.ts` CAS 用例重写：两个 client_id 同版本 → A 变 B 不变 → A 旧版本 0 行 → B 自己的 CAS 不影响 A。
- `cimd-registry.test.ts`「审计映射」describe（6 条）：枚举 → 事件名逐条断言，含 `unsupported_grant` 与 `document` 的分流。

> 三处既有断言的修订（grant/response 的 `reason: "document"` → `"unsupported_grant"`）
> 是**任务书要求的分类修正**，不是弱化——拒绝行为不变，只是 reason 枚举更精确。

---

## 3. Registry 状态机实现说明

新增 `cloud/src/mcp-oauth/cimd-registry.ts`，主入口 `resolveClientForAuthorize(clientId, deps)`。

### 3.1 查找顺序（R1 F11 的 High 修复，绝不回退）

```text
1. client_id 长度 > 2048 → 400（不查库、不解析、不发网络）
2. 按原始字符串精确查询 mcp_oauth_clients
3. 已存在 pre_registered / dcr
   ├─ URL 形态：身份冲突检查，冲突则 400
   └─ 不透明 ID：直接使用（不判 URL 形态、不抓取、不覆盖）
4. 已存在 cimd
   → 身份冲突检查 → 缓存四态 → 按 fetch floor 决定是否重抓
5. 不存在注册行
   → validateClientIdentifierUrl → 身份冲突检查 → 才允许网络抓取 → 写行（version=1）
```

**先查库、再对未注册的 client_id 判 URL 形态**——反过来会把所有不透明预注册 ID
误判成「非 URL → 未注册 → 拒绝」。

### 3.2 缓存四态（设计 §4 / §4.1）

| 状态 | 判定 | 行为 |
|---|---|---|
| `ABSENT` | 无行 | 走 §5 的未注册路径；**先查负面冷却**，命中则不联网 |
| `FRESH` | `expires > now` | 直接用缓存，**不发网络**，不写 |
| `STALE` | 有行、`expires <= now`、≠ epoch 哨兵 | `< 30s` floor → **503 transient**（不联网、不写时间戳）；`≥ 30s` → 重抓 |
| `INVALID` | `expires === new Date(0)` | `< 30s` floor → **400 terminal**（不联网）；`≥ 30s` → 重抓（**唯一自愈路径**） |

- `expires === NULL`（cimd 行）→ fail-safe 视为 `STALE`。
- `metadata_fetched_at === null` → 视为已过 floor（无可依据的冷却起点）。
- `no-cache`（ttl 0）→ 永久 `STALE`，每次授权都要重抓；floor 内第二次 → 503。
- Consent 的 in-flight 放行规则**留给下一阶段**，本阶段不实现。

### 3.3 依赖注入（无进程级隐藏状态）

```ts
interface CimdRegistryDeps {
  db;                      // Drizzle Database
  fetcher;                 // createCimdDeps(proxy) 的 CIMD 抓取器（DNS Pinning）
  baseUrl;                 // env.baseUrl（issuer）
  mcpResource;             // mcpResourceFor(baseUrl)
  mcpTrustedPeerIdentifiers;// env.mcpTrustedPeerIdentifiers
  now();                   // 注入时钟
  cooldown;                // 可替换的负面冷却存储
  audit(input);            // 审计写入（非阻断）
}
```

受信比较列表在内部组装为 `[baseUrl, mcpResource, ...mcpTrustedPeerIdentifiers]`。
**生产不允许绕过 DNS Pinning 的普通 fetch**——抓取一律经 `fetchClientMetadataDocument`。

### 3.4 返回契约

- 成功：`{ ok: true, client: ResolvedMcpClient }`（含 `redirectUris` / `grantTypes` /
  `registrationSource` / `metadataVersion` / `cacheState`）。
- 失败：`{ ok: false, failure: { kind, reason, status, detail } }`；
  `status` = `database_error`→500、`transient`→503、`terminal`→400。

---

## 4. metadata_version CAS 真实 SQL 条件

**唯一 CAS 令牌 = `metadata_version`**（不是 `metadata_fetched_at`）。
**谓词必须同时限定 `client_id` 与旧版本**——只用版本会误伤同版本的其它客户端。

**真实条件（`casWhere()`，registry 内每一处版本 CAS 都走它）**：

```sql
UPDATE mcp_oauth_clients
   SET metadata_version = metadata_version + 1,
       <本次状态变更的列…>
 WHERE client_id = $clientId
   AND metadata_version = $expectedVersion      -- 读取时的旧版本
 RETURNING …;
```

Drizzle 形态：

```ts
function casWhere(clientId: string, expectedVersion: number) {
  return and(
    eq(mcpOauthClients.clientId, clientId),
    eq(mcpOauthClients.metadataVersion, expectedVersion),
  );
}
// …
.set({ metadataVersion: sql`metadata_version + 1`, … })
.where(casWhere(clientId, row.metadataVersion))
.returning();
```

- **1 行** = 赢得该版本 → 允许提交状态变更。
- **0 行** = 别人先写 → 丢弃本次结果，**禁止合并 / 复用自身 metadata**。
- **生产读路径走 Drizzle**（`bigint mode:"number"` → JS `number`）；裸 postgres.js
  读回的是字符串 `"1"`，`=== 1` 会静默失败（3B-1 §4 实测）。

**不变量守卫**（`cimd-registry.test.ts`「版本递增不变量守卫」）：扫描 `src` 下全部
`.ts`，凡 `.update(mcpOauthClients)` 必须同时满足 ①含 `metadata_version + 1`
②WHERE 含 `client_id` 与 `metadata_version`（或 `casWhere(`）；并断言**不存在**
以 `metadata_fetched_at` 作等值 / CAS 比较的写路径。

**扫描实测（任务书 §八.8–10）**：

| 门禁 | 结果 |
|---|---|
| `.update(mcpOauthClients)` 调用数 | **2**（成功刷新 / terminal 两处） |
| 两处均带 `metadata_version + 1` | **2 / 2** |
| raw SQL `update mcp_oauth_clients` | **0 处** |
| CAS 谓词同时含 `client_id` + `metadataVersion` | **是**（`casWhere()` 单点定义） |
| `metadata_fetched_at` 出现在 WHERE / `eq()` 比较 | **0 处** |

---

## 5. CAS 失败的五种处理情况（设计 §8.5 边界一）

| # | 情形 | 数据库动作 | 当前请求的处置 | Registry 落点 |
|---|---|---|---|---|
| 1 | **成功刷新 CAS 失败**（0 行，版本已变） | 不写；重读**只作诊断** | **503 transient** `cas_superseded`（fail-closed；不建授权请求、不用自身结果） | `applySuccessOnExistingRow` |
| 2 | **mismatch CAS 失败**（0 行） | **不标 INVALID、不撤销、不写成功审计** | **400 terminal** `client_id_mismatch`（按自身抓取结果拒绝，但零 DB 写入） | `applyTerminalOnExistingRow` |
| 3 | **其它 terminal CAS 失败**（0 行） | 同上：**零 DB 写入** | **400 terminal**（自身 reason，如 `json`；不被改写成 `cas_superseded`） | `applyTerminalOnExistingRow` |
| 4 | **注册行被删除**（0 行且重读无行） | 不写；**不重新 INSERT** | **400** `row_deleted` | 两处 CAS 失败分支 |
| 5 | **数据库异常** | **整事务 ROLLBACK** | **500**（固定文案，不泄 SQL / 表名） | 两处 `catch` → `databaseError()` |

**为什么成功刷新失败是 503 而不是「用自己的结果继续」**：该结果对应**过时版本**，
用它建授权请求等于把「我以为的当前状态」当权威——权威只能是数据库当前行。

**为什么 terminal（含 mismatch）失败仍是 400 而不是 503**：terminal 结论是对
**当前这次请求**的诚实拒绝（我们刚抓到它）；但它**不拥有失效权**（CAS 0 行 =
别人已用更新版本确认状态），因此**一个字节都不写**。

**不得为了提高成功率放宽 fail-closed**：任何「CAS 失败就用自己抓的结果继续」的
实现都会让 #1 的 503 与 #2/#3 的零写入同时失效。

---

## 6. Grant / Session 撤销事务证据

新增 `sessions.ts` 的 `revokeMcpGrantsAndSessionsByClient(tx, { clientId, now })`，
**必须在调用方的事务里执行，且该事务已先完成版本 CAS（命中 1 行才有资格调用）**。

**锁顺序**：`mcp_oauth_clients → mcp_grants → mcp_sessions`（CAS 先拿 clients，
命中后才 grants → sessions）。

**同一事务内的三条写入**：

```sql
-- 1) Grant：撤销 + epoch +1（单条语句，不先读后写）
UPDATE mcp_grants SET revoked_at = $now, epoch = epoch + 1
 WHERE client_id = $clientId AND revoked_at IS NULL
RETURNING id, user_id;

-- 2) Session：只撤该 client 未撤销的
UPDATE mcp_sessions SET revoked_at = $now, revoked_reason = 'client_id_mismatch'
 WHERE client_id = $clientId AND revoked_at IS NULL
RETURNING id, user_id;

-- 3) 一条聚合审计（同事务；失败即整体回滚）
INSERT INTO auth_events (event_type, user_id, detail)
VALUES ('mcp_client_id_mismatch', NULL,
        jsonb_build_object('clientId', $clientId, 'reason', 'client_id_mismatch',
                           'revokedGrantCount', $g, 'revokedSessionCount', $s));
```

**Registry 的 mismatch 路径**（`applyTerminalOnExistingRow`）：
`db.transaction(tx => { CAS UPDATE; if 0 行 → 返回 {casWon:false}（零写入）;
else revokeMcpGrantsAndSessionsByClient(tx, …) })` —— CAS 与撤销**原子**。

**撤销语义**：跨用户、跨 resource、只按 `client_id` 匹配、不删历史行、
Grant `epoch +1`、审计 `userId = NULL`（跨用户的系统动作）。

**真实 PostgreSQL 测试证据**（`cimd-registry.test.ts`「Grant / Session 联动撤销」，7 条）：

| 用例 | 断言 |
|---|---|
| mismatch：Grant 与 Session 都撤销、epoch 递增 | 2 Grant 全撤、2 Session 全撤、epoch 均为 2 |
| 跨 resource | 同 client 下两个不同 resource 的 Grant 都撤 |
| 不影响其它 client | 无辜 client 的 Grant / Session `revoked=0`、version 不变 |
| 审计与撤销原子提交 | 恰 1 条 `mcp_client_id_mismatch`，`user_id` NULL，含两个计数 |
| **审计失败 → 整事务 rollback** | 注入 `recordAuthEvent` 抛错 → 500；**version 未推进、未标 INVALID、Grant 零撤销、零审计** |
| **CAS 失败 → 零撤销、零成功审计** | 持锁事务先推版本 → mismatch 的 CAS 撞锁 → 400；Grant 零撤销、零审计、行未标 INVALID |

> 「审计失败 → rollback」用 `vi.mock("../../src/db/audit.js")` 注入失败开关实现，
> 只影响 `mcp_client_id_mismatch` 这一条，其余审计仍走真实实现。

---

## 7. 负面冷却的存储与 TTL 实现（设计 §8.5 边界三）

ABSENT（无注册行）抓取失败不写行，**不受 `metadata_fetched_at` 的 30 秒 floor 保护**。
本阶段实现最小负面冷却。

| 项 | 实现 |
|---|---|
| 形态 | `InMemoryNegativeCooldown implements NegativeCooldownStore`（**可替换注入**） |
| 存储 | 进程内 `Map<clientId, { at: number; reason: CimdFailureReason }>` |
| TTL | **30 秒**（`NEGATIVE_COOLDOWN_TTL_MS = 30_000`，与 fetch floor 同值） |
| 存什么 | **只存时间戳 + 原因枚举**——**绝不**存响应正文、`no-store` 内容或 HTTP Header |
| 命中 | 返回 terminal，**不发起第二次网络请求** |
| 清除 | 成功注册后 `clear(clientId)` |
| transient | **不写**冷却（只有 terminal 写） |
| 容量 | `NEGATIVE_COOLDOWN_MAX_ENTRIES = 10_000`；先清理过期项，仍达上限则**逐出最旧**项 → 条目数恒 ≤ 上限 |
| 时钟 | 由调用方注入（`now` 参数），测试可控、不依赖真实时间 |
| 多实例 | 进程内实现（单实例部署即全局）；**Phase 1.4 扩容时必须重新评估共享存储** |
| 性质 | **短生命周期运行态运营数据**，不是授权状态 / Grant 状态（那类禁止放内存） |

**观测点**：`snapshot()` 返回 `{ clientId, at, reason }[]`，用于断言「不存响应正文」——
把哨兵串埋进 `no-store` 文档后，`JSON.stringify(snapshot())` 必须不含该哨兵。

**真实 PostgreSQL 测试**（7 条）：首次 terminal 写入 → 30 秒内重复请求**不发网络** →
冷却过期后重新抓取 → transient **不写** → 成功后**清除** → `no-store` 正文**不入冷却** →
不同 client 隔离 → 容量上限逐出最旧。

---

## 8. 所有 PostgreSQL 并发测试结果

全部 CAS 竞争用例使用**真实 PostgreSQL 事务 + 行锁 + `pg_stat_activity` /
`pg_blocking_pids` 断言**，不用 mock 模拟顺序。

`tests/mcp-oauth/cimd-registry.test.ts`（**42 条**）：

| 组 | 条数 | 关键并发 / 事务用例 |
|---|---:|---|
| 注册行为 | 6 | 预注册不透明 / URL 冲突 / DCR 不覆盖 / 非法 URL 零 DNS / 合法注册 version=1 / 2048-2049 边界 |
| 缓存行为 | 7 | FRESH 不抓 / STALE 超 floor 重抓 / STALE 内 503 / INVALID 内 400 / INVALID 超 floor 自愈 / no-cache 每次抓 / no-store 零行 |
| **CAS 竞争** | 8 | 两请求同读同版本（屏障）→ 恰一赢一 503；成功 vs mismatch 并发（胜者定终态）；**INVALID 先提交、迟到成功 → 503 且 INVALID 不复活**；**成功先提交、迟到 mismatch → 400 零撤销零审计**；malformed vs 成功；**删行后迟到请求不重新 INSERT**；**真实行锁：`pg_stat_activity` 观测到等待、提交后 CAS 失败**；CAS 只影响目标 client_id |
| Grant/Session 撤销 | 7 | 双撤 + epoch / 跨 resource / 不影响其它 client / 审计原子 / **审计失败整事务回滚** / **CAS 失败零撤销零审计** |
| ABSENT 负面冷却 | 7 | 命中不联网 / 过期重抓 / transient 不写 / 成功清除 / 不存正文 / 隔离 / 容量上限 |
| 审计映射 | 6 | 枚举 → 事件名（含 `unsupported_grant` / `document` 分流、mismatch 走撤销事务） |
| **版本递增守卫** | 2 | 扫描全部 `.update(mcpOauthClients)` 带 `version+1` 且 CAS 含 `client_id`+版本；无 `metadata_fetched_at` 等值比较 |

**并发编排方式**（确定性，非 sleep 碰运气）：
- **屏障 fetcher**：两个请求的 `request` 都挂在 gate 上，第 N 次调用才放行 →
  保证两者**都先读到同一版本**再同时进 CAS。
- **阻塞 fetcher**：单个请求的 fetch 挂起 → 先让另一方完整跑完（读→CAS→提交），
  再放行 → 制造「读到旧版本的迟到方」。
- **持锁事务** `holdVersionBump()`：手工 `BEGIN` 把 version +1 且**不提交** →
  让目标请求的 CAS 真正撞上行锁 → 用 `pg_stat_activity` 断言 `wait_event_type='Lock'`
  且 `pg_blocking_pids` 指向持锁方 → 提交后 CAS EPQ 失配 → 0 行。

**运行结果**：`cimd-registry.test.ts` **42 passed**（3 连跑稳定，含非确定性胜者的
malformed 并发用例已改为按「谁获胜」结构化断言）。

---

## 9. TypeScript / ESLint / Vitest 实际输出

| # | 门禁 | 实际执行 | 结果 |
|---|---|---|---|
| 1 | Cloud 类型检查 | `cd cloud && npx tsc --noEmit` | ✅ **无输出（0 error）** |
| 2 | Cloud lint | `cd cloud && npx eslint src tests` | ✅ **无输出（0 error / 0 warning）** |
| 3 | Registry 测试 | `npx vitest run tests/mcp-oauth/cimd-registry.test.ts` | ✅ **42 passed**（3 连跑稳定） |
| 4 | 完整测试 | `npx vitest run` | ✅ **1443 passed / 67 files**（基线 1397 / 66 → **+46 / +1**） |
| 5 | 真实 PG CAS 并发 | 含于 #3（屏障 / 阻塞 / 持锁事务 + `pg_stat_activity`） | ✅ 见 §8 |
| 6 | 撤销事务与审计回滚 | 含于 #3「Grant / Session 联动撤销」 | ✅ 见 §6 |
| 7 | ABSENT 负面冷却 | 含于 #3「ABSENT 负面冷却」 | ✅ 见 §7 |
| 8 | `.update(mcpOauthClients)` 扫描 | `grep -rn "\.update(mcpOauthClients)" src/` | ✅ **2 处，均带 `version+1`** |
| 9 | raw SQL 更新 `mcp_oauth_clients` | `grep -rniE "update\s+mcp_oauth_clients" src/` | ✅ **0 处** |
| 10 | 所有状态变更满足 `client_id + version` CAS | `casWhere()` 单点定义 + 守卫测试 | ✅ 见 §4 |
| 11 | git diff 检查 | 见 §10 文件清单 | ✅ 无越界修改 |
| 12 | Desktop / Discovery 未改 | `git status` 无 `Desktop/src`；`discovery.ts` 未改 | ✅ **未声明 `client_id_metadata_document_supported`** |

**失败项：无。** 测试未通过弱化断言、删除测试或跳过 PostgreSQL 取得结果。

---

## 10. 新增和修改文件清单

**源码（4 修改 + 1 新增）**

| 文件 | 变更 |
|---|---|
| `cloud/src/mcp-oauth/cimd-registry.ts` | **新增**：`resolveClientForAuthorize`、缓存四态、版本 CAS、ABSENT 负面冷却、审计枚举映射 |
| `cloud/src/mcp-oauth/cimd.ts` | 交集**真正过滤**；新增 reason `unsupported_grant` |
| `cloud/src/mcp-oauth/sessions.ts` | 新增 `revokeMcpGrantsAndSessionsByClient(tx, …)`（Grant+Session+聚合审计同事务） |
| `cloud/src/db/audit.ts` | `AuthEventType` 增 12 个 `mcp_cimd_*` / `mcp_client_id_mismatch` 取值 |
| `cloud/src/db/schema.ts` | `metadata_version` 的 CHECK 注释澄清（只保证正数，不保证单调） |

**测试（2 修改 + 1 新增）**

| 文件 | 变更 |
|---|---|
| `cloud/tests/mcp-oauth/cimd-registry.test.ts` | **新增**：42 条（注册 / 缓存 / CAS 并发 / 撤销 / 冷却 / 审计映射 / 版本守卫） |
| `cloud/tests/mcp-oauth/cimd.test.ts` | 交集过滤 5 条；grant/response 的 `reason` 改 `unsupported_grant` |
| `cloud/tests/db/migrations.test.ts` | CAS 用例重写：两 client_id 同版本，`WHERE` 同时限定 `client_id` + 版本 |

**文档（本阶段交付 4 份）**：设计契约（§5.6 / §8.1 / §8.2 / §15 / §12 / §17 的 3B-2 补充）、
本报告、`REMOTE_MCP_PHASES_ROADMAP.md`、`REMOTE_MCP_INDEX.md`。

**未改**：`authorize-flow.ts` / `consent-flow.ts` / `token-flow.ts` / `routes/mcp-oauth.ts`
生产逻辑、`discovery.ts`、Desktop 任何文件、迁移文件（0004 / 0005 沿用 3B-1）、
`package.json` / lockfile。

---

## 11. 尚未解决的问题

| # | 问题 | 归属 |
|---|---|---|
| 1 | Consent 失败分支的「提交语义」（§8.5 边界二）**仍未实现**（Consent 接入属 3B-3） | C3c-3B-3 |
| 2 | Consent GET/POST **四条件**未接入；`mcp_consent_metadata_invalid` 审计未写 | C3c-3B-3 |
| 3 | Token Endpoint 旧授权码策略（§8.4）、refresh gating 未接入 | C3c-3B-3 |
| 4 | `authorize-flow.ts` 未调用 `resolveClientForAuthorize`（本阶段刻意不接入路由） | C3c-3B-3 |
| 5 | 负面冷却是**进程内**实现，多实例不共享 | Phase 1.4 与限流一并换共享存储 |
| 6 | `no-store` 客户端 30 秒内无法二次 authorize（沿用 R2 风险 3） | 1.3.3 观察 |
| 7 | 迁移 0004 / 0005 需维护窗口（0004 改 CHECK 短暂锁表、0005 加列瞬时） | 发布流程 |

---

## 12. 下一阶段建议（C3c-3B-3）

按设计 §12 的 #8–#14：

1. **`consent-flow.ts` 四条件 + §8.5 边界二提交语义**：GET / POST 复核
   （POST 内 `FOR SHARE`）；metadata invalid 拒绝时**只做「清理 auth request +
   写 `mcp_consent_metadata_invalid`」并提交**，不写 Grant / Code；DB 异常仍回滚。
   测试：删行已提交、审计持久、无授权码、Grant/Session 不变、并发 POST 不重复消费。
2. **`authorize-flow.ts` 接入** `resolveClientForAuthorize`；错误映射
   `invalid_client` / 503；HTML 错误页（不重定向）。
3. **Token Endpoint**：`invalid_client` / 503 映射；`refresh_token` gating；
   **旧授权码按 §8.4（不查 INVALID / 版本）**。
4. **`consent-page.ts` `clientIdentifierHost`**（§16）。
5. **Discovery 能力声明**（`client_id_metadata_document_supported`）——**仍留到 1.3.3
   真实客户端联调之后**，本阶段与 3B-3 都不声明。

**本阶段到此为止，未开始 Consent / authorize / token 生产链路接入。**
