# 路线图

## Phase 0 — 工程启动（本次）

- Electron + electron-vite + React + TypeScript
- SQLite + Drizzle + 手写迁移（user_version）
- main / preload / renderer 职责隔离，IPC zod 校验 + sender 校验
- 契约层（实体 / 同步 / 校验）与纯逻辑层（库存 / 阶段 / 落位）
- Vitest + Playwright 脚手架
- 七份文档（本目录）

## Phase 1 — 本地 MVP（本次）

**Coffee**：豆子列表/新增/编辑/删除、详情、冲煮记录、品鉴记录、风味阶段、库存规则。
**Records**：四种载体、搜索 + 载体 + 标签筛选、详情、图片导入与本地持久化。
**Canvas**：无限画布（平移/缩放）、节点显示/拖动/选中、从 Records 添加、持久化。

明确未做：手绘工具、连线、分组、视频播放器、同步服务。

## Phase 2 — 局域网同步

1. 本地 HTTP 服务 + Bonjour 广播 + 二维码配对（一次性码、token、签名、nonce）。
2. 全量快照 → 增量 change log → 断线重连。
3. 媒体按块传输 + SHA-256 校验 + 断点续传。
4. 冲突上报（keepLocal / keepRemote / mergeLater），不做静默 LWW。
5. 设备撤销与审计。

## Phase 3 — 媒体与提醒

- 视频节点内嵌播放（复用 iOS 的播放器决策，不自动播放）。
- 提醒意图落地为系统通知（macOS/Windows 各自的调度）。
- 链接元数据抓取（标题/封面/作者），与 iOS 的抓取规则对齐。

## Phase 4 — 画布工具

- 手绘（pen/eraser）、颜色与笔宽、撤销/重做。
- 框选与多选、图层/节点管理、右侧属性检查器扩展。
- 分组区域、连接线。
- **前提**：iOS 端补上 `CanvasStroke` 模型与渲染，否则不宣称跨端可见。

## Phase 5 — 打包与发布

- macOS 签名/公证，Windows 安装包签名。
- 自动更新（差分）。
- 崩溃与日志上报（本地优先，可关闭）。
