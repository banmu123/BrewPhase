# 架构

## 1. 三个进程，三套权限

| 进程 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| main | 开 SQLite、读媒体文件、开系统对话框、注册自定义协议、校验 IPC | 不渲染界面 |
| preload | 用 `contextBridge` 暴露白名单 API | 不暴露 `ipcRenderer`、不暴露 Node |
| renderer | React + Konva 渲染、调用 `window.brewphase.*` | 不碰文件系统、不碰数据库、不发任意 IPC |

窗口配置固定为 `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`，
外链一律 `shell.openExternal`，窗口内不允许导航到外部站点。详见 `SECURITY_MODEL.md`。

## 2. 目录职责

```
src/main/database/schema.ts         Drizzle 表定义（唯一的表结构真相）
src/main/database/migrations.ts     手写 DDL + user_version 迁移
src/main/database/client.ts         开库、pragma、迁移、deviceId
src/main/database/repositories/     业务读写（事务边界都在这里）
src/main/ipc/register.ts            通道注册 + zod 校验 + sender 校验
src/main/media/store.ts             图片导入（nativeImage 缩放）、媒体协议
src/shared/contracts/               zod 契约 + 类型（main 与 renderer 共用）
src/shared/domain/                  纯逻辑：库存、阶段、落位
src/renderer/src/features/          三个业务模块 + 更多
tests/unit | integration | e2e     纯逻辑 / 真库 / 真应用
```

`src/shared` 里**不允许**出现 `electron`、`node:fs`、`better-sqlite3`：它同时被
renderer 打包，一旦引入就会在渲染进程里报错。

## 3. 数据流

```
界面操作 → window.brewphase.<method>() → ipcRenderer.invoke
        → 主进程 zod 校验 + sender 校验 → repository（一个事务）
        → SQLite（业务表 + sync_meta + change_log 同事务）
        → 返回值 → 界面刷新自己那一份 state
```

界面**不缓存跨模块数据**：Coffee / Records / Canvas 各自取、各自刷新。全局 store
只有导航状态，避免「两处缓存同一个字段、改一处另一处过期」。

## 4. 迁移策略

- 迁移是数组 + `PRAGMA user_version`，每版一个事务，失败即回滚并让应用停下。
- 只追加，不改已发布版本。
- 打包后不依赖任何 `.sql` 文件路径（asar 里路径会变），DDL 内联在 TS 里。
- `drizzle.config.ts` 只在开发期用于 schema 对比，不参与启动。

## 5. 为什么不用「一个巨大的 App 组件」

三个模块各有自己的数据、表单与刷新节奏；共享的只有外壳与样式。拆分边界按
**业务能力**，不是按「页面」。表单与 inspector 各自成组件，避免一个文件里既查库
又排版又做校验。

## 6. 已知约束

- `better-sqlite3` 是原生模块：**Node（vitest）与 Electron 的 ABI 不同**。跑单测用
  Node 构建，跑应用/E2E 前需要为本机 Electron 重新构建（见 README 的两步命令）。
- Phase 1 的画布视口不落库：重进画布按内容包围盒重新装窗（与 iOS 1.1 的行为一致）。
- 图片解码用 Electron `nativeImage`，不引入 sharp；HEIC 之类解码不了的格式会明确报错。
