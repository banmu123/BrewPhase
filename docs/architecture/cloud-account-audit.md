# BrewPhase 云端账号体系架构审计（Phase 1.0）

> 日期：2026-11-16 · 基线：`main @ bcfc25b`（Desktop 0.1.4）
> 性质：**只审计与设计，未实现任何账号功能，未修改业务代码**。
> 产品原则锚点：Local-first；登录可选；退出不删本地数据；网络异常不影响本地读写。

---

## 1. 当前项目真实目录结构（与本报告相关的部分）

```
BrewPhase/
├── Desktop/                        # Electron 桌面端（本报告主体）
│   ├── src/
│   │   ├── main/                   # 主进程（全部特权与 IO 都在这里）
│   │   │   ├── index.ts            # 生命周期 / 单实例锁 / 服务装配 / IPC 注册入口
│   │   │   ├── ipc/register.ts     # IPC 唯一注册表（818 行：sender 校验 + zod + 错误脱敏）
│   │   │   ├── window.ts           # 主窗口（sandbox+contextIsolation 硬约束）
│   │   │   ├── appearance.ts       # 外观 / 窗口 chrome / 图标
│   │   │   ├── database/           # client.ts / migrations.ts / schema.ts / repositories/*
│   │   │   ├── application/        # Application Services（records/coffee/canvas/
│   │   │   │                       #   work-context/personal-direction/local-workspace/
│   │   │   │                       #   reply-intelligence/errors/events）
│   │   │   ├── browser/            # WebContentsView 浏览器 / 浮窗 / 拖拽会话 / 缩略图
│   │   │   ├── roundtable/         # 圆桌布局 / 视图托管 / 独立窗口
│   │   │   ├── ai-chat/            # adapters(registry/platforms)/participant-service
│   │   │   ├── mcp/                # stdio.mjs 入口 / bridge-client / tools/*（18 工具）
│   │   │   ├── integrations/chrome/# Chrome Companion（扩展 + Native Messaging）
│   │   │   ├── sync/               # LAN 同步（iOS ↔ Desktop；auth.ts 安全原语）
│   │   │   ├── update/             # 版本感知（GitHub Releases）
│   │   │   ├── media/ metadata/ data-location-service.ts
│   │   ├── preload/index.ts        # contextBridge 白名单（唯一桥）
│   │   ├── renderer/src/           # React（features/… / app/ / i18n / shared/api）
│   │   └── shared/                 # contracts(zod)/domain —— Main↔Renderer 唯一契约层
│   ├── electron-builder.yml        # 打包（mac 签名公证 / win NSIS）
│   └── build/icon.{icns,ico,png}   # 应用图标
├── BrewPhase/                      # iOS（App Store 1.1；LAN 同步对端）
├── ChromeExtension/                # Chrome Companion 扩展（浏览器侧，与账号无关）
├── docs/                           # 测试报告 / MCP 架构 / PROJECT_STATUS.md
└── Tools/                          # 辅助脚本（Localization 等）
```

## 2. Electron 架构分析

| 项 | 现状（实测代码） | 与账号体系的匹配度 |
|---|---|---|
| 进程模型 | Main 全特权；Renderer 零 Node；`shared/contracts` 契约层双向复用 | ✅ 账号服务作为 Main 端新服务即可，Renderer 不碰凭证 |
| Preload | `contextBridge.exposeInMainWorld('brewphase', api)` 逐条列出能力，不透传 `ipcRenderer` | ✅ 新增 `account` 命名空间沿用同一模式 |
| Context Isolation / Sandbox / NodeIntegration | 所有窗口（主/浮窗/圆桌/采集宿主）`sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true`（window.ts:55-58、float-window.ts:123-126） | ✅ 无需改动 |
| CSP | `index.html:12`：`default-src 'self'; script-src 'self' 'unsafe-inline'; …; connect-src 'self' ws: http://localhost:*` | ⚠️ 两个缺口：①`script-src 'unsafe-inline'`（Vite 遗留弱点，与账号无直接关系但应记入债务）；②**云端账号 API 域名不在 `connect-src`**——不过方案上网络调用全部走 Main（`net.fetch`），Renderer 不直连云端，**CSP 无需为账号放行新域** |
| Deep Link | **完全没有**：无 `setAsDefaultProtocolClient`、无 `open-url` 处理；仅有 `second-instance` 单实例锁（index.ts:597） | ⚠️ OAuth 回调需要新增基础设施（见 §8 选型：Phase 1.1 建议先用 localhost 回调规避） |
| 系统默认浏览器 | `shell.openExternal` 已有两处成熟使用（浏览器面板「用系统浏览器打开」、更新「打开下载页」） | ✅ OAuth 授权页直接复用 |
| 生命周期 | 单实例锁 + `isQuitting` + `before-quit` 统一 dispose；多窗口广播（`app:changed`） | ✅ 账号会话刷新/撤销广播沿用 |
| 网络请求封装 | `update-service.ts:32` `net.fetch` 注入式 `FetchLike`（可测试、无 axios 依赖） | ✅ 云端 API 客户端沿用该模式 |

## 3. 本地数据库架构

- **存储**：better-sqlite3 + Drizzle ORM（`database/client.ts`：`openDatabase(file)` 返回 `{sqlite, db, deviceId, close}`）；逐版事务迁移 + `user_version`（`migrations.ts`，当前 **13** 版）。
- **位置**：默认 `app.getPath('userData')`，经 `data-location-service` 支持**用户可迁移**（复制不删除）。
- **业务表**：beans / brews / tastings / phase_rules / phase_reminders / records（+record_metadata/tags/tag_links）/ canvases(+nodes/strokes/notes) / sync_meta / change_log / devices / sync_baseline / sync_conflicts / local_state / mcp_clients / mcp_operation_log / mcp_idempotency / work_contexts(+resources) / current_states / directions / stage_goals / ai_conversations(+messages) / roundtable_panels / local_workspaces(+bindings) / captured_replies(+segments) / action_drafts。
- **身份字段扫描**：`schema.ts` 全文只有一处 `account_id`——`ai_messages.account_id`（Multi-AI 预留，**恒为空串**，语义是「同一平台多账号」占位，与云端账号体系无关）。**没有任何业务表含 user_id/owner**。
  → **结论：云端账号对现有业务表零侵入**。未来云端同步（Phase 4）才需要「本地库 ↔ 云端用户」的映射（放 `local_state` 或新表，本阶段不做）。
- **备份机制**：**无专门备份**。最接近的是 data-location 迁移时的整目录复制。⚠️ 账号/同步时代之前建议补「导出/备份」能力（列为 Phase 1.1 可选项，见 §13）。
- **Repository 模式**：纯函数模块（如 `repositories/local-workspaces.ts`），服务层校验——新增 `account` 仓库沿用。

## 4. 现有登录与身份相关代码

| 类别 | 结论 |
|---|---|
| 登录页面 / OAuth | **不存在**。SettingsPage 分区为 general/sync/browser/chrome/mcp/workspace，无账号 |
| 用户身份模型 | **不存在**。`devices` 表（sync_meta 同源）是 **LAN 同步的设备配对**（iOS ↔ Desktop，Bearer token 只存 sha256 + nonce 防重放 + HMAC 写签名，见 `sync/auth.ts`）——是**设备凭证**不是用户账号，概念上不合并 |
| Token 管理经验 | 三套成熟模式可复用：①sync/auth.ts（sha256 存储、恒定时间比较、重放窗口）；②MCP clients（token 哈希、scope 白名单、幂等键、审计日志 `mcp_operation_log`）；③Bridge（Unix socket / Named Pipe ACL 限当前用户） |
| 第三方身份绑定 | 不存在 |
| 网络请求 | `net.fetch` 注入模式（update-service）+ 链接元数据抓取（`metadata/`） |
| safeStorage / Keychain | **未使用**（`grep safeStorage` 零命中）→ 凭证加密存储需从零新增 |
| 结论 | 无可复用的登录实现；但**令牌安全的三套本地先例**是云端 auth_sessions 设计的直接参照 |

## 5. 当前 MCP / AI 接入架构（只审计，未修改）

- **Bridge**：`BridgeServer`（macOS/Linux Unix socket；Windows Named Pipe ACL 限当前用户）——Electron Main 内常驻，经 `McpClientService` 做认证（token sha256）、scope 校验、幂等、审计。
- **stdio 入口**：`src/mcp/stdio.ts → out/mcp/stdio.mjs`（单文件 ESM，依赖全打包）；无数据库权限，全部转发 Bridge；Token 从环境变量读（命令行会被进程列表看到——文档已注明）。
- **工具注册**：`tools/{records,coffee,canvas,work-context,personal-direction}.ts` 的 `registerXxxTools(mcp)`，18 工具 / 8 scope 组（`MCP_SCOPE_GROUPS`）。
- **与未来 Remote MCP 的关系**：Bridge 已具备「认证 + scope + 审计 + 单一事实库」三要素；Remote MCP（Phase 3）本质是给 Bridge 加一个**出站连接的传输层**（Desktop 主动外连，云端转发），架构预留点：scope 体系可扩展（加 `account:` 域）、审计日志已就位。**本阶段不动。**
- **AI 网页适配**：adapters registry（严格主机匹配）+ participant-service——与账号无耦合，不受影响。

## 6. Local-first 兼容性风险清单

| # | 风险 | 等级 | 处理 |
|---|---|---|---|
| 1 | 登录被做成启动/使用门槛 | 高 | 架构红线：账号是 `application/account` 纵切面，与业务服务零依赖；UI 只加设置分区 |
| 2 | 退出/断网影响本地读写 | 高 | 会话凭证独立于业务服务；业务 SQL 无任何账号依赖（§3 实测） |
| 3 | CSP `connect-src` 未含云端域 | 低 | 方案：云端调用全部走 Main `net.fetch`（不经 Renderer），CSP 无需放行；若未来 Renderer 直连需改 CSP |
| 4 | Deep Link 基础设施为零 | 中 | Phase 1.1 采用 localhost 回调规避（§8）；deep link 列为后续增强 |
| 5 | safeStorage 未使用 | 中 | Phase 1.1 新增 `credentials.ts`（§9） |
| 6 | 无备份机制，账号误操作焦虑放大 | 中 | Phase 1.1 可选：最小备份（dataDir 快照导出） |
| 7 | `script-src 'unsafe-inline'` | 低（既有债务） | 与账号无关；记入技术债，单独治理 |
| 8 | 业务表无用户维度 | ——（非风险） | 云端同步（Phase 4）才需要映射；本地单用户假设继续成立 |

## 7. 云端账号服务技术选型

**推荐：独立部署的小型 TypeScript 服务（monorepo `cloud/` 子目录，独立部署单元）**

| 选型 | 选择 | 理由（结合现有仓库） |
|---|---|---|
| 语言/框架 | **TypeScript + Hono（或 Fastify）** | 与 Desktop 同语言同类型工具链；Hono 极轻（零大件依赖）、Web 标准 API、部署目标灵活（Node/VPS/Fly.io）；Fastify 若需更全插件生态。不引入 NestJS（重） |
| DB/ORM | **PostgreSQL + Drizzle ORM** | 与 Desktop 同一 ORM 心智（迁移/类型体验一致）；Postgres 的事务与约束（唯一索引/级联）正合身份表需求 |
| 认证协议 | OAuth 2.0 + OIDC（Google `openid email profile`；GitHub OAuth App + 读取 `GET /user`）**服务端实现，不引 Auth.js/Passport** | 两个 provider 的对接代码量小（<300 行）；自持实现才能精确控制 state/PKCE/授权码一次性语义；避免大框架锁定 |
| 会话 | 短时 **JWT access**（10–15 min，无状态验签）+ **opaque refresh token**（随机 256bit，库中只存 sha256，rotation） | 规格的 auth_sessions 方向；JWT 让 Desktop 不必每请求回库，refresh rotation 提供可撤销性 |
| 部署 | 单进程单容器（VPS / Fly.io / Railway 任一），Postgres 托管（Neon/Supabase-DB-only 均可） | 明确**不做微服务**（规格 §六）；一个服务 + 一个库即够 |
| 不选 Supabase/Auth0 全家桶 | 数据主权（Local-first 产品姿态）、成本、与现有 Drizzle 栈一致性；Auth0 免费档对桌面分发规模不友好 | —— |

**环境/密钥**：`GOOGLE_CLIENT_SECRET`、`GITHUB_CLIENT_SECRET`、`JWT_SIGNING_KEY`（建议独立于 session secret）、`DATABASE_URL` 全部走部署环境变量；代码库不落任何密钥。

## 8. Google / GitHub OAuth 流程设计（Electron 端安全）

### 回调方案选型：**localhost 一次性回调为主，deep link 为后续增强**

| 维度 | localhost 回调（推荐） | deep link（brewphase://） |
|---|---|---|
| 基础设施 | 零注册：Main 起 `127.0.0.1` 随机端口一次性 HTTP 监听（BridgeServer 已有同族经验） | 需新增 `setAsDefaultProtocolClient` + electron-builder `protocols` + macOS `CFBundleURLTypes` + Windows second-instance argv 解析（**当前完全没有**） |
| 浏览器兼容 | 系统默认浏览器导航到 `http://127.0.0.1:<port>/callback`，无确认弹层 | 浏览器弹「打开 BrewPhase？」确认层（体验分叉） |
| 风险 | 端口占用（随机端口缓解）；本机其他程序抢先回调（state 校验兜底） | Windows 协议注册残留/卸载污染；dev 模式注册路径差异 |
| 结论 | **Phase 1.1 采用** | 列为后续增强（对移动端 Remote MCP 时才真正必要） |

### 完整流程（与规格 §四 对齐）

1. Renderer 点「Google 登录」→ IPC `account.login('google')`（**只传意图**）；
2. Main：生成 `state`（256bit 随机）+ PKCE `code_verifier`/`code_challenge`(S256)，**本地起一次性回调监听**（随机端口、60s 超时自毁），向云端 `/oauth/authorize` 发起，`shell.openExternal(授权URL)`（URL 含 `state` + `code_challenge` + `redirect_uri=http://127.0.0.1:<port>/callback`）；
3. 云端 `authorize`：校验 client、**生成并持久化一次性授权码**（`oauth_codes` 行：TTL 60s、绑定 state 哈希与 code_challenge），302 到第三方授权页；
4. 用户完成 Google/GitHub 授权 → 云端回调端点：**校验第三方 state** → 用 `sub`/用户 ID 匹配或创建 `users`+`user_identities` → 生成授权码 → 302 回 `redirect_uri?code=…&state=…`；
5. 本地回调监听收到 `code+state`：**校验 state 逐字节相等**（本地生成比对，防 CSRF）→ 关闭监听 → `POST /oauth/token`（带 `code` + `code_verifier`）；
6. 云端 `token` 端点：授权码存在、未过期、**未消费**（消费即标记，防重放）、`code_verifier` 与存储的 challenge 匹配 → 签发 `access(JWT,10min)` + `refresh(opaque,rotation)`；
7. Desktop：refresh/access 经 **safeStorage 加密**存本地；**Renderer 只拿 profile DTO**（id/昵称/邮箱/头像/身份列表）；
8. 退出：`POST /auth/logout`（撤销 refresh + session）→ 清 safeStorage → 广播 `account` 域 → UI 回未登录；**本地 SQLite / MCP / 全部功能不动**。

### 防重放与校验要点

- 授权码：一次性（消费标记 + 唯一索引）+ 60s TTL + 绑定 state 哈希 → 重放无效；
- state：本地随机生成、逐字节恒定时间比较、一次会话一个；
- PKCE：S256，verifier 只在本地内存，云端只存 challenge；
- redirect_uri：云端按 client 注册表**精确匹配**（含端口——本地随机端口需动态注册参数：authorize 请求带 `redirect_uri`，云端校验其为 `http://127.0.0.1:<port>` 白名单形态并把它绑定进授权码，token 时校验一致）；
- refresh rotation：每次刷新旧 refresh 作废 + 新发；**同一 family 的旧 token 被复用 → 撤销整个 family**（防盗用）。

### Windows / macOS 兼容

- localhost 方案：两平台一致，无系统注册；Windows 防火墙对 `127.0.0.1` 监听不拦截（loopback）。
- （后续 deep link）Windows：`setAsDefaultProtocolClient`（打包版免参，dev 需 `process.execPath` + args 特判）；macOS：electron-builder `protocols` 字段 + `app.on('open-url')`；两者都需经 second-instance 把回调 URL 转给首实例。

## 9. 安全凭证存储方案（Desktop 端）

- **Electron `safeStorage`**（未用过，Phase 1.1 新增）：Windows DPAPI / macOS Keychain / Linux libsecret，按 OS 原生加密 `encryptString/decryptString`。
- 存放：`safeStorage.encrypt(refresh + access JSON)` → 密文写 `local_state`（键 `account.session.v1`）或独立文件；**明文只在内存**。
- 启动时解密恢复会话；解密失败（换机器/DPAPI 损坏）→ 视为未登录，**不报错不阻塞**。
- Renderer 永不接触 token：IPC 只返回 profile DTO；刷新在 Main 定时/按需进行。
- 退出：云端撤销 → `safeStorage` 删除 → 清 local_state 键。
- 现有先例对齐：与 sync/MCP 的「只存哈希/最小暴露」纪律一致；新增 `account.ts` 服务与 `credentials.ts` 隔离测试。

## 10. 云端数据库 Schema 建议（PostgreSQL / Drizzle）

```sql
users (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'active',      -- active | suspended | deleted
  display_name  text not null default '',
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

user_identities (
  id               uuid primary key,
  user_id          uuid not null references users(id) on delete cascade,
  provider         text not null,                      -- 'google' | 'github'
  provider_subject text not null,                      -- Google OIDC sub / GitHub user id（字符串化）
  email            text not null default '',
  email_verified   boolean not null default false,
  raw_profile      jsonb not null default '{}',        -- 调试用最小快照
  created_at       timestamptz not null default now(),
  unique (provider, provider_subject)                  -- 身份唯一锚点；**邮箱相同不合并**
);

auth_sessions (
  id                uuid primary key,
  user_id           uuid not null references users(id) on delete cascade,
  refresh_token_hash text not null unique,             -- sha256；明文永不落库
  token_family      uuid not null,                     -- rotation 族：复用旧 token → 整族撤销
  device_id         uuid,                              -- Phase 2 设备管理预留（可空）
  device_name       text not null default '',
  user_agent        text not null default '',
  ip_hash           text not null default '',          -- sha256(ip + 服务端盐)，不存明文 IP
  expires_at        timestamptz not null,
  revoked_at        timestamptz,
  replaced_by       uuid,                              -- rotation 链
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz not null default now()
);

-- 规格外建议补充的两张表（安全必需）：
oauth_states (
  state_hash     text primary key,                      -- sha256(state)
  code_challenge text not null,
  redirect_port  integer not null,
  provider       text not null,
  expires_at     timestamptz not null,                  -- 5 分钟，过期清理任务
  created_at     timestamptz not null default now()
);

oauth_codes (
  code_hash      text primary key,                      -- sha256(一次性授权码)
  user_id        uuid not null references users(id),
  state_hash     text not null,
  code_challenge text not null,
  redirect_uri   text not null,                         -- 绑定本机回调端口
  consumed_at    timestamptz,                           -- 用后即焚（防重放核心）
  expires_at     timestamptz not null,                  -- 60 秒
  created_at     timestamptz not null default now()
);

-- 建议补充：auth_events（login/refresh/rotate/revoke/logout 审计，含 ip_hash）
```

**规格三表的分析**：`users`/`user_identities`/`auth_sessions` 字段基本够用，需补：`token_family` + `replaced_by`（rotation 重用检测）、`device_id/device_name`（Phase 2 预留）、`ip_hash/user_agent`（审计）、以及 **`oauth_states` / `oauth_codes` 两张短 TTL 表**（规格未列，但 PKCE + 授权码防重放必须有持久锚点）与 `auth_events` 审计表。

## 11. Phase 1.1 需要修改的现有文件清单（预估）

| 文件 | 修改 |
|---|---|
| `src/main/index.ts` | 装配 AccountService；**无 deep link 时不注册协议** |
| `src/main/application/events/application-events.ts` + `shared/contracts/index.ts` | AppDomain 增 `'account'` |
| `src/shared/contracts/validation/ipc.ts` | `account:*` 通道（login/refresh/logout/session/identities） |
| `src/preload/index.ts`、`src/shared/contracts/index.ts` | `account` 命名空间（只暴露 profile 与意图，**不暴露 token**） |
| `src/renderer/src/features/settings/SettingsPage.tsx` + `app/store.ts` | `SettingsCategory` 增 `'account'` + AccountSection |
| `src/renderer/src/i18n/messages/{zh-CN,en-US}/settings.ts` | 账号文案 |
| `src/renderer/index.html` | （仅当 Renderer 直连云端才改 CSP——方案下不需要） |
| `electron-builder.yml` | （仅 deep link 增强时加 `protocols`） |

## 12. 预计新增文件与目录清单

```
cloud/                                   # 独立部署单元（新目录，不进 Desktop 构建）
├── package.json / tsconfig.json / drizzle.config.ts
├── src/
│   ├── index.ts                         # Hono app（/oauth/*、/auth/*、/health）
│   ├── db/（schema.ts / client.ts / migrations/）
│   ├── oauth/（google.ts / github.ts / pkce.ts / codes.ts）
│   ├── auth/（sessions.ts / jwt.ts / middleware.ts）
│   └── env.ts
├── tests/（oauth 流程集成测试：mock provider）
└── Dockerfile

Desktop/
├── src/main/account/
│   ├── account-service.ts               # 登录意图/会话恢复/退出/身份列表
│   ├── oauth-callback-server.ts         # 127.0.0.1 一次性回调监听
│   ├── credentials.ts                   # safeStorage 封装
│   └── cloud-client.ts                  # net.fetch 封装（注入式，可测试）
├── src/shared/contracts/account.ts      # profile DTO + zod
└── tests/unit/（account-service / credentials / cloud-client）
```

## 13. Phase 1 后续实施顺序（Phase 1.1 起）

1. `cloud/` 服务骨架：schema + 迁移 + `/health`；
2. Google OAuth 全流程（authorize/token/refresh/logout）+ `oauth_states/codes` 一次性语义 + 单测；
3. GitHub OAuth（同构，`sub`→`id`）；
4. Desktop：`credentials.ts`（safeStorage）→ `account-service` → IPC/preload/contracts；
5. 设置页「账号」分区（未登录/已登录/退出，UI 只增不改）；
6. E2E：登录→重启恢复会话→退出→**本地数据与功能全量回归**（断网矩阵）；
7. （可选）最小备份导出；（Phase 1.2）deep link 增强 + GitHub 身份绑定 UI。

## 14. 主要安全风险与解决方案

| 风险 | 解决 |
|---|---|
| Token 进 Renderer（XSS 窃取） | 架构性隔离：Main 持凭证，IPC 只给 profile DTO；CSP 已有；`unsafe-inline` 记债 |
| 授权码被截获重放 | 一次性 + 60s TTL + PKCE(S256) + 绑定 state/redirect |
| state CSRF | 本地随机生成 + 恒定时间比较 + 一次性 |
| refresh 泄露/复用 | sha256 存储 + rotation + family 级联撤销 + safeStorage 加密 |
| 邮箱相同误合并账号 | 明确禁止：身份锚点仅 `(provider, provider_subject)`；合并未来做成显式用户操作 |
| Token 进日志/进程列表 | 沿用现有纪律（MCP：日志脱敏；Token 走 env 不走 argv） |
| 云端滥用/DoS | 速率限制（authorize/token/logout）、oauth_states/codes 过期清理任务 |
| 本地回调被抢占 | 随机端口 + state 校验兜底；监听仅存活至收到回调或超时 |
| 账号注销与数据 | Phase 1 仅「退出登录」；数据删除/导出列为账号体系 Phase 后续（合规预留） |

## 15. 测试与验收标准

- **云端**：oauth 全流程集成测试（mock Google/GitHub）；单测覆盖 state 一次性、code 60s TTL/消费即焚、verifier 不匹配拒绝、refresh rotation 与 family 撤销、速率限制；`oauth_states/codes` 过期清理。
- **Desktop**：credentials 单测（safeStorage mock：加密往返/损坏降级为未登录）；account-service 单测（登录意图/会话恢复/退出清理）；cloud-client 单测（net.fetch 注入、超时）。
- **UI E2E**：未登录态显示、Google/GitHub 按钮触发意图、登录后信息与身份列表、退出后回到未登录。
- **Local-first 回归（硬验收）**：登出状态与断网状态下——现有全量单测/E2E 全绿；豆/记录/画布/工作区/回复整理/MCP 全部可用；`git diff` 显示业务表与服务层零改动。
- **验收红线**：任何测试中出现「不登录无法使用本地功能」即为设计失败。

---

## 结论（对应交付要求）

- **当前架构是否适合加入云端账号**：适合。解耦点清晰——账号是新增纵切面（`application/account` + `cloud/`），业务表零侵入（实测无 user_id），Renderer 凭证隔离架构已就位。
- **是否建议独立部署云端账号服务**：建议。monorepo `cloud/` 子目录 + 独立部署单元（Hono + Postgres + Drizzle），不塞进 Electron，也不做微服务。
- **Google / GitHub 登录分别需要的准备**：Google——Cloud Console 项目 + OAuth Client（Web application 类型 + authorized redirect 指向云端回调）+ 同意屏幕；GitHub——OAuth App（callback 指向云端回调）+ Client Secret。两者 Secret 只存云端环境变量；桌面端零密钥。
- **当前代码需要提前处理的问题**：①deep link 基础设施为零（Phase 1.1 用 localhost 回调规避）；②safeStorage 未使用（新增）；③无备份机制（建议补最小导出）；④CSP `unsafe-inline` 既有债务（与账号无关，单独治理）；⑤`ai_messages.account_id` 与账号体系无关，不要误用。
- **Phase 1.1 应该具体实现**：`cloud/` 账号服务（users/identities/sessions/states/codes + Google/GitHub OAuth + refresh rotation）、Desktop `account` 服务与 safeStorage 凭证、设置页账号分区、上述测试。**不实现** deep link、设备管理、Remote MCP、同步。
- **主要架构风险**：localhost 回调依赖桌面端运行环境（端口/防火墙极端场景，已有缓解）；refresh rotation 的并发正确性（需锁/原子 SQL）；「邮箱相同不自动合并」需要在产品文案中明确（否则用户困惑）；未来 Remote MCP 时 scope 体系需加 `account:` 域并重审审计粒度。

**本阶段到此停止，等待人工审查与 Phase 1.1 指令。**
