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
  // 192.88.99.0/24：已废弃的 6to4 Relay Anycast（IANA 标记 Globally Reachable: N/A）
  // 整段拒绝，不是只挡某一个地址——它是 IPv6 到 IPv4 的中继入口，没有正常用途
  if (a === 192 && b === 88 && bytes[2] === 99) return false
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18/15 benchmark
  if (a === 198 && b === 51 && bytes[2] === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && bytes[2] === 113) return false // TEST-NET-3
  if (a >= 224) return false // 组播 + 保留 + 广播
  return true
}

/**
 * IPv6 解析成 8 个 16 位分组；非法返回 null。
 *
 * 支持 `::` 压缩、结尾内嵌 IPv4（`::ffff:192.168.0.1`、`64:ff9b::1.2.3.4`）、
 * zone id（`fe80::1%en0`）。**地址判断一律基于分组做按位前缀匹配**，不用
 * 字符串前缀——`startsWith('2001')` 既会误伤 `2001:4860::`（Google），
 * 也挡不住 `2001:0db8::` 之类的等价写法。
 */
export function parseIPv6(raw: string): number[] | null {
  let text = raw.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!text.includes(':')) return null
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)

  let embedded: [number, number] | null = null
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const bytes = parseIPv4(tail)
    if (!bytes) return null
    embedded = [(bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]]
    // 用 0:0 占位，解析完再把最后两组替换回内嵌 IPv4
    text = `${text.slice(0, lastColon + 1)}0:0`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const parseSide = (side: string): number[] | null => {
    if (!side) return []
    const out: number[] = []
    for (const part of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      out.push(Number.parseInt(part, 16))
    }
    return out
  }
  const head = parseSide(halves[0])
  const rest = halves.length === 2 ? parseSide(halves[1]) : []
  if (!head || !rest) return null

  let groups: number[]
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length
    if (missing < 1) return null
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest]
  } else {
    if (head.length !== 8) return null
    groups = head
  }
  if (embedded) {
    groups[6] = embedded[0]
    groups[7] = embedded[1]
  }
  return groups
}

/** 按位前缀匹配（不是字符串前缀）。 */
function inPrefix(groups: number[], prefix: number[], bits: number): boolean {
  let remaining = bits
  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const take = Math.min(16, remaining)
    const mask = (0xffff << (16 - take)) & 0xffff
    if ((groups[index] & mask) !== ((prefix[index] ?? 0) & mask)) return false
    remaining -= take
  }
  return true
}

/** 全球单播 2000::/3——唯一放行的地址空间。 */
const GLOBAL_UNICAST_2000_3 = [0x2000, 0, 0, 0, 0, 0, 0, 0]

/**
 * 2000::/3 之内的特殊用途段（IANA IPv6 Special-Purpose Address Registry）。
 * 落在 2000::/3 之外的段由「只放行全球单播」统一挡掉，见下方说明。
 */
const SPECIAL_WITHIN_GLOBAL_UNICAST: Array<{ prefix: number[]; bits: number; note: string }> = [
  {
    prefix: [0x2001, 0, 0, 0, 0, 0, 0, 0],
    bits: 23,
    note: '2001::/23 IETF 协议分配（Teredo 2001::/32、benchmarking 2001:2::/48、ORCHID 2001:10::/28、AMT、AS112…）'
  },
  { prefix: [0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], bits: 32, note: '2001:db8::/32 文档' },
  { prefix: [0x2002, 0, 0, 0, 0, 0, 0, 0], bits: 16, note: '2002::/16 6to4（内嵌 IPv4，可经中继触达私有网）' },
  { prefix: [0x3fff, 0, 0, 0, 0, 0, 0, 0], bits: 20, note: '3fff::/20 文档（RFC 9637）' }
]

function ipv4FromGroups(groups: number[]): string {
  const hi = groups[6]
  const lo = groups[7]
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
}

function isMappedGroups(groups: number[]): boolean {
  return (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  )
}

/**
 * IPv4-mapped IPv6（`::ffff:a.b.c.d` / `::ffff:7f00:1` / 完整 8 组写法）还原成 IPv4。
 * 十六进制形式是常见绕过手法（`::ffff:7f00:1` 就是 127.0.0.1），必须覆盖。
 */
export function ipv4FromMappedIPv6(address: string): string | null {
  const groups = parseIPv6(address)
  if (!groups || !isMappedGroups(groups)) return null
  return ipv4FromGroups(groups)
}

/**
 * 公网 IPv6 判定（白名单 + 段内黑名单）：
 *
 * 1. IPv4-mapped 先还原成 IPv4，走统一的 IPv4 规则（点分/十六进制都覆盖）；
 * 2. **只放行全球单播 2000::/3**。以下特殊用途段全部落在 2000::/3 之外，
 *    因此一律拒绝：`::/128`、`::1/128`、`64:ff9b::/96`（NAT64 WKP）、
 *    `64:ff9b:1::/48`（本地 NAT64，RFC 8215）、`100::/64`（discard-only）、
 *    `5f00::/16`（SRv6 SIDs）、`fc00::/7`（ULA）、`fe80::/10`（link-local）、
 *    `ff00::/8`（组播）。NAT64 前缀内嵌 IPv4、可经转换网关触达私有网，
 *    元数据抓取没有使用它的理由 → 明确拒绝而不是当公网地址；
 * 3. 2000::/3 之内再排除 IANA 登记的特殊用途段（Teredo/6to4/文档/benchmark）。
 */
export function isPublicIPv6(address: string): boolean {
  const groups = parseIPv6(address)
  if (!groups) return false
  if (isMappedGroups(groups)) return isPublicIPv4(ipv4FromGroups(groups))
  if (!inPrefix(groups, GLOBAL_UNICAST_2000_3, 3)) return false
  return !SPECIAL_WITHIN_GLOBAL_UNICAST.some((entry) => inPrefix(groups, entry.prefix, entry.bits))
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

/** DNS 解析器签名（默认 node:dns.lookup，测试可注入假 DNS）。 */
export type DnsResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
  callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void
) => void

/**
 * 连接时 DNS 校验：解析全部地址，任一私有即拒绝连接（保守策略），
 * 否则回填第一个公网地址。DNS rebinding 在校验与连接之间没有窗口——
 * 校验的就是即将连接的 IP。
 */
export function createGuardedLookup(resolve: DnsResolver = lookup as unknown as DnsResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      // Node 的 LookupFunction 有两种回调契约（20+ 的 autoSelectFamily 会传
      // `all: true` 并期待数组）。必须按外部传入的 options.all 回填对应形状，
      // 否则连接层拿到错误的返回类型（P0，第三轮修复）。
      const wantsAll = Boolean((options as { all?: boolean }).all)
      if (error) {
        if (wantsAll) (callback as unknown as (e: Error, a: []) => void)(error, [])
        else callback(error, '', 4)
        return
      }
      if (!addresses || addresses.length === 0) {
        const empty = new Error('dns returned no address')
        if (wantsAll) (callback as unknown as (e: Error, a: []) => void)(empty, [])
        else callback(empty, '', 4)
        return
      }
      const safe = addresses.filter((entry) => isPublicAddress(entry.address))
      if (safe.length === 0) {
        const blocked = new Error('blocked private address')
        if (wantsAll) (callback as unknown as (e: Error, a: []) => void)(blocked, [])
        else callback(blocked, '', 4)
        return
      }
      if (wantsAll) {
        // 保持解析器给出的顺序；连接层自己做 Happy Eyeballs
        ;(callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(
          null,
          safe.map((entry) => ({ address: entry.address, family: entry.family }))
        )
        return
      }
      const first = safe[0]
      callback(null, first.address, first.family as 4 | 6)
    })
  }
}

// MARK: - 抓取

export type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

/** 单跳请求签名（默认真实 socket；测试注入假响应，覆盖重定向逻辑）。 */
export type RequestOnce = (url: URL, opts: FetchOptions) => Promise<RawResponse>

export function requestOnce(url: URL, opts: FetchOptions): Promise<RawResponse> {
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
export async function safeFetchText(
  rawUrl: string,
  opts: FetchOptions,
  requestImpl: RequestOnce = requestOnce
): Promise<FetchResult> {
  let current = assertAllowedUrl(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestImpl(current, opts)
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
