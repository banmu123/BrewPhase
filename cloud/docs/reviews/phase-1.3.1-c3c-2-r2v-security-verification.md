# BrewPhase Phase 1.3.1-C3c-2-R2v — R2 成果独立复核验证

> 日期：2026-11-19 · 分支：`feature/remote-mcp`
> 性质：**对 C3c-2-R2 已提交成果的独立复核验证（verification）**。任务书下发时指定的
> 「当前远程 HEAD `92148bf`」已过期——R2 在任务书撰写之后、下发之前已被执行并提交
> （`326dcf1` 修复 + `502cbe7` 文档）。本轮不信任 R2 报告结论，重新通读源码、重建
> 全部变异、重跑门禁，逐条验证其声称是否真实成立。
> 范围：`cloud/src/net/proxy-fetch.ts`、`cloud/src/mcp-oauth/cimd.ts` 及其测试。
> **不接入 authorize，不做 DCR，不新增对外能力。**

---

## 1. 实际 HEAD 与提交链

| 项 | SHA | 说明 |
|---|---|---|
| C3c-2 起始基线 | `139731f` | strict CIMD fetcher 文档点 |
| R1 代码提交 | `cb2e68c` | harden CIMD fetcher network and failure boundaries |
| R1 最终文档提交 | `92148bf` | 任务书误将其记录为「当前远程 HEAD」 |
| R2 修复提交 | `326dcf1` | close CIMD fetcher residual security gaps（F1–F8） |
| R2 文档提交 | `502cbe7` | record CIMD fetcher security review |
| **本轮审查基线** | **`502cbe7`** | 工作区干净，无临时变异/凭证残留（`git status --porcelain -uall` 已核） |

`139731f..502cbe7` 差异：源码仅 `cimd.ts`（+154）与 `proxy-fetch.ts`（+329），
测试三文件 + fixtures（测试用自签名证书，`fixtures/README.md` 已说明），无夹带改动。

---

## 2. 复核方法与 R2 声称的核对

本轮独立重做了三类工作，不采信 R2 报告中的任何结论：

1. **逐行重读**两个源文件与三个测试文件，对照任务书 R2-1…R2-6 全部判据。
2. **探针实证**可疑点（探针用完即删，仓库无残留）。
3. **重建全部变异**（任务书 12 条按直连/代理两条路径拆分为 15 条），逐一真实执行并还原。

### 2.1 R2 报告声称核对结果

| R2 声称 | 复核结论 |
|---|---|
| F1–F8 修复存在且有测试 | ✅ 全部核实（`oth`、`validateInformationalUri`、4 段地址、专用 agent、resolver 兜底、长度上限、`ca` 信任锚、F1 abort 贯穿建隧道窗口） |
| 「各阶段超时」「端到端 TLS」测试真实 | ✅ 核实（本轮探针与变异重放均通过） |
| 变异 12/12 被抓 | ⚠️ **有条件成立，见 §3 F10**——在配了代理环境变量的机器上，M4（目标证书校验关闭）与 M5（SNI 替换）实际逃逸；根因是测试隔离缺陷，不是断言弱 |
| 门禁 1355/65 files、Desktop 1265/89 | ✅ 与本轮实测一致（本轮 Cloud 1357 = 1355 + 本轮新增 2 条） |

### 2.2 未发现问题的部分（本轮实际审查范围）

逐行核对并确认，不笼统声明整体安全：

- **CONNECT 路径**：CONNECT 始终用 pinned IP（`authorityHost`）；代理拒绝（非 200）必定失败且不退直连（变异 M3、探针均验证）。
- **代理凭据隔离**：`Proxy-Authorization` 只出现在 CONNECT 头，隧道内目标仅收到业务字节（测试实证）。
- **IPv6 authority**：`connectAuthority` 方括号规则正确，重复括号不产生（测试实证）。
- **HTTPS 代理 TLS 先行**：先握手后 CONNECT；代理证书不受信任时 CONNECT 一个字节都发不出去（测试实证）。
- **DNS Pinning**：`pinnedLookup` 支持 `autoSelectFamily` 的两种回调形态；解析一次、连接只用校验过的地址（cimd 测试 `DNS Rebinding` 实证 resolver 只调一次）。
- **IP 分类**：IPv4 表与 IANA 特殊用途登记逐段核对一致（含本轮 R2 补的 4 段）；IPv6 以 `2000::/3` 白名单 + 特殊段排除 + mapped 独立表；`net.isIP` 不识别的形态 fail-closed。
- **CIMD 字段**：RFC 7518 私钥成员枚举完整（`d p q dp dq qi oth k`）；`jwks`/`jwks_uri` 互斥；`client_id` 逐字符比较；URL 形态校验在原始字符串上做（点段/编码点段/空 userinfo 全部拒绝）。
- **缓存语义**：`no-store`/`no-cache`/`s-maxage`>`max-age`/24h 上限/默认 1h/失败不产生可缓存结构——逐条与实现一致。
- **5 KiB**：预检 + 流式累计双保险；超限返回空 body；`destroyedEarly` 用按需生产源区分「主动停读」与「读完了」（无假阳性）。
- **withDeadline**：无 unhandled rejection（迟到 reject 测试实证）；DNS 超时不触发额外请求。

---

## 3. 本轮独立发现（R2 未覆盖）

### F9 · 代理路径上「目标 TLS 握手窗口」总超时后 socket 泄漏

**严重性：Medium**（资源泄漏 / 连接悬挂；不构成 SSRF 或 TLS 绕过）

**攻击前提**：部署配了代理；代理（或劫持代理的攻击者）让 CONNECT 返回 200，
但对隧道内目标 TLS 握手不回应（吞掉 ClientHello）。每个 CIMD 抓取请求泄漏一条
已建立的 TCP 连接 + TLSSocket，直到对端回应或内核 TCP 超时（分钟级）。反复请求
可耗尽文件描述符。

**探针实测**（修复前）：`totalTimeoutMs=300`（黑洞 TLS 目标 + 透传代理），
请求按预期 `pinned request timed out (total)` 失败，但 500ms 后黑洞目标侧
`getConnections() === 1` 且 socket `ALIVE`。

**根因**：R2-F1 的修复把 abort 覆盖到 `openTunnel` **内部**（连接 + CONNECT），
`finally` 里移除监听。但 `openTunnel` 返回后、`createConnection` 的
`tls.connect` 完成前，socket 处于三不管状态：不属于 request（callback 未回调）、
abort 监听已移除、`request.destroy()` 管不到它。总预算在这个窗口耗尽时无人收尸。

**修复**（`proxy-fetch.ts` +18/−2）：abort 监听延伸到 TLS 握手窗口——
`onAbort` 销毁 `secure` 与底层 socket 并 settle；`settle` 移除监听、单次回调；
`controller.signal.aborted` 预检兜底；`handshaking` 标志防止 error/secureConnect/
abort 三方竞态重复回调。

**测试证据**：`总超时会销毁仍在 TLS 握手中的代理隧道（目标侧吞掉 ClientHello 也不泄漏）`
——修复前 `getConnections() === 1`（探针），修复后 `0` 且两侧 socket 全部 `destroyed`。

### F10 · 直连测试未隔离代理环境变量，直连分支在配代理的机器上从未被测到

**严重性：Medium**（测试有效性缺陷；导致 M4a/M5a 变异逃逸，生产代码无缺陷）

**发现过程**：第一轮变异执行 M4a（直连 `rejectUnauthorized: true→false`）与
M5a（直连 `servername: url.hostname→pinnedAddress`）均 **GREEN 逃逸**——与
R2 报告「M4/M5 被抓」矛盾。逐层诊断（monkey-patch `tls.connect`）发现：测试进程
的 `process.env` 含 `HTTPS_PROXY=http://127.0.0.1:53599`（本机系统代理），
`requestPinnedHttps` 的 `env` 缺省 `process.env`，于是所有未显式传 `env` 的
「直连」用例实际全部经**系统代理**执行：直连分支（`rejectUnauthorized`、
`pinnedLookup`、直连 `servername`）从未运行，变异自然抓不到。探针输出
`tls.connect calls: [{ socket, servername: 'localhost', ... }]`（代理隧道形态）
是决定性证据。

**根因**：`proxy-fetch.test.ts` 中 3 条直连用例（SNI/Host、目标证书拒绝、慢速
响应体）依赖 `env` 缺省值。测试语义随执行机器的环境变量漂移——在无代理变量的
机器上有效，在配了代理的机器上静默失效。R2 变异「12/12 被抓」只在无代理环境下
成立。

**修复**：3 条直连用例显式传 `env: {}`，并加注释说明。走代理的 7 条用例本就
显式传 `env: { HTTPS_PROXY: ... }`，不受影响。

**测试证据**：修复后重放 M4a / M5a 均 **RED**（第一轮 13/15 → 第二轮 15/15）。

### F11 · 「代理路径上目标 TLS 证书校验」无测试覆盖（覆盖缺口，非缺陷）

**严重性：Low**（验证缺口）

R2 的「目标证书不受信任时拒绝」只走直连路径；代理路径上隧道内 TLS 的校验
被关闭/丢弃（R2-F8 曾真实修过一例）没有任何测试能抓到。利用测试证书 SAN 同时含
`DNS:localhost` 与 `IP:127.0.0.1` 的特性构造分离场景：代理跳按 IP 直连
（不发 SNI，按 IP SAN 通过），目标跳按域名（`other.example.com`）校验必须失败。

**修复**：新增测试
`HTTPS 代理路径上，隧道内目标证书校验独立生效（altname 不匹配也拒绝）`。
**测试证据**：变异 M4b（隧道内 `tls.connect` 加 `rejectUnauthorized: false`）被
该用例捕获（RED）；生产代码行为正确（该用例对 HEAD 源码为绿）。

---

## 4. 独立变异测试（两轮）

每条变异真实执行、跑完立即还原，最后 `git diff` 校验源码还原完整性（仅剩 F9
修复 +18/−2）。第一轮暴露 F10，修复后第二轮全部抓获：

| # | 变异 | 第一轮 | 第二轮（F10 修复后） |
|---|---|---|---|
| M1 | DNS 截止移除（预算改 1h） | RED | RED（`DNS` 系用例） |
| M2 | 代理 TCP 连接超时失效 | RED | RED |
| M3 | HTTPS 代理改明文 | RED | RED |
| M4a | 直连目标 TLS 校验关闭 | **GREEN（逃逸）** | **RED**（「目标证书不受信任时拒绝」） |
| M4b | 代理路径目标 TLS 校验关闭 | RED | RED（F11 新用例） |
| M5a | 直连 SNI 替换成 pinned IP | **GREEN（逃逸）** | **RED**（「直连 pinned IP」） |
| M5b | 代理路径 SNI 替换 | RED | RED |
| M6 | IPv6 全球单播白名单移除 | RED | RED（14 条地址） |
| M7 | IPv4 10/8 漏判 | RED | RED |
| M8 | JWK 漏 `oth` | RED | RED |
| M9 | 5xx 改 terminal | RED | RED |
| M10 | 429 改 terminal | RED | RED |
| M11 | 5 KiB 主动 destroy 移除 | RED | RED（按需源 `_read` 计数） |
| M12 | 建隧道窗口 abort 移除（F1 回退） | RED | RED |
| M13 | TLS 握手窗口 abort 移除（F9 回退） | RED | RED（F9 新用例） |

**最终 15/15 被抓，无未捕获变异。** 全部变异、runner 与诊断脚本已删除，
仓库无残留。

---

## 5. 门禁（本轮实际执行）

环境修复：本机 `cloud/node_modules` 与 lockfile 不同步（缺 `ws`、tsx esbuild
二进制不匹配），`pnpm install --frozen-lockfile` 后重跑。此问题在 HEAD 状态
（无本轮改动）即存在，与本轮无关。

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过（0 error / 0 warning） |
| `pnpm build` | 通过 |
| `pnpm test` | **1357 passed / 65 files**（R2 基线 1355，+2：F9 用例、F11 用例） |

重点文件：`proxy-fetch.test.ts` 31（+3）、`cimd.test.ts` 197（不变）、
`pinned-request.test.ts` 28（不变）。

Desktop 回归（本轮未改 Desktop 任何代码）：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | 通过，**89 test files 全部 passed**（两次独立执行均 exit 0；与 R2 基线一致的 89 files / 1265 tests，本轮未动） |
| `pnpm build` | 通过 |
| `pnpm mcp:build` | 通过，`stdio.mjs` 911.67 kB 不变 |

环境事件：vitest 启动清理旧缓存目录（120 文件）被本机 safe-delete 保护拦截一次，
手动清理残留 `.vitest-cache.tmp-*` 后重跑通过；测试 PostgreSQL 容器
`brewphase-cloud-test-pg` 全程在线。

---

## 6. 范围与合规

- 未接入 `/mcp/oauth/authorize`；未改 DCR；未声明
  `client_id_metadata_document_supported`；未新增 `registration_endpoint`。
- 无新增数据库迁移、无新增依赖（`package.json` / `pnpm-lock.yaml` 未变）。
- 未修改 Session / Grant 生命周期；未改 Desktop 生产代码。
- 未删除测试、未放宽既有断言；对 R1 遗留的 `503` 断言未再触碰。
- 未关闭 TLS 证书验证、未绕过 pinned IP、未放宽 SSRF 白名单、未改 443 限制。
- 生产代码改动仅 `proxy-fetch.ts`（+18/−2，F9）；测试改动为 F9/F11 两条新用例
  与 F10 的 3 处 `env: {}`。

---

## 7. 未解决风险

1. **代理主机名 DNS 挂起**：`net.connect` 的解析不可注入、`dns.resolve*` 不可
   取消——调用方按时返回、socket 被销毁（行为级保证），底层 getaddrinfo 线程
   何时结束不可观测。与 R2 结论一致。
2. **`PinnedRequestOptions.ca`**：只增信任锚的注入口（语义等同
   `NODE_EXTRA_CA_CERTS`），目前只有测试在用；若不接受该入口，HTTPS 目标的
   正向路径将失去自动化覆盖（R2 遗留待决项，维持）。
3. **测试环境对 `process.env` 的普遍依赖**：本轮修复了 `requestPinnedHttps`
   相关 10 处；`createCimdDeps(env)` 的其它消费方（生产入口）未逐一审计环境
   隔离，建议接入 authorize 前（C3c-3）做一次环境变量来源盘点。
4. 真实客户端（ChatGPT / Grok）联调与 authorize 接入后的 transient/terminal
   缓存处置策略仍缺（R2 遗留）。

---

## 8. 结论：是否允许进入 C3c-3

**允许。** 理由：

- 无未解决的 Critical / High。本轮两个 Medium（F9 泄漏、F10 测试隔离）均已
  修复并有「修复前红 / 修复后绿」证据；F11 覆盖缺口已补。
- DNS Pinning 与 TLS 身份绑定在直连与代理两条路径上均有可验证证明
  （15/15 变异被抓）。
- 连接全生命周期（TCP → 代理 TLS → CONNECT → 目标 TLS → 读体）的超时与
  清理现在每个窗口都有独立用例。
- 全量门禁通过；未扩大对外能力。

**停在 C3c-2-R2v，不实现 C3c-3。** C3c-3 开始前需先落实 §7-3 的环境变量盘点
与 §7-2 的 `ca` 入口决策。
