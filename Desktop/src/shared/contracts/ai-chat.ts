import { z } from 'zod'
import {
  AI_PROVIDERS as PROVIDERS,
  type AIChatTaskSnapshot,
  type AIChatTaskState,
  type AIPlatformStatus
} from '../../main/ai-chat/automation/types'

/**
 * Multi-AI（AI Workspace Phase 1）的渲染层契约。
 *
 * 类型从主进程模块 re-export——自动化契约只有一份，UI 不再复制一份形状
 * 然后慢慢漂移。zod 只校验跨 IPC 的输入。
 */

export const AI_PROVIDERS = PROVIDERS
export type AIProvider = (typeof PROVIDERS)[number]

export const aiProviderSchema = z.enum(AI_PROVIDERS)

export const aiChatTaskStateSchema = z.enum([
  'idle',
  'checking',
  'ready',
  'sending',
  'generating',
  'completed',
  'login_required',
  'page_unavailable',
  'unsupported_page',
  'timeout',
  'failed',
  'cancelled'
])

export const aiAskInputSchema = z.object({
  /** 1–4000 字符：防误触全选粘贴一本小说，也防把输入框当文档用。 */
  prompt: z.string().trim().min(1).max(4_000),
  providers: z.array(aiProviderSchema).min(1).max(2)
})

export type AIAskInput = z.infer<typeof aiAskInputSchema>

/** 会话列表项与详情（保存的多模型讨论）。 */
export type AIConversationSummary = {
  id: string
  title: string
  prompt: string
  providers: string
  createdAt: number
}

export type AIMessageView = {
  id: string
  provider: string
  role: string
  content: string
  status: string
  note: string
  url: string
  createdAt: number
}

export type AIConversationDetail = {
  conversation: AIConversationSummary
  messages: AIMessageView[]
}

export type { AIChatTaskSnapshot, AIPlatformStatus, AIChatTaskState }

/**
 * 渲染层的终态判断（与主进程 isTerminalTaskState 同一份语义）：
 * busy = 任一平台处于非终态。放在共享层是因为圆桌与 Multi-AI 都要
 * 从广播快照里推导忙碌状态，不应该各写一份终态清单。
 */
const TERMINAL_AI_STATES = new Set([
  'completed',
  'login_required',
  'page_unavailable',
  'unsupported_page',
  'timeout',
  'failed',
  'cancelled'
])

export function isTerminalAIState(state: string): boolean {
  return TERMINAL_AI_STATES.has(state)
}

export function isAIChatTaskBusy(snapshot: AIChatTaskSnapshot | null): boolean {
  if (!snapshot) return false
  return snapshot.results.some((result) => !isTerminalAIState(result.state))
}
