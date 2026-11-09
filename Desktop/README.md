# BrewPhase Desktop

BrewPhase iOS 的桌面协同版：Coffee / Records / Canvas 三个同级模块，本地优先，
数据存在本机 SQLite 与 media 目录，不需要账号、不上传。

> 本目录是 BrewPhase monorepo 的 `Desktop/` 子目录，与 iOS 端同仓库演进；
> iOS 的数据模型与业务规则是这里的数据契约来源（见 `docs/DATA_MODEL_MAPPING.md`）。

当前完成 **Phase 0 + Phase 1**（本地 MVP）+ **Phase 2**（局域网同步 + 链接元数据补全）。
同步协议、配对与媒体传输已实现并有真实 HTTP 层集成测试；**真机双端联调仍需实机验证**。

## 技术栈

Electron · electron-vite · React 19 · TypeScript · Konva / react-konva · Zustand ·
SQLite（better-sqlite3）· Drizzle ORM · Zod · Vitest · Playwright · electron-builder · pnpm

## 起步

```bash
pnpm install

# 单测 + 集成测试（better-sqlite3 需要 Node ABI）
pnpm test
pnpm typecheck

# 构建并为本机 Electron 重建原生模块（ABI 不同，必须先重建再跑应用）
pnpm build
pnpm exec electron-builder install-app-deps

pnpm start          # 预览构建产物
pnpm dev            # 开发模式（HMR）
pnpm e2e            # Playwright + Electron 冒烟 / Records 视觉验收

# MCP（AI Action Gateway）：构建独立 stdio server，供 Codex/WorkBuddy 连接
pnpm mcp:build      # 输出 out/mcp/stdio.mjs
pnpm mcp:start      # node out/mcp/stdio.mjs（需要 BREWPHASE_MCP_TOKEN 等环境变量）

# 真实网络 smoke（默认不跑；验证元数据抓取在真实网络上是否可用）
METADATA_LIVE_SMOKE=1 pnpm test:live
```

> **MCP 前置**：Desktop 应用必须在运行（Bridge 随主进程启动）。客户端 token 在
> **设置 → AI 连接**里创建，明文只显示一次。完整配置步骤见下文
> [MCP（AI Action Gateway）](#mcpai-action-gateway)。

> **原生模块 ABI**：`better-sqlite3` 在 Node 与 Electron 下是两份二进制。
> `pnpm test` 用 Node 构建；`electron-builder install-app-deps` 会把它换成 Electron
> 构建，之后 Node 单测会加载失败。切换命令：
> `pnpm exec electron-builder install-app-deps`（给应用）↔
> `pnpm rebuild better-sqlite3`（给测试）。

## MCP（AI Action Gateway）

让 Codex、WorkBuddy 等支持 MCP 的 Agent 在**用户逐客户端授权的范围**内读写
BrewPhase。Agent 拿不到数据库、拿不到文件系统，也没有删除权限。

### 1. 一次性准备

```bash
cd Desktop
pnpm mcp:build        # 产出 out/mcp/stdio.mjs（MCP 入口，AI 客户端 spawn 它）
```

- 保持 **BrewPhase Desktop 正在运行**：Bridge（Unix socket）随主进程启动，
  App 关闭后 Agent 会收到 `APP_NOT_RUNNING`。
- 首次构建后路径即为 `Desktop/out/mcp/stdio.mjs`（绝对路径）。

### 2. 创建客户端并拿 Token

1. Desktop → **更多 → AI 连接**；
2. 填名称（如 `Codex`）、勾选 Scope（记录 / 标签 / 咖啡 / 画布，可任意组合）；
3. 点「创建并生成 Token」——**明文 token 只显示这一次**；
4. 用页面上的「复制 Codex 配置」/「复制 WorkBuddy 配置」直接拿到填好路径与
   token 的配置；页面底部「本机连接信息」也给出 `MCP 入口` 与 `数据目录` 的真实值。

Scope 与工具对应：

| Scope | 允许的工具 |
|---|---|
| `records:read` | `search_records`、`get_record` |
| `records:create` | `create_record` |
| `records:update` | `update_record` |
| `tags:read` / `tags:create` | `list_record_tags` / `create_tag` |
| `coffee:read` | `list_beans`、`get_bean`、`list_brews`、`list_tastings`、`get_coffee_summary` |
| `canvas:read` | `list_canvases`、`get_canvas` |
| `canvas:write` | `create_canvas`、`add_record_to_canvas`、`create_canvas_note`、`update_canvas_note`、`annotate_canvas_node` |

### 3. Codex 配置

写入 Codex 的 `config.toml`（`~/.codex/config.toml`）：

```toml
[mcp_servers.brewphase]
command = "node"
args = ["/absolute/path/to/Desktop/out/mcp/stdio.mjs"]

[mcp_servers.brewphase.env]
BREWPHASE_MCP_TOKEN = "<创建时显示的 token>"
BREWPHASE_MCP_USER_DATA_DIR = "<设置页「数据目录」显示的值>"
```

`args` 与 `BREWPHASE_MCP_USER_DATA_DIR` 两个值可以直接从设置页的
「复制 Codex 配置」拿到，不要手猜 Electron 的默认 userData 路径。

### 4. WorkBuddy 配置

写入 WorkBuddy 的 `mcp.json`：

```json
{
  "mcpServers": {
    "brewphase": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/Desktop/out/mcp/stdio.mjs"],
      "env": {
        "BREWPHASE_MCP_TOKEN": "<创建时显示的 token>",
        "BREWPHASE_MCP_USER_DATA_DIR": "<设置页「数据目录」显示的值>"
      },
      "timeout": 30000
    }
  }
}
```

> WorkBuddy 的执行环境必须能访问本机进程/socket。若它运行在没有本地执行能力的
> 云端环境，则无法连接本地 Bridge——本项目不会为此把 Bridge 暴露到公网。

### 5. 手动启动 MCP Server（排查用）

```bash
cd Desktop
BREWPHASE_MCP_TOKEN=<token> \
BREWPHASE_MCP_USER_DATA_DIR="<数据目录>" \
node out/mcp/stdio.mjs
# 或等价的显式参数：
node out/mcp/stdio.mjs --user-data-dir "<数据目录>" --version
```

- stdout 只走 MCP 协议；日志在 stderr（`[brewphase-mcp] ready (user-data: …)` 表示启动成功）。
- Token 只从环境变量读，**不要放进命令行参数**（进程列表可见）。

### 6. 撤销与限制

- **撤销**：设置页「已授权客户端」→「撤销」→ 该客户端的下一次调用即被拒绝
  （Main 每请求查库，不存在缓存窗口）。
- 审计：每次写调用（含失败与权限拒绝）落 `mcp_operation_log`；不记正文/token/路径。
- 幂等：`create_record` / `create_canvas` / `add_record_to_canvas` /
  `create_canvas_note` 需要 `idempotency_key`，重试不会产生重复数据。
- 并发：`update_record` / `update_canvas_note` 需带 `expected_updated_at`
  （从 get 工具读到的 `updated_at`），过期返回 `STALE_RECORD`。
- 平台：V1 仅 **macOS / Linux**（Windows Named Pipe 权限未验证，不提供 TCP 退化）。
- 同步：MCP 写入是 `desktop_local_only`，不会自动回传 iPhone。
- 文档：`docs/MCP_ARCHITECTURE.md`（结构）、`docs/MCP_TOOLS.md`（18 个工具）、
  `docs/MCP_SECURITY.md`（token/scope/socket/错误码）。

## 目录

```
src/main/       主进程：数据库、迁移、repository、媒体、IPC
src/preload/    contextBridge 白名单
src/renderer/   React 界面（coffee / records / canvas / settings）
src/shared/     契约（zod）、纯逻辑（库存 / 阶段 / 落位）
tests/          unit（纯函数）/ integration（真 SQLite）/ e2e（真 Electron）/
                live（真实网络 smoke，需显式开启）
docs/           产品范围、架构、数据模型映射、同步协议、安全模型、画布规格、路线图
```

## 已实现

- **Coffee**：豆子 CRUD、详情、冲煮记录、品鉴、风味阶段（派生）、库存扣减/回补/盘点。
- **Records**：四种载体、搜索 + 载体 + 标签筛选、详情、标签多对多、图片导入（本地持久化）。
- **Canvas**：无限画布平移/缩放、节点显示/拖动/选中、从 Records 添加、世界坐标持久化。
- **Records 平台卡片**：GitHub（仓库信息卡/og 图 + 统计叠加）、YouTube、Bilibili、
  X 动态、通用网页、本地媒体各自的差异化呈现；缺数据就落平台 fallback，绝不伪造。
- **链接元数据补全**：新建链接先本地识别平台（纯函数、不发请求），保存后由主进程
  安全抓取（SSRF 防护 + DNS 连接级校验 + 逐跳重定向校验）补全标题/封面/作者/
  仓库统计；用户写过的标题与备注永不被覆盖，URL 变更清空旧平台元数据。
- **元数据所有权分离**：Desktop 抓到的标题/摘要/封面/仓库统计只存
  `record_metadata`（独立表，**不进同步指纹**），`records` 的同步列只由 iOS
  同步或桌面用户编辑写入——自动补全不会制造假冲突，用户编辑与删除仍受冲突保护。
- **同步后自动补全**：iOS 同步进来的链接（新建或 URL 变更）会在事务提交后进入
  本地抓取队列（并发 2、按 recordId+URL 去重、失败不自动重试）；应用重启会恢复
  未完成的 pending 任务；结果只写本地派生表，抓完自动刷新界面。
- **搜索覆盖本地派生信息**：Records 搜索同时命中 `records` 与同 URL 的
  `record_metadata`（EXISTS 子查询，不产生重复行、不影响指纹）。
- **安全**：`contextIsolation` / `sandbox` / 无 Node 集成、IPC zod 校验 + sender 校验、
  自定义媒体协议、CSP。
- **MCP（AI Action Gateway）**：Codex / WorkBuddy 等 Agent 通过 STDIO 连接
  `out/mcp/stdio.mjs`，经本地 Unix socket 转给 Electron Main。逐客户端授权
  （8 种 scope）、token 只存 SHA-256、每请求查库校验、写操作审计 + 幂等键、
  乐观并发（`expected_updated_at`）。工具面：Records 读写、Coffee 只读、
  Canvas 受控读写；**没有删除、没有 SQL、没有文件系统**。见
  `docs/MCP_ARCHITECTURE.md` / `docs/MCP_TOOLS.md` / `docs/MCP_SECURITY.md`。

## 未实现（明确）

- **真机端到端联调**：配对/同步/媒体链路的自动化覆盖是集成级（真 HTTP + 真 SQLite），
  iPhone ↔ Mac 的实机验证仍在进行中（见 `docs/REAL_DEVICE_SYNC_GUIDE.md`）。
- 画布手绘工具（表结构已建；iOS 端还没有对应模型，不能宣称两端可见）。
- 视频播放器、系统提醒调度。
- 链接抓取的能力边界：GitHub 未认证限流（60 次/时）、X oEmbed 不提供媒体封面、
  Bilibili 部分页面没有 `meta[author]`——这些情况都优雅降级，不编造数据。
- Bonjour 自动发现、双向同步、TLS（当前同步是局域网 HTTP 明文）。
- MCP 的平台与能力边界：V1 只支持 macOS / Linux（Windows Named Pipe 权限未验证，
  不提供 TCP 退化）；WorkBuddy 若运行在没有本地进程访问能力的云端环境，无法连接
  本地 Bridge；MCP 写入是 `desktop_local_only`，不会自动回传 iOS。
- 代码签名 / 公证 / 自动更新。

## 文档

| 文件 | 内容 |
| --- | --- |
| `docs/PRODUCT_SCOPE.md` | 三个模块的边界与不做什么 |
| `docs/ARCHITECTURE.md` | 进程边界、数据流、迁移策略 |
| `docs/DATA_MODEL_MAPPING.md` | iOS ↔ Desktop 字段与关系对照、库存规则 |
| `docs/SYNC_PROTOCOL.md` | v1 配对、认证、增量、冲突 |
| `docs/SYNC_METADATA_CONSISTENCY.md` | Resolver × Sync 的字段所有权、指纹边界、回归场景 |
| `docs/SECURITY_MODEL.md` | Electron 安全边界与 IPC 校验 |
| `docs/CANVAS_SPEC.md` | 坐标、交互、节点渲染、手绘规划 |
| `docs/MCP_ARCHITECTURE.md` | MCP 进程模型、Bridge、生命周期、数据所有权 |
| `docs/MCP_TOOLS.md` | 18 个工具的入参、返回、scope 映射 |
| `docs/MCP_SECURITY.md` | token / scope / socket 权限 / 审计 / 错误码 |
| `docs/ROADMAP.md` | Phase 2–5 |
