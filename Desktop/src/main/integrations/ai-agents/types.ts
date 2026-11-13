/**
 * Main 侧的 Agent 配置类型。
 *
 * 对外形状（Renderer 能看到的）统一放在 `shared/contracts/agents.ts`，
 * 这里只做两件事：转出那些类型，并定义**只在主进程内部使用**的写入结果。
 * 两份定义并存迟早会分叉，所以这里不再重复声明。
 */

export type {
  AgentBlockedReason,
  AgentConfigPlan,
  AgentDetection,
  AgentKind
} from '../../../shared/contracts/agents'
export { AGENT_KINDS } from '../../../shared/contracts/agents'

/** 写盘结果：只在主进程与 IPC handler 之间传递。 */
export type AgentConfigResult = {
  ok: boolean
  configPath: string
  backupPath: string | null
  /** 写入后回读校验是否通过。 */
  verified: boolean
  requiresRestart: boolean
  error: string | null
}

/** 写入目标；由主进程依据 bridge 状态解析，Renderer 不传路径。 */
export type AgentWriteTarget = {
  entryPath: string
  userDataDir: string
}
