# BrewPhase Phase 1.3.2-R1 — Remote MCP HTTP 请求体限长与 OPTIONS 边界收尾

> 日期：2026-11-20 · 分支：`feature/remote-mcp`
> **基线 HEAD：`0b35ea7ccefc5f7820cd5c0b9ee95ef2f4e984a4`**（Phase 1.3.2 终态；
> 开始前 `git fetch` + `git ls-remote` 核实本地 = 远程 = 基线，工作区干净）。
> 交付提交 SHA 以 `git log -1 --format=%H` 为准。
> 性质：**独立安全硬化轮**——只修 ① 无 `Content-Length` 绕过 256 KiB 限制、
> ② 默认关闭 CORS 时 `OPTIONS /mcp` 404、③ JSON-RPC Batch 的 Scope 预检边界。
> **不重新实现 1.3.2、不进入 1.3.3、不启用 CIMD 能力。**

---

## 1. P1 的原因与修复前后的请求体读取顺序

### 修复前（缺陷）

```text
POST /mcp
 → Content-Length 快检（缺失 → 直接放行，不读任何字节）
 → Host / Origin / Bearer / DB
 → Scope 预检：request.clone().text()   ← 无 Content-Length 时【无上限】完整缓冲
 → SDK handler（maxRequestBodySize 才在这里兜底——太晚）
```

两个洞：
1. **chunked（无 CL）请求**在入口阶段完全不受 256 KiB 约束；
2. **Scope 预检自己就把正文完整读进内存**——SDK 的第二道限制发生在读取之后，
   挡不住这次无上限读取；谎报小 `Content-Length` 的请求同样能穿到预检阶段。

### 修复后（任务书 §3.2 八条要求逐条对应）

```text
POST /mcp
 → 1a. Content-Length > 256 KiB → 413（廉价快路径：一个字节都不读，
       且先于 Host / Origin / Bearer / 数据库）                    ← 要求 1
 → 1b. readBoundedMcpBody()：流式读取，累计实际 byteLength
       · ≤ 256 KiB 才继续；> 256 KiB → 立即停读 + reader.cancel() → 413 ← 要求 2/3/4
       · 正文最多保留 256 KiB（跨限 chunk 只计数不入缓冲）            ← 要求 5/6
       · 流不可读 / 对端中断 → 400（不进任何后续阶段）
 → 2. Host → 3. Origin → 4. Bearer → 5/6. Session/Grant（全部在读取**之后**，
       但读取本身已有界；顺序契约不变）
 → 7. Scope 预检：解析【已有界的 bytes】（含 batch 每个元素）
 → 8. withBoundedBody(request, bytes) 重建 Request → SDK
       （SDK maxRequestBodySize: 256 KiB 保留为第二道）              ← 要求 7/8
```

**关键性质**：任何超过 256 KiB 的请求，读取量上界是 `256 KiB + 单个 chunk`
（跨限即停），**不可能在入口或 Scope 预检阶段被完整缓冲**；原始请求的流在
成功路径被读尽、在超限路径被取消，重建的 Request 只携带已读出的有界字节。

## 2. 有界读取器的具体实现（`cloud/src/mcp-http/guards.ts`）

```ts
readBoundedMcpBody(request, limit = 256 KiB):
  body === null                     → { outcome: "ok", bytes: 空 }
  reader.read() 循环：
    累计 total += value.byteLength
    total > limit                   → await reader.cancel() → { "too_large", bytesRead: total }
    否则 chunks.push(value)         （缓冲恒 ≤ limit）
  读取抛错 / 拒绝                    → { "unreadable" }（入口回 400 纯文本）
  finally: reader.releaseLock()（容错，防泄漏锁）
  正常结束                           → 合并为恰好有界的 Uint8Array

withBoundedBody(request, bytes)：
  new Request(request.url, { method, headers: request.headers, body: bytes,
                             signal: request.signal })
  —— 保留 URL / method / 全部 headers（Authorization、MCP-Protocol-Version、
     Mcp-Method、Mcp-Name、Host、Origin、Content-Type 一个不丢）与 AbortSignal；
     正文换成有界字节，原始流不再被 SDK 触碰。
```

- `Content-Length` 快路径（`bodyTooLargeResponse`）保留为**声明值超限的零读取
  早退**；`Content-Length` 缺失或谎报都由实际字节读取兜底（谎报场景：CL 小、
  实际正文大 → 1a 放行 → 1b 按实际字节 413）。
- `peekToolCallName()`（`request.clone().text()`）**整体移除**：`src/` 下
  `grep -rn "clone()"` 仅剩 guards.ts 注释里对修复前行为的描述（0 处代码）。
- Scope 预检改为 `missingScopeFromBoundedBody(bytes, effectiveScopes)`：
  从有界字节解析；单条与 **batch 数组**逐元素检查；非法 JSON / 形状问题 /
  未知工具名 → 交回 SDK（`-32700` / `-32600` 分类不变）。

## 3. 无 Content-Length 的真实流测试结果

`guards.test.ts` 新增 describe「P1：无 Content-Length 的请求体硬上限」——
全部使用**真实 `ReadableStream`**（pull 驱动、逐块计数、带 `cancel()` 观测）：

| 用例 | 结果 |
|---|---|
| **测试 A**：1 MiB（16×64 KiB）无 CL + **非法 Host** + 无 Bearer | ✅ **413 纯文本**（body 恰为 `request body too large`）；**不是** Host 403、**无** `WWW-Authenticate`（未进 Bearer = 未进 DB）、无任何工具日志（未进 SDK）；**`cancel()` 被调用**；**`pulled === 5`**（4 块=256 KiB 未超，第 5 块跨限即停）→ 读取量 = 256 KiB + 64 KiB = 320 KiB **< 1 MiB**，第 6–16 块从未被拉取 |
| **测试 B**：无 CL 合法请求 | ✅ modern `server/discover` → 200（`supportedVersions` 含 2026-07-28）；modern `tools/call` → 200 且 **`arguments` 逐项原样到达派发层**（`{search:"ethiopia", limit:3}`，证明 SDK 收到完整正文）；legacy `initialize`（流式正文）→ 200 `text/event-stream` |
| **测试 C**：带 CL 超限（+ 非法 Host + 非法 Origin + 无 Bearer） | ✅ **413 纯文本**、无 challenge（Host/Origin/Auth/DB 全部未触达）、body 为我们的纯文本（非 SDK JSON-RPC） |
| **测试 D**：边界 | ✅ CL **恰好 262144** → 放行到认证（401，证明没被 413）；CL **262145** → 413；**流式恰好 256 KiB**（4×64 KiB）→ 放行 401、`pulled===4`、未取消；**流式 256 KiB+1 byte**（8 块中第 5 块跨界）→ 413、**`cancelled===true`**、`pulled===5`、第 6–8 块未读。**无 off-by-one** |

> 注：跨界用例特意用 8 块（而非恰好 5 块）——若流在跨界同一次 pull 里
> `close()`，`cancel()` 是 no-op，「取消」断言无意义；剩余 3 块让取消可观测。

**最大读取字节数的验证证据**：测试 A 的 `pulled * CHUNK === limit + CHUNK`
（320 KiB）且 `< 总长`；测试 D 的 `pulled === 5`（8 块流只拉 5 块）——
读取上界由 pull 次数直接证明，不是「先读完再判」。

## 4. Scope 预检回归（含 Batch）

SDK 行为实测（本轮探针）：**legacy batch 被完整支持**——数组里每个
`tools/call` 都会执行（两条 SSE 帧）；非法 JSON → `400 -32700 Parse error`；
modern 元素的 batch → `400 -32600`（SDK 拒绝）。因此：

| 用例 | 结果 |
|---|---|
| batch = `[search_records(有权), list_beans(缺 coffee:read)]`，records:read token | ✅ **403** + `scope="coffee:read"` + **0 次派发**——**只查第一个元素就会放行未授权工具**，本用例把「逐元素检查」钉死 |
| batch 两个都有权（full-scope token） | ✅ 预检放行 → **200 SSE**，SDK 批量执行，`dispatchToolCall` 顺序收到 `["search_records","list_beans"]` |
| 非法 JSON（无 CL 流式） | ✅ **400 `-32700`**（SDK 的协议错误；预检不越权、不改变分类），0 次派发 |
| 单条：有权派发 / 缺权 403 | ✅ 200 + 1 次派发；403 后派发数不变 |
| modern / legacy 协议（重建 Request 后） | ✅ 原 protocol.test.ts **13 条原样通过**（discover / initialize / list / call / -32020 / -32022 / -32601 / 405 / 202 / 无 `Mcp-Session-Id`）——全部经「有界读取 + 重建」新路径 |

## 5. OPTIONS 默认关闭 CORS 的响应（P2，设计 §4.1）

`routeMcpHttp` 现注册 `OPTIONS /mcp`（`app.on(["GET","DELETE","POST","OPTIONS"], …)`），
分支**最先**（先于限流后的任何其它处理，不进 Bearer / 不进 SDK / 不查库）：

```text
CORS_ORIGINS 为空（默认）：
  OPTIONS /mcp → 204
    Vary: Origin
    Access-Control-Allow-Methods: GET, POST, OPTIONS
    Access-Control-Allow-Headers: Authorization, Content-Type
    （无 Access-Control-Allow-Origin、无 `*`、无 credentials —— 只回答「不许」，
      不隐式放开任何跨源）
```

## 6. CORS 开启后的行为

- **白名单 Origin** → 204 + `Access-Control-Allow-Origin: <该 origin>`（**回显具体
  origin，绝不用 `*`**）、无 `Access-Control-Allow-Allow-Credentials`；头部与
  `app.ts` 全局 CORS 中间件**逐字段一致**（配置 CORS 时全局中间件先拦截，两条
  分支语义相同）。
- **非白名单 Origin** → 204 但**没有 ACAO**（浏览器自行拦截）；来源不被扩大。
- **POST 的 Origin Guard 不受影响**：非白名单 Origin 的 POST 仍 **403**（用例断言）。
- **OPTIONS 不进入 Bearer**（无 Authorization 也 204）；**不消耗业务状态**：
  连续 3 次 OPTIONS 后无工具日志、零派发，随后同链路 `server/discover` 仍 200。
- **GET / DELETE 仍由 SDK 返回 405**——未改变其处理方式（protocol.test.ts 回归
  通过；本组另有 405 断言）。

## 7. Modern / Legacy 回归结果

原 `protocol.test.ts` 13 条**全部原样通过**（它们现在全部走「有界读取 → 重建
Request」路径）；新增流式（无 CL）modern discover / tools/call 与 legacy
initialize 各 200；batch 的 legacy 执行行为按 SDK 实测形态断言。双时代、
`-32020` / `-32022` / `-32601` / `-32700` / 405 / 202、无 `Mcp-Session-Id`、
`legacy: "stateless"`、不手写 Transport 等安全不变量**逐项保持**（§六）。

## 8. TypeScript / ESLint / 全量测试 / build 结果（真实执行）

```text
$ cd cloud && npx tsc --noEmit
（无输出，0 error）

$ cd cloud && npx eslint src tests
（无输出，0 error / 0 warning）

$ cd cloud && npx vitest run tests/mcp-http
 Test Files  8 passed (8)
      Tests  81 passed (81)          ← 基线 70 → +11（本轮新增全部在 guards.test.ts）

$ cd cloud && npx vitest run
 Test Files  78 passed (78)
      Tests  1596 passed (1596)      ← 基线 1585 → +11，既有零回归

$ cd cloud && npm run build          ← 生产构建（tsc -p tsconfig.build.json + 资产拷贝）
build_exit=0
```

**失败项：无。** 既有测试**无删除、无 skip、无弱化**（`tests/mcp-http/` 下
`grep .skip/.only` 0 命中）；改动仅 3 个文件：
`src/mcp-http/guards.ts`、`src/routes/mcp-http.ts`、`tests/mcp-http/guards.test.ts`。

重点复核（任务书 §八）：
- 无 CL 超限不能绕过 ✅（测试 A/D）；无无上限 `clone().text()` ✅（src 0 处代码）；
- SDK 收到的正文与原始合法正文一致 ✅（测试 B 参数逐项断言）；
- modern / legacy 回归 ✅；OPTIONS 默认 204 ✅；CORS 未扩大 ✅；
- **无新增依赖、无新增迁移**（`git status` 无 package/lock/migrations 改动）；
- SDK 仍是 `@modelcontextprotocol/server`（未更换），`maxRequestBodySize`
  保留为第二道限制；8 个只读工具、`dispatchToolCall`、jti 不去重、日志纪律、
  Session/Grant 实时回查、401 无 scope、403 只报一个 scope——**全部未变**。

## 9. GitHub CI 实际状态

- 仓库 `.github/workflows/` **仅 `desktop-release.yml`**（Desktop 发布），
  **未配置** Cloud 的 tsc / eslint / vitest CI；
- 本机 `gh` CLI **不可用**（`command not found: gh`），**未观测到**任何
  GitHub Workflow Runs。
- **结论：未配置 / 未观测到——不声称「CI 通过」。** §8 全部为本地真实执行。

## 10. 尚未解决的风险

| # | 风险 / 边界 | 归属 |
|---|---|---|
| 1 | 读取上界是 `256 KiB + 单个流 chunk`（跨限 chunk 不入缓冲但已从流中取出）——chunk 大小由对端/运行时决定，本实现不假设其尺寸 | 记录（已显著优于无上限缓冲） |
| 2 | `Content-Length` 快路径只判声明值；「谎报小值 + 实际大」由 1b 实际字节读取兜底（HTTP/1.1 解析器按 CL 定帧，线上谎报无法超出 CL，测试环境用 Request 直构验证了兜底） | 记录 |
| 3 | batch 中**多个**元素同时缺不同 scope 时只报第一个缺失的（修复一个再撞下一个）；单元素 batch 是主路径 | 记录（§5.8.3「只报一个」的延伸） |
| 4 | 现代元素 batch（SDK 自身 `-32600` 拒绝）若同时含缺权 tools/call，会先得到我们的 403——两种都是拒绝，且未授权工具绝不进入派发；未按 SDK 分类排序 | 记录 |
| 5 | 真实客户端（1.3.3）与 CIMD 能力声明仍未做——`NOT VERIFIED` 项原样保留 | 1.3.3 |
| 6 | Cloud 测试 CI 未配置（§9） | 另行任务 |

---

**完成后停止，等待独立审核；不进入 Phase 1.3.3、不启用 CIMD、不合并 main。**
