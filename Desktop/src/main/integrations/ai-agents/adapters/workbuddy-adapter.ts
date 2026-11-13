import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renderWorkBuddyEntry } from '../../../../shared/mcp-config-format'
import type { AgentBlockedReason, AgentDetection } from '../types'

/**
 * WorkBuddy 适配器。
 *
 * 配置位置：`~/.workbuddy/mcp.json`（当前桌面版实测读取；结构为
 * `{ "mcpServers": { "<name>": {...} } }`）。
 *
 * 关于 JSONC：实测本机文件是严格 JSON。这里**只接受能通过 JSON.parse 的
 * 内容**——遇到注释或尾逗号时直接判为 invalid_config 并回退手动配置。
 * 不写正则去"清洗"注释：那正是会悄悄改坏用户其他 MCP 配置的做法。
 */

const SERVER_NAME = 'brewphase'

export function workbuddyConfigPath(homeDir: string = homedir()): string {
  return join(homeDir, '.workbuddy', 'mcp.json')
}

export function workbuddyConfigDir(homeDir: string = homedir()): string {
  return join(homeDir, '.workbuddy')
}

type WorkBuddyFile = { mcpServers?: Record<string, unknown> } & Record<string, unknown>

export type WorkBuddyAnalysis = {
  exists: boolean
  hasEntry: boolean
  /** 解析失败（含 JSONC）时为 false。 */
  mergeable: boolean
  conflict: boolean
}

function parse(content: string): WorkBuddyFile | null {
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as WorkBuddyFile
  } catch {
    return null
  }
}

export function analyzeWorkBuddyConfig(
  configPath: string = workbuddyConfigPath()
): WorkBuddyAnalysis {
  if (!existsSync(configPath)) {
    return { exists: false, hasEntry: false, mergeable: true, conflict: false }
  }
  const parsed = parse(readFileSync(configPath, 'utf-8'))
  if (!parsed) return { exists: true, hasEntry: false, mergeable: false, conflict: false }

  const servers = parsed.mcpServers
  const hasEntry =
    typeof servers === 'object' && servers !== null && SERVER_NAME in servers
  return { exists: true, hasEntry, mergeable: true, conflict: hasEntry }
}

/** 已有条目是否指向当前这套入口。 */
export function workbuddyEntryMatches(
  entryPath: string,
  userDataDir: string,
  configPath: string = workbuddyConfigPath()
): boolean {
  if (!existsSync(configPath)) return false
  const parsed = parse(readFileSync(configPath, 'utf-8'))
  const entry = parsed?.mcpServers?.[SERVER_NAME] as
    | { args?: unknown; env?: Record<string, unknown> }
    | undefined
  if (!entry) return false
  const args = Array.isArray(entry.args) ? entry.args : []
  const env = entry.env ?? {}
  return args[0] === entryPath && env.BREWPHASE_MCP_USER_DATA_DIR === userDataDir
}

/**
 * 合并：只替换 `mcpServers.brewphase`，其余 key 原样保留。
 * 文件不存在时创建最小结构。
 */
export function mergeWorkBuddyContent(
  content: string,
  params: { entryPath: string; userDataDir: string; token: string }
): string {
  const base: WorkBuddyFile = content.trim().length === 0 ? {} : (parse(content) ?? {})
  const servers =
    typeof base.mcpServers === 'object' && base.mcpServers !== null ? base.mcpServers : {}

  const merged: WorkBuddyFile = {
    ...base,
    mcpServers: {
      ...servers,
      [SERVER_NAME]: renderWorkBuddyEntry(params)
    }
  }
  return `${JSON.stringify(merged, null, 2)}\n`
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function detectWorkBuddy(
  executablePath: string | null,
  target: { entryPath: string; userDataDir: string } | null = null,
  homeDir: string = homedir()
): AgentDetection {
  const configPath = workbuddyConfigPath(homeDir)
  const dirExists = existsSync(workbuddyConfigDir(homeDir))
  const configExists = existsSync(configPath)

  let blocked: AgentBlockedReason | null = null
  let hasEntry = false
  let matches = false

  if (!dirExists) {
    // 没有 ~/.workbuddy：要么没装，要么版本用的是别的目录。不猜，交给手动。
    blocked = executablePath ? 'config_path_unknown' : 'agent_not_detected'
  } else if (configExists) {
    const analysis = analyzeWorkBuddyConfig(configPath)
    hasEntry = analysis.hasEntry
    if (!analysis.mergeable) blocked = 'invalid_config'
    else if (!isWritable(configPath)) blocked = 'permission_denied'
    matches =
      hasEntry && target
        ? workbuddyEntryMatches(target.entryPath, target.userDataDir, configPath)
        : false
  } else if (!isWritable(workbuddyConfigDir(homeDir))) {
    blocked = 'permission_denied'
  }

  return {
    kind: 'workbuddy',
    displayName: 'WorkBuddy',
    executablePath,
    configPath,
    configExists,
    configDirExists: dirExists,
    hasBrewphaseEntry: hasEntry,
    matchesCurrentEntry: matches,
    canAutoConfigure: blocked === null,
    blockedReason: blocked
  }
}
