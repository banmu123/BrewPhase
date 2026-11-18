# BrewPhase Remote MCP — 安全模型（Phase 1.0 设计，1.0.1 / 1.0.2 / 1.0.3 修订）

> 与 `MCP_SECURITY.md`（Local MCP）互补，**不复用它的信任边界**。
> 本文只覆盖远程链路：MCP Client 授权、设备身份、Scope、Token 生命周期、
> 撤销、跨用户隔离、隐私与威胁模型。
> 架构见 `REMOTE_MCP_ARCHITECTURE.md`，协议见 `REMOTE_MCP_PROTOCOL.md`。
> 修订：**Phase 1.0.1**、**1.0.2**、**1.0.3**（均 2026-11-17），
> 基线 `feature/remote-mcp` @ `89866cd`。

> **文档族导航**：安全族共 2 册，章节号全族唯一：
> - `REMOTE_MCP_SECURITY.md`（本册）：§0 三条前提、§1 信任边界、§2 五层权限模型（**§2.6 = 五身份唯一权威**）、§3 Token 生命周期
> - `REMOTE_MCP_SECURITY_OPERATIONS.md`：§4 状态机与撤销、§5 跨用户隔离、§6 数据隐私与审计（§6.5 审计方案）、§7 威胁模型（**§7.1 = ST 测试矩阵唯一权威**）、§8 与 Local MCP 边界、§9 OPEN QUESTION
> 全系列索引见 `REMOTE_MCP_INDEX.md`。
## 0.0.3 Phase 0（P0-1 / P0-2）修订摘要（本系列）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | **P0-1**：删除连接级 `hello_ok.scopes`，改为逐 grant 的 **Grant 授权上下文**（§2.7）；请求只带 `grant_ctx`；撤销时清该 grant 缓存 | 同一设备上的多个 MCP Client 无法用连接级 scope 区分；旧 `req.grant_id` 只是审计字段 |
| 2 | **P0-2**：`jti` 明确为 **Token 级**、不做请求去重（§3.2.1）；`/mcp` 不引入 per-request nonce | 原文 §3.2 与 §5.3 互相矛盾；按 `jti` 去重会拒绝同一 token 的正常第二次调用 |
| 3 | 错误码 17 → **19**；ST 17 → **26**；OQ 22 → **23** | 新语义需要独立错误码与回归门禁；写工具的发送者约束（OQ-16）仍开放 |

## 0.0 Phase 1.0.3 修订摘要（本系列）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | §3.1 / §2.3.2 把 `claim_secret` 的传递改为 **POST 请求体**，并明确禁止入 URL/日志/错误信息 | query 会进反向代理 access log；凭证不该出现在 URL 里 |
| 2 | §6.5.6 明确审计失败计数器是**进程内状态**，重启归零，且 UI 不得描述为「历史已补齐」 | 1.0.2 只写了「内存维护」，没禁止把归零当修复 |
| 3 | §7.1 新增 **ST-16**（关闭开关与重复投递的竞态）与 **ST-17**（用户切换后的崩溃恢复） | 这两条是「缓存越权」与「重启后自动连旧设备」的唯二防线，此前没有验收项 |
| 4 | §7.1 修正 **ST-13 的阻断级别说明**（✅ 阻断），并统一「阻断只有两档」 | 阶段文档曾把它写成不阻断，与本文冲突 |
| 5 | 全文时间表述复核为 **Unix epoch（跨进程）/ monotonic（进程内）** 二分 | 与协议 §2.1 对齐；「单调 epoch」类混合术语会误导 deadline 实现（ST-9） |

## 0.0.1 Phase 1.0.2 修订摘要（本系列，保留）

| # | 修订点 | 原因 |
|---|---|---|
| 1 | §6.5.5 重写为**三段状态分离**（准入 / 业务 / 审计），并新增 §6.5.6–6.5.10 | 原文只说「不把查询报成失败」，未定义审计算不算数，也没禁止声称审计完整 |
| 2 | §6.5.7 把 `OQ-5` 熔断的**待评估条件**扩到 6 项，明确「未定稿」 | 原文只有一句倾向，没有任何可评估的判据 |
| 3 | 新增 §2.6 **五个身份分层 + 五个生命周期场景** | 设备身份与用户登录、设备绑定、grant 三者从未被显式拆开 |
| 4 | 新增 `boundUserId` 机制 | 缺少「A 登出 → B 登录」的阻断点，会继承 A 的设备绑定 |
| 5 | 威胁模型新增 T17 / T18 / T19 | 用户切换继承、审计三段混淆、`delivery_id` 被替换内容 |
| 6 | 新增 §7.1 **安全集成测试矩阵**（1.0.2 时为 ST-1~ST-15） | 原文档有威胁但无对应验收用例，无法判定阶段是否真的安全 |
| 7 | 审计可靠性承诺边界（§6.5.10）明确「不承诺取证级不可篡改」 | 避免对外表述夸大 |

## 0.0.2 Phase 1.0.1 修订摘要（本系列，保留）

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
│    ├─ 可重放截获的请求   → 全链路 TLS + 15 min `exp` + `aud` 绑定 + 逐请求 grant/scope 校验；
│    │                       **不按 `jti` 去重、不加 per-request nonce**（§3.2.1 / §15.2）
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
- **这张表在 Phase 1.2 建，不在 1.3**：1.2 的「转发前校验 `grant.user_id ==
  device.user_id`」（ST-1，发布阻断项）必须读它。1.3 只补 `mcp_oauth_clients` /
  `mcp_auth_codes` 与签发路径。

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

#### 2.3.1a device_token 的传输纪律（Phase 1.1B.1）

| 载体 | 允许 | 理由 |
|---|---|---|
| WSS 握手 `Authorization: Bearer bp_dev_…` | ✅ **唯一**允许的地方 | 头不进 URL 日志；且 TLS 失败时服务端连头都收不到（Spike 实测 `net::ERR_INSECURE_RESPONSE`） |
| `hello` 帧字段 | ❌ | 帧会被 Cloud 应用层看到并可能进日志；已在头里，重复传递只增加泄漏面 |
| URL / query | ❌ | 会进反向代理 `access_log`、崩溃转储、错误上报 |
| `Sec-WebSocket-Protocol` | ❌ | 子协议头同样会进代理日志 |
| 渲染进程 / IPC 返回值 | ❌ | Renderer 只需要「是否已配对」，不需要凭据 |
| 磁盘明文 | ❌ | 只以 safeStorage 密文存在于 `remote/device.json`；不落明文、不落可逆编码 |

**形态判据**：`^bp_dev_[A-Za-z0-9_-]{16,}$`。它不是安全门槛（真正的判据是
Cloud 侧 `sha256(token)` 命中 `token_hash`），作用是便宜地挡掉
「拿错凭据域」的东西——用户 access token、`bp_mcp_*`、空串——让这类错误
在握手第一步就失败，而不是等到业务层才暴露。

**这条纪律的反面教材**：Phase 1.1B 的连接层把 `Authorization` 丢掉了，
`hello` 里也没有 token，而 Mock Gateway 无条件返回 `101`。于是「设备认证」
在客户端和服务端**两边都没实现**，测试却全绿——因为两侧都不检查。
现在的防守是双边的：Mock 拒绝无 token / 伪造 token / 错误子协议，
连接层在拿不到 `electron.net` 时**直接抛错**而不是静默退回全局 `WebSocket`。

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
   Cloud 握手校验 9 步 + `hello_ok` 构造（协议 §4.3 共 10 项），含验签与 nonce 去重
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

**Scope 的归属是 grant，不是连接（Phase 0 / P0-1 定稿）**：`hello_ok` **不再**携带
连接级 `scopes` 字段。每个 grant 的 scope 集合由 Cloud 在授权时确定，随
**Grant 授权上下文**下发（§2.7）。Desktop 的所有 scope 判定都必须以
`grant_ctx.scopes` 为输入；从连接级字段推断 scope 会让同一设备上的多个
MCP Client 无法区分——这是 P0-1 要关闭的漏洞。

**错误码的唯一权威表在 `REMOTE_MCP_PROTOCOL_RUNTIME.md` §9.1（19 个）。** 本文只按语义
引用其中与安全相关的若干（`DEVICE_REVOKED` / `SCOPE_DENIED` / `TOOL_NOT_ALLOWED` /
`USER_MISMATCH` / `GRANT_CONTEXT_INVALID` / `GRANT_REVOKED` 等），不重复定义第二次，
避免两处漂移。

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

> **状态（Phase 1.2B.1）**：`rotating` **尚未实现**，因为 1.2B.1 不转发任何 `req`
> ——没有请求就没有「旧连接继续接新请求」这条路径。它因此是 **1.2B.2 的第一个
> 交付项**，必须排在 `req` 转发之前：转发层一开，这个窗口就真实存在。
> 关闭码 `4010` 与 Desktop 侧的「换新凭证立即重连一次」已经就绪。

---

### 2.7 Grant 授权上下文（Phase 0 / P0-1 定稿）

> **要解决的问题**：Grant 是 **MCP Client 级**授权（I4），WSS 是 **设备级**连接（I5）。
> 旧设计只有连接级 `hello_ok.scopes`，请求帧里的 `grant_id` 又只是「审计字段、
> Desktop 不据此决策」——于是同一个设备上「ChatGPT 的请求」和「另一个 AI 客户端的
> 请求」在 Desktop 看来完全一样：无法逐 Client 校验 scope，也无法在撤销其中一个
> grant 后阻止它的缓存被回放。

> **Phase 1.2B.2.2 的落地结果**（先看结论再看设计）：`grant_ctx` 现在是
> **Cloud 单方面映射**的——调用方只给 `grantId`，ctx 由 Cloud 从**当前连接**的
> 上下文表反查。请求帧里没有 `grant_id` / `client_id` / `scopes`，所以
> 「两个事实来源」这条隐患在结构上消失了。撤销时 Cloud 先停路由、结束在途请求、
> 再发 `revoke` 帧并等 ack；ack 超时/为 false 一律 `grant_sync_lag` 并停止该设备
> **全部** grant 的路由（fail-closed）。详见协议运行时 §6.5.2 / §9.4。

#### 2.7.1 两个候选方案与取舍

| 维度 | **A. Grant 独立授权上下文（采用）** | B. 每请求携带可验证断言 |
|---|---|---|
| 形态 | Cloud 在握手/变更时下发上下文；`req` 只带不透明引用 `grant_ctx` | `req` 携带 Cloud 签名的 JSON（grant / client / scope / user / exp） |
| 信任锚 | 已认证的 WSS（`device_token` + Ed25519 + TLS），**不新增 PKI** | 需要第二套签名密钥 + Desktop 内置公钥 + 轮换流程 |
| 撤销 | Cloud 停路由 + 下发 `revoke`；Desktop 立即清上下文与缓存 | 签名只证明来源，**不能撤销**；仍须下发黑名单——没有减少任何工作 |
| 每请求成本 | 一个字符串引用 | 一次签名运算 + 更大的帧 |
| 失效风险 | 上下文陈旧 → 用 `grant_epoch` + ack + 重连快照消除 | 密钥轮换窗口、时钟偏差、多版本公钥并存 |
| 结论 | ✅ 采用 | ❌ 只把「来源可信」从信道搬到消息层，而信道本来已可信 |

**关键判断**：B 方案常被误认为「更安全」，但它只解决「这条请求是不是 Cloud 发的」。
在一条已经由 `device_token` + Ed25519 双向认证的 WSS 上，这个问题**本来就有答案**。
真正的难点是「Grant 被撤销后，缓存、执行中请求和后续请求怎么办」——B 方案对此
毫无帮助，仍要推送 + 状态机。既然撤销机制两个方案都绕不开，就没有理由再引入
第二套密钥体系；A 方案的上下文本身就携带逐 grant 的 scope，且可被撤销。

#### 2.7.2 六个必答问题

| # | 问题 | 决策 |
|---|---|---|
| 1 | 每次工具请求如何绑定 Grant | `req.grant_ctx` **必填**；Desktop 用它在内存上下文表查到唯一 grant。上下文**只能**由 `hello_ok` / `grant_update` 安装，绝不从 `req` 读取 grant / client / scope / user |
| 2 | Desktop 如何验证请求所属 Grant | 四查：① `grant_ctx` 已知；② 状态 `active`；③ `epoch` 等于当前值；④ `bound_user_id == device.boundUserId`。任一失败即拒，**在查缓存之前** |
| 3 | Desktop 如何校验工具所需 Scope | `effective_scopes = ctx.scopes ∩ REMOTE_SCOPES ∩ 本地允许集`；`required_scope(tool) ∈ effective_scopes`。`executeTool` 内部再验一次（结构保证，不是冗余） |
| 4 | Cloud 如何保证 Grant 与设备属于同一 user | 三个等式：`grant.user_id == token.sub`、`device.user_id == token.sub`、`grant.user_id == device.user_id`。**每次转发前查库**，不信任 JWT 里的 `scope` 快照 |
| 5 | Grant 撤销后，缓存/执行中/后续请求如何处理 | Cloud 先停路由，再 `grant_epoch+1` 并下发 `revoke`；Desktop 移除上下文、清该 `grant_ctx` 的全部缓存（含 inflight 占位）；在途请求完成后**不回传数据**，回 `GRANT_REVOKED`；后续请求 `GRANT_CONTEXT_INVALID` |
| 6 | 同一设备多个 MCP Client 的不同 Scope 如何隔离 | 逐 grant 的 `scopes` / `effective_tools` / 缓存键 `(grant_ctx, delivery_id)` / 撤销范围。`max_inflight` 是连接级共享上限（已知取舍，见 §2.7.6） |

#### 2.7.3 Cloud 与 Desktop 各自负责什么

| 检查 | Cloud | Desktop |
|---|---|---|
| token 签名 / `aud` / `exp` | ✅ 唯一 | — |
| `grant.user_id == sub` | ✅ | — |
| `device.user_id == sub` | ✅ | — |
| `grant.user_id == device.user_id` | ✅ | ✅（`bound_user_id` vs `boundUserId`） |
| grant 未撤销 / scope 覆盖工具 | ✅ 转发前查库 | ✅ 执行前查上下文 |
| 工具白名单 / Zod | ✅ 粗筛 | ✅ **最终** |
| 本地远程开关 | — | ✅ **最终否决** |
| 设备归属是否可跨用户继承 | —（不知道本机登录态） | ✅ **最终否决** |

**「Desktop 不根据 `grant_id` / `client_id` 决策」这条规则必须精确化**：它禁止的是
「根据**请求帧里的自报字段**决策」，不是「禁止使用任何 grant 信息」。正确表述是：

> Desktop 可以、并且必须根据 **Cloud 通过已认证信道下发且经本地校验的 grant 上下文**
> 决策；它绝不根据 `req` 里的自报 `grant_id` / `client_id` / `scopes` 决策。

否则规则会自相矛盾——P0-1 的方案要求 Desktop 按 grant 校验 scope，而旧措辞
字面上禁止它这么做。

#### 2.7.4 撤销语义（逐对象）

| 对象 | 撤销后的行为 |
|---|---|
| 上下文 | 立即移除；`grant_epoch` +1；**不落盘** |
| 缓存 | 该 `grant_ctx` 的全部条目（含 inflight 占位）同步清除 |
| 执行中请求 | 同步 handler **无法中断**；完成后不回传数据，回 `GRANT_REVOKED`，不写缓存 |
| 后续请求 | Desktop 回 `GRANT_CONTEXT_INVALID`；Cloud 在转发前即回 `GRANT_REVOKED` |
| 同设备其它 grant | **不受影响**（这是拆到逐 grant 上下文的主要收益） |
| 重连 | `hello_ok.grants` 快照不含该 grant → 永久失效 |

**为什么缓存键含 `grant_ctx` 还不够**：分键只解决「A 的结果不被 B 命中」，不解决
「撤销后仍能回放撤销前的数据」。必须在撤销时**清除**该 grant 的全部条目——
理由与关闭远程开关时清缓存相同（协议 §8.5）。

#### 2.7.5 上下文的生命周期

* **只在内存**：随 WSS 建立而安装，随连接断开全部丢弃；不写 `device.json`、不写 SQLite。
  这消除了「重启后读到陈旧授权」的整类问题。
* **来源唯一**：`hello_ok.grants`（全量快照）与 `grant_update`（增量）；二者之外没有第三条路径。
* **版本唯一**：`grant_epoch` 由 Cloud 按设备单调递增；Desktop 丢弃 `epoch <= 当前` 的更新（幂等）。
* **安装先于路由**：Desktop 必须在下一条帧之前应用完 `hello_ok.grants`；Cloud 对
  `install` 必须收到 `grant_update_ack` 才允许为该 grant 路由（协议 §6.5）。

#### 2.7.6 已知取舍

| 取舍 | 说明 | 后续 |
|---|---|---|
| `max_inflight` 仍为连接级 | 同一设备多个 Client 共享 2 个在途名额，一个 Client 可能挤占另一个 | Phase 1.4 若引入多设备/多租户再评估按 grant 配额（不阻塞 1.1） |
| 审计表仍只记 `remote:<device_id>` | 1.1 零迁移约束；`grant_id` 只进 stderr | Phase 1.2 迁移加 `grant_id` 列（安全 §6.5.3） |
| 上下文撤销依赖 ack | 网络分区时 Cloud 可能短暂无法确认 Desktop 已撤销 | fail-closed：超时即暂停向该设备路由所有 grant（协议 §6.5） |
| **不防御已被攻破的 Gateway** | 见 §2.7.7——本方案的信任锚就是 Cloud 授权服务本身 | 若要防，需 Grant 由用户设备或独立签发方签名（未排期） |

#### 2.7.7 Grant 快照的信任边界（Phase 1.1B 明确，避免文档自相矛盾）

**必须写清楚：Cloud 授权服务是 Grant 快照的可信签发方，不是「不可信的 Grant 来源」。**

| 命题 | 是否成立 | 说明 |
|---|---|---|
| TLS/WSS 能证明「连接的另一端确实持有 `cloudOrigin` 的证书」 | ✅ | 这是传输层身份，本方案依赖它 |
| TLS/WSS 能证明「Cloud 内部没有被攻破、下发的一定是用户真实授权」 | ❌ | **不成立**。TLS 只保护信道，不保护端点 |
| 本方案能抵御「已被攻破且主动伪造授权的 Cloud Gateway」 | ❌ | **明确不宣称**。见下 |

因此本方案的信任模型是 **MVP 信任模型**，显式声明如下：

1. **信任锚**：`cloudOrigin` 指向的 Cloud 授权服务。`hello_ok.grants` 与
   `grant_update` 的内容**被当作事实接受**——只要通过信道认证与结构校验。
2. **Desktop 的最终否决权不检查「Cloud 说得对不对」，只检查「本地条件允不允许」**：
   - 本地开关 `enabled` 必须为 on；
   - 上下文的 `bound_user_id` 必须等于本机 `boundUserId`；
   - `grant_ctx` 必须存在、`active`、`epoch` 为当前值；
   - 工具的 scope 必须在 `effectiveScopes(grant)` 内；
   - 工具必须在 `REMOTE_TOOLS` 常量内。

   这些条件**能挡住**：用户已关闭开关、本机换了用户、授权上下文过期、
   Grant 已被撤（Cloud 主动告知时）、scope 不足、Cloud 试图越界调用本机 8 个只读工具之外的任何东西。
3. **挡不住**：一个能签发合法 TLS 证书、且已攻破 Cloud 的攻击者，直接伪造
   `grants[]` —— 他可以给某个 Client 伪造更大的 scope，甚至伪造一个不存在的
   Client。此时 Desktop 仍会执行「8 个只读工具 ∩ 伪造 scope」范围内的调用。
   **这是本方案的已知边界，不掩盖**。

**为什么第一版接受它**：

- 8 个工具全只读，且 `REMOTE_TOOLS` 是 Desktop 写死的常量——
  被攻破的 Cloud 最多让攻击者多读一些**用户的记录/豆子/画布**，
  拿不到写入、终端、文件系统。
- 要对冲这一步，需要 Grant 由**用户设备或独立签发方**签名（Desktop 内置公钥），
  那是另一套 PKI，成本与 OQ-16 的发送者约束同级。**未排期，登记为 OQ-18。**

**文档纪律**：不得在任何地方把 Cloud 同时描述成
「Grant 的唯一可信来源」和「不可信的 Grant 来源」。正确表述是：
**信道可信（TLS + device_token + Ed25519）；端点可信度是假设，不是保证；
本地校验限制的是「即使端点说谎，能造成的最大损害」。**

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

**claims 里的 `grant_id` / `scope` 是「签发快照」，不是授权依据**：`/mcp` 每次请求
必须按 `sub` + `grant_id` **回查 `mcp_grants`**（`revoked_at IS NULL` 且 scope 以库里为准），
否则撤销要等 15 分钟才生效。claim 只用于「找到是哪个 grant」和日志关联。
这与 P0-1 的立场一致：**授权判断永远看服务端/上下文里的事实，不看自报字段**
（安全 §2.4、§2.7.3；协议 §15.2）。

这样两个 audience 互不通用：Desktop 登录 token 打 `/mcp` 会被拒（`aud` 不符），
MCP token 打 `/auth/me` 同样被拒。**这是 B6 的关闭方式。**

> OAuth 三层（A 规范要求 / B ChatGPT 实际要求 / C BrewPhase 安全策略）的区分见
> `REMOTE_MCP_PROTOCOL_LIFECYCLE.md` §15.1。**不允许用 B 层推测去放宽 C 层。**

- `jti` 是 **Token 级**标识，不是请求级标识；同一 token 允许承载多次正常调用。
  完整语义见 §3.2.1（Phase 0 / P0-2 定稿）。
- **scope 不从 JWT 单独信任**：每次转发前仍查 `mcp_grants`（`revoked_at` / `scopes`
  以库为准），JWT 里的 `scope` 只作为「签发时快照」用于日志对比。

#### 3.2.1 `jti` 的语义（Phase 0 / P0-2 定稿）

**结论：`jti` 是 Token 级标识，不是请求级标识；同一个 access token 允许多次正常调用。**

| # | 问题 | 决策 |
|---|---|---|
| 1 | `jti` 是 Token 级还是请求级 | **Token 级**。签发时生成，`exp` 之前不变；一个 token 一个 `jti` |
| 2 | 同一 access token 是否允许多次调用 | **允许，且是常态**。MCP Streamable HTTP 下，一个会话在 15 分钟内会有几十次 `tools/call`，全部共享同一 `jti` |
| 3 | HTTP 请求级重放保护用什么 | v1 **不引入** per-request nonce / 硬去重。防线：TLS + 15 分钟 TTL + `aud` 绑定 + 每次转发查 grant/scope + 8 个工具全部只读 |
| 4 | 重复请求与合法重试如何区分 | HTTP 层不区分。在 MCP 工具层用 `Idempotency-Key`（MCP 规范）或网关 `delivery_id`：同 key = 重试，不同 key = 新调用 |
| 5 | 是否需要独立 request_id / nonce / 摘要 | HTTP 层 v1 **不需要**；WSS 层已有 `delivery_id` + `request_hash`。可选的 `request_digest` 只用于审计关联，**不参与放行** |
| 6 | 是否会误伤正常 MCP Client | 不会：不做 `jti` 去重、不加 per-request nonce。唯一保留的是**异常信号**（同一 `jti` 在 60s 内来自两个不同来源指纹 → 告警 + 审计，**不拒绝**） |

**为什么不能按 `jti` 去重**：`jti` 在 token 生命周期内是常量。若规定「同一 `jti`
5 分钟内重复出现即拒绝」，那么同一个 token 的**第二次正常工具调用**就会被拒——
这不是防重放，是拒绝服务。Phase 1.0 的 §5.3 曾这样写，P0-2 予以纠正。

**`jti` 的真实用途（三者都不是「请求去重」）**：

1. **审计关联**：把同一 token 下的多次调用串成一条会话链（Cloud `/mcp` 结构化日志可记 `jti` 前 8 位）。
2. **未来撤销的键**：若要提前吊销未过期 token，denylist 以 `jti` 为主键（当前无状态，不实现）。
3. **异常检测**：同一 `jti` 短时间内来自不同来源指纹 → 可能是 token 被复制，**告警但不阻断**（NAT / 移动网络切换会造成误报）。

**写工具开放前必须重评**：只读工具重放只造成重复读；一旦开放写工具，必须引入
发送者约束（DPoP，RFC 9449）或 per-request nonce。见 `OQ-16`。

> **refresh 的归属已定稿（OQ-3 关闭，Phase 1.3.0）**：采用**独立 `mcp_sessions` 表**，
> **不改** `auth_sessions`（现有表没有、也不该有 `session_kind`）。
>
> 决定性理由有三条，均来自真实代码而非偏好：
> 1. `auth_sessions.refresh_token_hash` 是**全局 UNIQUE**——两个域的 token 挤在同一
>    唯一性域里，任一侧的清理都会波及另一侧；
> 2. `logoutByRefreshToken()` 与 `rotateRefreshToken()` 的复用检测都会**撤销整个
>    `token_family`**——共表时 MCP 客户端登出（或并发刷新被误判为盗用）会直接踢掉
>    Desktop 登录；
> 3. `auth_sessions` 没有 `client_id` / `grant_id` / `scope` / `resource`，
>    加进去等于一张表两种语义，且现有 340+ 条会话测试的每条查询都要记得按
>    kind 过滤——漏一处就是越权或误踢。
>
> 完整状态机、轮换流程与「登出/撤销/过期」行为矩阵见
> **`REMOTE_MCP_PHASE_1_3_DESIGN.md` §9**。该矩阵是 OQ-3 的验收本体：
> 任何一行出现跨域联动（MCP 登出影响 Desktop、Desktop 登出撤 MCP）即违反决策。

### 3.3 `device_token`

- `bp_dev_` + `randomBytes(32).base64url`，Cloud 只存 `sha256`。
- 与 `mcp_devices` 行一一对应；轮换时旧 token 立即失效（覆盖 `token_hash`，
  不保留宽限）。
- **不与 `mcp_clients` 混用**：设备 id 只出现在 `mcp_operation_log.client_id`
  的 `remote:` 前缀里，不参与任何 MCP 语义（不是 client、不是 scope 主体）。

## 12. 派发层的三条不变量（Phase 1.2B.2.2）

这一节只写**实现完之后仍然成立、且随时可能被下一个改动破坏**的三条。
它们不是设计偏好，而是「撤销/轮换/超时」三类边界能不能守住的前提。

### 12.1 授权判据只在数据库，不在任何快照里

| 看起来可以省一次查询的东西 | 为什么不行 |
|---|---|
| JWT 里的 scope 快照 | 撤销后 token 仍然有效到过期，快照也跟着有效 |
| `hello_ok.grants` | 那是一次握手的快照；撤销/scope 变更之后就过时了 |
| `ConnectionRegistry` 里的连接 | 它只说「socket 还在」，不说「授权还在」 |
| Desktop 上报的 `serviceable` / `inflight` | 被限流方自报的状态，不能当授权或限流判据 |
| `req` 帧里的任何字段 | 帧里根本没有身份字段——这是刻意的 |

代价是每次派发两次索引查询。收益是「撤销在下一个请求就生效」，
而这正是只读工具**唯一**的安全兜底（只读没有写副作用可以回滚）。

### 12.2 「不知道」必须收敛成「不路由」

`grant_update` 的 ack 超时、连接在同步途中断开、`applied=false`——三种情况的
共同点是**Cloud 无法确认 Desktop 侧的授权表是什么样**。在授权语义里
「不知道」等于「可能还是旧的」，所以一律 `grant_sync_lag` 并停止该设备
**全部** grant 的新请求。恢复路径只有一条：重新握手，以新的 `hello_ok`
快照为准。

这条约束的代价很重（一台设备上的所有 AI 客户端停服），所以它**只在真的
无法确认时**触发。三个必须区分的信号：

| 信号 | 含义 | 处置 |
|---|---|---|
| `applied=false` | 对端明确拒绝（协议理解不一致 / 上下文不合法） | 停路由 + **告警**（这是 bug） |
| ack 超时 | 对端没说话 | 停路由（可能是网络或设备卡住） |
| 连接断开 | 对端不存在了 | 停路由（重连会拿到新快照） |

把三者合成一个「同步失败」会让「Cloud 与 Desktop 对协议理解不一致」这种
必须人工介入的故障，与「笔记本睡眠了 3 秒」混在同一条日志里。

### 12.3 迟到的结果不能越过授权边界

三类迟到，三种处置，都必须在**结算之前**判断：

| 迟到的东西 | 判据 | 处置 |
|---|---|---|
| 旧连接的 `res` | `entry.connectionId !== 帧来源 connectionId` | 忽略（warn） |
| 已结算 id 的 `res` | 幂等完成已返回 `false` | 忽略（debug） |
| 撤销/轮换之后到达的 `res` | 请求已被 `GRANT_REVOKED` / `DEVICE_UNAUTHORIZED` 结束 | 忽略 |

第一条尤其隐蔽：连接被顶替后，同一个 `delivery_id` 可能在新连接上被复用，
旧连接的 `res` 此刻才到——只按 `id` 匹配的实现会把「上一个会话的结果」
交给这次调用。
