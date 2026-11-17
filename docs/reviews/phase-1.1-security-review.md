# BrewPhase Phase 1.1 — 独立安全与工程审查报告

> 日期：2026-11-16 · 审查对象：`cloud/` 独立云端账号服务
> 被审分支：`feature/cloud-account-phase-1.1` · 审计基线：`main @ bcfc25b`
> 性质：**独立审查，未修改任何项目文件**（源码 / 测试 / Schema / 迁移 / 配置 / 分支零改动；本报告是本次任务唯一新增文件）。
> 结论先行：**A. PASS** — 未发现 Critical / High 问题；2 项 Medium（1 项部署条件性、1 项设计取舍残余）与 5 项 Low 建议在 Phase 1.2 前处理，不阻塞合并。

---

## 1. 审查范围与环境

| 项 | 内容 |
|---|---|
| 代码范围 | `cloud/` 全部 33 个源码文件 + 11 个测试文件 + Dockerfile / .env.example / README |
| 参照文档 | 实施报告 `docs/implementation/phase-1.1-cloud-account-report.md`、架构审计 `docs/architecture/cloud-account-audit.md`、任务书（Phase 1.1 规格） |
| 运行环境 | Windows（win32）· Node 22.22 · pnpm 9 · Docker 28（PostgreSQL 16 容器 `brewphase-cloud-test-pg` @ 127.0.0.1:54329，保留运行中） |
| 审查方法 | ① 全量代码精读（逐文件定位到行号）；② 执行现有测试套件；③ **仓库外一次性验证脚本**（运行后已删除）对现有测试未覆盖的 7 个风险场景做真实运行验证；④ 工程门禁复跑（typecheck / lint / build） |
| 独立性说明 | 审查脚本位于仓库外（`D:/work/BrewPhase/bp-review-verify.mts`，验证完成后已删除），仅通过 import 读取项目模块；未向仓库写入除本报告外的任何文件 |

## 2. Git 基线与工作区状态

- 分支 `feature/cloud-account-phase-1.1`，HEAD = `eee2a32 feat(cloud): Phase 1.1 独立云端账号服务`（已推送 origin，含上游跟踪）。
- `bcfc25b..HEAD` 全部差异 = 新增 `cloud/`（58 文件）+ 审计文档 + 本报告前置的实施报告；**Desktop / iOS / ChromeExtension / Android 路径零改动**（`git diff --name-only` 验证为空）。
- 工作区仅有 `.workbuddy/memory/` 两个代理记忆文件未提交改动（非项目代码，不影响审查对象）。
- 未发现任何 Secret 入库：`cloud/.env` 不存在，仅 `.env.example` 占位；源码中密钥均为 `test-*` 假值；`.gitignore` / `.dockerignore` 均排除 `.env`。

## 3. 安全架构复核

实施与审计报告的架构一致性核对（逐项）：

| 审计/规格要求 | 实现 | 判定 |
|---|---|---|
| 双 State 完全独立、只存哈希、不混用 | `state.ts`：`client_state_hash` / `provider_state_hash` 两列独立，PR 服务端生成、CS 客户端生成，各自哈希校验 | ✅ |
| Client State 回传且不落明文 | PR.CS 经 provider state 参数透传（base64url 无 `.`，首个 `.` 切分），回调时 H(CS) 完整性校验后原样回传 | ✅ 设计成立 |
| PKCE S256、一次性授权码、60s TTL | `token-exchange.ts` 原子消费；`authorization.ts` challenge 形态强校验（43 字符 base64url） | ✅ |
| Google OIDC 全量验证 | `google.ts`：jose `createRemoteJWKSet` + `algorithms:["RS256"]` 钉死 + issuer/aud/exp + **nonce 哈希恒定时间比对**（明文 nonce 只在 authorize URL 出现一次） | ✅ |
| GitHub 服务端流程、无仓库权限、email 可空 | `github.ts`：scope 留空，subject = 数字 ID 字符串化，emailVerified 恒 false | ✅ |
| Refresh rotation + family 撤销 | `session-service.ts`：事务 + FOR UPDATE + 30s 并发宽限窗口 | ✅（残余风险见 I-2） |
| 哈希存储纪律 | refresh token / 授权码 / 双 State / nonce / IP 全部 SHA-256(pepper 域分隔)，grep 全库无明文落库路径 | ✅ |
| 审计事件最小化 | `auth_events` 七类事件，detail 仅含 family/count/reason 等非敏感字段，无 token/code/资料 | ✅ |
| Desktop 授权协议 | authorize 校验（provider/state 形态/S256 形态/redirect 白名单）→ provider 流 → 回调验 state → 一次性码（绑定 challenge+redirect_uri）→ token 交换五重校验 | ✅ |

与实施报告声明的差异核对：报告所述「nonce_hash 为规格外补充列」「oauth_codes.transaction_id 无 FK（防级联误删）」「限流为单实例内存实现」均与代码一致，无虚报。

## 4. OAuth 安全审查

### 4.1 State 机制
- **独立性**：✅。CS 由 Desktop 生成（32–128 位 base64url 强制，≥192 bit 熵），PR 由 Cloud 生成（256 bit）；两值不共用存储列、不共用校验路径。
- **CSRF**：✅。CS 仅由 Desktop 本地逐字节比对（Cloud 不代验，符合规格）；攻击者无法预知 CS，无法向 localhost 回调注入伪造会话（authorization code injection 被 CS + PKCE 双重阻断）。
- **重放**：✅。事务在签发授权码的同一事务内删除（`callback.ts:144`）；顺序重放 400 invalid_grant（现有测试覆盖）。过期事务惰性删除（`state.ts:99-101`），**独立验证 V2 确认**过期后回调返回 400 且不重定向。
- **篡改**：✅。PR.CS 中 CS 被篡改 → H(CS) 不匹配 → 事务删除 + 拒绝（`state.ts:104-107`，现有测试覆盖）。
- **跨 Provider 混用**：✅。provider 列匹配校验（现有测试：google 事务的 state 用于 github 回调被拒）。

### 4.2 Google OIDC 验证完整性
- 签名：RS256 钉死（`algorithms` 选项），远程 JWKS，jose 默认拒绝内嵌 jwk/x5c 混淆 —— ✅（现有测试：错误密钥签发的 ID Token 被拒）。
- issuer / audience / exp：`jwtVerify` 选项全配，clockTolerance 60s（合理范围上限）—— ✅。
- nonce：ID Token 的 nonce claim 取 SHA-256 后与事务 `nonce_hash` 恒定时间比对 —— ✅（现有测试：nonce 不匹配 → server_error 重定向）。缺 nonce 或事务无 nonce_hash → 拒绝 —— ✅。
- `sub` 缺失 → 拒绝 —— ✅。

### 4.3 GitHub 流程
- 授权码只能配合 client_secret 在 Cloud 侧兑换；access_token 仅存在于单次调用栈用于取资料，不落库、不回传、不进日志 —— ✅（代码审计确认）。
- `/user` 响应校验数字 `id`（`github.ts`）；subject 字符串化稳定 —— ✅。

### 4.4 授权码一次性与并发
- 顺序重复消费 → 400（现有测试）；过期 → 400（现有测试）；redirect_uri 不匹配 → 400 + 烧码（现有测试）；PKCE 错误 → 400 + 烧码（现有测试）。
- **并发兑换同一授权码**：现有测试确认恰好一个 200（条件 UPDATE 原子消费，sessions=1）—— ✅。
- **并发重复回调**：见 I-4（发现 TOCTOU 窗口，实际影响受限）。

### 4.5 redirect_uri 白名单
- 正则精确匹配 `^http://127\.0\.0\.1:(\d{1,5})/callback$` + 端口范围校验。不做 URL 解析意味着**不存在解析器差异绕过面**（百分号编码、`localhost`、`0x7f000001`、userinfo、fragment、尾斜杠、查询串全部被正则拒绝——13 种变体有测试）。错误重定向只指向事务中存储的合法值；事务不存在时不做任何重定向（现有开放重定向测试覆盖）—— ✅。

### 4.6 回调中断 / 重复 / 并发
- Provider 拒绝（无 code）→ access_denied 重定向 + 事务清理（现有测试）。
- Provider 端点故障 → server_error 重定向（现有测试）。
- ID Token 验签失败 / nonce 不匹配 → server_error 重定向（现有测试）。
- 非预期异常（如 Provider 返回非法 JSON）→ 500 JSON，事务清理，不重定向 —— 见 I-6（错误路径体验问题）。
- 并发重复回调 → 见 I-4 / I-5。

## 5. Token / Session 审查

- **JWT 算法一致性**：签发 HS256（kid=current），验证钉死 `["HS256"]`；`decodeProtectedHeader` 后按 kid 选密钥，**未知 kid 不回退到任意密钥**（keyCandidates 返回空 → 拒绝）—— 独立验证 V5 确认 `kid=badkid→401`。无 kid 时按 current→previous 顺序回退，仅限显式配置的 `JWT_SIGNING_KEY_PREVIOUS` —— 独立验证 V5 确认合法签名无 kid token 验证通过（预期回退行为，非降级：密钥仍是服务端秘密）。alg=none → 401（现有测试 + V5）。
- **过期拒绝**：现有测试（构造过期 token → 401）。
- **Refresh Token 存储**：schema 仅 `refresh_token_hash`，哈希域分隔 pepper —— ✅。
- **Rotation 原子性**：事务 + `SELECT ... FOR UPDATE`；两个并发刷新恰好一个成功、sessions=1（现有测试）。失败方走 grace 路径，不产生第二会话。
- **宽限期分析（任务书要求专项）**：见 I-2 完整分析（含攻击者先刷新链的运行时验证 V7）。
- **宽限期后重放**：现有测试确认整族撤销（`refresh_reuse_detected` + `session_revoked` 双事件，2 行 revoked）。
- **Logout**：撤销整个 token family（含所有轮换后代）—— 现有测试；未知 token 幂等 200 —— 现有测试；logout 需持有 refresh token 本身（access token 泄露无法用于撤销，降低攻击面）—— ✅。
- **suspended / deleted 与旧 Access Token**：见 I-3 / I-9 / 第 8 节。
- **JWT 无服务端撤销列表**：access token 最长 15 分钟，撤销语义由 refresh 层承载 —— 标准 bearer 取舍，已在实施报告声明 —— Informational。

## 6. 数据库一致性审查

- **事务覆盖**：用户+身份创建（同事务）、授权码签发+事务删除（同事务）、授权码消费+会话创建（同事务）、rotation 全链（同事务）、logout 撤族（同事务）—— ✅。
- **FOR UPDATE 覆盖**：授权码消费与 rotation 两处热点均行锁串行化 —— ✅（并发测试 + V1）。
- **唯一约束防重复身份**：`(provider, provider_subject)` 唯一索引 —— 并发首次登录 V8 确认 users=1（唯一约束兜底）；失败方 500（I-5，体验问题）。
- **删除事务对授权码的影响**：`oauth_codes.transaction_id` 故意无 FK，事务删除不级联授权码 —— ✅（现有测试：回调后 token 交换成功）。
- **部分成功**：用户+身份同事务原子回滚 —— ✅（V1/V8 的失败方回滚干净，users=1）。
- **Rotation 失败残留**：所有写在同一事务，异常即回滚 —— ✅。
- **迁移可重复**：独立空库测试（执行/幂等/约束存在性三例）—— ✅。
- **过期数据清理**：oauth_transactions / oauth_codes 有 sweep（`app.ts` startSweep，60s）+ 访问时惰性删除；**auth_sessions 过期行无物理清理**（查询时判断失效）—— I-10，数据量可控但长期需任务。

## 7. HTTP / Docker 部署审查

- **CORS**：默认完全关闭；仅显式配置来源才启用且不含 credentials —— ✅。
- **TRUST_PROXY**：默认 false（socket 地址，不可伪造）。true 时取 XFF **左第一跳** —— **I-1（Medium）**：追加式反代下可伪造绕过限流（独立验证 V6-B 实锤）。默认配置不受影响（V6-A 实锤 XFF 被忽略）。
- **限流**：每 IP 固定窗口，端点分桶；429 + Retry-After（现有测试）。缺陷：边界突发 2x、重启清零、进程内存（多实例失效）—— I-8，文档已注明定位。`/oauth/callback` 无独立限流 —— I-11（有 state 哈希查找前置，成本受限）。
- **错误泄露**：生产环境意外错误仅返回 `server_error`（现有测试断言无 error_description）；AppError 描述均为非敏感文案 —— ✅。
- **日志脱敏**：请求日志仅 method/pathname/status/duration（pathname 不含 query → authorize 的 state/challenge 不落日志）；logger 对敏感键模式统一 `[redacted]`；请求体与 Authorization 头永不记录 —— ✅（代码审计）。
- **Docker**：多阶段构建、`USER node` 非 root、HEALTHCHECK `/health`、只带 dist+生产依赖 —— ✅。容器冒烟（生产模式 + 强校验通过 + /ready 200）此前已实测。
- **弱默认值**：生产强制 JWT_SIGNING_KEY≥32 / PEPPER≥16 / 双 Provider 凭据 / https BASE_URL，缺失即拒绝启动（此前容器冒烟时曾实测拒绝路径）—— ✅。密钥生成方式文档化（openssl rand）—— ✅。无熵值校验（长度≠熵）—— Informational。
- **请求体大小**：无应用层上限，JSON/form 全量读入内存 —— I-7（建议反代 client_max_body_size 或应用层限制）。
- **HTTPS/反代**：文档已给出 TLS 终结与 TRUST_PROXY 指引；需补充「代理必须覆盖式设置 XFF」警示（并入 I-1 修复）。无 HSTS/nosniff 响应头 —— I-12（反代层补齐即可）。

## 8. 用户身份与生命周期审查

- **邮箱不合并**：现有测试强制（跨 Provider 同邮箱 → 2 users）；身份锚点唯一约束 —— ✅。
- **未经授权绑定**：不存在「向已有用户追加身份」的端点或代码路径；身份仅随新用户创建写入 —— 不变性成立（审计要求）—— ✅。
- **suspended**：登录回调拒绝（access_denied 重定向，现有测试）；refresh 拒绝（用户状态检查，V3 验证 401）；旧 Access Token 有效期内仍可读自身 profile（V3：/auth/me=200 且响应携带 suspended 状态供客户端响应）—— I-9，符合 bearer 语义，≤15min。
- **deleted**：`/auth/me` 401（现有代码路径 + V4 验证）；**`/auth/identities` 无状态检查 —— I-3（V4 实锤：status='deleted' 返回 200 含身份列表；行删除后返回 200 空列表）**。登录回调对 deleted 同样走 `status !== 'active'` → access_denied（代码路径，与 suspended 同分支）。
- **账号删除 / 恢复 / 解绑**：本阶段明确未实现（规格禁止），边界在实施报告与代码中一致 —— ✅。

## 9. 测试执行结果

**现有套件（本次审查复跑，全新结果）**：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 通过 |
| `pnpm lint` | ✅ 0 错误 |
| `pnpm test` | ✅ **7 文件 / 73 测试全部通过**（11.16s，真实 PostgreSQL 容器） |
| `pnpm build` | ✅ dist + 迁移复制就绪 |

**独立验证（仓库外脚本，7 项新增验证，运行后脚本已删除）**：

| ID | 场景 | 结果 |
|---|---|---|
| V1 | 并发重复 Provider 回调 | `[302/500]`，codes=1，users=1，txs=0 —— 身份唯一约束兜底；TOCTOU 窗口另见 I-4 |
| V2 | 过期 OAuth Transaction 后回调 | 400 invalid_grant，不重定向，事务惰性删除 ✅ |
| V3 | suspended + 旧 Access Token | /auth/me=200（含 suspended 状态）；/auth/refresh=401 → I-9 |
| V4 | deleted + 旧 Access Token | /auth/me=401 ✅；**/auth/identities=200（I-3 实锤）**；行删除后 identities=200 空列表 |
| V5 | 篡改 kid / 无 kid / alg=none | kid=badkid→401（无任意回退）✅；无 kid 合法签名→200（显式 previous/current 回退，预期）✅；alg=none→401 ✅ |
| V6-A | trustProxy=false 伪造 XFF | 401,401,401,**429** —— XFF 被忽略，默认配置不可绕过 ✅ |
| V6-B | trustProxy=true 伪造 XFF | 401×4 —— **每个伪造 IP 独立桶，限流被绕过（I-1 实锤）** |
| V7 | 宽限期「攻击者先刷新」链 | attacker#1=200 → victim=401,401（grace）→ attacker#2=200；grace_events=2，reuse_events=0 —— **家族永不撤销（I-2 实锤）** |
| V8 | 并发首次登录同一 subject | `[302/500]`，users=1，identities=1 —— 唯一约束兜底（I-5） |

**12 项指定风险场景核对表**：

| # | 场景 | 验证方式 | 结果 |
|---|---|---|---|
| 1 | 同一授权码并发兑换 | 现有测试 | ✅ 一 200 一 400，sessions=1 |
| 2 | 同一 Refresh Token 并发刷新 | 现有测试 | ✅ 一 200 一 401，family 完好 |
| 3 | 30 秒内 RT 重复使用 | 现有测试 | ✅ 401 rotated，不撤族 |
| 4 | 30 秒后 RT 重复使用 | 现有测试 | ✅ 整族撤销 + 双审计事件 |
| 5 | OAuth 回调重复到达 | 现有测试（顺序）+ V1（并发） | ✅ 顺序拒绝；并发由唯一约束兜底，TOCTOU 窗口见 I-4 |
| 6 | 过期 Transaction 后回调 | V2 | ✅ 400 |
| 7 | 修改 redirect_uri 兑换 | 现有测试 | ✅ 400 + 烧码 |
| 8 | 修改 kid / 签名算法 | V5 + 现有测试 | ✅ 全部拒绝，无降级 |
| 9 | 密钥轮换前后 Token | 现有测试 | ✅ previous 平滑验证 |
| 10 | suspended + 旧 Access Token | V3 | ✅（I-9：AT 有效期内可读 profile） |
| 11 | deleted + 旧 Access Token | V4 | ⚠️ me=401 ✅；identities=200 → I-3 |
| 12 | 伪造 X-Forwarded-For | V6 | ⚠️ 默认配置安全；trustProxy=true 可绕过 → I-1 |

## 10. 已确认问题

### I-1 · Medium · TRUST_PROXY=true 时 X-Forwarded-For 左第一跳可伪造，限流可被绕过
- **位置**：`cloud/src/security/rate-limit.ts:26-31`（`clientIp` 取 `forwarded.split(",")[0]`）
- **触发条件**：`TRUST_PROXY=true` **且** 反代采用追加式 XFF（Nginx 默认 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` 即追加）。默认 `TRUST_PROXY=false` 不受影响。
- **攻击路径**：客户端每次请求携带不同 `X-Forwarded-For: 10.0.0.<n>` → 每次命中全新限流桶 → 认证端点限流失效。**运行时实锤**（V6-B：4 个伪造 IP 全部 401 未触发 429）。
- **影响**：认证端点的每 IP 限流（authorize 30/min、token 20/min、auth 30/min）失去意义。注意：refresh token / 授权码均为 256 bit 随机，爆破在熵上不可行，因此主要影响是 DoS 防护与审计 IP 归因失真，而非凭证破解。
- **现有测试覆盖**：无（V6 补验）。
- **修复建议**：取 XFF **最右**条目（对追加式与覆盖式代理均正确），或强制要求反代覆盖式设置 XFF 并写入部署文档，或支持 Proxy Protocol。

### I-2 · Medium · 宽限窗口在「攻击者先刷新」场景下使盗用检测永久失效（设计取舍的残余风险）
- **位置**：`cloud/src/sessions/session-service.ts:118-131`（grace 分支）、`:190-198`（事件落库）
- **触发条件**：攻击者已窃取 refresh token T（bearer 模型的前置条件），且攻击者**先于**合法客户端使用 T 完成轮换。
- **攻击路径（运行时实锤 V7）**：攻击者 refresh(T)=200 获得家族控制权 → 合法客户端 refresh(T) 两次均 401（grace 分支，`sinceRevokeMs≤30s`）→ **每次重试只产生 `refresh_grace_reuse` 事件，从不触发撤族** → 攻击者的会话可通过继续轮换无限存活（attacker#2=200）。无 grace 时，受害者第一次失败重试即会以 reuse 语义撤销整族、锁死攻击者。
- **影响**：token 被盗且攻击者先行的场景下，系统失去「受害者重试=撤族」的自愈防线；攻击者可长期维持访问。对比无 grace 方案的代价：合法客户端的正常并发重试会误杀会话（规格明确要求避免）。
- **现有测试覆盖**：并发重试不撤族有测试；「攻击者先刷新 + 受害者重试链」无测试（V7 补验）。
- **修复建议**：① per-family 的 `refresh_grace_reuse` 计数 ≥2 次即撤销整族（正常并发只重试一两次，盗用场景受害者会反复重试）；或 ② 窗口缩至 5s；或 ③ grace 事件触发显式告警。三项可并行。定性：**实现正确、语义为已声明的取舍**，需要产品层决策。

### I-3 · Low · `/auth/identities` 缺少用户状态检查
- **位置**：`cloud/src/routes/auth.ts:115-119`（对照 `/auth/me` 的 `:101-103` 有 `deleted` 检查）
- **触发条件**：用户 `status='deleted'`（或用户行已物理删除）且其旧 Access Token 仍在有效期内。
- **运行时实锤（V4）**：status='deleted' → `/auth/me=401` 但 `/auth/identities=200`（返回完整身份列表）；用户行删除后 → `200 {"identities":[]}`。
- **影响**：已删除账户的自身数据可见性不一致；仅泄露用户自己的身份信息，无跨用户影响、无权限提升。
- **现有测试覆盖**：无（V4 补验）。
- **修复建议**：`/auth/identities` 复用 `/auth/me` 的存在性+状态检查；或把检查上移到 requireAuth 共享。

### I-4 · Low · OAuth Transaction 解析无行锁（TOCTOU），并发重复回调存在双码窗口
- **位置**：`cloud/src/oauth/state.ts:92-106`（`resolveTransactionByProviderState` 只读无 FOR UPDATE）+ `cloud/src/oauth/callback.ts`（事务删除发生在码签发事务内）
- **触发条件**：同一 `PR.CS` 的回调并发到达两次，且交错满足「双方都在任一方删除事务前完成解析，且后到方的身份查询发生在先到方提交之后」。
- **可复现路径**：V1 实测交错为 `[302/500]`（后到方在身份 INSERT 上撞唯一约束回滚 → 500）——该交错下 codes=1；但代码分析确认存在另一交错：后到方解析成功 → 先到方完整提交 → 后到方 findOrCreate 命中已存在身份 → 走签发分支 → **第二条授权码**。两条码绑定同一 PKCE challenge 与 redirect_uri，跨权限边界不可利用（持有者等价），但违反「一事务一码」的预期。
- **影响**：低。协议语义瑕疵 + 一条多余审计事件；无权限边界突破（真实 Provider 的一次性 code 也会拦截第二条回调路径，双码窗口进一步收窄）。
- **现有测试覆盖**：顺序重放有测试；并发交错无测试（V1 补验）。
- **修复建议**：解析时 `SELECT ... FOR UPDATE` 并以条件 `DELETE ... RETURNING` 作为原子消费点（与授权码消费同构）。

### I-5 · Low · 并发首次登录同一身份，失败方返回 500 而非优雅错误
- **位置**：`cloud/src/users/user-service.ts`（SELECT-then-INSERT）+ `cloud/src/oauth/callback.ts:178`（非 AppError 异常 → 500 JSON）
- **运行时实锤（V8）**：并发双回调 `[302/500]`，users=1 identities=1 —— 正确性由唯一约束保证；失败方（postgres 23505）走非 AppError 路径，Desktop 只收到 500 错误页而非 `error` 重定向。
- **影响**：并发竞态下的用户体验问题，无安全影响。
- **修复建议**：捕获 23505 → 事务内重走 find 分支；或映射为 access_denied 重定向。

### I-6 · Low · Provider 网络层非 AppError 异常导致 500 JSON 而非 error 重定向
- **位置**：`google.ts` / `github.ts`（`resp.json()` 解析失败、fetch 的 TypeError 等未包 AppError）+ `callback.ts:178`
- **触发条件**：Provider 返回 2xx 但 body 非 JSON，或 TLS/网络中途失败。
- **影响**：Desktop 侧回调监听收不到应答（浏览器停在 Cloud 错误页），流程中断但无安全影响；事务已清理。
- **修复建议**：provider 适配器内将基础设施异常统一包为 `serverError()`（现有 token 端点非 2xx 已是 AppError，仅解析层遗漏）。

## 11. 潜在风险（Informational）

| ID | 内容 | 位置/依据 |
|---|---|---|
| I-7 | 请求体无大小上限（JSON/form 全量读入内存）；建议应用层 1MB 上限或反代 `client_max_body_size` | `routes/body.ts` |
| I-8 | 固定窗口限流：窗口边界突发可达 2×max；进程重启计数清零；多实例部署需换共享存储（定位已文档化） | `rate-limit.ts` |
| I-9 | suspended 用户旧 Access Token 有效期内（≤15min）仍可读自身 profile（响应携带 status 供客户端响应）；refresh 已正确拒绝（V3） | `routes/auth.ts:101-107` |
| I-10 | 过期 auth_sessions 无物理清理任务；`REFRESH_SESSION_TTL_SECONDS` 实为「每会话滚动续期」而非家族绝对上限——活跃家族可无限存续（标准 refresh 语义，建议文档明确） | `session-service.ts` / `app.ts` |
| I-11 | `/oauth/callback` 无独立限流；未验证 state 时成本为一次索引 SELECT，风险有限 | `routes/oauth.ts` |
| I-12 | 无安全响应头（HSTS/nosniff 等）；建议反代层统一补齐 | 部署层 |
| I-13 | JWT_SIGNING_KEY 仅长度校验无熵校验；README 已提供 `openssl rand` 生成指引 | `env.ts` |
| I-14 | 秘密轮换/审计事件的保留策略未定义（auth_events 无限增长） | `schema.ts` |

**审查范围内核实为安全的项**（均给出依据）：State 独立性/防 CSRF/防重放（测试+V2）、OIDC 五要素验证（测试）、GitHub 服务端流程（代码审计）、授权码一次性与并发（测试+V1）、PKCE 无绕过（RFC 向量测试+恒定时间比较）、redirect_uri 白名单无解析绕过（13 变体测试+正则精确匹配）、开放重定向（测试）、JWT 无 alg/kid 降级（V5+测试）、rotation 原子性与并发单会话（测试）、30s 内/外重放语义（测试+V7）、logout 撤族与幂等（测试）、邮箱不合并（测试）、无未授权身份绑定（无该端点）、迁移幂等（测试）、事务/行锁覆盖（测试+精读）、生产错误不泄露（测试）、日志脱敏（审计）、非 root 容器+健康检查+弱默认拒绝启动（容器冒烟）、CORS 默认关闭（代码）。

## 12. 修复优先级

| 优先级 | 项 | 建议时点 |
|---|---|---|
| P1（Phase 1.2 开发前） | I-1 XFF 最右条目 + 部署文档警示；I-2 grace 计数阈值撤族（或窗口缩短+告警） | Electron 接入依赖部署形态定型，先修 |
| P2（Phase 1.2 内随手修） | I-3 identities 状态检查；I-4 事务解析行锁；I-5 23505 优雅处理；I-6 provider 异常包装 | 小改动，各 ≤20 行 |
| P3（部署前） | I-7 请求体上限；I-12 安全响应头；I-10 session 清理任务 | 与生产部署清单合并 |
| 记录即可 | I-8 / I-9 / I-11 / I-13 / I-14 | 已文档化或在后续阶段自然解决 |

## 13. 是否建议合并至 main

**建议：可以进入人工合并审查（A. PASS）。**

依据：
1. 未发现 Critical / High 问题。两项 Medium 中，I-1 仅在「TRUST_PROXY=true + 追加式代理」的非默认部署组合下成立（默认配置经 V6-A 实锤安全），I-2 是已声明设计取舍的残余风险且前提是 token 已被窃取、有完整审计事件可追溯。
2. 任务书 12 项必验风险场景全部得到验证：9 项由现有测试覆盖，3 项缺口（过期事务回调、suspended/deleted 旧 token、XFF 伪造）由本次独立验证补齐，全部按预期或转化为已列问题，无未验证项被宣称通过。
3. 并发一致性由真实 PostgreSQL 事务 + 行锁 + 唯一约束三重保障，73 项测试含并发兑换与并发刷新。
4. 无 Secret 入库、无业务端（Desktop/iOS/Extension）改动、迁移幂等、Docker 非 root 可构建可运行。

合并前不强制修复任何问题；建议将 P1 两项纳入 Phase 1.2 首个迭代（P2 四项可随手带上）。

## 14. Phase 1.2 开始前的必要条件

1. **人工决策 I-2**：grace 窗口策略三选一（计数阈值撤族 / 缩短窗口+告警 / 维持现状），影响 Desktop 端「静默重试」UX 设计。
2. **完成 I-1 修复或部署形态决策**：确定反代 XFF 模式并在 `cloud/README.md` 写入强制配置示例。
3. **P2 四项小修**（I-3 / I-4 / I-5 / I-6），各为局部改动，配套补 3-4 个测试用例（并发双回调交错、deleted+identities、23505 重试路径）。
4. **Provider 真实凭据联调**：申请 Google OAuth Client 与 GitHub OAuth App（callback 指向 `{BASE_URL}/oauth/callback/*`），用真实 Provider 跑通端到端（mock 无法覆盖：真实 JWKS 缓存与轮换行为、真实授权页交互、Google `prompt` 参数差异）。
5. **Desktop 端契约冻结**：`/oauth/authorize` 参数、回调 query 形态（`code`+`state`）、`/oauth/token` 请求/响应体、错误码语义（`invalid_grant`/`access_denied`/`server_error`+`error_description`）以本报告 §3/§4 确认的实现为准写入 `shared/contracts`。

---

**审查完成。本次任务未修改任何项目文件（除本报告），未开始 Phase 1.2，等待人工处理。**
