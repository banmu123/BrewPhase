# BrewPhase Phase 1.3.1-C3c-3B-3-R1 — Consent 拒绝路径并发锁收尾

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> **基线 HEAD：`fe37aeed529b064ddb87d1589128c586055bd54d`**（C3c-3B-3 终态；
> 开始前 `git fetch` + `git ls-remote` 核实本地 = 远程 = 基线，工作区干净）。
> 交付提交 SHA 以 `git log -1 --format=%H` 为准（见最终交付报告）。
> 性质：**P2 单点修复轮**——Consent 的 deny / 空 scope 路径补 `FOR SHARE` 锁，
> 不重新实现 Consent、不改 allow、不碰 Authorize / Token / Registry / CAS。
> **未新增迁移、未新增依赖、未改 Desktop / iOS、未改 Discovery 能力声明。**

---

## 1. 问题与修复前后的事务 / 锁顺序

### 1.1 独立审核发现的 P2

`decideConsent()` 的 deny / 空 scope 分支（修复前）：

```text
普通 SELECT auth_request + LEFT JOIN client（快照）
    ↓
按快照执行四条件（无锁）
    ↓
denyConsent()：条件 DELETE（无事务边界）
    ↓
HTTP 302 access_denied → redirect_uri
```

**缺口**：四条件检查之后、删除 / 重定向之前不持锁。刷新事务可以在窗口内
把本次 `redirect_uri` 移出 `redirect_uris`（或标 INVALID），拒绝仍会把响应
**302 到已从注册集合删除的回调地址**——正是 [ID §4.2 MUST 精确匹配] 要防的
形态。allow 路径（3B-3）已有 `FOR SHARE`，deny / 空 scope 没有。

### 1.2 修复后（`denyConsentInTransaction()`，`consent-flow.ts`）

```text
BEGIN
1. SELECT mcp_auth_requests FOR UPDATE
2. 重新检查（锁内，不信任入口读）：行存在 / expires_at / provider_consumed_at /
   user_id / provider / browser_binding_hash / CSRF（常量时间比较）
3. SELECT mcp_oauth_clients FOR SHARE            ← 锁序：auth_requests → oauth_clients
4. 四条件（锁内当前值）：① 行存在 ② 非 INVALID epoch ③ redirect_uri 逐字符在册
   ④ grant_types 含 authorization_code
5. metadata invalid → 删除 auth request + 写 mcp_consent_metadata_invalid
   （stage=consent_submit、condition=1|2|3|4）→ **正常 return（提交事务）**
   → 路由 400 HTML，绝不 302；不 throw（抛错会把删行与审计一起回滚）
6. 四条件通过 → 条件 DELETE（防御性条件保留）→ redirect_uri / state 取
   **锁内行** → return denied → 事务提交后路由才 302 access_denied
COMMIT
（只有数据库异常才抛出 → decideConsentSafely 收口固定 500、整事务回滚）
```

### 1.3 对照表

| 维度 | 修复前 | 修复后 |
|---|---|---|
| 判定与删除的原子性 | 快照读 → 无锁删除，窗口内可被刷新改写 | 同一事务、`FOR SHARE` 保护下判定与删除 |
| 锁顺序 | 无锁 | `auth_requests FOR UPDATE → oauth_clients FOR SHARE`（**与 allow 完全一致，无反向**） |
| invalid 拒绝 | 独立事务删 + 审计（外层预检） | **同一事务**删 + 审计，正常 return 提交 |
| deny 正常 | 条件 DELETE（命中行数判据） | 同样以条件 DELETE 命中行为判据（持锁后窗口关闭），redirect/state 取锁内行 |
| 空 scope | 复用 denyConsent（同样无锁） | **同一事务函数**（任务书 §5.3：沿用显式 deny 同一逻辑） |
| CSRF | 只在外层读时检查 | 外层快路径保留 + **锁内重新检查**（与 allow 同纪律：不一致删行并提交） |
| 数据库异常 | — | 抛出 → 固定 500、整事务回滚 |

**未改动**：allow 路径（`allowConsent` 函数体零 diff——已用
`git diff … | grep upsert/finalScopes/insert(mcpAuthCodes)` 核实）、
`metadata_version` / CAS、INVALID/STALE 判定、Grant upsert、Step-up scope、
授权码签发、Token Endpoint、Registry、Grant/Session 撤销、路由层
（`consentSubmitFailure` / deny 的 302 与 Cookie 清理原样）。

**改动面**：`cloud/src/mcp-oauth/consent-flow.ts`（+178/−72，全部在 deny 侧）与
`cloud/tests/mcp-oauth/consent-metadata.test.ts`——仅此两个文件。

---

## 2. 测试 A–D 的真实 PostgreSQL 执行证据

新增 describe「deny / 空 scope 的事务与真实锁（C3c-3B-3-R1）」，4 条；
`consent-metadata.test.ts` 19 → **23 条**。并发证明全部使用**真实事务、真实
行锁**，阻塞检测用 `pg_stat_activity`（`wait_event_type = 'Lock'` + 查询文本
含 `mcp_oauth_clients`）与 `pg_blocking_pids`，**不 sleep 猜测**；断言包在
`try/finally` 里保证失败时也释放持锁事务（不泄漏锁卡住后续 `resetDb`）。

### 测试 A：显式 deny 与注册信息刷新竞争 → **condition=3**

时序（全部真实 PG）：

```text
B: BEGIN → UPDATE mcp_oauth_clients（version+1，取得 U 锁，不提交）→ signal
T: POST decision=deny → FOR UPDATE(auth_request 拿到) → FOR SHARE(clients) 阻塞
   → pg_stat_activity 观测 wait_event_type='Lock'、pg_blocking_pids 指向 B  ✅ 断言通过
B: UPDATE redirect_uris = ['https://elsewhere.example/cb']（移除本次回调）→ COMMIT
T: FOR SHARE 恢复 → 读到新 redirect_uris → 条件 3 失败 → 删行 + 审计（同事务）→ 400
```

断言（全部通过）：HTTP **400**、**无 `Location` 头**、auth request 已删、
`mcp_consent_metadata_invalid` 持久且 `stage=consent_submit`、`condition=3`、
零授权码、零新 Grant、零 Session、**另一用户另一 client 的 Grant 逐字段不变**
（`grantSnapshot` 前后深比较）。

### 测试 B：空 scope 与 INVALID 竞争 → **condition=2**

```text
B: BEGIN → UPDATE … metadata_cache_expires_at = epoch（U 锁，不提交）→ signal
T: POST decision=allow, scopes=[] → FOR SHARE 阻塞（pg_stat_activity 断言）  ✅
B: COMMIT → T 恢复 → 读到 epoch → 条件 2 失败 → 删行 + 审计 → 400
```

断言：**400、无 Location**、删行 + 审计（`stage=consent_submit`、
`condition=2`）已提交、零 Code / Grant / Session、`version=2`（B 的推进已提交）。

### 测试 C：有效 deny 正常路径

无并发：**302**、`error=access_denied`、`state=client-state-1` **原样回传**、
无 `code`、auth request 已删、零 Code / Grant / Session、**无** metadata 审计
（正常拒绝 ≠ metadata 拒绝）。

### 测试 D：空 scope 正常路径

`decision=allow, scopes=[]` → 按 deny 处理：**302 access_denied**、state 原样、
无 code、删行、零 Code / Grant / Session、无 metadata 审计。

**执行结果**：`consent-metadata.test.ts` **23 passed**，**3 连跑稳定**；
其中 A / B 的 `expect(waiter).not.toBeNull()` 通过即证明「POST 真实阻塞在
`FOR SHARE`」——不是 sleep、不是 mock 锁。

---

## 3. 门禁实际结果

```text
$ cd cloud && npx tsc --noEmit
（无输出，0 error）

$ cd cloud && npx eslint src tests
（无输出，0 error / 0 warning）

$ cd cloud && npx vitest run tests/mcp-oauth/consent-metadata.test.ts
 Test Files  1 passed (1)
      Tests  23 passed (23)          ← 3 连跑稳定

$ cd cloud && npx vitest run tests/mcp-oauth
 Test Files  34 passed (34)
      Tests  881 passed (881)        ← 基线 877 → +4（测试 A–D）

$ cd cloud && npx vitest run
 Test Files  70 passed (70)
      Tests  1515 passed (1515)      ← 基线 1511 → +4
```

**失败项：无。** 无测试被删除、skip 或弱化（allow 路径、既有 deny/空 scope
行为、S1–S7、FOR SHARE 阻塞与兼容性用例全部原样保留并通过）。

§七「特别检查」逐项：

| 检查 | 结果 |
|---|---|
| allow 路径仍用 `FOR SHARE` | ✅ `consent-flow.ts:708`（函数体零改动） |
| deny / 空 scope 也用 `FOR SHARE` | ✅ `consent-flow.ts:513`（新事务） |
| 无反向锁顺序 | ✅ 两处均为 `auth_requests FOR UPDATE (477/658) → oauth_clients FOR SHARE (513/708)` |
| metadata invalid 拒绝正常提交 | ✅ 事务内正常 `return`（测试 A/B 断言删行与审计均已持久） |
| 数据库异常仍 rollback | ✅ 异常抛出事务 → `decideConsentSafely` 固定 500 |
| deny 正常仍 `access_denied` | ✅ 测试 C / D |
| invalid 时绝不重定向 | ✅ 测试 A / B 断言 `Location` 为 null；既有 S1/S2/deny 用例原样通过 |
| 无删除 / skip / 弱化 | ✅ 全量 1515 条通过 |

范围约束：仅改 `consent-flow.ts` + `consent-metadata.test.ts`（+ 本报告与
路线图 / 索引）；**未**改 Authorize / Token / Registry / `metadata_version` /
迁移 / 依赖 / Desktop / iOS / Discovery。

---

## 4. 未解决的风险与边界

| # | 风险 / 边界 | 归属 |
|---|---|---|
| 1 | deny 的**入口快路径**（`decideConsent` 的普通读 + CSRF 预检）保留——它只用于快速失败与错误文案，**权威判定全部在锁内**（任务书 §5.1 步骤 2 的「重新检查」） | 设计如此 |
| 2 | CSRF 在锁内不一致时删行并提交（与 allow 同纪律）；外层预检已挡掉绝大多数，锁内分支只覆盖「另一标签页 GET 轮换了 CSRF」的窗口 | 与 allow 一致 |
| 3 | `FOR SHARE` 只与刷新的 `UPDATE` 冲突：拒绝与刷新被串行化，但拒绝本身不携带任何「注册仍有效」的承诺（只删自己的 pending 行、302 的回调已由锁内条件 3 把关） | 已由测试 A 钉住 |
| 4 | 既有边界不变：进程内 cooldown / singleflight / 限流（Phase 1.4）、能力声明留 1.3.3、Access Token ≤15min 窗口（1.3.2） | 沿用前轮 |

---

## 5. 下一阶段建议

本 P2 修复完成，C3c-3B 生产链路（Authorize / Consent / Token）与全部边界
收口。**正确路线（C3c-3B-3-R1 修正，取代本文档先前的错误顺序）**：

1. **Phase 1.3.2**：`POST /mcp` Streamable HTTP 与 8 个只读工具服务（Bearer /
   Session / Grant 实时回查、双时代协议、`dispatchToolCall` 转发）；
2. **Phase 1.3.3**：真实客户端联调（Inspector / ChatGPT / Grok，G1–G6 门禁）；
3. **单独提交启用 `client_id_metadata_document_supported`**——只有真实客户端
   联调通过后才开启 CIMD Discovery capability（设计 §12.2，独立可 revert）。

（Phase 1.4 共享存储属于 1.4 自身范围，不在上述链条内；先前
「1.3.3 → 1.4 → 1.3.2」的顺序是错误的，已废止。）

**完成后停止，等待独立审核；不合并 main、不 force push、不提前声明 CIMD 能力。**
