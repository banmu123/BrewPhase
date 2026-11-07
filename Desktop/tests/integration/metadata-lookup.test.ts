import { createServer, request as httpRequest, type Server } from 'node:http'
import type { LookupFunction } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGuardedLookup } from '../../src/main/metadata/metadata-security'

/**
 * 真实 `http.request` 层的 lookup 契约验证（§第三轮 1）。
 *
 * 这里测的不是 IP 校验逻辑（那有独立单测），而是**Node 连接层是否真的按
 * 我们给出的回调形状工作**：Node 20+ 的 autoSelectFamily 会以
 * `options.all === true` 调用 lookup 并期待 `{address, family}[]` —— 之前
 * 的实现无论 all 与否都回单个地址，这层会拿到错误类型。
 *
 * 两个用例：
 * 1. 测试专用 lookup（不校验 IP，只回 127.0.0.1）在 autoSelectFamily 下
 *    真实建立连接 → 证明数组契约被 Node 接受；
 * 2. 生产 guarded lookup（注入假 DNS 返回私有 IP）在真实连接时被拒绝 →
 *    证明安全层在真实 socket 路径上生效。
 */
let server: Server
let port: number

beforeEach(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('lookup-ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function fetchThrough(lookup: LookupFunction): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'sync.test',
      port,
      path: '/',
      method: 'GET',
      lookup,
      agent: false,
      autoSelectFamily: true
    } as unknown as import('node:http').RequestOptions
    const request = httpRequest(
      options,
      (response) => {
        let body = ''
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        response.on('end', () => resolve(body))
      }
    )
    request.on('error', reject)
    request.end()
  })
}

describe('自定义 lookup 与真实 http.request', () => {
  it('测试专用 lookup（all:true 返回数组）→ 真实连接成功，且 Node 确实传了 all:true', async () => {
    let sawAll: boolean | undefined
    let shape: 'array' | 'single' | null = null
    const testLookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
      expect(hostname).toBe('sync.test')
      sawAll = Boolean(options.all)
      if (sawAll) {
        shape = 'array'
        callback(null, [{ address: '127.0.0.1', family: 4 }])
      } else {
        shape = 'single'
        callback(null, '127.0.0.1', 4)
      }
    }) as unknown as LookupFunction

    const body = await fetchThrough(testLookup)
    expect(body).toBe('lookup-ok')
    expect(sawAll).toBe(true)
    expect(shape).toBe('array')
  })

  it('生产 guarded lookup 在真实连接时拒绝私有目标（假 DNS 返回 127.0.0.1）', async () => {
    const guarded = createGuardedLookup((_host, _opts, callback) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }])
    })
    await expect(fetchThrough(guarded)).rejects.toThrow(/blocked private address/)
  })
})
