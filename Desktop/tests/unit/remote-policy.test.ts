import { describe, expect, it } from 'vitest'
import {
  REMOTE_SCOPES,
  REMOTE_TOOLS,
  REMOTE_TOOL_SCOPES,
  toolsForScopes,
  type RemoteScope
} from '../../src/shared/contracts/remote'
import {
  LOCAL_ALLOWED_REMOTE_SCOPES,
  effectiveScopes,
  effectiveTools,
  isRemoteTool,
  remoteToolScopeMismatches,
  scopeForTool,
  toRemoteErrorCode
} from '../../src/main/remote/remote-policy'
import { TOOL_DEFINITIONS } from '../../src/shared/mcp/tool-schemas'

/**
 * Remote 权限面（Phase 1.1B）。
 *
 * 这里测的是「Cloud 说给了什么」到「本机实际允许什么」的收敛：
 * 工具面是常量、scope 逐 grant、错误码必须翻译。
 */

describe('常量面', () => {
  it('REMOTE_SCOPES 恰好 4 个只读 scope', () => {
    expect(REMOTE_SCOPES).toEqual(['records:read', 'tags:read', 'coffee:read', 'canvas:read'])
    expect(REMOTE_SCOPES).toHaveLength(4)
  })

  it('REMOTE_TOOLS 恰好 8 个，且全部只读', () => {
    expect(REMOTE_TOOLS).toHaveLength(8)
    for (const tool of REMOTE_TOOLS) {
      expect(TOOL_DEFINITIONS[tool].write, `${tool} 必须是只读`).toBe(false)
    }
  })

  it('REMOTE_TOOL_SCOPES 与 TOOL_DEFINITIONS 的 scope 一致（防止两处漂移）', () => {
    expect(remoteToolScopeMismatches()).toEqual([])
    for (const tool of REMOTE_TOOLS) {
      expect(REMOTE_TOOL_SCOPES[tool]).toBe(TOOL_DEFINITIONS[tool].scope)
    }
  })

  it('27 个 Local 工具里只有 8 个进入远程面', () => {
    expect(Object.keys(TOOL_DEFINITIONS)).toHaveLength(27)
    expect(REMOTE_TOOLS.length).toBeLessThan(Object.keys(TOOL_DEFINITIONS).length)
  })

  it('写工具与个人工作类工具都不在远程面', () => {
    for (const forbidden of [
      'create_record',
      'update_record',
      'create_tag',
      'create_canvas',
      'update_canvas_note',
      'annotate_canvas_node',
      'list_work_contexts',
      'get_direction_overview',
      'propose_direction'
    ]) {
      expect(isRemoteTool(forbidden), `${forbidden} 不该可远程调用`).toBe(false)
      expect(scopeForTool(forbidden)).toBeNull()
    }
  })
})

describe('effectiveScopes：逐 grant 收敛', () => {
  it('取交集并保持 REMOTE_SCOPES 顺序', () => {
    expect(effectiveScopes(['canvas:read', 'records:read'])).toEqual(['records:read', 'canvas:read'])
  })

  it('空授权 → 空生效集', () => {
    expect(effectiveScopes([])).toEqual([])
  })

  it('全给也只有本地允许的那 4 个', () => {
    expect(effectiveScopes([...REMOTE_SCOPES])).toEqual([...LOCAL_ALLOWED_REMOTE_SCOPES])
    expect(LOCAL_ALLOWED_REMOTE_SCOPES).toHaveLength(4)
  })

  it('两个 grant 的 scope 不会被合并（ST-20 的底座）', () => {
    const grantA: RemoteScope[] = ['records:read']
    const grantB: RemoteScope[] = ['coffee:read']
    expect(effectiveScopes(grantA)).toEqual(['records:read'])
    expect(effectiveScopes(grantB)).toEqual(['coffee:read'])
    // A 拿不到 coffee:read —— 这正是「同设备多 Client 隔离」的含义。
    expect(effectiveScopes(grantA)).not.toContain('coffee:read')
  })
})

describe('effectiveTools：Cloud 不能扩张工具面', () => {
  it('按 scope 收窄', () => {
    expect(effectiveTools(['records:read'], null)).toEqual(['search_records', 'get_record'])
    expect(effectiveTools(['tags:read'], null)).toEqual(['list_record_tags'])
    expect(effectiveTools(['coffee:read'], null)).toEqual([
      'list_beans',
      'list_brews',
      'list_tastings'
    ])
    expect(effectiveTools(['canvas:read'], null)).toEqual(['list_canvases', 'get_canvas'])
  })

  it('Cloud 的 allowed_tools 只能做交集，给多了没用', () => {
    const all = effectiveTools(['records:read', 'coffee:read'], [...REMOTE_TOOLS, 'create_record', 'drop_table'])
    // 即使 Cloud 把写工具塞进 allowed_tools，也不会出现在结果里。
    expect(all).toEqual(['search_records', 'get_record', 'list_beans', 'list_brews', 'list_tastings'])
  })

  it('allowed_tools 更窄时按 Cloud 的收窄', () => {
    expect(effectiveTools(['records:read'], ['search_records'])).toEqual(['search_records'])
  })

  it('空 scope → 空工具', () => {
    expect(effectiveTools([], null)).toEqual([])
  })

  it('toolsForScopes 不会返回写工具', () => {
    for (const tool of toolsForScopes([...REMOTE_SCOPES])) {
      expect(TOOL_DEFINITIONS[tool].write).toBe(false)
    }
  })
})

describe('Local → Remote 错误码映射（架构设计 §6.8.1）', () => {
  it('按 stage 翻译，而不是直接透传 Local 码', () => {
    expect(toRemoteErrorCode('VALIDATION_ERROR', 'tool')).toBe('TOOL_NOT_ALLOWED')
    expect(toRemoteErrorCode('PERMISSION_DENIED', 'scope')).toBe('SCOPE_DENIED')
    expect(toRemoteErrorCode('VALIDATION_ERROR', 'params')).toBe('INVALID_ARGUMENTS')
  })

  it('handler 阶段只放行白名单', () => {
    expect(toRemoteErrorCode('NOT_FOUND', 'handler')).toBe('NOT_FOUND')
    expect(toRemoteErrorCode('VALIDATION_ERROR', 'handler')).toBe('INVALID_ARGUMENTS')
    // STALE_RECORD 远程不该出现；出现也折成 NOT_FOUND，少泄漏一点。
    expect(toRemoteErrorCode('STALE_RECORD', 'handler')).toBe('NOT_FOUND')
    // 其余一律 INTERNAL_ERROR。
    for (const code of ['UNAUTHORIZED', 'IDEMPOTENCY_KEY_REUSE', 'BRIDGE_PROTOCOL_MISMATCH'] as const) {
      expect(toRemoteErrorCode(code, 'handler')).toBe('INTERNAL_ERROR')
    }
  })

  it('replay 阶段（Remote 不传钩子，属兜底）→ INTERNAL_ERROR', () => {
    expect(toRemoteErrorCode('IDEMPOTENCY_KEY_REUSE', 'replay')).toBe('INTERNAL_ERROR')
  })

  it('绝不把 Local 的 PERMISSION_DENIED / VALIDATION_ERROR 原样外传', () => {
    const allStages = ['tool', 'scope', 'params', 'replay', 'handler'] as const
    for (const stage of allStages) {
      const mapped = toRemoteErrorCode('PERMISSION_DENIED', stage)
      expect(mapped).not.toBe('PERMISSION_DENIED')
    }
    expect(toRemoteErrorCode('VALIDATION_ERROR', 'handler')).not.toBe('VALIDATION_ERROR')
  })
})
