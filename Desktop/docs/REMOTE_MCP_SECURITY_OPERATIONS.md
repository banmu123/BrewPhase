# BrewPhase Remote MCP — 安全模型 · 状态机、隐私与威胁（§4–§9）

> **分册说明**：本册从 `REMOTE_MCP_SECURITY.md` 按整章拆出，章节号沿用全系列编号。
> 本册：§4 状态机与撤销、§5 跨用户隔离、§6 数据隐私与审计（§6.5）、§7 威胁模型（**§7.1 = ST 测试矩阵唯一权威**）、§8 与 Local MCP 边界、§9 OPEN QUESTION。
> 全系列索引见 `REMOTE_MCP_INDEX.md`。基线 `feature/remote-mcp` @ `fc96654`。
> 本册由原文档整章拆出（仅搬移 + 补导航，无内容变更）；**其后叠加 Phase 0 的
> P0-1 / P0-2 修订**，逐条见 `REMOTE_MCP_INDEX.md` §7。

---

## 4. 状态机与撤销

### 4.0 五个独立状态机（禁止合并成一个 online/offline）

Phase 1.0 把「开关 / 设备 / 连接 / grant / 登录」混在在线状态里讨论，导致
「网络断开」与「用户 suspend」无法区分。Phase 1.0.1 明确拆成五个：

| # | 状态机 | 取值 | 存在哪 | 谁改 | 变更方式 |
|---|---|---|---|---|---|
| S1 | **本地远程开关** | `off` \| `on` | Desktop `local_state`（key `remote.enabled`） | 仅用户 | 同步写盘，立即生效 |
| S2 | **Cloud 设备状态** | `pending` \| `active` \| `suspended` \| `revoked` | Cloud `mcp_devices.status` | 注册/确认/暂停/撤销 | 单条 UPDATE，事务提交即生效 |
| S3 | **WSS 连接状态**（运行时，不持久化） | `idle` \| `connecting` \| `handshaking` \| `online` \| `draining` \| `backoff` \| `blocked` | Desktop 内存 + Cloud 连接表 | 网络事件 / 心跳 / 策略 | 事件驱动 |
| S4 | **MCP Grant 状态** | `active` \| `revoked` | Cloud `mcp_grants.revoked_at` | 用户在 Web 撤销 | 单条 UPDATE |
| S5 | **Desktop 账户状态** | `signed-out` \| `restoring` \| `signed-in` \| `needs-reauth` | Desktop `account/account-service.ts` | 登录/登出/401 | 现有状态机，不改 |

正交性（必须成立，否则会误判）：

| 现象 | S1 | S2 | S3 | S4 | S5 |
|---|---|---|---|---|---|
| 用户关开关 | `off` | `suspended`（异步） | `idle` | `active` | `signed-in` |
| 网络断开 | `on` | `active` | `backoff` | `active` | `signed-in` |
| 用户撤销设备 | `on` | `revoked` | `blocked` | `active` | `signed-in` |
| 用户撤销 grant | `on` | `active` | `online` | `revoked` | `signed-in` |
| 用户登出 Cloud | `on` | `active`→`suspended`（仅本设备） | `idle` | `active`（**不动**） | `signed-out` |
| 私钥解密失败 | `on`→`off` | `active`（无连接） | `blocked` | `active` | `signed-in` |
| Cloud 重启 | 不变 | 不变 | `backoff`→`online` | 不变 | 不变 |

**S1 与 S2 允许不一致**（本地关、Cloud 还没收到），**S2 与 S3 也允许不一致**
（设备 `active` 但没连接 = 离线）。**任何「用一个字段表示在线」的设计都会在这里出错。**

**状态迁移的合法边（S2）**：

```
pending   → active | revoked
active    → suspended | revoked
suspended → active | revoked
revoked   → （终态，不可恢复）
```

**没有 `active → pending`。** 重新注册总是新建一行（新 `device_id`），
不复用旧行——否则「已撤销设备复活」与审计历史都会被混淆。

### 4.1 撤销矩阵（含顺序）

**统一原则：先持久化状态、再异步清理。清理失败不回滚已持久化的撤销。**

| 触发 | ① 先做（同步、持久化） | ② 再做（异步、可失败） | Desktop 动作 | 生效依据 |
|---|---|---|---|---|
| Web 撤销 grant | `mcp_grants.revoked_at = now()`，**先停路由**，`grant_epoch + 1` | 发 `grant_update{op:"revoke"}`；撤销该 grant 的 MCP refresh（若 OQ-3 选独立表） | 移除上下文 + 清该 grant 缓存 + 在途结果不外传 + `grant_update_ack` | 上下文失效 + 请求前查 grant |
| Web 撤销设备 | `mcp_devices.status='revoked'` | 删连接表项 → 发 `bye(revoked)` → close `4003` | 删 `remote/device.json`，`linkState='blocked'`，不重连 | 连接表 + 请求前查设备状态 |
| Desktop 用户关开关 | **`local_state` 写 `off`** | `POST /mcp-devices/{id}/suspend` → 断 WSS | 立即拒绝一切 `req` | 本地判定，不依赖 Cloud |
| Desktop 用户开开关 | `local_state` 写 `on` | 连接 WSS（若未注册先走注册） | 进入 `connecting` | — |
| Desktop 登出 Cloud | 清 `account/credentials.json` | 断开**本设备**连接 + `suspend` 本设备 | `remote.disconnect()` | **不动**其它设备与 grant |
| Cloud 用户登出 | 撤销该 session 的 refresh family（现有机制） | 断开该 session 关联的连接（若有） | 收到 401 → `needs-reauth` | 现有 `/auth/*` 语义 |
| 用户删除账号 | `users.status='deleted'` | 级联删 `mcp_grants` / `mcp_devices` / 全部连接 | 删 `account/` + `remote/` | 级联 |
| 设备轮换 | 覆盖 `public_key` + `token_hash`（一条 UPDATE） | 删连接表项 → `bye(rotated)` → close `4010` | 用新凭证重连 | 旧 token 哈希已被覆盖 |
| 私钥解密失败 | 删 `remote/device.json` | 无（无法认证，不能通知 Cloud） | `off` + `blocked` + 提示重新授权 | 无连接即不可路由 |

**四条硬规则**：

1. **本地关闭先于 Cloud 通知**。`local_state` 写入是同步的、必然成功的；
   `POST suspend` 可能超时。若反过来，断网时用户点「关闭」会关不掉。
2. **撤销设备 ≠ 撤销 grant**。grant 属于 user，设备只是「一台能执行它的机器」。
   撤销设备后 grant 仍 `active`，只是没有在线设备可路由 ⇒ 全部 `DEVICE_OFFLINE`。
   这避免「换电脑后所有 AI 客户端都要重新授权」。
3. **撤销 grant ≠ 断连接，但必须清该 grant 的上下文与缓存**。设备可能还有别的
   grant 在用，所以不能断 WSS；但撤销的那一刻必须让该 grant 立即失效——
   否则「撤销后仍能回放旧结果」就是一条真实的数据泄露路径（安全 §2.7.4）。
4. **网络断开 ≠ suspend**。前者 S3 `backoff`（会重连），后者 S3 `blocked`（不重连）。
   把断网当 suspend 会导致「地铁里没信号，回家发现远程被关了」。

**「立即生效」的实现要求**：Cloud 不能只依赖 access token 过期（15 min）。
每次转发前必须查一次 `mcp_grants.revoked_at` 与 `mcp_devices.status`
（允许 ≤ 5 秒的进程内缓存；撤销操作主动清该缓存）。

### 4.2 与 Phase 1.0 的差异（修正点）

| Phase 1.0 | Phase 1.0.1 | 原因 |
|---|---|---|
| 「关开关 = 先 `POST suspend` → Cloud 清表 → 断 WSS」 | **先写本地、立即拒请求**，再尽力 suspend | 网络失败会让本地关闭失效 |
| 「登出 → Cloud 撤销该 user 全部 grant」 | 登出只暂停**本设备**，**不撤 grant** | 会误伤其它设备；违背「不要撤销不相关授权」 |
| 撤销矩阵未区分「持久化」与「清理」 | 明确 ① 持久化 → ② 异步清理 | 清理失败不能恢复授权 |

---

## 5. 跨用户隔离与身份伪造防护

### 5.1 越权路径逐条封堵

| 攻击 | 为什么不可行 |
|---|---|
| 改请求体里的 `user_id` | 服务端**不读**该字段；`user_id` 只来自 JWT `sub` |
| 改 `device_id` 指向别人的设备 | 路由用 `(user_id, device_id)` 复合键；`user_id` 不匹配直接 404 而非 403（不泄露设备是否存在） |
| 用别人的 access token | JWT 签名校验失败；`aud` 不匹配；`grant_id` 不属于该 `sub` |
| 用自己账号的 token 读别人数据 | Desktop 端所有查询都以本机 SQLite 为界，没有「按 user_id 查」的入口——**Desktop 库本身就是单用户库**，这是最强的隔离 |
| 伪造 `connection_id` | 握手时 Cloud 生成，与 `(user_id, device_id)` 绑定；客户端无法指定；后续帧**不携带**它（属于连接上下文，见协议 §4.4） |
| 复用 Local MCP token 走远程 | Remote 路径不认 `bp_mcp_` 前缀，两套校验器物理分离；且 Remote 的 context 类型里没有 `McpClientService` |
| 用 Desktop 登录 token 打 `/mcp` | 两者 `aud` 不同（B6）：`brewphase-desktop` vs `MCP_RESOURCE` |

### 5.2 为什么「Desktop 是单用户库」是关键前提

Remote MCP 不需要在 SQL 层加 `where user_id = ?`——因为 Desktop 的 SQLite 里
只有一个人的数据。**任何试图给远程请求传 `user_id` 并据此过滤的设计都是错的**，
它会让「多用户库」这个错误假设渗进业务层。

正确表述：**隔离发生在 Cloud（谁能连到哪台设备），不在 SQL（查谁的行）。**

### 5.3 重放防护

| 面 | 机制 |
|---|---|
| `/authorize` | 双 State（Client State + Provider State，均只存哈希）；用后即删 |
| `/token` | 授权码 60s + 一次性 + PKCE S256 + `redirect_uri` 完全匹配；失败即焚码 |
| `/mcp`（HTTP） | access token 15 min + `aud` 绑定 + 每请求回查 `mcp_grants`。**`jti` 是 Token 级标识，不做请求级去重、不拒绝重复出现**（同一 token 在 TTL 内多次 `tools/call` 是合法常态）；仅当同一 `jti` 在 60 s 内来自两个不同来源指纹时**告警 + 审计，仍不拒绝**（安全 §3.2.1、协议 §15.2） |
| WSS 请求帧 | **`delivery_id`（`id`）重复到达 → 回放缓存结果**（键 = `grant_ctx` + `delivery_id`）；缓存 256 条 / 8 MiB / 60 s，**断线即清**（Cloud 不在重连后重发，见协议 §8） |
| 设备握手 | 每次握手带 `nonce` + `ts`（±120s）+ Ed25519 签名；Cloud 用 `NonceStore`（复用 `sync/auth.ts` 的有界实现）判重，**check-and-record 必须原子**（两次调用之间不得 await） |

> **为什么 `/mcp` 不加 per-request nonce（Phase 0 / P0-2 定稿）**：MCP Client 会在一个
> token 生命周期内发起任意多次工具调用，任何「同 `jti` 第二次即拒」的规则都会打死
> 正常客户端（等于把正常调用当攻击）；而 per-request nonce 需要 Client 侧配合，
> 标准 MCP Client 不发送。v1 的 8 个工具全是只读，重放的后果是「再读一次同样的数据」，
> 已由 TLS + 15 min TTL + `aud` 绑定 + 逐请求 grant/scope 校验压到可接受。
> **写工具开放前必须重评**——见 OQ-16（DPoP / 发送者约束）。

> **Phase 1.0.1 修正**：Phase 1.0 的 `idem = sha256(tool+args)` 不能作为去重键——
> 用户两次独立问「上周喝了什么」参数完全相同，却是两个独立意图，命中缓存会返回
> 陈旧结果（且 `has_more` 可能已变化）。去重只认 **投递标识**，语义见协议 §8。

---

## 6. 数据隐私

### 6.1 Cloud 能看到什么

| 数据 | Cloud 是否可见 |
|---|---|
| 用户身份（provider subject / 邮箱） | ✅ 已有 |
| 设备（名称、平台、在线状态） | ✅ 新增 |
| 授权（哪个 client 拿到哪些 scope） | ✅ 新增 |
| **调用了哪个 tool** | ✅ 仅 tool 名 |
| **tool 参数**（搜索词、record_id） | ⚠️ **第一版不可避免**：Gateway 必须解析 args 才能转发 |
| **tool 结果**（记录正文、品鉴笔记） | ✅ 可见（在转发路径上），但**不落库、不落日志** |
| 完整业务库 | ❌ 不存在于 Cloud |

**必须诚实记录这一条**：Remote MCP 的流量经过 Cloud，Cloud 在内存里能看到
参数与结果。设计能做的是「不持久化、不进日志」，不能做「看不到」。
可选增强（Phase 1.5）：端到端加密（Desktop 生成会话密钥，Cloud 只转发密文），
但会让 Cloud 无法做结果级过滤，需要单独权衡。

### 6.2 日志纪律

在现有 `cloud/src/logger.ts` 的 `SENSITIVE_KEY_PATTERN` 基础上，MCP 事件必须额外：

- 只记 `tool`、`status`、`duration_ms`、`error_code`、`device_id`、`grant_id`、`jti` **前 8 位**
  （`jti` 是 **Token 级**标识，只用于把同一 token 的多次调用串起来，不承担请求级去重——安全 §3.2.1）
- **禁止**记 `params` / `result` / `text` / `note` / `body` / `title`
- `redact()` 的 key 正则加入：`args|params|result|content|note|body|title|search|url`
- 请求体永不进日志（现有 HTTP 日志已只记 method/path/status/duration，
  `cloud/src/app.ts` 的中间件是正确范例，照抄）

### 6.3 用户可见性

用户必须能在界面里看到，且能一键断：

1. 哪些 MCP Client 被授权，各自哪些 scope，最后一次调用时间
2. 哪些设备在线，最后活跃时间
3. 最近 N 次远程调用（tool 名 + 时间 + 成功/失败）——数据来自**本地**
   `mcp_operation_log`，不依赖 Cloud
4. 「立即断开全部远程访问」按钮

### 6.4 默认值

| 项 | 默认 |
|---|---|
| 远程访问开关 | **关** |
| 远程 scope | 空（授权时必须用户勾选） |
| 设备注册 | 需用户在场确认码；`claim_secret` 一次有效 |
| 数据留存 | 无（Cloud 不存业务数据） |
| Cloud 日志留存 | 30 天（仅 tool 名、状态、耗时） |
| Desktop 审计留存 | 不自动清理（沿用现有 `mcp_operation_log` 行为） |

### 6.5 审计方案（Phase 1.0.1 定稿）

Phase 1.0 的四份文档在这里互相矛盾：PHASES 的 A10 要求 `channel='remote'`、
1.1.2 又禁止迁移、1.1.6 又拿 `channel` 验收（**均为 1.0 编号**）。
现按真实 schema 定案。

#### 6.5.1 事实基础

```
-- migrations.ts 的 MCP_ACCESS_SQL（实际建表语句）
CREATE TABLE IF NOT EXISTS mcp_operation_log (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,          -- 无 REFERENCES、无 CHECK、无长度限制
  tool_name TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  success INTEGER NOT NULL,
  error_code TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX mcp_oplog_client_idx ON mcp_operation_log (client_id, created_at);
```

结论：`client_id` 是**自由文本**，写入 `remote:<device_id>` 完全合法，且该值
落在索引首列上（按前缀查询虽不走范围扫描，但审计读取频率极低）。

#### 6.5.2 决策：1.1A/1.1B 采用**方案 A**（不改库结构）

| 方案 | 判定 | 理由 |
|---|---|---|
| **A. 不改结构，`client_id = 'remote:<device_id>'`** | ✅ **采用** | schema 无约束；1.1A/1.1B 零迁移；`remote:` 前缀使 Local/Remote 可区分且不会与任何 `mcp_clients.id`（uuid）碰撞 |
| B. 1.1 就加 `channel` 列 | ❌ 推迟到 1.2 | 加列要动 Desktop migration 14；而 1.2 本来就要为设备/grant 做迁移，合并做一次更省风险 |

**前缀格式（固定，不可改写）**：

```
client_id := "remote:" + mcp_devices.id      // 例：remote:0b7c9e2a-…
```

- 解析：`startsWith('remote:')` → 取 `slice(7)` 为 device_id。
- 不改写为 `remote/<id>`、`device:<id>` 等变体——验收测试按此字符串断言。

#### 6.5.3 字段映射（方案 A 下的取舍）

| 想记的 | 方案 A 能否记 | 处理 |
|---|---|---|
| `device_id` | ✅ 编码在 `client_id` 前缀 | — |
| `grant_id` | ❌ 无列 | **只进 Desktop stderr 日志**（`[remote] tool=… grant=…`），不进库。P0-1 后审计仍需能区分 Client，但 1.1 零迁移约束优先——**已知缺口**，1.2 加列（见下） |
| `delivery_id`（`request_id`） | ❌ 无列 | 同上；但 `entity_id` 仍留给业务实体，不复用 |
| `tool_name` / `success` / `error_code` / `created_at` | ✅ | 原样 |
| `entity_type` / `entity_id` | ✅ | 只读工具多数为空，`get_record` 等填实体 id |
| `idempotency_key` | ⚠️ 不用于远程 | 远程无持久幂等（协议 §8），该列写 `NULL` |

**Phase 1.2 迁移（migration 14）**将加四列：
`channel TEXT NOT NULL DEFAULT 'local'`、`device_id TEXT`、`grant_id TEXT`、`request_id TEXT`。
届时 `client_id` 恢复写真实主体（`mcp_clients.id` 或 `mcp_devices.id`），
前缀方案退役——**但历史行的 `remote:` 前缀仍然可解析**，不需要回填。
`grant_id` 列是 P0-1「同一设备多个 MCP Client 可区分」在审计面的落地；
在它落地之前，审计只能回答「哪台设备」，stderr 才能回答「哪个 Client」。

#### 6.5.4 写入时机与策略

**判据：审计记录的是「一次针对具体工具的数据读取尝试」**，
即「已经进入 `executeTool`」的调用。被拒绝受理的不算读取，因此不入表。

| 场景 | Local（现状，不变） | Remote（新增） |
|---|---|---|
| 只读工具成功 | **不记** | **记**（`success=1`） |
| 只读工具失败（scope 不足 / 参数非法 / 业务错误） | **不记** | **记**（`error_code`） |
| 写工具成功/失败 | 记 | 第一版无写工具 |
| **受理前拒绝**：开关关闭 / 帧超限 / 未知 `type` / deadline 已过 / tool 不在白名单 | — | **不记库**，只记 stderr + `remote:diagnose` 计数器 |

**为什么「受理前拒绝」不审计**（这是刻意的，不是遗漏）：

1. 三者都**没有发生读取**——开关关闭时一个字节的业务数据都没碰。
   把它们记成"一次访问"，会让审计表里充满「没读到任何东西」的行。
2. **写放大**：`REMOTE_DISABLED` 期间 Cloud 若仍在重试，每帧写一行会
   在不该有写入的时刻制造写入（甚至可能正是磁盘满的诱因）。
3. 它们的可观测性另有出口：`remote:diagnose` 暴露
   `rejectedBeforeAdmission: { disabled, tooLarge, expired, notAllowed }` 四个计数，
   排查时看得到，但不污染审计表。

**由此得到的可检验承诺**：审计表里每一行都对应一次**真实的工具读取尝试**。
这也是「不承诺审计绝对完整」（§6.5.10）之外的另一半诚实边界。

**Remote 只读也记**是刻意与 Local 不同的：远程访问的每一次数据读取都必须留痕，
否则「谁在什么时候读了我的记录」无从回答。Local 保持原状以免给现有库凭空涨量。

> 注意：上表的 `success` 列只表达 **S-B（业务执行）**，不表达审计本身是否写成。
> 三者的分离见 §6.5.5——把「审计写失败」写进 `success=false` 会让统计里出现
> 一批「业务成功但被记成失败」的行，反而污染审计。

#### 6.5.5 审计写入失败：三段状态必须分离（Phase 1.0.2 定稿）

**问题（Phase 1.0.1 的表述不充分）**：原文只说「审计写失败不把查询报成失败」，
但没有说明「那审计到底算不算数」，也没有禁止「声称审计完整」。
这会让实现者与使用者都误以为「每次远程读取都有记录」。

**决策：把三件事拆成三个独立状态，任何一处都不得合并成一个 `success`。**

| 状态 | 含义 | 存哪 | 谁能看到 | 失败时 `res` 长什么样 |
|---|---|---|---|---|
| **S-A 准入是否通过** | 开关 / 帧大小 / deadline / 白名单 / scope 全过 | 不持久化 | Cloud + AI（通过 `res.error.code`） | `ok:false` + 具体错误码 |
| **S-B 业务是否执行成功** | `executeTool` 是否返回数据 | `mcp_operation_log.success` + `res.ok` | 本地 + Cloud | `ok:false` + 业务错误码 |
| **S-C 审计是否写入成功** | 那一行 `mcp_operation_log` 有没有落库 | 内存计数器（见下） | **仅本地**（设置页 + diagnose） | **不影响 `res`** |

**硬规则**：

1. `res.ok` 只由 S-A 与 S-B 决定。**S-C 失败时 `res` 保持 `ok:true`**——
   否则磁盘故障会被伪装成业务错误，AI 会去改参数重试，而重试永远失败。
2. S-C 的状态**不通过协议帧回传**。Cloud 不需要知道用户磁盘的健康状况；
   把它放进 `res` 只会多一条泄露本地状态的通道。
3. 三者在同一次调用里可以出现「S-A 通过 + S-B 成功 + S-C 失败」的组合，
   这是**正常且必须被支持**的组合，不是异常路径。

#### 6.5.6 第一版审计策略：best-effort（已确定决策）

| 项 | 规则 |
|---|---|
| 承诺 | 每次远程工具调用都**尝试**写入一条审计记录 |
| 写入时机 | `executeTool` 返回后（成功或失败），`ctx.audit` 由 Remote 侧注入 |
| 成功 | 正常返回结果；计数器 `consecutiveFailures` 归零 |
| 失败 | 结果**仍正常返回**；`console.error('[remote] audit write failed', err)`；计数器递增 |
| 可观测 | 内存维护 `{ consecutiveFailures, lastFailureAt, totalFailures, lastErrorKind }`，通过 `remote:status` / `remote:diagnose` 暴露 |
| **计数器生命周期** | **纯进程内状态**：随主进程启动归零，**不落盘、不进 SQLite、不跨重启累计**（见下方说明） |
| 界面 | 设置页「远程访问」区在 `consecutiveFailures > 0` 时显示**告警条**：「最近 N 次远程访问未能写入审计记录」+ 最近失败时间 + 「重试写入」按钮（可选） |
| 恢复 | 下一次写入成功后 `consecutiveFailures = 0`；`lastFailureAt` **保留**（仅限本次进程内） |
| 熔断 | 第一版**不熔断**（见 §6.5.7） |

**计数器是进程内状态（Phase 1.0.3 明确）**：

| 事实 | 后果 | 允许的说法 | **禁止的说法** |
|---|---|---|---|
| `consecutiveFailures` / `totalFailures` / `lastFailureAt` 只存在主进程内存 | 应用重启后全部归零 | 「本次运行以来未出现审计写入失败」 | ❌「审计已恢复正常」「历史缺口已补齐」「从未失败过」 |
| 重启后计数为 0 **不表示**之前缺的记录被补写 | 缺口在 `mcp_operation_log` 里永久缺失 | 「重启会清空计数器；此前未写成的记录不会补写」 | ❌「重启后计数归零，说明审计链路已修复」 |

**UI 层同样受此约束**：设置页不得把「重启后告警条消失」呈现为「问题已解决」——
告警条消失只能说明**本次进程内**还没有失败。这是 best-effort 的诚实边界，
也是 §6.5.10 承诺边界的一部分。

**明确不得声称**：

- ❌ 不得在文档、UI 或日志里说「远程访问的每一次读取都有审计记录」。
- ✅ 只能说「每次远程访问都会尝试写入本地审计；失败会计数并在界面告警」。

**为什么不做成准入条件（硬失败）**：审计是事后追责，不是准入控制。
把它变成硬失败会让「磁盘满 / SQLite 临时锁」升级为「远程功能全挂」，
而用户此时最需要的恰恰是「先能查，再修磁盘」。代价是承认存在
「查到了但没记上」的窗口——这个窗口**必须靠界面告知用户**，而不是藏在文档里。

#### 6.5.7 熔断策略：保留为 `OQ-5`（未定稿）

第一版**不实现熔断**。Phase 1.4 评估时至少需要定清以下条件：

| # | 待定条件 | 为什么需要单独定 |
|---|---|---|
| 1 | 连续失败次数阈值 | 太敏感（1 次就断）会让瞬时锁误伤；太钝（100 次）失去意义 |
| 2 | 失败持续时间 | 单次磁盘满 vs 长期只读挂载，处置不同 |
| 3 | 磁盘空间阈值 | 与「SQLite 写入异常」是两种不同原因，可能需要不同响应 |
| 4 | 可识别的错误类型 | `SQLITE_FULL` / `SQLITE_READONLY` / `SQLITE_BUSY` / 其他——只有前两种值得熔断 |
| 5 | 恢复后的状态 | 磁盘腾出空间后是自动恢复，还是必须用户手动重开？ |
| 6 | 是否要求用户重新开启远程访问 | 熔断后若静默自动恢复，等于没熔断；若要求手动，用户可能长时间以为「AI 坏了」 |

`OQ-5` 状态：**OPEN QUESTION，未定稿**。本节只登记待评估条件，不预设结论。
**倾向**（非决策）：只有在可识别为 `SQLITE_FULL` / `SQLITE_READONLY` 且连续失败
≥ 5 次时，暂停远程并在界面要求用户处理；其余错误只告警。

#### 6.5.8 分期范围

| 阶段 | 审计失败相关范围 | 明确不做 |
|---|---|---|
| **Phase 1.1B** | 计数器 + stderr 告警 + 设置页告警条 + `remote:diagnose` 输出 | 熔断、自动关闭开关、自动重试写入、**计数器持久化** |
| **Phase 1.4** | 评估 §6.5.7 的 6 个条件；若决定熔断，实现「暂停 + 用户手动重开」 | E2E 加密、写入工具 |

> **1.1B 不持久化审计计数**是刻意的：一旦落盘，就会引出「重启后要不要恢复告警条」
> 「跨版本怎么迁移计数」等一串问题，而它并不提升安全性——真正的记录是
> `mcp_operation_log` 里的行，计数器只是**当下**的可观测性。

#### 6.5.9 禁止进入任何日志/审计的字段

`arguments`（全部）、`data` / `structuredContent`（全部）、`note`、`title`、
`body`、`summary`、搜索关键词、URL、文件名、`device_token`、`claim_secret`、
`access token`、Ed25519 私钥。

验收方式：跑一次带独特哨兵字符串（如 `SENTINEL-7f3a9c`）的 `search_records`，
再对 `mcp_operation_log` 全表与 Cloud 日志文件 grep 该字符串，必须 0 命中。

#### 6.5.10 审计可靠性的安全承诺边界（必须写进 UI 文案）

| 承诺级别 | 内容 | 是否声称 |
|---|---|---|
| ✅ 强承诺 | 「每次远程调用都会**尝试**写入本地审计」 | 是 |
| ✅ 强承诺 | 「审计写入失败会计数，并在设置页明确告警」 | 是 |
| ✅ 强承诺 | 「审计记录不含参数、结果、搜索词或任何正文」 | 是 |
| ❌ 不承诺 | 「每次远程读取都有审计记录」 | **否** |
| ❌ 不承诺 | 「审计记录不可篡改」 | **否**（本地 SQLite，用户有完全控制权） |
| ❌ 不承诺 | 「审计崩溃后不丢失」 | **否**（无 WAL 保证的跨进程语义） |

**最后两条尤其重要**：审计是给**用户自己**看的追踪，不是给第三方取证用的
防篡改日志。任何对外表述（README、App 描述、隐私政策）都不得暗示后者。
若未来需要「可对外举证」的审计，那是另一个功能（需要签名链 + 外部锚定），
不在 Remote MCP 第一版范围内。

---

## 7. 威胁模型

| # | 威胁 | 前提 | 影响 | 缓解 | 残余风险 |
|---|---|---|---|---|---|
| T1 | 恶意 MCP Client 骗取授权 | 用户点了「允许」 | 读取 4 个 scope 内的数据 | 授权页逐项列 scope + 明确「这会读取你的…」；可随时撤销 | 用户不看就点 |
| T2 | 授权码拦截 | 中间人 | 换取会话 | 全链路 TLS + PKCE + 60s + 一次性 | TLS 被破（超出范围） |
| T3 | access token 泄露 | 日志/内存 dump | 15 分钟内可读数据 | 短 exp + `aud` 绑定 + 不落库 | 15 分钟窗口 |
| T4 | device_token 泄露 | 本机文件被读 | 冒充设备上线 | 私钥 safeStorage 加密；token 只存哈希；可撤销 | 本机已被完全控制（超出范围） |
| T5 | Cloud 数据库泄露 | 拖库 | 拿到身份与设备元数据 | 无业务数据；token 只存哈希；公钥本身不是秘密 | 用户身份关联泄露 |
| T6 | 内鬼 / 运维看数据 | 有 Cloud 主机权限 | 流量里的记录正文 | 不落库不落日志；E2E 加密（Phase 1.5 可选） | 内存可见 |
| T7 | 跨用户越权 | 改 id | 读别人数据 | `user_id` 不来自请求体；`(user_id, device_id)` 复合路由；Desktop 单用户库 | — |
| T8 | 重放请求 | 截获一次请求 | 重复执行 | `jti` 告警 + `delivery_id` 回放缓存（256/60s，断线即清） | 60 秒内的首次重放可能被执行一次（只读，无副作用） |
| T9 | 设备被撤销后仍能收请求 | 撤销时连接未清 | 越权 | **先持久化 `status='revoked'`**，再删路由 + 断连；转发前查状态 ⇒ 清理失败也不会放行 | 正在转发途中的单条请求 |
| T9b | 本地已关闭但 Cloud 仍认为在线 | `suspend` 请求失败 | 继续路由 | **本地开关是准入判定**（收到 `req` 直接拒），Cloud 状态只影响「会不会发过来」 | 一条已发出的请求会收到 `REMOTE_DISABLED` |
| T9c | 撤销 grant 误伤其它 client | 撤销实现按 user 批量 | 用户其它 AI 客户端失效 | 按 `grant_id` 精确撤销；只有删账号才级联 | — |
| T10 | 伪造 Host 头 / DNS rebinding | 用户在浏览器访问恶意页 | 打到 Gateway | `hostHeaderValidationResponse` + `originValidationResponse`（SDK 已提供） | — |
| T11 | 资源耗尽 | 大量并发请求 | Gateway/Desktop 被打满 | 每 user 并发上限（4）+ 每设备并发上限（2）+ 请求体上限（256 KB）+ 严格 `limit` 上限 | — |
| T12 | 工具白名单漂移 | Cloud 与 Desktop 版本不同 | 越权调用 | 两端各存白名单 + 合同测试断言一致；Desktop 拒绝时返回 `TOOL_NOT_ALLOWED`（不是断连） | — |
| T13 | 本地开关关闭后仍可访问 | 只断连不撤授权 | 重连即恢复 | 关开关先写 `local_state`；重开需用户再次确认；`suspended` 只是异步跟随 | — |
| T14 | 协议降级 | 中间人/旧客户端 | 绕过新校验 | 版本区间协商，无交集即 close `4002`，不静默降级 | — |
| T15 | 伪造设备领取凭证 | 已持有用户 Bearer | 接管他人设备 | 领取需 `claim_secret`（300s、一次、只出现一次）；条件 UPDATE 防重复 | 用户 Bearer + 本机文件同时被控（超出范围） |
| T16 | 轮换后旧连接继续用 | 轮换不清连接 | 旧会话语义越权 | 轮换 = 覆盖公钥与 token → 标记 `rotating` → 删路由 → close `4010` | 单条在途请求 |
| T17 | 用户切换后继承设备绑定 | A 登出、B 登录，device.json 未校验 | B 看到 A 的设备与授权状态；审计污染 | `boundUserId` 比对，不匹配强制 `blocked` + 要求解绑（§2.6.4） | 用户主动解绑前无法使用远程（可接受） |
| T18 | 审计写失败被当成业务失败 | 三段状态合并 | AI 误判可重试；审计统计被污染 | §6.5.5 三段分离；`res.ok` 不含 S-C | 「查到但没记上」窗口（UI 告警） |
| T19 | `delivery_id` 被替换请求内容 | 只在 Cloud 内生成 | 回放错误结果给新请求 | `request_hash` 校验，不一致 → `PROTOCOL_VIOLATION`（协议 §8.2） | — |

### 7.1 安全集成测试矩阵（Phase 1.0.2 新增，必须进各阶段验收）

**这不是"建议加的测试"，是发布阻断项的清单。** 每项都必须有明确阶段、位置、
预期结果与阻断级别；实现时按此表建用例，缺项不得宣称阶段完成。

| # | 测试 | 阶段 | 位置 | 预期结果 | 发布阻断 |
|---|---|---|---|---|---|
| **ST-1** | 用户 A 的 MCP Grant + 用户 B 的设备 | 1.2 | Cloud | 转发前查 `grant.user_id ≠ device.user_id` → `USER_MISMATCH`，**不转发**到设备 | ✅ 是 |
| **ST-2** | 设备 A 的 `device_token` + 设备 B 的签名 | 1.2 | Cloud | 握手第 6 步用 A 的公钥验 B 的签名失败 → close `4001`，不建立连接 | ✅ 是 |
| **ST-3** | 设备轮换后，旧连接发送新 `req` | 1.2 | Cloud | ② 之后该 `connection_id` 已标 `rotating` → 回 `DEVICE_UNAUTHORIZED`，**不进 Desktop** | ✅ 是 |
| **ST-4** | 用户 A 登出后用户 B 登录 | 1.1B | Desktop | `device.boundUserId ≠ uB` → `remote.enabled=false`、`linkState='blocked'`、零出站连接；界面显示解绑提示 | ✅ 是 |
| **ST-5** | 远程开关关闭时同时到达 `req` | 1.1B | Desktop | 不进入 `executeTool`（service 调用次数断言 0）→ `REMOTE_DISABLED`；**不写审计**（受理前拒绝，§6.5.4）；`rejectedBeforeAdmission.disabled` +1 | ✅ 是 |
| **ST-6** | 同一 `delivery_id` + 不同 `request_hash` | 1.1B | Desktop | `PROTOCOL_VIOLATION`，不执行、不污染缓存、记 stderr；原缓存条目**不被覆盖** | ✅ 是 |
| **ST-7** | 同一 `delivery_id` + 同一 `request_hash` 并发到达 | 1.1B | Desktop | 只执行一次（`exec_id` 计数 = 1），两次都收到同一结果（第二次 `meta.cached=true`） | ✅ 是 |
| **ST-8** | 不同 `delivery_id` 相同 tool/arguments | 1.1B | Desktop | 独立执行（`exec_id` 计数 = 2）；**第二次能看到第一次之后新增的数据**（构造：两次调用之间插一行记录） | ✅ 是 |
| **ST-9** | 系统时间前后调整 | 1.1B | Desktop | 用假 clock 把 `Date.now()` 前跳 1 小时 / 后跳 1 小时；本地 deadline 仍按 monotonic 到期（在 15s 内超时），不被延长或提前 | ✅ 是 |
| **ST-10** | 审计数据库写入失败 | 1.1B | Desktop | 注入 `writeAudit` 抛错：`res.ok=true` 且结果正确；`consecutiveFailures=1`；`remote:status` 暴露；stderr 有告警；**下一行审计成功即归零** | ✅ 是 |
| **ST-11** | Cloud 重启后 Desktop 自动恢复连接 | 1.2 | Integration | 退避重连成功；**不重放**任何旧 `delivery_id`（缓存已清空）；Cloud 侧旧在途请求已以 `DEVICE_OFFLINE` 结束 | ✅ 是 |
| **ST-12** | 设备 Token 被撤销后继续握手 | 1.2 | Cloud | 第 3 步 `status='revoked'` → close `4003`；且路由表无残留（`lookup` 为 null） | ✅ 是 |

**补充五项（与 §2.6 生命周期、§8.5 竞态直接相关）**：

| # | 测试 | 阶段 | 位置 | 预期结果 | 发布阻断 |
|---|---|---|---|---|---|
| **ST-13** | 登出后 Cloud 侧仍持有旧 connection | 1.1B + 1.2 | Integration | 登出 → 断连 + `suspend`；Cloud 连接表无该项；后续 `tools/call` 返回 `DEVICE_OFFLINE`（不是超时） | ✅ 是 |
| **ST-14** | 「忘记设备」时 Cloud 不可达 | 1.1B | Desktop | 本地仍完成 ①②④；`device.json` 已删；界面提示「云端记录可能仍在」；**不无限重试** | ✅ 是 |
| **ST-15** | 同一用户重登（`boundUserId` 匹配） | 1.1B | Desktop | 允许 resume，**不要求**重新输入确认码；`enabled` 仍为 `false`（需用户手动开） | ❌ 否（体验项） |
| **ST-16** | 同一 `delivery_id` 执行中关闭开关，随后重复投递到达 | 1.1B | Desktop | 重投**重新走完整准入**，第 1 步即拒 → `REMOTE_DISABLED`；**不返回执行中请求的结果、不命中缓存**；`executeTool` 调用次数仍为 1（未因重投再执行）；缓存已在关闭时清空 | ✅ 是 |
| **ST-17** | 用户切换后崩溃恢复（A 绑定 → 切到 B → 关闭开关 → 主进程异常退出 → 重启） | 1.1B | Desktop | 主进程启动即校验 `boundUserId ≠ 当前账户` 且 `enabled=false` → **零出站连接、`linkState='blocked'`**；校验发生在 `RemoteService` 初始化，**不依赖渲染层加载或用户进入设置页** | ✅ 是 |

**Phase 0（P0-1 / P0-2）新增九项**：

| # | 测试 | 阶段 | 位置 | 预期结果 | 发布阻断 |
|---|---|---|---|---|---|
| **ST-18** | `req` 的 `grant_ctx` 缺失 / 未知 / 已过期 | 1.1B | Desktop | `GRANT_CONTEXT_INVALID`；**不进入 `executeTool`、不查缓存**（service 调用次数 0） | ✅ 是 |
| **ST-19** | 上下文 `bound_user_id` ≠ 本机 `boundUserId` | 1.1B | Desktop | `USER_MISMATCH`；清空全部上下文；`linkState='blocked'`；零出站连接 | ✅ 是 |
| **ST-20** | 同设备两个 grant、scope 不同：A 无 `coffee:read`，B 有 | 1.1B | Desktop | A 的 `list_beans` → `SCOPE_DENIED`；B 的同一调用成功；**两次都不得命中对方的缓存** | ✅ 是 |
| **ST-21** | 撤销 grant A 后，A 的旧 `delivery_id` 重投 | 1.1B | Desktop | 上下文已移除 → `GRANT_CONTEXT_INVALID`；**撤销前的缓存不得回放**；同设备 grant B 的缓存与调用不受影响 | ✅ 是 |
| **ST-22** | 撤销 grant A 时 A 有执行中请求 | 1.1B | Desktop | handler 完成后**不回传数据**，回 `GRANT_REVOKED`，不写缓存；B 不受影响 | ✅ 是 |
| **ST-23** | 重复 / 乱序 / `epoch` 回退的 `grant_update` | 1.1B | Desktop | 丢弃且状态不变（幂等）；仅 `epoch > 当前` 生效 | ✅ 是 |
| **ST-24** | 重连后 `hello_ok.grants` 全量替换 | 1.1B | Desktop | 不在快照中的旧 `grant_ctx` 立即失效；其缓存同步清除 | ✅ 是 |
| **ST-25** | 同一 access token 连续 10 次 `tools/call`（同 `jti`） | 1.3 | Cloud | **全部成功**；不得因 `jti` 重复被拒（P0-2 回归门禁） | ✅ 是 |
| **ST-26** | 同一 token 并发 2 个 `tools/call`，来源指纹不同 | 1.3 | Cloud | 两个调用均成功；`jti` 重复只产生告警/审计，**不产生 4xx** | ✅ 是（告警不阻断） |

**ST-18 ~ ST-24 的分工**：18 测「引用无效」，19 测「跨用户」，20 测「多 Client
scope 隔离」，21 测「撤销后缓存」，22 测「撤销时在途」，23 测「版本幂等」，
24 测「重连快照」。它们共同回答 P0-1 的核心问题——**Desktop 能否在请求级别
识别并约束具体 Grant**。ST-25/26 是 P0-2 的回归门禁：任何「按 `jti` 去重」的
实现都会让它们失败。

**ST-16 与 ST-5 的区别**：ST-5 测「关闭时**新**请求到达」；ST-16 测「**已有执行中请求**
+ 同 `delivery_id` 重投」，它验证的是「缓存命中不能早于准入」（协议 §8.5 R1）。
两条都过，才能说「缓存不构成越权路径」。

**ST-17 的关键断言是「时机」而不是「结果」**：结果（不连接）容易做到，难的是
**不依赖 UI**。测试必须在「不创建 BrowserWindow」的 headless 主进程里跑，
否则它只能证明「用户打开设置页后才安全」——那已经太晚了。

**矩阵与阶段的关系**：1.1A 不含任何一项（它不接远程请求）——这是拆分 1.1A/1.1B
的直接理由之一。1.1B 必须通过 **ST-4 ~ ST-10、ST-13 ~ ST-24**；1.2 必须通过
ST-1 ~ ST-3、ST-11 ~ ST-12；1.3 必须通过 **ST-25 ~ ST-26**。
**任一 ✅ 项未通过，不得进入下一阶段。**

**阻断级别只有两档，没有第三档**：`✅ 是` = 未通过不得发布、不得进入下一阶段；
`❌ 否` = 允许带缺陷发布，但必须登记为已知问题。**`❌` 只能用于体验项**
（当前仅 ST-15），任何涉及越权、数据外泄、审计缺失的用例都必须是 `✅`。

---

## 8. 与 Local MCP 的边界（防回归）

| 要求 | 落地方式 |
|---|---|
| Local 的协议/认证/白名单/幂等逐字不变 | `routeBridgeRequest` 只把「scope+Zod+handler+错误映射」交给 `executeTool`，其余顺序与错误码不动 |
| Remote 不走 socket 绕回 | `src/main/remote/**` **禁止** import `mcp-bridge/**`（结构测试断言） |
| Local token 不出本机 | `src/main/remote/**` 不 import `application/authorization/permission-service.ts`；且 `ToolServices` 类型里没有 `clients` |
| Local 的工具列表不变 | 远程白名单是**新常量** `REMOTE_TOOLS`（8 个），不修改 `TOOL_DEFINITIONS` |
| Local 审计语义不变 | Local 仍「只记写工具」；Remote 由 `ctx.audit` 注入，只读也记 |
| Local 的单测基线不变 | 现有 **949 条**必须全绿（抽取前后逐条等价） |
| Windows Named Pipe 行为不变 | `bridge-contract.ts` / `bridge-server.ts` 零改动 |

**唯一允许触碰的既有代码（Phase 1.1A）**：把 `HANDLERS`、`createShape` 的调用关系
抽到 `src/main/application/mcp-tools/`，`request-router.ts` 改为调用 `executeTool`。
**不新增 `channel` 参数到 `routeBridgeRequest`**（Phase 1.0 的设想）——channel 由
`executeTool` 的 `ctx` 传入，`routeBridgeRequest` 的签名保持不变，减少回归面。

---

## 9. 待确认 / `OPEN QUESTION`

**编号与完整汇总以 `REMOTE_MCP_ARCHITECTURE_DESIGN.md` §7.3 为唯一权威**（共 **23** 项：
`OQ-1`~`OQ-16` 共 16 项 + `OQ-A`~`OQ-F` 共 7 项，字母组的 E 拆为 `OQ-E1`/`OQ-E2`）。
本节只列与安全直接相关的几项，说明其安全含义：

| # | 问题 | 为何无法确定 | 谁决策 | 影响 | 阻塞 1.1 |
|---|---|---|---|---|---|
| OQ-5 | 审计连续失败是否熔断远程开关 | 产品权衡 | 用户 | 1.4 | 否 |
| OQ-6 | 是否需要 E2E 加密（Cloud 只见密文） | 产品权衡；会影响 Cloud 侧过滤能力 | 用户 | 1.5 | 否 |
| OQ-7 | DCR 是否必需 | ChatGPT 行为 | 真实联调 | 1.3 | 否 |
| OQ-8 | 设备确认码是否必须走 Web | 产品流程；取决于是否有 Web 设置页 | 用户 | 1.2 | 否（默认 Web） |
| OQ-9 | 多设备路由策略 | 产品决策 | 用户 | 1.2（默认单连接顶替）、1.4 | 否 |
| OQ-10 | Cloud 审计/日志留存 30 天是否满足合规 | 合规要求外部 | 用户 | 1.2 | 否 |
| OQ-3 | MCP 会话归属（`session_kind` vs `mcp_sessions`） | 取决于是否复用 rotation | 1.3 设计 | 1.3 | 否 |
| **OQ-16** | **写工具开放后，HTTP 层如何做发送者约束**（DPoP vs per-request nonce vs mTLS） | 只读工具重放无副作用；写工具会改变状态，必须引入发送者约束，但选型取决于真实客户端能力 | 1.5 设计 | 1.5（写工具之前） | 否 |
| OQ-E1 | Electron 主进程 Ed25519 是否与系统 Node 一致 | 系统 Node 已实测，Electron 未验证 | 1.1B 第一天 spike | 1.1B | 否（低风险） |
| OQ-E2 | Windows DPAPI / Linux keyring 的 `safeStorage` 行为 | 需对应实机 | 1.1B 后期 | 1.1B（若含 Windows） | 否，若首发仅 macOS |
