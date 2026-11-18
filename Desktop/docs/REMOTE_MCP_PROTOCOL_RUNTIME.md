# BrewPhase Remote MCP — 通信协议 · 请求与可靠性（§6–§10）

> **分册说明**：本册从 `REMOTE_MCP_PROTOCOL.md` 按整章拆出，章节号沿用全系列编号（未重新起算）。
> 本册：§6 请求转发、§7 时间/超时/取消、§8 重复请求与缓存、§9 错误码（**§9.1 唯一权威**）、§10 断线检测与重连。
> 全系列索引见 `REMOTE_MCP_INDEX.md`。基线 `feature/remote-mcp` @ `fc96654`。
> 本册由原文档整章拆出（仅搬移 + 补导航，无内容变更）；**其后叠加 Phase 0 的
> P0-1 / P0-2 修订**，逐条见 `REMOTE_MCP_INDEX.md` §7。

---

## 6. 请求转发

### 6.1 `req`（Cloud → Desktop）

```jsonc
{
  "v": 1,
  "type": "req",
  "id": "req_01J8Z9K2M4",            // **投递标识**（delivery_id），Cloud 生成
  "ts": 1763400001000,
  "tool": "search_records",
  "arguments": { "search": "埃塞", "limit": 20 },
  "request_hash": "sha256:9f2c…",     // 内容指纹，**只校验同 id 未被换内容**（§8.2）
  "deadline_ms": 1763400016000,      // **绝对** epoch 毫秒，不是相对超时
  "grant_ctx": "gc_01J8Z9K2M4",      // **必需**：授权上下文引用（§6.5）
  "trace": {
    "mcp_request_id": "…",           // ChatGPT 的 JSON-RPC id，仅用于日志串联
    "received_at": 1763400000980     // Gateway 收到 HTTP 的时刻（epoch）
  }
}
```

**Phase 0（P0-1）移除了 `grant_id` / `client_id` / `client_name`**：它们只存在于
`grant_ctx` 指向的上下文里（§6.5）。请求帧里同时出现「引用」和「自报身份」会制造
两个事实来源——实现者一定会误用后者。

**Phase 1.0.1 移除了 `idem` 字段**（按 `sha256(tool+args)` 去重会把两次独立查询
误合并）。**Phase 1.0.2 加入 `request_hash`，但用途完全不同**：它只回答
「同一个 `delivery_id` 的请求内容有没有被换掉」，不参与任何跨 id 的合并。
详见 §8.2。

**`id` 的三条硬约束**：

1. 由 **Cloud** 生成，Desktop 不得自造。
2. 一次 HTTP `tools/call` → 一个 `id`；**重投必须复用同一个 `id`**（且 `request_hash` 不变）。
3. 新的逻辑调用（哪怕参数完全相同）→ **新的 `id`**。

**为什么 deadline 用绝对值**：相对超时会在每一跳累积误差，而且 Desktop 无法判断
请求是否「已经在路上很久」。绝对时间让 Desktop 能直接判断「已过期，不要开始」。

### 6.2 校验顺序（Desktop，任一失败即 `res.ok=false`）

顺序与 §8.5 的**准入段（第 1–10 步）完全一致**；本节多出的 11–12 是审计与出站组装，
不属于准入判定。**缓存命中在准入之后**：

```
1.  本地远程开关 == on                        → 否则 REMOTE_DISABLED
2.  frame_bytes ≤ max_frame_bytes              → 否则 REQUEST_TOO_LARGE
3.  now_mono 未超过本地预算（§7.1）            → 否则 REQUEST_TIMEOUT（不执行）
4.  grant_ctx 已知、状态 active、epoch 当前    → 否则 GRANT_CONTEXT_INVALID
5.  ctx.bound_user_id == device.boundUserId    → 否则 USER_MISMATCH（并置 blocked）
6.  tool ∈ effective_tools(grant)              → 否则 TOOL_NOT_ALLOWED
7.  required_scope(tool) ∈ effective_scopes    → 否则 SCOPE_DENIED
8.  delivery_id / request_hash 一致性          → 不一致则 PROTOCOL_VIOLATION（不执行、不污染缓存）
9.  查结果缓存（§8.4，键 = grant_ctx + delivery_id）→ 命中则回放，meta.cached=true
10. executeTool(tool, arguments, ctx)          → 内部：scope → Zod → handler → 错误映射
11. 写审计（安全 §6.5.5 / §6.5.6）             → **审计结果不影响 res.ok**
12. 组装 res{ok,data|error} → 发送 → 写入缓存
```

**顺序里的四个刻意之处**：

- **deadline 检查在 Zod 之前**：已过期的请求不需要花时间校验参数。
- **grant 上下文在 4–7，早于缓存**：缓存键里含 `grant_ctx`，但「上下文已失效」
  必须在查缓存之前判定——否则撤销后的旧结果还能被回放。
- **缓存在 1–8 之后**：先查缓存会让「已关开关 / scope 已收紧 / 设备已撤销 /
  grant 已撤销」全部失效——这是最隐蔽的越权路径。
- **`executeTool` 内部会再校验一次 scope**（架构 §6.5.4）。第 7 步是「提前失败、
  给出更准确的错误码」，内部那次是结构保证——两处都保留，不是冗余。

### 6.3 `res`（Desktop → Cloud）

成功：

```jsonc
{
  "v": 1,
  "type": "res",
  "id": "req_01J8Z9K2M4",
  "ts": 1763400001120,
  "ok": true,
  "data": {
    "items": [
      { "id": "…", "title": "…", "carrier": "link", "note": "…", "created_at": 1763… }
    ],
    "limit": 20, "offset": 0, "has_more": true
  },
  "meta": { "duration_ms": 118, "cached": false }
}
```

失败：

```jsonc
{
  "v": 1,
  "type": "res",
  "id": "req_01J8Z9K2M4",
  "ts": 1763400001120,
  "ok": false,
  "error": {
    "code": "SCOPE_DENIED",
    "message": "records:read is not granted on this device",
    "retryable": false
  }
}
```

`meta.duration_ms` 用**单调时钟**测（§7.1），**不**用 `ts` 差值。
`meta.cached` 仅在「同一 `delivery_id` 重投命中缓存」时为 `true`（§8.4）。

**`res` 不携带审计状态。** 审计是否写成是**纯本地**事实（安全 §6.5.5 的 S-C），
不通过协议回传——否则会多一条「用户磁盘健康状况」的泄露通道，
也会诱导实现者把审计失败塞进 `res.ok`。审计状态只进 `remote:status` /
`remote:diagnose`。

`message` 面向 AI 可读，**不得包含**：SQL、文件路径、堆栈、token、内部主机名。
沿用 Local MCP 的纪律（`request-router.ts:551-558`：只对 `ApplicationError` 透传原文，
其余统一文案）。

### 6.4 Gateway → MCP 的映射

| Desktop 结果 | MCP tool 返回 |
|---|---|
| `ok:true` | `content: [{type:'text', text: JSON.stringify(data)}]` + `structuredContent: data` |
| `ok:false` | `content: [{type:'text', text: JSON.stringify({error})}]` + `isError: true` |
| 连接不存在 | 同一个 `isError:true`，`code: DEVICE_OFFLINE`（**不抛 JSON-RPC error**，让 AI 能读到原因并重试） |

**重要**：不要用 JSON-RPC 协议层错误（`-32603`）表达业务失败——AI 客户端对
协议错误的处理通常是中止对话，而不是「换个说法再试」。

---

### 6.5 Grant 上下文的线格式（Phase 0 / P0-1）

上下文由 Cloud 通过**已认证的 WSS** 下发；`req` 只携带不透明引用 `grant_ctx`。
安全模型、方案取舍与撤销语义见 `REMOTE_MCP_SECURITY.md` §2.7。

**为什么不是「请求帧里加一个普通 `grant_id`」**：普通字段无法回答「这个 grant 现在
是否还有效、它的 scope 是什么」。把 `grant_id` 放进请求却不校验，等于让 Cloud 独自
承担授权判断；（按旧设计）Desktop 仍然只有连接级 scope，无法在请求级约束具体 Client。
上下文方案把「grant 的当前状态」变成 Desktop 可校验的本地对象，并在撤销时主动失效。

#### 6.5.1 `hello_ok.grants`（全量快照）

字段见 §4.4。三条硬规则：

1. Desktop **必须**在下一条帧之前原子替换整张上下文表（`hello_ok` 是同步屏障）。
2. `grants` 为空数组 = 当前无任何授权；**保持连接**，但任何 `req` 回 `GRANT_CONTEXT_INVALID`。
3. `grant_epoch` 是设备级代数；重连后以新快照为准，旧上下文的缓存随断线已清空（§8.4）。

#### 6.5.2 `grant_update` / `grant_update_ack`（增量）

```jsonc
// Cloud → Desktop
{
  "v": 1, "type": "grant_update", "ts": 1763400001000,
  "grant_epoch": 8,                 // 设备级，单调递增
  "op": "install",                  // "install" | "revoke"
  "grant": {                        // install 必填，字段同 §4.4 grants[]
    "grant_ctx": "gc_01J8Z9K2M4", "grant_id": "grt_01J8Z9K2M4",
    "client_id": "chatgpt", "client_name": "ChatGPT",
    "scopes": ["records:read", "coffee:read"],
    "bound_user_id": "u-8f21c3", "epoch": 3
  },
  "grant_ctx": "gc_01J8Z9K2M4",     // revoke 必填
  "reason": "user_revoked"          // user_revoked | scope_changed | user_switch | device_revoked
}

// Desktop → Cloud
{
  "v": 1, "type": "grant_update_ack", "ts": 1763400001010,
  "grant_epoch": 8,
  "applied": true,
  "reason": ""                      // applied=false 时必填
}
```

规则：

| # | 规则 |
|---|---|
| 1 | `grant_epoch` 按**设备**单调递增；Desktop 丢弃 `<= 当前` 的更新（幂等，抵御重复/乱序） |
| 2 | `install`：Cloud **必须**收到 `grant_update_ack{applied:true}` 才可为该 grant 路由；未 ack 前一律 `GRANT_CONTEXT_INVALID` |
| 3 | `revoke`：Cloud **先停路由**，再发帧；`grant_ack_timeout_ms`（建议 3000，未实测）内无 ack → 标记该设备 `grant_sync_lag` 并**暂停向它路由所有 grant**，直到重新握手 |
| 4 | `applied=false` 必须给出 `reason`：`user_mismatch` / `stale_epoch` / `protocol_violation`；Cloud 记安全事件并停止路由该设备 |
| 5 | 上下文**不落盘**：连接断开即全部丢弃；重连只认新的 `hello_ok` 快照 |
| 6 | `revoke` 不要求 Desktop 中断同步 handler（不可能），但要求完成后不回传数据（§11.3） |
| 7 | **畸形帧也要 ack**：形状非法（未知键 / 类型错 / 缺字段）但 `grant_epoch` 可读时，Desktop **必须**回 `applied=false, reason:'protocol_violation'`，且**一点不改**上下文。只有连 epoch 都读不出来才丢弃 |

**两个 epoch 不要混（最容易被实现成同一个）**：

| 字段 | 层级 | 用途 |
|---|---|---|
| `grant_epoch` | **设备级**（帧字段） | 帧的新旧门槛：`<= 当前` 即丢弃，抵御重复/乱序/重放 |
| `grants[].epoch` / `grant.epoch` | **单个 grant** | 该 grant 自身的版本：scope 变更时 +1，用于判断「这条 `req` 引用的上下文是否还是当前版本」 |

设备级 `grant_epoch` 每次上下文变更都 +1；单 grant 的 `epoch` 只在该 grant 自身
变化时 +1。准入第 4 步校验的是**后者**（`req` 引用的 grant 版本必须等于当前版本）。

**ack 超时的取舍（fail-closed）**：宁可暂停该设备的全部远程访问，也不在
「无法确认撤销已生效」的状态下继续路由。设备会显示为「授权同步异常」，
重新握手即可恢复——这比「撤销后仍能读」可接受得多。

**但正因为它这么重，规则 7 不是可选的**：如果畸形 `grant_update` 被静默丢弃，
Cloud 侧等不到 ack，就会走 fail-closed **暂停该设备的全部 grant**——
一个序列化 bug 足以让整台设备停服。同步把 `applied=false` 回过去，
代价只是一条 ack，收益是「错误被局限在这一帧」。

---

## 7. 时间、超时与取消

### 7.1 两种时间，不许混用

| 用途 | 用哪个 | 为什么 |
|---|---|---|
| 帧里的 `ts`、`deadline_ms`、`received_at`（**跨进程**） | `Date.now()`（epoch ms） | 只有 epoch 在不同机器/进程间可比 |
| 心跳 RTT、执行耗时 `duration_ms`、退避计时（**进程内**） | `performance.now()`（monotonic） | 系统时间被改/被 NTP 校正时，耗时不能跳变 |

规则：

- **任何「差值」只要两端在同一个进程，就必须用 monotonic。**
  `Date.now() - startedAt` 一律视为 bug（机器休眠/校时会让它变成负数或几十秒）。
- **`deadline_ms` 是跨进程协议字段，必须是 epoch。** Desktop 收到后：
  1. `remaining = deadline_ms - Date.now()`（一次 epoch 差值，允许偏差）
  2. 之后所有计时用 monotonic：`expiresAtMono = performance.now() + remaining`
  3. 判断是否超时只看 `performance.now() >= expiresAtMono`

这样即使执行期间系统时间被向前跳 1 小时，也不会让一个 15s 的请求变成 1 小时的请求。

**实现上的硬要求（Phase 1.1B.1）**：`Date.now()` 在一次请求里**只读一次**，
就是算 `remaining` 的那一次。之后每个判断都用 `performance.now()` 与
`expiresAtMono` 比较。测试用可注入时钟断言「epoch 时钟恰好被读 1 次」——
读 2 次就说明有第二个比较点用错了时钟。

### 7.2 预算分配

| 段 | 预算 | 说明 |
|---|---|---|
| ChatGPT ↔ Gateway | 由客户端定（通常 60s） | 不可控 |
| Gateway 内部排队 | 2s | 超出即 `DEVICE_BUSY` |
| Gateway ↔ Desktop 执行 | **15s 默认**，硬上限 30s | 写入 `deadline_ms` |
| Desktop 执行 | 受 `deadline_ms` 约束 | 见 §7.3 的执行现实 |

```
deadline_ms = min(now_epoch + tool_budget, now_epoch + 30_000, client_deadline)
```

### 7.3 执行现实：同步 handler 不可中断

**已实测**：27 个 handler 与 5 个 service 全部同步（better-sqlite3），
`HANDLERS` 体内 `await` 出现 0 次（架构 §1.4 补充表）。

因此：

- **不存在「执行到一半被 deadline 打断」**。一次 handler 调用是一次事件循环内的
  原子操作，耗时通常在微秒到几十毫秒。
- deadline 只有两个有意义的检查点：**收到帧时**（过则拒）与**发送 res 前**
  （过则丢弃结果、回超时）。中间没有第三个检查点——不要设计一个不存在的
  「执行中超时回调」。
- 若未来某个工具变成 async（例如访问网络），必须同时引入
  `AbortSignal` 与取消语义，**那是一次协议变更**，需递增 `v`。

### 7.4 超时行为

| 位置 | 行为 |
|---|---|
| Gateway 等到 deadline | 返回 `REQUEST_TIMEOUT` + 发 `cancel` 给 Desktop（**尽力**） |
| Desktop 收到 `req` 时 `remaining ≤ 0` | 立即 `res.ok=false, code:REQUEST_TIMEOUT`，**不执行**（不进 Zod、不碰数据库） |
| Desktop 执行完成后发现已过 deadline | **不发送 `res`**，丢弃结果**并丢弃 inflight 占位**，记审计 `success=false, error_code=REQUEST_TIMEOUT` |

第三条是刻意的：如果 Cloud 已经超时返回，Desktop 再补发一个 `res` 只会让
Cloud 收到一个「迟到的成功」，与它已经告诉 AI 的结果矛盾。**宁可丢结果，不要自相矛盾。**

**「丢弃占位」不是可选的**：占位留着会让同一个 `delivery_id` 在此后一直被
当成「正在执行」而拒绝（§8.3 第 1 条），直到断线才恢复——等于给一个永远
不会到来的 `res` 占着一个坑。所以「丢弃结果」与「丢弃占位」必须同时发生。

### 7.5 `cancel`

```jsonc
{ "v": 1, "type": "cancel", "id": "req_01J8Z9K2M4", "ts": 1763400005000,
  "reason": "client_cancelled" }   // client_cancelled | gateway_timeout | device_shutdown
```

| 收到时请求处于 | 处理 |
|---|---|
| 在队列中（未开始） | 移出队列 → 回 `res{ok:false, code:REQUEST_CANCELLED}` |
| 正在执行 | 由于执行同步，实际不可能观察到；若因未来异步化而出现，标记为「已取消」，执行结束后**不发 res** |
| 已完成（结果已发） | **忽略**（幂等空操作） |
| 未知 `id` | **忽略**（可能是重复 cancel） |

**取消只针对单个 `id`，不影响任何其它请求。** 第一版没有「多个 waiter 共享一次执行」，
因此不存在「取消一个 waiter 影响另一个」的问题（§8.4）。

**Cloud 只在 `req` 真的写出之后才发 `cancel`。** 「写没写过」是 Cloud 的内部事实
（`frameSent`），不是协议字段：排队项，以及「已登记、被最终核对拦下」的项，
Desktop 从没见过它们的 `id`，发 `cancel` 只会让对端去取消一个不存在的请求。
超时（`gateway_timeout`）与取消（`client_cancelled`）走同一条判据。

---

## 8. 重复请求与缓存（Phase 1.0.1 重写，1.0.2 补齐语义）

### 8.1 七个 id / 标识必须先分清

| 名称 | 谁生成 | 作用域 | 是否会重复 | 用途 |
|---|---|---|---|---|
| `mcp_request_id` | ChatGPT（JSON-RPC `id`） | 一次 MCP 会话 | 客户端重试时可能重复 | 仅日志串联（`trace.mcp_request_id`） |
| `delivery_id`（协议字段 `id`） | **Cloud** | 一次 WSS 投递 | **重投时故意复用** | 唯一去重键 |
| **`request_hash`** | **Cloud** | 一次投递的内容指纹 | 同内容必同值 | **仅校验同一 `delivery_id` 的内容未被替换**（§8.2） |
| `intent_digest` | Cloud（可选计算） | 调用意图 | 独立调用会相同 | **只用于日志/诊断**，不参与去重 |
| `exec_id` | Desktop | 一次真实执行 | 不重复 | 审计与性能指标 |
| **`grant_ctx`** | **Cloud**（在上下文中） | 一次 WSS 连接内的一个授权 | 同一 grant 重连后会变 | **授权引用**，参与缓存键；**不是去重键** |
| `grant_id` / `client_id` | Cloud | 授权主体 | — | 审计与限流；只存在于上下文，**不在 `req`** |

### 8.2 `request_hash`：内容指纹，不是幂等键

**定义**：

```
canonical_request = canonicalJson({
  v:         1,               // 协议版本，纳入指纹（跨版本语义可能不同）
  tool:      "search_records",
  arguments: { ... }          // 完整、未截断
})
request_hash = "sha256:" + SHA-256(UTF8(canonical_request))
```

`canonicalJson` 的规则复用现有实现语义（`Desktop/src/main/mcp-bridge/audit-log.ts:100-107`：
对象键排序、剔除 `undefined`、数组保序、不做 Unicode 归一化）。

**三条硬约束**：

1. **`request_hash` 只用于「同一 `delivery_id` 的内容是否被替换」这一件事。**
2. **绝不用于合并不同 `delivery_id` 的相同查询。** 两个独立请求的
   `request_hash` 相同是**正常且必须允许**的（§8.3 规则 2）。
3. **不参与任何授权判断。** 它不携带 scope、不携带 device、不携带用户身份。

> 为什么仍要加它：`delivery_id` 由 Cloud 生成，如果 Cloud 有 bug（或被改造），
> 可能出现「复用旧 id 但换了请求内容」。没有指纹校验时，Desktop 会把这个
> 新请求当成重投、回放旧缓存——**用户看到的是另一个问题的答案**。
> 指纹让这种情况变成显式错误，而不是静默错答案。

### 8.3 六种重复投递情况的处理（必须逐条实现）

| # | 情况 | 处理 |
|---|---|---|
| 1 | 相同 `delivery_id` + 相同 `request_hash`，**第一次正在执行** | **不重复执行**。v1 返回 `PROTOCOL_VIOLATION`（理由见下方「第 1 条的 v1 定稿」） |
| 2 | 相同 `delivery_id` + 相同 `request_hash`，**已有完成结果** | 返回缓存结果（`meta.cached=true`，`duration_ms` 为首次值） |
| 3 | 相同 `delivery_id` + **不同** `request_hash` | **拒绝**：`PROTOCOL_VIOLATION`，不执行，**不覆盖**已有缓存，记 stderr + 安全事件 |
| 4 | **不同** `delivery_id` + 相同 tool/arguments | **视为独立请求，各执行一次**（这是最容易被写错的一条） |
| 5 | 第一次执行中连接断开 | **不得**因为重连自动执行第二次。旧请求以 `DEVICE_OFFLINE` 结束，缓存随断线清空 |
| 6 | 旧连接的迟到响应 | **不得**污染新连接的请求状态。新连接是新的 `connection_id` + 新缓存，旧帧丢弃 |

#### 第 1 条的 v1 定稿：**拒绝，不排队**（Phase 1.1B.1 修订）

Phase 1.0.2 写的是「挂起该帧，等首次完成后共用结果」。**v1 改为直接拒绝**，
理由是那条路径在 v1 里**结构性不可达**，而为一个不可达路径写异步协调代码
（取消、关开关、断线时都要保证不泄漏结果）比一条明确错误更危险。

结构性的依据：27 个 handler 全同步（架构 §1.4 实测），`handle()` 从
`beginInflight` 到 `put` 之间**没有 `await`**。Node 单线程下，第二次投递
只可能在该函数**返回之后**到达——那时占位已被结果替换，走的是情况 2。

因此 v1 的三条结论：

| 决定 | 内容 |
|---|---|
| 占位表**保留** | 它是「同 id 绝不重复执行」的结构保证，也是 ST-7 可断言的前提 |
| 命中占位 → `PROTOCOL_VIOLATION` | 明确、可观测、不静默 |
| 不实现 waiter | 异步工具落地时（`v` 递增）再实现，届时需要 `exec_id` + waiter 计数 + 「所有 waiter 取消才中止」 |

**不允许的捷径**：不得因为「同步所以不可能并发」就省掉占位、让第 1 条落到
第 4 条去（那会变成执行两次）。占位表的存在本身就是第 1 条的实现。

**为什么不影响正常重投**：Cloud 的重投发生在「没收到 `res`」之后，那时首次
执行早已返回、占位已换成了结果，走情况 2 命中缓存。占位被命中的唯一方式是
**同一条连接上并发投递同一个 id**，那本身就是协议违规。

### 8.4 缓存生命周期（设计建议，未实测）

| 项 | 建议值 | 依据 / 备注 |
|---|---|---|
| 键 | **`(grant_ctx, delivery_id)`** | 逐 grant 隔离；同一设备两个 Client 的同名 `delivery_id` 不会互相命中 |
| 容量（条数） | **256 条** | 远大于单连接在途上限（`max_inflight=2`）× 重投次数 |
| 容量（字节） | **8 MiB** | 256 条若都是 1 MiB 结果会到 256 MiB，必须另有字节上限 |
| 淘汰 | **LRU，条数与字节数任一超限即淘汰最旧** | 两个上限都要有；只按条数会在「大结果」场景爆内存 |
| TTL | **60 秒（monotonic）** | 重投窗口不会超过一个 deadline（15s）+ 网络抖动 |
| 存什么 | `{ grant_ctx, delivery_id, request_hash, ok, data \| error, completedAtMono, durationMs }` | **不落盘**，只在内存 |
| **成功结果** | 缓存 | 回放值必须与首次发送的帧**逐字节等价** |
| **错误结果** | **同样缓存**（只缓存「已经发出 `res` 的那些」） | 理由见下 |
| 执行中占位 | `Map<(grant_ctx, delivery_id), {request_hash, state:'inflight'}>` | 完成后原地替换为结果 |
| 断线时 | **整体清空**（含占位） | §8.3 规则 5；重连不重投 |
| **关闭远程开关时** | **同步整体清空**（含占位），在持久化 `enabled=false` 之后、断连之前 | §8.5：关闭是「不要再读」的明确意图，缓存是关闭前的数据 |
| **grant 撤销时** | **清除该 `grant_ctx` 的全部条目（含占位）** | 撤销后不得回放撤销前的数据；其它 grant 不受影响 |
| **grant 上下文更新时** | 同样清除该 `grant_ctx` 的全部条目 | scope 可能已收紧；宁可重执行，不可回放旧权限下的结果 |
| 重连后旧 `delivery_id` | **不允许复用**（缓存已清，同 id 再来会当新请求执行） | 见下方注 |

**为什么错误也缓存**：判据不是「错误 vs 成功」，而是「**我们是否真的发出了
这个 `res`**」。凡已发出的帧都缓存，回放才能保证「同一次投递得到同一个答案」。
唯一不缓存的是「已过 deadline 因而**根本没发** `res`」的情况——那里没有可回放的帧。

**为什么重连后旧 `delivery_id` 允许被当新请求执行**：重连意味着 Cloud 侧
那些请求已全部以 `DEVICE_OFFLINE` 结束；如果 Cloud 又发来同一个 `delivery_id`，
那只能是一次**新的** `tools/call`（Cloud 侧 id 生成器不该复用，但没有跨连接的
强制手段）。此时执行一次是安全的（只读）；若拒绝反而会让用户看到莫名的失败。
**这条与 §8.3 规则 5 不冲突**：规则 5 禁的是「Desktop 主动重放」，
这里说的是「Cloud 主动新发」。

`OPEN QUESTION`：上表所有数值（256 条 / 8 MiB / 60s）均为**设计建议**，
未做压力测试。Phase 1.1B 需用真实结果体大小分布校准，写入 `OQ-15`。

### 8.5 缓存不得绕过任何校验

**重投的帧必须走完整的准入链，缓存命中在准入之后。** 顺序不可调换
（本节只列准入的 10 步；审计写入与 `res` 组装是 §6.2 的第 11–12 步，不属于准入）：

```
1. 本地远程开关 == on
2. 帧大小 / JSON 合法
3. deadline 未过（monotonic）
4. grant_ctx 已知、active、epoch 当前
5. ctx.bound_user_id == boundUserId
6. tool ∈ effective_tools(grant)
7. required_scope(tool) ∈ effective_scopes(grant)
8. request_hash 与 delivery_id 的一致性校验（§8.3 规则 3）
9. ← 只有到这里才查缓存（键 = grant_ctx + delivery_id）
10. executeTool(...)
```

**为什么缓存不能提前到 1–8 之前**：如果先查缓存直接回放，那么「用户已关闭开关」
「scope 已被收紧」「设备已被撤销」「grant 已被撤销」这些状态变化都不会生效——
AI 仍能拿到关开关之前的旧数据。这是最隐蔽的越权路径，必须由顺序保证。

**关闭开关时同时清空缓存（Phase 1.0.3 新增）**：

| 动作 | 时机 | 理由 |
|---|---|---|
| 持久化 `remote.enabled=false` | 第一步（同步，权威） | 先让本机「拒绝」生效 |
| **清空结果缓存（含 inflight 占位）** | 紧接持久化之后，**同步** | 缓存里是「关闭前」的数据；重开后回放它等于绕过用户的关闭意图 |
| 断 WSS | 之后（异步） | 断连只是结果 |

**两件事都必须做，不能互相替代**：清缓存不能替代准入（重开后仍要走 1–6 的检查），
准入也不能替代清缓存（否则重开后第一次同 id 请求会命中关闭前的旧结果）。

**四个竞态场景的确定行为**：

| # | 场景 | 期望行为 |
|---|---|---|
| R1 | 请求 X 正在执行 → 用户关闭开关 → Cloud 重投同一个 `delivery_id` | 若该 `req` 在新连接上到达：准入第 1 步拒绝 → `REMOTE_DISABLED`，**不查缓存、不返回 X 的结果**。若连接已断：Cloud 侧 `DEVICE_OFFLINE`。两者都不得让 X 的结果漏出去 |
| R2 | 请求 X 已完成（缓存有值）→ 关闭开关 → 重开 → 同一 `delivery_id` 再来 | 缓存已在关闭时清空 → 当作**新请求**执行一次（只读，安全） |
| R3 | 请求 X 已完成 → `deadline_ms` 已过 → Cloud 用同一 `delivery_id` 重投 | 第 3 步先拒（`REQUEST_TIMEOUT`），**缓存命中也要拒**——已过期的投递不该有结果 |
| R4 | `grant` 上下文被更新（scope 收紧）→ 同一 `delivery_id` 重投 | 第 7 步拒（`SCOPE_DENIED`），且该 grant 的缓存已在更新时清除，不回放 tighten 之前的缓存 |

对应验收：ST-5（关开关时到达 → 不进业务层）、ST-6（hash 不匹配 → 拒绝且不污染缓存）、
**ST-16（R1 组合：执行中关闭 + 重复投递必须重新走准入）**。

### 8.6 不需要 single-flight（并说明为什么）

Phase 1.0 设计了「同一 `idem` 的并发请求共享一次执行（single-flight）」。
Phase 1.0.1 **取消该设计**；Phase 1.0.2 明确：§8.3 第 1 条的「挂起并共用结果」
**不是** single-flight——它是「同一 `delivery_id` 的重复投递」，
而 single-flight 原指「不同请求按内容合并」。后者永不实现。

理由：

1. 去重键是 `delivery_id`，同一 id 的并发只可能是 Cloud 重投（异常路径）。
2. handler 同步执行，Node 单线程下天然串行。
3. 按内容合并（`intent_digest`）会重新引入「结果陈旧」的风险，见规则 2。

结论：**不实现按内容合并**，v1 也**不实现「同 delivery_id 的 waiter」**
（§8.3 第 1 条）。若引入异步工具，则两者一起重新评估
（届时需要 `exec_id` + waiter 计数 + 「所有 waiter 取消才中止执行」的语义）。

> 与 §8.3 的关系：§8.3 第 1 条是「同一 `delivery_id` 的重复投递」，
> 这里说的是「不同请求按内容合并」。两者都在 v1 里选择「不做合并/不做排队」，
> 但理由不同——前者是路径不可达，后者是会引入结果陈旧。

### 8.7 已完成后又收到 cancel

忽略。不修改缓存、不改审计（那次的 `success` 已经记录）。

### 8.8 为什么不需要 Cloud 侧持久幂等表

只读工具重复执行只有「多查一次」的代价，没有副作用。Desktop 的内存缓存已覆盖
真正的重投场景；Cloud 侧再加持久表只会带来「把用户查询存到 Cloud」的隐私成本——
注意 `request_hash` 本身也是内容指纹，**绝不能落 Cloud 库**
（它在内存里算完即传，不写日志、不写表）。
**写工具第一版不开放，因此不需要持久幂等。**

### 8.9 OPEN QUESTION

- `OQ-11`：是否需要「相同意图 5 秒内合并」作为**可选**优化（默认关）。
  **倾向不做**：它会重新引入「结果陈旧」的风险，而只读查询的成本很低。**不阻塞**。
- `OQ-15`（**新增**）：§8.4 的 256 条 / 8 MiB / 60s 是否合适。
  需 Phase 1.1B 用真实结果体大小校准。**不阻塞 1.1A**。

> 本文出现的 OQ 编号，完整汇总与阻塞判断见
> `REMOTE_MCP_ARCHITECTURE_DESIGN.md` §7.3（唯一权威）。

---

## 9. 错误码规范

### 9.1 业务错误码（`res.error.code`）

| code | 含义 | 触发方 | retryable | 前端提示方向 |
|---|---|---|---|---|
| `DEVICE_OFFLINE` | 无活跃连接 | Gateway | ✅（稍后） | 「桌面端未打开或离线」 |
| `DEVICE_UNAUTHORIZED` | 设备凭证无效/未激活 | Gateway | ❌ | 「请重新连接设备」 |
| `DEVICE_REVOKED` | 设备已被撤销 | Gateway | ❌ | 「此设备已被移除」 |
| `DEVICE_SUSPENDED` | 用户关闭了远程访问（Cloud 已知道） | Gateway | ❌ | 「你已关闭远程访问」 |
| `REMOTE_DISABLED` | Desktop 本地开关已关，但 Cloud 仍以为在线 | **Desktop** | ❌ | 「你已关闭远程访问」（同时暴露 Cloud 状态同步失败） |
| `DEVICE_BUSY` | 该设备在途请求已达 `max_inflight` | Gateway | ✅（立即） | 无需提示 |
| `USER_MISMATCH` | token 的 `sub` 与设备 `user_id` 不一致 | Gateway | ❌ | 记安全事件 |
| `GRANT_CONTEXT_INVALID` | 请求引用的 grant 上下文未知 / 已失效 / 版本过期 | Gateway + Desktop | ❌ | 「授权状态已变化，请重试」 |
| `GRANT_REVOKED` | 该 grant 已被用户撤销 | Gateway + Desktop | ❌ | 「该 AI 客户端的授权已被撤销」 |
| `SCOPE_DENIED` | scope 不覆盖该工具 | Gateway + Desktop | ❌ | 「授权范围不含此项」 |
| `TOOL_NOT_ALLOWED` | 工具不在白名单（Cloud 或 Desktop 任一侧） | Gateway + Desktop | ❌ | 「该操作不支持远程使用」 |
| `INVALID_ARGUMENTS` | 参数未通过 Zod | Desktop | ❌ | AI 可自行修正参数后重试 |
| `NOT_FOUND` | 实体不存在（record/bean/canvas id 无效） | Desktop | ❌ | 「找不到这条记录」 |
| `REQUEST_TIMEOUT` | 超过 deadline | 双方 | ✅（可重试一次） | 「查询超时」 |
| `REQUEST_CANCELLED` | 被 cancel | Desktop | ❌ | 无需提示 |
| `REQUEST_TOO_LARGE` | 帧或参数超限 | 双方 | ❌ | 缩小 `limit` |
| `PROTOCOL_VERSION_UNSUPPORTED` | 版本无交集 | 双方 | ❌ | 提示升级客户端/应用 |
| `PROTOCOL_VIOLATION` | 帧格式/语义非法（无法解析、帧内 `connection_id` 与握手不符、`id` 复用但内容不同） | 双方 | ❌ | 记审计并告警 |
| `INTERNAL_ERROR` | 未预期异常 | 双方 | ⚠️ 一次 | 「出错了」 |

本表共 **19** 个业务错误码。任务书列出的 10 个全部包含；新增 9 个
（`DEVICE_SUSPENDED`、`REMOTE_DISABLED`、`DEVICE_BUSY`、`INVALID_ARGUMENTS`、
`NOT_FOUND`、`REQUEST_TOO_LARGE`、`PROTOCOL_VIOLATION`、`GRANT_CONTEXT_INVALID`、
`GRANT_REVOKED`），
理由是这些情况在真实链路里必然出现，缺了就只能塞进 `INTERNAL_ERROR`，
AI 会误判为可重试。

**`GRANT_CONTEXT_INVALID` 与 `GRANT_REVOKED` 必须分开**：前者是「引用对不上」
（Cloud 与 Desktop 的上下文不同步，属于系统故障，要告警）；后者是「授权被用户
主动撤销」（正常业务事件，不该告警）。合并后运维就分不清「用户撤销」和「同步坏了」。

**`DEVICE_SUSPENDED` 与 `REMOTE_DISABLED` 必须并存**：前者说明 Cloud 状态已同步，
后者说明**本地已关但 Cloud 还不知道**——这是唯一能观测「suspend 请求失败」的信号，
合并成一个码就再也看不到这类故障。

### 9.2 错误码是**跨层稳定**的

Desktop 的 `error.code` 原样透传给 ChatGPT，不做二次映射。因此：

- 新增 Desktop 侧错误码必须同步登记在本表（合同测试断言两侧集合相同）
- 禁止把 `ApplicationError.code`（`VALIDATION_ERROR` / `STALE_RECORD` 等）
  直接外泄——网关层做一次白名单映射，未登记的一律 `INTERNAL_ERROR`

### 9.3 WSS close code

| code | 含义 | Desktop 是否应重连 |
|---|---|---|
| `1000` | 正常关闭（应用退出） | 否 |
| `1001` | 服务端下线 | 是（退避） |
| `1011` | 服务端内部错误 | 是（退避） |
| `4001` | `DEVICE_UNAUTHORIZED` | **否**（需用户重新注册） |
| `4002` | `PROTOCOL_VERSION_UNSUPPORTED` | **否**（需升级） |
| `4003` | `DEVICE_REVOKED` | **否**（清本地私钥） |
| `4004` | `USER_MISMATCH` | **否**（记安全事件） |
| `4005` | `DEVICE_SUSPENDED` | **否**（等用户开开关） |
| `4006` | `SUPERSEDED`（另一台设备接管） | **否** |
| `4007` | 握手超时（5s 未发 `hello`） | 是（一次） |
| `4008` | `HEARTBEAT_TIMEOUT` | 是（退避） |
| `4009` | 帧过大 / 帧格式非法 | 否（客户端 bug） |
| `4010` | `CREDENTIALS_ROTATED`（密钥/token 已轮换，需用新凭证） | **否**（用新凭证立即重连一次，不算退避） |
| `4011` | `MAINTENANCE`（服务端主动排空完成） | 是（退避） |

**关键区分**：4xxx 是「策略性关闭」，重连无意义（`4010` 是唯一例外：换新凭证后
立即重连）；1001/1011/4008/4011 是「技术性关闭」，必须重连。
混淆这两类会导致撤销后无限重连风暴。

**Cloud 侧的两个实现细节（Phase 1.2B.1）**：

| 情况 | Cloud 发什么 | 为什么不发「更自然的那个」 |
|---|---|---|
| 传输层超限（`ws` 内部会自己 close `1009`） | 在 close 之前改写为 **4009** | `1009` 不在 Desktop 的「不重连」集合里。一个序列化 bug 导致的大帧会让它无限退避重连，而协议规定这类情况「不重连」 |
| nonce 表容量耗尽 | **1011**（不是 4001） | 容量耗尽既不是重放也不是凭据错误。报 4001 会让 Desktop **清掉本地私钥**，用户被迫重新走确认码——为一个临时性的服务端资源问题付出了最重的代价 |

**`4006` 与 `drain` 的交互（Phase 1.0.1 明确）**：

- `drain` = 优雅排空（滚动部署）→ 排空后 close `1001`（**可重连**）
- `4006` = 被另一台设备顶替 → 直接 close，**不排空**（排空期间的请求也没有意义，
  新连接马上接管）
- 两者同时触发时，**`4006` 优先**：立即 close，不再等排空。

---

### 9.4 Cloud 侧转发层的实现约束（Phase 1.2B.2.2）

协议的前九节描述「帧长什么样」；这一节记录**实现时被证明必须固定下来的顺序**。
全部来自 `cloud/src/link/{dispatch-guard,request-registry,forwarder}.ts`。

**准入的十个判据，每次派发都重读数据库**

| # | 判据 | 失败 |
|---|---|---|
| 1 | 连接属于该 `userId` | `USER_MISMATCH` |
| 2 | 连接不处于 rotating | `DEVICE_UNAUTHORIZED` |
| 3 | grant 存在 | `GRANT_CONTEXT_INVALID` |
| 4 | `grant.user_id == userId` | `USER_MISMATCH`（ST-1） |
| 5 | grant 未撤销 | `GRANT_REVOKED` |
| 6 | `grant.resource == 本服务 resource` | `GRANT_CONTEXT_INVALID` |
| 7 | 工具在 8 个白名单内 | `TOOL_NOT_ALLOWED` |
| 8 | scope 覆盖该工具 | `SCOPE_DENIED` |
| 9 | `device.user_id == userId` | `USER_MISMATCH` |
| 10 | `status == active` 且 `token_expires_at > now` | `DEVICE_REVOKED` / `DEVICE_SUSPENDED` / `DEVICE_UNAUTHORIZED` |

第 3–6 条读 `mcp_grants`，第 9–10 条读 `mcp_devices`——**两张表各查一次，归属关系逐次核对**。
只查一半的实现会分别漏掉「B 的 token + A 的 grant」与「A 的身份 + B 的设备」。

**写出去之前的最后一次核对**：**先**在 `RequestRegistry` 里登记（`reserve`），
**再** `await lookup(userId, deviceId)` 比对 `connectionId`。顺序不能反：
`reserve` 是「撤销能不能看见这条请求」的唯一判据，详见 §9.5。

**`res` 的四种忽略**（都不是错误，都不该让调用方收到 5xx）：

| 情况 | 处理 |
|---|---|
| 未知 `id` | 忽略（`link_unknown_res`，warn） |
| 已结算的 `id` | 忽略（`link_duplicate_res`，debug） |
| `connectionId` 不匹配 | 忽略（`link_res_from_other_connection`，warn） |
| 形状非法 | 忽略（`link_malformed_res`，warn） |

**四种忽略必须分开记日志**：合成一条「无效 res」会让「Cloud 在等一个永远不会来的
`res`」这类故障彻底看不见——而那正是最需要发现的一种。

**在途计数的三层生命周期**

| 事件 | 动作 |
|---|---|
| 预留 | 三层各 +1（admitted）；排队项**不占**任何计数 |
| `promote` | 排队项转 `sent` 时才 +1 |
| 结算（res / 超时 / 断线 / 取消 / 撤销） | 三层各 −1，**恰好一次**（`released` 标志） |
| 连接断开 | 该连接全部（含排队项）以 `DEVICE_OFFLINE` 结束 |
| 轮换 | 该连接全部以 `DEVICE_UNAUTHORIZED` 结束（不可重试） |
| grant 撤销 | 该 ctx 全部以 `GRANT_REVOKED` 结束 |

**为什么排队项不占计数**：它还没发出去，占着计数就等于「凭空多一个在途」，
会让设备明明空闲却报 `DEVICE_BUSY`。

### 9.5 派发、撤销与取消的线性化（Phase 1.2B.2.2-R1）

§9.4 说明「检查哪些东西」，这一节说明**这些检查之间那条不能跨过的线**。
三个 bug 都出自同一种形状：*检查通过了，但在写出去之前，世界变了*。

#### 9.5.1 线性化点是 `reserve()`，不是「最后一次核对」

```
准入（DB）→ grant ctx 核对 → 预算 → reserve ─┬─→ 最终核对（await lookup）
                                              │        ↓  写 req
                                              └─ 从这里起：撤销/轮换/断线/取消都找得到它
```

`revokeInstalled()` 的动作顺序是「删 `byGrantId` / 删 `byCtx` →
`rejectByGrantCtx` → 发 `grant_update` → 等 ack」。第三条只能找到**已经登记**
的请求。所以：

| 顺序 | 结果 |
|---|---|
| 撤销先（`rejectByGrantCtx` 命中） | entry 已 `settled`，派发返回撤销原因，**不写 `req`** |
| `reserve` 先（撤销随后） | 撤销一定能结算它（含排队项），**不写或写后不交付** |

反过来（先 `lookup`、后 `reserve`）留出的窗口里，撤销会看到空集合、顺利完成，
随后派发恢复执行，带着一个**刚刚撤销的 `grant_ctx`** 把 `req` 写出去。
调用方看到的错误会指向「Desktop 不认这个上下文」，而真实原因是
「Cloud 把一条已撤销的授权发了出去」。

**最终核对必须复核四件事**（全部在 `await` 之后做，任何一个不成立就不写）：

1. `entry.state === "settled"` → 返回**先发生的那件事**的错误码（撤销 → `GRANT_REVOKED`，取消 → `REQUEST_CANCELLED`）；
2. 连接仍在 `conns` 里且不是 rotating；
3. `lookup(userId, deviceId)` 仍返回同一条 `connectionId`；
4. `byGrantId[grantId] === grantCtx`、`byCtx[grantCtx] === slot` 且 `slot.installed`。

第 4 条是最后防线：**不重读数据库**。授权事实由准入给出，重查只会把窗口换成
另一个形状（见 §9.4 的十条判据）。

#### 9.5.2 `AbortSignal` 在两个阶段的语义

| 阶段 | 行为 | 为什么不这样会错 |
|---|---|---|
| 调用之前已 aborted | **立即** `REQUEST_CANCELLED`，不查库、不登记、不占计数 | 为一个已经离开的调用方查两次库 |
| 已登记、`req` 未写出 | 结算为 `REQUEST_CANCELLED`，**不写 `req`**，**不发 `cancel`** | 发了 `cancel` 就是在取消一个 Desktop 没见过的 id |
| 已写出 `req` | 结算为 `REQUEST_CANCELLED` + 发 `cancel{client_cancelled}`（**尽力**） | 同步 handler 不可中断（§7.3），但要让 Desktop 别白做一次查询 |

「有没有写出去」由内部事实 `frameSent` 记录，**不是协议字段**：`state === 'sent'`
的语义是「已占着三层计数里的一个槽位」，`reserve()` 返回 `admitted` 的那一刻
就已经是 `sent`——那时帧还没构造。两者混用会凭空发出 `cancel`。

`sendEntry()` 的第一行是 `if (entry.state === "settled") return;`：这是
「排队项被撤销后又被 `promote()` 取出」的唯一拦截点（`promote()` 只负责从
队列里取，不判断还该不该发）。

#### 9.5.3 最终核对的错误分类（rotating ≠ offline）

| 状态 | 错误码 | `retryable` |
|---|---|---|
| 路由项不存在、连接已收敛 | `DEVICE_OFFLINE` | `true` |
| 连接标记为 rotating（凭据已换） | `DEVICE_UNAUTHORIZED` | `false` |
| `lookup` 返回**另一条** `connectionId`（被顶替） | `DEVICE_UNAUTHORIZED` | `false` |
| 窗口内出现 `syncLag` | `GRANT_CONTEXT_INVALID` | `false` |
| 窗口内 `grant_ctx` 不再是当前映射 | `GRANT_CONTEXT_INVALID` | `false` |

**rotating 必须与 offline 分开**：`ConnectionRegistry.lookup()` 对 rotating 返回
`null`（结构防线，生命周期 §12.2），所以「`null` ⇒ 离线」这条捷径会把「凭据已作废」
报成「可重试的离线」。客户端会一直重试一个永远不会成功的连接。
判据用转发层自己的 `ConnSync.rotating`：它在 `onConnectionRotating()` 里
**同步**置起，早于 `markRotating` / `unbind`，也早于 socket 关闭。

#### 9.5.4 重复 `install` 的 fail-closed 规则

`installGrant()` 发现同一条 `grant_id` 已装过时会先 `revoke` 旧 ctx。**只有
`not_installed` 才能继续安装**：

| 撤销结论 | 是否继续安装 | 理由 |
|---|---|---|
| `applied` | ✅ | 旧 ctx 已被 Desktop 丢弃 |
| `not_installed` | ✅ | 竞态下别人先撤了，旧 ctx 确实不在 |
| `rejected`（`applied=false`） | ❌ 返回 `rejected` | Desktop 明确拒绝，`syncLag` 已置 |
| `ack_timeout` | ❌ 返回 `ack_timeout` | 不知道撤销有没有生效 |
| `offline` | ❌ 返回 `offline` | 帧根本没写出去 |

继续安装的后果不是「多一条无用帧」：新 slot 的 ack 一到就把 `installed` 置成
`true`，连接在 `syncLag=true` 下**重新开始路由**——而 `syncLag` 本来只允许由
重新握手（新 `hello_ok` 快照）清除。那等于把一次明确的同步失败悄悄撤销掉。

三种失败**不得合并**成同一个日志事件：`link_grant_apply_rejected`（对端说不行）／
`link_grant_ack_timeout`（写出去了没回应）／`link_grant_sync_offline`（没写出去）。
排障方向完全不同。


## 10. 断线检测与重连

### 10.1 Desktop 侧的断线判定

| 信号 | 判定 |
|---|---|
| `onclose` | 立即断线 |
| `onerror` | 等 `onclose`（WebSocket 规范保证 error 后必有 close） |
| 90s 无 `ping` | 主动 close（半开连接） |
| `send()` 返回 false / 抛错 | 标记可疑，等 close |

### 10.2 退避策略

```
delay = min(cap, base * 2^attempt) * random(0.5, 1.0)   // full jitter 的一半
base = 1s, cap = 60s
attempt 在连接稳定 60s 后归零
```

| attempt | 基准延迟 | 实际范围 |
|---|---|---|
| 1 | 1s | 0.5–1s |
| 2 | 2s | 1–2s |
| 3 | 4s | 2–4s |
| 5 | 16s | 8–16s |
| 7+ | 60s | 30–60s |

**必须加 jitter**：Cloud 重启时全部设备会在同一秒重连，无 jitter 等于自造 DDoS。

### 10.3 重连时的状态

| 状态 | 处理 |
|---|---|
| 在途请求 | **全部丢弃**：Desktop 侧 reject 挂起的 promise、清定时器；Cloud 侧对这些 `id` 返回 `DEVICE_OFFLINE`（**不重发**） |
| `connection_id` | 旧的作废，`hello_ok` 下发新的 |
| **Grant 上下文** | **全部丢弃**：`grant_ctx` 只属于连接；重连后由 `hello_ok.grants` 重新全量安装。安装完成前收到的 `req` 一律 `GRANT_CONTEXT_INVALID` |
| 结果缓存（`(grant_ctx, delivery_id)` LRU） | **整体清空**（修正 Phase 1.0 的「跨重连保留」）——因为不跨连接重投，保留只会让新连接的回放命中旧数据；且旧 `grant_ctx` 已作废 |
| 心跳 `seq` | 归零重新计数 |
| 重连 `attempt` 计数 | **保留**（否则每次失败都从 1s 开始，等于没有退避）；连接稳定 60s 后归零 |
| 本地开关 | 若用户已关，不再重连 |
| **本地身份校验** | **每次重连（含进程重启后的首次连接）都要重新通过** `enabled=true` + `boundUserId === 当前 userId` 双门；不得因「上次连过」而跳过（安全 §2.6.4，ST-17） |
| `linkState` | `backoff` → `connecting`；若是 `blocked`（撤销/版本/私钥/用户切换）则**不重连** |

**重连清理清单（实现必须逐项做到，遗漏会内存泄漏或误回放）**：

```
1. reject 所有 pending promise（reason: LINK_LOST）
2. clearTimeout / clearInterval 所有 deadline 与心跳定时器
3. 清空 pendingReqId → promise 的 Map
4. 清空结果缓存（(grant_ctx, delivery_id) → result）
5. 清空全部 Grant 上下文（含 grant_epoch）
6. 置 connection_id = null
7. 心跳 seq = 0
8. 保留 reconnectAttempt 与 blockedReason
```

**不做「断线期间排队」**：排队会让用户看到「刚问的问题在十分钟后突然被回答」，
且离线期间的数据可能已变更（库存扣减、记录编辑）。明确失败优于延迟成功。

### 10.4 `drain`（服务端主动排空）

```jsonc
{ "v": 1, "type": "drain", "ts": 1763400009000, "reason": "deploy", "grace_ms": 5000 }
```

Desktop 收到后：

1. 置 `linkState='draining'`，**对任何新 `req` 立即回 `DEVICE_BUSY`**
2. 等在途请求完成（最多 `grace_ms`）
3. 主动 close `1001`

Cloud 侧收到 `drain` 后必须**先停路由再发帧**：把该设备标为 `draining`，
新的转发请求直接回 `DEVICE_BUSY`，避免「排空中又塞进新请求」。
这样滚动重启不会掉请求。
