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

# 真实网络 smoke（默认不跑；验证元数据抓取在真实网络上是否可用）
METADATA_LIVE_SMOKE=1 pnpm test:live
```

> **原生模块 ABI**：`better-sqlite3` 在 Node 与 Electron 下是两份二进制。
> `pnpm test` 用 Node 构建；`electron-builder install-app-deps` 会把它换成 Electron
> 构建，之后 Node 单测会加载失败。切换命令：
> `pnpm exec electron-builder install-app-deps`（给应用）↔
> `pnpm rebuild better-sqlite3`（给测试）。

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

## 未实现（明确）

- **真机端到端联调**：配对/同步/媒体链路的自动化覆盖是集成级（真 HTTP + 真 SQLite），
  iPhone ↔ Mac 的实机验证仍在进行中（见 `docs/REAL_DEVICE_SYNC_GUIDE.md`）。
- 画布手绘工具（表结构已建；iOS 端还没有对应模型，不能宣称两端可见）。
- 视频播放器、系统提醒调度。
- 链接抓取的能力边界：GitHub 未认证限流（60 次/时）、X oEmbed 不提供媒体封面、
  Bilibili 部分页面没有 `meta[author]`——这些情况都优雅降级，不编造数据。
- Bonjour 自动发现、双向同步、TLS（当前同步是局域网 HTTP 明文）。
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
| `docs/ROADMAP.md` | Phase 2–5 |
