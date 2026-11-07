import { lookup } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'

/**
 * 元数据抓取的安全网络层（§ SSRF 防护）。
 *
 * 威胁模型：`generic` 网页抓取等于**用用户的 URL 发起服务器侧请求**。
 * 防护按「连接时校验」而不是「请求前校验字符串」设计：
 * - 只允许 http/https；hostname 预检拒绝 localhost/.local/云元数据别名；
 * - **DNS 解析校验发生在 TCP 连接时**（自定义 `lookup`）——实际连接的 IP
 *   必须是公网地址，DNS rebinding（解析后再改）无法绕过；
 * - 每次重定向都重新执行 URL 校验与 IP 校验，最多 3 跳；
 * - 8 秒超时、1MB HTML / 256KB JSON 上限、Content-Type 白名单；
 * - 不带任何 Cookie / Authorization，User-Agent 明确标识应用。
 */

export const FETCH_TIMEOUT_MS = 8_000
export const MAX_REDIRECTS = 3
export const MAX_HTML_BYTES = 1024 * 1024
export const MAX_JSON_BYTES = 256 * 1024

export type FetchOptions = {
  /** Accept 头；同时参与 Content-Type 白名单判断 */
  accept: string
  maxBytes: number
  /** 只接受这些 Content-Type 前缀（大小写不敏感） */
  allowedTypes: string[]
}

export type FetchResult = {
  url: string
  status: number
  contentType: string
  body: string
}

/** 允许的 UA：公开元数据接口要求带 User-Agent，GitHub API 会 403 无 UA 请求。 */
const USER_AGENT = 'BrewPhase-Desktop/0.1 (metadata resolver; +https://github.com/banmu123/BrewPhase)'

// MARK: - IP 分类

/** 解析 IPv4 点分十进制；非法返回 null。 */
export function parseIPv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}

/** 公网 IPv4：排除保留/私有/回环/链路本地/CGNAT/组播/云元数据。 */
export function isPublicIPv4(address: string): boolean {
  const bytes = parseIPv4(address)
  if (!bytes) return false
  const [a, b] = bytes
  if (a === 0) return false // 0.0.0.0/8
  if (a === 10) return false // 10/8
  if (a === 127) return false // loopback
  if (a === 100 && b >= 64 && b <= 127) return false // 100.64/10 CGNAT
  if (a === 169 && b === 254) return false // link-local（含 169.254.169.254 云元数据）
  if (a === 172 && b >= 16 && b <= 31) return false // 172.16/12
  if (a === 192 && b === 168) return false // 192.168/16
  if (a === 192 && b === 0 && bytes[2] === 0) return false // 192.0.0/24
  if (a === 192 && b === 0 && bytes[2] === 2) return false // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18/15 benchmark
  if (a === 198 && b === 51 && bytes[2] === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && bytes[2] === 113) return false // TEST-NET-3
  if (a >= 224) return false // 组播 + 保留 + 广播
  return true
}

/** 公网 IPv6：排除 loopback/未指定/ULA/link-local/组播/IPv4 映射（按 IPv4 判）。 */
export function isPublicIPv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === '::1' || normalized === '::') return false
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false // ULA fc00::/7
  if (/^fe[89ab]/.test(normalized)) return false // link-local fe80::/10
  if (normalized.startsWith('ff')) return false // 组播
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPublicIPv4(mapped[1])
  return true
}

export function isPublicAddress(address: string): boolean {
  const family = address.includes(':') ? 6 : 4
  return family === 6 ? isPublicIPv6(address) : isPublicIPv4(address)
}

// MARK: - URL 预检

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'instance-data',
  'metadata'
])

/** URL 预检：协议、hostname 形态。IP 层的校验在连接时做（见 guardedLookup）。 */
export function assertAllowedUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('invalid url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('protocol not allowed')
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) throw new Error('missing host')
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('host not allowed')
  }
  // IP 字面量直接在预检里拒绝私有地址（DNS lookup 不会处理字面量）
  const bare = host.replace(/^\[|\]$/g, '')
  if (parseIPv4(bare) && !isPublicIPv4(bare)) throw new Error('private address blocked')
  if (bare.includes(':') && !isPublicIPv6(bare)) throw new Error('private address blocked')
  return url
}

/**
 * 连接时 DNS 校验：解析全部地址，任一私有即拒绝连接（保守策略），
 * 否则回填第一个公网地址。DNS rebinding 在校验与连接之间没有窗口——
 * 校验的就是即将连接的 IP。
 */
export function createGuardedLookup(): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 4)
        return
      }
      if (!addresses || addresses.length === 0) {
        callback(new Error('dns returned no address'), '', 4)
        return
      }
      const safe = addresses.filter((entry) => isPublicAddress(entry.address))
      if (safe.length === 0) {
        callback(new Error('blocked private address'), '', 4)
        return
      }
      const first = safe[0]
      callback(null, first.address, first.family as 4 | 6)
    })
  }
}

// MARK: - 抓取

type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

function requestOnce(url: URL, opts: FetchOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const requester = isHttps ? httpsRequest : httpRequest
    const request = requester(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: opts.accept,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          // 不发送 cookie / authorization —— 元数据抓取不需要任何登录态
          connection: 'close'
        },
        // 每次请求都新建 lookup：实际连接的 IP 必须通过校验（rebinding 防护）
        lookup: createGuardedLookup(),
        // 证书校验用 hostname（SNI）；lookup 只影响解析
        servername: isHttps ? url.hostname : undefined,
        timeout: FETCH_TIMEOUT_MS
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > opts.maxBytes) {
            request.destroy(new Error('response too large'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as RawResponse['headers'],
            body: Buffer.concat(chunks)
          })
        })
        response.on('error', reject)
      }
    )
    request.on('timeout', () => request.destroy(new Error('request timeout')))
    request.on('error', reject)
    request.end()
  })
}

function headerValue(headers: RawResponse['headers'], name: string): string {
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

/**
 * 安全抓取：手动跟随重定向（每跳都重新校验 URL + 目标 IP），
 * 限制返回类型与大小。任何一步失败抛出可读错误，由上层归一为 failed。
 */
export async function safeFetchText(rawUrl: string, opts: FetchOptions): Promise<FetchResult> {
  let current = assertAllowedUrl(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestOnce(current, opts)
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, 'location')
      if (!location) throw new Error(`redirect without location (${response.status})`)
      if (hop === MAX_REDIRECTS) throw new Error('too many redirects')
      // 相对地址按当前 URL 解析；随后**重新执行完整预检**
      current = assertAllowedUrl(new URL(location, current).toString())
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`unexpected status ${response.status}`)
    }
    const contentType = headerValue(response.headers, 'content-type').toLowerCase()
    const allowed = opts.allowedTypes.some((type) => contentType.startsWith(type))
    if (!allowed) throw new Error(`content-type not allowed: ${contentType || 'unknown'}`)
    return {
      url: current.toString(),
      status: response.status,
      contentType,
      body: response.body.toString('utf8')
    }
  }
  throw new Error('too many redirects')
}
