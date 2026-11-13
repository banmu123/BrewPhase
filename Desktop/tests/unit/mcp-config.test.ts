import { describe, expect, it } from 'vitest'
import {
  codexConfig,
  configTargetFrom,
  genericConfig,
  workbuddyConfig
} from '../../src/renderer/src/features/settings/mcp-config'

/**
 * MCP 配置生成器。
 *
 * 这些字符串会被用户原样粘进 Agent 的配置文件，所以「看起来很对」不够：
 * Windows 路径里的反斜杠在 TOML 中是转义符，漏转义会让整份配置解析失败；
 * JSON 那边则要保证结构可被客户端直接 merge。
 */

const WINDOWS_TARGET = {
  entryPath: 'C:\\Program Files\\BrewPhase\\resources\\mcp\\stdio.mjs',
  userDataDir: 'C:\\Users\\me\\AppData\\Roaming\\BrewPhase'
}

const POSIX_TARGET = {
  entryPath: '/Applications/BrewPhase.app/Contents/Resources/mcp/stdio.mjs',
  userDataDir: '/Users/me/Library/Application Support/BrewPhase'
}

describe('codexConfig', () => {
  it('生成 TOML 的 mcp_servers 段落', () => {
    const toml = codexConfig(POSIX_TARGET, 'tok_123')
    expect(toml.startsWith('[mcp_servers.brewphase]')).toBe(true)
    expect(toml).toContain('command = "node"')
    expect(toml).toContain('BREWPHASE_MCP_TOKEN = "tok_123"')
    expect(toml).toContain('BREWPHASE_MCP_USER_DATA_DIR = "/Users/me')
  })

  it('Windows 反斜杠成对转义，不留下裸 \\U 之类', () => {
    const toml = codexConfig(WINDOWS_TARGET, 'tok')
    // 每个反斜杠都要写成两个，否则 TOML 会把 \U 当 Unicode 转义。
    expect(toml).toContain('C:\\\\Program Files\\\\BrewPhase')
    expect(toml).not.toMatch(/[^\\]\\U/)
  })

  it('引号被转义，不会提前结束字符串', () => {
    const toml = codexConfig({ ...POSIX_TARGET, entryPath: '/tmp/a"b/stdio.mjs' }, 'tok')
    expect(toml).toContain('/tmp/a\\"b/stdio.mjs')
  })
})

describe('workbuddyConfig', () => {
  it('是合法 JSON，且形状可直接 merge', () => {
    const parsed = JSON.parse(workbuddyConfig(POSIX_TARGET, 'tok')) as {
      mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }>
    }
    const entry = parsed.mcpServers.brewphase
    expect(entry.type).toBe('stdio')
    expect(entry.command).toBe('node')
    expect(entry.args).toEqual([POSIX_TARGET.entryPath])
    expect(entry.env.BREWPHASE_MCP_TOKEN).toBe('tok')
    expect(entry.env.BREWPHASE_MCP_USER_DATA_DIR).toBe(POSIX_TARGET.userDataDir)
  })

  it('Windows 路径在 JSON 里保持原样（由 JSON 自己转义）', () => {
    const parsed = JSON.parse(workbuddyConfig(WINDOWS_TARGET, 'tok')) as {
      mcpServers: Record<string, { args: string[] }>
    }
    expect(parsed.mcpServers.brewphase.args[0]).toBe(WINDOWS_TARGET.entryPath)
  })
})

describe('genericConfig', () => {
  it('不带 type / timeout —— 不同客户端对这些字段的容忍度不一样', () => {
    const parsed = JSON.parse(genericConfig(POSIX_TARGET, 'tok')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(parsed.mcpServers.brewphase.type).toBeUndefined()
    expect(parsed.mcpServers.brewphase.timeout).toBeUndefined()
    expect(parsed.mcpServers.brewphase.command).toBe('node')
  })
})

describe('configTargetFrom', () => {
  it('缺任何一个字段都返回 null，不生成半截配置', () => {
    expect(configTargetFrom(null)).toBeNull()
    expect(
      configTargetFrom({
        running: true,
        socketPath: null,
        protocolVersion: 1,
        clientCount: 0,
        userDataDir: '/tmp',
        mcpEntryPath: '',
        platformSupported: true
      })
    ).toBeNull()
  })

  it('齐了才给出两项', () => {
    const target = configTargetFrom({
      running: true,
      socketPath: null,
      protocolVersion: 1,
      clientCount: 0,
      userDataDir: '/tmp/ud',
      mcpEntryPath: '/tmp/stdio.mjs',
      platformSupported: true
    })
    expect(target).toEqual({ entryPath: '/tmp/stdio.mjs', userDataDir: '/tmp/ud' })
  })
})
