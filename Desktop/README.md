# BrewPhase Desktop

BrewPhase iOS 的桌面协同版：Coffee / Records / Canvas 三个同级模块，本地优先，
数据存在本机 SQLite 与 media 目录，不需要账号、不上传。

> 本目录是 BrewPhase monorepo 的 `Desktop/` 子目录，与 iOS 端同仓库演进；
> iOS 的数据模型与业务规则是这里的数据契约来源（见 `docs/DATA_MODEL_MAPPING.md`）。

当前完成 **Phase 0 + Phase 1**（本地 MVP）。局域网同步只有协议结构，没有服务端。

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
pnpm e2e            # Playwright + Electron 冒烟
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
tests/          unit（纯函数）/ integration（真 SQLite）/ e2e（真 Electron）
docs/           产品范围、架构、数据模型映射、同步协议、安全模型、画布规格、路线图
```

## 已实现

- **Coffee**：豆子 CRUD、详情、冲煮记录、品鉴、风味阶段（派生）、库存扣减/回补/盘点。
- **Records**：四种载体、搜索 + 载体 + 标签筛选、详情、标签多对多、图片导入（本地持久化）。
- **Canvas**：无限画布平移/缩放、节点显示/拖动/选中、从 Records 添加、世界坐标持久化。
- **安全**：`contextIsolation` / `sandbox` / 无 Node 集成、IPC zod 校验 + sender 校验、
  自定义媒体协议、CSP。

## 未实现（明确）

- 局域网同步服务、配对二维码、媒体传输（只有协议与类型）。
- 画布手绘工具（表结构已建；iOS 端还没有对应模型，不能宣称两端可见）。
- 视频播放器、链接元数据抓取、系统提醒调度。
- 代码签名 / 公证 / 自动更新。

## 文档

| 文件 | 内容 |
| --- | --- |
| `docs/PRODUCT_SCOPE.md` | 三个模块的边界与不做什么 |
| `docs/ARCHITECTURE.md` | 进程边界、数据流、迁移策略 |
| `docs/DATA_MODEL_MAPPING.md` | iOS ↔ Desktop 字段与关系对照、库存规则 |
| `docs/SYNC_PROTOCOL.md` | v1 配对、认证、增量、冲突 |
| `docs/SECURITY_MODEL.md` | Electron 安全边界与 IPC 校验 |
| `docs/CANVAS_SPEC.md` | 坐标、交互、节点渲染、手绘规划 |
| `docs/ROADMAP.md` | Phase 2–5 |
