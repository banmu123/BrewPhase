import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { escapeTomlString, renderCodexBlock } from '../../../../shared/mcp-config-format'
import type { AgentBlockedReason, AgentDetection } from '../types'

/**
 * Codex 适配器。
 *
 * 配置位置：`~/.codex/config.toml`（Codex CLI 0.154 实测读取此文件）。
 *
 * 为什么不用 `codex mcp add --env`：那条命令把 token 放进进程参数，
 * 同机其他进程与 shell history 都能看到。规格禁止，所以走受控 TOML 合并。
 *
 * 合并只做「段落级替换」：定位 `[mcp_servers.brewphase]` 及其子表，
 * 整段替换为新内容，其余文本一个字节都不动——包括用户注释与其他 MCP Server。
 * 若文件里出现 brewphase 但不是标准表头写法（例如内联表），拒绝写入。
 */

const SERVER_NAME = 'brewphase'

export function codexConfigPath(homeDir: string = homedir()): string {
  return join(homeDir, '.codex', 'config.toml')
}

export function codexConfigDir(homeDir: string = homedir()): string {
  return join(homeDir, '.codex')
}

type Region = { start: number; end: number }

/** 表头行：`[mcp_servers.brewphase]` 或 `[mcp_servers.brewphase.xxx]`。 */
const BREWPHASE_HEADER = /^\[mcp_servers\.brewphase(\.[^\]]+)?\]$/

/**
 * 找出属于 brewphase 的连续区段。
 *
 * 一个区段从表头行开始，到**下一个表头**为止——所以 `[...brewphase]`
 * 后面紧跟 `[...brewphase.env]` 时会被切成两段，两段都会被删掉，正是我们
 * 想要的结果。
 */
function findBrewphaseRegions(lines: string[]): Region[] {
  const regions: Region[] = []
  let index = 0
  while (index < lines.length) {
    if (BREWPHASE_HEADER.test(lines[index].trim())) {
      const start = index
      let end = index + 1
      while (end < lines.length) {
        const next = lines[end].trim()
        if (next.startsWith('[') && next.endsWith(']')) break
        end += 1
      }
      regions.push({ start, end })
      index = end
      continue
    }
    index += 1
  }
  return regions
}

/** 出现了 brewphase 字样但不符合标准表头 → 不能安全合并。 */
function hasNonStandardEntry(content: string): boolean {
  if (findBrewphaseRegions(content.split('\n')).length > 0) return false
  // `brewphase = {...}` 内联表，或 `[mcp_servers]` 段下的键
  return /^\s*brewphase\s*=/m.test(content) || /mcp_servers\s*\.\s*brewphase/i.test(content)
}

export type CodexAnalysis = {
  exists: boolean
  hasEntry: boolean
  /** false 表示文件里有 brewphase 但不是标准写法，必须拒绝自动写入。 */
  mergeable: boolean
  conflict: boolean
}

export function analyzeCodexConfig(configPath: string = codexConfigPath()): CodexAnalysis {
  if (!existsSync(configPath)) {
    return { exists: false, hasEntry: false, mergeable: true, conflict: false }
  }
  const content = readFileSync(configPath, 'utf-8')
  const hasEntry = findBrewphaseRegions(content.split('\n')).length > 0
  const mergeable = !hasNonStandardEntry(content)
  return { exists: true, hasEntry, mergeable, conflict: hasEntry }
}

/** 已有条目是否指向当前这套入口（路径与数据目录都对得上）。 */
export function codexEntryMatches(
  entryPath: string,
  userDataDir: string,
  configPath: string = codexConfigPath()
): boolean {
  if (!existsSync(configPath)) return false
  const content = readFileSync(configPath, 'utf-8')
  const lines = content.split('\n')
  const regions = findBrewphaseRegions(lines)
  if (regions.length === 0) return false
  const text = regions.map((r) => lines.slice(r.start, r.end).join('\n')).join('\n')
  return (
    text.includes(escapeTomlString(entryPath)) && text.includes(escapeTomlString(userDataDir))
  )
}

/**
 * 段落级合并：删掉旧 brewphase 段（可能不止一个），在文件末尾追加新段。
 * 其余内容原样保留。
 */
export function mergeCodexContent(
  content: string,
  params: { entryPath: string; userDataDir: string; token: string }
): string {
  const lines = content.split('\n')
  const regions = findBrewphaseRegions(lines)

  const kept: string[] = []
  let cursor = 0
  for (const region of regions) {
    kept.push(...lines.slice(cursor, region.start))
    cursor = region.end
  }
  kept.push(...lines.slice(cursor))

  const remaining = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd()
  const block = renderCodexBlock(params)

  if (remaining.length === 0) return `${block}\n`
  return `${remaining}\n\n${block}\n`
}

/** 只读地检查是否可写；不修改任何东西。 */
function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 组装检测结果。`executablePath` 由 detection-service 用 PATH 查找后传入，
 * 这里只负责配置侧的事实。
 */
export function detectCodex(
  executablePath: string | null,
  target: { entryPath: string; userDataDir: string } | null = null,
  homeDir: string = homedir()
): AgentDetection {
  const configPath = codexConfigPath(homeDir)
  const dirExists = existsSync(codexConfigDir(homeDir))
  const configExists = existsSync(configPath)

  let blocked: AgentBlockedReason | null = null
  let hasEntry = false
  let matches = false
  let writable = false

  if (!dirExists) {
    blocked = executablePath ? 'config_path_unknown' : 'agent_not_detected'
  } else if (configExists) {
    try {
      const analysis = analyzeCodexConfig(configPath)
      hasEntry = analysis.hasEntry
      writable = isWritable(configPath)
      if (!analysis.mergeable) blocked = 'invalid_config'
      else if (!writable) blocked = 'permission_denied'
      // 只有拿到当前入口信息时才谈得上「已配置且指向这里」。
      matches = hasEntry && target
        ? codexEntryMatches(target.entryPath, target.userDataDir, configPath)
        : false
    } catch {
      blocked = 'invalid_config'
    }
  } else {
    // 目录在、文件不在：可以安全创建，前提是目录可写。
    writable = isWritable(codexConfigDir(homeDir))
    if (!writable) blocked = 'permission_denied'
  }

  return {
    kind: 'codex',
    displayName: 'Codex',
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

/** 供 config-service 判断文件大小，避免误读一个巨大的非配置文件。 */
export function isPlausibleConfigFile(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size < 2 * 1024 * 1024
  } catch {
    return false
  }
}
