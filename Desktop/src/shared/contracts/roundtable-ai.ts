import { z } from 'zod'
import type { AIChatTaskState } from '../../main/ai-chat/automation/types'

/**
 * 真实 WebCard 驱动的圆桌问答契约（Phase 4.2）。
 *
 * 身份规则：**tabId 是参与者身份，platformId 只是能力标签**。
 * 同一平台可以有多张卡（多个独立参与者）；同平台不同卡的状态与回答
 * 永不合并。Renderer 只传 tabId——平台识别、WebContents 解析、能力判定
 * 全部在主进程，Renderer 无从（也无须）伪造身份。
 */

/** 并发安全上限：一轮圆桌任务最多同时驱动的参与者数（可按机器调整）。 */
export const ROUNDTABLE_AI_MAX_PARTICIPANTS = 12

/**
 * Multi-AI 提问条（「开始讨论」）的 UI 开关。
 *
 * **暂时屏蔽**（用户要求，2026-11-15）：圆桌当前聚焦多网页工作空间，
 * 真实平台的并行问答等稳定后随测试接缝一起回归。恢复时改回 `true`
 * 即可——停靠区块与独立窗口底部的提问条 / 讨论抽屉都由它控制，
 * 底层链路（participant-service / IPC / 持久化 / 事件广播）原样保留。
 * 恢复时记得把 roundtable-ai.e2e 的 skip 一并解除。
 */
export const ROUNDTABLE_ASK_UI_ENABLED = false

/**
 * 任务快照广播通道。与 `roundtable:changed` 同一模式：preload 是 sandboxed
 * 的，通道名只能放共享层；主窗口与圆桌独立窗口都订阅它。
 */
export const ROUNDTABLE_AI_TASK_CHANGED_CHANNEL = 'roundtable-ai-task:changed'

/** 单个圆桌成员的识别与登录状态（成员卡展示用）。 */
export type AIRoundtableParticipantStatus = {
  tabId: string
  /** 已识别的平台 id；普通网页（未识别）为 null。 */
  platformId: string | null
  /** 平台展示名（已识别时），如 ChatGPT / Gemini。 */
  platformName: string | null
  /** 是否具备自动交互能力（已识别且已适配）。 */
  adapted: boolean
  login: 'logged_in' | 'logged_out' | 'unknown' | 'unavailable'
  /** 该成员当前任务的执行状态（无任务时 idle）。 */
  taskState: AIChatTaskState
  /** 实时 URL / 标题（来自真实 WebContents）。 */
  url: string
  title: string
  /** 探测或识别的排查信息。 */
  note: string
}

/** 单个参与者的任务结果（按 tabId 区分，同平台多卡互不混淆）。 */
export type AIRoundtableTaskResult = {
  tabId: string
  platformId: string
  displayName: string
  state: AIChatTaskState
  content: string
  note: string
  url: string
  title: string
}

/** 一轮圆桌任务的整体快照（广播与 hydration 共用）。 */
export type AIRoundtableTaskSnapshot = {
  taskId: string
  prompt: string
  createdAt: number
  results: AIRoundtableTaskResult[]
  conversationId?: string
}

export const roundtableAIAskInputSchema = z.object({
  prompt: z.string().trim().min(1).max(4_000),
  participantTabIds: z
    .array(z.string().min(1))
    .min(1)
    .max(ROUNDTABLE_AI_MAX_PARTICIPANTS, `一轮讨论最多 ${ROUNDTABLE_AI_MAX_PARTICIPANTS} 位 AI 成员`)
})

export type AIRoundtableAskInput = z.infer<typeof roundtableAIAskInputSchema>

export const roundtableAIDescribeInputSchema = z.object({
  tabIds: z.array(z.string().min(1)).max(ROUNDTABLE_AI_MAX_PARTICIPANTS)
})

/** 渲染层的终态判断（与主进程 isTerminalTaskState 同一份语义）。 */
const TERMINAL_AI_STATES = new Set([
  'completed',
  'login_required',
  'page_unavailable',
  'unsupported_page',
  'timeout',
  'failed',
  'cancelled'
])

export function isRoundtableAITaskBusy(snapshot: AIRoundtableTaskSnapshot | null): boolean {
  if (!snapshot) return false
  return snapshot.results.some((result) => !TERMINAL_AI_STATES.has(result.state))
}
