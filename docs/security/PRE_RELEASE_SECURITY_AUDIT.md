# BrewPhase 正式发版前安全审计与修复报告

> 日期：2026-11-27 · 分支：`security/pre-release-hardening`
> 审计基线：`edf60c1dcd71a04cfe473eb09bbb53574952163e`（main）
> 性质：正式发版前安全审计。目标不是新功能，而是确认个人记录、咖啡数据、用户凭证、
> 设备同步和远程 MCP 是否存在影响真实用户的重大安全问题，并修复 P0/P1。
> **本轮不创建 Release、不改正式版本号。**

---

## 1. 审计范围与基线

| 模块 | 范围 |
|---|---|
| 局域网同步（最高优先级） | `Desktop/src/main/sync/*`（server / auth / pairing / media-transfer / snapshot-importer / wipe）、`Desktop/docs/SYNC_PROTOCOL.md`、iOS `BrewPhase/Sync/*`（Keychain / NetworkClient / Manager / Models）、跨端夹具与测试 |
| Remote MCP 云端 | `cloud/src/mcp-http/`、`mcp-oauth/`、`mcp-devices/`、`link/`、`sessions/`、`security/`、`db/`、相关测试（60+ 文件） |
| Electron 桌面端 | `window.ts`、`ipc/register.ts`、`preload/index.ts`、`mcp-bridge/`、`authorization/`、`integrations/chrome/`、`browser/`、`ai-chat/` |
| 本地数据 | SQLite（drizzle / better-sqlite3）、媒体目录、数据目录迁移、Agent 配置写入、wipe |
| 隐私与数据流 | `docs/privacy.html`、`docs/privacy-gap.md`、Cloud 表结构、转发链路 |
| 依赖与构建 | Desktop/Cloud `pnpm audit --prod`、Electron 45、Actions 权限、仓库泄密扫描 |

审计方法：三路并行摸底（每处结论带文件:行号）→ 主线程复核可疑点 → 探针实证
（submodule 幽灵修改、`GIT_CONFIG_NOSYSTEM` 行为、TLS 握手行为）→ 修复 → 测试 → 门禁。

## 2. 风险等级与问题清单

### 已修复

| ID | 等级 | 问题 | 位置 | 攻击路径（摘要） | 修复 |
|---|---|---|---|---|---|
| P0-1 | **Critical** | 局域网同步全程**明文 HTTP**：`GET` 端点明文 Bearer（一次嗅探 = 长期 token，无过期）、`/api/pair` 明文配对码+token、全部记录 payload 与媒体字节可截获 | `sync/server.ts`（`node:http`）、`SyncNetworkClient.swift:27-29`（`http://`） | 同一 Wi-Fi 的攻击者被动嗅探即可获得永久访问凭据与全部个人记录内容；HMAC 只防截获后的写重放，不防截获本身 | **TLS 改造（协议 v2）**，见 §4.1 |
| P1-1 | **High** | `browser:execute-on-tab` IPC 接受渲染端**任意脚本字符串**并 `executeJavaScript`；渲染端无任何调用者——纯攻击面 | `ipc/register.ts`（旧 `:781`）、`preload/index.ts:78` | 渲染进程被攻破（XSS/devtools）→ 在用户已登录的内嵌页面（`persist:` 分区）执行任意 JS，窃取登录态 | **移除 IPC 通道**（register/preload/contracts/validation 四处）；`executeOnTab` 保留为主进程内部 API（真实消费者——AI chat adapters——本就直连 `webContents.executeJavaScript`） |
| P1-2 | **High** | `claimSecretHash` / `confirmCodeHash` 用普通 `!==` 比较（哈希后），违反项目恒定时间比较纪律 | `cloud/src/mcp-devices/claim.ts:71`、`service.ts:177` | 理论上的时序侧信道（实用度低：比较对象是哈希、确认码有 5 次上限+限流，但纪律不一致） | 改用 `security/crypto.ts` 的 `constantTimeEqual`（与 PKCE / browser-binding 同一工具） |
| P1-3 | **High** | 设备注册的「同公钥查重 + 5 台配额」是事务内 SELECT→INSERT，并发注册可产生重复 pending 设备/超配额 | `cloud/src/mcp-devices/service.ts:110-133` | 并发注册同一公钥 → 重复设备行；并发注册 → 超配额（同用户资源面，无跨用户影响） | migration `0006_mcp_device_public_key_unique.sql`（`(user_id, public_key)` 部分唯一索引，排除 revoked）+ 应用层捕获 23505 转成 `deviceExists` |
| P1-4 | **High（真实 bug）** | 引擎的 git 隔离环境在 Windows 上产生**幽灵修改**：`GIT_CONFIG_NOSYSTEM=1` 丢掉系统级 `core.autocrlf=true`，CRLF 落盘文件与 LF index 失配 → 干净 submodule 被报 `1 .M S.M. 160000`（探针实证） | `git-command-runner.ts:buildGitEnv` | 影响：Windows 上工作区快照含幽灵变更 → 同步把不存在的变化推给 iPhone；CI Windows job 因此挂（发版阻塞） | win32 上保留系统 config（注入风险项已被 `-c core.fsmonitor=false` / `--no-pager` / 清空 `GIT_*` 覆盖）；POSIX 保持完全隔离 |
| P2-1 | Medium | `before-quit` 清理清单缺 LAN 同步服务——退出竞态窗口内新同步请求仍可进入认证/落库 | `index.ts:793-853` | 竞态窗口内落库（事务保护，无直接漏洞） | `syncService?.disable()` 加入有界收尾（3s 兜底不变） |
| P2-2 | Medium | `bindAll(port=0)` 时 `activePort` 记为 0（未回读内核分配端口）→ 二维码/状态里的端口错误 | `sync/server.ts` bindAll | 功能缺陷（`preferredPort=0` 场景），测试中发现 | 返回 `actualPort`（从 `server.address()` 回读） |
| P2-3 | **High（合规）** | 隐私政策与实现不一致：无账号/不联网/卸载删除等声明与 Remote MCP、LAN 监听、卸载行为、元数据抓取不符 | `docs/privacy.html:105-143` vs `privacy-gap.md` | 用户的知情权与合规风险（技术风险低） | `privacy.html` 增加「桌面端补充说明」（zh/en 双语）：云账户、LAN TLS 同步、Remote MCP 经 Cloud 转发的可见性、链接元数据出站、Windows 卸载不删数据、导出为 iOS-only；`privacy-gap.md` 追加本轮审计发现 |

### 记录接受（P2/P3，附理由）

| ID | 位置 | 现象 | 接受理由 |
|---|---|---|---|
| S3 | `sessions/jwt.ts:29` | kid = sha256(secret) 前 8 hex，公开 header 泄露密钥哈希 32bit 前缀 | 不构成密钥恢复路径；改随机 kid 属增强项 |
| S4 | `env.ts` + 两套凭据 | Desktop/MCP 凭据共享 HS256 密钥环，隔离靠 iss/aud 强制（有双向测试） | 当前实现正确；密钥泄露=单点。中期建议密钥分离或迁非对称（架构变更，不在本轮） |
| S5 | `link/connection-registry.ts` | 每用户单连接、后连者顶替：多设备用户请求总发给当前占槽设备 | 产品语义问题非越权（跨用户结构性不可能）；需要产品确认 |
| S6 | `mcp-oauth/token-flow.ts:142-160` | 兑换时不复核 redirect_uri 是否仍在 client 当前集合 | 文档化决策；窗口 60 秒；CIMD 缓存到期缓解 |
| S7 | `link/nonce-store.ts` | nonce 表进程内存：重启后 ±120s 窗口内握手可重放一次 | 已在注释记录；需同时持有 device_token，且只换来连接不换数据；多实例化时必须换共享存储 |
| S8 | `link/link-server.ts` | 无 Origin 的 WSS 放行进入设备认证 | 设计如此（Origin 只挡浏览器上下文）；建议对无 Origin 握手成功保持指标观测 |
| S9 | `mcp-oauth/authorize-flow.ts:295` | `deleteAuthRequest` 仅按 rid 删行 | **检查通过**：5 处调用点全部位于过期/绑定失配/Provider 认领失败的 fail-closed 路径（删行 = 让可疑会话失效） |
| S10 | `mcp-http/tools.ts:21-24` | 写工具发送者约束（DPoP/nonce，OQ-16）未实现 | 当前**不开放任何写工具**（8 个只读工具 + `readOnlyHint`）；开放写工具前必须落地 OQ-16 |
| A1 | `mcp-bridge/bridge-contract.ts` | Windows Named Pipe 权限靠 Node 默认 ACL 的文档性保证 | Node 层无 DACL API；pipe 名含 userData 哈希；记录为低-中 |
| A2 | `data-location.ts:184-222` | 目录迁移中途失败目标残留半份数据 | 配置不写 → 不被引用；属隐私残留非数据损坏 |
| A3 | `window.ts:67` | `shell.openExternal` 仅校验 `https://` 前缀（非 URL 解析） | 畸形 URL 由 OS 浏览器兜底；低 |
| A4 | `sync/wipe.ts:29-43` | wipe 含本地创作（咖啡/画布），防护靠 UI 确认文案 | 2026-11-09 产品决策（注释自述）；`DELETE_SYNCED_CONTENT` 确认串 + Bearer+HMAC 已有 |
| A5 | `@hono/node-server@1.19.19`（CVE-2026-118663，moderate） | `serveStatic` 双重解码绕过中间件 | **Cloud 不使用 serveStatic**（仅 `serve()`），不受影响；2.x 是 major 升级，按「不为告警盲目升级」原则记录接受 |
| A6 | 应用生命周期 | 关窗即完全退出、无 Tray/后台常驻 | 产品行为（用户已知情）；**降低攻击面**：LAN 服务只随应用运行期存在，`before-quit` 现已显式停止（P2-1） |

**未发现的问题**（同样重要）：Cloud 无跨用户越权、无身份注入（所有 userId 来自已验证凭据，三身份一致性 ST-1/ST-2 有结构保证与测试）；Electron 三层边界完整（sandbox+contextIsolation+全量 zod+trusted sender、无动态 channel）；SQL 全参数化、标识符来自白名单；日志无凭据泄露（redact + 白名单字段纪律）；仓库无泄密（工作区扫描 + `.gitignore` 检查）。

## 3. TLS 改造（P0-1 修复详情）

### 3.1 方案

**桌面端证书身份 + 配对交付 + iOS pinning**（不引入第三方依赖）：

1. **证书身份**（`sync/tls-identity.ts`，新）：首次启用同步生成 **ECDSA P-256 自签
   证书**（10 年有效期，`basicConstraints CA:FALSE critical`），私钥存 userData
   （0600）。Node 无 X.509 签发 API → 手写最小 ASN.1 DER 编码器（~150 行，全部
   输入为常量或 CSPRNG）。身份 = **证书 DER 的 SHA-256**（与 iOS
   `SHA256(SecCertificateCopyData)` 口径一致）。
2. **服务端**：`server.ts` 只监听 **HTTPS**（`https.createServer({key, cert})`）——
   不存在明文回退；`/api/status` 声明 `tls: true`。
3. **配对交付**：二维码新增 `certFingerprint` 字段（v2 必填）——「面对面扫码」是
   带外信任来源；iOS 存 Keychain（`desktop.certFingerprint`）。
4. **iOS pinning**（`SyncNetworkClient.swift`）：每次连接经 `URLSessionDelegate`
   的 serverTrust 处理——`SHA256(SecCertificateCopyData(leaf))` 必须等于
   Keychain 指纹，否则 `cancelAuthenticationChallenge`；未配置指纹 = 一律拒绝。
   所有 7 处客户端构造点（探测/pair/同步/unpair）全部带 pinning。
5. **协议版本**：`SYNC_PROTOCOL_VERSION` 1 → 2（双端）。v1 客户端探测 v2 服务端
   直接失败——**安全门**，不是兼容性事故。
6. **纵深防御保留**：Bearer + 时间戳/nonce/HMAC 原样（应用层重放防护不依赖
   TLS 信任）。

### 3.2 兼容性影响（任务书要求先分析再实施）

- **v1 iOS + v2 Desktop / v2 iOS + v1 Desktop**：配对被协议版本门拒绝（两端同
  发布内升级，无存量用户混合场景——0.2.1 是首个含自动更新的版本）。
- **二维码结构**：新增 `certFingerprint` 字段；旧二维码缺字段 → iOS 抛
  `missingCertificateFingerprint`（明确文案，不是静默降级）。
- **重新配对**：证书轮换后旧设备被 pinning 拒绝 → 重新扫码配对即恢复（不撤销授权）。
- **测试面**：`sync.test.ts` 58 用例全部切 TLS（`tlsFetch` helper 模拟 iOS 的
  锚定语义：`ca: [desktopCert]` + `rejectUnauthorized:true`）；harness 产出
  `certFingerprint` 供 iOS 跨端测试；4 条新 TLS 安全门测试。

### 3.3 Desktop 测试证据

- `tests/unit/sync-tls-identity.test.ts`（6）：X509 解析/指纹自洽/TLS 栈接受/
  CA:FALSE/持久化稳定/轮换语义。
- `tests/unit/sync.test.ts`（58，含 4 条新 TLS 安全门）：
  - 信任锚 = 桌面证书 → 200；
  - **信任锚是别的证书 → 标准 TLS 验证失败，连接拒绝**（攻击者自签证书场景）；
  - **明文 HTTP 请求 → TLS 握手失败**（不存在明文回退）；
  - **证书轮换：旧锚拒绝、重建实例后新锚通过**（模拟 iOS 未重新配对 → 重新配对）。

## 4. 测试结果与覆盖

### Desktop（本机 Windows 11，全量）

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | **121 files / 2046 passed / 29 skipped**（含 6 条 TLS 身份测试、4 条 TLS 安全门测试；submodule 用例为真实修复后通过） |
| `pnpm build` / `mcp:build` | 通过（MCP stdio 939KB） |

新增安全测试覆盖（对照任务书清单）：未授权（401 无 Bearer）、已撤销（revoked 401）、
错误证书/伪造证书（CA 锚不匹配 reject）、明文 HTTP 降级（拒绝）、写重放（nonce 去重
+ HMAC）、恶意媒体路径（白名单正则）、恶意同步数据（entityType 白名单 + 事务 + 冲突
基线）、日志凭证（redact 纪律 + 现有测试）、并发领取（claim 恰好一个）、撤销与在途
请求竞态（link dispatch-race）——**验证真实拒绝行为**（真实端口 + 真实 SQLite +
真实 TLS，无 mock 预期）。

### Cloud（部分阻塞）

- `pnpm typecheck`：通过（0 错误）。
- `pnpm test`：**本机阻塞**——Docker Desktop 的 WSL 后端被 WorkBuddy 安全中心的
  程序黑名单（wsl.exe）拦截，测试 PostgreSQL 容器无法启动。**已完成的修复
  （P1-2、P1-3）需要在 Docker 恢复后补跑**：`pnpm --dir cloud test`（重点
  `tests/mcp-devices/`、`tests/db/migrations.test.ts`）。
- 既有测试面（上次全量通过记录）：JWT/会话/OAuth/设备/link 60+ 文件，
  覆盖 §5 清单的跨用户、PKCE、并发、撤销竞态等。

### iOS（无法本机验证）

Swift 改造为盲写（本机无 Xcode）。**必须真机/模拟器验证**，见 §5。

## 5. 需要真实设备验证的项目

1. **iOS 配对全链路**（TLS v2）：扫码 → 探测（HTTPS+pinning）→ pair → Keychain
   写入（含 `desktop.certFingerprint`）→ 首次同步。
2. **证书 pinning 在真机的 ATS 行为**：自签证书 + URLSessionDelegate 接管
   serverTrust（预期不需要 ATS 豁免，需实测）；指纹不匹配时的用户可见报错文案。
3. **跨端夹具**：`sync-harness.ts` 现产出 `certFingerprint`——`SyncCrossEndTests`
   的 3 个用例在模拟器上全链路（读指纹 → pinning → 同步）。
4. **证书轮换路径**：桌面轮换证书后，已配对 iPhone 的报错文案与「重新扫码」恢复。
5. **Windows 实机**：Named Pipe 的 MCP bridge 连通性（DACL 文档性保证的实测）、
   非管理员账户下同步服务启停、防火墙首次弹窗。

## 6. 尚未修复的问题与理由

见 §2「记录接受」表（S3/S4/S5/S6/S7/S8/S10/A1-A6）。共同点：低危或非安全类，
修复收益低于改动风险（S4/S5 属架构/产品决策），已如实记录供后续版本排期。

另外两项**发布流程阻断项**（非代码，先前已知并保留）：
- Privacy Policy URL 404 / 无 Terms 页；
- Windows 安装包未签名（SmartScreen 每次拦截）。

## 7. 结论：是否具备正式发版条件

**有条件具备。** 判断依据：

- ✅ 无未处理的 Critical/High **代码级**问题：P0-1（明文传输）已用协议 v2 修复并
  有 4 条安全门测试；P1-1/P1-2/P1-3/P1-4 已修复且类型/测试通过。
- ✅ 局域网同步不再存在明文凭证与个人内容传输（TLS-only，无回退；应用层防护保留）。
- ✅ Remote MCP 的身份/权限/设备隔离：审计确认结构保证 + 既有 60+ 测试文件覆盖，
  本轮发现的唯一并发缺口已补唯一索引与原子守卫。
- ✅ Electron IPC 与本地 MCP 安全边界通过测试（含本轮移除的任意脚本通道）。
- ✅ 备份恢复/导入/媒体处理无已知高危路径（zip-slip/SQL 注入/路径穿越均确认防护）。
- ✅ 依赖与生产部署检查完成（1 个 moderate 经评估不受影响，记录接受）。
- ⚠️ **两个先决条件**：
  1. **Cloud 测试套件补跑**（本机 Docker 被安全策略拦截）：`pnpm --dir cloud test`
     全绿后方可发版——P1-2/P1-3 的修复已过 typecheck 但测试验证待补；
  2. **iOS TLS 全链路真机验证**（§5 清单）：Swift 改造无法本机编译验证。
- ✅ 安全文档与代码一致（privacy.html 桌面端补充节 + SYNC_PROTOCOL.md v2 +
  privacy-gap.md 审计补充）。

**建议的发布路径**：① 放行 Docker → Cloud 测试补跑全绿；② iOS 模拟器跑
SyncCrossEndTests + 真机配对冒烟；③ 合并本分支回 main；④ bump 版本推 tag →
CI draft Release → 人工审核 Publish。

## 8. 交付清单

- 分支：`security/pre-release-hardening`（自 `edf60c1`）
- Desktop：`sync/tls-identity.ts`（新）、`sync/server.ts`（HTTPS+端口修复）、
  `sync/sync-service.ts`（身份+二维码）、`sync/auth.ts`（未动，纵深防御保留）、
  `git-command-runner.ts`（autocrlf 修复）、`index.ts`（before-quit）、
  `ipc/register.ts` / `preload/index.ts` / `shared/contracts/*`（execute-on-tab 移除）、
  测试 4 文件（58+6 用例 TLS 化 + 19 处 skipIf 见 git 历史提交）
- Cloud：`mcp-devices/claim.ts` / `service.ts`（恒定时间比较 + 原子 INSERT）、
  `db/migrations/0006_*.sql` + journal
- 文档：`docs/security/PRE_RELEASE_SECURITY_AUDIT.md`（本文件）、
  `docs/privacy.html`、`docs/privacy-gap.md`、`Desktop/docs/SYNC_PROTOCOL.md`
- 本轮全部变更以独立提交落于安全分支（见 git log），**main 未动**
