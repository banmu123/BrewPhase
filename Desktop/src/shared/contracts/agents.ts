import { z } from 'zod'

/**
 * AI Agent 自动配置的共享契约。
 *
 * 只放**形状**：检测结果、写入预览、写入结果。
 * 真正的检测与写盘都在主进程完成，Renderer 拿不到路径也不能指定路径——
 * 目标位置永远由主进程的 Adapter 依据官方约定的目录解析。
 */

export const AGENT_KINDS = ['workbuddy', 'codex'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]
export const agentKindSchema = z.enum(AGENT_KINDS)

export const AGENT_BLOCKED_REASONS = [
  'agent_not_detected',
  'config_path_unknown',
  'permission_denied',
  'invalid_config',
  'unsupported_platform'
] as const
export type AgentBlockedReason = (typeof AGENT_BLOCKED_REASONS)[number]

export type AgentDetection = {
  kind: AgentKind
  displayName: string
  executablePath: string | null
  configPath: string | null
  configExists: boolean
  configDirExists: boolean
  hasBrewphaseEntry: boolean
  /** 已有条目是否指向当前这套入口（路径 + 数据目录都对得上）。 */
  matchesCurrentEntry: boolean
  canAutoConfigure: boolean
  blockedReason: AgentBlockedReason | null
}

export type AgentConfigPlan = {
  kind: AgentKind
  displayName: string
  configPath: string
  format: 'toml' | 'json'
  serverName: string
  /** 已存在同名条目：必须由用户明确同意替换。 */
  conflict: boolean
  backupPath: string
  /** 预览片段；Token 用占位符，绝不含明文。 */
  preview: string
  requiresRestart: boolean
}

/** 自动配置成功后的返回。**不含 Token**——它已经写进配置文件了。 */
export type AgentConfigApplied = {
  kind: AgentKind
  clientId: string
  clientName: string
  configPath: string
  backupPath: string | null
  requiresRestart: boolean
}

export type AgentConfigFailure = {
  kind: AgentKind
  /** 已经尽量回滚；true 表示原文件已恢复。 */
  rolledBack: boolean
  /** 是否连回滚都失败了——这种情况下必须让人看见。 */
  rollbackFailed: boolean
  configPath: string
  backupPath: string | null
}

/** 自动配置的返回：成功带 Client 元信息，失败带可回滚状态。 */
export type AgentApplyOutcome =
  | ({ ok: true } & AgentConfigApplied)
  | {
      ok: false
      kind: AgentKind
      configPath: string
      backupPath: string | null
      rollbackFailed: boolean
    }
