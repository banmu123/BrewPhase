import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeRequestHash } from '../../src/main/remote/request-handler'
import { REMOTE_ERROR_CODES, REMOTE_TOOLS, REMOTE_TOOL_SCOPES, remoteReqSchema } from '../../src/shared/contracts/remote'
import { scopeForTool, isRemoteTool } from '../../src/main/remote/remote-policy'

/**
 * Cloud ↔ Desktop 的**请求合同**（Phase 1.2B.2.2）。
 *
 * 这一组不测任何一端的业务逻辑，只回答一个问题：
 * **两端对「一条 `req` 长什么样」的理解是否一致。**
 *
 * 判据只有两个，且都是**跨端**的：
 *
 * 1. `request_hash`：对 `fixtures/remote-mcp/req-v1.json` 的同一份向量，
 *    Cloud 与 Desktop 必须算出同一个哈希（Cloud 侧见
 *    `cloud/tests/link/request-hash.test.ts`）；
 * 2. 字段集：Cloud 发出的那条帧必须能被 Desktop 的 `remoteReqSchema` 接受。
 *    Cloud 侧用接口（`ReqFrame`）描述出站帧，Desktop 侧用 zod 校验入站帧——
 *    两套类型各自写，字段名写错时**只有合同测试**会红。
 *
 * 「两端各自能跑通自己的测试」在跨端协议里不是证据：两边可以各自自洽，
 * 而线上一条帧都过不去。
 */

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'remote-mcp',
  'req-v1.json'
)

interface ReqFixture {
  protocol: string
  cases: Array<{
    name: string
    input: { v: number; tool: string; arguments: unknown }
    canonical: string
    request_hash: string
  }>
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ReqFixture

/**
 * 一条按 Cloud `ReqFrame` 形状构造的帧。
 *
 * 刻意**手写**而不是从 fixture 生成：手写才能暴露「我以为 Cloud 会发 X」。
 * 字段名与 `cloud/src/link/schemas.ts` 的 `ReqFrame` 逐项对应。
 */
function cloudShapedReq(argumentsValue: unknown): Record<string, unknown> {
  return {
    v: 1,
    type: 'req',
    id: 'req_0123456789ab',
    ts: 1_763_400_001_000,
    tool: 'search_records',
    arguments: argumentsValue,
    request_hash: computeRequestHash({ v: 1, tool: 'search_records', arguments: argumentsValue }),
    deadline_ms: 1_763_400_016_000,
    grant_ctx: 'gc_0123456789abcdef01234567',
    trace: { mcp_request_id: 'jsonrpc-1', received_at: 1_763_400_000_980 }
  }
}

describe('request_hash 黄金向量（与 Cloud 共用一份）', () => {
  it('fixture 可用', () => {
    expect(fixture.protocol).toBe('brewphase.remote.req.v1')
    expect(fixture.cases.length).toBeGreaterThanOrEqual(6)
  })

  for (const testCase of fixture.cases) {
    it(`${testCase.name}：哈希与 Cloud 逐字节一致`, () => {
      expect(computeRequestHash(testCase.input)).toBe(testCase.request_hash)
    })
  }

  it('undefined 的键被剔除（与「没传」同哈希、与 null 不同）', () => {
    const withUndefined = computeRequestHash({
      v: 1,
      tool: 'search_records',
      arguments: { a: 1, b: undefined }
    })
    expect(withUndefined).toBe(computeRequestHash({ v: 1, tool: 'search_records', arguments: { a: 1 } }))
    expect(withUndefined).not.toBe(
      computeRequestHash({ v: 1, tool: 'search_records', arguments: { a: 1, b: null } })
    )
  })

  it('不做 Unicode 归一化（NFC ≠ NFD）', () => {
    const nfc = computeRequestHash({ v: 1, tool: 'search_records', arguments: { s: '\u00e9' } })
    const nfd = computeRequestHash({ v: 1, tool: 'search_records', arguments: { s: 'e\u0301' } })
    expect(nfc).not.toBe(nfd)
  })
})

describe('req 帧的字段集能被 Desktop 的 schema 接受', () => {
  it('合法帧通过校验（含 trace）', () => {
    const parsed = remoteReqSchema.safeParse(cloudShapedReq({ search: '埃塞' }))
    expect(parsed.success).toBe(true)
  })

  it('没有 trace 也通过（trace 是可选字段）', () => {
    const frame = cloudShapedReq({})
    delete frame.trace
    expect(remoteReqSchema.safeParse(frame).success).toBe(true)
  })

  it('每个黄金向量的 arguments 都能塞进 req 并通过校验', () => {
    for (const testCase of fixture.cases) {
      const frame = cloudShapedReq(testCase.input.arguments)
      const parsed = remoteReqSchema.safeParse(frame)
      expect(parsed.success, testCase.name).toBe(true)
    }
  })

  it('未知键被拒绝（Cloud 若新增字段必须先改两端 + 升级 v）', () => {
    const withExtra = { ...cloudShapedReq({}), user_id: 'u-1' }
    expect(remoteReqSchema.safeParse(withExtra).success).toBe(false)
    // 这两个也必须是未知键：帧里带「自报身份」就会有两个事实来源。
    expect(remoteReqSchema.safeParse({ ...cloudShapedReq({}), grant_id: 'g-1' }).success).toBe(false)
    expect(remoteReqSchema.safeParse({ ...cloudShapedReq({}), scopes: ['records:read'] }).success).toBe(false)
  })

  it('request_hash 必须是 `sha256:` + 64 位小写十六进制', () => {
    const frame = cloudShapedReq({})
    for (const bad of ['', 'sha256:', 'sha256:XYZ', `sha256:${'A'.repeat(64)}`, '0'.repeat(64)]) {
      expect(remoteReqSchema.safeParse({ ...frame, request_hash: bad }).success, bad).toBe(false)
    }
  })

  it('deadline_ms 缺失或类型不对会被拒（它是绝对 epoch，不是相对超时）', () => {
    const frame = cloudShapedReq({})
    const { deadline_ms: _drop, ...withoutDeadline } = frame
    expect(remoteReqSchema.safeParse(withoutDeadline).success).toBe(false)
    expect(remoteReqSchema.safeParse({ ...frame, deadline_ms: '15000' }).success).toBe(false)
  })
})

describe('工具与 scope 的两端映射一致', () => {
  /**
   * Cloud 侧 `REMOTE_TOOL_SCOPES`（`cloud/src/link/schemas.ts`）的**当前值**。
   *
   * 抄一份到测试里而不是从 Cloud import（两台独立发布单元）：一份写死在这里
   * 的期望值，才能在 Cloud 改了映射而 Desktop 没跟时变红。
   */
  const CLOUD_TOOL_SCOPES: Record<string, string> = {
    search_records: 'records:read',
    get_record: 'records:read',
    list_record_tags: 'tags:read',
    list_beans: 'coffee:read',
    list_brews: 'coffee:read',
    list_tastings: 'coffee:read',
    list_canvases: 'canvas:read',
    get_canvas: 'canvas:read'
  }

  it('8 个工具、scope 逐项相同', () => {
    expect(Object.keys(CLOUD_TOOL_SCOPES).sort()).toEqual([...REMOTE_TOOLS].sort())
    for (const tool of REMOTE_TOOLS) {
      expect(scopeForTool(tool), tool).toBe(CLOUD_TOOL_SCOPES[tool])
      expect(REMOTE_TOOL_SCOPES[tool]).toBe(CLOUD_TOOL_SCOPES[tool])
      expect(isRemoteTool(tool)).toBe(true)
    }
  })

  it('19 个错误码（Cloud 的 res 校验用的是同一张全集）', () => {
    expect(REMOTE_ERROR_CODES).toHaveLength(19)
  })

  it('白名单之外的工具在两端都不存在', () => {
    for (const tool of ['delete_record', 'update_bean', 'create_brew', 'work_context']) {
      expect(isRemoteTool(tool)).toBe(false)
      expect(scopeForTool(tool)).toBeNull()
    }
  })
})
