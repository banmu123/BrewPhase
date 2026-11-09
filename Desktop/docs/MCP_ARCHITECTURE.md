# BrewPhase MCP V1 — 架构（AI Action Gateway）

> 状态：V1 已实现（2026-11-09）。这份文档描述**已经落地的结构**，不是提案。
> 工具清单见 `MCP_TOOLS.md`，信任边界与授权模型见 `MCP_SECURITY.md`。

## 1. 目标与边界

BrewPhase MCP 是 BrewPhase 的**官方 AI 操作入口**：让支持 MCP 的客户端
（Codex / WorkBuddy / Claude Code）以用户逐客户端授权的 Scope 读取和写入
BrewPhase 数据。

不是：

- 不是 SQLite MCP，不暴露 SQL、表结构或文件路径；
- 不是文件系统 MCP，不提供 read_file / write_file / run_command；
- 不是同步协议的一部分，MCP 写入是 **desktop_local_only**（见 §7）。

## 2. 进程与数据所有权

```
AI Client (Codex / WorkBuddy / …)
   │  STDIO (MCP JSON-RPC)
   ▼
brewphase-mcp 进程（每客户端一个，无数据库权限）
   │  Unix domain socket（NDJSON）
   ▼
Electron Main — Application Bridge
   │  auth（token 哈希查库） → scope 校验 → Zod 校验 → 审计
   ▼
Application Service（records / coffee / canvas）
   ▼
Repository（事务 + change_log + 本地元数据播种）
   ▼
SQLite（brewphase.db）+ Media
```

**唯一数据库所有者是 Electron Main。** MCP 进程不 import better-sqlite3、
不打开 brewphase.db、不写媒体目录。Electron 未运行时不建第二个库，
Bridge 连接失败即返回 `APP_NOT_RUNNING`。

## 3. 传输

| 段 | 传输 | 说明 |
|---|---|---|
| AI 客户端 → MCP Server | STDIO | 官方 `@modelcontextprotocol/server` v2.4.0（2026-07-28 spec） |
| MCP Server → Main | Unix domain socket | NDJSON：一行一个请求/响应，单行 ≤ 1MB |

Windows 的 Named Pipe 权限隔离在 V1 未验证，因此 **V1 只支持 macOS / Linux**；
代码里 socket 路径的获取集中在 `bridge-contract.ts`，加 Windows 只需换 transport，
但不得退化为监听 TCP。

### 3.1 Socket 与连接信息

- Socket：`<userData>/mcp/bridge.sock`，目录 `0700`，socket `0600`。
- 连接信息：`<userData>/mcp/bridge-info.json`，**原子写**（tmp + rename），只含
  `{ socketPath, protocolVersion, pid, appVersion }`，**不含 token**。
- 启动：先尝试连接探测既有 socket；连不上则删除失效文件再 bind（不误删活服务）。
- 退出：`before-quit` 关闭 server 并删除 socket 与 bridge-info.json。

MCP CLI 通过 `--user-data-dir` 或 `BREWPHASE_MCP_USER_DATA_DIR` 定位
`bridge-info.json`，**不猜 Electron 默认路径**。客户端的可复制配置
（Codex `config.toml` / WorkBuddy `mcp.json`）与逐步操作唯一维护在
`Desktop/README.md` 的「MCP（AI Action Gateway）」章节，本文不重复。

### 3.2 帧格式

```jsonc
// request（客户端 → Main）
{ "requestId": "uuid", "protocolVersion": 1, "method": "tools.call",
  "tool": "search_records", "token": "bp_mcp_…", "params": { } }

// response（Main → 客户端）
{ "requestId": "uuid", "success": true, "data": { } }
{ "requestId": "uuid", "success": false, "error": { "code": "STALE_RECORD", "message": "…" } }
```

`requestId` 由客户端生成，响应原样带回；连接内严格串行，不会混淆。
协议版本不匹配 → `BRIDGE_PROTOCOL_MISMATCH`。

## 4. Application Service

`src/main/application/` 是 Renderer IPC 与 MCP Bridge 的**共同业务入口**：

| Service | 职责 | 不做什么 |
|---|---|---|
| `record-service.ts` | 搜索/读取/创建/更新记录、标签管理；链接规范化（`parseLink`）；乐观并发（`expected_updated_at`）；元数据补全调度 | 不直接写 SQL；不碰媒体路径字段 |
| `coffee-service.ts` | 豆子/冲煮/品鉴只读查询 + 汇总 | **V1 不提供任何写操作**（库存规则只在 Repository + iOS 同步路径） |
| `canvas-service.ts` | 画布/节点/便签读取；创建画布、添加节点、便签增改；摆放位置由 `nextNodeOrigin` 计算 | 不接收屏幕坐标；不删任何东西 |
| `permission-service.ts` | 创建/列出/撤销 MCP 客户端；token 生成与哈希；scope 集合校验 | 明文 token 只在创建响应出现一次 |

Service 调用既有 Repository，不复制事务 / change_log / 外键行为。
写入成功后通过 `application-events.ts` 广播 `app:changed`（domain: records /
canvas），Renderer 订阅后刷新对应页面——不依赖 MCP 直接触碰 UI。

## 5. 授权模型

- 每个客户端独立授权；token `bp_mcp_<48 位 base64url>`，`crypto.randomBytes(32)`。
- 库中只存 `sha256(token)` 十六进制；创建响应返回一次明文。
- **每个请求都查库校验**客户端存在、未撤销、scope 覆盖该工具，不使用进程内授权缓存。
- Scope 清单：`records:read`、`records:create`、`records:update`、`tags:read`、
  `tags:create`、`coffee:read`、`canvas:read`、`canvas:write`。
- 撤销（`revoked_at` 置位）对**已有连接**的下一次请求立即生效。

## 6. 审计与幂等

- `mcp_operation_log`：每次**写**调用（成功与失败）一条；只记 tool 名、实体
  id、错误码、幂等键，不记正文、不记 token、不记路径。
- `mcp_idempotency`：`(client_id, idempotency_key)` 主键 + 请求摘要
  （sha256 规范化参数）。同 key 同摘要 → 返回原实体；同 key 不同摘要 →
  `IDEMPOTENCY_KEY_REUSE`。表内不存完整参数。

## 7. 同步语义

同步协议（iOS → Desktop 单向）不改。MCP 写入走 `recordChange` / change_log
的既有本地路径，但**不会自动回传到 iOS**；所有写工具响应显式标注
`sync_status: "desktop_local_only"`。

## 8. 生命周期

| 事件 | 行为 |
|---|---|
| Electron bootstrap | migration 007 → BridgeServer.start()（socket + info 原子发布） |
| Electron `before-quit` | BridgeServer.stop() → 关 socket、删 info/socket → 关库 |
| MCP 进程启动 | 读 info → connect；失败 → 每个 tool 返回 `APP_NOT_RUNNING` |
| MCP 进程退出 | 关闭 socket；SIGINT/SIGTERM 清理；stdout 只走协议 |
| App 崩溃 | 残留 socket 在下次启动被探测并清理（先 connect 探测，失败才删） |

## 9. 实现调整记录（相对任务书）

1. **SDK**：任务书建议 `@modelcontextprotocol/server`，核实后确认它就是 v2 稳定线
   当前包名（2.4.0，16 天前发布，ESM-only，peer 无 zod 但内部用 zod v4）。
   采用之，`registerTool` + `inputSchema` + `structuredContent` 均为 v2 API。
2. **Windows**：按任务书要求，V1 明确标为不支持，socket 路径抽象集中在
   `bridge-contract.ts`，不伪装跨平台。
3. **审计范围**：只记写调用（任务书要求「记录每次写入调用」）；读调用不进
   `mcp_operation_log`，避免高频读取膨胀审计表。
4. **`search_records` 总量**：现有 `listRecords` 不支持 count，V1 返回
   `{ items, limit, offset, has_more }`，不臆造 total。
5. **Canvas 便签更新**：Repository 的 `updateNote` 接收整条 `CanvasNote`，
   Service 在其上做「先读→合并 patch→写回」并校验 `expected_updated_at`。
