import { request as httpsRequest } from 'node:https'

/**
 * 局域网同步测试的 TLS HTTP 客户端——**模拟 iOS SyncNetworkClient 的
 * 锚定信任语义**：
 *
 * - 桌面自签证书不进系统信任链；iOS 在配对成功后把**证书本体**存进
 *   Keychain，并在每次连接时用 `SecTrustSetAnchorCertificates` 把它设为
 *   唯一信任锚、`SecTrustSetAnchorCertificatesOnly(true)` 只信这一个锚、
 *   然后走**标准链评估**——证书不一致 / 过期 / 换签全部失败。
 * - Node 模拟：`ca: [trustedCertPem]` + `rejectUnauthorized: true` 等价于
 *   同一条信任链；`checkServerIdentity` 返回 undefined 跳过 hostname 校验
 *   （自签证书的 SAN 不含 IP，hostname 由配对交付的 host 覆盖）。
 * - 信任锚不匹配 → 标准 TLS 验证失败 → 连接拒绝，**没有明文回退**。
 */
export function syncTlsFetch(
  url: string,
  init?: RequestInit,
  trustedCertPem = ''
): Promise<{
  ok: boolean
  status: number
  headers: Record<string, string | string[] | undefined>
  json: () => Promise<unknown>
  text: () => Promise<string>
}> {
  const parsed = new URL(url)
  const method = init?.method ?? 'GET'
  const rawBody = init?.body
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : (rawBody as Buffer | undefined)
  const headers = (init?.headers ?? {}) as Record<string, string>
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers,
        rejectUnauthorized: true,
        ca: trustedCertPem ? [trustedCertPem] : undefined,
        // SAN 只有 DNS 名（brewphase.sync.local），IP 直连时跳过 hostname
        // 校验——身份由「证书即唯一信任锚」保证，hostname 由配对交付。
        checkServerIdentity: () => undefined
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode ?? 0
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: res.headers,
            json: async () => JSON.parse(text),
            text: async () => text
          })
        })
        res.on('error', reject)
      }
    )
    req.on('error', (error) => reject(error))
    if (body) req.write(body)
    req.end()
  })
}
