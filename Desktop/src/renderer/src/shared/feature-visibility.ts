/**
 * 暂不对外开放的功能入口。
 *
 * 这些功能的**代码与测试都是完整的**（Remote MCP：R5-R3.4；Cloud Account：
 * test 分支已集成），只是产品节奏上先收起来。屏蔽的是设置页入口与工作室
 * 的账号徽章这类**界面入口**——主进程行为不动，已登录的会话与已配对的
 * 设备不受影响；要彻底断开云端连接，需要在主进程侧另行处理。
 *
 * 放开时把对应常量改回 `true` 即可；不要直接删除区块代码。
 */
export const REMOTE_ACCESS_VISIBLE = false
export const CLOUD_ACCOUNT_VISIBLE = false
