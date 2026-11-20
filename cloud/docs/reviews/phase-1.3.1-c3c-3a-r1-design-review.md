# BrewPhase Phase 1.3.1-C3c-3A-R1 — 设计契约复审报告

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> 审查基线：`b45809f`（C3c-3A 终态，本地 = 远程）
> 上一轮报告：`phase-1.3.1-c3c-3a-design-review.md`（**原文保留，不覆盖**）
> 设计正文（已修订）：`docs/design/phase-1.3.1-c3c-3a-cimd-authorize-integration-contract.md`
> 性质：**设计复审与决策关闭**。**没有生产逻辑改动、没有迁移、没有依赖变更**。

---

## 1. 实际 HEAD 与基线

| 项 | 值 | 核对方式 |
|---|---|---|
| 分支 | `feature/remote-mcp` | `git branch --show-current` |
| 本地 HEAD | `b45809f` | `git log -1` |
| 远程 HEAD | `b45809f6500aa982d249cafe542a6afcae3b15cb` | `git ls-remote`（`20.205.243.166` + HTTP/1.1） |
| 工作区 | 干净 | `git status --porcelain -uall` |

提交链：`139731f`（C3c-2）→ `cb2e68c` / `92148bf`（R1）→ `326dcf1` / `502cbe7`（R2）
→ `6c20908`（R2v）→ `b45809f`（C3c-3A）。本轮以 `b45809f` 为审查基线。

### 1.1 读取的代码与文档

代码（重读，不采信上一轮摘要）：`cimd.ts`、`authorize-flow.ts`、`consent-flow.ts`
（GET / POST 两条路径逐行）、`sessions.ts`（`createMcpSessionInTransaction` 的锁序注释、
`revokeMcpSessionsByGrant`）、`token-flow.ts`（兑换与 refresh）、`consent-page.ts`、
`db/schema.ts`（`mcp_grants` / `mcp_oauth_clients` / `mcp_sessions` / `mcp_auth_codes`）、
`env.ts`、`net/proxy-fetch.ts`。

文档：`draft-…-03` 原文（§4.2 / §6.1 / §6.2 / §10.1 / §10.6 / §10.9）、RFC 7591 §2、
Node.js `tls` 文档源码、上一轮设计与审查报告。

### 1.2 与任务书的两处核对

1. 任务书基线 `b45809f` —— 一致。
2. 任务书称「同意页面会把已有 Grant 的权限显示为已授予、禁用的复选框」——**属实**，
   但需要补一句更精确的机制：GET 与 POST 的 grant 查询都带 `isNull(revokedAt)`，
   所以「撤销 Grant」确实会让复选框回到未勾选。这正是本轮把 Grant 纳入撤销的依据。

---

## 2. 独立发现的问题

| # | 级别 | 问题 | 代码根因 | 处置 |
|---|---|---|---|---|
| F1 | **High** | 只撤 Session 时，**旧 Grant 会被静默继承**：同意页把它显示为已授予、step-up 合并 scope、`epoch` 因「scope 未变」保持不变 → Desktop 侧 `(grantId, epoch)` 上下文被复用 | `consent-flow.ts` 的 upsert epoch 规则只看 `revoked_at` 与 scope；只撤 Session 时 Grant 仍 active | 设计改为 Grant + Session 一起撤，`epoch + 1`（设计 §5.3） |
| F2 | **High** | **待完成授权请求与元数据刷新的竞态**：authorize 固化了 `redirect_uri`，刷新删掉它之后，consent GET/POST 仍会签发授权码并 302 到已删除的回调 | `allowConsent()` 只对 `mcp_auth_requests` 加 `FOR UPDATE`；读 `mcp_oauth_clients` 只为取 `client_name`，不校验 `redirect_uris`；`token-flow.ts` 只比对 `mcp_auth_codes.redirect_uri`，从不读注册表 | 设计新增 §8.3：GET / POST 双检查，POST 在事务内 `FOR SHARE` 锁注册行；给出锁序与死锁证明 |
| F3 | **Medium** | 初版说「低于 fetch floor 时按 STALE 使用旧行」——即冷却窗口内把**已过期**文档当有效 | 把 [ID §6.2 MAY]（限流）误读成「可以使用过期数据」 | 改为 fail-closed：冷却内 503；`INVALID` 优先于 floor；`no-cache` 明确为永久 STALE（设计 §4.1） |
| F4 | **Medium** | 未实现 [ID §10.1 SHOULD] 的**身份冲突检查**：`client_id` 可等于 issuer 或 MCP resource，造成令牌 `aud` / `iss` 语义混淆 | `validateClientIdentifierUrl()` 只判形态 | 新增纯函数 `conflictsWithTrustedIdentifier()`，DNS 之前、terminal、不发网络（设计 §3.2） |
| F5 | **Medium** | **CAS 精度未证明**：`timestamptz` 是微秒、`Date` 是毫秒；若有人用 `now()` 写 `metadata_fetched_at` 再拿它做 CAS，必然失配且无人察觉 | 设计只写「用 `metadata_fetched_at` 做 CAS」，没有精度论证 | 真实 PG 实测（§3），并固化三条纪律（设计 §8.2） |
| F6 | **Medium** | `grant_types` 省略时默认 `["authorization_code","refresh_token"]`，与 RFC 7591 §2 的默认值（仅 `authorization_code`）不符；且未声明 `refresh_token` 的客户端照样拿到 refresh token | `cimd.ts` 的 `grantTypes ?? [...]`；`createMcpSessionInTransaction` 无条件签发 refresh | 默认值改为 `["authorization_code"]`；`refresh_token` 必须显式声明，未声明则不签发（3B 任务 #4 / #10） |
| F7 | Low | 3B 与 1.3.3 **循环依赖**：3B 最后一步要声明能力，声明前置是「真实客户端联调」，而联调属 1.3.3 | 设计 §12 的步骤 10 与前置条件表互相矛盾 | 3B 不声明（`false`）；1.3.3 联调后单独提交声明（设计 §12.2） |
| F8 | Low | 审计事件三名混用：`mcp_client_id_mismatch` / `mcp_session_revoked` / `client_id_mismatch` | 文档未区分「DB 取值」与「事件名」 | 新增命名表并消歧（设计 §15） |
| F9 | Low | 同意页未展示 `client_id` 的 hostname（[ID §10.6 SHOULD]）；现有 `redirectHost` 容易被误当成客户端身份 | `consent-page.ts` 只有 `clientName` + `redirectHost` | 新增 `clientIdentifierHost`，与 `redirectHost` 分离渲染（设计 §16） |
| F10 | Info | postgres.js 3.4.9 **不接受裸 `Date` 参数**（`ERR_INVALID_ARG_TYPE`）；CAS 谓词若写成 `sql\`… is not distinct from ${date}\`` 会直接抛错 | 驱动只接受字符串 / Buffer；Drizzle 的列编码器才会把 `Date` 转 ISO | 设计明确要求 `::timestamptz` 显式 cast 或 `eq(col, date)` |
| F11 | **High** | 初稿的判定顺序（长度 → **形态** → 查库）会把**所有预注册客户端拒掉**：预注册 `client_id` 不是 URL，形态必然不合格，于是走「未注册 → 拒绝」，永远到不了查库 | 顺序本身；配合 512 预检查，连「长度够短」的普通 id 也会被拒 | 改为「长度硬上限 → 查库 → 未命中才判形态」；512 降为创建时约束（设计 §3 / §3.1） |

---

## 3. CAS 时间精度的实测证据

**环境**：真实 PostgreSQL 16（容器 `brewphase-cloud-test-pg`，54329）+ Drizzle
（`postgres-js` 3.4.9）+ 真实的 `mcp_oauth_clients` 表。**不是 mock Date。**

| 场景 | 操作 | 实测输出 |
|---|---|---|
| A 毫秒往返 | 写 `2026-11-20T10:00:00.123Z` → 读回 → 用读回值 CAS | 读回 `…10:00:00.123Z`，`getTime()` 相等；**CAS 命中 1 行** |
| B 微秒截断 | `SET metadata_fetched_at = now()`（存 `…04:03:34.260007`）→ 读回 `…04:03:34.260Z` → CAS | **CAS 命中 0 行**（必然失配） |
| C 并发 CAS | 同一旧令牌两次 UPDATE（新值 → 更旧值） | 第一次 **1 行**、第二次 **0 行**；最终值是新数据，失败者未覆盖 |
| D 列编码器 | `eq(col, new Date(...))` | 命中 1 行（`Date` 经列编码器可正常工作） |

附带的驱动层事实：把裸 `Date` 放进 Drizzle 的 `sql` 模板会立刻抛
`The "string" argument must be of type string or an instance of Buffer or ArrayBuffer.
Received an instance of Date`。因此 CAS 只能写成
`${value.toISOString()}::timestamptz` 或 `eq(col, value)`。

**结论**：`metadata_fetched_at` **可以**继续做 CAS 令牌，但前提是「只写毫秒精度的
JS `Date`」。这一条必须由一条**负向测试**钉住（设计 §13 #42：`now()` 写入 → CAS
命中 0 行）。若 3B 实现中出现任何一处 `now()` 写该列，测试会立刻转红。

---

## 4. 规范对齐（R1 新增部分）

标注：`MUST` / `SHOULD` / `MAY` 为草案原文强度；`[项目策略]` 是本地更严格选择。

| 条款 | 强度 | 当前实现 | 结论 |
|---|---|---|---|
| §10.1 拒绝与自身 issuer / 受信 AS / RS 标识符相同的 client_id | **SHOULD** | **未实现** | 3B 补（§3.2）。项目按 terminal 拒绝，比 SHOULD 更硬 → 标注为 [项目策略] |
| §10.6 授权界面展示 client_id 的 hostname | SHOULD | **未实现**（只有 redirectHost） | 3B 补（§16） |
| §10.9 展示 logo 的三个前置条件（预取 / 受信提供 / 内容校验） | **MUST** | 不展示远程 logo，不抓取 | ✅ 不触发该 MUST；继续不显示 |
| §6.2 允许限流，即使频率低于 Cache-Control 要求 | MAY | 30s floor 方向正确，但初版用它为「使用过期文档」背书 | 修正为「floor 只限制抓取，不放行过期数据」（§4.1） |
| §4.2 回调必须是注册值的精确匹配 | **MUST** | authorize 阶段满足；**consent / token 阶段不复核** | 3B 在 consent GET/POST 复核（§8.3） |
| §6.1 失败时不得重定向到客户端 | **MUST NOT** | 现状 JSON 400，不重定向 | ✅；3B 改成 HTML 页仍是 4xx/5xx |

**RFC 7591 §2 的默认值**（与草案的关系）：

| 字段 | RFC 7591 原文默认 | 草案是否覆盖 | 本项目取 |
|---|---|---|---|
| `grant_types` | 「the client will use only the `authorization_code` Grant Type」 | 未覆盖（§6 只讲交集） | `["authorization_code"]` |
| `response_types` | 「the client will use only the `code` response type」 | 未覆盖 | `["code"]` |
| `token_endpoint_auth_method` | `client_secret_basic` | **明确 MUST NOT 套用**，改按 `none`（§5） | `none`（已实现） |

**这三行必须分开看**：只有 `token_endpoint_auth_method` 是草案**显式改写**的默认值；
`grant_types` / `response_types` 的默认值来自 RFC 7591，草案没有否定，因此沿用。

---

## 5. 已冻结的决策（本轮关闭，不再留待复审）

| # | 决策 | 出处 |
|---|---|---|
| D1 | `client_id_mismatch` **同时撤销**该 client 的全部 Grant 与 Session | §5.3 |
| D2 | Grant `epoch` 在撤销时 `+1`，重新授权再 `+1`；旧 epoch 永不复用 | §5.3 / §5.4 |
| D3 | 只按 `client_id` 匹配，不碰其它 client，不按 resource 过滤 | §5.3 |
| D4 | 撤销是两条 `UPDATE`（不删行），单事务，Grant → Session 锁序 | §5.3 |
| D5 | 审计一条事件 `mcp_client_id_mismatch`（`user_id = NULL`，两个计数） | §5.3 / §15 |
| D6 | 冷却窗口内**不使用**过期文档（fail-closed）；`INVALID` 优先于 floor | §4.1 |
| D7 | `no-cache` = 永久 STALE，每次授权都要成功抓取一次 | §4.1 |
| D8 | `no-store` 继续拒绝（terminal，不写行） | §6.2 |
| D9 | Consent GET / POST 双重复核注册；POST 用 `FOR SHARE` 锁注册行 | §8.3 |
| D10 | 授权码签发后**不追溯**回调变更；token 只复核注册存在与 `authorization_code` | §8.3 |
| D11 | 身份冲突检查：issuer / resource / 预留 peer 列表，精确字符串，DNS 之前 | §3.2 |
| D12 | `grant_types` 默认 `["authorization_code"]`；`refresh_token` 需显式声明 | §12 #4 / #10 |
| D13 | CAS 只允许写毫秒 JS `Date`；禁止 `now()`；禁止裸 `Date` 进 `sql` 模板 | §8.2 |
| D14 | 迁移 0004（扩 `revoked_reason` CHECK）**接受** | §11 |
| D15 | 代理只经 `Env.outboundProxy`；宿主机变量允许继承但必须显式解析 + 脱敏记录 | §9.2 |
| D16 | `caOverride` 仅测试注入，不是用户可控输入 | §10.2 |
| D17 | 3B **不声明** `client_id_metadata_document_supported`；声明独立提交，排在 1.3.3 之后 | §12.2 |
| D18 | 审计统一前缀 `mcp_cimd_*`；`client_id_mismatch` 只是 DB 取值，不是事件名 | §15 |
| D19 | 同意页 `clientIdentifierHost` 与 `redirectHost` 必须分开渲染；不显示远程 logo | §16 |
| D20 | 判定顺序：长度硬上限（2048）→ 查库 → 未命中才判形态 → 身份冲突 → 抓取；512 只是创建时约束 | §3 / §3.1 |

---

## 6. 被排除的方案（含本轮新增）

| 方案 | 为什么排除 |
|---|---|
| 只撤 Session、保留 Grant | F1：旧授权会被静默继承，`epoch` 不变，Desktop 上下文被复用 |
| 撤销时同时撤销 Grant 与 Session，但**不**改 epoch | 同 F1 的后半段：`(grantId, epoch)` 仍指向旧上下文 |
| 撤销时**删除** Grant 行 | 丢取证；且 `unique(user_id, client_id, resource)` 会让「重新授权」变成 INSERT，历史散成多行 |
| 冷却窗口内继续用旧 STALE | F3：把 [§6.2 MAY] 当成「可以用过期数据」 |
| 冷却窗口内直接返回「缓存未就绪」但不记录原因 | 运维无法区分「对端慢」与「我们自己在限流」 |
| 只靠 consent GET 检查（POST 不再查） | F2：刷新可能发生在 GET 与 POST 之间 |
| POST 用 `FOR UPDATE` 锁注册行 | 会让同一 client 的多个用户并发同意互相阻塞；`FOR SHARE` 已足够 |
| 用 `SKIP LOCKED` 跳过被锁的注册行 | 「跳过」等于不检查，正好绕开要防的窗口 |
| 在 `mcp_oauth_clients` 上加 `metadata_invalid` 列 | 只为一个三态判定加列；epoch 哨兵足够且可逐字符比较 |
| 用 `metadata_version BIGINT` 做 CAS | 能解决精度问题，但要加列 + 回填 + 改三处查询；场景 A 已证明现方案精确。**记录为备选**，若 3B 发现 `now()` 残留则升级 |
| 在 3B 就声明 `client_id_metadata_document_supported` | F7：循环依赖；声明是承诺，必须等真实客户端验证 |
| 同意页把 `redirectHost` 当作客户端身份 | F9：两个域名语义不同，混用等于帮钓鱼 |
| 「先判形态、再查库」 | F11：预注册 id 不是 URL，形态必然不合格 → 全部预注册客户端被拒 |
| 在 authorize 保留 512 预检查 | 同 F11：查库还没发生就已拒绝，且会把长度超过 512 的合法预注册行挡掉 |
| 展示远程 `logo_uri` | [§10.9 MUST] 的三个前置条件一个都没实现 |

---

## 7. C3c-3B 施工顺序

```
1 配置收口 (env.outboundProxy + mcpTrustedPeerIdentifiers, createCimdDeps 去默认参数)
2 TLS 语义 (ca → caOverride)
3 迁移 0004（revoked_reason 增加 client_id_mismatch）
4 cimd.ts（conflictsWithTrustedIdentifier + grant/response 默认值）
5 cimd-registry（长度 → 形态 → 身份冲突 → 缓存四态 → floor → 抓取 → 注册/CAS）
6 revokeMcpGrantsAndSessionsByClient（Grant epoch+1 → Session，单条聚合审计）
7 consent-flow（GET/POST 复核 + FOR SHARE + 失败删 auth request）
8 authorize-flow 接入（错误映射 invalid_client）
9 路由 HTML 错误页 + 审计（§15 命名）
10 token 端点（invalid_client/503 + refresh_token gating）
11 consent-page（clientIdentifierHost）
12 测试矩阵 44 条
13 文档同步
```

**能力声明不在这个列表里**——见 §8。

---

## 8. 与 1.3.3 的依赖（F7 的修正）

| 阶段 | 能力实现 | `client_id_metadata_document_supported` |
|---|---|---|
| C3c-3B | 完整 | **`false`**（字段不出现） |
| 1.3.3 | 真实客户端联调（authorize → 抓取 → 同意 → code → refresh → revoke + 故障路径） | 仍 `false` |
| 最终 | 只改 Discovery 一个字段 + 一条测试 | `true` |

理由：声明 `true` 之后客户端会真的按 CIMD 发起请求；没验证过就声明，故障会以
「用户登不上」的形式出现在客户端侧，而我们只看到一堆 4xx。独立提交也保证出问题时
可以单独 revert 而不影响接入逻辑。

---

## 9. 验收矩阵

见设计 §13，共 **44 条**，分五组：

| 组 | 条数 | 覆盖 |
|---|---:|---|
| 13.1 注册与缓存 | 15 | 预注册 / FRESH / STALE / 冷却 / INVALID / `no-cache` / `no-store` |
| 13.2 mismatch 与撤销 | 7 | Grant + Session 双撤、跨 client 隔离、多 resource、零命中、重置后 epoch、审计回滚 |
| 13.3 竞态 | 6 | GET 拒、POST 拒、GET/POST 之间刷新、grant_types 变化、并发不死锁、签发后不追溯 |
| 13.4 字段与默认值 | 6 | 身份冲突（issuer / resource）、默认 grant/response、非法 grant |
| 13.5 既有边界 + CAS | 10 | 逐字符匹配、scope/resource/PKCE、代理一致性、CAS 精度与并发、同意页字段 |

每条都写明 HTTP、DB、Grant、Session/Refresh、审计、是否可重试。

---

## 10. 范围合规

| 检查 | 结果 |
|---|---|
| 生产 authorize / token / revoke 逻辑 | **未改** |
| 抓取器接入生产链路 | **未接**（`createCimdDeps` 仍无调用方） |
| 数据库迁移 | **无新增**（0004 只是设计，未写文件） |
| 依赖 | **无变更**（`package.json` / `pnpm-lock.yaml` 未动） |
| Desktop 生产代码 | **未改** |
| `client_id_metadata_document_supported` | **未声明** |
| 既有测试断言 | **未修改** |

本轮实测只用到临时脚本（已在执行后删除），对测试库的写入限于一条临时
`mcp_oauth_clients` 行，结尾已删除。

---

## 11. 仍未解决的问题

| # | 问题 | 归属 |
|---|---|---|
| 1 | 撤销 Session / Grant 不影响已签发的 Access Token（≤15 分钟） | 1.3.2 `/mcp` 按 `sid` 回查 |
| 2 | 代理主机名的 DNS 查询没有注入点，「调用方超时返回」≠「后台查询终止」 | 沿用 C3c-2-R2 的结论，记录即可 |
| 3 | `no-cache` 客户端在 30 秒内无法二次授权 | 刻意；1.3.3 观察真实客户端是否使用 `no-cache` |
| 4 | Punycode 展示可读性 | 1.3.3 的 UI 评估 |
| 5 | 是否要「永久拉黑」反复 mismatch 的 client_id | 运营策略，本轮不做 |
| 6 | 迁移 0004 需要在维护窗口执行（改 CHECK 会短暂锁表） | 发布流程 |

---

## 12. 结论

- **F1 / F2 是两处会产生真实后果的设计缺陷**（静默继承旧授权、按已删除回调签发
  授权码），本轮已改为可执行的具体判据，并配了验收用例。
- **F5（CAS 精度）不是纸面问题**：实测已经证明 `now()` 路径必然失配、裸 `Date`
  会直接抛错。这两条现在写进了设计与 3B 的注释要求。
- 规范对齐新增 6 条，其中 §10.9 的 MUST 通过「不展示远程 logo」规避，其余 5 条
  都进了 3B 任务。
- 三个初版未决项全部关闭，没有遗留「到时候再说」的分支。
- 范围合规：未改生产逻辑、未加迁移与依赖、未声明能力、未动 Desktop。

**建议：允许进入 C3c-3B。** 3B 的第 3 步（迁移 0004）与第 6 步（撤销函数）现在
都有确定的写法，不需要再设计。
