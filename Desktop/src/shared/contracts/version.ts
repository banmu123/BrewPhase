/**
 * 版本号是**契约**的一部分：数据库 schema、IPC 契约、同步协议各自独立演进。
 * 任何一端不匹配都要能被显式拒绝，而不是靠字段缺省值蒙混过去。
 */
export const APP_VERSION = '0.1.0'

/** 本地 SQLite 的 schema 版本。与 `migrations.ts` 里的迁移序号一一对应。 */
export const DB_SCHEMA_VERSION = 1

/** 局域网同步协议版本。v1 只定义结构，不实现传输。 */
export const SYNC_PROTOCOL_VERSION = 1

/** 同步元数据里记录「这条数据由谁产生」。 */
export const DEVICE_KIND = ['ios', 'desktop'] as const
export type DeviceKind = (typeof DEVICE_KIND)[number]
