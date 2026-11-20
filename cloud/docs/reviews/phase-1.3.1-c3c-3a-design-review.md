# BrewPhase Phase 1.3.1-C3c-3A — 设计审查报告

> 日期：2026-11-20 · 分支：`feature/remote-mcp` · HEAD `6c20908`
> 性质：设计审查 / 规范对齐 / 架构决策 / 测试契约冻结。
> **没有生产逻辑改动**（唯一的源码编辑是两处注释，见 §7）。
> 设计正文：`docs/design/phase-1.3.1-c3c-3a-cimd-authorize-integration-contract.md`

---

## 1. 本次审查的真实 HEAD

| 项 | 值 | 核对 |
|---|---|---|
| 分支 | `feature/remote-mcp` | `git branch --show-current` |
| 本地 HEAD | `6c20908` | `git log -1` |
| 远程 HEAD | `6c20908` | `git ls-remote`（固定 IP） |
| 工作区 | 干净 | `git status --porcelain -uall` |

提交链：`139731f`（C3c-2）→ `cb2e68c` / `92148bf`（R1）→ `326dcf1` / `502cbe7`（R2）
→ `6c20908`（R2v）。本阶段以 `6c20908` 为设计基线。

### 1.1 读取的代码与文档

代码：`cimd.ts`、`authorize-flow.ts`、`consent-flow.ts`、`sessions.ts`、
`revoke-flow.ts`、`routes/mcp-oauth.ts`、`db/schema.ts`、`env.ts`、
`net/proxy-fetch.ts`、`discovery.ts`，以及对应测试与迁移 `0003_mcp_oauth.sql`。

文档：`draft-ietf-oauth-client-id-metadata-document-03` 原文（2026-11-02）、
Node.js `tls` 文档源码（`doc/api/tls.md`）、R2/R2v 报告、`REMOTE_MCP_PHASE_1_3_DESIGN.md`
§7、`REMOTE_MCP_PHASES_ROADMAP.md`。

### 1.2 与任务书的两处偏差

1. 任务书说「当前远程基线 `6c20908`」——核实一致。
2. 任务书说「-03 发布日期 2026-11-02」——原文核实一致；**代码里原来写的是
   「2025 年版本」，已修正**（§7）。

---

## 2. 规范对齐结果（逐条）

标注：`MUST` / `MUST NOT` / `SHOULD` 为草案原文强度；`[项目策略]` 是本地更严格选择。

| # | 要求 | 强度 | 当前实现 | 结论 |
|---|---|---|---|---|
| 1 | `grant_types` 与 AS 支持集求交集 | MUST（§6） | 已实现「无交集即拒」，但错误码在 authorize 层是 `invalid_request`，不是 `invalid_client` | **3B 需改错误码** |
| 2 | `response_types` 求交集 | MUST（§6） | 同上 | 同上 |
| 3 | 任一交集为空 → `invalid_client` | MUST（§6） | 目前非 `invalid_client` | **3B 必改** |
| 4 | 抓取失败 → SHOULD 中止当前授权请求 | SHOULD（§6.1） | 未接入，无从谈起 | 3B 实现 |
| 5 | transient 不得使已建立信任失效 | SHOULD NOT（§6.1） | 分类已实现，未接数据库 | 3B 按 §5.1 落地 |
| 6 | transient 不得清除缓存 / 使 refresh 失效 | SHOULD NOT（§6.1） | 同上 | 3B 按 §5.1 落地 |
| 7 | `client_id` mismatch → 立即失效 refresh token | SHOULD（§6.1） | 无此路径 | **3B 必做**（§5.3） |
| 8 | 信任/策略类 terminal 可裁量失效 refresh | MAY（§6.1） | — | 决策：**不撤销**（§5.2） |
| 9 | 失败时不得重定向到客户端 | MUST NOT（§6.1） | 现状：JSON 400，不重定向 | 3B 改成 HTML 页（仍是 4xx/5xx） |
| 10 | token / PAR 失败 → `invalid_client`，transient → 503 | MUST（§6.1） | token 端点无 CIMD 分支 | 3B 按需 |
| 11 | `token_endpoint_auth_methods_supported` 缺省按 `none`，不得套 RFC 7591 默认 | MUST（§5） | 只接受 `none`，缺省即通过 | ✅ 已符合 |
| 12 | 两个 auth 字段同时出现时，单数必须属于复数集合 | MUST（§5） | **未实现** | **3B 新增判据** |
| 13 | 文档不得含共享密钥 / 私钥材料 | MUST NOT（§4.1） | 已实现（含 `oth`） | ✅ |
| 14 | `jwks` 与 `jwks_uri` 不得同时出现 | MUST NOT（§4.1） | 已实现 | ✅ |
| 15 | `client_id` 逐字符比较、不规范化 | MUST（§3/§4） | 已实现 | ✅ |
| 16 | 不得跟随重定向、只接受 200 | MUST（§6） | 已实现 | ✅ |
| 17 | 5 KiB 读取上限 | SHOULD（§10.11） | 已实现（草案建议值） | ✅ |
| 18 | SSRF：不得抓取 RFC 6890 特殊用途地址 | MUST（§10.7） | 已实现（IPv4 表 + IPv6 `2000::/3` 白名单） | ✅ |
| 19 | 不得缓存错误响应 / 非法文档 | MUST NOT（§6.2） | 已实现（失败结果不含 cache 字段） | ✅ |
| 20 | pre-registered 与 unregistered 并存时要有可靠区分方式 | SHOULD（§9.1） | `registration_source` 列 | ✅ |

**结论**：规范层面没有发现「已实现但违反 MUST」的项；差距集中在**接入层**
（#1–#4、#7、#10、#12），全部属于 C3c-3B 范围。

---

## 3. 已作出的架构决策

| # | 决策 | 理由（摘要） |
|---|---|---|
| D1 | `pre_registered` / `dcr` 行**永不**被 CIMD 覆盖，也不触发抓取 | 预注册是人工核验过的身份，自动抓取不得改写 |
| D2 | 未注册 `client_id` 只有**通过 CIMD URL 形态校验**才抓取；否则按既有 512 上限拒绝 | 避免把任意字符串当 URL 抓（SSRF 面与探测面） |
| D3 | 缓存四态机：`ABSENT / FRESH / STALE / INVALID`，`expires_at = NULL` 视为 STALE | fail-safe |
| D4 | 重取下限 30s（fetch floor） | 防 `no-cache` 文档把授权变成抓取放大器 |
| D5 | transient：中止当前请求，**保留**行、时间戳、Session、Refresh | 草案 §6.1 的三条 SHOULD NOT |
| D6 | terminal 中**只有** `client_id_mismatch` 撤销 Session（跨用户、全 client）；其余只标记缓存不可用 | 草案只对 mismatch 用 SHOULD；过度撤销会把文档事故放大成掉线 |
| D7 | 撤销用**单条 UPDATE + 单条聚合审计**（`user_id = NULL`） | 与 `revokeMcpSessionsByGrant` 一致；逐条写会刷满审计表 |
| D8 | `no-store` **拒绝**（terminal，不写行） | 授权码流程跨两个请求，必然要落库；落库与 no-store 语义冲突；进程内缓存与单副本绑定，不可取 |
| D9 | 元数据变化**不触发**通用撤销；`redirect_uris` 变化不影响既有令牌 | 同意页每次授权都出现（无静默路径），令牌不依赖这些字段 |
| D10 | 并发：`INSERT … ON CONFLICT DO NOTHING` + 以 `metadata_fetched_at` 做 CAS；不用 DELETE+INSERT | 数据库是唯一正确性来源；时钟不可靠 |
| D11 | 代理配置收口到 `Env.outboundProxy`，`createCimdDeps` **去掉默认参数** | R2v-F10 的根因是「默认读 process.env」；默认参数让漏传变成静默行为 |
| D12 | `ca` 语义是**替换**而非追加；3B 重命名为 `caOverride` 并移出生产入口 | Node 文档原文：`ca` completely replaces the default list |
| D13 | 数据模型只加一条 CHECK（`revoked_reason` 增 `client_id_mismatch`） | 审计要能区分「客户端主动撤销」与「服务端判定身份失效」 |
| D14 | `client_id_metadata_document_supported` 只在 #1–#9 + 真实客户端联调完成后才声明 | 声明即承诺；提前声明等于对外撒谎 |

---

## 4. 被排除的设计方案

| 方案 | 为什么排除 |
|---|---|
| 在 authorize 里直接调 `fetchClientMetadataDocument()` 并顺手写库 | 抓取器是纯边界，副作用必须由单一 registry 模块在同一事务里做；散落调用会产生「半注册」状态 |
| 未注册 `client_id` 一律抓取（不看形态） | 会把 `abc123` 当 URL 去解析/抓取，制造探测面与无意义 DNS |
| 缓存过期就无条件重抓（无下限） | `no-cache` 文档 → 每次授权一次出网，等于放大器 |
| transient 时删除缓存行 | 直接违反 §6.1「SHOULD NOT discard previously cached valid client metadata」 |
| terminal 时统一撤销 Session | 超出规范要求（除 mismatch 外都是 MAY），把一次文档错误放大成全量掉线 |
| 所有 terminal 都不撤销 | mismatch 场景会让被盗用的 client 身份继续持有 refresh token |
| `no-store` 写「立刻过期」的行 | 语义上仍是存储；no-store 的意图就是「不要存」 |
| `no-store` 用进程内 Map 暂存 | 正确性绑定单副本；本项目 `env.ts` 已经明确拒绝多副本 |
| 用 `DELETE` + `INSERT` 刷新 | 并发授权会读到空窗 |
| 用 `now()` 比较做并发控制 | 时钟回拨会让旧数据覆盖新数据 |
| 把 `ca` 保留为「追加信任锚」的实现 | 与 Node 语义不符；要么改名，要么自己拼 `tls.getCACertificates()`，后者引入平台差异 |
| 现在就声明 `client_id_metadata_document_supported` | 会让依赖它的客户端去调用一个还不存在的注册能力 |

---

## 5. C3c-3B 施工顺序

见设计 §12（10 步，按依赖排序）。关键闸门：

```
1 配置收口 (env.outboundProxy, createCimdDeps 去默认参数)
2 TLS 语义 (ca → caOverride)
3 迁移 0004（CHECK 扩 revoked_reason）
4 cimd-registry（形态/缓存/抓取/注册/CAS）
5 revokeMcpSessionsByClient
6 authorize-flow 接入
7 路由 HTML 错误页 + 审计
8 token 端点错误映射
9 测试矩阵 22 条
10 声明 client_id_metadata_document_supported（最后）
```

---

## 6. 完整验收矩阵

见设计 §13（22 条 + 3 条补充）。每条都写明：输入、HTTP 结果、DB 变化、
Session/Refresh/Grant 影响、审计事件、是否允许重试。**3B 的完成定义就是这 22 条
全部有对应测试。**

---

## 7. 本阶段的代码改动（仅注释）

| 文件 | 改动 | 性质 |
|---|---|---|
| `cloud/src/mcp-oauth/cimd.ts` | 文件头版本说明：`2025 年版本` → `发布日期 2026-11-02，有效期至 2027-05-06，不是 RFC` | 注释（任务书明确要求） |
| `cloud/src/net/proxy-fetch.ts` | `ca` 的 JSDoc：删掉「等同 `NODE_EXTRA_CA_CERTS`」的错误类比，改为「**完全替换**默认信任链，仅测试注入」，并标注 3B 会改名为 `caOverride` | 注释（修正与 Node 文档不符的描述） |

**没有**逻辑改动、没有测试改动、没有迁移、没有依赖变更：

```
git diff --stat   →  两个文件，行数仅注释
git status cloud/src/db/migrations cloud/package.json cloud/pnpm-lock.yaml → 空
```

验证：`pnpm typecheck` / `pnpm lint` 通过（注释不改变类型与 lint 结果）。

---

## 8. 仍未解决的问题

| # | 问题 | 需要谁拍板 |
|---|---|---|
| 1 | `client_id_mismatch` 是否也要撤销 Grant（当前：不撤销） | 复审 |
| 2 | 迁移 0004（扩 `revoked_reason` CHECK）是否接受；不接受则退化为「复用 `client_revoke` + 审计 detail」 | 复审 |
| 3 | 生产是否允许隐式继承宿主机 `HTTPS_PROXY`（当前：允许，但要在启动日志里记录一次） | 复审 |
| 4 | `no-store` 拒绝会不会挡住真实客户端（需真实联调确认） | 1.3.3 |
| 5 | 已签发 Access Token 在 Session 撤销后仍有效（≤15 分钟） | 1.3.2 `/mcp` 补 `sid` 回查 |

---

## 9. 结论

- 规范对齐：已实现部分**没有**违反 MUST 的地方；差距都在接入层，已逐条列为 3B 任务。
- 设计完整性：注册来源、缓存状态机、失败矩阵、撤销语义、`no-store`、并发、
  配置、TLS 信任都有**单一确定答案**，没有留下「到时候再说」的分支。
- 契约可执行性：3B 的 10 个步骤与 22 条验收用例可以直接照做，不需要再设计。
- 范围合规：未改 authorize / token / revoke 行为，未接抓取器，未声明能力，
  未加迁移与依赖，未动 Desktop。

**建议：允许开始 C3c-3B。** 条件是两个未决项先拍板（§8-1 与 §8-2），因为它们
决定 3B 第 3、5 步的写法。
