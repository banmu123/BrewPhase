# BrewPhase Phase 1.3.2-R2 — Remote MCP 流式读取超时与 OPTIONS 限流隔离

> 日期：2026-11-21 · 分支：`feature/remote-mcp`
> **基线 HEAD：`845cac95684f246707d01a210f9ef1404b552025`**（Phase 1.3.2-R1 终态；
> 开始前 `git fetch` + `git status` + `git ls-remote` 核实本地 = 远程 = 基线，
> 工作区干净）。交付提交 SHA 以 `git log -1 --format=%H` 为准。
> 性质：**安全与可靠性收尾轮**——只修 ① 请求体流式读取无时间上限、
> ② 默认关闭 CORS 时 `OPTIONS /mcp` 消耗 `mcp-http` 限流额度。
> **不重新实现 MCP HTTP、不进入 1.3.3、不启用 CIMD、无新增依赖 / 迁移。**

---

## 1. 本轮发现的问题

| # | 问题 | 影响 |
|---|---|---|
| P1 | `readBoundedMcpBody()` 只有字节上限、**没有读取时间上限**：无 `Content-Length` 的客户端可以发几个字节后无限停住 | 未认证客户端即可长期占用未结束的请求处理流程（连接/内存挂起）；路由顺序上读取发生在 Host/Bearer **之前**，连认证都还没做 |
| P2 | `OPTIONS /mcp` 与 GET/DELETE/POST 共用 `limiter` 注册：`CORS_ORIGINS` 默认为空时全局 CORS 中间件不注册，OPTIONS 落进限流桶 | 恶意刷预检即可**打满 `mcp-http` 业务配额**，让合法 `POST /mcp` 全部 429（预检不该有业务成本） |

改动面：**3 个文件**（`src/mcp-http/guards.ts`、`src/routes/mcp-http.ts`、
`tests/mcp-http/guards.test.ts`）；既有测试无删除、无 skip、无弱化。

## 2. 流读取超时策略

- **绝对总时限**：`MCP_HTTP_BODY_READ_TIMEOUT_MS = 15_000`（15 秒）。
  实现上**整次读取只创建一个 `setTimeout`**（在循环外）——持续收到少量数据
  **不会**重置它；每次迭代只用 `deadline - Date.now()` 计算剩余时间参与 race
  （实际实现：单个 timeout promise 与每次 `reader.read()` 的 tagged 结果 race）。
- 结果类型扩展为四态（调用方与测试已同步更新）：

  ```ts
  type BoundedBodyRead =
    | { outcome: "ok"; bytes: Uint8Array }
    | { outcome: "too_large"; bytesRead: number }
    | { outcome: "unreadable" }
    | { outcome: "timeout" };
  ```

- **分类互斥且明确**：客户端断开 / 流错误 → `unreadable` → **400** 固定纯文本
  （`request body could not be read`）；总时限到 → `timeout` → **408** 固定纯文本
  （`request body read timed out`，无任何内部细节）；字节超限 → **413**。
- **检查优先级不变**：字节与时长判定都发生在 Host / Origin / Bearer / 数据库 /
  SDK **之前**（路由分支顺序：CL 快路径 → 有界读取〔超限 413 / 超时 408 /
  不可读 400〕→ Host → Origin → 认证 …）。256 KiB 字节硬上限与
  `Content-Length` 零读取快路径原样保留；SDK `maxRequestBodySize` 仍是第二道。

## 3. 超时后取消流的实现

```ts
const read = reader.read().then(
  (result) => ({ kind: "read" as const, result }),
  () => ({ kind: "error" as const }),   // 双向 then：拒绝也变成已决议的 tagged 值
);
const winner = await Promise.race([read, timeout]);   // timeout = 循环外的单个定时器
if (winner.kind === "timeout") {
  await reader.cancel().catch(() => undefined);        // 立即停读 + 取消底层流
  return { outcome: "timeout" };                      // finally 随后清理
}
```

关键点（逐条对应任务书要求）：

1. **不留下无法处理的挂起**：被放弃的 `reader.read()` 已通过双向 then 转成
   **已决议**的 promise——race 落定后它迟到的完成/拒绝都已被消费，**不会产生
   unhandled rejection**（测试用 `process.on("unhandledRejection")` 收集器断言 0）。
2. **取消流不产生未处理 rejection**：`reader.cancel().catch(() => undefined)`。
3. **定时器与 reader 锁必清**：`finally` 对**任何**退出路径（ok / too_large /
   unreadable / timeout / 抛错）执行 `clearTimeout` + `releaseLock()`（清理异常
   被吞掉，不改变结果分类）；路由级测试用 fake timers 断言 `vi.getTimerCount() === 0`。
4. `await reader.cancel()` 依据 WHATWG 规范会 settle 挂起的 read 且不等待
   底层 pull 完成，因此超时路径不会被「卡住的 pull」再次拖住。

## 4. 超时与正常流测试结果（全部真实 `ReadableStream`）

| 用例 | 结果 |
|---|---|
| **路由级超时**（fake timers，不真等 15s）：无 CL、只发 1 字节后永停 + **非法 Host** + 无 Bearer | ✅ 推进假时钟 ≤60s 内返回 **408**；body 恰为固定文案 `request body read timed out`、`text/plain`；**无 `WWW-Authenticate`**（未进 Bearer=未进 DB，也证明没先撞 Host 的 403）；**`cancel()` 被调用**（底层流已取消）；**`vi.getTimerCount() === 0`**（定时器清理）；无工具日志（未进 SDK/业务）；`unhandledRejection` 收集器 **0 条** |
| **注入短超时（函数级，真实 ~150ms）** | ✅ `readBoundedMcpBody(req, 256KiB, 150)` → `outcome === "timeout"`、流被取消、耗时 ∈ [140ms, 3s)——注入生效且**没等 15 秒**；同时钉死默认值 `MCP_HTTP_BODY_READ_TIMEOUT_MS === 15_000` |
| **时限内正常结束的流** | ✅ `outcome === "ok"`，`bytes` 与原文**逐字节相等**（长度断言），完整进入后续流程（既有 R1 测试 B 的 discover / tools/call / legacy initialize 全部照常 200） |
| **客户端主动断开（流在读取中 `error()`）** | ✅ **400** 固定文案 `request body could not be read`（与超时 408 分类互斥）、无 challenge；`unhandledRejection` **0 条**；随后同一 harness 的 discover 仍 200（无状态泄漏） |
| **R1 边界回归（未削弱）** | ✅ 256 KiB 恰好放行、+1 byte 413（CL 与流式各一组）、无 CL 超限流被取消、1 MiB 只读到跨限附近（< 512 KiB）即停——原测试全部保留（仅把跨限块数断言从精确 `5` 改为区间 `5..6` 并注释原因：race 引入的微步时序会让流的 **HWM 预取**多拉一块，该块进入的是**流内部队列**而非我们的缓冲，cancel 时被丢弃；安全性质「跨限即停、不完整缓冲、远小于总长」逐条保留） |
| **modern / legacy 回归** | ✅ `protocol.test.ts` 13 条、`auth` 9、`scope` 11、`session-grant` 10、`forwarding` 8、`logging` 3、`schema` 6 全部原样通过 |

## 5. OPTIONS 与限流器的隔离方式

```ts
// 独立路由：精确匹配 /mcp，不挂 limiter（R2 P2）
app.on("OPTIONS", "/mcp", (c) => optionsPreflight(c, ctx.env.corsOrigins));

// 业务路由：GET / DELETE / POST 仍受 mcp-http 桶保护
app.on(["GET", "DELETE", "POST"], "/mcp", limiter, async (c) => { … });
```

- OPTIONS **不进限流桶**、不认证、不查库、不进 SDK、不消耗业务额度；
- 响应逻辑（`optionsPreflight`）**一字未改**：默认 CORS 关闭 → 204 无任何
  ACAO（无 `*`、无 credentials）；白名单命中才回显具体 origin；头部与全局
  CORS 中间件逐字段一致；配置 CORS 时全局中间件仍先拦截（既有语义不变）；
- 路径**精确匹配 `/mcp`**：其它路径的 OPTIONS 不被接管（404）；
- GET / DELETE 仍走原方法分支 → SDK 405（处理方式未改）；
- **没有**通过扩大 CORS 白名单解决任何问题。

## 6. 限流回归测试

| 用例 | 结果 |
|---|---|
| `maxMcp=3`：**连续 6 次 OPTIONS** | ✅ 全部 **204**（无 ACAO、无 challenge）——若计入额度第 4 次就该 429，全 204 即**零消耗**的直接证明 |
| 同一 harness **3 次合法 POST discover** | ✅ 全 **200**（额度完整留给业务） |
| 第 4 次 POST | ✅ **429** + `Retry-After > 0`（POST 仍受原有 mcp-http 限流保护） |
| `maxMcp=1` 极小配额 | ✅ OPTIONS×3 全 204 → 第 1 次 POST 200 → 第 2 次 POST 429（互不影响） |
| OPTIONS 精确路径 | ✅ `OPTIONS /mcp/oauth/authorize` → **404**（未扩大），`OPTIONS /mcp` → 204 |
| CORS 白名单行为（既有 P2 测试） | ✅ 命中 origin 204+ACAO（非 `*`）、未命中 204 无 ACAO、非白名单 POST 仍 403、OPTIONS 无需 Bearer、GET/DELETE 仍 405——全部原样通过 |

## 7. 原有 256 KiB 与 Batch 回归结果

- **256 KiB**：`MCP_HTTP_MAX_BODY_BYTES` 未改（256×1024）；CL > 上限零读取
  413 快路径保留；实际字节 413（含 +1 byte 边界，CL 与流式两组）保留；
  超限取消流保留；`request.clone().text()` 在 `src/` **0 处代码**；
  `withBoundedBody()` 仍保留 URL / method / **全部 headers** / AbortSignal；
  SDK `maxRequestBodySize` 保留为第二道。
- **Batch Scope**：batch 逐元素预检用例（`[有权, 缺权]` → 403 + 0 派发；
  全有权 → SDK 双派发；非法 JSON → `-32700`）原样通过。
- 其余不变量（双时代、无 `Mcp-Session-Id`、401 无 scope、403 只报一个 scope、
  Session/Grant 每请求回查、身份只取 JWT `sub`、8 只读工具、全部经
  `dispatchToolCall`、jti 不去重、日志哨兵、CIMD 能力未声明、OAuth/Token/
  Consent/CIMD 零改动）——全量测试与 §四扫描逐项通过。

## 8. TypeScript / ESLint / Vitest / Build 结果（本地真实执行）

```text
$ cd cloud && npx tsc --noEmit
（无输出，0 error）

$ cd cloud && npx eslint src tests
（无输出，0 error / 0 warning）

$ cd cloud && npx vitest run tests/mcp-http
 Test Files  8 passed (8)
      Tests  88 passed (88)          ← 基线 81 → +7（R2-P1 四条 + R2-P2 三条）

$ cd cloud && npx vitest run
 Test Files  78 passed (78)
      Tests  1603 passed (1603)      ← 基线 1596 → +7，既有零回归

$ cd cloud && npm run build          ← 生产构建（tsc -p tsconfig.build.json + 资产拷贝）
build_exit=0
```

**失败项：无。** 无测试被删除 / skip / 弱化（`tests/mcp-http` 下
`grep .skip/.only` 0 命中）；无新增依赖、无新增数据库迁移（`git status` 干净面：
仅上述 3 个源/测试文件 + 3 份文档）。

## 9. GitHub CI 实际状态

- 仓库 `.github/workflows/` **仅 `desktop-release.yml`**（Desktop 安装包发布），
  **未配置** Cloud 的 tsc / eslint / vitest 工作流；
- 本机 `gh` CLI **不可用**（`command not found`），**未观测到**任何
  GitHub Workflow Runs。
- **结论：Cloud CI 未配置 / 未观测到——不描述为「通过」。** §8 全部为本地
  真实执行结果。

## 10. 未解决的风险

| # | 风险 / 边界 | 归属 |
|---|---|---|
| 1 | 15s 是绝对总时限的默认值、写死为常量（非 env 配置）——部署无法按需调整 | 记录；如需配置化再单独评估 |
| 2 | 超时路径 `await reader.cancel()` 依赖底层流 cancel 及时完成（WHATWG 下不等 pending pull；undici body 流为套接字拆除、实践上即时）——若未来注入的流 cancel 本身挂起，408 会推迟 | 记录 |
| 3 | `releaseLock()` 在极端路径（pending read 未 settle）会抛并被吞——锁随请求对象整体弃置，不构成泄漏但非「显式清理成功」 | 记录 |
| 4 | 跨限块数断言改为区间 `5..6`（HWM 预取的微步时序）——安全性质（跨限即停、不完整缓冲、远小于总长）逐条保留 | 记录 |
| 5 | 慢速但**在时限内**持续发送的客户端仍可占满 15s × 并发连接数——真正的并发上限是服务端连接层/限流，不属本轮 | 记录（连接层既有） |
| 6 | 真实客户端联调（1.3.3）与 CIMD 能力声明仍未做；Cloud 测试 CI 未配置 | 1.3.3 / 独立任务 |

---

**完成后停止，等待独立代码审核；不合并 main、不进入 Phase 1.3.3、
不启用 CIMD Discovery 能力、不增加写工具、不修改 Desktop 业务代码。**
