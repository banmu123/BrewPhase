/**
 * 应用事件：Renderer IPC 与 MCP Bridge 共用的「数据变了」通知。
 *
 * 只广播领域名，不带数据——各页面订阅后自己重新取，避免出现第二份状态。
 * Main 在 bootstrap 里注册一个监听器，把事件转成 `app:changed` 发给所有窗口。
 */

export type AppDomain = 'records' | 'coffee' | 'canvas' | 'workContexts' | 'personalDirection'

export class ApplicationEvents {
  private readonly listeners = new Set<(domain: AppDomain) => void>()

  onChanged(listener: (domain: AppDomain) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(domain: AppDomain): void {
    for (const listener of this.listeners) {
      try {
        listener(domain)
      } catch {
        // 单个监听器失败不能影响写入结果。
      }
    }
  }
}
