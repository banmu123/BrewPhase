# BrewPhase Remote MCP — 通信协议（Phase 1.0 设计，1.0.1 / 1.0.2 / 1.0.3 修订）

> 协议版本 **1.0**（线格式 `v: 1`）。状态：设计，未实现。
> 覆盖两段链路：
> **A. ChatGPT ↔ Gateway（HTTPS + MCP Streamable HTTP）**
> **B. Gateway ↔ Desktop（WSS）**
> 本文只定义 B 的完整线协议（A 由 MCP 规范约束，本文只列 Gateway 必须暴露的端点与校验）。
> 修订：**Phase 1.0.1**、**1.0.2**、**1.0.3**（均 2026-11-17），基线 `feature/remote-mcp` @ `89866cd`。

> **文档族导航**：协议族共 3 册，章节号全族唯一（如「协议 §9.1」不因拆分改变）：
> - `REMOTE_MCP_PROTOCOL.md`（本册）：§1 协议分层与版本、§2 帧总览、§3 设备注册、§4 WSS 握手、§5 心跳与在线状态
> - `REMOTE_MCP_PROTOCOL_RUNTIME.md`：§6 请求转发、§7 时间/超时/取消、§8 重复请求与缓存、§9 错误码（**§9.1 = 错误码唯一权威表**）、§10 断线检测与重连
> - `REMOTE_MCP_PROTOCOL_LIFECYCLE.md`：§11 生命周期事件、§12 多实例路由、§13 字段归属与校验、§14 完整时序示例、§15 Gateway HTTP 端点、§16 与 Local MCP 对照
> 全系列索引见 `REMOTE_MCP_INDEX.md`。
## 0.0.3 Phase 0（P0-1 / P0-2）修订摘要（本系列）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | **P0-1**：`hello_ok.scopes` → `grant_epoch` + `grants[]`；`req.grant_ctx` 必填；新增 `grant_update` / `grant_update_ack`；缓存键改 `(grant_ctx, delivery_id)` | 连接级 scope 无法区分同设备多个 MCP Client；请求帧自报 `grant_id` 会制造第二事实来源 |
| 2 | **P0-2**：新增 §15.2，明确 `jti` = Token 级、不做请求去重；`/mcp` 不加 per-request nonce | 与安全 §3.2.1 对齐，消除「重复即拒绝」的矛盾 |
| 3 | 错误码 17 → **19**（+`GRANT_CONTEXT_INVALID` / `GRANT_REVOKED`） | 新语义需要独立错误码，不能塞进 `SCOPE_DENIED` / `PROTOCOL_VIOLATION` |

## 0.0 Phase 1.0.3 修订摘要（本系列）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | §3.4 领取改为 **`POST /mcp-devices/{id}/credentials` + 请求体 `claim_secret`**，新增四条传输纪律 | query 会进反向代理 access log；凭证不该出现在 URL / 错误信息里 |
| 2 | **§2.1 术语重写**：`ts` = Unix epoch 毫秒（`Date.now()`），删除「单调 epoch 毫秒」 | 混合术语把两个互斥时钟混在一起，是实现歧义的来源 |
| 3 | **§8.5 扩展**：关闭开关时同步清空缓存 + 四个竞态场景（R1–R4）的确定行为 | 原 §8.5 只说「缓存命中在准入之后」，没定义「已有执行中请求 + 关闭开关 + 重投」 |
| 4 | §8.3 缓存表补「关闭开关时的清理」，与 §8.5 对齐 | 清理时机必须唯一 |
| 5 | §15.1 端点表补 `register` / `confirm` / `credentials` / `GET /mcp-devices` | 原表缺三个已定义的设备端点，容易被误读为「只有四个端点」 |

## 0.0.1 Phase 1.0.2 修订摘要（本系列，保留）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | `req` 新增 **`request_hash`**（§6.1 / §8.2），六种重复投递情况逐条定义（§8.3） | `delivery_id` 由 Cloud 生成，若被复用但换了内容，Desktop 会回放错的答案 |
| 2 | §8.4 缓存生命周期补全：条数 + **字节上限**、错误也缓存、占位、淘汰、断线清理、重连复用 | 原文只有「256 条 / 60s」，大结果会爆内存；错误缓存规则未定 |
| 3 | §8.5 明确「**缓存命中在准入之后**」，并给出不可调换的 8 步顺序（Phase 0 因 Grant 上下文扩至 **10 步**，顺序原则不变） | 先查缓存会让「已关开关 / scope 收紧」失效，是最隐蔽的越权路径 |
| 4 | §11.5 新增**用户切换**；§11.6 新增**轮换**（含 `rotating` 状态） | 安全 §2.6 的生命周期需要协议侧的实现约束 |
| 5 | §13.1 增列 `request_hash`，并给出与已移除 `idem` 的对照 | 两者最容易被混为一谈 |
| 6 | §6.3 明确 **`res` 不携带审计状态** | 防止把本地磁盘状态泄露给 Cloud，也防止审计失败被塞进 `res.ok` |

## 0.0.2 Phase 1.0.1 修订摘要（本系列，保留）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | §3 重写设备注册为**四凭证 + `claim_secret` 领取**，路径改 `/mcp-devices/*` | 原流程无法防「持 Bearer 的其它客户端抢先领取」 |
| 2 | §8 整节重写：**取消 `idem` 去重**，改为 `delivery_id` 重投 + 缓存 | `sha256(tool+args)` 会把两次独立查询误合并 |
| 3 | §7 明确 **epoch 用于跨进程绝对时间、monotonic 用于本地计时** | 原文档未区分，会导致「改系统时间就延长超时」 |
| 4 | §4.4 `connection_id` 明确为**连接上下文，后续帧不携带** | 原文档在 §13.1 说「后续帧必须匹配」，与 §4.4 矛盾 |
| 5 | §1.1 版本协商给出**完整公式**（含 `min` 交集判定） | 原式 `min(max_version, CLOUD_MAX)` 不完整 |
| 6 | §11 撤销顺序改为「先持久化、再异步清理」，与安全 §4.1 一致 | 原文档 §11.1 要求「先断连再清凭据」，网络失败时会让撤销失效 |
| 7 | 新增 §2.2 **未知帧处理规则** | 未知 `req` 若被静默忽略会造成永久等待 |
| 8 | §12.2 单副本**无法技术强制**，改为运维约束 + 启动断言 | 原文档写成「必须限制为 1 副本」但没给执行方式 |

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
| 接收方义务 | 必须**忽略未知字段**；未知 `type` 按 §2.2 处理（不是一律忽略） |
| 破坏性变更 | 必须递增 `v`，旧版本连接收到不支持的 `v` → close `4002` |
| 第一版 | Cloud 与 Desktop 都只实现 `v=1`，但代码必须走协商而非硬编码 |

**协商公式（完整）**：

```
clientRange = [c_min, c_max]      // hello.min_version .. hello.max_version，须 c_min ≤ c_max
serverRange = [s_min, s_max]      // Cloud 常量，v1 实现为 [1, 1]

lo = max(c_min, s_min)
hi = min(c_max, s_max)

若 lo > hi          → 无交集 → close 4002，不下发 hello_ok
否则 negotiated = hi              // 取双方共同支持的最高版本
```

第一版 `negotiated` 恒为 `1`；未来若 Cloud 支持 `[1,2]` 而 Desktop 只支持 `[1,1]`，
结果为 `1`（不是 2），连接建立但新特性不可用——这正是区间协商的意义。

---

## 2. 帧（Frame）总览

所有帧都是 **单个 JSON 对象**，UTF-8 文本帧。不用二进制帧。

公共信封：

```jsonc
{
  "v": 1,                    // 协议主版本
  "type": "hello",           // 帧类型
  "ts": 1763400000123        // Unix epoch 毫秒（Date.now()；跨进程可比，允许时钟偏差）
}
```

| type | 方向 | 用途 |
|---|---|---|
| `hello` | Desktop → Cloud | 握手（设备认证 + 版本协商） |
| `hello_ok` | Cloud → Desktop | 握手成功（下发 connection_id / 策略） |
| `ping` | Cloud → Desktop | 心跳探测 |
| `pong` | Desktop → Cloud | 心跳应答（附在途计数） |
| `req` | Cloud → Desktop | 转发一次 tool 调用（携带 `grant_ctx`） |
| `res` | Desktop → Cloud | 返回结果或错误 |
| `grant_update` | Cloud → Desktop | 授权上下文安装/撤销（**策略帧**，非业务数据） |
| `grant_update_ack` | Desktop → Cloud | 上下文变更确认（附 `grant_epoch`） |
| `status` | Desktop → Cloud | **服务能力提示**（`serviceable` + `reason`；见 §4.4.1） |
| `cancel` | Cloud → Desktop | 取消在途请求 |
| `drain` | Cloud → Desktop | 即将断开（重启/撤销前），拒绝新请求 |
| `bye` | 双向 | 优雅关闭（附原因） |

**单向约束**：Cloud 从不向 Desktop 推送「请求驱动」的**业务帧**；唯一例外是
**策略帧** `grant_update`——它只改变授权上下文，不携带任何用户数据。
Desktop 不主动发起 tool 调用。Desktop 主动的帧只有
`hello` / `pong` / `res` / `grant_update_ack` / `status` / `bye`。

**`status` 是提示帧，不是授权帧**：Cloud 可据此暂停派发，但不得据此跳过
自己的 grant/scope 校验；Desktop 也不得因为上报过 `serviceable:true`
就跳过逐请求的本地校验（§4.4.1）。

### 2.1 `ts` 的语义：Unix epoch，不是 monotonic

```
ts = Date.now()        // Unix epoch 毫秒，跨进程可比
```

**术语纪律（Phase 1.0.3 修订）**：本文不再使用「单调 epoch 毫秒」这种混合说法
——它把两个互斥的时钟混在一个词里，是实现歧义的来源。只有两个合法术语：

| 术语 | 取法 | 唯一用途 |
|---|---|---|
| **Unix epoch 毫秒** | `Date.now()` | **跨进程**：`ts`、`deadline_ms`、`trace.received_at`、`expires_at` |
| **monotonic 毫秒** | `performance.now()` | **进程内**：`duration_ms`、心跳 RTT、退避计时、本地 deadline 倒计时 |

`ts` **只用于**：握手时校验时钟偏移（±120s）、诊断排序、日志。
**不用于**计算执行耗时（见 §7.1）。每一帧都带 `ts` 是为了让 Cloud 侧能在
「没有响应」的故障里判断请求大概在哪一段丢失。

### 2.2 未知帧与畸形帧的处理规则（Phase 1.0.1 新增）

**总规则：只有 `req` 必须得到回应；其余帧可以安全忽略。**

| 收到的内容 | 处理 | 理由 |
|---|---|---|
| 未知 `type`（如未来的 `policy`） | 记 warn 后**忽略** | 前向兼容：老客户端不该因为新帧断连 |
| 已知 `type` 但 `v` 高于自身支持 | 忽略该帧（连接不关） | 同上；版本能力差异已在 `hello` 协商 |
| `res` / `pong` / `bye` 的 `id`/`seq` 未知 | **忽略** | 可能是已超时、已取消的请求的迟到响应 |
| `cancel` 的 `id` 未知 | **忽略**（幂等空操作） | 见 §7.3 |
| **`req` 的 `tool` 未知 / 参数非法 / 已过 deadline** | **必须回 `res.ok=false`** | 否则 Cloud 会一直等到超时；AI 侧只能看到「卡住」 |
| **无法解析为 JSON 的帧，但能从原文提取出 `id`** | 回 `res{ok:false, code:'PROTOCOL_VIOLATION'}` | 尽力回话，避免永久等待 |
| 无法解析且提取不到 `id` | close `4009`（帧格式非法） | 无法回话，连接上下文已不可信 |
| 单帧超过 `max_frame_bytes` | close `4009`，并记审计 | 同上 |

**`max_frame_bytes` 的两个口径（Phase 1.1B.1 定稿）**：

| 项 | 约定 |
|---|---|
| 计量单位 | **UTF-8 字节数**（`Buffer.byteLength(data, 'utf8')`），不是 JS 字符数。`data.length` 对中文会少算约 2/3 |
| 生效上限 | `min(本机 REMOTE_MAX_FRAME_BYTES, hello_ok.max_frame_bytes)`。Cloud 只能**收紧**，不能放宽——本机上限是内存保护，不该被对端协商掉 |
| 超限动作 | close `4009`，**不解析、不回显帧内容**（它可能整段是业务数据） |
| 检查位置 | 传输层，在 JSON 解析与业务准入之前 |

**Desktop 侧实现约束**：`req` 的处理必须包在 `try/catch/finally` 里，
`finally` 中保证「要么发出 `res`，要么显式记录 deliberate-drop 原因」。
不允许出现「解析失败就 return」的早退路径。

#### 2.2.1 三条「必须回话」的具体落点（Phase 1.1B.1 补齐）

上表的三行在实现里最容易写成「记一行日志然后 return」，因为那是最省事的。
它们的共同代价是：**Cloud 分不清「设备没收到」与「设备拒收」**，只能等到
deadline 超时，而超时错误（`REQUEST_TIMEOUT`，可重试）会诱导 AI 重试一次坏帧。

| 输入 | 必须做的事 | 不得做的事 |
|---|---|---|
| `req` 形状非法（未知键 / 类型错 / 缺字段），但 `id` 可用 | 回 `res{ok:false, code:'PROTOCOL_VIOLATION', retryable:false}` | 静默丢弃；执行工具；写缓存 |
| 非 JSON 文本，但能提取出 `req` 的 `id` | 同上（尽力回话） | 静默丢弃 |
| 非 JSON 且提不出 `id`；或 `req` 连 `id` 都没有 | close `4009` | 继续用一条已不可信的连接 |
| `hello_ok` 形状非法（未知键 / 缺字段） | close `4009`（帧格式非法） | 报 `4002`（那是「版本不兼容」的专属码） |
| `hello_ok` 的 `v` 不受支持 | close `4002` | 与形状错误混用同一个 code |

**「提取 id」的保守判据**（避免把业务参数里恰好叫 `id` 的字段当投递 id）：

1. 原文必须同时出现 `"type"` 与 `"req"`；
2. 取 `"arguments"` / `"tool"` **之前**的那一段里的第一个 `"id"`。

猜错的代价可控：协议规定未知 `res.id` 一律忽略，所以一个错 id 不会污染任何
真实请求的状态；而「不回话」的代价是必然的一次超时。

**审计口径（形状非法的 `req`）**：

| 情况 | 审计 |
|---|---|
| `tool` 属于 `REMOTE_TOOLS`（帧能解析出字段，只是多了/错了键） | 记 **1 行**：`success=false, error_code=PROTOCOL_VIOLATION` |
| `tool` 不可信 / 整帧不是 JSON | **不记**，只写日志 |

不记的理由不是省事：`tool_name` 这一列有语义，塞占位符会让「按工具统计」
永远对不上账。**宁可少一行，也不用不可信的数据污染审计表。**
反过来，往一个合法工具调用里塞未知键正是「篡改 WSS 载荷」最现实的形态
（序列化 bug 或中间人），所以工具名可信时**必须**留痕。

---

## 3. 设备注册（HTTPS，非 WSS）

注册不能走 WSS——设备还没有身份。用独立的 HTTPS 端点，**需要用户在场确认**，
且需要**第四个凭证 `claim_secret`** 来回答「谁有权领取 `device_token`」。

### 3.0 为什么需要 `claim_secret`

只有「确认码」时，流程是「任何持用户 Bearer 的客户端都能调
`/mcp-devices/{id}/credentials` 拿走 token」。用户 Bearer 在 Desktop 上
（`account/credentials.json`）——一台被临时接触的机器、或任何拿到 refresh token
的东西都能抢领。

`claim_secret` 的作用是**把领取权绑定到「发起注册的那个进程」**：

- 它只在 `register` 的响应里出现一次（Cloud 只存 `sha256`）
- 不落盘（仅存在 Desktop 内存里的 `pendingRegistration`）
- 领取时必须一起提交，`token_issued_at` 非空即拒（一次性）

### 3.1 流程

```
Desktop                              Cloud                      用户（Web 设置页）
  │ ① 生成 Ed25519 密钥对              │                               │
  │   私钥 → safeStorage → device.json│                               │
  │                                   │                               │
  │ ② POST /mcp-devices/register      │                               │
  │   Bearer <用户 access token>       │                               │
  │   {name, platform, public_key,    │ 校验 Bearer / pubkey 长度 /    │
  │    app_version}                   │ 设备数上限                     │
  ├──────────────────────────────────>│ 建 mcp_devices(status=pending) │
  │                                   │ 存 confirm_code_hash +         │
  │                                   │    claim_secret_hash           │
  │ {device_id, confirm_code,         │ 均 300s 过期                   │
  │  claim_secret, expires_in: 300}   │                               │
  │<──────────────────────────────────┤                               │
  │ 界面显示 confirm_code              │                               │
  │ claim_secret 只留内存              │                               │
  │                                   │<──────────────────────────────┤ 输入 6 位码
  │                                   │ POST /mcp-devices/{id}/confirm │
  │                                   │ status: pending → active       │
  │                                   │──────────────────────────────>│
  │ ③ POST /mcp-devices/{id}/credentials                              │
  │   Bearer <用户 access token>       │                               │
  │   Body: {claim_secret}（不放 URL） │                               │
  ├──────────────────────────────────>│ 三重校验 + 条件 UPDATE         │
  │ {device_token, expires_at}        │ (token_issued_at IS NULL)      │
  │<──────────────────────────────────┤ 写 token_hash、issued_at       │
  │ ④ 落盘：device_token + 私钥一起加密 │                               │
  │ ⑤ WSS 握手（Ed25519 签名证明持钥）  │                               │
```

### 3.2 `POST /mcp-devices/register`

```jsonc
// request（Header: Authorization: Bearer <用户 access token>）
{
  "name": "banmu 的 MacBook Pro",
  "platform": "darwin",
  "public_key": "<base64url(32B Ed25519 raw)>",   // 43 字符
  "app_version": "0.1.5"
}
// 200
{
  "device_id": "0b7c9e2a-…",     // Cloud 生成 uuid，不接受客户端自报
  "confirm_code": "492817",      // 6 位数字，展示给用户
  "claim_secret": "<base64url(32B)>",  // **只在这一次响应里出现**
  "expires_in": 300
}
```

校验与失败：

| 校验 | 失败响应 |
|---|---|
| Bearer 有效（现有 `verifyAccessToken`） | 401 `invalid_token` |
| `public_key` 解码后 == 32 字节 | 400 `invalid_public_key` |
| 该 user `active + pending` 设备数 < 5 | 429 `device_limit` |
| 同 `(user_id, public_key)` 无未撤销行 | 409 `device_exists`（不新建，提示「此设备已注册，请撤销后重试」） |

`status=pending` 的设备**不能**握手（`hello` → `DEVICE_UNAUTHORIZED`）。

### 3.3 `POST /mcp-devices/{id}/confirm`

Web 设置页调用（Bearer 用户 token）。

```jsonc
// request
{ "confirm_code": "492817" }
// 200
{ "device_id": "0b7c…", "status": "active" }
```

| 校验 | 响应 |
|---|---|
| `user_id` 不匹配 / 设备不存在 | 404 `device_not_found`（**两者完全一致**，不泄露存在性） |
| `status == 'active'` | **200 幂等**（返回 `{status:'active'}`，不再校验确认码） |
| `status ∈ {suspended, revoked}` | 409 `invalid_device_state` |
| `now >= expires_at`（仅 pending） | 410 `confirm_expired` |
| 确认码不匹配 | 400 `invalid_confirm_code`；第 5 次失败时该行转 `revoked` |
| 并发两个正确码 | 只有一条 UPDATE 命中；另一个按当前状态返回 200 幂等 |

> **Phase 1.2A 修订（原文自相矛盾）**：原表把「已 active」写成
> `409 already_active（幂等：已 active 直接返回 200）`——同一格既是 409 又是 200。
> 取**幂等 200**：确认码在激活那一刻就完成使命，用户重复点确认不该报错。
> `409` 保留给 `suspended` / `revoked` 这类确实不能再确认的状态。
>
> 同时明确两条实现要求：
> - **计数必须原子**：单条 UPDATE 里 `confirm_attempts + 1` 在所有 SET 表达式中
>   读的都是旧值，因此「自增」与「是否越线」用同一个基准。拆成
>   「读计数 → 判断 → 写回」会让两个并发请求都读到 4。
> - **触顶后对外仍是同一个错误**（`invalid_confirm_code`）：否则攻击者能靠
>   错误码的变化判断自己离锁定还有几次。

### 3.4 `POST /mcp-devices/{id}/credentials`

Desktop 轮询（1s 间隔，最多 300s）。

```
POST /mcp-devices/{id}/credentials
Authorization: Bearer <用户 access token>
Content-Type: application/json

{ "claim_secret": "<base64url(32B)>" }
```

**必须用 POST 请求体，不得用 `GET ...?claim=<claim_secret>`。（Phase 1.0.3 修订）**

| 原因 | 说明 |
|---|---|
| URL 会进日志 | 反向代理、`access_log`、浏览器/客户端诊断、错误上报、崩溃转储都会记录完整 URL 与 query |
| 请求体可控 | 凭证请求体由服务端显式声明为「不记录」，见下方传输纪律 |
| 语义正确 | 领取是「提交一个秘密换凭证」的状态变更动作，不是幂等读取 |

**凭证传输纪律（四条，全部为硬要求）**：

1. `claim_secret` **只**出现在请求体与 ② 的注册响应体中；
   **不得**放入 URL path、query、header 名、cookie、错误信息或任何重定向的 `Location`。
2. HTTP 访问日志**不得**记录凭证类请求体。落地方式：该路由强制 `Content-Type: application/json`
   且日志中间件按「路径 + 方法」白名单跳过 body 记录（不是按字段名猜）。
3. 错误响应**不得回显** `claim_secret` 或它的任何片段；`claim_mismatch` 只返回固定文案。
4. Cloud **只存 `sha256(claim_secret)`**，不存明文、不存可逆编码、不存长度以外的派生信息。

**Cloud 三重校验**（顺序与内容均不变）：

| # | 校验 | 失败响应 |
|---|---|---|
| 1 | Bearer 的 `sub` == `mcp_devices.user_id` | 404 `device_not_found`（统一话术，不区分「不是你的」与「不存在」） |
| 2 | `constantTimeEqual(sha256(claim), claim_secret_hash)` | 403 `claim_mismatch` |
| 3 | `status='active' AND token_issued_at IS NULL` | 409 `credentials_already_issued` |

**「还没确认」不是错误（Phase 1.2A 补齐，原文缺失）**：

| 设备状态 | 响应 | 理由 |
|---|---|---|
| `pending` 且未过期 | **202** `{status:'pending', retry_after_ms:1000}` | Desktop 的轮询把 4xx 当作**终态失败**。若 pending 也回 4xx，一次完全正常的注册会在第一次轮询（注册后 1 秒）就死掉——而「等用户点确认」恰恰是这条路径的常态 |
| `pending` 且已过期 | 410 `confirm_expired` | 这一行确实没救了，必须让客户端停 |
| `suspended` | 409 `invalid_device_state` | 用户主动暂停，不该悄悄恢复 |
| `revoked` | 404 `device_not_found` | 与「不存在」一致：已撤销的设备不确认自己存在过 |

> **顺序不可交换**：第 2 步（claim 校验）必须在第 3 步（状态判断）**之前**。
> 反过来的话，「claim 错」与「状态不对」会得到同一个错误，等于白送攻击者
> 一个 claim 正确性探针——他可以拿错误的状态去试 claim，靠响应差异反推。

**原子领取（防重复与竞态的唯一可靠方式）**：

```sql
UPDATE mcp_devices
   SET token_hash = $1, token_issued_at = now()
 WHERE id = $2 AND token_issued_at IS NULL AND status = 'active'
RETURNING id;
-- 返回 0 行 → 409；返回 1 行 → 下发明文 token
```

不能用「先 SELECT 检查、再 UPDATE」——两个并发请求都会读到 `NULL`。
也不需要在 Cloud 保存明文：`$1` 是本次生成的 token 的 sha256，明文只在响应体里出现一次。

> **方法变更（Phase 1.0.3）不改变任何语义**：三重校验、条件 UPDATE 的原子性、
> 一次性领取、300s 过期、全部失败码都与 1.0.2 逐字一致。**唯一变化是凭证载体**
> ——从 URL query 换成 JSON 请求体。因此「一次性领取」的判据仍然是
> `RETURNING` 的行数，不是请求方法。

响应：

```jsonc
{ "device_token": "bp_dev_…", "expires_at": 1765992000000 }
```

- 重复请求 → `409 credentials_already_issued`（**不补发**）。
- 丢失 → 删除本地 `remote/device.json`，重新走 ②③④（得到新 `device_id`），
  旧设备在 Web 删除。

### 3.5 其他设备端点

| 方法 | 路径 | 认证 | 用途 |
|---|---|---|---|
| `POST` | `/mcp-devices/register` | 用户 Bearer | 注册，返回 `confirm_code` + `claim_secret`（§3.2） |
| `POST` | `/mcp-devices/{id}/confirm` | 用户 Bearer | 用户确认码，`pending → active`（§3.3） |
| `POST` | `/mcp-devices/{id}/credentials` | 用户 Bearer + 请求体 `claim_secret` | 一次性领取 `device_token`（§3.4） |
| `GET` | `/mcp-devices` | 用户 Bearer | 列出当前用户设备（不含 token / claim） |
| `POST` | `/mcp-devices/{id}/rotate` | **现有 device_token** + Ed25519 签名（覆盖新公钥） | 轮换；成功后 close `4010` |
| `POST` | `/mcp-devices/{id}/suspend` | 用户 Bearer 或 device_token | 用户关闭远程开关 |
| `POST` | `/mcp-devices/{id}/resume` | 用户 Bearer | 重新打开（需 status != revoked） |
| `DELETE` | `/mcp-devices/{id}` | 用户 Bearer | 撤销（不可恢复；`pending` 也可删） |
| `POST` | `/mcp-devices/{id}/heartbeat` | — | **不提供**，见 §5.3 |

**轮换的签名内容**（防止只拿到 token 就能换钥匙）：

```
rotate_sig_msg = "brewphase.remote.rotate.v1\n" + device_id + "\n" + new_public_key + "\n" + ts
签名用**旧私钥**；Cloud 用**旧公钥**验签通过后才替换
```

`POST /mcp-devices/{id}/rotate`（Header: `Authorization: Bearer <旧 device_token>`）：

```jsonc
// request
{ "new_public_key": "<base64url(32B)>", "ts": 1763400000000, "sig": "<base64url>" }
// 200
{ "device_token": "bp_dev_<新>", "expires_at": 1765992000000 }
```

**新 `device_token` 必须在响应里返回**（否则轮换后设备无法重连）——
明文只在这一个响应里出现一次，Cloud 只存 `sha256`。旧 token 的哈希被同一
条 UPDATE 覆盖，立即失效。响应返回后再 close `4010`。Desktop 侧必须
**先落盘新凭据、再重连**，顺序反了会丢掉唯一一次下发的 token。

**Phase 1.2B.2.1 的实现顺序（`cloud/src/mcp-devices/rotate.ts` + `link-server.ts`）**：

```
① 旧 token → 设备行；路径 id 必须与行 id 相同（否则 404，不给存在性探针）
② status=active（revoked/suspended → 409，两者处置完全不同）
③ token_expires_at > now（过期 → 401）
④ 新公钥是**规范**的 32 字节（字符集 + 长度 + 重编码逐字相同）
⑤ |now - ts| ≤ 120s
⑥ 用**旧公钥**验签（缺任一步都不构成"证明持有旧私钥"）
⑦ 事务：SELECT ... FOR UPDATE → 重验 token_hash/status/token_expires_at
   → 同一条 UPDATE 写 public_key + token_hash + token_issued_at +
     token_expires_at + key_rotated_at
⑧ COMMIT 之后：标 rotating → 从路由表摘除 → bye(rotated) → close 4010
```

三处不能动：

| 约束 | 理由 |
|---|---|
| **④ 早于 ⑥** | 新公钥进了签名原文。先拒一个不可能是合法公钥的输入，且「公钥形态错」（客户端 bug）与「签名错」（攻击）是两种故障，错误码必须分开 |
| **⑦ 是 `FOR UPDATE` + 重验** | ①–⑥ 读的是**快照**。并发的第二个轮换会在此处读到已被覆盖的 `token_hash` → 401。串行与并发的错误面因此一致 |
| **⑧ 在 COMMIT 之后** | 先断连接再改库会留下「旧连接已死、旧凭据仍有效」的窗口——攻击者能拿旧 token 重新握手。清理失败**不回滚**已提交的轮换 |

轮换与 `suspend` / `revoke` / 握手准入争的是**同一把行锁**（`UPDATE mcp_devices`
无条件持有它），所以四者天然串行，不需要第二套互斥。

### 3.6 过期与清理

- `expires_at = now + 300s`，`confirm_code_hash` 与 `claim_secret_hash` 同时失效。
- 复用现有 `startSweep(ctx, 60_000)`（`cloud/src/app.ts` 里已在跑）追加一条：
  `DELETE FROM mcp_devices WHERE status='pending' AND expires_at < now()`。
- 用户主动取消 = `DELETE /mcp-devices/{id}`（pending 也能删）。

---

## 4. WSS 握手

### 4.1 连接

```
wss://<gateway-host>/device-link
```

- **只接受** `Authorization: Bearer bp_dev_…`（放 header，不放 query——
  query 会进反向代理的 access log）。
- 服务端必须校验 `Host`（`hostHeaderValidationResponse` 的语义），拒绝与配置不符的连接。
- 子协议：`Sec-WebSocket-Protocol: brewphase.remote.v1`（便于未来并行支持多版本）。

#### 4.1.1 Upgrade 预检的四条边界（Phase 1.2B.1 定稿）

Upgrade 是**普通 HTTP 请求**，所以它的失败是 HTTP 状态码，不是 close code。
两者不能混用：对未升级的 socket 发 close frame，对端只会看到一段乱码响应；
而对已升级的连接回 401，客户端会当成网络错误无限重连。

| 检查 | 拒绝方式 | 说明 |
|---|---|---|
| path 精确等于 `/device-link` | 404 | 前缀/尾斜杠都不接受 |
| **path 带任何 query** | 400 | 见下 |
| `Host` 命中配置白名单 | 403 | **只看 `Host`，不看 `X-Forwarded-Host`** |
| `Origin`（若存在）命中白名单 | 403 | 不存在则放行（原生客户端） |
| `Sec-WebSocket-Protocol` 含 `brewphase.remote.v1` | 400 | |
| `Authorization` 形态匹配 `^bp_dev_…` | 401 | 只做形态，**不查库**（见下） |

三条实现取舍：

1. **任何 query 一律 400**。这不是洁癖：`?token=…` 会被反向代理的 access log
   原样记下来。让「把凭证放进 URL」在协议层就无法表达，比靠 review 保证可靠。
2. **Host 比较忽略端口**。端口不是安全边界（连接已经落在监听者身上），
   DNS rebinding 的判据是 hostname。因此 `Host: 127.0.0.1:3100` 与白名单里的
   `127.0.0.1` 视为匹配。
3. **token 的哈希查库不在 Upgrade 做**。它要读数据库，而 Upgrade 阶段没有
   连接上下文可以挂超时与审计；把 IO 放在这里会让一个慢查询卡住整个 upgrade
   队列。形态检查（同步、无状态）在 Upgrade，哈希命中在握手第 2 步。

**Desktop 侧的承载方式（Phase 1.1B.1 实测并定稿）**：用 Electron 主进程的
`net.WebSocket(url, { headers, protocols })`。Spike（Electron 45.2.3 真实主进程）
实测结果：

| 能力 | `net.WebSocket` | 全局 `WebSocket` |
|---|---|---|
| 自定义 header 送达 | ✅ 服务端收到完整 `Bearer` | ❌ 标准 API 无此能力 |
| 子协议送达 | ✅ | ✅ |
| 服务端发起的 4xxx close code | ✅ 精确到达（需完整关闭握手） | ✅ |
| TLS 失败时的行为 | `net::ERR_INSECURE_RESPONSE`，**服务端连 header 都收不到** | 同 |

因此实现是 **fail-closed** 的：需要自定义头却拿不到 `electron.net` 时直接抛错，
**绝不静默退回全局 WebSocket**。那种「退回」会让设备认证在测试里等于没做，
而所有用例仍然是绿的——这正是本阶段要消灭的那类假通过。

> **反向教训（记录在此以免重犯）**：Phase 1.1B 的连接层签名是
> `connect(url)`，`headers` 参数在类型里存在、在实现里被丢弃，而 Mock Gateway
> 无条件返回 `101`。于是「设备认证」整条链路在两侧都没实现，测试却全绿。
> 现在两侧都补上了：Mock 按 §4.3 前 3 步 + 子协议拒绝非法 Upgrade，
> 测试用真实发送 header 的最小客户端驱动（`tests/helpers/ws-client.ts`）。

### 4.2 `hello`（Desktop → Cloud，连接后 5s 内必须发）

```jsonc
{
  "v": 1,
  "type": "hello",
  "ts": 1763400000123,
  "device_id": "0b7c…",
  "nonce": "base64url(16B random)",   // 每次握手唯一
  "min_version": 1,                    // §1.1 协商公式的输入
  "max_version": 1,
  "app_version": "0.1.5",              // 排障用，不参与授权
  "platform": "darwin",                // 同上
  "capabilities": ["cancel", "drain", "tools.call"],
  "serviceable": true,                 // Desktop 独占的自检结果（§4.4.1）
  "sig": "base64url(Ed25519(规范串))"
}
```

`device_token` **不放进 `hello`**——它已在 header 里，重复传递只会增加泄漏面。

#### 4.2.1 签名规范串（Phase 1.1B.1 定稿，唯一实现）

**除 `sig` 之外，`hello` 的每个字段都进签名**，顺序固定，`capabilities` 排序后
以 `,` 连接：

```
brewphase.remote.hello.v1
v=1
type=hello
ts=1763400000123
device_id=0b7c…
nonce=<base64url>
min_version=1
max_version=1
app_version=0.1.5
platform=darwin
capabilities=cancel,drain,tools.call
serviceable=true
```

四条硬要求：

| # | 要求 | 为什么 |
|---|---|---|
| 1 | 首行是域分隔串 `brewphase.remote.hello.v1` | 没有它，同一把私钥在别处签的消息（例如 §3.5 的 rotate）可能与 hello 同形，形成**跨协议签名复用** |
| 2 | 签名覆盖 `min_version` / `max_version` / `capabilities` | 不覆盖就能被篡改成「这台设备只支持老版本」，从而关掉它本可用的保护 |
| 3 | 字段值**不得含换行**；含则拒绝生成签名 | 规范串是「换行 + `=`」分隔的，值里带换行会让两组不同字段产生同一段字节（规范歧义） |
| 4 | v1 的字段集合冻结 | 新增字段属兼容变更，但**必须**同时定义新前缀（`brewphase.remote.hello.v2`），否则新旧实现的签名会静默错配 |

**旧写法作废**：Phase 1.0 写的「只签 `device_id + '\n' + nonce + '\n' + ts`」
不覆盖版本与能力，已废弃。Desktop 与 Mock 现在共用同一个
`helloSigningPayload()`；实现漂移由结构测试逐键比对
（`tests/integration/remote-handshake.test.ts`）。

#### 4.2.2 `serviceable` 与版本字段为什么同时存在

两者解决的不是同一件事：

- `min_version` / `max_version` 决定**这条连接能不能用**（§1.1 协商）；
- `serviceable` 决定**能不能派活**（§4.4.1）。

1.1B 的实现只带了后者、1.0 的文档只带了前者，所以两边都不完整：缺区间时
§4.3 第 8 步无从执行，缺 `serviceable` 时 Cloud 只能按「连上了」派发。

### 4.3 Cloud 侧校验顺序（任一失败即 close）

顺序是**安全性的一部分**：先做便宜的、无状态的检查，再做验签，
**最后**才做有状态、会「消耗」nonce 的检查。

```
1. Authorization header 存在且匹配 `^bp_dev_[A-Za-z0-9_-]{16,}$` → 否则 4001（Upgrade 阶段，HTTP 401）
2. sha256(token) 命中 mcp_devices.token_hash        → 否则 4001
3. status = 'active'（pending→4001 / suspended→4005 / revoked→4003）
4. **mcp_devices.token_expires_at > now**           → 否则 4001
5. |cloud_now - ts| ≤ 120_000                       → 否则 4001
6. Ed25519 验签（mcp_devices.public_key）            → 否则 4001
7. **原子** nonce check-and-record（120s 窗口）      → 否则 4001（replay）
8. 版本区间有交集（§1.1 公式）                        → 否则 4002
9. 该 user 已有活跃连接？→ 按 §4.6 顶替
10. 构造 `hello_ok`：取该 user 中 `grant.user_id == device.user_id` 且
    `revoked_at IS NULL` 的 grant，生成 `grant_ctx` + 设备级 `grant_epoch`（§6.5）
```

> **第 4 步是 `token_expires_at`，不是 `expires_at`（Phase 1.2B.1 修正）**。
> 原文写的是 `mcp_devices.expires_at > now`，那是 **pending 注册窗口**
> （注册后 300 秒内必须确认 + 领取）。用它判断已领取设备，会让**每一台正常
> 设备在注册 5 分钟后全部被判死**——因为该字段在领取之后再也没有被推进过。
>
> 三个时间字段的分工（混用即 bug）：
>
> | 字段 | 含义 | 谁读 |
> |---|---|---|
> | `expires_at` | pending 窗口 | 确认、领取、sweep |
> | `token_issued_at` | 首次领取时刻（非空 = 已领取） | 一次性领取的判据 |
> | `token_expires_at` | device_token 寿命（30 天） | **WSS 握手第 4 步** |
>
> 回归锁在 `cloud/tests/link/link-server.test.ts`：同一个用例里
> `expires_at` 已过期而 `token_expires_at` 有效，必须**允许**握手。

**第 7 步的原子性要求**：`nonceStore.checkAndRecord(nonce)` 内部的
「查存在 + 记录」之间**不得有 `await`**。若拆成 `has()` 然后 `await something`
再 `set()`，两个并发的重放请求都能通过。

Cloud 侧实现见 `cloud/src/link/nonce-store.ts`（**进程内**、有界、fail-closed）：

| 性质 | 实现 |
|---|---|
| 原子性 | 公开方法**没有 async**（结构保证，不是纪律） |
| 时钟 | monotonic（`performance.now()`）；`Date.now()` 被回拨会让过期项「复活」 |
| 容量 | 8192；**到达上限拒绝新 nonce**，绝不驱逐仍有效项 |
| 容量耗尽的响应 | close **1011**（不是 4001）——它既不是重放也不是凭据错误，而 4001 会让 Desktop 清掉本地私钥 |
| 重启 | 表随进程消失（如实记录）。代价仅限「重启前发出的 nonce 可再用一次」，且换来的只是一条新连接，不是任何数据 |

**为什么验签（6）在 nonce（7）之前**：先用公钥挡掉无效请求，避免攻击者用随机
nonce 灌满去重表。反之（先记 nonce 再验签）会让未认证的流量消耗内存。

**为什么把版本（8）放在最后**：版本不匹配是「双方都合法但能力不同」，
不应因为版本问题而消耗 nonce 之外的区别对待——但此时连接即将关闭，
nonce 已被记录也无害（下次握手是新 nonce）。

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
  "allowed_tools": [                   // Cloud 视图的白名单（连接级上限）
    "search_records", "get_record", "list_record_tags",
    "list_beans", "list_brews", "list_tastings",
    "list_canvases", "get_canvas"
  ],
  "grant_epoch": 7,                    // 本设备授权上下文代数，单调递增（§6.5）
  "grants": [                          // 全量快照；空数组 = 当前无任何授权
    {
      "grant_ctx": "gc_01J8Z9K2M4",   // 不透明引用，`req.grant_ctx` 用它
      "grant_id": "grt_01J8Z9K2M4",
      "client_id": "chatgpt",
      "client_name": "ChatGPT",
      "scopes": ["records:read", "coffee:read"],
      "bound_user_id": "u-8f21c3",    // 与 device.boundUserId 比对
      "epoch": 3                       // 该 grant 自身的版本
    }
  ]
}
```

**`hello_ok.scopes` 已删除（Phase 0 / P0-1）**：连接级 scope 无法区分同一设备上的
多个 MCP Client；保留它会制造第二个事实来源。scope 只在 `grants[].scopes` 里。

Desktop 收到后必须**先原子替换整张上下文表**，再处理下一条帧；然后逐 grant 取交集：

```
effective_scopes(grant) = grant.scopes ∩ REMOTE_SCOPES ∩ 本地允许集
effective_tools(grant)  = REMOTE_TOOLS ∩ hello_ok.allowed_tools
                          ∩ toolsForScopes(effective_scopes(grant))
```

`REMOTE_TOOLS` 是 Desktop 侧**写死的 8 个**常量（不是从 `TOOL_DEFINITIONS` 过滤
出来的），所以 "Cloud 给了更多" 或 "Local 新增了工具" 都不会扩张远程面。
`grants` 为空数组 → 仍然保持连接（让 Cloud 能下发新授权），但对任何 `req` 返回
`GRANT_CONTEXT_INVALID`。

#### 4.4.1 `serviceable` 的方向（Phase 1.1B 新增，**方向不可反**）

「连上了」不等于「能干活的」。参考实现曾为此付出代价：服务端按 `status=online`
派发，而设备本地执行器已死，导致整批调用被拒且没有一次成功。

因此本协议把三个概念分开，且**方向严格单向**：

| 概念 | 谁判定 | 含义 |
|---|---|---|
| `connected` | 双方各自 | WSS 已建立并通过握手 |
| `authorized` | Desktop | `bound_user_id` 匹配、`grant_ctx` 有效、`epoch` 当前 |
| **`serviceable`** | **Desktop 独占** | 本地具备执行条件：开关 on、用户匹配、业务库就绪、五个 Service 已装配、未处于停止/blocked |

**`serviceable` 只能由 Desktop 上报，不能由 Cloud 设置。**
方向是 Desktop → Cloud，载体是 **`hello` 帧的 `serviceable` 字段**：

```jsonc
// hello（Desktop → Cloud，完整字段见 §4.2）
{
  "v": 1, "type": "hello",
  "device_id": "0b7c…",
  "nonce": "…", "ts": 1763400000000,
  "min_version": 1, "max_version": 1,
  "app_version": "0.1.5", "platform": "darwin",
  "capabilities": ["cancel", "drain", "tools.call"],
  "serviceable": true,        // ← 本连接建立时 Desktop 的自检结果
  "sig": "…"
}
```

后续变更用 **`status` 帧**（Desktop → Cloud，已有帧型，不是新帧）：

```jsonc
{ "v": 1, "type": "status", "ts": 1763400100000, "serviceable": false, "reason": "remote_disabled" }
```

- `reason` ∈ `remote_disabled` / `user_mismatch` / `db_unavailable` / `services_unavailable` / `shutting_down` / `blocked`。
  （`blocked` 是 Phase 1.1B.1 新增：设备被撤销 / 需重新配对时，本地确实不具备
  执行条件，如实上报；新增枚举值属兼容变更，接收方应忽略未知值。）
- 语义是**提示**：Cloud 可以据此停止派发（推荐），但**不得**据此跳过自己的
  grant/scope 校验；Desktop 也**不得**因为上报过 `true` 就跳过逐请求本地校验。
- `hello_ok`（Cloud → Desktop）**没有** `serviceable` 字段——它是 Cloud 的帧，
  不能承载 Desktop 的自报状态。这是「方向不可反」的具体含义。
- `hello` 未知键一律 `PROTOCOL_VIOLATION`（闭合键集，§2.1）。

**为什么不动态上报工具清单**：`REMOTE_TOOLS` 必须是 Desktop 写死的 8 个常量。
一旦允许 Cloud 通过 `allowed_tools` 或任何动态字段扩张工具面，
「Cloud 被攻破最多只能多读一点」的损害上限就不成立了（安全 §2.7.7）。

### 4.5 `connection_id` 的位置（Phase 1.0.1 明确）

**`connection_id` 只属于连接上下文，仅在 `hello_ok` 里出现一次；
后续任何帧都不得携带，也不需要携带。**

理由：

- 一个 WSS 连接对应唯一 `connection_id`，由 Cloud 在建连时生成并绑定到 socket。
  每帧重复携带等于把「身份」放进消息体，制造了一个可以伪造/错配的字段。
- Desktop 若收到带 `connection_id` 的帧，且该值与握手时不同 → `PROTOCOL_VIOLATION`，
  记审计；相同则忽略该字段。
- Cloud 侧在路由前用 socket → session 查 `connection_id`，不与帧内容比对。

Phase 1.0 §13.1 写的「后续帧必须匹配 `connection_id`」作废。

### 4.6 同用户多连接

- 第一版：**只允许一个活跃连接**。第二条 `hello` 到达时按以下顺序：
  1. 先 `bind` 新连接（原子替换路由表项，新的立即生效）
  2. 向旧连接发 `drain{grace_ms:0}` 后立即 close `4006 SUPERSEDED`
  3. 旧连接的 Desktop 收到 `4006` → **不重连**，界面显示「另一台设备已接管」
- 先 bind 再断旧，是为了避免「旧连接已死、新连接还没进表」的空窗（§12.4）。
- 多设备并行属 Phase 1.4，需要 `mcp_devices.is_primary` 与用户选择（OQ-9）。

**Phase 1.2B.1 的实现约束（`cloud/src/link/connection-registry.ts`）**：

| 约束 | 为什么 |
|---|---|
| 路由键是 `userId`，表项里记 `deviceId` | 「每用户一条」是协议规则；键成 `(user, device)` 就允许同用户两条并存 |
| `lookup(userId, deviceId)` 在 deviceId 不匹配时返回 `null` | 顶替之后旧设备**不能借到**新连接，否则请求会打到别人的会话上 |
| `unbind` 必须同时比对 `deviceId` 与 `connectionId` | 旧连接的 close 回调到达顺序没有任何保证；只按 user 删会把**新**连接删掉，而新连接还活着 |
| `bind` 返回 `displaced` | 顶替动作由调用方驱动（发 drain 再 close），注册表不碰 socket |
| 实现同步、接口异步 | Phase 1.4 换 Redis 时调用方不用改；而**实现里不 await** 是「先 bind 新再断旧」原子性的前提 |

### 4.7 握手失败的 close code

见 §9。**失败时不下发任何业务信息**，错误详情只进 Cloud 日志（含 device_id 前缀）。

---

### 4.8 Cloud 的派发入口（Phase 1.2B.2.2）

Cloud 侧**唯一**的派发入口是 `LinkControl.dispatchToolCall`（`cloud/src/context.ts`）：

```ts
dispatchToolCall({
  userId,          // 只能来自已验证的 MCP JWT `sub`
  grantId,         // 只能来自已认证的授权上下文
  tool, arguments,
  clientDeadline?, // 只能收紧预算，不能延长
  signal?,         // 调用方取消
  trace?
}): Promise<DispatchResult>
```

三条**刻意不暴露**的东西，每一条都对应一类真实事故：

| 不暴露 | 暴露了会怎样 |
|---|---|
| `connectionId` / socket | HTTP 路由会开始「顺手拿连接做点别的」，绕过准入 |
| `grant_ctx` | 调用方可以指定任意上下文 → `grant_ctx` 变成可猜的授权引用 |
| `deviceId` | 派发变成「指名道姓发给某台设备」，而正确的问题是「这个用户此刻在哪台设备上」 |

`grant_ctx` 由 Cloud 从**当前连接**的上下文表里按 `grantId` 反查得到；反查不到
就是 `GRANT_CONTEXT_INVALID`——这同时覆盖了「握手后才新增的 grant」与
「scope 变更后的旧上下文」两种情形。

**`/mcp` 本身仍属 Phase 1.3。** 本阶段只把内部入口做对：它已经是一个可以被
OAuth 授权层直接调用的、无状态的语义接口。

## 5. 心跳与在线状态

### 5.1 心跳

```jsonc
// Cloud → Desktop，每 heartbeat_ms 一次
{ "v": 1, "type": "ping", "ts": 1763400020000, "seq": 17 }

// Desktop → Cloud
{ "v": 1, "type": "pong", "ts": 1763400020012, "seq": 17, "inflight": 1 }
```

- `seq` 回显，Cloud 用**单调时钟**算 RTT（`performance.now() - pingSentAt`），
  写指标不写库。
- **连续 3 次未收到 `pong`（默认 60s）→ close `4008 HEARTBEAT_TIMEOUT`**，
  并把该连接从路由表删除、`mcp_devices.last_seen_at` 更新为最后成功 `pong` 的时间。

**Phase 1.2B.1 的实现细节（`cloud/src/link/heartbeat.ts`）**：

| 判据 | 说明 |
|---|---|
| 空闲基准 = **连接建立时刻** | 旧写法在 `lastPongAt === null` 时直接 return，于是「握手成功但再没收到 pong」这种最常见的半开连接（NAT 超时、LB 掉表）永远不会被判死 |
| 双判据 | `missed >= 3` **且** `now - lastValidPong >= idle_timeout_ms`，任一条成立即 close 4008。前者抓「ping 有发但没回应」，后者抓「定时器被节流/没跑」 |
| pong 的 `seq` 必须等于**最近一次** ping | 迟到的 pong 不能证明此刻链路还通；错误 seq 不计入、也不刷新 |
| 其他帧不算心跳 | 只回 `status` 而不回 `pong` 的客户端会正常被判死——「上行已断」正是最需要发现的那种故障 |
| RTT 用 monotonic | `Date.now()` 一次 NTP 回拨就能把 RTT 变成负数或几十秒 |
| `last_seen_at` 只在有效 pong 后写 | 协议原文如此；写库失败只记日志，不影响连接 |
| 关闭必清 timer | 心跳超时、对端 close、我们主动断开、停机，四条路都走同一个幂等收敛 |
- Desktop 侧若 90s 未收到任何 `ping`（Cloud 卡死/半开连接），主动 close 并重连。
  这条是必需的：只靠 Cloud 单向探测，NAT 半开时 Desktop 会永远「以为在线」。

### 5.2 在线状态判定

在线状态是**连接事实的投影**，不是独立字段（与安全 §4.0 的 S3 对应）：

| 判定 | 结论 |
|---|---|
| 路由表有 `(user_id, device_id)` 且 `now - last_pong_at < 60s` | `online` |
| 路由表无此项 | `offline` |
| 有连接但 `mcp_devices.status='suspended'` | 连接应已被断开；若仍存在视为异常，转发时按 `DEVICE_SUSPENDED` 拒 |

**在线状态只来自连接事实，不由 Desktop 上报。** Desktop 说「我在线」不可信，
也不必要——有连接就是在线的定义。

### 5.3 心跳与 HTTP 的关系

`POST /mcp-devices/{id}/heartbeat` **不提供**。两套心跳会产生两个「在线」概念，
必然有一天不一致。在线 = WSS 有连接，唯一的真相在 Cloud 的连接管理器里。
