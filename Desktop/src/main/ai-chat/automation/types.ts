/**
 * Multi-AI 页面自动化的契约。
 *
 * 分层：Adapter 只提供「在页面里跑的脚本」与域名白名单，完全不知道 Electron；
 * PageManager 持有 WebContentsView，负责把脚本送进去；Coordinator 负责并行、
 * 状态机与超时。这样选择器永远只改 Adapter 一处。
 *
 * 所有脚本返回可 JSON 序列化的对象——executeJavaScript 的结果要跨 IPC。
 */

export const AI_PROVIDERS = ['chatgpt', 'claude'] as const
export type AIProvider = (typeof AI_PROVIDERS)[number]

/** 一次提问任务里，单个平台的执行状态。两个平台各自独立。 */
export type AIChatTaskState =
  | 'idle'
  | 'checking'
  | 'ready'
  | 'sending'
  | 'generating'
  | 'completed'
  | 'login_required'
  | 'page_unavailable'
  | 'unsupported_page'
  | 'timeout'
  | 'failed'
  | 'cancelled'

export function isTerminalTaskState(state: AIChatTaskState): boolean {
  return (
    state === 'completed' ||
    state === 'login_required' ||
    state === 'page_unavailable' ||
    state === 'unsupported_page' ||
    state === 'timeout' ||
    state === 'failed' ||
    state === 'cancelled'
  )
}

/** 单个平台的当前可用性（Accounts 页与 Multi-AI 顶部都展示它）。 */
export type AIPlatformStatus = {
  provider: AIProvider
  /** 后台页面是否存在且活着。 */
  pageAlive: boolean
  /** 页面当前 URL（不存在时为空）。 */
  url: string
  title: string
  /**
   * 登录判定。**只基于页面 DOM 的可见信号**（输入框是否存在等），
   * 不读 Cookie；判定不了时是 unknown，界面要求用户自己去确认。
   */
  login: 'logged_in' | 'logged_out' | 'unknown'
  /** 当前任务的执行状态（无任务时 idle）。 */
  taskState: AIChatTaskState
  /** 上一次完成 / 失败的原因，给 UI 的排查提示。 */
  lastNote: string
}

/** ask 的入参（IPC schema 再校验一遍长度）。 */
export type AIAskInput = {
  prompt: string
  providers: AIProvider[]
}

/** 单平台的最终结果。 */
export type AIProviderResult = {
  provider: AIProvider
  state: AIChatTaskState
  /** 提取到的最终回答；state 不是 completed 时为空串。 */
  content: string
  /** 给人看的失败原因（已本地化由 UI 决定，这里存原始事实）。 */
  note: string
  /** 结果页 URL——保留来源，方便回原网页核对。 */
  url: string
}

/** 一次 Multi-AI 任务的整体快照（推送与查询共用）。 */
export type AIChatTaskSnapshot = {
  taskId: string
  prompt: string
  createdAt: number
  results: AIProviderResult[]
}

/**
 * 页面内探测的返回形状。字段全是字面量，避免脚本与 TS 之间约定漂移。
 */
export type PageProbe = {
  loggedIn: boolean
  /** loggedIn=false 时给 reason；UI 能据此区分「没登录」与「改版了」。 */
  reason: string
  inputReady: boolean
  generating: boolean
  /** 最近一条助手回答的可见文本。 */
  answer: string
  /** 提交后分配的稳定标识（页面里自己的序号），用于避免把上一问的回答当成这一问。 */
  answerSeq: number
}
