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
| `cancel` | Cloud → Desktop | 取消在途请求 |
| `drain` | Cloud → Desktop | 即将断开（重启/撤销前），拒绝新请求 |
| `bye` | 双向 | 优雅关闭（附原因） |

**单向约束**：Cloud 从不向 Desktop 推送「请求驱动」的**业务帧**；唯一例外是
**策略帧** `grant_update`——它只改变授权上下文，不携带任何用户数据。
Desktop 不主动发起 tool 调用。Desktop 主动的帧只有
`hello` / `pong` / `res` / `grant_update_ack` / `bye`。

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
10. 构造 `hello_ok`：取该 user 中 `grant.user_id == device.user_id` 且
    `revoked_at IS NULL` 的 grant，生成 `grant_ctx` + 设备级 `grant_epoch`（§6.5）
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
