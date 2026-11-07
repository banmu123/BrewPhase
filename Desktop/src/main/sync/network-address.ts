import { networkInterfaces } from 'node:os'

/**
 * 本机真实局域网 IPv4 地址，按优先级排序（en0 优先，排除 loopback 与
 * 链路本地）。`0.0.0.0` 只是监听地址，绝不把它当「局域网地址」发给手机。
 */
export function lanAddresses(): string[] {
  const result: string[] = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== 'IPv4') continue
      if (address.address.startsWith('169.254.')) continue
      result.push(address.address)
    }
  }
  // en0 / en 前缀的接口通常是主网卡；其余接口（虚拟网卡等）排后面。
  return result.sort((a, b) => rank(a) - rank(b))
}

function rank(address: string): number {
  return 0
}

/** 服务器要监听的地址集合；一个都没有时回落到全部接口。 */
export function listenAddresses(): string[] {
  const list = lanAddresses()
  return list.length > 0 ? list : ['0.0.0.0']
}
