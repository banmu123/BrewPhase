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

    const onInstalled: { addListener(listener: () => void): void }
    const onStartup: { addListener(listener: () => void): void }
  }

  namespace contextMenus {
    type ContextType =
      | 'page'
      | 'selection'
      | 'image'
      | 'link'
      | 'editable'
      | 'frame'
      | 'video'
      | 'audio'

    interface CreateProperties {
      id?: string
      title?: string
      contexts?: ContextType[]
      parentId?: string
      documentUrlPatterns?: string[]
      targetUrlPatterns?: string[]
    }

    interface OnClickData {
      menuItemId: string | number
      parentMenuItemId?: string | number
      selectionText?: string
      srcUrl?: string
      pageUrl?: string
      frameId?: number
    }

    function create(properties: CreateProperties, callback?: () => void): string | number
    function removeAll(callback?: () => void): void
    const onClicked: {
      addListener(listener: (info: OnClickData, tab?: tabs.Tab) => void): void
    }
  }

  namespace tabs {
    interface Tab {
      id?: number
      url?: string
      title?: string
      favIconUrl?: string
      windowId?: number
    }

    function query(queryInfo: {
      active?: boolean
      currentWindow?: boolean
    }): Promise<Tab[]>

    function get(tabId: number): Promise<Tab>
    function create(createProperties: {
      url: string
      active?: boolean
    }): Promise<Tab>
    function captureVisibleTab(
      windowId?: number,
      options?: { format?: 'png' | 'jpeg'; quality?: number }
    ): Promise<string>
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }

    const session: StorageArea
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number
    }

    function executeScript<T>(injection: {
      target: InjectionTarget
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      func: (...args: any[]) => T
      args?: unknown[]
    }): Promise<Array<{ result?: T }>>
  }
}
