import { get } from 'node:https'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { EmbedHost } from '../../src/main/embed-host'

const hosts: EmbedHost[] = []

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop()
})

function newHost(): EmbedHost {
  const host = new EmbedHost()
  hosts.push(host)
  return host
}

function getHttp(
  origin: string,
  path: string,
  hostHeader?: string
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const parsed = new URL(origin)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: parsed.hostname,
        port: parsed.port,
        path,
        headers: hostHeader === undefined ? {} : { host: hostHeader }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers
          })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('embed host（YouTube 错误 153 的回环包装页）', () => {
  it('启动后返回 http origin（127.0.0.1 + 随机端口），且每次启动端口不同', async () => {
    const first = await newHost().start()
    expect(first).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const second = await newHost().start()
    expect(second).not.toBe(first)
  })

  it('包装页：合法 videoId → iframe 指向 youtube-nocookie 并带 origin 参数 + 严格 CSP', async () => {
    const host = newHost()
    const origin = await host.start()
    const response = await getHttp(origin, '/youtube/dQw4w9WgXcQ')
    expect(response.status).toBe(200)
    // CSP：default-src none + 只放行 nocookie 播放器
    expect(String(response.headers['content-security-policy'])).toContain("default-src 'none'")
    expect(String(response.headers['content-security-policy'])).toContain('frame-src https://www.youtube-nocookie.com')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    // iframe：ID 只由路径拼；origin 参数 = 包装页自己的 origin
    expect(response.body).toContain('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
    expect(response.body).toContain(`origin=${encodeURIComponent(origin)}`)
    // 不该出现第二个可执行入口
    expect(response.body).not.toContain('<script')
  })

  it('非法 videoId（路径穿越 / 错误长度 / 特殊字符）→ 400，绝不进 URL', async () => {
    const host = newHost()
    const origin = await host.start()
    for (const path of [
      '/youtube/..%2F..%2Fetc%2Fpasswd',
      '/youtube/short',
      '/youtube/waytoolongvideoidthanallowed123',
      '/youtube/<script>',
      '/youtube/'
    ]) {
      const response = await getHttp(origin, path)
      expect(response.status, path).toBe(400)
    }
  })

  it('非 /youtube 路径 → 404', async () => {
    const host = newHost()
    const origin = await host.start()
    for (const path of ['/', '/status', '/youtube', '/anything/else']) {
      const response = await getHttp(origin, path)
      expect(response.status, path).toBe(404)
    }
  })

  it('Host 头与自身不符 → 403（DNS rebinding 防御）', async () => {
    const host = newHost()
    const origin = await host.start()
    const response = await getHttp(origin, '/youtube/dQw4w9WgXcQ', 'evil.example.com:80')
    expect(response.status).toBe(403)
  })

  it('start 参数只接受数字（断点续播），其它丢弃', async () => {
    const host = newHost()
    const origin = await host.start()
    const good = await getHttp(origin, '/youtube/dQw4w9WgXcQ?start=90')
    expect(good.body).toContain('&start=90')
    const bad = await getHttp(origin, '/youtube/dQw4w9WgXcQ?start=alert(1)')
    expect(bad.body).not.toContain('alert(1)')
  })

  it('stop 后 origin 不再可达（句柄全部释放）', async () => {
    const host = newHost()
    const origin = await host.start()
    host.stop()
    await expect(getHttp(origin, '/youtube/dQw4w9WgXcQ')).rejects.toThrow()
  })
})
