# BrewPhase Phase 1.3.1-C3c-2-R2 — CIMD Fetcher 独立安全复审

> 日期：2026-11-19 · 分支：`feature/remote-mcp`
> 审查基线：`92148bf`（R1 终态）
> 参照基线：`139731f`（C3c-2 交付点）
> 性质：**独立复审**。上一轮的实施报告与自审报告只作线索，结论全部由本轮重新读源码、
> 构造攻击场景、跑测试与变异得出。
> 范围：`cloud/src/mcp-oauth/cimd.ts`、`cloud/src/net/proxy-fetch.ts` 及其测试。
> **不接入 authorize，不做 DCR，不新增对外能力。**

---

## 1. 实际 HEAD 与基线

| 项 | 值 | 核对方式 |
|---|---|---|
| 分支 | `feature/remote-mcp` | `git branch --show-current` |
| 工作区 | 干净（无临时变异脚本、无残留测试凭证） | `git status --porcelain -uall` |
| 本地 HEAD | `92148bf` | `git log -1` |
| 远程 HEAD | `92148bf` | `git ls-remote`（固定 IP，不走系统代理） |

### 1.1 `139731f..92148bf` 的实际差异

```
 cloud/src/mcp-oauth/cimd.ts                        |  95 ++++++-
 cloud/src/net/proxy-fetch.ts                       | 251 +++++++++++---
 cloud/tests/mcp-oauth/cimd.test.ts                 | 172 ++++++++++-
 cloud/tests/net/pinned-request.test.ts             | 163 +++++++++++
 cloud/tests/net/proxy-fetch.test.ts                | 205 ++++++++++++
 cloud/tests/fixtures/{README.md,*.pem}             |  67 +++++
 cloud/docs/{implementation,reviews}/…-r1-*.md      | 366 +++++++++++++++
 Desktop/docs/*（3 份）+ memory                      |  55 ++
```

代码部分只有两个文件，与 R1 报告一致，没有夹带无关改动。

### 1.2 R1 报告里的过期表述（已修）

R1 报告第 1 节写「远程 HEAD `139731f`」。那只描述**开工时**的事实，R1 交付后远程
HEAD 已是 `92148bf`。已在报告里补一张提交链表（C3c-2 起始基线 / R1 代码提交 /
R1 文档提交 / R2 审查基线），避免后续复审按错误基线比对。

---

## 2. 审查方法

1. 通读两个源文件与三个测试文件，逐条对照 R2 任务书的判据。
2. 对可疑点先写**探针脚本**验证真实行为（不靠推理下结论），探针用完即删。
3. 只对已验证的缺陷动手；每个修复都配一条在修复前会失败的测试。
4. 用 12 条定向变异反向验证测试的有效性（§6）。

本轮特意避免的两个假信号：

- **暂停的 socket 不会感知 FIN**。第一版探针在服务端 socket 上等 `'close'`，得到
  「超时后连接仍开着」的结论；`resume()` 之后同一段代码立刻显示 `destroyed: true`。
  只有读走的 socket 才能观察到对端关闭。
- **`Readable.from` 读完会自动 destroy**。仅凭 `stream.destroyed` 无法区分「我们主动
  停读」与「它自己读完了」——这正是 R1 的 M5 变异漏网的原因。

---

## 3. 独立发现的问题

### R2-F1 · 总预算耗尽时，建连中的代理 socket 不会被销毁

**严重性：Medium**（资源泄漏 / 连接悬挂；不构成 SSRF 绕过）

**攻击前提**：能触达 CIMD 抓取的调用方（接入 authorize 后即任何能提供 `client_id`
的人），且部署配了代理、代理在建连或 CONNECT 阶段卡住。

**现象（探针实测）**：黑洞代理（接受 TCP、永不回应 CONNECT）+ `totalTimeoutMs=200`
+ `connectTimeoutMs=5000` 时，请求按预期以 `pinned request timed out (total)` 失败，
但 500ms 后代理侧仍有 1 条 ESTABLISHED 连接（`server.getConnections() === 1`）。

**根因**：`requestPinnedHttps` 的总定时器只 `request.destroy()`。而在
`createConnection` 里 `openTunnel()` 尚未返回 socket 时，这条 socket 不属于任何
`ClientRequest`；`connectToProxy` 的成功路径又会移除 abort 监听，于是
「TCP 已连上、正在等 CONNECT 200」这个窗口无人负责。

**修复**：把 `AbortSignal` 贯穿到 `openTunnel` 的**整个建隧道窗口**（连接 + CONNECT），
定时器触发时先 `controller.abort()` 再 `finish()`。`connectToProxy` 与 `openTunnel`
都改为单次 settle，避免 error/close/abort 重复 reject 或重复销毁。

**测试证据**：`总超时会销毁仍在建连的代理 socket`——修复前 `getConnections() === 1`，
修复后 `0` 且服务端 socket `destroyed === true`。

---

### R2-F2 · JWK 私钥成员漏检 `oth`

**严重性：Medium**（草案 §4.1「private key material MUST NOT be included」的绕过口）

**攻击前提**：恶意 CIMD 文档携带多质数 RSA 私钥。

**根因**：`PRIVATE_JWK_MEMBERS` 是 `d, p, q, dp, dq, qi, k`，漏了 RFC 7518 §6.2.2
里的 `oth`（`"oth"` 是 other primes info 数组）。带 `oth` 的私钥会被判定为「公钥」。

**修复**：加入 `oth`，并把测试改成逐个成员覆盖（8 个），不再只测 `d`。

**测试证据**：`每个 JWK 私钥成员都被拒绝（RFC 7518 §6.2.2 含 oth）`。变异 M8 删除
`oth` 后该用例转红。

---

### R2-F3 · `client_uri` / `logo_uri` 没有任何形态校验

**严重性：Medium**（存储侧污染；接入同意页后是 XSS / 协议滥用面）

**攻击前提**：恶意 CIMD 文档提供 `client_uri: "javascript:..."` 或超长 URL，
后续任何把它渲染成 `<a href>` / `<img src>` 的代码都会中招。

**根因**：`if (typeof doc.client_uri === "string") metadata.clientUri = doc.client_uri;`
——只判类型。草案不限制这两个字段的 scheme，但项目会在同意页渲染它们。

**修复**：新增 `validateInformationalUri()`：https、无 userinfo、绝对 URL、
≤2048 字节；校验失败按**文档非法**处理（fail-closed），而不是静默丢弃——丢弃会让
被篡改的文档看起来仍然正常。

**测试证据**：`client_uri / logo_uri 必须是 https、无 userinfo、有长度上限`
（5 个反例）+ `合法的 client_uri / logo_uri 被保留`。

**规范归属**：这是 **BrewPhase 自己的安全策略**，不是 RFC / 草案要求。

---

### R2-F4 · RFC 6890 特殊用途地址表缺 4 段

**严重性：Low**（这 4 段不是私有网段，落在它们上面的服务极少；但草案 §10.7 是
「MUST NOT fetch … special-use IP addresses」）

**根因**：地址表按印象列举，漏了 AS112 与 AMT 的分配段。

**修复**：补 `192.31.196.0/24`（AS112-v4）、`192.52.193.0/24`（AMT）、
`192.175.48.0/24`（AS112 direct delegation）、`2620:4f:8000::/48`（AS112-v6）。

**测试证据**：地址分类表各加一条（含「解析到该地址时拒绝整个目标」）。

> 复查结论：其余 IPv4/IPv6 段与 IANA 登记一致；`2001::/23` 覆盖了 `2001:1::1`、
> `2001:3::/32`、`2001:4:112::/48`、`2001:20::/28`、`2001:30::/28` 等零散分配。

---

### R2-F5 · `sendConnect` 隐式使用 `http.globalAgent`

**严重性：Low**（理论上的连接串扰；需要进程内恰好存在同名的空闲 keep-alive 连接）

**根因**：`http.request({ method: "CONNECT", path, headers })` 没有指定 agent，
Node 会走 `http.globalAgent`，而池名来自 options 的 host/port（此时是默认的
`localhost:80`）。若池里正好有同名的空闲 socket，`addRequest` 会**复用它**，
CONNECT 就写到了一条无关连接上。

**修复**：每次隧道建一条专用 `http.Agent({ keepAlive: false })`，并把它实例上的
`createConnection` 指向手里这条 socket；失败时 `agent.destroy()`。

**测试证据**：所有 CONNECT 用例（HTTP / HTTPS 代理、IPv6 authority、凭据隔离、
端到端全链路）在修复后仍通过——证明换 agent 没有破坏协议行为。

---

### R2-F6 · `deps.resolve` 同步抛错会逃出「永不 throw」契约

**严重性：Low**（默认实现是 async，只有注入实现才可能触发；属于契约健壮性）

**修复**：把 `deps.resolve(...)` 的**调用**也包进 try/catch，同步抛错映射为
`transient/dns_failure`。

**测试证据**：`resolver 同步抛错也不会让抓取器抛出`。

---

### R2-F7 · `client_id` / `client_name` 没有长度上限

**严重性：Low**（配合 5 KiB body 上限，最坏情况是一个 5 KiB 的展示名进同意页）

**修复**：`client_id` ≤ 2048、`client_name` ≤ 256（**项目策略**，草案无长度要求）。

**测试证据**：`client_name 与 client_id 有长度上限`。

---

### R2-F8 · 目标侧 TLS 缺少端到端证明（R1 自认未证明）

**严重性：Informational（验证缺口，不是缺陷）**

R1 报告写明「目标侧 TLS 握手仍只有代码审查」。本轮补上：给 `PinnedRequestOptions`
增加**只增信任锚**的 `ca`（没有 `rejectUnauthorized`，没有关闭校验的入口），
并用本地 TLS 服务器做端到端验证。

**测试证据**（新增 5 条）：

| 用例 | 证明了什么 |
|---|---|
| 直连 pinned IP | 连接打到 `127.0.0.1`，但 SNI 与 Host 都是 `localhost`；证书按域名验证通过 |
| 目标证书不受信任 | 同一连接不传 `ca` 时以 `DEPTH_ZERO_SELF_SIGNED_CERT` 失败 |
| HTTPS 代理全链路 | 代理收到 `CONNECT 127.0.0.1:<port>`（pinned IP），隧道内 SNI/Host 仍是 `localhost`，响应 200 |
| 代理证书不受信任 | 握手阶段失败，代理侧 `seen === []`（CONNECT 一个字节都没发） |
| 各阶段超时 | CONNECT 超时、代理 TCP 超时、慢速响应体总超时 |

---

## 4. 逐项复核结论（未发现问题的部分）

| 判据 | 结论 | 依据 |
|---|---|---|
| 直连路径的 `lookup` 真的钉住了 IP | ✅ | 探针：`client.example.com` 不解析，仍连到 `127.0.0.1` 并因证书失败（而非 `ENOTFOUND`） |
| `agent: false` 下 `lookup` 仍生效 | ✅ | 同上（这是 pinning 成立的前提） |
| HTTPS 代理先 TLS 后 CONNECT | ✅ | 明文连接会在握手阶段失败；`seen` 为空 |
| 代理凭据只发给代理 | ✅ | 目标侧只收到 `ping` |
| CONNECT 目标是 pinned IP | ✅ | 代理侧 `seen === ["127.0.0.1:<port>"]` |
| IPv6 authority 带方括号 | ✅ | `[::1]:443`，已带方括号不重复加 |
| 隧道内 TLS 用原始域名 | ✅ | 服务端观察到 `servername === "localhost"`、`host === "localhost:<port>"` |
| 失败不退回直连 | ✅ | 代理 502 → 目标服务器 `connections === 0` |
| 重定向不跟随 | ✅ | 3xx 只调用一次 transport，hostname 未变 |
| 5 KiB 流式上限 | ✅ | 5120/5121/分块/无 CL/低报 CL/byteLength/停读 |
| 缓存语义 | ✅ | `no-store` / `no-cache` / `s-maxage` > `max-age` / 24h 上限 / 默认 1h / 不缓存错误 |
| 状态分类 | ✅ | 408/425/429/5xx = transient，3xx/其它 4xx = terminal |
| DNS 全量校验 + 任一特殊即拒 | ✅ | 30+ 条地址用例 + 混合公网/私网 |
| IP 字面量走同一套分类 | ✅ | `resolveCimdHost` 对字面量直接返回，分类逻辑共用 |

---

## 5. 没有修的（记录在案）

| 项 | 说明 | 为什么不修 |
|---|---|---|
| 代理主机名的 DNS 挂起 | `net.connect({host})` 的解析由 Node 内部完成，没有注入点 | 要修得给 `proxy-fetch` 加 resolver 注入，属于接口改造；当前由总定时器 + abort 兜底（调用方按时返回、socket 被销毁），**但底层 `getaddrinfo` 线程要等它自己返回** |
| 目标侧 TLS 握手阶段的独立截止 | 目前只有总预算约束 | 再加一个阶段定时器收益很小，且会与总预算产生两套时间语义 |
| DNS 查询本身不可取消 | `dns.resolve4/6` 无 abort 参数 | Node 未提供；已在报告明确区分「调用方超时返回」与「后台查询终止」 |

**关于 `setTimeout` 的能力边界**：它约束的是事件循环还能跑多久。如果进程被同步
长任务（或 GC 停顿）阻塞，定时器会推迟——**不构成硬实时保证**。本模块的所有
超时都只是「不会无限等」，不是「一定在 N 毫秒内返回」。

---

## 6. 独立变异测试（12/12 被抓）

每条变异都真实执行、跑完即还原（脚本 `finally` 回写原文），仓库里没有残留。

| # | 变异内容 | 被哪条测试捕获 | 结果 |
|---|---|---|---|
| M1 | 移除 DNS 截止时间（改回 `await settled`） | `DNS 永不返回…`、`DNS 超时后迟到 resolve`、`DNS 超时后迟到 reject` | 3 红 |
| M2 | 代理 TCP 连接超时失效 | `代理 TCP 连接超时：不可达地址按连接超时结束` | 1 红 |
| M3 | HTTPS 代理改用明文连接 | `先与代理完成 TLS 握手…`、`HTTPS 代理 + pinned IP CONNECT + 原始域名 TLS 全链路`、`自签名证书默认被拒绝`、`代理证书不受信任…` | 4 红 |
| M4 | 目标 TLS 证书校验关闭 | `目标证书不受信任时拒绝` | 1 红 |
| M5 | SNI 替换成 pinned IP | `直连 pinned IP：SNI 与 Host 用原始域名…` | 1 红 |
| M6 | 移除 IPv6 全球单播白名单 | `4000::1 … f000::1` 共 14 条 | 14 红 |
| M7 | IPv4 私有段（`10/8`）漏判 | `10.1.2.3` 分类、`解析到 10.1.2.3 时拒绝`、`混合公网与私网` | 3 红 |
| M8 | JWK 私钥字段漏检（去掉 `oth`） | `每个 JWK 私钥成员都被拒绝` | 1 红 |
| M9 | 503 判成 terminal | `500/501/502/503/504/599 是 transient`、`503 不再被当成…` | 7 红 |
| M10 | 429 判成 terminal | `429 是 transient` | 1 红 |
| M11 | 移除 5 KiB 超限即时 destroy | `超限后立即停止消费：不再向数据源请求更多字节` | 1 红 |
| M12 | 总超时不清理在建连的 socket | `总超时会销毁仍在建连的代理 socket` | 1 红 |

**没有未被捕获的变异。** M1 用 `--testTimeout=4000` 把「永不返回」压缩成测试超时，
否则单条要等默认 30s。

---

## 7. 门禁（本轮实际执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过（0 error / 0 warning） |
| `pnpm build` | 通过 |
| `pnpm test` | **1355 passed / 65 files**（R2 基线 1333，+22） |

分文件：`cimd.test.ts` 197（+14）、`proxy-fetch.test.ts` 28（+8）、
`pinned-request.test.ts` 28（不变）。

Desktop 回归：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` / `test` / `build` / `mcp:build` | 通过；**1265 passed / 89 files**；`stdio.mjs` 911.67 kB 不变 |

**环境事件**：本轮开始时测试 PostgreSQL 容器未运行（Docker 守护进程退出），
`pnpm test` 直接报 `ECONNREFUSED 127.0.0.1:54329`。启动容器后重跑，上述数字为
容器就绪后的真实结果。

---

## 8. 范围与合规

- 未接入 `/mcp/oauth/authorize`；未改 DCR；未声明 `client_id_metadata_document_supported`；
  未新增 `registration_endpoint`。
- 无新增数据库迁移（`cloud/src/db/migrations` 未变）；无新增依赖
  （`package.json` / `pnpm-lock.yaml` 未变）。
- 未修改 Session / Grant 生命周期；未改 Desktop 生产代码。
- 未删除测试、未放宽既有断言。唯一改动的既有断言是 R1 遗留的
  「`503` 属于 terminal」样本——它在 R1 就被替换成 `404`，R2 未再动。
- 未关闭 TLS 校验、未绕过 pinned IP、未改 443 限制。

**新增的 `ca` 参数**：只增加信任锚（语义等同 `NODE_EXTRA_CA_CERTS`），没有
`rejectUnauthorized`，也没有任何关闭校验的入口。它是本轮为「目标侧 TLS 端到端
证明」引入的唯一接口变更，需要复审确认是否接受；若不接受，HTTPS 目标的正向路径
将失去自动化覆盖。

---

## 9. 未解决风险

1. **代理主机名 DNS 挂起**只能给出行为级证明（调用方按时返回、socket 被销毁），
   底层查询何时真正结束不可观测。
2. **目标侧 TLS 的正向路径依赖 `ca` 注入**。生产部署若要连私有 CA 的目标，需要
   同样的入口——目前只有测试在用。
3. **真实客户端（ChatGPT / Grok）仍未联调**，CIMD 文档的真实形态（字段组合、
   缓存头）没有样本验证。
4. **CIMD 尚未接入 authorize**，因此「失败如何影响已有缓存 / refresh token」只有
   分类，没有落地策略。

---

## 10. 结论：是否允许进入 C3c-3

**允许，附两个条件。**

满足项：无未解决的 Critical / High（本轮 3 个 Medium 已修并有测试与变异证据）；
DNS Pinning 与 TLS 身份绑定有端到端证明；连接各阶段的超时与清理有独立用例；
IP 分类有 RFC 6890 + IANA 2000::/3 依据；CIMD 字段无已知绕过；缓存与失败分类正确；
5 KiB 有真实流式证据；全量测试通过；未扩大对外能力。

条件：

1. 复审需明确接受 `PinnedRequestOptions.ca`（或给出替代的测试注入方案）。
2. C3c-3 若开始接入 authorize，必须先定义「transient / terminal 对已有缓存与
   refresh token 的作用」，且该策略要单独有测试——本轮只交付分类，不交付处置。
