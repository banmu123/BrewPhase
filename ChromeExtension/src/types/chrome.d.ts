/**
 * 只声明本项目真正用到的 Chrome 扩展 API。
 *
 * 不引入 `@types/chrome`：这里需要的面很窄（tabs / scripting / runtime），
 * 自己声明能把「扩展能做什么」显式钉在代码里，也避免类型包版本漂移。
 */

declare namespace chrome {
  namespace runtime {
    interface Port {
      postMessage(message: unknown): void
      disconnect(): void
      onMessage: { addListener(listener: (message: unknown) => void): void }
      onDisconnect: { addListener(listener: () => void): void }
    }

    interface LastError {
      message?: string
    }

    function connectNative(application: string): Port
    function sendMessage<T = unknown>(message: unknown): Promise<T>
    function getURL(path: string): string

    const lastError: LastError | undefined
    const id: string

    const onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response?: unknown) => void
        ) => boolean | void
      ): void
    }
  }

  namespace tabs {
    interface Tab {
      id?: number
      url?: string
      title?: string
      favIconUrl?: string
    }

    function query(queryInfo: {
      active?: boolean
      currentWindow?: boolean
    }): Promise<Tab[]>
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number
    }

    function executeScript<T>(injection: {
      target: InjectionTarget
      func: () => T
    }): Promise<Array<{ result?: T }>>
  }
}
