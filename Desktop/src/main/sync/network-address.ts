import { networkInterfaces } from 'node:os'

/**
 * 本机真实局域网 IPv4 地址（§3 多 IP 连接能力）：
 * - 排除 loopback 与链路本地（169.254.*）；
 * - **按接口类型排序**：物理网卡（en*）优先，iPhone USB/桥接其次，
 *   VPN（utun/tun/tap）与容器虚拟网卡（docker/veth）排最后——它们通常
 *   不是手机可达的网段；
 * - `0.0.0.0` 只是监听地址，绝不把它当「局域网地址」发给手机。
 */
export function lanAddresses(): string[] {
  const entries: Array<{ name: string; address: string }> = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== 'IPv4') continue
      if (address.address.startsWith('169.254.')) continue
      entries.push({ name, address: address.address })
    }
  }
  return entries
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map((entry) => entry.address)
}

/** 接口名 → 优先级（小者靠前）。 */
function rank(name: string): number {
  const lower = name.toLowerCase()
  if (lower.startsWith('en')) return 0 // 物理网卡（en0 通常是 Wi-Fi）
  if (lower.startsWith('ap')) return 1 // iPhone USB / 接入点
  if (lower.startsWith('bridge') || lower.startsWith('eth')) return 2
  if (lower.startsWith('docker') || lower.startsWith('veth')) return 6
  if (lower.startsWith('utun') || lower.startsWith('tun') || lower.startsWith('tap')) return 7 // VPN
  return 5 // 其余虚拟网卡
}

/** 服务器要监听的地址集合；一个都没有时回落到全部接口。 */
export function listenAddresses(): string[] {
  const list = lanAddresses()
  return list.length > 0 ? list : ['0.0.0.0']
}
