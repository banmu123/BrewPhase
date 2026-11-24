import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_DOMAINS } from '../../src/shared/contracts'
import { IPC, ipcRequestSchemas } from '../../src/shared/contracts/validation/ipc'
import { JOURNEY_LINK_TYPES } from '../../src/shared/contracts/entities/agent-journey'

/**
 * R6-4.1 的 IPC 契约边界测试。
 *
 * IPC 是 Renderer 与主进程之间**唯一**的口子：通道名必须在 `IPC` 常量表里、
 * 每个通道必须有对应的 zod schema、preload 必须逐条暴露。任何一环漏了，
 * Renderer 要么调不通，要么调通了却没人校验入参。
 */

/** 本阶段新增的融合通道（少一个都算没接完）。 */
const FUSION_CHANNELS = [
  'agentJourneysList',
  'agentJourneyGet',
  'agentJourneyNoteCreate',
  'agentJourneyNoteUpdate',
  'agentJourneyNoteRemove',
  'agentJourneyLinkCreate',
  'agentJourneyLinkRemove',
  /** R6-4.3.1：工作区绑定（绑定 / 换绑 / 解绑）。 */
  'agentJourneyWorkspaceBind',
  'canvasJourneys',
  'canvasJourneyAdd',
  'canvasJourneyMove',
  'canvasJourneyEventMove',
  'canvasJourneyCollapse',
  'canvasJourneyRemove'
] as const

/** 通道字符串 → schema 的唯一取值点（避免到处写索引断言）。 */
function schemaFor(channel: string) {
  return (ipcRequestSchemas as Record<string, unknown>)[channel]
}

describe('融合通道的白名单完整性', () => {
  it('融合通道都在 IPC 常量表里，且通道名带命名空间', () => {
    for (const key of FUSION_CHANNELS) {
      expect(IPC[key as keyof typeof IPC], `IPC.${key}`).toBeTruthy()
      const channel = IPC[key as keyof typeof IPC] as string
      expect(
        channel.startsWith('agent-journey') || channel.startsWith('agent-journeys') ||
          channel.startsWith('canvas:journey'),
        `${key} 的通道名 ${channel} 不属于 Journey 融合命名空间`
      ).toBe(true)
    }
  })

  it('每个通道都有对应请求体 schema（无 schema = 无人校验入参）', () => {
    for (const key of FUSION_CHANNELS) {
      const channel = IPC[key as keyof typeof IPC] as string
      expect(schemaFor(channel), `${channel} 缺 schema`).toBeDefined()
    }
  })

  it('IPC 常量表与 ipcRequestSchemas 的键完全一致（不允许多也不允许少）', () => {
    const ipcChannels = new Set(Object.values(IPC) as string[])
    const schemaChannels = new Set(Object.keys(ipcRequestSchemas))
    const missing = [...ipcChannels].filter((channel) => !schemaChannels.has(channel))
    const extra = [...schemaChannels].filter((channel) => !ipcChannels.has(channel))
    expect(missing, '有通道没 schema').toEqual([])
    expect(extra, '有 schema 没通道').toEqual([])
  })
})

describe('入参校验（脏参数必须在边界上被拒）', () => {
  const parse = (channel: string, payload: unknown) => {
    const schema = schemaFor(channel) as {
      safeParse: (value: unknown) => { success: boolean; data?: unknown }
    }
    return schema.safeParse(payload)
  }

  it('Journey 列表：search 超长被拒', () => {
    expect(parse(IPC.agentJourneysList, { search: 'x'.repeat(500) }).success).toBe(false)
    expect(parse(IPC.agentJourneysList, { search: '正常' }).success).toBe(true)
  })

  it('Journey 列表：缺省参数合法（带 default 的对象）', () => {
    expect(parse(IPC.agentJourneysList, undefined).success).toBe(true)
  })

  it('详情 / 删除：非 UUID 被拒', () => {
    expect(parse(IPC.agentJourneyGet, { journeyId: 'not-a-uuid' }).success).toBe(false)
    expect(parse(IPC.agentJourneyGet, { journeyId: crypto.randomUUID() }).success).toBe(true)
    expect(parse(IPC.agentJourneyNoteRemove, { id: '123' }).success).toBe(false)
    expect(parse(IPC.agentJourneyLinkRemove, { id: '123' }).success).toBe(false)
  })

  it('R6-4.3.1 工作区绑定：uuid 绑定 / null 解绑合法，路径与缺省被拒', () => {
    const journeyId = crypto.randomUUID()
    const parseBind = (payload: unknown) => parse(IPC.agentJourneyWorkspaceBind, payload)
    // 绑定 / 换绑：uuid。
    expect(parseBind({ journeyId, workspaceId: crypto.randomUUID() }).success).toBe(true)
    // 解绑：必须显式传 null（不给默认值，避免「忘了传」被静默当成解绑）。
    expect(parseBind({ journeyId, workspaceId: null }).success).toBe(true)
    expect(parseBind({ journeyId }).success).toBe(false)
    // 绝对路径在 IPC 边界就被拒——渲染层同样拿不到目录访问权。
    expect(parseBind({ journeyId, workspaceId: '/Users/me/project' }).success).toBe(false)
    expect(parseBind({ journeyId, workspaceId: 'not-a-uuid' }).success).toBe(false)
    expect(parseBind({ journeyId: 'bad', workspaceId: null }).success).toBe(false)
    // 身份字段照旧不收：zod 默认 strip，多余字段不会被透传给主进程。
    const spoofed = parseBind({ journeyId, workspaceId: null, source_client_id: 'spoofed' })
    expect(spoofed.success).toBe(true)
    expect(spoofed.success && 'source_client_id' in (spoofed.data as object)).toBe(false)
  })

  it('笔记：空 body 被拒、超长被拒', () => {
    expect(parse(IPC.agentJourneyNoteCreate, { journeyId: crypto.randomUUID(), body: '' }).success).toBe(
      false
    )
    expect(
      parse(IPC.agentJourneyNoteCreate, {
        journeyId: crypto.randomUUID(),
        body: 'x'.repeat(20_001)
      }).success
    ).toBe(false)
    expect(
      parse(IPC.agentJourneyNoteCreate, { journeyId: crypto.randomUUID(), body: 'ok' }).success
    ).toBe(true)
  })

  it('笔记：eventId 可省略（Journey 级）也可给 UUID（Event 级）', () => {
    const journeyId = crypto.randomUUID()
    expect(parse(IPC.agentJourneyNoteCreate, { journeyId, body: 'a' }).success).toBe(true)
    expect(
      parse(IPC.agentJourneyNoteCreate, { journeyId, eventId: crypto.randomUUID(), body: 'a' })
        .success
    ).toBe(true)
    expect(
      parse(IPC.agentJourneyNoteCreate, { journeyId, eventId: 'bad', body: 'a' }).success
    ).toBe(false)
  })

  it('关系类型只收五种白名单值', () => {
    const base = {
      journeyId: crypto.randomUUID(),
      eventId: crypto.randomUUID(),
      recordId: crypto.randomUUID()
    }
    for (const kind of JOURNEY_LINK_TYPES) {
      expect(parse(IPC.agentJourneyLinkCreate, { ...base, relationshipType: kind }).success, kind).toBe(
        true
      )
    }
    // 白名单外的一律拒
    expect(parse(IPC.agentJourneyLinkCreate, { ...base, relationshipType: 'causes' }).success).toBe(
      false
    )
    expect(parse(IPC.agentJourneyLinkCreate, { ...base, relationshipType: '' }).success).toBe(false)
  })

  it('摆位：坐标必须是有限数（NaN / Infinity 被拒）', () => {
    const base = { canvasId: crypto.randomUUID(), journeyId: crypto.randomUUID() }
    expect(parse(IPC.canvasJourneyMove, { ...base, positionX: 1, positionY: 2 }).success).toBe(true)
    expect(parse(IPC.canvasJourneyMove, { ...base, positionX: NaN, positionY: 0 }).success).toBe(false)
    expect(
      parse(IPC.canvasJourneyMove, { ...base, positionX: Infinity, positionY: 0 }).success
    ).toBe(false)
    expect(parse(IPC.canvasJourneyMove, { ...base, positionX: '1', positionY: 0 }).success).toBe(false)
  })

  it('事件摆位与折叠：入参形状固定', () => {
    expect(
      parse(IPC.canvasJourneyEventMove, {
        canvasId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        positionX: 10,
        positionY: 20
      }).success
    ).toBe(true)
    // 缺 eventId 必须拒——否则会写到错误的行
    expect(
      parse(IPC.canvasJourneyEventMove, {
        canvasId: crypto.randomUUID(),
        positionX: 10,
        positionY: 20
      }).success
    ).toBe(false)
    expect(
      parse(IPC.canvasJourneyCollapse, {
        canvasId: crypto.randomUUID(),
        journeyId: crypto.randomUUID(),
        collapsed: 'yes'
      }).success
    ).toBe(false)
  })

  it('没有一条 Journey 通道接受 source_client_id（身份只能来自认证）', () => {
    const journeyId = crypto.randomUUID()
    const payloadsWithIdentity = [
      { journeyId, body: 'a', source_client_id: 'spoofed' },
      { journeyId, eventId: crypto.randomUUID(), body: 'a', source_client_id: 'spoofed' }
    ]
    for (const payload of payloadsWithIdentity) {
      // 多出来的字段要么被 zod 丢掉（strict 之外默认 strip），要么整条被拒——
      // 无论哪种，都不可能写进库：Service 侧根本不读这个字段。
      const result = parse(IPC.agentJourneyNoteCreate, payload)
      if (!result.success) continue // 被拒更安全，直接过
      if (result.data && typeof result.data === 'object' && 'source_client_id' in result.data) {
        throw new Error('schema 不得把 source_client_id 透传给主进程')
      }
    }
  })
})

describe('AppDomain 两份枚举不再漂移', () => {
  it("shared APP_DOMAINS 含 'agentJourneys'（R6-4.1 §7.5 修复）", () => {
    expect(APP_DOMAINS).toContain('agentJourneys')
  })

  it("main 侧 ApplicationEvents.AppDomain 与 shared APP_DOMAINS 一致", async () => {
    const source = readFileSync('src/main/application/events/application-events.ts', 'utf8')
    const block = source.slice(source.indexOf('export type AppDomain'))
    const mainDomains = [...block.matchAll(/'([a-zA-Z]+)'/g)].map((match) => match[1])
    expect([...mainDomains].sort()).toEqual([...APP_DOMAINS].sort())
  })
})

describe('preload 逐条暴露（白名单不能漏）', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8')

  it('每个融合通道都在 preload 里被 invoke', () => {
    for (const key of FUSION_CHANNELS) {
      const channel = IPC[key as keyof typeof IPC] as string
      expect(preload, `${channel} 未在 preload 暴露`).toContain(`IPC.${key}`)
    }
  })

  it('preload 不透传 ipcRenderer 本身', () => {
    // 模块私有 const 可以有；任何导出/返回 ipcRenderer 的写法都不允许。
    expect(preload).not.toMatch(/export\s+(const|let|var|function)\s+ipcRenderer/)
    expect(preload).not.toMatch(/return\s+ipcRenderer/)
  })
})

describe('主进程注册（唯一注册点必须真的接上）', () => {
  const register = readFileSync('src/main/ipc/register.ts', 'utf8')

  it('每个融合通道都注册了 handler', () => {
    for (const key of FUSION_CHANNELS) {
      expect(register, `register.ts 未处理 ${key}`).toContain(`IPC.${key}`)
    }
  })

  it('走的是注入的同一 Service 实例，不新建第二个', () => {
    expect(register).toContain('services.agentJourneys.')
    expect(register).toContain('services.canvas.')
    // 不允许在 register.ts 里 new 这两个 Service
    expect(register).not.toMatch(/new\s+AgentJourneyService\s*\(/)
    expect(register).not.toMatch(/new\s+CanvasService\s*\(/)
  })

  it('没有引入 remote / cloud 侧的 Journey 执行能力', () => {
    const remote = readFileSync('src/main/remote/request-handler.ts', 'utf8')
    expect(remote).not.toMatch(/agentJourney|agent_journey/i)
  })
})
