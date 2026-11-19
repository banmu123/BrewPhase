# BrewPhase Phase 1.3.1-C3c-2-R1 — CIMD Fetcher 安全自审

> 日期：2026-11-19 · 分支：`feature/remote-mcp` · 基线 `139731f`
> **这是实现方的自审记录，不是独立复审结论。** 目的是把「每条安全边界现在由什么保证、
> 由哪条测试证明、还有哪里没证明」摆出来，供下一轮复审逐条核对。
> 实施细节见 `docs/implementation/phase-1.3.1-c3c-2-r1-cimd-hardening-report.md`。

---

## 1. 威胁模型（本轮覆盖的部分）

`client_id` 由对端提供，抓取器会用服务器身份主动出网。因此攻击者能控制：

- URL 的形态（路径、端口、编码、userinfo、反斜杠）；
- 目标域名解析出的地址（DNS Rebinding）；
- 响应的状态码、Content-Type、大小、节奏（慢速/分块）；
- 响应体的 JSON 内容。

攻击者**不能**控制：进程环境变量、代理配置、代码路径。

---

## 2. 安全边界 → 保证方式 → 证明

| # | 边界 | 现在由什么保证 | 由哪条测试证明 |
|---|---|---|---|
| 1 | 只允许 `https`、无 userinfo、非根路径、无点段（含 `%2e%2e`）、无 fragment、无 query、端口只 443、无反斜杠 | `validateClientIdentifierUrl()` 在**原始字符串**上判断 | `cimd.test.ts` 的 `Client Identifier URL` 14 条 |
| 2 | `client_id` 逐字符比较，不规范化 | `doc.client_id !== clientId` | `:443` 与不带端口不相等 |
| 3 | 所有 A/AAAA 结果都必须公网 | 全量遍历 + 任一不合格即拒绝整个目标 | 30 条地址拒绝 + 混合公网/私网 |
| 4 | IPv6 必须在 `2000::/3` | `GLOBAL_UNICAST_V6` 白名单 | 7 段越界地址 × 2 |
| 5 | IPv4-mapped 一律拒绝 | 独立 BlockList（不污染 IPv4 判定） | `::ffff:127.0.0.1` / `::ffff:10.1.2.3` |
| 6 | 连接只用校验过的 IP，不做第二次解析 | `pinnedLookup` + 一次 `resolve` | `DNS Rebinding` 用例（resolver 调用 1 次、address 相同） |
| 7 | 代理 CONNECT 目标是 pinned IP | `connectAuthority()` | `CONNECT [::1]:443`、`127.0.0.1:<port>` |
| 8 | HTTPS 代理先 TLS 再 CONNECT | `connectToProxy()` 按 `proxy.protocol` 分支 | HTTPS 代理握手成功 + 自签名被拒 |
| 9 | 目标与代理的证书校验都开启 | 两处都没有 `rejectUnauthorized:false`；`TunnelOptions` 只有 `ca` | 自签名拒绝；代码内无关闭开关 |
| 10 | 代理凭据不泄露给目标 | 凭据只写在 CONNECT 头 | 目标侧只收到 `ping` |
| 11 | 不跟随重定向 | 只接受 200，3xx 归 terminal | 3xx 用例断言 transport 只调 1 次、hostname 未变 |
| 12 | 5 KiB 上限（流式） | `readPinnedResponse` + `readResponseBody` | 5120/5121/分块/无 CL/低报 CL/byteLength/停读 共 11 条 |
| 13 | DNS 也计入总预算 | `withDeadline` + 单调时钟 | DNS 永不返回、迟到 resolve/reject、剩余时间 7 条 |
| 14 | 临时故障不作废缓存 | `classifyHttpStatus` + `transient` 分类 | 408/425/429/5xx 表驱动 |
| 15 | 错误与非法文档不入缓存 | 失败结果不带 `cacheExpiresAt` | `{503,429,408}` 与非法文档 |
| 16 | 只发 `Accept` | `PINNED_REQUEST_HEADERS`（只有 accept） | `只带 Accept` 用例 |
| 17 | 不抓取 logo/client/jwks URI | 只读字段，不产生请求 | `从不抓取 …` 断言 transport 只调 1 次 |

---

## 3. 本轮修掉的三个「看起来安全」的点

1. **`http.request` 连 HTTPS 代理**：`parseProxyUrl` 允许 `https:`，但建连一律走
   `http.request`。这不是「不支持」，而是**用明文访问了一个 TLS 端点**，凭据会明文出网。
2. **`await` 后检查耗时**：预算只在 DNS 返回之后才参与判断，DNS 挂起时永远不生效。
3. **`Readable.from` 的 `destroyed`**：它是自动销毁的，用它断言「我们主动停读」是假阳性
   ——第一版变异没抓住，就是这条断言的问题（已换成按需生产的源 + 计数上界）。

---

## 4. 明确未证明的事项

| 项 | 现状 | 风险 |
|---|---|---|
| 目标侧 TLS 握手（`requestPinnedHttps` 直连/代理两路） | 只有代码审查，无端到端测试 | 中：需要受信任证书 + 443，本轮不放宽端口 |
| 代理连接超时（3s）与总超时（5s）的真实计时 | 只测了「剩余预算传参」与错误分类 | 低：定时器逻辑简单，但未实测 |
| 慢速攻击（服务端一点点吐字节拖到 5s） | 由总超时定时器兜底，未单独构造用例 | 低 |
| 并发抓取同一 client_id | 本轮不做缓存写入，无并发控制 | 无（未接入） |
| `ca` 注入参数的滥用可能 | 只有 `ca`，无法关闭校验 | 低：调用方是代码而非配置 |

---

## 5. 范围合规核对

- 未接入 `/mcp/oauth/authorize`；未改 DCR；未声明 `client_id_metadata_document_supported`；
  未新增 `registration_endpoint`。
- 无新增迁移（`git status cloud/src/db/migrations` 为空）；无新增依赖
  （`package.json` / `pnpm-lock.yaml` 未变）。
- 未修改 Desktop 生产代码；未抓取 CIMD 文档里的任何其它 URL。
- 未删除测试、未放宽既有断言。唯一改动的既有断言是「非 200 → terminal」的样本从
  `503` 换成 `404`——因为 `503` 现在**按本阶段要求**是 transient，原断言与目标行为
  冲突；`503` 的判定移到了新的 `HTTP 状态分类` 分组，覆盖面只增不减。
- 首轮全量出现的 `600001 ≤ 600000` 1ms 抖动**没有**通过修改断言解决，见实施报告 §9。
