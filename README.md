# BrewPhase

本地优先的咖啡记录与风味分析应用。Local-first coffee logging & flavour analysis.

记录每一包豆，看到风味怎么变化——阶段判断、冲煮记录、个人规律，全部在你的设备上，不联网也能完整使用。

Log every bag and watch its flavour move — phase tracking, brew logs and personal patterns, all on your device, fully offline.

## 桌面端 / Desktop

桌面协同版（Coffee / Records / Canvas，Electron + SQLite）在 [`Desktop/`](Desktop/README.md)。

The desktop companion (Coffee / Records / Canvas, Electron + SQLite) lives in [`Desktop/`](Desktop/README.md).

## MCP（AI Action Gateway）

让 Codex、WorkBuddy 等 MCP 客户端在逐客户端授权下读写 BrewPhase（本地 Bridge，
不暴露公网；无 SQL / 文件系统 / 删除权限）。

完整配置步骤与可复制的 `config.toml` / `mcp.json` **在 [`Desktop/README.md`](Desktop/README.md#mcpai-action-gateway)** 的「MCP（AI Action Gateway）」章节：

- [`desktop/mcp architecture`](Desktop/docs/MCP_ARCHITECTURE.md) · 进程模型与 Bridge
- [`MCP tools`](Desktop/docs/MCP_TOOLS.md) · 18 个工具与 scope 映射
- [`MCP security`](Desktop/docs/MCP_SECURITY.md) · token / scope / 审计 / 错误码

## 隐私政策 / Privacy Policy

- [BrewPhase 隐私政策 / Privacy Policy](https://banmu123.github.io/BrewPhase/privacy.html)

该页面由本仓库 `docs/` 目录经 GitHub Pages 发布；如尚未启用 Pages，请先在仓库 Settings → Pages 中选择 main 分支的 `/docs` 目录。

The page is served from this repository's `docs/` folder via GitHub Pages; if Pages is not yet enabled, select the `/docs` folder of the `main` branch in Settings → Pages.
