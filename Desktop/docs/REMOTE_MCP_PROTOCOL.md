# BrewPhase Remote MCP — 通信协议（Phase 1.0 设计）

> 协议版本 **1.0**（线格式 `v: 1`）。状态：设计，未实现。
> 覆盖两段链路：
> **A. ChatGPT ↔ Gateway（HTTPS + MCP Streamable HTTP）**
> **B. Gateway ↔ Desktop（WSS）**
> 本文只定义 B 的完整线协议（A 由 MCP 规范约束，本文只列 Gateway 必须暴露的端点与校验）。

---

## 1. 协议分层与版本

```
┌──────────────────────────────────────────────┐
│ MCP 语义层（JSON-RPC，tools/list、tools/call）│  ← 规范层，不自创
├──────────────────────────────────────────────┤
│ Remote Link Protocol v1（本文）                │  ← Cloud ↔ Desktop 私有协议
│  hello / ping / req / res / cancel / drain    │
├──────────────────────────────────────────────┤
│ WSS（TLS 1.2+，文本帧，一帧一个 JSON 对象）    │
└──────────────────────────────────────────────┘
```

### 1.1 版本规则

| 项 | 规则 |
|---|---|
| 版本载体 | 每一帧都有整数 `v` |
| 兼容策略 | **同 major 内只增不改**：新增可选字段、新增 `type` 均为兼容变更 |
| 接收方义务 | 必须**忽略未知字段**；必须**忽略未知 `type`** 并记 warn（不得断连） |
| 破坏性变更 | 必须递增 `v`，旧版本连接收到不支持的 `v` → close `4002` |
| 协商 | `hello` 带 `min_version` / `max_version`；Cloud 选择 `min(max_version, CLOUD_MAX)`，低于 `CLOUD_MIN` 即拒 |
| 第一版 | Cloud 与 Desktop 都只实现 `v=1`，但代码必须走协商而非硬编码 |

---

## 2. 帧（Frame）总览

所有帧都是 **单个 JSON 对象**，UTF-8 文本帧。不用二进制帧。

公共信封：

```jsonc
{
  "v": 1,                    // 协议主版本
  "type": "hello",           // 帧类型
  "ts": 1763400000123        // 发送方单调 epoch 毫秒（Clock 允许偏差，只用于排序/诊断）
}
```

| type | 方向 | 用途 |
|---|---|---|
| `hello` | Desktop → Cloud | 握手（设备认证 + 版本协商） |
| `hello_ok` | Cloud → Desktop | 握手成功（下发 connection_id / 策略） |
| `ping` | Cloud → Desktop | 心跳探测 |
| `pong` | Desktop → Cloud | 心跳应答（附在途计数） |
| `req` | Cloud → Desktop | 转发一次 tool 调用 |
| `res` | Desktop → Cloud | 返回结果或错误 |
| `cancel` | Cloud → Desktop | 取消在途请求 |
| `drain` | Cloud → Desktop | 即将断开（重启/撤销前），拒绝新请求 |
| `bye` | 双向 | 优雅关闭（附原因） |

**单向约束**：Cloud 从不向 Desktop 推送「非请求驱动」的业务帧。Desktop 不主动
发起 tool 调用。唯一 Desktop 主动的帧是 `hello` / `pong` / `res` / `bye`。

---

## 3. 设备注册（HTTPS，非 WSS）

注册不能走 WSS——设备还没有身份。用独立的 HTTPS 端点，且**需要用户在场确认**。

### 3.1 流程

```
Desktop                          Cloud                     用户（Web 设置页）
  │ 生成 Ed25519 密钥对            │                              │
  │ POST /devices/register        │                              │
  │  {name, platform, public_key, │                              │
  │   app_version}                │                              │
  ├──────────────────────────────>│ 建 devices 行(status=pending) │
  │  {device_id, confirm_code,    │ 生成 6 位 confirm_code        │
  │   expires_in: 300}            │                              │
  │<──────────────────────────────┤                              │
  │ 界面显示 confirm_code          │                              │
  │                               │<─────────────────────────────┤ 输入 6 位码
  │                               │ POST /devices/{id}/confirm    │
  │                               │ status=active + 签 device_token
  │                               │─────────────────────────────>│
  │ GET /devices/{id}/credentials │                              │
  ├──────────────────────────────>│                              │
  │  {device_token}               │                              │
  │<──────────────────────────────┤                              │
```

### 3.2 `POST /devices/register`

```jsonc
// request
{
  "name": "banmu 的 MacBook Pro",
  "platform": "darwin",
  "public_key": "base64url(32B Ed25519 raw public key)",
  "app_version": "0.1.5"
}
// 200
{
  "device_id": "0b7c…",          // Cloud 生成 uuid，不接受客户端自报
  "confirm_code": "492817",
  "expires_in": 300
}
```

- 需要 **L1 用户身份**（Bearer access token，现有 `/auth/*` 的那套）。
- `status=pending` 的设备**不能**握手，`hello` 返回 `DEVICE_UNAUTHORIZED`。
- 单用户最多 5 台；超出返回 `429 DEVICE_LIMIT`。
- `public_key` 必须是 32 字节 Ed25519 raw key，长度不符直接 400（不做猜测式容错）。

### 3.3 `POST /devices/{id}/confirm`

Web 设置页调用，带用户 Bearer。成功后 `status='active'`。

### 3.4 `GET /devices/{id}/credentials`

Desktop 轮询（1s 间隔，最多 300s）。返回：

```jsonc
{ "device_token": "bp_dev_…", "expires_at": 1765992000000 }
```

**只在 `status='active'` 且尚未下发过时返回一次**；重复请求返回 `409 already_issued`。
丢失只能重新注册（不允许补发，避免「拿到 Cloud 会话就能取走设备凭证」）。

### 3.5 其他设备端点

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/devices` | 列出当前用户设备（不含 token） |
| `POST` | `/devices/{id}/rotate` | 用旧私钥签名新公钥，轮换 |
| `POST` | `/devices/{id}/suspend` | 用户关闭远程开关 |
| `POST` | `/devices/{id}/resume` | 重新打开（需重新确认） |
| `DELETE` | `/devices/{id}` | 撤销（不可恢复） |
| `POST` | `/devices/{id}/heartbeat` | 见 §5.3（可选，WSS 心跳为主） |

---

## 4. WSS 握手

### 4.1 连接

```
wss://<gateway-host>/device-link
```

- **只接受** `Authorization: Bearer bp_dev_…`（放 header，不放 query——
  query 会进反向代理的 access log）。
- 服务端必须校验 `Origin`（不适用，非浏览器客户端）与 `Host`
  （`hostHeaderValidationResponse` 的语义），拒绝 `Host` 与配置不符的连接。
- 子协议：`Sec-WebSocket-Protocol: brewphase.remote.v1`（便于未来并行支持多版本）。

### 4.2 `hello`（Desktop → Cloud，连接后 5s 内必须发）

```jsonc
{
  "v": 1,
  "type": "hello",
  "ts": 1763400000123,
  "device_id": "0b7c…",
  "nonce": "base64url(16B random)",   // 每次握手唯一
  "sig": "base64url(Ed25519(device_id + '\n' + nonce + '\n' + ts))",
  "min_version": 1,
  "max_version": 1,
  "app_version": "0.1.5",
  "platform": "darwin",
  "capabilities": ["tools.call", "cancel", "drain"]
}
```

`device_token` **不放进 `hello`**——它已在 header 里，重复传递只会增加泄漏面。

### 4.3 Cloud 侧校验顺序（任一失败即 close）

```
1. Authorization header 存在且以 bp_dev_ 开头
2. sha256(token) 命中 devices.token_hash
3. devices.status = 'active'（pending → 4001 / suspended → 4005 / revoked → 4003）
4. devices.expires_at > now
5. nonce 未在 120s 内出现过（NonceStore，复用 sync/auth.ts 的有界实现）
6. |cloud_now - ts| ≤ 120_000
7. Ed25519 验签（devices.public_key）
8. 版本区间有交集（否则 4002）
9. 该 user 已有活跃连接？→ 见 §4.5
```

### 4.4 `hello_ok`（Cloud → Desktop）

```jsonc
{
  "v": 1,
  "type": "hello_ok",
  "ts": 1763400000200,
  "connection_id": "conn_01J…",        // Cloud 生成，本次连接唯一
  "instance_id": "gw-a",               // 多实例调试用；单实例恒为 "gw-a"
  "server_time": 1763400000200,        // 供 Desktop 估算时钟偏差
  "heartbeat_ms": 20000,
  "idle_timeout_ms": 60000,
  "max_inflight": 2,
  "max_frame_bytes": 1048576,          // 单帧上限 1 MiB
  "allowed_tools": [                   // Cloud 视图的白名单
    "search_records", "get_record", "list_record_tags",
    "list_beans", "list_brews", "list_tastings",
    "list_canvases", "get_canvas"
  ],
  "scopes": ["records:read", "tags:read", "coffee:read", "canvas:read"]
}
```

Desktop 收到后必须**取交集**：

```
effective_tools = intersect(hello_ok.allowed_tools, REMOTE_READONLY_ALLOWLIST, local_granted_scopes)
```

三者任一为空 → 仍然连接（让 Cloud 能下发撤销），但对任何 `req` 返回
`TOOL_NOT_ALLOWED`。

### 4.5 同用户多连接

- 第一版：**只允许一个活跃连接**（主设备）。第二条 `hello` 到达时：
  Cloud 先向旧连接发 `drain` 并等最多 5s，再 close `4006 SUPERSEDED`，
  然后接受新连接。这样「换机」不会永久卡住。
- 多设备并行属 Phase 1.4，需要 `devices.is_primary` 与用户选择。

### 4.6 握手失败的 close code

见 §9。**失败时不下发任何业务信息**，错误详情只进 Cloud 日志（含 device_id 前缀）。

---

## 5. 心跳与在线状态

### 5.1 心跳

```jsonc
// Cloud → Desktop，每 heartbeat_ms 一次
{ "v": 1, "type": "ping", "ts": 1763400020000, "seq": 17 }

// Desktop → Cloud
{ "v": 1, "type": "pong", "ts": 1763400020012, "seq": 17, "inflight": 1 }
```

- `seq` 回显，Cloud 用它算 RTT（`now - ping_sent_at`），写指标不写库。
- **连续 3 次未收到 `pong`（默认 60s）→ close `4008 HEARTBEAT_TIMEOUT`**，
  并把该连接从路由表删除、`devices.last_seen_at` 更新为最后成功 `pong` 的时间。
- Desktop 侧若 90s 未收到任何 `ping`（Cloud 卡死/半开连接），主动 close 并重连。
  这条是必需的：只靠 Cloud 单向探测，NAT 半开时 Desktop 会永远「以为在线」。

### 5.2 在线状态判定

| 状态 | 判定 |
|---|---|
| `online` | 路由表有 `(user_id, device_id)` 且 `now - last_pong_at < 60s` |
| `offline` | 无路由表项 |
| `suspended` | `devices.status='suspended'`（用户关了开关） |

**在线状态只来自连接事实，不由 Desktop 上报。** Desktop 说「我在线」不可信，
也不必要——有连接就是在线的定义。

### 5.3 心跳与 HTTP 的关系

`POST /devices/{id}/heartbeat` **不采用**。两套心跳会产生两个「在线」概念，
必然有一天不一致。在线 = WSS 有连接，唯一的真相在 Cloud 的连接管理器里。

---

## 6. 请求转发

### 6.1 `req`（Cloud → Desktop）

```jsonc
{
  "v": 1,
  "type": "req",
  "id": "req_01J8Z9K2M4",            // Cloud 生成，uuid v7 或 ULID（可按时间排序）
  "ts": 1763400001000,
  "tool": "search_records",
  "arguments": { "search": "埃塞", "limit": 20 },
  "deadline_ms": 1763400016000,      // **绝对** epoch 毫秒，不是相对超时
  "grant_id": "grt_01J…",
  "client_id": "chatgpt",
  "client_name": "ChatGPT",
  "idem": "sha256:9f2c…",            // 规范化 arguments 的摘要，见 §8
  "trace": {
    "mcp_request_id": "…",           // ChatGPT 的 JSON-RPC id，仅用于日志串联
    "received_at": 1763400000980
  }
}
```

**为什么 deadline 用绝对值**：相对超时会在每一跳累积误差，而且 Desktop 无法判断
请求是否「已经在路上很久」。绝对时间让 Desktop 能直接判断「已过期，不要开始」。

### 6.2 校验顺序（Desktop，任一失败即 `res.ok=false`）

```
1. 本地远程开关 = on                  → 否则 DEVICE_OFFLINE（本地视角）/ SUSPENDED
2. frame_bytes ≤ max_frame_bytes       → 否则 REQUEST_TOO_LARGE
3. tool ∈ effective_tools              → 否则 TOOL_NOT_ALLOWED
4. arguments 通过 TOOL_DEFINITIONS[tool].input.safeParse
                                       → 否则 INVALID_ARGUMENTS
5. now < deadline_ms                   → 否则 REQUEST_TIMEOUT（不执行）
6. settings 中的 scope 仍覆盖           → 否则 SCOPE_DENIED
7. 幂等检查（§8）
8. 执行 HANDLERS[tool]（**进程内直接调用**，不经 socket）
9. 写 mcp_operation_log(channel='remote', client_id=device_id)
```

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
  "meta": { "duration_ms": 118, "channel": "remote", "device_id": "0b7c…" }
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

## 7. 超时与取消

### 7.1 预算分配

| 段 | 预算 | 说明 |
|---|---|---|
| ChatGPT ↔ Gateway | 由客户端定（通常 60s） | 不可控 |
| Gateway 内部排队 | 2s | 超出即 `DEVICE_BUSY` |
| Gateway ↔ Desktop 执行 | **15s 默认**，单工具可覆盖，硬上限 30s | 写入 `deadline_ms` |
| Desktop 执行 | 受 `deadline_ms` 约束 | 不得超时后继续写库 |

```
deadline_ms = min(now + tool_budget, now + 30_000, client_deadline)
```

### 7.2 超时行为

| 位置 | 行为 |
|---|---|
| Gateway 等到 deadline | 返回 `REQUEST_TIMEOUT` + 发 `cancel` 给 Desktop（**尽力**） |
| Desktop 收到 `req` 时已过 deadline | 立即 `res.ok=false, code:REQUEST_TIMEOUT`，**不执行** |
| Desktop 执行中过 deadline | 中止并把结果丢弃，回 `REQUEST_TIMEOUT`（若查询已不可中断，仍返回超时——不能让 AI 拿到超时后又收到结果） |

### 7.3 `cancel`

```jsonc
{ "v": 1, "type": "cancel", "id": "req_01J8Z9K2M4", "ts": 1763400005000,
  "reason": "client_cancelled" }   // client_cancelled | gateway_timeout | device_shutdown
```

- Desktop 收到后：若请求仍在排队 → 丢弃并回 `REQUEST_CANCELLED`；
  若已开始执行 → 标记取消，执行完成后**不发送** `res`（避免 Cloud 已超时后又收到结果）。
- 幂等：对已完成或未知的 `id` 发 `cancel` 是无害空操作，不回错误。

---

## 8. 幂等与重复请求

### 8.1 两个不同概念

| 字段 | 语义 | 谁生成 | 跨重试是否变化 |
|---|---|---|---|
| `id` | 本次投递的唯一标识 | Cloud | **会变**（每次重发新 id） |
| `idem` | 这次**调用意图**的摘要 | Cloud | **不变** |

```
idem = "sha256:" + sha256(canonicalJson({tool, arguments}))
```

`canonicalJson` 复用 Local MCP 已有的实现语义（键排序、剔除 `undefined`、
数组保序），见 `Desktop/src/main/mcp-bridge/audit-log.ts:100-107`。

### 8.2 Desktop 侧处理

| 情况 | 行为 |
|---|---|
| `idem` 未见过 | 正常执行，结果存入 LRU |
| `idem` 命中且已有结果 | 直接返回缓存结果（`meta.replayed=true`），**不重查** |
| `idem` 命中但仍在执行 | 挂起该帧，等同一次执行完成后共用一个结果（single-flight） |
| `id` 命中「已处理」但 `idem` 不同 | 说明 Cloud 有 bug 或有人在构造——`PROTOCOL_VIOLATION`，记审计 |

缓存参数：**2048 条 / 10 分钟**，超出按 LRU 淘汰。只读工具的缓存命中率低、
危害小，这个容量足够覆盖「网络抖动导致的重发」。

### 8.3 为什么不需要在 Cloud 存结果的持久幂等表

只读工具天然幂等，重复执行的后果是「多查一次」，没有副作用。
Desktop 的内存 LRU 已能吸收重发；再加一层 Cloud 侧的持久幂等表只会带来
「缓存了用户数据」的隐私成本。**写工具第一版不开放，因此不需要持久幂等。**

---

## 9. 错误码规范

### 9.1 业务错误码（`res.error.code`）

| code | 含义 | 触发方 | retryable | 前端提示方向 |
|---|---|---|---|---|
| `DEVICE_OFFLINE` | 无活跃连接 | Gateway | ✅（稍后） | 「桌面端未打开或离线」 |
| `DEVICE_UNAUTHORIZED` | 设备凭证无效/未激活 | Gateway | ❌ | 「请重新连接设备」 |
| `DEVICE_REVOKED` | 设备已被撤销 | Gateway | ❌ | 「此设备已被移除」 |
| `DEVICE_SUSPENDED` | 用户关闭了远程访问 | Gateway | ❌ | 「你已关闭远程访问」 |
| `DEVICE_BUSY` | 该设备在途请求已达 `max_inflight` | Gateway | ✅（立即） | 无需提示 |
| `USER_MISMATCH` | token 的 `sub` 与设备 `user_id` 不一致 | Gateway | ❌ | 记安全事件 |
| `SCOPE_DENIED` | scope 不覆盖该工具 | Gateway + Desktop | ❌ | 「授权范围不含此项」 |
| `TOOL_NOT_ALLOWED` | 工具不在白名单（Cloud 或 Desktop 任一侧） | Gateway + Desktop | ❌ | 「该操作不支持远程使用」 |
| `INVALID_ARGUMENTS` | 参数未通过 Zod | Desktop | ❌ | AI 可自行修正参数后重试 |
| `NOT_FOUND` | 实体不存在（record/bean/canvas id 无效） | Desktop | ❌ | 「找不到这条记录」 |
| `REQUEST_TIMEOUT` | 超过 deadline | 双方 | ✅（可重试一次） | 「查询超时」 |
| `REQUEST_CANCELLED` | 被 cancel | Desktop | ❌ | 无需提示 |
| `REQUEST_TOO_LARGE` | 帧或参数超限 | 双方 | ❌ | 缩小 `limit` |
| `PROTOCOL_VERSION_UNSUPPORTED` | 版本无交集 | 双方 | ❌ | 提示升级客户端/应用 |
| `PROTOCOL_VIOLATION` | 帧格式/语义非法（如 id 冲突但 idem 不同） | 双方 | ❌ | 记审计并告警 |
| `INTERNAL_ERROR` | 未预期异常 | 双方 | ⚠️ 一次 | 「出错了」 |

任务书列出的 10 个错误码全部包含；新增 6 个（`DEVICE_SUSPENDED`、`DEVICE_BUSY`、
`INVALID_ARGUMENTS`、`NOT_FOUND`、`REQUEST_TOO_LARGE`、`PROTOCOL_VIOLATION`），
理由是这 6 种情况在真实链路里必然出现，缺了就只能塞进 `INTERNAL_ERROR`，
AI 会误判为可重试。

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

**关键区分**：4xxx 是「策略性关闭」，重连无意义；1001/1011/4008 是「技术性关闭」，
必须重连。混淆这两类会导致撤销后无限重连风暴。

---

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
| 在途请求 | **全部丢弃**，Cloud 侧对这些 `id` 返回 `DEVICE_OFFLINE`（不重发） |
| `connection_id` | 旧的作废，`hello_ok` 下发新的 |
| 幂等 LRU | **保留**（跨重连有效，这正是它存在的意义） |
| 本地开关 | 若用户已关，不再重连 |

**不做「断线期间排队」**：排队会让用户看到「刚问的问题在十分钟后突然被回答」，
且离线期间的数据可能已变更（库存扣减、记录编辑）。明确失败优于延迟成功。

### 10.4 `drain`（服务端主动排空）

```jsonc
{ "v": 1, "type": "drain", "ts": 1763400009000, "reason": "deploy", "grace_ms": 5000 }
```

Desktop 收到后：停止接受新 `req`（回 `DEVICE_BUSY`），等在设计中的在途请求完成
（最多 `grace_ms`），然后主动 close `1001`。Cloud 侧据此可以实现「滚动重启不掉请求」。

---

## 11. 生命周期事件

### 11.1 用户退出登录

```
Desktop account-service.signOut()
  → 1. 清本地凭据（现有行为）
  → 2. remote.disconnect()：发 bye(reason=signout) → close 1000
  → 3. Cloud 收到 bye / 检测到 close：
        撤销该 user 全部 mcp_grants
        删除该 user 全部路由表项
        记 auth_events(event_type='mcp_sessions_revoked')
  → 4. 任何在途 refresh token 失效（family 撤销，现有机制）
```

顺序要求：**先断连再清凭据**。反了的话，断连请求就带着已删的 token 发不出去，
Cloud 只能等心跳超时——用户会看到「已退出但 AI 还能读 15 分钟」。

### 11.2 设备撤销

```
用户在 Web 撤销
  → Cloud: devices.revoked_at = now
  → Cloud: 向该连接发 bye(reason=revoked) → close 4003
  → Cloud: 删路由表项（原子，先删表再发 bye，避免竞态中有请求被转发）
Desktop 收到 4003
  → 删除 userData/remote/device.json（私钥）
  → 界面回到「未连接远程」
  → 不重连
```

### 11.3 Scope 撤销（grant 撤销，设备保留）

```
Cloud: mcp_grants.revoked_at = now
  → 该 grant 的 access token 立即失效（每次转发前查 grant 状态）
  → **不**断开设备连接（设备可能还有别的 grant）
  → 通过 hello_ok 无法即时下发；改为下一次 req 直接返回 SCOPE_DENIED
```

可选增强：Cloud 发一个 `policy` 帧（`type:"policy", scopes:[...]`）主动下推。
第一版不做——`scopes` 在握手时下发一次足够，撤销靠「查 grant」兜底。

### 11.4 本地开关关闭

```
Desktop 用户关开关
  → POST /devices/{id}/suspend（Cloud: status=suspended，清路由表）
  → 断开 WSS（close 1000）
  → 后续请求：DEVICE_SUSPENDED（不是 OFFLINE——语义不同：一个是「你关了」，一个是「没开」）
```

---

## 12. 多实例下的设备路由

### 12.1 问题

WSS 是长连接，连接只存在于**某一台** Gateway 实例的内存里。ChatGPT 的
`POST /mcp` 可能打到任意实例（LB 轮询），因此必须有跨实例的「这台设备连在哪」。

### 12.2 第一版：单实例（明确限制）

```ts
// 接口先定好，实现可以是内存
interface ConnectionRegistry {
  bind(userId, deviceId, conn: { connectionId, instanceId }): Promise<void>
  unbind(userId, deviceId): Promise<void>
  lookup(userId, deviceId): Promise<{ connectionId, instanceId } | null>
  touch(userId, deviceId): Promise<void>   // 心跳续约
  listByUser(userId): Promise<Array<{ deviceId, connectionId, instanceId }>>
}
```

内存实现的 `instanceId` 恒为 `"gw-a"`。**部署必须限制为 1 副本**，
并在 `/ready` 里暴露 `instanceId` 便于确认。

### 12.3 多实例：Redis（Phase 1.4）

```
key:    mcp:conn:{user_id}:{device_id}
value:  {connection_id, instance_id, device_id, last_pong_at}
TTL:    90s（每次 ping 续期，比心跳间隔长，防抖动误删）

路由：
  1. lookup → instance_id
  2. instance_id == self  → 本地 Map 取 socket，直接转发
  3. 否则 → PUBLISH mcp:route:{instance_id} {req, reply_channel}
           等待 reply_channel 上的应答（超时 = 转发超时）
  4. lookup 为空 → DEVICE_OFFLINE
```

替代方案（不引 Redis）：Postgres `LISTEN/NOTIFY`。延迟可接受（<50ms），
但每条请求都要一次跨实例通知，QPS 高时数据库压力明显。**推荐 Redis**，
理由：它的 pub/sub 语义与「路由表 + TTL」正好匹配，且未来限流也可以共用
（现有 `rate-limit.ts` 已注明需要共享存储）。

### 12.4 路由表的一致性要求

| 要求 | 原因 |
|---|---|
| `bind` 必须在 `hello_ok` **之前**完成 | 否则握手成功但请求打进来时查不到 |
| `unbind` 必须在 close 处理里执行 | 否则路由到死连接 |
| TTL 必须 > 心跳间隔 × 2 | 防一次 ping 丢失就把在线设备判死 |
| 撤销设备时先删表再发 bye | 见 §11.2 |

---

## 13. 字段归属与校验

### 13.1 谁生成什么

| 字段 | 生成方 | 是否被对方校验 | 说明 |
|---|---|---|---|
| `v` | 双方各自填 | ✅ 版本区间 | 不允许中间件改 |
| `ts` | 发送方 | ⚠️ 仅握手时校验 ±120s | 业务帧的 `ts` 只用于诊断 |
| `device_id` | **Cloud**（注册时） | ✅ 必须与 token 归属一致 | 客户端自报一律忽略 |
| `nonce` | Desktop | ✅ 120s 去重 | 每次握手新值 |
| `sig` | Desktop | ✅ Ed25519 | 覆盖 `device_id\nnonce\nts` |
| `connection_id` | **Cloud** | ✅ 后续帧必须匹配 | Desktop 不得指定 |
| `instance_id` | **Cloud** | — | 只用于诊断 |
| `heartbeat_ms` / `max_inflight` / `allowed_tools` / `scopes` | **Cloud** | Desktop 取交集 | Cloud 是策略源 |
| `id` | **Cloud** | ✅ 响应必须回显 | Desktop 不得自造 |
| `tool` | Cloud（来自 MCP） | ✅ 白名单 + 存在性 | — |
| `arguments` | Cloud（来自 MCP） | ✅ Zod | Desktop 不信任任何字段 |
| `deadline_ms` | **Cloud** | ✅ 必须尊重 | Desktop 不得延长 |
| `grant_id` / `client_id` | Cloud（来自 JWT） | ⚠️ 仅审计 | Desktop 不据此决策 |
| `idem` | Cloud | ✅ 摘要一致性 | 不一致 → `PROTOCOL_VIOLATION` |
| `data` / `error` | Desktop | Cloud 不透传未登记 code | — |

### 13.2 三条反伪造规则

1. **`user_id` 永远不出现在任何帧里。** Cloud 从 token 派生，Desktop 也不需要
   （本地库本来就只有一个用户）。请求里出现即视为协议违规并记安全事件。
2. **`device_id` 不参与路由决策。** 路由键是 `(token → user_id, connection)`。
   `device_id` 只用于审计与多设备场景的展示。
3. **Desktop 不做「信任 Cloud」的捷径。** 即使 `grant_id` 看起来合法，
   Desktop 仍按本地 scope + 白名单 + 开关判定。

### 13.3 敏感数据不进日志（协议层约束）

| 位置 | 规则 |
|---|---|
| Cloud HTTP 日志 | 只 `method/path/status/duration`（现有 `app.ts` 已如此） |
| Cloud WSS 日志 | 只 `device_id` 前 8 位、`tool`、`status`、`duration_ms`、`error_code` |
| 帧内容 | **永不**记录 `arguments` / `data` / `error.message` |
| Desktop 日志 | 可记完整 `error.message`（本地），但不记 `data` |
| 审计表 | `mcp_operation_log`：tool / entity / success / error_code，**无参数无结果** |

---

## 14. 完整时序示例

### 14.1 正常查询

```
ChatGPT → POST /mcp  tools/call search_records {search:"埃塞", limit:20}
Gateway:
  JWT ok → sub=u1, grant=g1, scope 含 records:read ✔
  registry.lookup(u1, d1) → {conn_01J, gw-a} ✔
  req_01J8Z9K2M4 → WSS
Desktop:
  开关 on ✔ / tool ∈ effective ✔ / Zod ✔ / now<deadline ✔ / scope ✔
  HANDLERS.search_records → 20 条（has_more=true）
  写 mcp_operation_log(channel=remote, tool=search_records, success=1)
  res ok:true, duration_ms=118
Gateway → ChatGPT: structuredContent={items:[…],limit:20,offset:0,has_more:true}
```

### 14.2 设备离线

```
ChatGPT → POST /mcp
Gateway: registry.lookup(u1,d1) → null
→ tool result isError:true, {error:{code:"DEVICE_OFFLINE",retryable:true}}
（日志只记 tool + code，不记 search 关键词）
```

### 14.3 超时 + 取消

```
t=0      Gateway 发 req, deadline_ms=t+15000
t=15000  Gateway 未收到 res
         → 回 ChatGPT {code:"REQUEST_TIMEOUT"}
         → 发 cancel(id, reason:"gateway_timeout")
t=15020  Desktop 执行完成，发现已取消 → 丢弃结果，不回 res
t=15021  Desktop 记审计：success=false, error_code=REQUEST_CANCELLED
```

### 14.4 撤销后重连尝试

```
Web 撤销设备 → Cloud: revoked_at, 删路由项, bye(revoked), close 4003
Desktop: 收到 4003 → 删 device.json → 不重连 → 界面「远程已断开」
若 Desktop 因 bug 仍重连 → hello → Cloud 校验 status=revoked → close 4003
                            （第二次之后 Cloud 对该 device_id 限流，1 次/分钟）
```

---

## 15. Gateway 必须暴露的 HTTP 端点

| 方法 | 路径 | 用途 | 备注 |
|---|---|---|---|
| `POST` | `/mcp` | MCP Streamable HTTP | 用 SDK `createMcpHandler` + `WebStandardStreamableHTTPServerTransport` |
| `GET` | `/.well-known/oauth-protected-resource` | RFC 9728 保护资源元数据 | SDK `buildOAuthProtectedResourceMetadata` |
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 AS 元数据 | SDK `oauthMetadataResponse` |
| `POST` | `/register` | DCR（RFC 7591） | 是否需要「待确认」（见安全文档 §9） |
| `GET` | `/authorize` | 授权（含 consent 页） | **必须接受非 127.0.0.1 的 redirect_uri**（与现有登录 OAuth 的关键差异） |
| `POST` | `/token` | `grant_type=authorization_code\|refresh_token` | **必须支持 `grant_type`**（与现有 `/oauth/token` 的差异） |
| `POST` | `/revoke` | RFC 7009 | 可选 |
| `GET` | `/health` | 存活 | 已有 |
| `GET` | `/ready` | 就绪（含 `instance_id`） | 扩展现有 |

`/mcp` 必须：
- 校验 `Authorization: Bearer`，失败返回 401 + `WWW-Authenticate: Bearer resource_metadata="…"`
- 校验 `Host` 与 `Origin`（SDK 的 `hostHeaderValidationResponse` / `originValidationResponse`）
- 请求体上限 256 KB（MCP 请求本身不含大数据）
- 不支持 `GET` 的 SSE 长连接（第一版只要请求-响应；ChatGPT 若要求 SSE，Phase 1.3 再加）

---

## 16. 与 Local MCP 协议的对照

| 项 | Local MCP | Remote Link |
|---|---|---|
| 传输 | Unix socket / Named Pipe | WSS |
| 帧 | NDJSON（一行一帧） | 一帧一 JSON |
| 认证 | `bp_mcp_*` token（每请求查库） | `bp_dev_*` + Ed25519 握手；MCP JWT 在 HTTP 层 |
| 版本 | `protocolVersion: 1`（整数，严格相等） | `v: 1`（区间协商 + 未知字段忽略） |
| 超时 | 客户端 30s 硬编码 | `deadline_ms` 绝对时间，双层预算 |
| 取消 | 无 | `cancel` 帧 |
| 幂等 | `mcp_idempotency` 表（写工具） | 内存 LRU（只读，无需持久化） |
| 错误码 | 12 个，`{code,message}` | 16 个，`{code,message,retryable}` |
| 审计 | `mcp_operation_log` | 同表 + `channel='remote'` |

**不合并两套协议**：NDJSON 单行帧适合本地流式追加，JSON 帧 + 心跳适合长连接；
强行统一会让本地链路背上心跳与重连的复杂度，而它根本不需要。
