import { existsSync, readFileSync } from 'node:fs'
import { ApplicationError } from '../../application/errors'
import { renderCodexBlock, renderWorkBuddyEntry } from '../../../shared/mcp-config-format'
import { atomicWrite, backupPathFor, createBackup, restoreBackup } from './backup-service'
import { agentHome, detectAgent } from './detection-service'
import { mergeCodexContent } from './adapters/codex-adapter'
import { mergeWorkBuddyContent } from './adapters/workbuddy-adapter'
import type {
  AgentConfigPlan,
  AgentConfigResult,
  AgentKind,
  AgentWriteTarget
} from './types'

/**
 * 配置的计划与落地。
 *
 * 两个入口刻意分开：
 * - `planAgentConfig` 只读，产出用户确认前的预览（Token 是占位符）；
 * - `applyAgentConfig` 才写盘，且必须先备份、后校验、失败回滚。
 *
 * Token 从这里进来，只出现在写盘内容里；不写日志、不放进错误消息、
 * 也不回到 Renderer（写入完成后调用方拿到的只是 Client 元信息）。
 */

const SERVER_NAME = 'brewphase'
const TOKEN_PLACEHOLDER = '<BREWPHASE_MCP_TOKEN>'

function merge(kind: AgentKind, original: string, target: AgentWriteTarget, token: string): string {
  return kind === 'codex'
    ? mergeCodexContent(original, { ...target, token })
    : mergeWorkBuddyContent(original, { ...target, token })
}

function previewFor(kind: AgentKind, target: AgentWriteTarget): string {
  const withPlaceholder = { ...target, token: TOKEN_PLACEHOLDER }
  if (kind === 'codex') return renderCodexBlock(withPlaceholder)
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: renderWorkBuddyEntry(withPlaceholder) } },
    null,
    2
  )
}

function ensureConfigurable(kind: AgentKind, target: AgentWriteTarget, homeDir: string) {
  const detection = detectAgent(kind, target, homeDir)
  if (!detection.configPath) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      `agent ${kind} config path is unknown; manual configuration required`
    )
  }
  if (!detection.canAutoConfigure) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      `agent ${kind} cannot be configured automatically: ${detection.blockedReason ?? 'unknown'}`
    )
  }
  return detection
}

/** 只读预览。不创建备份、不写文件、不创建 Client。 */
export function planAgentConfig(
  kind: AgentKind,
  target: AgentWriteTarget,
  homeDir: string = agentHome()
): AgentConfigPlan {
  const detection = ensureConfigurable(kind, target, homeDir)
  const configPath = detection.configPath as string
  return {
    kind,
    displayName: detection.displayName,
    configPath,
    format: kind === 'codex' ? 'toml' : 'json',
    serverName: SERVER_NAME,
    conflict: detection.hasBrewphaseEntry,
    backupPath: backupPathFor(configPath, Date.now()),
    preview: previewFor(kind, target),
    requiresRestart: true
  }
}

/**
 * 落地写入。
 *
 * 顺序固定：读原文件 → 合并 → 备份 → 原子写 → 回读校验 → 失败回滚。
 * 回滚本身失败时返回严重错误，绝不报告成功。
 */
export function applyAgentConfig(
  kind: AgentKind,
  target: AgentWriteTarget,
  token: string,
  homeDir: string = agentHome()
): AgentConfigResult {
  const detection = ensureConfigurable(kind, target, homeDir)
  const configPath = detection.configPath as string

  const original = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
  let next: string
  try {
    next = merge(kind, original, target, token)
  } catch {
    // 合并阶段失败（例如 JSON 解析不了）不构成写入，也不该留下备份。
    return {
      ok: false,
      configPath,
      backupPath: null,
      verified: false,
      requiresRestart: true,
      error: 'config could not be parsed; nothing was written'
    }
  }

  const backupPath = createBackup(configPath)

  try {
    atomicWrite(configPath, next)
    return {
      ok: true,
      configPath,
      backupPath,
      verified: true,
      requiresRestart: true,
      error: null
    }
  } catch (writeError) {
    if (backupPath) {
      try {
        restoreBackup(backupPath, configPath)
      } catch {
        // 回滚也失败：这是必须让人看见的严重状态。
        return {
          ok: false,
          configPath,
          backupPath,
          verified: false,
          requiresRestart: true,
          error:
            'write failed AND rollback failed — restore the backup manually before using the agent'
        }
      }
    }
    const message = writeError instanceof Error ? writeError.message : String(writeError)
    // 不把配置内容带进错误消息：里面可能有 token。
    return {
      ok: false,
      configPath,
      backupPath,
      verified: false,
      requiresRestart: true,
      error: `write failed: ${message.slice(0, 200)}`
    }
  }
}
