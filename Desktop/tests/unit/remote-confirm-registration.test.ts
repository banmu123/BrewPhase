import { describe, expect, it } from 'vitest'
import {
  createHttpDeviceRegistrar,
  type DeviceFetchLike
} from '../../src/main/remote/registration'

/**
 * `DeviceRegistrar.confirm` / `.revoke` 的状态码映射（R5-R3.4）。
 *
 * 这一层只做一件事：把 HTTP 结果翻译成界面能分别解释的原因。所以测试
 * 用**注入的 fake fetch** 而不是真实网关——要覆盖 401/404/409/410/429
 * 这些分支，真实网关得先被改造成能返回任意状态码，反而更不可信。
 *
 * 三个不变量在每条用例里都要成立：
 * 1. 错误对象里不出现确认码、响应体原文、token；
 * 2. `redirect: 'manual'`；
 * 3. 确认码只走请求体，不进 URL。
 */

type Captured = {
  url: string
  method: string
  body: string
  headers: Record<string, string>
  redirect: string
}

function harness(status: number, payload: unknown): {
  registrar: ReturnType<typeof createHttpDeviceRegistrar>
  calls: Captured[]
} {
  const calls: Captured[] = []
  const fetchImpl: DeviceFetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: init.body,
      headers: init.headers,
      redirect: init.redirect
    })
    return { status, text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) }
  }
  return {
    registrar: createHttpDeviceRegistrar({
      origin: 'http://127.0.0.1:3999',
      userAccessToken: 'user-bearer',
      fetchImpl
    }),
    calls
  }
}

const CONFIRM_OK = { device_id: 'dev_1', status: 'active' }

describe('confirm：状态码 → 原因', () => {
  it('200 + active → ok，且请求形态正确', async () => {
    const { registrar, calls } = harness(200, CONFIRM_OK)
    const result = await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe('POST')
    // 确认码只走请求体：URL 里出现它会留在反向代理的 access log 里。
    expect(call.url).toBe('http://127.0.0.1:3999/mcp-devices/dev_1/confirm')
    expect(JSON.parse(call.body)).toEqual({ confirm_code: '123456' })
    expect(call.redirect).toBe('manual')
    expect(call.headers.authorization).toBe('Bearer user-bearer')
  })

  it('400 → invalid_code（码错，可以重试）', async () => {
    const { registrar } = harness(400, { error: 'invalid_confirm_code' })
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '000000' })).toEqual({
      ok: false,
      reason: 'invalid_code'
    })
  })

  it('401 → unauthorized', async () => {
    const { registrar } = harness(401, { error: 'invalid_token' })
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })).toEqual({
      ok: false,
      reason: 'unauthorized'
    })
  })

  it('403 → unauthorized', async () => {
    const { registrar } = harness(403, { error: 'forbidden' })
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })).toEqual({
      ok: false,
      reason: 'unauthorized'
    })
  })

  it('404 → not_found（不存在或不属于当前账户）', async () => {
    const { registrar } = harness(404, { error: 'device_not_found' })
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })).toEqual({
      ok: false,
      reason: 'not_found'
    })
  })

  it('409 → device_state（状态机不允许）', async () => {
    const { registrar } = harness(409, { error: 'invalid_device_state' })
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })).toEqual({
      ok: false,
      reason: 'device_state'
    })
  })

  it('410 → expired', async () => {
    const { registrar } = harness(410, { error: 'confirm_expired' })
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })).toEqual({
      ok: false,
      reason: 'expired'
    })
  })

  it('429 → rate_limited', async () => {
    const { registrar } = harness(429, { error: 'rate_limited' })
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })).toEqual({
      ok: false,
      reason: 'rate_limited'
    })
  })

  it('200 但响应体不是预期形状 → invalid_response', async () => {
    const { registrar } = harness(200, { device_id: 'dev_1' })
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })).toEqual({
      ok: false,
      reason: 'invalid_response'
    })
  })

  it('200 但响应体不是 JSON → invalid_response', async () => {
    const { registrar } = harness(200, '<html>oops</html>')
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })).toEqual({
      ok: false,
      reason: 'invalid_response'
    })
  })

  it('fetch 抛错 → network', async () => {
    const fetchImpl: DeviceFetchLike = async () => {
      throw new Error('socket hang up')
    }
    const registrar = createHttpDeviceRegistrar({
      origin: 'http://127.0.0.1:3999',
      userAccessToken: 'user-bearer',
      fetchImpl
    })
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })).toEqual({
      ok: false,
      reason: 'network'
    })
  })

  it('access token 取不到（已登出）→ unauthorized，且不发请求', async () => {
    let called = false
    const fetchImpl: DeviceFetchLike = async () => {
      called = true
      return { status: 200, text: async () => JSON.stringify(CONFIRM_OK) }
    }
    const registrar = createHttpDeviceRegistrar({
      origin: 'http://127.0.0.1:3999',
      accessToken: async () => {
        throw new Error('not signed in')
      },
      fetchImpl
    })
    expect(await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })).toEqual({
      ok: false,
      reason: 'unauthorized'
    })
    expect(called).toBe(false)
  })

  it('错误对象里没有确认码、没有响应体原文', async () => {
    const { registrar } = harness(400, { error: 'invalid_confirm_code', echo: '123456' })
    const result = await registrar.confirm({ deviceId: 'dev_1', confirmCode: '123456' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('123456')
    expect(serialized).not.toContain('echo')
  })
})

describe('revoke：撤销 pending 设备', () => {
  it('200 → ok，且用 DELETE', async () => {
    const { registrar, calls } = harness(200, { device_id: 'dev_1', status: 'revoked' })
    expect(await registrar.revoke({ deviceId: 'dev_1' })).toEqual({ ok: true })
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.url).toBe('http://127.0.0.1:3999/mcp-devices/dev_1')
  })

  it('404 视为成功（设备已不在，没什么可撤的）', async () => {
    const { registrar } = harness(404, { error: 'device_not_found' })
    expect(await registrar.revoke({ deviceId: 'dev_1' })).toEqual({ ok: true })
  })

  it('401 → unauthorized', async () => {
    const { registrar } = harness(401, { error: 'invalid_token' })
    expect(await registrar.revoke({ deviceId: 'dev_1' })).toEqual({
      ok: false,
      reason: 'unauthorized'
    })
  })

  it('500 → invalid_response', async () => {
    const { registrar } = harness(500, { error: 'internal' })
    expect(await registrar.revoke({ deviceId: 'dev_1' })).toEqual({
      ok: false,
      reason: 'invalid_response'
    })
  })

  it('网络异常 → network', async () => {
    const fetchImpl: DeviceFetchLike = async () => {
      throw new Error('offline')
    }
    const registrar = createHttpDeviceRegistrar({
      origin: 'http://127.0.0.1:3999',
      userAccessToken: 'user-bearer',
      fetchImpl
    })
    expect(await registrar.revoke({ deviceId: 'dev_1' })).toEqual({
      ok: false,
      reason: 'network'
    })
  })
})
