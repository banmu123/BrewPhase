import type { PageProbe } from '../automation/types'
import { matchesAllowedHost } from './host-match'

/**
 * 通用 AI 平台适配器契约（Phase 4.2）。
 *
 * Adapter 负责**平台差异**的全部知识：域名识别、登录探测、输入框定位、
 * 问题写入、发送、回答提取、生成状态判断。圆桌核心（ParticipantService）
 * 与调度引擎只认 `platformId` + `tabId`，不含任何平台的 DOM 选择器。
 *
 * 与旧 `PlatformAdapter`（automation/adapters.ts，遗留 Multi-AI 路径）的区别：
 * 旧接口只产出脚本字符串、由调用方 executeJavaScript；新接口接收
 * `AIWebCardContext`（真实 WebCard 的 WebContents）自己执行——自动化只发生
 * 在主进程、只发生在 Adapter 声明的域名范围内，Renderer 拿不到任何
 * WebContents 或任意脚本执行通道。
 */

/** 一次自动化调用的工作现场：真实 WebCard 的页面与身份。 */
export type AIWebCardContext = {
  /** 参与者身份（真实 WebCard 的 tabId）。 */
  tabId: string
  /** 页面的真实 WebContents（主进程内部使用，绝不跨 IPC 传递）。 */
  webContents: Electron.WebContents
  /** 当前 URL（从 WebContents 实时读取，不用渲染层快照）。 */
  url: string
  /** 当前标题（实时读取）。 */
  title: string
}

/** 探测结果：登录态 + 输入框可用性。字段与旧 PageProbe 一致，避免脚本漂移。 */
export type AIProbeResult = PageProbe

/** 提交结果：是否成功 + 原因 + 发送前的回答基线。 */
export type AISubmitResult = {
  ok: boolean
  reason: string
  baseline: number
}

/** 单次轮询读数：是否在生成 + 最近一条回答。 */
export type AIPollResult = {
  generating: boolean
  answer: string
  answerSeq: number
}

/**
 * 平台适配器。`matches` 与 `allowedHosts` 必须一致——Registry 用它识别 URL，
 * 执行期用它确认页面没有跳走；两者一起构成「只在自己的网站上自动化」的护栏。
 */
export interface AIPlatformAdapter {
  /** 平台 id（稳定、小写；持久化里 platformId 用它）。 */
  readonly id: string
  /** 展示名（UI 直接显示；不用于匹配）。 */
  readonly displayName: string
  /** 允许自动化的主机名（精确或以其为后缀的子域）。 */
  readonly allowedHosts: readonly string[]
  /** 打开登录页用的入口地址（可见浏览器里打开，不在后台建页）。 */
  readonly homeURL: string
  /** URL 是否属于本平台（严格主机名匹配；测试接缝见 host-match.ts）。 */
  matches(url: string): boolean
  /** 探测：登录态 + 输入框可用性（在真实页面上执行）。 */
  probe(context: AIWebCardContext): Promise<AIProbeResult>
  /** 写入问题并提交；返回发送前的回答基线。 */
  submit(context: AIWebCardContext, prompt: string): Promise<AISubmitResult>
  /** 单次轮询读数（生成状态 + 最近回答）。 */
  poll(context: AIWebCardContext): Promise<AIPollResult>
}

/**
 * 平台**描述符**：识别元数据与自动化能力分离。
 * 已识别但没有 adapter 的平台（如未来接入前的 Gemini）会明确显示
 * 「已识别 · 尚未适配」，绝不伪装成可自动提问。
 */
export type AIPlatformDescriptor = {
  id: string
  displayName: string
  /** 识别规则：严格主机名匹配（与 allowedHosts 同一套规则）。 */
  matches(url: string): boolean
  /** 自动化能力；缺省 = 已识别但尚未适配。 */
  adapter?: AIPlatformAdapter
}

/* ------------------------------------------------------------------ */
/* 页面内共享的辅助脚本（每次注入，保持自包含）                          */
/* ------------------------------------------------------------------ */

/**
 * 把文本写进 contenteditable 并让框架感知。
 * execCommand 已废弃但对两类受控编辑器（React 受控 div / ProseMirror）
 * 仍是最可靠的输入通道；失败时退回 InputEvent + textContent。
 */
export const PAGE_HELPERS = `
function __bpPick(cands) {
  for (const sel of cands) {
    try {
      const list = document.querySelectorAll(sel)
      for (const el of list) {
        const r = el.getBoundingClientRect()
        if (r.width > 40 && r.height > 12) return el
      }
    } catch (e) {}
  }
  return null
}
function __bpText(el) {
  return (el && el.innerText ? el.innerText : '').trim()
}
function __bpInputText(el) {
  if (!el) return ''
  if (typeof el.value === 'string') return el.value
  return (el.innerText || '').trim()
}
function __bpNormalize(text) {
  return String(text || '').replace(/\\s+/g, '')
}
function __bpTypeInto(el, text) {
  try {
    el.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
    if (document.execCommand('insertText', false, text)) return true
  } catch (e) {}
  try {
    el.textContent = text
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    return true
  } catch (e) { return false }
}
function __bpClickFirst(cands) {
  for (const sel of cands) {
    try {
      const list = document.querySelectorAll(sel)
      for (const el of list) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) { el.click(); return true }
      }
    } catch (e) {}
  }
  return false
}
`

/** JSON.stringify 注入用户文本，杜绝把输入当脚本执行。 */
export function literal(text: string): string {
  return JSON.stringify(text)
}

/**
 * 脚本型 Adapter 的公共底座：probe/submit/poll 都是「生成脚本 → 在真实
 * 页面上执行 → JSON 结果」。纪律与旧实现一致：
 * - 脚本全部包 try/catch，永远返回 JSON；
 * - 选择器写成多候选数组；
 * - **回答基线必须在点击发送之前统计**；写入后校验文本真的进了编辑器。
 */
export function createScriptAdapter(params: {
  id: string
  displayName: string
  allowedHosts: readonly string[]
  homeURL: string
  probeScript: () => string
  submitScript: (prompt: string) => string
  pollScript: () => string
}): AIPlatformAdapter {
  const { id, displayName, allowedHosts, homeURL, probeScript, submitScript, pollScript } = params
  return {
    id,
    displayName,
    allowedHosts,
    homeURL,
    matches(url: string): boolean {
      return matchesAllowedHost(id, allowedHosts, url)
    },
    async probe(context) {
      return (await context.webContents.executeJavaScript(probeScript())) as AIProbeResult
    },
    async submit(context, prompt) {
      return (await context.webContents.executeJavaScript(submitScript(prompt))) as AISubmitResult
    },
    async poll(context) {
      const result = (await context.webContents.executeJavaScript(pollScript())) as AIProbeResult
      return { generating: result.generating, answer: result.answer, answerSeq: result.answerSeq }
    }
  }
}
