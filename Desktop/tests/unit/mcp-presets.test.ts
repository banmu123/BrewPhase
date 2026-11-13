import { describe, expect, it } from 'vitest'
import { MCP_SCOPES, MCP_SCOPE_PRESETS } from '../../src/shared/contracts/mcp'

/**
 * 权限预设。
 *
 * 第一档就是新建客户端时的默认值，所以这里锁两件事：
 * ① 默认确实是「全部」，不是某个悄悄收缩过的子集；
 * ② 全集里永远没有 confirm 类能力——AI 不能替用户拍板，这是靠「根本不存在
 *    这条权限」保证的，不是靠默认不勾。
 */

describe('MCP 权限预设', () => {
  const [first] = MCP_SCOPE_PRESETS

  it('第一档就是全部权限，用于新建客户端的默认值', () => {
    expect([...first.scopes].sort()).toEqual([...MCP_SCOPES].sort())
    expect(first.scopes).toHaveLength(MCP_SCOPES.length)
  })

  it('每个预设都只由已声明的 scope 组成，不会写出不存在的权限', () => {
    const known = new Set<string>(MCP_SCOPES)
    for (const preset of MCP_SCOPE_PRESETS) {
      for (const scope of preset.scopes) {
        expect(known.has(scope), `${preset.key} 含未知 scope ${scope}`).toBe(true)
      }
    }
  })

  it('不存在任何 confirm 类能力', () => {
    // 这条一旦变红，说明有人给 MCP 加了「替用户确认人生方向」的口子。
    for (const scope of MCP_SCOPES) {
      expect(scope).not.toMatch(/confirm/i)
    }
  })

  it('预设按权限数量递减，便于用户往回收', () => {
    for (let i = 1; i < MCP_SCOPE_PRESETS.length; i += 1) {
      const previous = MCP_SCOPE_PRESETS[i - 1]
      const current = MCP_SCOPE_PRESETS[i]
      expect(current.scopes.length).toBeLessThan(previous.scopes.length)
      for (const scope of current.scopes) {
        expect(previous.scopes).toContain(scope)
      }
    }
  })

  it('默认档覆盖写入类能力，Agent 开箱即可整理内容', () => {
    expect(first.scopes).toContain('records:create')
    expect(first.scopes).toContain('canvas:write')
    expect(first.scopes).toContain('work_context:update')
    expect(first.scopes).toContain('direction:propose')
  })
})
