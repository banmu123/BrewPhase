import { request } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import {
  createClientState,
  startOAuthCallbackServer,
  type OAuthCallbackServer
} from '../../src/main/account/oauth-callback-server'

/**
 * 本机回调服务器测试：合法回调、错误 state、重复回调、超时、非法请求。
 *
 * 全部走**真实 HTTP 请求**（127.0.0.1 上的一次性端口），不用 mock 的
 * request 事件——Host 头、方法、路径这些边界只有在真实连接上才能验到。
 */

const STATE = createClientState()

type HttpResponse = { status: number; body: string }

function call(
  port: number,
  path: string,
  options: { method?: string; host?: string } = {}
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.host ? { host: options.host } : undefined
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    // 服务器已经关端口时连接会被拒绝：交给调用方判断「不可再回放」。
    req.on('error', reject)
    req.end()
  })
}

async function start(timeoutMs = 5_000): Promise<OAuthCallbackServer> {
  return await startOAuthCallbackServer({ clientState: STATE, timeoutMs })
}

/** 端口最终必须关掉：轮询到连接被拒绝为止（关连接是异步的）。 */
async function waitForClosed(port: number): Promise<void> {
  await vi.waitFor(
    async () => {
      await expect(call(port, '/callback')).rejects.toBeTruthy()
    },
    { timeout: 1_500, interval: 20 }
  )
}

describe('OAuthCallbackServer', () => {
  it('只监听回环地址，redirect_uri 形如 http://127.0.0.1:<port>/callback', async () => {
    const server = await start()
    try {
      expect(server.port).toBeGreaterThan(0)
      expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`)
    } finally {
      server.cancel()
    }
  })

  it('合法回调：返回 code、响应 200、不把参数回显进页面', async () => {
    const server = await start()
    const response = await call(server.port, `/callback?code=the-code&state=${STATE}`)
    expect(response.status).toBe(200)
    expect(await server.result).toEqual({ status: 'code', code: 'the-code' })
    // 响应页是静态的：授权码不能出现在 HTML 里。
    expect(response.body).not.toContain('the-code')
  })

  it('state 不匹配：400 且流程不结束，随后合法回调仍然成功', async () => {
    const server = await start()
    const rejected = await call(server.port, '/callback?code=attacker&state=wrong-state')
    expect(rejected.status).toBe(400)

    const accepted = await call(server.port, `/callback?code=real-code&state=${STATE}`)
    expect(accepted.status).toBe(200)
    expect(await server.result).toEqual({ status: 'code', code: 'real-code' })
  })

  it('回调成功后端口关闭：同一个 code 无法被第二次兑换', async () => {
    const server = await start()
    await call(server.port, `/callback?code=once&state=${STATE}`)
    expect(await server.result).toEqual({ status: 'code', code: 'once' })

    // 关闭过程中的重放最多拿到 409（已处理），绝不可能再拿到一次 code。
    let replayStatus: number | null = null
    try {
      const replay = await call(server.port, `/callback?code=twice&state=${STATE}`)
      replayStatus = replay.status
    } catch {
      replayStatus = null
    }
    expect(replayStatus === null || replayStatus === 409).toBe(true)
    expect(await server.result).toEqual({ status: 'code', code: 'once' })
    await waitForClosed(server.port)
  })

  it('Provider 拒绝（error=access_denied）→ error 结果', async () => {
    const server = await start()
    const response = await call(
      server.port,
      `/callback?error=access_denied&error_description=denied&state=${STATE}`
    )
    expect(response.status).toBe(200)
    expect(await server.result).toEqual({
      status: 'error',
      error: 'access_denied',
      description: 'denied'
    })
  })

  it('缺少 code 且没有 error → invalid_request，且不挂起等待', async () => {
    const server = await start()
    const response = await call(server.port, `/callback?state=${STATE}`)
    expect(response.status).toBe(400)
    expect(await server.result).toEqual({
      status: 'error',
      error: 'invalid_request',
      description: null
    })
  })

  it('错误路径 / 错误方法 / 错误 Host 都不改变状态', async () => {
    const server = await start()

    expect((await call(server.port, '/callback-other?code=x&state=' + STATE)).status).toBe(404)
    expect((await call(server.port, `/callback?code=x&state=${STATE}`, { method: 'POST' })).status).toBe(405)
    expect((await call(server.port, `/callback?code=x&state=${STATE}`, { host: 'evil.example' })).status).toBe(421)

    // 三次非法请求之后，正确的回调依然有效 —— 说明它们没有消费掉这次登录。
    const ok = await call(server.port, `/callback?code=good&state=${STATE}`)
    expect(ok.status).toBe(200)
    expect(await server.result).toEqual({ status: 'code', code: 'good' })
  })

  it('超时：到期 resolve timeout 并关闭端口', async () => {
    const server = await start(80)
    expect(await server.result).toEqual({ status: 'timeout' })
    await waitForClosed(server.port)
  })

  it('取消：resolve cancelled 并关闭端口', async () => {
    const server = await start()
    server.cancel()
    expect(await server.result).toEqual({ status: 'cancelled' })
    await waitForClosed(server.port)
  })

  it('重复调用 cancel 幂等，结果不变', async () => {
    const server = await start()
    server.cancel()
    server.cancel()
    expect(await server.result).toEqual({ status: 'cancelled' })
  })
})
