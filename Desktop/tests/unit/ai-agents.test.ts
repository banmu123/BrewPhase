import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  analyzeCodexConfig,
  codexEntryMatches,
  detectCodex,
  mergeCodexContent
} from '../../src/main/integrations/ai-agents/adapters/codex-adapter'
import {
  analyzeWorkBuddyConfig,
  mergeWorkBuddyContent
} from '../../src/main/integrations/ai-agents/adapters/workbuddy-adapter'
import { detectAgent } from '../../src/main/integrations/ai-agents/detection-service'
import { applyAgentConfig, planAgentConfig } from '../../src/main/integrations/ai-agents/config-service'
import { backupPathFor, createBackup, restoreBackup } from '../../src/main/integrations/ai-agents/backup-service'

/**
 * Agent 自动配置的核心不变量：
 * - 只碰 brewphase 这一段，其他 MCP Server 与用户注释原样保留；
 * - 解析不了的文件绝不写入（JSONC / 非标准 TOML 一律退回手动）；
 * - 写之前有备份，失败能回滚；
 * - 预览里不出现明文 Token。
 */

let home: string

const TARGET = {
  entryPath: '/opt/BrewPhase/resources/mcp/stdio.mjs',
  userDataDir: '/home/u/.config/BrewPhase'
}

const CODEX_ORIGINAL = `# 我自己的注释，不能被删
model = "o3"

[mcp_servers.other]
command = "other-server"
args = ["--flag"]
`

const WORKBUDDY_ORIGINAL = JSON.stringify(
  {
    mcpServers: {
      other: { command: 'other-server', args: [] }
    },
    theme: 'dark'
  },
  null,
  2
)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bp-ai-agents-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('Codex：段落级合并', () => {
  it('新增 brewphase 时保留注释与其他 Server', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    const configPath = join(home, '.codex', 'config.toml')
    writeFileSync(configPath, CODEX_ORIGINAL, 'utf-8')

    const result = applyAgentConfig('codex', TARGET, 'tok_secret', home)
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(true)

    const after = readFileSync(configPath, 'utf-8')
    expect(after).toContain('[mcp_servers.brewphase]')
    expect(after).toContain('BREWPHASE_MCP_TOKEN = "tok_secret"')
    // 原有内容一个不少
    expect(after).toContain('# 我自己的注释，不能被删')
    expect(after).toContain('model = "o3"')
    expect(after).toContain('[mcp_servers.other]')
    expect(after).toContain('command = "other-server"')
  })

  it('已有 brewphase 时替换整段，不产生重复表头', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    const configPath = join(home, '.codex', 'config.toml')
    const first = mergeCodexContent(CODEX_ORIGINAL, { ...TARGET, token: 'old' })
    writeFileSync(configPath, first, 'utf-8')

    const result = applyAgentConfig('codex', TARGET, 'new', home)
    expect(result.ok).toBe(true)

    const after = readFileSync(configPath, 'utf-8')
    expect(after.match(/\[mcp_servers\.brewphase\]/g)).toHaveLength(1)
    expect(after).toContain('BREWPHASE_MCP_TOKEN = "new"')
    expect(after).not.toContain('"old"')
  })

  it('非标准 brewphase 写法（内联表）拒绝合并', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    const configPath = join(home, '.codex', 'config.toml')
    const inline = '[mcp_servers]\nbrewphase = { command = "node" }\n'
    writeFileSync(configPath, inline, 'utf-8')

    const analysis = analyzeCodexConfig(configPath)
    expect(analysis.mergeable).toBe(false)

    const detection = detectAgent('codex', TARGET, home)
    expect(detection.canAutoConfigure).toBe(false)
    expect(detection.blockedReason).toBe('invalid_config')

    // 文件必须原封不动
    expect(readFileSync(configPath, 'utf-8')).toBe(inline)
  })

  it('配置文件不存在时安全创建', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    const configPath = join(home, '.codex', 'config.toml')
    expect(existsSync(configPath)).toBe(false)

    const result = applyAgentConfig('codex', TARGET, 'tok', home)
    expect(result.ok).toBe(true)
    expect(result.backupPath).toBeNull()
    expect(readFileSync(configPath, 'utf-8')).toContain('[mcp_servers.brewphase]')
  })

  it('既没装也找不到配置目录时，判定为未检测到', () => {
    // 直接测 adapter：detectAgent 会去查 PATH，本机可能真的装着 codex。
    const detection = detectCodex(null, TARGET, home)
    expect(detection.canAutoConfigure).toBe(false)
    expect(detection.blockedReason).toBe('agent_not_detected')
  })

  it('装了 Agent 但配置目录不存在时，判定为路径未知（不是"未安装"）', () => {
    const detection = detectCodex('/usr/local/bin/codex', TARGET, home)
    expect(detection.blockedReason).toBe('config_path_unknown')
    expect(() => planAgentConfig('codex', TARGET, home)).toThrow()
  })

  it('入口匹配判断能区分"已配置且指向这里"与"配的是别处"', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    const configPath = join(home, '.codex', 'config.toml')
    writeFileSync(configPath, mergeCodexContent('', { ...TARGET, token: 't' }), 'utf-8')

    expect(codexEntryMatches(TARGET.entryPath, TARGET.userDataDir, configPath)).toBe(true)
    expect(codexEntryMatches('/somewhere/else/stdio.mjs', TARGET.userDataDir, configPath)).toBe(false)
  })
})

describe('WorkBuddy：JSON 合并', () => {
  it('保留其他 Server 与顶层键', () => {
    mkdirSync(join(home, '.workbuddy'), { recursive: true })
    const configPath = join(home, '.workbuddy', 'mcp.json')
    writeFileSync(configPath, WORKBUDDY_ORIGINAL, 'utf-8')

    const result = applyAgentConfig('workbuddy', TARGET, 'tok_secret', home)
    expect(result.ok).toBe(true)

    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>
      theme: string
    }
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(['brewphase', 'other'])
    expect(parsed.theme).toBe('dark')
  })

  it('同名条目算冲突，但仍可显式替换', () => {
    mkdirSync(join(home, '.workbuddy'), { recursive: true })
    const configPath = join(home, '.workbuddy', 'mcp.json')
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { brewphase: { command: 'old' } } }, null, 2),
      'utf-8'
    )

    expect(analyzeWorkBuddyConfig(configPath).conflict).toBe(true)
    const plan = planAgentConfig('workbuddy', TARGET, home)
    expect(plan.conflict).toBe(true)

    const result = applyAgentConfig('workbuddy', TARGET, 'tok', home)
    expect(result.ok).toBe(true)
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      mcpServers: Record<string, { command: string }>
    }
    expect(parsed.mcpServers.brewphase.command).toBe('node')
  })

  it('JSONC（带注释）判为不可合并，且不改文件', () => {
    mkdirSync(join(home, '.workbuddy'), { recursive: true })
    const configPath = join(home, '.workbuddy', 'mcp.json')
    const jsonc = '{\n  // 用户注释\n  "mcpServers": {}\n}\n'
    writeFileSync(configPath, jsonc, 'utf-8')

    expect(analyzeWorkBuddyConfig(configPath).mergeable).toBe(false)
    const detection = detectAgent('workbuddy', TARGET, home)
    expect(detection.blockedReason).toBe('invalid_config')

    expect(() => applyAgentConfig('workbuddy', TARGET, 'tok', home)).toThrow()
    expect(readFileSync(configPath, 'utf-8')).toBe(jsonc)
  })

  it('文件不存在时创建最小结构', () => {
    mkdirSync(join(home, '.workbuddy'), { recursive: true })
    const configPath = join(home, '.workbuddy', 'mcp.json')

    const result = applyAgentConfig('workbuddy', TARGET, 'tok', home)
    expect(result.ok).toBe(true)
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(parsed.mcpServers)).toEqual(['brewphase'])
  })
})

describe('备份与回滚', () => {
  it('写入前生成带时间戳的备份，内容与原文一致', () => {
    mkdirSync(join(home, '.workbuddy'), { recursive: true })
    const configPath = join(home, '.workbuddy', 'mcp.json')
    writeFileSync(configPath, WORKBUDDY_ORIGINAL, 'utf-8')

    const backup = createBackup(configPath, 1_700_000_000_000)
    expect(backup).toBe(backupPathFor(configPath, 1_700_000_000_000))
    expect(readFileSync(backup as string, 'utf-8')).toBe(WORKBUDDY_ORIGINAL)
  })

  it('回滚能把原文写回去', () => {
    mkdirSync(join(home, '.workbuddy'), { recursive: true })
    const configPath = join(home, '.workbuddy', 'mcp.json')
    writeFileSync(configPath, WORKBUDDY_ORIGINAL, 'utf-8')
    const backup = createBackup(configPath) as string

    writeFileSync(configPath, '{"corrupted":true}', 'utf-8')
    restoreBackup(backup, configPath)

    expect(readFileSync(configPath, 'utf-8')).toBe(WORKBUDDY_ORIGINAL)
  })
})

describe('预览不含明文 Token', () => {
  it('计划里用占位符，且列出真实配置路径', () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    const plan = planAgentConfig('codex', TARGET, home)

    expect(plan.preview).toContain('<BREWPHASE_MCP_TOKEN>')
    expect(plan.preview).not.toContain('tok_')
    expect(plan.configPath).toContain('config.toml')
    expect(plan.format).toBe('toml')
    expect(plan.serverName).toBe('brewphase')
  })
})
