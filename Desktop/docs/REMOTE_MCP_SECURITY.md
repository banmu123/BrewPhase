# BrewPhase Remote MCP — 安全模型（Phase 1.0 设计，1.0.1 / 1.0.2 / 1.0.3 修订）

> 与 `MCP_SECURITY.md`（Local MCP）互补，**不复用它的信任边界**。
> 本文只覆盖远程链路：MCP Client 授权、设备身份、Scope、Token 生命周期、
> 撤销、跨用户隔离、隐私与威胁模型。
> 架构见 `REMOTE_MCP_ARCHITECTURE.md`，协议见 `REMOTE_MCP_PROTOCOL.md`。
> 修订：**Phase 1.0.1**、**1.0.2**、**1.0.3**（均 2026-11-17），
> 基线 `feature/remote-mcp` @ `89866cd`。

## 0.0 Phase 1.0.3 修订摘要（本文）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | §3.1 / §2.3.2 把 `claim_secret` 的传递改为 **POST 请求体**，并明确禁止入 URL/日志/错误信息 | query 会进反向代理 access log；凭证不该出现在 URL 里 |
| 2 | §6.5.6 明确审计失败计数器是**进程内状态**，重启归零，且 UI 不得描述为「历史已补齐」 | 1.0.2 只写了「内存维护」，没禁止把归零当修复 |
| 3 | §7.1 新增 **ST-16**（关闭开关与重复投递的竞态）与 **ST-17**（用户切换后的崩溃恢复） | 这两条是「缓存越权」与「重启后自动连旧设备」的唯二防线，此前没有验收项 |
| 4 | §7.1 修正 **ST-13 的阻断级别说明**（✅ 阻断），并统一「阻断只有两档」 | 阶段文档曾把它写成不阻断，与本文冲突 |
| 5 | 全文时间表述复核为 **Unix epoch（跨进程）/ monotonic（进程内）** 二分 | 与协议 §2.1 对齐；「单调 epoch」类混合术语会误导 deadline 实现（ST-9） |

## 0.0.1 Phase 1.0.2 修订摘要（本文，保留）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | §6.5.5 重写为**三段状态分离**（准入 / 业务 / 审计），并新增 §6.5.6–6.5.10 | 原文只说「不把查询报成失败」，未定义审计算不算数，也没禁止声称审计完整 |
| 2 | §6.5.7 把 `OQ-5` 熔断的**待评估条件**扩到 6 项，明确「未定稿」 | 原文只有一句倾向，没有任何可评估的判据 |
| 3 | 新增 §2.6 **五个身份分层 + 五个生命周期场景** | 设备身份与用户登录、设备绑定、grant 三者从未被显式拆开 |
| 4 | 新增 `boundUserId` 机制 | 缺少「A 登出 → B 登录」的阻断点，会继承 A 的设备绑定 |
| 5 | 威胁模型新增 T17 / T18 / T19 | 用户切换继承、审计三段混淆、`delivery_id` 被替换内容 |
| 6 | 新增 §7.1 **安全集成测试矩阵**（1.0.2 时为 ST-1~ST-15） | 原文档有威胁但无对应验收用例，无法判定阶段是否真的安全 |
| 7 | 审计可靠性承诺边界（§6.5.10）明确「不承诺取证级不可篡改」 | 避免对外表述夸大 |

## 0.0.2 Phase 1.0.1 修订摘要（本文，保留）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | §2.3 重写为**四凭证 + 注册闭环**，引入 `claim_secret` | 原设计只有「确认码」，无法回答「持有 Bearer 的其它客户端能否抢先领取」 |
| 2 | §4 拆出**五个独立状态机** + 撤销顺序表 | 原设计把开关/设备/连接/grant/登录混成 online，导致断网 ≡ suspend |
| 3 | §3.2 明确 JWT `aud` 硬编码冲突，MCP token 必须**新建签发/校验路径** | `sessions/jwt.ts` 的 `TOKEN_AUDIENCE` 固定为 `brewphase-desktop`，无法「直接复用」 |
| 4 | 删除不存在的 `session_kind='mcp'` 说法，改为 `OPEN QUESTION` OQ-3 | `auth_sessions` 无该列 |
| 5 | §6.5 新增审计定稿：1.1A/1.1B 采用**方案 A**（`client_id='remote:<device_id>'`） | 真实 schema 允许；原 A10/1.1.2/1.1.6 三处互相矛盾 |
| 6 | §5.3 重放机制改为按 `delivery_id` 去重 | `sha256(tool+args)` 会把两次独立查询误合并 |
| 7 | §7 新增 T9b/T9c/T15/T16 | 撤销误伤、领取伪造、轮换残留 |

## 0. 三条不可让渡的前提

1. **Remote 与 Local 是两套凭据域。** `bp_mcp_*` token 永不出本机；
   Remote 用 `device_token` + MCP access token，两者互不派生、互不可换。
2. **Cloud 不持有数据，因此 Cloud 的泄露不等于数据泄露。** 这个性质必须靠
   「Gateway 不落业务数据」维持，一旦为了性能加缓存就失效。
3. **Desktop 有最终否决权。** Cloud 说允许不等于 Desktop 必须执行。

---

## 1. 信任边界

```
不可信
├─ ChatGPT / 任意远程 MCP Client
│    ├─ 可伪造任意 HTTP 请求 → 每请求验 JWT 签名 + aud + exp
│    ├─ 可重放截获的请求   → jti + 服务端去重 + 短 exp
│    └─ 可枚举 device_id   → device_id 不参与路由决策，只作提示
├─ 公网中间人
│    └─ 全链路 TLS；WSS 双向校验
├─ Cloud 运行环境（运维/日志/备份）
│    ├─ 只能看到 tool 名与状态码，看不到参数与结果
│    └─ 数据库里没有业务数据
└─ 设备凭证的持有者（若被窃取）
     └─ 私钥在 safeStorage；换机需用户重新确认

可信
├─ Desktop 主进程（唯一数据库所有者）
│    ├─ 本地开关 + 只读白名单 + scope 二次校验
│    └─ 审计唯一权威（mcp_operation_log；远程行 client_id='remote:<device_id>'）
└─ Cloud 身份与会话服务（users / auth_sessions，现有实现）
```

**Cloud Gateway 是「半可信」**：它做第一道授权，但不是数据所有者。因此
Desktop 不能因为「Cloud 已经验过」就跳过自己的检查——两边都必须校验。

---

## 2. 五层权限模型

远程访问必须同时通过五层，任一层否决即拒绝：

| 层 | 主体 | 由谁校验 | 存储 | 粒度 |
|---|---|---|---|---|
| L1 Cloud 用户身份 | 人 | Cloud | `auth_sessions`（已有） | 账号级 |
| L2 MCP Client 授权 | AI 客户端 | Cloud | `mcp_grants`（新增） | client × user |
| L3 Desktop 设备授权 | 设备 | Cloud + Desktop | `mcp_devices`（新增） | device × user |
| L4 Tool Scope | 单次调用 | **Cloud + Desktop 各一次** | `mcp_grants.scopes` | tool 级 |
| L5 本地远程开关 | 用户 | Desktop | `local_state` | 全局 / 单设备 |

### 2.1 L1 → L2：ChatGPT 用户如何与 BrewPhase 用户关联

**唯一路径是用户在浏览器里显式登录并同意。** 不存在「用 ChatGPT 邮箱自动匹配
BrewPhase 账号」的通道。

```
ChatGPT                     Gateway                     用户浏览器
  │ GET /authorize            │                             │
  │  (client_id, redirect_uri,│                             │
  │   code_challenge, state)  │                             │
  ├──────────────────────────>│ 校验 client + redirect     │
  │                           │ 302 → /consent?tx=...       │
  │                           ├────────────────────────────>│
  │                           │                             │ 若未登录 → 走现有 Google/GitHub 登录
  │                           │                             │ 展示授权页（scope 逐项）
  │                           │<────────────────────────────┤ 用户点「允许」
  │                           │ 生成 grant（user_id,        │
  │                           │ client_id, scopes）         │
  │ 302 redirect_uri?code=... │                             │
  │<──────────────────────────┤                             │
  │ POST /token (code+verifier)                             │
  ├──────────────────────────>│ PKCE 校验 → 签 access token │
  │ access_token (aud=resource)                             │
  │<──────────────────────────┤                             │
```

铁律：

- **`user_id` 只从授权码换取，永不从请求体读。** 任何请求里出现 `user_id`
  一律忽略（不是「校验」，是「不读」）。
- **邮箱不是身份锚点。** 沿用现有 `user_identities` 的 `(provider, provider_subject)`
  唯一约束——同邮箱不自动合并用户（`cloud/src/db/schema.ts` 注释已明确）。
- **L1 会话 ≠ L2 授权。** 用户登录 Cloud 只证明「他是谁」；MCP 授权是独立
  grant，可单独撤销而不影响登录状态。

### 2.2 L2：MCP Client 授权的存储形态

```sql
mcp_grants (
  id              uuid primary key,
  user_id         uuid not null references users(id) on delete cascade,
  client_id       text not null,           -- 预注册或 DCR 得到的 client
  client_name     text not null,           -- 授权页展示用
  scopes          text[] not null,         -- 远程只读子集
  resource        text not null,           -- RFC 8707 resource indicator，绑定 Gateway URL
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  unique (user_id, client_id, resource)
)
```

- 一个用户可以有多个 grant（ChatGPT + 别的客户端），各自独立撤销。
- `resource` 参与 access token 的 `aud` 校验：token 不能拿到别的 MCP 服务上用。
- **不存** 用户对话内容、tool 参数、tool 结果。
- **grant 挂 user，不挂 device**（二者正交）：撤销设备不应连带撤销 grant，
  撤销 grant 也不应断开设备。见 §4。

### 2.3 L3：设备身份与注册闭环

#### 2.3.1 四个凭证的职责（不许合并）

| 凭证 | 谁生成 | 存哪 | 证明什么 | 生命周期 |
|---|---|---|---|---|
| **用户 Bearer Token** | Cloud `/oauth/token`（现有登录流程） | Desktop `account/credentials.json`（safeStorage 密文） | 「这个人在浏览器里登录过」 | 15 min / refresh 30 天 |
| **claim_secret**（注册阶段一次性秘密） | Cloud `/mcp-devices/register` 响应 | Desktop 仅内存（不落盘） | 「领取 device_token 的这方，就是发起注册的这方」 | 300 s，一次有效 |
| **device_token**（`bp_dev_`） | Cloud，领取时下发 | Desktop `remote/device.json`（safeStorage 密文） | 「这是已确认的那台设备」（WSS 接入认证） | 30 天 / 可轮换 |
| **Ed25519 私钥** | Desktop（`generateKeyPairSync('ed25519')`） | Desktop `remote/device.json`（safeStorage 密文，PKCS8 DER） | 「本机确实持有注册时那把私钥」（每次握手） | 随设备；轮换即换新 |

关键分离：

- **用户 Bearer 不是设备凭证**。它只用于「注册 / 确认 / 管理」，不能直接接入 WSS。
- **claim_secret 不是 device_token**。它只用于**一次**领取，领取后即失效，
  即使泄漏也无法再领（`token_issued_at` 非空即拒绝）。
- **device_token 不是身份证明的唯一手段**。它只解决「这条 WSS 属于哪台设备」；
  「是不是真的那台机器」由 Ed25519 签名证明。两者同时校验，缺一不可。

#### 2.3.2 完整流程（含每一步的校验与失败行为）

```
① 生成密钥（本地，不联网）
   generateKeyPairSync('ed25519')
   privateKey → PKCS8 DER (48 B) → safeStorage.encrypt → device.json (0600)
   publicKey  → SPKI DER (44 B) → 取尾部 32 B raw → base64url (43 char)

② POST /mcp-devices/register
   Header: Authorization: Bearer <用户 access token>
   Body:   { name, platform, app_version, public_key: "<base64url 32B>" }

   Cloud 校验：
     a. Bearer 有效（现有 verifyAccessToken）
     b. public_key 解码后长度 == 32，否则 400 invalid_public_key
     c. 该 user 的 active+pending 设备数 < 5，否则 429 device_limit
     d. 同 public_key 已存在且未撤销 → 409 device_exists（幂等提示，不新建）
   Cloud 写入（status=pending）：
     mcp_devices { id, user_id, name, platform, public_key,
                   confirm_code_hash, claim_secret_hash,
                   expires_at: now+300s, token_hash: null, token_issued_at: null }
   Cloud 返回（**唯一一次**出现明文）：
     { device_id, confirm_code: "492817", claim_secret: "<base64url 32B>",
       expires_in: 300 }

③ 用户确认（Web 设置页，需已登录同一账号）
   POST /mcp-devices/{id}/confirm
   Header: Authorization: Bearer <用户 access token>
   Body:   { confirm_code: "492817" }
   Cloud：constantTimeEqual(sha256(code), confirm_code_hash)
          + status == 'pending' + now < expires_at + user_id 匹配
          → status = 'active'
   失败：code 不匹配 → 400 invalid_confirm_code（计数，5 次锁定该 pending 行）；
        过期 → 410 confirm_expired；已 active → 409（幂等返回 active）

④ 领取 device_token（Desktop 轮询，1s 间隔 ≤ 300s）
   POST /mcp-devices/{id}/credentials
   Header: Authorization: Bearer <用户 access token>
   Body:   { claim_secret: "<base64url 32B>" }      ← 不放 URL / query / 日志

   Cloud 三重校验：
     a. user_id 必须等于该设备的 user_id          → 否则 404（不泄露存在性）
     b. sha256(claim) == claim_secret_hash（常量时间） → 否则 403 claim_mismatch
     c. status == 'active' 且 token_issued_at IS NULL → 否则 409

   **原子领取**（竞态与重复的关键）：
     UPDATE mcp_devices
        SET token_hash = $1, token_issued_at = now()
      WHERE id = $2 AND token_issued_at IS NULL AND status = 'active'
      RETURNING id
     有 0 行 → 409 credentials_already_issued（不区分「已领过」与「状态变化」）

   Cloud 返回（**唯一一次**出现明文）：{ device_token: "bp_dev_…", expires_at }

⑤ WSS 握手（每次连接）
   Authorization: Bearer <device_token>
   → hello { device_id, nonce, ts, sig = Ed25519(device_id\nnonce\nts) }
   Cloud 9 步校验（协议 §4.3），含验签与 nonce 去重
```

#### 2.3.3 八个必答问题

| # | 问题 | 答案 |
|---|---|---|
| 1 | **另一个持有用户 Bearer Token 的客户端能否抢先领取设备凭证？** | **不能。** 领取需 `claim_secret`，它只在 ② 的响应里出现一次、不落 Cloud 明文、不经任何其它通道下发。仅持 Bearer 的客户端最多能**发起一次新注册**（那会得到它自己的 `device_id` 与 `claim_secret`），无法领取已有设备的凭证。 |
| 2 | `POST .../credentials` 如何验证领取者身份？ | 三重：用户 Bearer 的 `sub` == 设备 `user_id`；请求体里的 `claim_secret` 哈希匹配（常量时间）；状态为 `active` 且未领取。三者全过才发放。 |
| 3 | 一次性领取如何防重复与竞态？ | **单条条件 UPDATE 的 `RETURNING` 行数**做判定（不是「先查后写」）。并发两个请求只有一个能更新成功，另一个 409。 |
| 4 | 注册超时 / 用户取消 / 确认码失效？ | `expires_at=300s`；过期后 ③ 返回 410、④ 返回 409；`startSweep`（现有 60s 定时器）删除 `status='pending' AND expires_at < now()` 的行。用户取消 = `DELETE /mcp-devices/{id}`（pending 也可删，205）。确认码错 5 次锁定该 pending 行（置 `status='revoked'`），需重新注册。 |
| 5 | `device_token` 丢失后如何重新注册？ | **不能补发**（`token_issued_at` 非空即拒）。Desktop 删除本地 `device.json` → 走一次全新 ②③④（得到新 `device_id`）→ 用户可在 Web 删除旧的僵尸设备。 |
| 6 | 轮换时旧 Token / 旧公钥 / 旧连接如何失效？ | `POST /mcp-devices/{id}/rotate`，需**当前 device_token** + 用**旧私钥**对「新公钥 + 新 token 请求」签名。Cloud 单条 UPDATE 同时覆盖 `public_key` 与 `token_hash`（旧 token 哈希被覆盖即失效，无需额外撤销表）→ 然后**先**删连接表项、**再**向该连接发 `bye(reason=rotated)` + close `4010`。Desktop 收到 4010 用新凭证重连。 |
| 7 | Cloud 是否保存可恢复的设备明文凭证？ | **不保存。** 存 `sha256(device_token)`、`sha256(claim_secret)`、`sha256(confirm_code)`、`public_key`（公开值）。数据库泄露无法推出 device_token，也无法伪造签名（无私钥）。 |
| 8 | 私钥无法解密时设备如何进入未授权状态？ | `safeStorage.decryptString()` 抛错 → Desktop 删除 `device.json`、`linkState='blocked'`、不重连、界面提示「需要重新授权」。**不尝试明文兜底**（与 `account/credentials.ts` 同纪律）。Cloud 侧该设备仍是 `active`，但因无 WSS 连接而离线；用户可在 Web 删除。**不存在「本地已废但 Cloud 仍可路由」的窗口**，因为路由依赖活跃连接。 |

#### 2.3.4 Ed25519 可行性（已实测，非推测）

在本机 Node **v22.22.2** 实测通过（命令见交付报告）：

| 项 | 实测结果 |
|---|---|
| `generateKeyPairSync('ed25519')` + 签名 | 2 ms |
| SPKI DER 长度 | 44 B，固定头 `302a300506032b6570032100` + 32 B raw |
| 用 raw 32 B 重建公钥后验签 | ✅ true |
| PKCS8 DER 长度 | 48 B，重建后签名可验（✅ true） |

结论：**无需第三方依赖**，`node:crypto` 足够。Cloud 侧用 `crypto.createPublicKey()`
从 raw 32 B 重建（拼固定 SPKI 头），Desktop 侧用 `sign(null, msg, key)`。

`OPEN QUESTION`
- `OQ-E1`：**Electron 45 主进程**的 Node 是否与系统 Node 完全一致（本机验证用的是
  系统 Node）。属低风险，但仍需在 1.1B 第一天用 `app.evaluate` 跑一次同样的
  往返。**不阻塞**（失败则退回 `ws` + 纯 JS Ed25519 的实现评估）。
- `OQ-E2`：Windows（DPAPI）与 Linux（无 keyring）下 `safeStorage` 的可用性/
  行为。首发若仅 macOS，**不阻塞**。

#### 2.3.5 存储与权限

| 资源 | 位置 | 权限 |
|---|---|---|
| 设备私钥 + device_token | `<userData>/remote/device.json` | 目录 `0700` / 文件 `0600`，先写 `.tmp` 再 `rename` |
| 外层信封 | `{ version: 1, alg: 'safeStorage-v1', payload: base64 }` | 与 `account/credentials.json` 同构；**userId 也不落明文** |
| `safeStorage.isEncryptionAvailable() === false` | **拒绝落盘**，仅在内存持有本次会话 | 界面明确提示「重启需重新授权」 |

设备文件与 `account/credentials.json` **分开两个文件**：退出 Cloud 登录只删账户文件，
设备身份保留（否则每次登出都要用户重新确认设备）；「忘记此设备」才删 `remote/`。

### 2.4 L4：Scope 设计（远程子集）

远程第一版**只读 8 个工具、4 个 scope**：

| Scope | 工具 | 是否第一版开放 |
|---|---|---|
| `records:read` | `search_records`、`get_record` | ✅ |
| `tags:read` | `list_record_tags` | ✅ |
| `coffee:read` | `list_beans`、`list_brews`、`list_tastings` | ✅ |
| `canvas:read` | `list_canvases`、`get_canvas` | ✅ |
| `records:create` / `update`、`tags:create` | — | ❌ 不开放 |
| `canvas:write` | — | ❌ 不开放 |
| `work_context:*` | — | ❌ 不开放（个人工作上下文，远程收益最低） |
| `direction:read` / `propose` | — | ❌ 不开放 |
| `coffee:write`（不存在） | — | — |

命名沿用现有 `MCP_SCOPES` 的字符串，**但远程枚举独立定义**：

```ts
// 建议位置：Desktop/src/shared/contracts/remote.ts（新增）
export const REMOTE_SCOPES = [
  'records:read', 'tags:read', 'coffee:read', 'canvas:read'
] as const
```

理由：如果直接复用 `MCP_SCOPES`，将来给 Local 加写 scope 会**自动**出现在远程授权页上。
两个枚举之间加一条单测断言 `REMOTE_SCOPES ⊂ MCP_SCOPES` 即可保持一致，
但不会意外放宽。

**错误码的唯一权威表在 `REMOTE_MCP_PROTOCOL.md` §9.1（17 个）。** 本文只按语义
引用其中与安全相关的若干（`DEVICE_REVOKED` / `SCOPE_DENIED` / `TOOL_NOT_ALLOWED` /
`USER_MISMATCH` 等），不重复定义第二次，避免两处漂移。

### 2.5 L5：本地远程访问开关

开关是**独立状态机**（与 Cloud 设备状态、WSS 连接状态正交，见 §4.0）：

| 本地状态 | WSS | Cloud 侧（最终一致） | 对远程请求的效果 |
|---|---|---|---|
| `off`（默认） | 不建立 | `suspended` 或从未注册 | 无连接 ⇒ `DEVICE_OFFLINE`/`DEVICE_SUSPENDED` |
| `on`（已授权） | 建立并保活 | `active` | 正常路由 |
| `on`（未授权） | 建立后立即被 close 4001 | `pending` | 无连接 ⇒ `DEVICE_OFFLINE` |
| `blocked`（私钥不可用） | 不建立 | `active`（无连接） | `DEVICE_OFFLINE`；界面提示重新授权 |

**默认关闭。** 用户必须主动打开，且打开时界面必须显示：「任何获得你授权的 AI
客户端都可以读取下列内容」，并逐项列出 4 个 scope 对应的具体数据。

**关闭的顺序（与 Phase 1.0 不同，见 §4.2）**：本地先落盘、先拒请求，再尽力通知 Cloud。
Cloud 不可达**不能**阻止本地关闭。

### 2.6 五个身份的分层与用户生命周期（Phase 1.0.2 新增）

#### 2.6.1 五层身份，各管一件事

| # | 身份 | 载体 | 存在哪 | 生命周期 | 谁能撤销 |
|---|---|---|---|---|---|
| I1 | **Cloud 用户身份** | refresh token（`account/credentials.json`） | Desktop（safeStorage）+ Cloud `auth_sessions` | 登录 → 登出 / 401 | 用户登出、Cloud 撤销会话 |
| I2 | **Desktop 设备身份** | Ed25519 私钥 + `device_token`（`remote/device.json`） | Desktop（safeStorage）+ Cloud `mcp_devices` | 注册 → 撤销 / 轮换 | 用户「忘记设备」、Cloud 撤销 |
| I3 | **Cloud 设备注册关系** | `mcp_devices.user_id` + `status` | 仅 Cloud | `pending → active ⇄ suspended → revoked` | 用户在 Web 撤销 / 确认 |
| I4 | **MCP Client grant** | `mcp_grants` 行 | 仅 Cloud | 授权 → 撤销 | 用户在 Web 撤销 |
| I5 | **WSS 连接** | `connection_id` | Cloud 内存 + Desktop 内存 | 建连 → 断开 | 任意一方 |

**关键关系**：**I2 ≠ I3 ≠ I4**。

- I2 是「这台机器有一把私钥」——纯粹的本机属性。
- I3 是「这台机器的公钥属于哪个账号」——**绑定关系**，可以被撤销。
- I4 是「哪个 AI 客户端能读哪些 scope」——属于用户，**不挂在设备上**。

三者混为一谈的后果：撤销设备时误撤 grant（换电脑后所有 AI 客户端都要重新授权）、
登出时误删设备（每次登录都要重新确认设备）、换用户时继承旧绑定（越权）。

#### 2.6.2 设备绑定必须带 `boundUserId`

`remote/device.json` **必须**额外记录 `boundUserId`（Cloud 的用户 uuid），
与私钥、`device_token` 放在同一段 safeStorage 密文里。

```
device.json 解密后的结构（Phase 1.0.2）
{
  deviceId:        "0b7c…",
  boundUserId:     "u-8f21…",     // ← 新增，用于跨用户阻断
  privateKeyPkcs8: "<base64 DER>",
  deviceToken:     "bp_dev_…",
  registeredAt:    1763400000000
}
```

`boundUserId` 的作用只有一个：**在「恢复远程」之前比对当前登录用户**。
比对不通过就绝不复用这份设备身份。它本身不是秘密（用户 id 不敏感），
但仍在密文内，避免「未登录也能读出本机绑定过谁」。

#### 2.6.3 场景一：用户正常登出（同用户）

```
① Desktop remote.disconnect()：发 bye(reason=signout) → close 1000
② 尽力 POST /mcp-devices/{self}/suspend（Cloud: status='suspended'）
③ 清 account/credentials.json（现有 signOut 行为）
④ **保留** remote/device.json（含 boundUserId 与 device_token）
⑤ **保留** mcp_grants（grant 属于用户，不因登出作废）
```

| 问题 | 决策 |
|---|---|
| 是否通知 Cloud？ | **要**，通知 `suspend` 而非 `revoke`。理由：登出是会话事件，不是设备事件；撤销设备会让下次登录必须重新走确认码 |
| 通知失败怎么办？ | **不回滚本地登出**。WSS 已断，Cloud 会在心跳超时后判定离线；`suspend` 失败只影响「Cloud 是否显示为已暂停」，不影响「能否路由」 |
| 旧用户的 Remote 授权是否还工作？ | **不能**。① 断连后无路由目标；② grant 需要 MCP access token，而 token 来自登录会话，登出后 refresh 已撤销，最迟 15 分钟内全部失效；③ 若用户重新登录，是**同一个** user_id，grant 本就属于他 |
| 设备身份会不会让旧用户复活？ | **不会**。`device_token` 只解决「哪台设备」，不解决「哪个用户的 grant」。Cloud 转发前必须同时通过 grant 校验 |

#### 2.6.4 场景二：用户切换（A 登出 → B 登录）——必须阻断继承

这是本节最重要的一条。若无约束会推出这个结论：
「A 的设备绑定还在 → B 登录后 Cloud 仍认为这台设备属于 A → Desktop 却用 A 的
device_token 连接 → B 的会话能看到 A 的设备名与授权状态、Cloud 侧仍显示
『A 的设备在线』」。虽然 B 拿不到 A 的业务数据（Desktop 库里只有本地数据，
grant 也属于 A），但**这已经是越权信息泄露与审计污染**。

**规则（已确定决策）**：设备身份可以保留，**设备与用户的绑定关系不能跨用户继承**。

```
B 登录成功（account-service 拿到 userId = uB）
  → remote.prepareFor(userId)
      device.json 不存在            → 无事（B 需自行注册设备）
      device.boundUserId === uB     → 允许 resume（同一用户重登，无需重新确认）
      device.boundUserId !== uB     → **强制阻断**：
          1. local_state['remote.enabled'] = 'false'（同步）
          2. linkState = 'blocked'
          3. 不删除 device.json（保留，供用户主动解绑）
          4. 界面显示：「此设备已绑定到另一个账号。要继续使用远程访问，
             需要先解绑并重新注册。」提供『解绑此设备』『取消』
          5. 『解绑此设备』= 删除 device.json + 提示用户到**旧账号**的
             Web 设置页删除对应设备行（本地 token 属于旧账号，无法代为删除）
```

**不允许的行为**：

- ❌ 静默复用旧 `device_token` 连接（Cloud 会认为 A 的资产在线）
- ❌ 自动把 `mcp_devices.user_id` 改成 B（等于静默转移资产）
- ❌ 认为「本地库是 B 的数据」就没有越权（Cloud 侧设备归属仍是 A）

##### 启动时校验：不依赖 UI（Phase 1.0.3 新增，对应 ST-17）

上面的 `prepareFor(userId)` 有一个致命前提：**它必须真的被调用**。如果它挂在
「用户打开设置页」或「渲染层请求 `remote:status`」上，那么崩溃重启后、或用户
从不点开设置页时，校验就永远不会发生——设备会在后台自动连上旧账号。

**规则（已确定决策）**：远程身份的校验发生在**主进程启动路径**上，与窗口和 UI 无关。

```
app.whenReady()
  → 初始化数据库 / local_state
  → 构造 RemoteService
      ① 读 local_state['remote.enabled']           默认 'false'
         为 'false' → linkState='idle'，**直接 return，不读密钥、不建连接**
      ② 读 userData/remote/device.json
         不存在 → linkState='idle'，return
      ③ 读当前 account 的 userId（account-service 的 restore 结果）
         未登录 → linkState='blocked'（不删凭据），return
      ④ device.boundUserId === 当前 userId ?
         不等 → local_state['remote.enabled']='false'（同步）→ linkState='blocked'
         相等 → 才允许进入 start() 的候选态（仍需 enabled=true）
      ⑤ 全部通过且 enabled=true → 才建立出站连接
  → 之后才创建 BrowserWindow
```

**三条硬性要求**：

| # | 要求 | 反例（必须判为不通过） |
|---|---|---|
| 1 | 校验在 `RemoteService` 初始化内完成，**早于**任何 `BrowserWindow` 创建 | 把 `prepareFor` 写在 `ipcMain.handle('remote:status')` 里 |
| 2 | 任一校验失败 → **零出站连接**（`net` 层可断言无 socket） | 「先连上再检查」 |
| 3 | 崩溃恢复后不依赖任何用户操作 | 要求用户「重新打开一次设置页」才生效 |

**为什么 ① 和 ④ 都要有**：崩溃场景里两者通常**同时**成立（用户已关闭开关 + 已切换账号），
但它们是两道独立的门——只有 ④ 会漏掉「同用户但用户已关开关」，
只有 ① 会漏掉「开关是 on 但账号已换」。**双门是刻意的冗余**。

#### 2.6.5 场景三：关闭远程开关（本地优先，已确定决策）

```
① Desktop（同步，权威）
   local_state['remote.enabled'] = 'false'
   linkState = 'idle'
   立即对任何新到的 req 回 REMOTE_DISABLED
   立即 reject 所有在途请求（reason: LOCAL_SWITCH_OFF）
② Desktop（异步，可失败）
   POST /mcp-devices/{self}/suspend
   无论成功与否 → 断开 WSS（close 1000）
③ 重新开启必须由用户再次操作，且必须重新展示 scope 清单
   （不能因为「上次同意过」而跳过确认）
```

**Cloud 不可达不能阻止 ① 生效。**

#### 2.6.6 场景四：忘记此设备

顺序固定，每一步失败都不能跳过后一步：

```
① 本地：local_state['remote.enabled'] = 'false'; linkState='blocked'
② 本地：断开 WSS（先断，避免删了凭据还在收请求）
③ Cloud：DELETE /mcp-devices/{self}（用当前 device_token）
④ 本地：删除 remote/device.json
⑤ 若 ③ 失败：
     - **仍然删除** ④（本机不能留一份「Cloud 可能仍记为 active」的私钥）
     - 界面提示：「已在本地解除，但云端记录可能仍在。请到 Web 设置页手动删除
       名为『<device name>』的设备。」
     - **不重试**（重试需要 token，而 token 已删；无限重试是死循环）
⑥ 结果：Cloud 侧可能残留一行 active 但无连接 → 表现为离线；
   用户在 Web 删除是唯一兜底路径，必须写进 UI 文案
```

#### 2.6.7 场景五：Token / 密钥轮换

```
前置：device.json 有旧私钥 + 旧 device_token，连接在线
① Desktop → POST /mcp-devices/{self}/rotate（Bearer 旧 token）
   body: { new_public_key, ts, sig = Ed25519_旧私钥(...) }
② Cloud：验旧公钥签名 → 单条 UPDATE 同时覆盖 public_key 与 token_hash
   → 返回新 device_token（**唯一一次**）
③ Desktop：**先落盘**新凭据（新私钥 + 新 token + 同一 boundUserId）→ 再重连
④ Cloud：删路由项 → 向旧连接发 bye(rotated) → close 4010
⑤ Desktop 收到 4010：用新凭据立即重连一次（**不按退避**）
```

| 失效关系 | 何时失效 | 依据 |
|---|---|---|
| 旧 `device_token` | ② 的 UPDATE 提交时 | `token_hash` 被覆盖 |
| 旧公钥 | 同上 | `public_key` 被覆盖 |
| 旧路由表项 | ④ | 显式删除 |
| 旧 WSS 连接 | ④ 的 close | Cloud 主动断 |
| **旧连接上在途的新请求** | **② 之后立即拒绝** | 见下 |

**关键约束**：轮换提交（②）后、close 到达（④）前，旧连接可能又收到一两个 `req`。
Cloud 必须在 ② 之后**立刻**把该 `connection_id` 标记为 `rotating`，
对这段时间到达的 `req` 直接回 `DEVICE_UNAUTHORIZED`。
**不允许旧连接在凭据已失效后继续接受新请求**——否则「轮换」只是换了个 token，
旧连接的安全语义没有变化。

---

## 3. Token 生命周期

### 3.1 四类凭证对照

| | Local MCP token | MCP access token | `device_token` | `claim_secret` |
|---|---|---|---|---|
| 前缀 | `bp_mcp_` | JWT（无前缀） | `bp_dev_` | 无（base64url 32B） |
| 生成方 | Desktop | Cloud Gateway | Cloud（绑定设备公钥） | Cloud |
| 存储 | Desktop SQLite `mcp_clients.token_hash`（只存 sha256） | 不落库（无状态） | Cloud `mcp_devices.token_hash`（只存 sha256） | Cloud 只存 sha256；明文只出现一次 |
| 生命周期 | 长期，手动撤销 | 15 分钟 | 30 天，可轮换 | **300 秒，一次** |
| 传递 | MCP 进程环境变量 | HTTPS `Authorization: Bearer` | WSS 握手 `Authorization` | HTTPS **POST 请求体**（仅领取那一次；**禁止**入 URL/query/日志） |
| 出本机 | **永不** | 是（到 Cloud） | 是（到 Cloud） | 是（到 Cloud，仅一次） |
| 校验方 | Desktop | Cloud（+ Desktop 二次 scope） | Cloud | Cloud |

### 3.2 MCP access token（JWT）

```jsonc
{
  "iss": "https://cloud.example.com",
  "sub": "<user_id>",
  "sid": "<mcp_session_id>",
  "aud": "https://cloud.example.com/mcp",   // RFC 8707 resource，≠ brewphase-desktop
  "grant_id": "<mcp_grants.id>",
  "client_id": "<client>",
  "scope": "records:read coffee:read",
  "iat": 1763400000, "exp": 1763400900,     // 15 min
  "jti": "<uuid>"
}
```

**与现有实现的差异（必须显式新建，不能「复用」）**：

```ts
// cloud/src/sessions/jwt.ts:15 —— 现状
export const TOKEN_AUDIENCE = "brewphase-desktop";
// signAccessToken 固定 .setAudience(TOKEN_AUDIENCE)；verifyAccessToken 固定校验它
// AccessClaims 只有 { userId, sessionId, jti }，无 scope / grant_id
```

因此 Phase 1.3 必须：

1. 新增 `signMcpAccessToken()`：同 keyring、独立 `aud`（= `MCP_RESOURCE`）、
   附加 `grant_id` / `client_id` / `scope`
2. 新增 `verifyMcpAccessToken()`：校验 `aud === MCP_RESOURCE`
3. **不改** 现有 `signAccessToken` / `verifyAccessToken` 的行为（Desktop 登录依赖它）

这样两个 audience 互不通用：Desktop 登录 token 打 `/mcp` 会被拒（`aud` 不符），
MCP token 打 `/auth/me` 同样被拒。**这是 B6 的关闭方式。**

> OAuth 三层（A 规范要求 / B ChatGPT 实际要求 / C BrewPhase 安全策略）的区分见
> `REMOTE_MCP_PROTOCOL.md` §15.1。**不允许用 B 层推测去放宽 C 层。**

- `jti` 只用于审计关联，**不做全局去重**（无状态校验的代价；防重放靠短 exp +
  服务端「同一 jti 在 5 分钟内重复出现」告警，不是硬拒绝）。
- **scope 不从 JWT 单独信任**：每次转发前仍查 `mcp_grants`（`revoked_at` / `scopes`
  以库为准），JWT 里的 `scope` 只作为「签发时快照」用于日志对比。

> **refresh 的归属是 `OPEN QUESTION`（OQ-3）**：现有 `auth_sessions` **没有**
> `session_kind`（Phase 1.0 文档误写为「独立 family `session_kind='mcp'`」）。
> 两条可选路径：① migration 给 `auth_sessions` 加 `session_kind TEXT NOT NULL
> DEFAULT 'desktop'`；② 新建 `mcp_sessions` 表，完全独立于登录会话。
> **倾向 ②**——MCP 客户端的登出绝不该碰用户的 Desktop 登录会话，独立表在结构上
> 保证这一点。定稿在 Phase 1.3。

### 3.3 `device_token`

- `bp_dev_` + `randomBytes(32).base64url`，Cloud 只存 `sha256`。
- 与 `mcp_devices` 行一一对应；轮换时旧 token 立即失效（覆盖 `token_hash`，
  不保留宽限）。
- **不与 `mcp_clients` 混用**：设备 id 只出现在 `mcp_operation_log.client_id`
  的 `remote:` 前缀里，不参与任何 MCP 语义（不是 client、不是 scope 主体）。

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
| Web 撤销 grant | `mcp_grants.revoked_at = now()` | 撤销该 grant 的 MCP refresh（若 OQ-3 选独立表） | 无感 | 下次请求查 grant 即拒 |
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
3. **撤销 grant ≠ 断连接**。设备可能还有别的 grant 在用。
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
| `/mcp`（HTTP） | access token 15 min；`jti` 记录 5 分钟窗口，重复出现触发告警并拒绝该请求 |
| WSS 请求帧 | **`delivery_id`（`id`）重复到达 → 回放缓存结果**；缓存 256 条 / 60 s，**断线即清**（Cloud 不在重连后重发，见协议 §8） |
| 设备握手 | 每次握手带 `nonce` + `ts`（±120s）+ Ed25519 签名；Cloud 用 `NonceStore`（复用 `sync/auth.ts` 的有界实现）判重，**check-and-record 必须原子**（两次调用之间不得 await） |

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

- 只记 `tool`、`status`、`duration_ms`、`error_code`、`device_id`、`grant_id`
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
| `grant_id` | ❌ 无列 | **只进 Desktop stderr 日志**（`[remote] tool=… grant=…`），不进库 |
| `delivery_id`（`request_id`） | ❌ 无列 | 同上；但 `entity_id` 仍留给业务实体，不复用 |
| `tool_name` / `success` / `error_code` / `created_at` | ✅ | 原样 |
| `entity_type` / `entity_id` | ✅ | 只读工具多数为空，`get_record` 等填实体 id |
| `idempotency_key` | ⚠️ 不用于远程 | 远程无持久幂等（协议 §8），该列写 `NULL` |

**Phase 1.2 迁移（migration 14）**将加三列：
`channel TEXT NOT NULL DEFAULT 'local'`、`device_id TEXT`、`request_id TEXT`。
届时 `client_id` 恢复写真实主体（`mcp_clients.id` 或 `mcp_devices.id`），
前缀方案退役——**但历史行的 `remote:` 前缀仍然可解析**，不需要回填。

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

**ST-16 与 ST-5 的区别**：ST-5 测「关闭时**新**请求到达」；ST-16 测「**已有执行中请求**
+ 同 `delivery_id` 重投」，它验证的是「缓存命中不能早于准入」（协议 §8.5 R1）。
两条都过，才能说「缓存不构成越权路径」。

**ST-17 的关键断言是「时机」而不是「结果」**：结果（不连接）容易做到，难的是
**不依赖 UI**。测试必须在「不创建 BrowserWindow」的 headless 主进程里跑，
否则它只能证明「用户打开设置页后才安全」——那已经太晚了。

**矩阵与阶段的关系**：1.1A 不含任何一项（它不接远程请求）——这是拆分 1.1A/1.1B
的直接理由之一。1.1B 必须通过 **ST-4 ~ ST-10、ST-13 ~ ST-17**；1.2 必须通过
ST-1 ~ ST-3、ST-11 ~ ST-12。**任一 ✅ 项未通过，不得进入下一阶段。**

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

**编号与完整汇总以 `REMOTE_MCP_ARCHITECTURE.md` §7.3 为唯一权威**（共 **22** 项：
`OQ-1`~`OQ-15` + `OQ-A`~`OQ-F`）。本节只列与安全直接相关的几项，说明其安全含义：

| # | 问题 | 为何无法确定 | 谁决策 | 影响 | 阻塞 1.1 |
|---|---|---|---|---|---|
| OQ-5 | 审计连续失败是否熔断远程开关 | 产品权衡 | 用户 | 1.4 | 否 |
| OQ-6 | 是否需要 E2E 加密（Cloud 只见密文） | 产品权衡；会影响 Cloud 侧过滤能力 | 用户 | 1.5 | 否 |
| OQ-7 | DCR 是否必需 | ChatGPT 行为 | 真实联调 | 1.3 | 否 |
| OQ-8 | 设备确认码是否必须走 Web | 产品流程；取决于是否有 Web 设置页 | 用户 | 1.2 | 否（默认 Web） |
| OQ-9 | 多设备路由策略 | 产品决策 | 用户 | 1.2（默认单连接顶替）、1.4 | 否 |
| OQ-10 | Cloud 审计/日志留存 30 天是否满足合规 | 合规要求外部 | 用户 | 1.2 | 否 |
| OQ-3 | MCP 会话归属（`session_kind` vs `mcp_sessions`） | 取决于是否复用 rotation | 1.3 设计 | 1.3 | 否 |
| OQ-E1 | Electron 主进程 Ed25519 是否与系统 Node 一致 | 系统 Node 已实测，Electron 未验证 | 1.1B 第一天 spike | 1.1B | 否（低风险） |
| OQ-E2 | Windows DPAPI / Linux keyring 的 `safeStorage` 行为 | 需对应实机 | 1.1B 后期 | 1.1B（若含 Windows） | 否，若首发仅 macOS |
