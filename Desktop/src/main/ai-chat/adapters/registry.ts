import { matchesAllowedHost } from './host-match'
import type { AIPlatformAdapter, AIPlatformDescriptor } from './types'

/**
 * AI 平台注册中心（Phase 4.2）。
 *
 * 职责只有三件事，每件都必须是确定的：
 * 1. **按真实 URL 识别平台**——严格主机名匹配（精确或子域后缀），相似域名
 *    与模糊包含都冒充不了平台；解析失败（非法 URL、非 http/https）返回 null。
 * 2. **区分「已识别」与「可自动交互」**——descriptor 没有 adapter 时，
 *    `resolve` 仍返回描述符（UI 显示「已识别 · 尚未适配」），但调用方
 *    绝不能对它执行自动化。
 * 3. **开放扩展**——新平台 register 进来即可，圆桌核心零改动；
 *    同一 adapter 可以服务于任意多个 tabId（平台 ID 不等于页面身份）。
 */
export class AIAdapterRegistry {
  private readonly descriptors = new Map<string, AIPlatformDescriptor>()

  register(descriptor: AIPlatformDescriptor): void {
    if (this.descriptors.has(descriptor.id)) {
      throw new Error(`platform already registered: ${descriptor.id}`)
    }
    this.descriptors.set(descriptor.id, descriptor)
  }

  unregister(platformId: string): boolean {
    return this.descriptors.delete(platformId)
  }

  get(platformId: string): AIPlatformDescriptor | null {
    return this.descriptors.get(platformId) ?? null
  }

  has(platformId: string): boolean {
    return this.descriptors.has(platformId)
  }

  list(): AIPlatformDescriptor[] {
    return [...this.descriptors.values()]
  }

  /**
   * 按真实 URL 识别平台。返回 null = 不是任何已注册平台（普通网页）。
   * 返回值里的 adapter 可能是 undefined（已识别、尚未适配）。
   */
  resolve(url: string): { descriptor: AIPlatformDescriptor; adapter?: AIPlatformAdapter } | null {
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.matches(url)) return { descriptor, adapter: descriptor.adapter }
    }
    return null
  }

  /** 某平台是否具备自动交互能力（descriptor 存在且带 adapter）。 */
  isAdapted(platformId: string): boolean {
    return this.descriptors.get(platformId)?.adapter !== undefined
  }
}

/**
 * 平台识别的公共实现：给 descriptor.matches 用——语义与 Adapter 的
 * allowedHosts 完全一致，识别与执行永不漂移。
 */
export function platformMatcher(platformId: string, allowedHosts: readonly string[]): (url: string) => boolean {
  return (url: string) => matchesAllowedHost(platformId, allowedHosts, url)
}
