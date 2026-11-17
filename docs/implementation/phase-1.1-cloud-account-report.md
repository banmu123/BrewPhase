# BrewPhase Phase 1.1 — 独立云端账号服务实施报告

> 日期：2026-11-16 · 分支：`feature/cloud-account-phase-1.1`
> 基线：`main @ bcfc25b`（Desktop 0.1.4），审计报告 `docs/architecture/cloud-account-audit.md`
> 性质：**只新增独立 Cloud 服务，未修改 Desktop / iOS / Chrome Extension 任何代码。**

---

## 1. 实际新增目录结构

```
cloud/                                   # 独立部署单元（新目录，不进 Desktop 构建）
├── package.json / pnpm-lock.yaml
├── tsconfig.json / tsconfig.build.json  # NodeNext ESM；build 产物到 dist/
├── drizzle.config.ts                    # 迁移生成配置
├── vitest.config.ts / eslint.config.mjs
├── Dockerfile                           # 多阶段、非 root、HEALTHCHECK
├── .env.example / .gitignore / README.md
├── scripts/copy-assets.mjs              # 构建后复制迁移 SQL 到 dist
├── src/
│   ├── index.ts                         # 入口：fail-fast 启动 + 优雅停机
│   ├── app.ts                           # Hono 组装 / 请求日志 / 过期清理 sweep
│   ├── context.ts                       # AppContext / AppHono 类型
│   ├── env.ts                           # zod 环境校验（生产强校验 + 弱默认拒绝）
│   ├── logger.ts                        # 结构化日志 + 敏感键脱敏
│   ├── db/
│   │   ├── schema.ts                    # 6 张表
│   │   ├── client.ts                    # postgres.js + Drizzle + 迁移执行
│   │   ├── audit.ts                     # auth_events 审计（最小化记录）
│   │   └── migrations/                  # 0000_nasty_solo.sql + meta journal
│   ├── oauth/
│   │   ├── provider.ts                  # ProviderAdapter 契约
│   │   ├── google.ts                    # OIDC：JWKS 验签 + nonce 哈希比对
│   │   ├── github.ts                    # OAuth code 换 token + GET /user
│   │   ├── providers.ts                 # 注册表（凭据缺失不注册）
│   │   ├── state.ts                     # 双 State 事务（只存哈希 + 透传回传）
│   │   ├── authorization.ts             # /oauth/authorize 输入校验
│   │   ├── callback.ts                  # 回调编排：身份映射 + 授权码签发
│   │   └── token-exchange.ts            # 授权码原子消费 + PKCE
│   ├── users/
│   │   ├── user-service.ts              # findOrCreateUserWithIdentity
│   │   └── identity-service.ts          # 身份查询
│   ├── sessions/
│   │   ├── jwt.ts                       # HS256 + kid 密钥环（轮换预留）
│   │   ├── refresh-token.ts             # 256bit opaque token + 哈希
│   │   └── session-service.ts           # rotation + family 重放检测 + logout
│   ├── security/
│   │   ├── crypto.ts                    # sha256/随机/常数时间比较/PKCE/redirect 白名单
│   │   ├── errors.ts                    # AppError + OAuth 风格错误码
│   │   └── rate-limit.ts                # 每 IP 固定窗口限流
│   ├── routes/
│   │   ├── health.ts                    # /health /ready
│   │   ├── oauth.ts                     # /oauth/* 三端点
│   │   ├── auth.ts                      # /auth/* 四端点 + requireAuth
│   │   └── body.ts                      # JSON/form 双解析 + parseOr400
│   └── scripts/migrate.ts               # 迁移命令入口（dev/prod 同构路径）
└── tests/
    ├── global-setup.ts                  # 测试库自动迁移（不可达即失败）
    ├── helpers/                         # env / db / mock-providers / harness
    ├── db/migrations.test.ts
    ├── users/identity.test.ts
    ├── oauth/authorize.test.ts / callback.test.ts / token.test.ts
    ├── sessions/session.test.ts
    └── security/security.test.ts
```

## 2. 使用的技术和版本

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | 22.22（本机）/ 容器 node:22-alpine | engines >= 22 |
| TypeScript | 5.9.3 | 刻意不用 Desktop 的 TS 7：typescript-eslint 8 尚不兼容，cloud 需要完整 lint 能力 |
| Hono | 4.10.x + @hono/node-server 1.14.x | 轻量、Web 标准 API |
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | 与 Desktop 同版本心智 |
| postgres.js | 3.4.x | 驱动；事务 + FOR UPDATE 行锁 |
| jose | 6.1.x | 自签 JWT + Google JWKS 远程验签 |
| zod | 4.6.7 | 与 Desktop 同版本 |
| Vitest | 5.1.0 | 集成测试（fileParallelism=false 串行共享测试库） |
| ESLint | 9 + typescript-eslint 8 | flat config |

**与审计报告的选型差异**：无。审计推荐 Hono + Postgres + Drizzle 自持实现（不引 Auth.js/Passport），已照做。

## 3. 数据库 Schema

六张表（迁移文件 `0000_nasty_solo.sql`）：

- **users**：`id uuid PK`、`status text`（CHECK: active/suspended/deleted，默认 active）、`display_name`、`avatar_url`、时间戳。第三方账号名只作展示，不是身份依据。
- **user_identities**：`user_id FK→users ON DELETE CASCADE`、`provider`（CHECK: google/github）、`provider_subject`（Google sub / GitHub 数字 ID 字符串化）、`email` 可空、`email_verified bool`。**唯一锚点 `UNIQUE(provider, provider_subject)`**——邮箱相同绝不合并。
- **auth_sessions**：`refresh_token_hash UNIQUE`（SHA-256，明文永不落库）、`token_family uuid`（rotation 族）、`device_id/device_name`（设备管理预留，可空）、`user_agent`、`ip_hash`（pepper 哈希，不存明文 IP）、`expires_at`、`revoked_at`、`replaced_by`（rotation 链，无 FK 允许独立清理）、`last_used_at`。索引：family/user/expires。
- **oauth_transactions**：`provider_state_hash UNIQUE`（防重放锚点）、`client_state_hash`、`code_challenge`（S256）、`redirect_uri`、`nonce_hash`（Google OIDC 用）、`expires_at`（300s）。**与规格的差异**：规格字段表没有 nonce 列，为满足「nonce 校验」要求加了 `nonce_hash`（规格允许"至少包含"）。
- **oauth_codes**：`code_hash PK`、`user_id FK`、`transaction_id`（**故意无 FK**：事务在签发授权码后即删，级联外键会连带删码）、`code_challenge`、`redirect_uri`（绑定原始请求）、`consumed_at`（消费即焚）、`expires_at`（60s）。
- **auth_events**：`event_type`（login_success/login_failed/refresh_success/refresh_reuse_detected/refresh_grace_reuse/logout/session_revoked）、`user_id`、`provider`、`session_id`、`ip_hash`、`detail jsonb`。**不记录任何明文 Token/Code/Secret/完整资料**。

**与审计报告的 Schema 差异**：审计建议的 `oauth_states` 表被规格的 `oauth_transactions` 取代（单表同时承载双 State + PKCE + redirect_uri，职责一致）。

## 4. Migration 说明

- 生成：`pnpm db:generate`（drizzle-kit）；应用：`pnpm db:migrate`（dev）/ `pnpm db:migrate:prod`（dist 产物）。
- journal 机制保证**幂等可重复**；迁移测试在独立空库验证：①迁移完整执行 ②重复执行零变化 ③关键约束真实存在（身份唯一锚点、refresh_token_hash 唯一、provider CHECK、status CHECK、provider_state_hash 唯一）。
- 生产流程：先 `node dist/scripts/migrate.js` 再启动服务；服务本体不做自动迁移。

## 5. Google OAuth 实现说明

- 权限严格限定 `openid email profile`，`access_type=online`（不向 Google 索取 refresh token，登录后不再持有任何 Provider Token）。
- Cloud 创建 Transaction：生成独立 Provider State（PR）与 nonce，**库里只存两者的 SHA-256**。
- 授权 URL 携带 `state=PR.CS`（PR 与 CS 以第一个 "." 拼接；base64url 字母表无 "."，切分安全）。
- 回调后：`jwtVerify`（jose `createRemoteJWKSet` 拉取 Google 官方 JWKS）校验 **RS256 签名 / issuer(`https://accounts.google.com`) / audience(client_id) / exp**；`alg` 显式限定 RS256（拒绝 none/其他算法）。
- **nonce 校验**：对 ID Token 的 nonce claim 取 SHA-256，与事务中的 `nonce_hash` 恒定时间比较——既满足「库中只存哈希」又完成 nonce 绑定校验（设计要点：明文 nonce 只出现在 authorize URL 中一次）。
- 取 `sub` 作 provider_subject；`email`/`email_verified` 来自 ID Token claims。

## 6. GitHub OAuth 实现说明

- 标准 Authorization Code Flow，**不申请任何 scope**（GitHub 默认只读公开资料，无仓库权限），不要求用户公开邮箱。
- Cloud 用 Client Secret 服务端换 access_token → `GET /user`（Accept: application/vnd.github+json，UA 必填）→ **数字用户 ID 字符串化作 provider_subject**。
- `email` 可空（隐藏邮箱场景直接建用户），`email_verified` 恒为 false（公开资料邮箱不视为已验证）。
- GitHub access_token 只存在于本函数调用栈内用于取资料，**不落库、不返回 Desktop、不打日志**。
- 按官方文档实现，与 Google 的差异（无 OIDC/无 ID Token/无 nonce/scope 语义不同）全部封装在 provider 适配器内，编排层零假设。

## 7. 统一用户身份映射说明

- 事务内 `findOrCreateUserWithIdentity`：按 `(provider, provider_subject)` 查 `user_identities` → 命中即复用用户（同一 Provider 再登录 = 同一用户）；未命中创建全新 `users` + `user_identities`。
- **不同 Provider 相同邮箱 = 两个独立用户**（有测试强制）。邮箱只是资料，不是身份锚点。
- 「绑定身份必须经过现有用户验证」：本阶段不存在「向已有用户追加身份」的流程——身份只在创建新用户时写入，不变性天然成立；未来若做绑定功能，必须先完成该用户的会话验证。
- `suspended` 用户登录被拒（access_denied 重定向回 Desktop 并记录 login_failed）；`deleted` 用户对 `/auth/me` 表现为 401。

## 8. Desktop 授权码交接协议

```
Desktop（未来 Electron Main）                          Cloud
────────────────────────────                          ─────
state = 256bit 随机                                   
code_verifier = 256bit 随机（内存持有）                
code_challenge = S256(verifier)                       
127.0.0.1 随机端口一次性监听                           
── GET /oauth/authorize?provider&state&code_challenge&redirect_uri ──>
                                  校验 provider/state 形态/S256 形态/redirect_uri 白名单
                                  （只允许 http://127.0.0.1:<port>/callback）
                                  创建 Transaction（双 State 哈希 + challenge + redirect_uri 落库）
<── 302 到 Google/GitHub 授权页（state=PR.CS, nonce）──
（用户在系统浏览器完成第三方授权）
── Provider 回调 Cloud ──>  验证 PR（哈希查找 + provider 匹配 + 过期）+ CS 完整性
                            交换 Provider 授权码并验证身份
                            findOrCreate 用户
                            签发一次性授权码（60s，绑定 challenge + redirect_uri）
                            删除 Transaction
<── 302 redirect_uri?code=<一次性码>&state=<原始 client state> ──
Desktop 逐字节比对 state（本地验证，Cloud 不代验）→ 关闭监听
── POST /oauth/token {code, code_verifier, redirect_uri} ──>
                            SELECT FOR UPDATE → 存在/未过期/未消费/redirect 完全一致/PKCE 匹配
                            条件 UPDATE 原子消费 → 创建 Session → 签发 tokens
<── {access_token, token_type, expires_in, refresh_token} ──
```

安全要点：
- **双 State 完全独立**：CS 由 Desktop 生成、Desktop 本地比对；PR 由 Cloud 生成、Cloud 哈希校验。Cloud 库中两者都只有哈希；CS 明文经 Provider 的 state 参数透传回来用于回显（Provider 原样回显，Cloud 用哈希校验其未被篡改）。
- Provider 授权码只能在 Cloud 侧使用；Desktop 只接触 BrewPhase 自己的一次性授权码。
- 事务中途无法修改 provider/state/challenge/redirect_uri——它们在 authorize 时一次性绑定落库。
- 开放重定向：错误重定向只可能指向事务中存储的合法 redirect_uri；事务不存在时一律 400 JSON 不重定向。

## 9. Access Token 和 Refresh Token 设计

**Access Token（JWT / HS256）**
- 默认 15 分钟（env 可配，钳制 600–900s）；claims：`sub`(user_id)、`sid`(session_id)、`iss`(BASE_URL)、`aud`("brewphase-desktop")、`iat`/`exp`、`jti`。
- Header 带 `kid`；密钥环支持 `JWT_SIGNING_KEY` + `JWT_SIGNING_KEY_PREVIOUS`——签发永远用 current，验证按 kid 选 key（无 kid 依次尝试 current→previous），**轮换平滑过渡有测试覆盖**。
- 验证固定 `algorithms: ["HS256"]`（alg=none / RS / 其他算法全部拒绝）；iss/aud/exp/签名全验。不包含任何第三方 Provider Token。

**Refresh Token（Opaque）**
- 256 bit 随机 base64url（43 字符）；库中存 `SHA-256(pepper 域分隔)`。
- 每次刷新轮换：旧 token `revoked_at` + `replaced_by` 链接新 session；**同一 token 不可能成功刷新两次**（SELECT FOR UPDATE + 条件更新保证原子性）。
- 重放检测语义（对应「不能让正常并发请求轻易触发误判」）：
  - 旧 token 在被轮换后 **30 秒宽限窗口内**再次到达（典型：客户端并发重试/网络重发）→ 401「已被轮换」，**不撤销整族**，胜者的 token 继续可用（有并发测试验证）；
  - **宽限窗口外**重放 → 判定盗用，**撤销整个 token family**（refresh_reuse_detected + session_revoked 双事件），所有派生 token 全部失效；
  - 安全权衡已如实记录：被盗 token 若在 30s 内使用，攻击者拿不到新 token（旧 token 已一次性作废），但不会触发整族撤销——代价是合法用户不因自己的并发重试被误踢下线。后续增强（设备指纹/重试计数）列为 Phase 1.2 建议。

## 10. 安全机制

1. HTTPS：生产 env 强制 `BASE_URL` 为 https，否则拒绝启动。
2. OAuth State 校验：双 State 独立生成、独立校验、一次性（事务用后即删）。
3. OIDC nonce：nonce 哈希比对（见 §5）。
4. PKCE S256：challenge 形态强校验（43 字符 base64url），verifier 恒定时间比较，RFC 7636 Appendix B 测试向量通过。
5. 一次性授权码：60s TTL + 原子消费 + **任何校验失败（verifier 错/redirect 不匹配）即烧毁**，防穷举。
6. Refresh Token Rotation + family 重放撤销（见 §9）。
7. 数据库事务 + FOR UPDATE：授权码消费、refresh 轮换、用户创建全部事务化。
8. 速率限制：authorize(30/min)/token(20/min)/auth 端点(30/min)，每 IP 固定窗口，429 + Retry-After。内存实现为单容器运营态（非授权状态持久化），扩容需换共享存储。
9. 环境变量校验：zod 统一入口；生产强制真实密钥（≥32/≥16 字符），弱默认值直接拒绝启动。
10. 统一错误处理：AppError → OAuth 风格 JSON（`{error, error_description}`）；意外错误生产环境不回传内部细节；zod 失败统一 400。
11. 敏感日志脱敏：logger 只记录方法/路径/状态/耗时 + 白名单字段；敏感键模式（token/code/secret/authorization/password/verifier/nonce）一律 `[redacted]`；请求体与 Authorization 头永不进日志。
12. redirect_uri 白名单：严格 `http://127.0.0.1:<port>/callback`（13 种攻击变体有测试）。
13. Callback 无开放重定向：见 §8。
14. CORS 默认关闭；显式配置来源才启用，且不含 credentials。
15. 安全事件审计：7 类事件落 auth_events，最小化记录（IP 哈希、无 token/code/资料）。
16. 密钥轮换预留：JWT kid 密钥环（见 §9）。
17. IP 最小化：全部走 `sha256(pepper + "ip" + ip)`，无明文留存。
18. 数据库不可达：启动 ping 失败 exit(1)；`/ready` 503。绝不假装健康。

## 11. 测试结果

**环境**：真实 PostgreSQL 16（Docker 容器，端口 54329）；不用 Mock 代替数据库行为（事务、唯一索引、并发锁全部真实执行）。Google/GitHub 用本地 mock provider 服务器（真实 HTTP 调用 + 真实 jose JWKS 验签路径，仅身份签发可控）。

**执行命令**：`pnpm test`（vitest run；globalSetup 自动迁移测试库，数据库不可达直接报错不跳过）

**结果：7 个测试文件、73 个测试全部通过（0 失败 0 跳过）**

| 套件 | 覆盖 |
|---|---|
| tests/db/migrations.test.ts (3) | 空库迁移 / 幂等 / 5 项关键约束存在性 |
| tests/users/identity.test.ts (6) | 首次/再次 Google、GitHub 登录；跨 Provider 同邮箱不合并；GitHub 隐藏邮箱；provider_subject 唯一约束；/auth/identities |
| tests/oauth/authorize.test.ts (22) | provider 白名单（含未配置）；state 强度；PKCE S256 形态；**13 种 redirect_uri 攻击变体**；事务参数绑定 |
| tests/oauth/callback.test.ts (11) | 双端 happy path（code+原始 client state 回传）；state 重放；**跨 Provider state 混用**；CS 篡改；缺失 code→access_denied 重定向；**开放重定向防御**；**ID Token 错误签名拒绝**；nonce 不匹配；provider 端点故障；suspended 账户拒绝 |
| tests/oauth/token.test.ts (8) | 正常换发 + JWT 可用；form 编码；错误 PKCE 烧码；redirect 不匹配烧码；过期；重复消费；**并发换发同一授权码恰好一个成功**；未知/畸形请求 |
| tests/sessions/session.test.ts (10) | rotation 后旧 token 失效；**并发刷新同一 token 恰好一个成功且整族完好（宽限事件审计）**；**宽限期外重放→整族撤销**；logout 撤销整族；logout 幂等；JWT 过期/错误签名/错误 iss/aud/alg=none/无 Bearer；**kid 轮换平滑验证** |
| tests/security/security.test.ts (13) | PKCE RFC 7636 向量；verifier 形态；随机熵；常数时间比较；pepper 哈希域分隔；错误序列化（生产隐藏内部）；/health /ready；404；**限流 429+Retry-After** |

**工程质量**：`pnpm typecheck` ✓ · `pnpm lint`（eslint flat config，0 错误）✓ · `pnpm build`（tsc 编译 + 迁移复制）✓ · 生产 dist 冒烟启动（/health 200、/ready 200、authorize 302、404 JSON、结构化日志）✓ · `docker build` 见 §12。

## 12. 生产部署准备

- **Dockerfile**：多阶段（deps→build→runtime），node:22-alpine，非 root 用户，HEALTHCHECK `/health`，只带 dist + 生产依赖。**Docker 构建实测通过**（`docker build -t brewphase-cloud:phase-1.1 .`）。
- **.env.example**：全部变量含注释与生成方式（`openssl rand -base64 48`）。
- **迁移命令**：`pnpm db:generate` / `db:migrate` / `db:migrate:prod`。
- **本地开发**：`pnpm dev`（tsx watch）；**测试**：`pnpm test`；**生产构建**：`pnpm build`。
- **部署说明**：`cloud/README.md`（凭据申请、迁移、单容器部署、TLS 反代、TRUST_PROXY、密钥轮换步骤）。
- 部署顺序：migrate（只需 `DATABASE_URL`，可在 CI/一次性 Job 中先行执行）→ 启动服务 → 健康探活。数据库不可达启动即失败。
- **容器冒烟实测**：镜像内 `node dist/scripts/migrate.js` 迁移成功；生产模式容器启动（env: production，全部强校验通过）；`/health` 200、`/ready` 200（容器经 host.docker.internal 连真实 PostgreSQL）、`/oauth/authorize` 302。

## 13. 尚未解决的问题

1. **Provider 凭据未申请**：Google Cloud Console 与 GitHub OAuth App 的真实 Client Id/Secret 需要人工在两家控制台创建（callback URL 见 README），本阶段无法做真实 Provider 手工验收——已用本地 mock provider 服务器覆盖完整协议路径（真实 HTTP + 真实 JWKS 验签）。
2. **限流为进程内存实现**：单容器部署正确；未来水平扩容需换共享存储（Redis 或 Postgres 计数表），接口已隔离在 `rate-limit.ts`。
3. **refresh 重放宽限窗口（30s）的权衡**：被盗 token 在轮换后 30s 内重用不会触发整族撤销（攻击者拿不到新 token，但合法客户端不被误杀）。如需更强判定，Phase 1.2 可加设备指纹或重试计数。
4. **过期 session 无后台清理任务**：auth_sessions 过期行靠查询时判断失效，未做定期物理清理（oauth_transactions/oauth_codes 已有 sweep）；数据量小，列为后续增强。
5. **生产环境未实测**：无服务器/域名，HTTPS 反代、真实两家 Provider 回调均待部署时验证（本阶段只交付部署能力，符合任务书要求）。

## 14. Phase 1.2 Electron 接入建议

1. **新增（不修改既有服务语义）**：`src/main/account/` 四件套——`credentials.ts`（safeStorage 加密存 refresh+access，解密失败静默降级未登录）、`oauth-callback-server.ts`（127.0.0.1 随机端口一次性监听 + state 逐字节比对）、`account-service.ts`（登录意图/会话恢复/定时 refresh/logout）、`cloud-client.ts`（net.fetch 注入式封装，沿用 update-service 模式）。
2. **IPC/preload**：`account` 命名空间只暴露 profile DTO 与意图，**永不暴露 token**（审计 §8/§9 已定契约）；`shared/contracts/account.ts` 用 zod 定义。
3. **登录流程**：Main 生成 state+PKCE → 起 127.0.0.1 监听 → `shell.openExternal` 打开 Cloud authorize URL → 回调校验 state → `POST /oauth/token` → safeStorage 加密落盘 → 广播 `account` 域。
4. **会话恢复**：启动解密 → `GET /auth/me` 验活（401 则尝试 refresh）→ 全部失败视为未登录，**不阻塞本地功能**（Local-first 红线）。
5. **UI**：SettingsPage 增 `account` 分区（未登录/已登录/退出 + 身份列表），i18n 双语言文案；明确提示「同邮箱的 Google/GitHub 登录是两个独立账号」（对应身份模型）。
6. **E2E 回归**：登出态与断网态下现有全量功能必须全绿（验收红线：不登录不影响任何本地功能）。
7. **CSP**：无需为云端放行新域（网络全部走 Main `net.fetch`）。
8. **refresh 重放 UX**：客户端对 401 `invalid_token` 统一处理为「静默重登引导」，避免把宽限窗口拒绝（"already rotated by a concurrent request"）当错误弹窗。

---

## 附加输出

### 新增文件清单（46 个，共 4615 行 TS + 配置/文档）

- 配置：`cloud/package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`tsconfig.build.json`、`drizzle.config.ts`、`vitest.config.ts`、`eslint.config.mjs`、`Dockerfile`、`.dockerignore`、`.env.example`、`.gitignore`、`README.md`、`scripts/copy-assets.mjs`
- 源码 33 文件 + 迁移 3 文件（0000_nasty_solo.sql + meta×2）
- 测试 11 文件（helpers×5 + 5 套件 + global-setup）

### 修改文件清单

**无**。Desktop / iOS / Chrome Extension / 既有 docs 零修改（`git status` 可验证）。

### Git diff 摘要

- 分支 `feature/cloud-account-phase-1.1`（基线 bcfc25b + 审计文档提交 2751550）
- 本阶段提交：全部为新增 `cloud/` 目录 + 本报告 `docs/implementation/phase-1.1-cloud-account-report.md`
- 无 Secret 提交：`.env` 被 `cloud/.gitignore` 忽略，只有 `.env.example` 入库；代码/测试中所有密钥均为 `test-*` 假值

### 测试命令与执行结果

```text
pnpm typecheck   # tsc --noEmit            → 通过
pnpm lint        # eslint src tests        → 0 错误
pnpm build       # tsc + copy-assets       → dist/ 就绪
pnpm test        # vitest run（真实 PG 容器）→ 7 files, 73 passed, 0 failed, 0 skipped
docker build -t brewphase-cloud:phase-1.1 .  → 构建成功
node dist/scripts/migrate.js                 → 迁移应用成功
生产 dist 冒烟                                → /health 200 /ready 200 /authorize 302
```

### 未完成事项

见 §13（Provider 真实凭据、限流共享存储、session 物理清理、生产实测）。

---

**Phase 1.1 到此完成，等待人工审查。不自动进入 Phase 1.2。**
