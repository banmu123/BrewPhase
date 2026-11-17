# BrewPhase Remote MCP — 通信协议（Phase 1.0 设计，1.0.1 / 1.0.2 / 1.0.3 修订）

> 协议版本 **1.0**（线格式 `v: 1`）。状态：设计，未实现。
> 覆盖两段链路：
> **A. ChatGPT ↔ Gateway（HTTPS + MCP Streamable HTTP）**
> **B. Gateway ↔ Desktop（WSS）**
> 本文只定义 B 的完整线协议（A 由 MCP 规范约束，本文只列 Gateway 必须暴露的端点与校验）。
> 修订：**Phase 1.0.1**、**1.0.2**、**1.0.3**（均 2026-11-17），基线 `feature/remote-mcp` @ `89866cd`。

## 0.0 Phase 1.0.3 修订摘要（本文）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | §3.4 领取改为 **`POST /mcp-devices/{id}/credentials` + 请求体 `claim_secret`**，新增四条传输纪律 | query 会进反向代理 access log；凭证不该出现在 URL / 错误信息里 |
| 2 | **§2.1 术语重写**：`ts` = Unix epoch 毫秒（`Date.now()`），删除「单调 epoch 毫秒」 | 混合术语把两个互斥时钟混在一起，是实现歧义的来源 |
| 3 | **§8.5 扩展**：关闭开关时同步清空缓存 + 四个竞态场景（R1–R4）的确定行为 | 原 §8.5 只说「缓存命中在准入之后」，没定义「已有执行中请求 + 关闭开关 + 重投」 |
| 4 | §8.3 缓存表补「关闭开关时的清理」，与 §8.5 对齐 | 清理时机必须唯一 |
| 5 | §15.1 端点表补 `register` / `confirm` / `credentials` / `GET /mcp-devices` | 原表缺三个已定义的设备端点，容易被误读为「只有四个端点」 |

## 0.0.1 Phase 1.0.2 修订摘要（本文，保留）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | `req` 新增 **`request_hash`**（§6.1 / §8.2），六种重复投递情况逐条定义（§8.3） | `delivery_id` 由 Cloud 生成，若被复用但换了内容，Desktop 会回放错的答案 |
| 2 | §8.4 缓存生命周期补全：条数 + **字节上限**、错误也缓存、占位、淘汰、断线清理、重连复用 | 原文只有「256 条 / 60s」，大结果会爆内存；错误缓存规则未定 |
| 3 | §8.5 明确「**缓存命中在准入之后**」，并给出不可调换的 8 步顺序 | 先查缓存会让「已关开关 / scope 收紧」失效，是最隐蔽的越权路径 |
| 4 | §11.5 新增**用户切换**；§11.6 新增**轮换**（含 `rotating` 状态） | 安全 §2.6 的生命周期需要协议侧的实现约束 |
| 5 | §13.1 增列 `request_hash`，并给出与已移除 `idem` 的对照 | 两者最容易被混为一谈 |
| 6 | §6.3 明确 **`res` 不携带审计状态** | 防止把本地磁盘状态泄露给 Cloud，也防止审计失败被塞进 `res.ok` |

## 0.0.2 Phase 1.0.1 修订摘要（本文，保留）

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
| `req` | Cloud → Desktop | 转发一次 tool 调用 |
| `res` | Desktop → Cloud | 返回结果或错误 |
| `cancel` | Cloud → Desktop | 取消在途请求 |
| `drain` | Cloud → Desktop | 即将断开（重启/撤销前），拒绝新请求 |
| `bye` | 双向 | 优雅关闭（附原因） |

**单向约束**：Cloud 从不向 Desktop 推送「非请求驱动」的业务帧。Desktop 不主动
发起 tool 调用。唯一 Desktop 主动的帧是 `hello` / `pong` / `res` / `bye`。

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

**Desktop 侧实现约束**：`req` 的处理必须包在 `try/catch/finally` 里，
`finally` 中保证「要么发出 `res`，要么显式记录 deliberate-drop 原因」。
不允许出现「解析失败就 return」的早退路径。

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

| 校验 | 失败响应 |
|---|---|
| `user_id` 匹配 | 404 `device_not_found`（不泄露存在性） |
| `status == 'pending'` | 409 `already_active`（幂等：已 active 直接返回 200） |
| `now < expires_at` | 410 `confirm_expired` |
| `constantTimeEqual(sha256(code), confirm_code_hash)` | 400 `invalid_confirm_code`；累计 5 次 → 该行 `status='revoked'` |

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

顺序是**安全性的一部分**：先做便宜的、无状态的检查，再做验签，
**最后**才做有状态、会「消耗」nonce 的检查。

```
1. Authorization header 存在且以 bp_dev_ 开头       → 否则 4001
2. sha256(token) 命中 mcp_devices.token_hash        → 否则 4001
3. status = 'active'（pending→4001 / suspended→4005 / revoked→4003）
4. mcp_devices.expires_at > now                     → 否则 4001
5. |cloud_now - ts| ≤ 120_000                       → 否则 4001
6. Ed25519 验签（mcp_devices.public_key）            → 否则 4001
7. **原子** nonce check-and-record（120s 窗口）      → 否则 4001（replay）
8. 版本区间有交集（§1.1 公式）                        → 否则 4002
9. 该 user 已有活跃连接？→ 按 §4.6 顶替
```

**第 7 步的原子性要求**：`nonceStore.checkAndRecord(nonce)` 内部的
「查存在 + 记录」之间**不得有 `await`**。若拆成 `has()` 然后 `await something`
再 `set()`，两个并发的重放请求都能通过。现有 `sync/auth.ts:57-78` 的
`NonceStore` 就是「一次调用内完成」，直接复用即可。

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
effective_tools = REMOTE_TOOLS ∩ hello_ok.allowed_tools ∩ toolsForScopes(scopes)
```

`REMOTE_TOOLS` 是 Desktop 侧**写死的 8 个**常量（不是从 `TOOL_DEFINITIONS` 过滤
出来的），所以 "Cloud 给了更多" 或 "Local 新增了工具" 都不会扩张远程面。
任一集合为空 → 仍然保持连接（让 Cloud 能下发撤销），但对任何 `req` 返回
`TOOL_NOT_ALLOWED`。

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

### 4.7 握手失败的 close code

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

- `seq` 回显，Cloud 用**单调时钟**算 RTT（`performance.now() - pingSentAt`），
  写指标不写库。
- **连续 3 次未收到 `pong`（默认 60s）→ close `4008 HEARTBEAT_TIMEOUT`**，
  并把该连接从路由表删除、`mcp_devices.last_seen_at` 更新为最后成功 `pong` 的时间。
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
  "grant_id": "grt_01J…",            // 仅审计/诊断，Desktop 不据此决策
  "client_id": "chatgpt",            // 同上
  "client_name": "ChatGPT",          // 同上
  "trace": {
    "mcp_request_id": "…",           // ChatGPT 的 JSON-RPC id，仅用于日志串联
    "received_at": 1763400000980     // Gateway 收到 HTTP 的时刻（epoch）
  }
}
```

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

顺序与 §8.5 完全一致，**缓存命中在准入之后**：

```
1. 本地远程开关 == on                    → 否则 REMOTE_DISABLED
2. frame_bytes ≤ max_frame_bytes          → 否则 REQUEST_TOO_LARGE
3. now_mono 未超过本地预算（§7.1）         → 否则 REQUEST_TIMEOUT（不执行）
4. tool ∈ effective_tools                 → 否则 TOOL_NOT_ALLOWED
5. scopes 仍覆盖（本地配置可能已收紧）      → 否则 SCOPE_DENIED
6. delivery_id / request_hash 一致性       → 不一致则 PROTOCOL_VIOLATION（不执行、不污染缓存）
7. 查结果缓存（§8.4）                      → 命中则直接回放，meta.cached=true
8. executeTool(tool, arguments, ctx)      → 内部：scope → Zod → handler → 错误映射
9. 写审计（安全 §6.5.5 / §6.5.6）        → **审计结果不影响 res.ok**
10. 组装 res{ok,data|error} → 发送 → 写入缓存
```

**顺序里的三个刻意之处**：

- **deadline 检查在 Zod 之前**：已过期的请求不需要花时间校验参数。
- **缓存在 1–5 之后**：先查缓存会让「已关开关 / scope 已收紧 / 设备已撤销」
  全部失效——这是最隐蔽的越权路径。
- **`executeTool` 内部会再校验一次 scope**（架构 §6.5.4）。第 5 步是「提前失败、
  给出更准确的错误码」，第 6 步内部那次是结构保证——两处都保留，不是冗余。

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
| Desktop 执行完成后发现已过 deadline | **不发送 `res`**，丢弃结果，记审计 `success=false, error_code=REQUEST_TIMEOUT` |

第三条是刻意的：如果 Cloud 已经超时返回，Desktop 再补发一个 `res` 只会让
Cloud 收到一个「迟到的成功」，与它已经告诉 AI 的结果矛盾。**宁可丢结果，不要自相矛盾。**

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

---

## 8. 重复请求与缓存（Phase 1.0.1 重写，1.0.2 补齐语义）

### 8.1 五个 id / 标识必须先分清

| 名称 | 谁生成 | 作用域 | 是否会重复 | 用途 |
|---|---|---|---|---|
| `mcp_request_id` | ChatGPT（JSON-RPC `id`） | 一次 MCP 会话 | 客户端重试时可能重复 | 仅日志串联（`trace.mcp_request_id`） |
| `delivery_id`（协议字段 `id`） | **Cloud** | 一次 WSS 投递 | **重投时故意复用** | 唯一去重键 |
| **`request_hash`** | **Cloud** | 一次投递的内容指纹 | 同内容必同值 | **仅校验同一 `delivery_id` 的内容未被替换**（§8.2） |
| `intent_digest` | Cloud（可选计算） | 调用意图 | 独立调用会相同 | **只用于日志/诊断**，不参与去重 |
| `exec_id` | Desktop | 一次真实执行 | 不重复 | 审计与性能指标 |
| `grant_id` / `client_id` | Cloud | 授权主体 | — | 审计与限流 |

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
| 1 | 相同 `delivery_id` + 相同 `request_hash`，**第一次正在执行** | **不重复执行**。挂起该帧，等首次完成后共用同一结果（第二次 `meta.cached=true`） |
| 2 | 相同 `delivery_id` + 相同 `request_hash`，**已有完成结果** | 返回缓存结果（`meta.cached=true`，`duration_ms` 为首次值） |
| 3 | 相同 `delivery_id` + **不同** `request_hash` | **拒绝**：`PROTOCOL_VIOLATION`，不执行，**不覆盖**已有缓存，记 stderr + 安全事件 |
| 4 | **不同** `delivery_id` + 相同 tool/arguments | **视为独立请求，各执行一次**（这是最容易被写错的一条） |
| 5 | 第一次执行中连接断开 | **不得**因为重连自动执行第二次。旧请求以 `DEVICE_OFFLINE` 结束，缓存随断线清空 |
| 6 | 旧连接的迟到响应 | **不得**污染新连接的请求状态。新连接是新的 `connection_id` + 新缓存，旧帧丢弃 |

**第 1 条的诚实说明**：当前 27 个 handler 全同步（架构 §1.4 实测），
Node 单线程下一次执行是事件循环内的原子操作，因此「执行中再到达」**在
现有实现里不可观测**。但仍必须实现占位逻辑，因为：

- 审计写入 / 结果序列化未来可能引入异步点；
- 未来可能引入异步工具（协议 §7.3 已声明那是一次 `v` 变更）；
- 用例 ST-7 需要一个可断言的执行计数，占位是它成立的前提。

**不允许的捷径**：不得因为「同步所以不可能并发」就省掉占位、让第 1 条落到
第 4 条去（那会变成执行两次）。占位表的存在本身就是第 1 条的实现。

### 8.4 缓存生命周期（设计建议，未实测）

| 项 | 建议值 | 依据 / 备注 |
|---|---|---|
| 键 | `delivery_id` | 唯一去重键 |
| 容量（条数） | **256 条** | 远大于单连接在途上限（`max_inflight=2`）× 重投次数 |
| 容量（字节） | **8 MiB** | 256 条若都是 1 MiB 结果会到 256 MiB，必须另有字节上限 |
| 淘汰 | **LRU，条数与字节数任一超限即淘汰最旧** | 两个上限都要有；只按条数会在「大结果」场景爆内存 |
| TTL | **60 秒（monotonic）** | 重投窗口不会超过一个 deadline（15s）+ 网络抖动 |
| 存什么 | `{ delivery_id, request_hash, ok, data \| error, completedAtMono, durationMs }` | **不落盘**，只在内存 |
| **成功结果** | 缓存 | 回放值必须与首次发送的帧**逐字节等价** |
| **错误结果** | **同样缓存**（只缓存「已经发出 `res` 的那些」） | 理由见下 |
| 执行中占位 | `Map<delivery_id, {request_hash, state:'inflight'}>` | 完成后原地替换为结果 |
| 断线时 | **整体清空**（含占位） | §8.3 规则 5；重连不重投 |
| **关闭远程开关时** | **同步整体清空**（含占位），在持久化 `enabled=false` 之后、断连之前 | §8.5：关闭是「不要再读」的明确意图，缓存是关闭前的数据 |
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

**重投的帧必须走完整的准入链，缓存命中在准入之后。** 顺序不可调换：

```
1. 本地远程开关 == on
2. 帧大小 / JSON 合法
3. deadline 未过（monotonic）
4. tool ∈ effective_tools
5. scopes 仍覆盖（本地配置可能已收紧）
6. request_hash 与 delivery_id 的一致性校验（§8.3 规则 3）
7. ← 只有到这里才查缓存
8. executeTool(...)
```

**为什么缓存不能提前到 1–5 之前**：如果先查缓存直接回放，那么「用户已关闭开关」
「scope 已被收紧」「设备已被撤销」这些状态变化都不会生效——AI 仍能拿到
关开关之前的旧数据。这是最隐蔽的越权路径，必须由顺序保证。

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
| R4 | `scopes` 被本地收紧 → 同一 `delivery_id` 重投 | 第 5 步拒（`SCOPE_DENIED`），不回放 tighten 之前的缓存 |

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

结论：**不实现按内容合并**。若 Phase 1.5 引入异步工具，则重新评估
（届时需要 `exec_id` + waiter 计数 + 「所有 waiter 取消才中止执行」的语义）。

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
> `REMOTE_MCP_ARCHITECTURE.md` §7.3（唯一权威）。

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

本表共 **17** 个业务错误码。任务书列出的 10 个全部包含；新增 7 个
（`DEVICE_SUSPENDED`、`REMOTE_DISABLED`、`DEVICE_BUSY`、`INVALID_ARGUMENTS`、
`NOT_FOUND`、`REQUEST_TOO_LARGE`、`PROTOCOL_VIOLATION`），
理由是这些情况在真实链路里必然出现，缺了就只能塞进 `INTERNAL_ERROR`，
AI 会误判为可重试。

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

**`4006` 与 `drain` 的交互（Phase 1.0.1 明确）**：

- `drain` = 优雅排空（滚动部署）→ 排空后 close `1001`（**可重连**）
- `4006` = 被另一台设备顶替 → 直接 close，**不排空**（排空期间的请求也没有意义，
  新连接马上接管）
- 两者同时触发时，**`4006` 优先**：立即 close，不再等排空。

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
| 在途请求 | **全部丢弃**：Desktop 侧 reject 挂起的 promise、清定时器；Cloud 侧对这些 `id` 返回 `DEVICE_OFFLINE`（**不重发**） |
| `connection_id` | 旧的作废，`hello_ok` 下发新的 |
| 结果缓存（`delivery_id` LRU） | **整体清空**（修正 Phase 1.0 的「跨重连保留」）——因为不跨连接重投，保留只会让新连接的回放命中旧数据 |
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
4. 清空结果缓存（delivery_id → result）
5. 置 connection_id = null
6. 心跳 seq = 0
7. 保留 reconnectAttempt 与 blockedReason
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

---

## 11. 生命周期事件

**统一顺序原则（与安全 §4.1 一致）：① 先持久化授权状态 → ② 再异步清理连接/路由。
清理失败不回滚已持久化的撤销。**

这里有两个**不同层次**的顺序，不要混为一谈：

| 顺序 | 说的是 | 规则 |
|---|---|---|
| **授权状态顺序** | 「撤销」什么时候生效 | 先写状态（DB），再清理连接。清理失败也不放行 |
| **凭证使用顺序** | 本地/服务端的凭据文件何时删 | 必须**先完成所有需要凭据的请求**（断连、suspend），再删凭据。反了则请求发不出去 |

§11.1 讲的是**凭证使用顺序**（先断连再清凭据）；§11.2 讲的是**授权状态顺序**
（先持久化再清理）。两者不矛盾。

### 11.1 用户退出 Cloud 登录

```
Desktop account-service.signOut()
  → 1. remote.disconnect()：发 bye(reason=signout) → close 1000
  → 2. 尽力 POST /mcp-devices/{self}/suspend（仅本设备）
  → 3. 清本地 account 凭据（现有行为：删 credentials.json）
  → 4. 保留 remote/device.json（设备身份不随登录作废）

Cloud 收到 bye / 检测到 close：
  → 删该设备的连接表项
  → 不撤销 mcp_grants（grant 属于 user，其它设备可能还在用）
  → 不断开该 user 的其它设备
```

**为什么先断连再清凭据**：断连和 `suspend` 都需要 Bearer/device_token；
先清凭据会导致这两个请求发不出去，Cloud 只能等心跳超时（最长 60s），
用户会看到「已退出但设备仍显示在线」。

**为什么不清 `device.json`**：设备身份是机器的属性，不是会话的属性。
每次登出都要求重新走确认码，会让用户放弃使用。

### 11.2 设备撤销

```
① 持久化（同步，事务）
   Cloud: mcp_devices.status = 'revoked', revoked_at = now()
   —— 提交后，任何转发前查状态都会拒（即使 ② 全失败）

② 清理（异步，可失败）
   Cloud: DELETE 路由表项（先删表，避免竞态中还有请求被转发）
   Cloud: 向该连接发 bye(reason=revoked) → close 4003

③ Desktop 收到 4003
   删除 userData/remote/device.json（私钥）
   linkState = 'blocked'
   界面「远程已断开」→ 不重连
```

**注意顺序变化**：Phase 1.0 写的是「先断连再删路由表」，现在改为
**先持久化 → 再删路由表 → 再发 bye**。删路由表在发 bye 之前，是因为
「连接还在但表项已删」的唯一后果是这条连接收不到新请求（无害）；
反过来「表项还在但连接已死」会让请求打到死连接上（有害）。

### 11.3 Grant 撤销（设备保留）

```
① Cloud: mcp_grants.revoked_at = now()（单条，按 grant_id 精确撤销）
② 撤销该 grant 的 refresh（若使用独立 mcp_sessions，见 OQ-3）
③ **不**断开设备连接
④ **不**影响该 user 的其它 grant
⑤ 下一次 req 命中该 grant → SCOPE_DENIED（或 401，若 token 已过期）
```

可选增强：Cloud 发 `policy` 帧（`type:"policy", scopes:[...]`）主动下推。
第一版不做——握手时下发一次足够，撤销靠「每次转发前查 grant」兜底。

### 11.4 本地开关关闭（本地优先）

```
① Desktop（同步，权威）
   写 local_state['remote.enabled'] = 'false'
   linkState 立即置为 'idle'
   对内存中任何在途/新到的 req 直接回 REMOTE_DISABLED

② Desktop（异步，可失败）
   POST /mcp-devices/{self}/suspend
   → 无论成功与否，都断开 WSS（close 1000）

③ Cloud
   status = 'suspended'；删路由表项并 close 4005（若连接仍在）

后续请求：
  - Cloud 仍认为在线（② 失败时）→ 请求发到 Desktop → Desktop 回 REMOTE_DISABLED
  - Cloud 已标 suspended → 直接回 DEVICE_SUSPENDED
```

**`REMOTE_DISABLED` 与 `DEVICE_SUSPENDED` 的语义不同**：
前者是「Desktop 本地拒绝了」（Cloud 可能还以为在线），
后者是「Cloud 知道设备被暂停」。两者都不可重试，但排障含义不同——
有 `REMOTE_DISABLED` 说明 Cloud 状态同步失败，这正是要观测的信号。

### 11.5 用户切换（A 登出 → B 登录）

**这条不在 Cloud 侧处理，全部在 Desktop 侧拦截。** 因为 Cloud 只知道
「设备 X 属于用户 A」，它没有任何依据判断「此刻桌面端登录的是 B」——
除非 Desktop 主动上报，而那又是一条新的信任假设。

```
B 登录成功 → remote.prepareFor(uB)
  device.boundUserId === uB  → 允许 resume；但仍需用户手动开开关
  device.boundUserId !== uB  → 强制阻断：
      local_state['remote.enabled'] = 'false'
      linkState = 'blocked'
      **不建立任何出站连接**（因此 Cloud 侧该设备变为离线）
      保留 device.json（含旧的 boundUserId，供用户主动解绑）
      界面：需要先解绑并重新注册
```

**为什么不在 Cloud 侧「改绑」**：`mcp_devices.user_id` 改成 B 等于把 A 的设备
资产静默转给 B。正确做法是 B 走一次全新注册（新 `device_id`），
旧行由 A 在自己的 Web 设置页删除。

**验证**：ST-4（A 登出 B 登录 → 不继承 A 的设备授权）。

### 11.6 设备 Token / 密钥轮换

```
① Desktop → POST /mcp-devices/{self}/rotate（Bearer 旧 device_token）
   body: { new_public_key, ts, sig = Ed25519_旧私钥("brewphase.remote.rotate.v1\n"
           + device_id + "\n" + new_public_key + "\n" + ts) }
② Cloud：用**旧公钥**验签通过 → 单条 UPDATE 覆盖 public_key + token_hash
   → 返回新 device_token（唯一一次）
   → **立即**将该 connection_id 标记为 `rotating`
③ Cloud：删路由项 → bye(rotated) → close 4010
④ Desktop：**先落盘**新凭据（新私钥 + 新 token + 同一 boundUserId）→ 用新凭据重连
```

**`rotating` 状态的语义**：从 ② 提交到 ③ 的 close 之间，该连接上到达的
**任何 `req` 一律回 `DEVICE_UNAUTHORIZED`**，不进入 Desktop 的准入链。
理由：凭据已经换了，旧连接不再代表当前设备身份；
如果继续放行，「轮换」就只是换了个 token，旧连接的安全语义没有变化。

**已在执行中的请求**：允许其完成（它用的是旧连接建立时的授权，且只读无副作用）。
`OQ-14` 记录这一取舍，Phase 1.2 需明确并测试。

**为什么新 token 必须在 ② 的响应里返回**：轮换的本质是「换一套凭据」。
若不返回新 token，设备只能重新走一遍注册（再要一次确认码），
那就不是轮换而是重注册。明文只出现一次，Cloud 只存 `sha256`。

**失效关系一览**：

| 对象 | 失效时刻 | 机制 |
|---|---|---|
| 旧 `device_token` | ② 的 UPDATE 提交 | `token_hash` 被覆盖 |
| 旧公钥 | 同上 | `public_key` 被覆盖 |
| 旧连接上的新请求 | ② 之后立刻 | `rotating` 标记 → `DEVICE_UNAUTHORIZED` |
| 旧路由表项 | ③ | 显式删除 |
| 旧 WSS 连接 | ③ | close `4010` |

**验证**：ST-3（轮换后旧连接发新请求 → 拒绝）。

---

## 12. 多实例下的设备路由

### 12.1 问题

WSS 是长连接，连接只存在于**某一台** Gateway 实例的内存里。ChatGPT 的
`POST /mcp` 可能打到任意实例（LB 轮询），因此必须有跨实例的「这台设备连在哪」。

### 12.2 第一版：单实例（运维约束，无法技术强制）

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

内存实现的 `instanceId` 恒为 `"gw-a"`。

**必须诚实说明：单副本无法在应用层技术上强制。** 两个副本会各自维护一份内存路由表，
设备连到 A、请求打到 B 时表现为 `DEVICE_OFFLINE`（看起来像设备掉线，实际是部署错误）。
因此只能靠三层约束：

| 层 | 做法 |
|---|---|
| 启动断言 | `GATEWAY_EXPECTED_REPLICAS` 环境变量（默认 `1`）；`> 1` 时**拒绝启动**并打印「需要 Phase 1.4 的共享路由表」 |
| 就绪探测 | `/ready` 增加 `instance_id` 与 `connection_count`；运维可据此发现「两台都在接流量」 |
| 部署文档 | README / 部署清单写明：Phase 1.2–1.3 期间 `replicas` 必须为 1，滚动更新用 `maxSurge=0, maxUnavailable=1` |

换 `instance_id` 的能力保留，是为了 Phase 1.4 换 Redis 实现时**不需要改协议**。

**`OPEN QUESTION` `OQ-12`**：`GATEWAY_EXPECTED_REPLICAS` 是否可被运维误配为 1
而实际跑 2 副本？**答**：无法完全防止——这是运维约束，不是安全边界。
缓解：`/ready` 暴露 `instance_id`（每个副本随机生成并打印启动日志），
运维可对比 LB 后端清单。**不阻塞**。

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
| 撤销设备时**先持久化状态**，再删表、再发 bye | 见 §11.2；清理失败也不能放行 |
| 顶替（§4.5）时**先 bind 新连接**，再断旧 | 避免空窗 |

---

## 13. 字段归属与校验

### 13.1 谁生成什么

| 字段 | 生成方 | 是否被对方校验 | 说明 |
|---|---|---|---|
| `v` | 双方各自填 | ✅ 版本区间（§1.1 公式） | 不允许中间件改 |
| `ts` | 发送方 | ⚠️ 仅握手时校验 ±120s | 其余帧只用于诊断；**不用于算耗时** |
| `device_id` | **Cloud**（注册时） | ✅ 必须与 token 归属一致 | 客户端自报一律忽略 |
| `nonce` | Desktop | ✅ 120s 去重（原子 check-and-record） | 每次握手新值 |
| `sig` | Desktop | ✅ Ed25519，覆盖 `device_id\nnonce\nts` | 不含版本号（版本由服务端强制） |
| `connection_id` | **Cloud** | ⚠️ **只在 `hello_ok` 出现一次**；后续帧不携带 | 属于连接上下文（§4.5） |
| `instance_id` | **Cloud** | — | 只用于诊断 |
| `heartbeat_ms` / `max_inflight` / `allowed_tools` / `scopes` | **Cloud** | Desktop 取交集 | Cloud 是策略源 |
| `id`（`delivery_id`） | **Cloud** | ✅ 响应必须回显；重投必须复用 | Desktop 不得自造 |
| `request_hash` | **Cloud** | ✅ 必须与 `{v, tool, arguments}` 重算值一致 | 只校验同 id 未被换内容，**不参与跨 id 合并**（§8.2） |
| `tool` | Cloud（来自 MCP） | ✅ 白名单 + 存在性 | — |
| `arguments` | Cloud（来自 MCP） | ✅ Zod | Desktop 不信任任何字段 |
| `deadline_ms` | **Cloud** | ✅ 必须尊重 | Desktop 不得延长 |
| `grant_id` / `client_id` | Cloud（来自 JWT/DB） | ⚠️ 仅审计 | Desktop 不据此决策 |
| `data` / `error` | Desktop | Cloud 不透传未登记 code | — |

**已移除的字段**：`idem`（Phase 1.0 的去重键）。理由见 §8.1–8.3。
若未来需要「意图指纹」用于诊断，字段名必须是 `intent_digest` 且**明确不参与去重**。

**`request_hash` 与 `idem` 的区别（最容易混淆的一点）**：

| | `idem`（已移除） | `request_hash`（Phase 1.0.2） |
|---|---|---|
| 计算对象 | `{tool, arguments}` | `{v, tool, arguments}` |
| 是否跨 `delivery_id` 比较 | **是**（这就是 bug 来源） | **否**，只在同一 `delivery_id` 内比 |
| 命中后的行为 | 回放缓存（可能是陈旧数据） | 只是「允许走缓存」，内容不同则拒绝 |
| 能否合并两个独立查询 | 会（错误） | 绝不 |

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
| Cloud WSS 日志 | 只 `device_id` 前 8 位、`tool`、`status`、`duration_ms`、`error_code`、`delivery_id` |
| 帧内容 | **永不**记录 `arguments` / `data` / `error.message` |
| Desktop 日志 | 可记完整 `error.message`（本地），但不记 `data`；可记 `grant_id` / `delivery_id`（审计表无这些列） |
| 审计表 | `mcp_operation_log`：`client_id='remote:<device_id>'` + tool / entity / success / error_code，**无参数无结果**（安全 §6.5） |

---

## 14. 完整时序示例

### 14.1 正常查询

```
ChatGPT → POST /mcp  tools/call search_records {search:"埃塞", limit:20}
Gateway:
  JWT ok → sub=u1, sid=s1；查 mcp_grants → grant=g1, scope 含 records:read ✔
  registry.lookup(u1, d1) → {conn_01J, gw-a} ✔
  生成 delivery_id=req_01J8Z9K2M4, request_hash=sha256({v,tool,args}),
      deadline=now+15000 → WSS
Desktop:
  开关 on ✔ / 帧合法 ✔ / 未过期 ✔ / tool ∈ effective ✔ / scope ✔ / hash 一致 ✔
  缓存未命中 → executeTool('search_records', args) → 20 条（has_more=true）
  审计尝试写入：client_id='remote:0b7c…', tool=search_records, success=1
  res ok:true, duration_ms=118 (monotonic), cached=false
  → 写入缓存 {delivery_id, request_hash, ok, data, completedAtMono}
Gateway → ChatGPT: structuredContent={items:[…],limit:20,offset:0,has_more:true}
```

**同一次调用中审计失败的情形（必须单独理解）**：

```
Desktop:
  ... executeTool 成功 → data 已就绪
  审计尝试写入 → SQLite 抛错
  → console.error('[remote] audit write failed', err)
  → consecutiveFailures += 1；lastFailureAt = now
  → **仍然发送** res ok:true, data=（原样）
  → 设置页显示告警：「最近 1 次远程访问未能写入审计记录」
```

`res` 与审计结果无关——这是安全 §6.5.5 三段分离的直接体现，
也是 ST-10 的验收内容。

### 14.2 设备离线

```
ChatGPT → POST /mcp
Gateway: registry.lookup(u1,d1) → null
→ tool result isError:true, {error:{code:"DEVICE_OFFLINE",retryable:true}}
（日志只记 tool + code，不记 search 关键词）
```

### 14.3 超时 + 迟到结果

```
t=0      Gateway 发 req(delivery=req_x), deadline_ms=t+15000
         Desktop 收到，remaining=15000 → expiresAtMono = perf.now()+15000
t=15000  Gateway 未收到 res
         → 回 ChatGPT {code:"REQUEST_TIMEOUT", retryable:true}
         → 发 cancel(req_x, reason:"gateway_timeout")
t=15020  Desktop 执行完成，检查 perf.now() >= expiresAtMono（或已收到 cancel）
         → **不发送 res**（丢弃结果）
         → 审计 success=false, error_code=REQUEST_TIMEOUT
t=15021  Cloud 收到迟到 res（若 Desktop 因 bug 发送）→ 无对应 waiter，**忽略**
```

### 14.4 参数完全相同但两次独立调用（Phase 1.0.1 必须正确）

```
10:00  ChatGPT 第 1 次: search_records{search:"埃塞"} → delivery=A → 执行 → 返回 5 条
10:01  用户又冲了 1 杯并记录
10:05  ChatGPT 第 2 次: search_records{search:"埃塞"} → delivery=B
       （参数与 A 完全相同，但 delivery 不同）
       → **必须重新执行** → 返回 6 条

若按 Phase 1.0 的 idem=sha256(tool+args) 去重 → 会回放 A 的 5 条
→ 用户看到过期数据且无从察觉。这就是移除 idem 的原因。
```

### 14.5 撤销后重连尝试

```
Web 撤销设备
  → Cloud ① status='revoked'（持久化，先做）
  → Cloud ② 删路由项 → bye(revoked) → close 4003
Desktop: 收到 4003 → 删 device.json → blocked → 不重连 → 界面「远程已断开」
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
| `POST` | `/mcp-devices/register` | 设备注册（§3.2） | 需用户 Bearer |
| `POST` | `/mcp-devices/{id}/confirm` | 用户确认码（§3.3） | Web 设置页 |
| `POST` | `/mcp-devices/{id}/credentials` | 领取 device_token（§3.4） | 需 Bearer + 请求体 `claim_secret`（**不入 URL**） |
| `GET` | `/mcp-devices` | 设备列表 | 不含 token |
| `POST` | `/mcp-devices/{id}/rotate` | 轮换（§3.5） | 需 device_token + 旧私钥签名 |
| `POST` | `/mcp-devices/{id}/suspend` \| `/resume` | 暂停 / 恢复 | Bearer 或 device_token |
| `DELETE` | `/mcp-devices/{id}` | 撤销 | Bearer |
| `GET` | `/health` | 存活 | 已有 |
| `GET` | `/ready` | 就绪（新增 `instance_id` / `connection_count`） | 扩展现有 |

`/mcp` 必须：
- 校验 `Authorization: Bearer`，失败返回 401 + `WWW-Authenticate: Bearer resource_metadata="…"`
- 校验 `Host` 与 `Origin`（SDK 的 `hostHeaderValidationResponse` / `originValidationResponse`）
- 请求体上限 256 KB（MCP 请求本身不含大数据）
- 不支持 `GET` 的 SSE 长连接（第一版只要请求-响应；ChatGPT 若要求 SSE，Phase 1.3 再加）

### 15.1 OAuth 相关的三层要求必须分开（Phase 1.0.1）

| 层 | 内容 | 当前状态 |
|---|---|---|
| **A. MCP 官方协议要求** | Streamable HTTP（`POST /mcp`，可选 SSE）、`initialize` / `tools/list` / `tools/call`、RFC 9728 保护资源元数据、`WWW-Authenticate` 带 `resource_metadata`、RFC 8707 `resource` 参数、PKCE S256 | SDK 已提供实现（`createMcpHandler`、`WebStandardStreamableHTTPServerTransport`、`buildOAuthProtectedResourceMetadata`、`requireBearerAuth`、`checkResourceAllowed`）——**协议层不用手写** |
| **B. ChatGPT 实际接入要求** | 是否必须 DCR、是否必须 `outputSchema`、是否发送 `notifications/cancelled`、是否要求 SSE `GET /mcp`、`resource` 是否必填 | **未验证**（OQ-B/OQ-C）。**Phase 1.0.1 不得断言任何一条**，Phase 1.3 用真实客户端验收 |
| **C. BrewPhase 自身安全策略** | `redirect_uri` 精确匹配（不走通配）、scope 必须在同意页逐项展示、`aud` 绑定 resource、token 15 分钟、撤销立即生效 | 已设计（本文 + 安全文档），与 A/B 无关，**不因 ChatGPT 的要求而放宽** |

**不允许的推断**：不能说「ChatGPT 一定要求 DCR」或「ChatGPT 一定不支持 refresh」。
这些只能由真实联调确定。Phase 1.0.1 只把它们列为验收门禁项。

---

## 16. 与 Local MCP 协议的对照

| 项 | Local MCP | Remote Link |
|---|---|---|
| 传输 | Unix socket / Named Pipe | WSS |
| 帧 | NDJSON（一行一帧） | 一帧一 JSON |
| 认证 | `bp_mcp_*` token（每请求查库） | `bp_dev_*` + Ed25519 握手；MCP JWT 在 HTTP 层 |
| 版本 | `protocolVersion: 1`（整数，严格相等） | `v: 1`（区间协商 + 未知字段忽略） |
| 超时 | 客户端 30s 硬编码（服务端无 deadline） | `deadline_ms` 绝对时间 + monotonic 计时，双层预算 |
| 取消 | 无 | `cancel` 帧 |
| 重投去重 | `mcp_idempotency` 表（写工具，`(client_id,key)` 唯一） | 内存 LRU 按 `delivery_id`（只读，256/60s，断线清空） |
| single-flight | 无（同步 handler） | **无**（理由同左，见 §8.4） |
| 执行入口 | `routeBridgeRequest` → `HANDLERS` | **同一个 `executeTool`**（架构 §6.5） |
| 错误码 | 12 个 `MCP_ERROR_CODES`，`{code,message}` | 17 个，`{code,message,retryable}` |
| 审计 | `mcp_operation_log`，**只记写工具** | 同表，**只读也记**，`client_id='remote:<device_id>'` |

**不合并两套协议**：NDJSON 单行帧适合本地流式追加，JSON 帧 + 心跳适合长连接；
强行统一会让本地链路背上心跳与重连的复杂度，而它根本不需要。
**但执行层必须合并**——那是业务逻辑，一份就够。
