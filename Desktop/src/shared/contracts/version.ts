/**
 * 应用版本**没有**这里的副本——事实来源是 `package.json` 的 `version` 字段，
 * 运行时一律通过 Electron `app.getVersion()` 读取（打包后来自 Info.plist）。
 *
 * 过去这里曾硬编码一份 `APP_VERSION`，两处并存必然漂移：0.2.0 发版时
 * package.json 已升、常量停在 0.1.4，导致更新比较把自己当成旧版（永远提示
 * 更新）且设置页显示错版本。需要版本号的地方：主进程用 `app.getVersion()`，
 * Renderer 从 `IPC.appInfo` 的 `appVersion` 拿（主进程填的同一来源），
 * MCP Bridge / Chrome Native Host 由主进程在构造时注入同一个值——都不留副本。
 *
 * 本文件剩下的都是**协议/存储层**的版本：它们与包版本独立演进，各自显式声明。
 */

/** 本地 SQLite 的 schema 版本。与 `migrations.ts` 里的迁移序号一一对应。 */
export const DB_SCHEMA_VERSION = 1

/** 局域网同步协议版本。v1 只定义结构，不实现传输。 */
export const SYNC_PROTOCOL_VERSION = 1

/** 同步元数据里记录「这条数据由谁产生」。 */
export const DEVICE_KIND = ['ios', 'desktop'] as const
export type DeviceKind = (typeof DEVICE_KIND)[number]
