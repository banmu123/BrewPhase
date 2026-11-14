import type { AIPlatformAdapter } from '../types'
import { aiTestOrigin } from '../host-match'
import { createScriptAdapter, literal, PAGE_HELPERS } from '../types'

/**
 * ChatGPT 适配器（Phase 4.2 从 automation/adapters.ts 迁移）。
 *
 * 提交时序纪律：**回答基线在点击发送之前统计**（AI 响应快时基线取晚会把
 * 本轮回答计入旧基线，完成判定就永远不成立）；写入后校验文本真的进了
 * 编辑器（写入失败时点发送只会发出上一轮的问题）。
 * 选择器随平台改版只改这里。
 */

export const CHATGPT_ALLOWED_HOSTS = ['chatgpt.com', 'chat.openai.com'] as const

export const chatgptScripts = {
  probeScript() {
    return `${PAGE_HELPERS}
(() => {
  const input = __bpPick(['#prompt-textarea', 'div[contenteditable="true"]#prompt-textarea'])
  const url = location.href
  if (input) return { loggedIn: true, reason: '', inputReady: true, generating: false, answer: '', answerSeq: 0 }
  const stopBtn = document.querySelector('button[data-testid="stop-button"]')
  if (stopBtn) return { loggedIn: true, reason: '', inputReady: false, generating: true, answer: '', answerSeq: 0 }
  const loginHint = document.querySelector('[data-testid="login-button"], a[href*="/auth/login"], a[href*="auth.openai.com"]')
  const onAuth = /auth\\.openai\\.com|\\/auth\\/login|\\/log-in/.test(url)
  if (loginHint || onAuth) return { loggedIn: false, reason: 'login_page', inputReady: false, generating: false, answer: '', answerSeq: 0 }
  return { loggedIn: false, reason: 'input_not_found', inputReady: false, generating: false, answer: '', answerSeq: 0 }
})()`
  },

  submitScript(prompt: string) {
    return `${PAGE_HELPERS}
(() => {
  const input = __bpPick(['#prompt-textarea', 'div[contenteditable="true"]#prompt-textarea'])
  if (!input) return { ok: false, reason: 'input_not_found', baseline: 0 }
  __bpTypeInto(input, ${literal(prompt)})
  // 写入校验：编辑器没拿到文本就点发送，发出去的是上一轮的问题。
  if (__bpNormalize(__bpInputText(input)) !== __bpNormalize(${literal(prompt)})) {
    return { ok: false, reason: 'input_write_failed', baseline: 0 }
  }
  // 基线在点击发送**之前**统计：发送后新回答可能瞬间出现。
  const baseline = document.querySelectorAll('[data-message-author-role="assistant"]').length
  const sent = __bpClickFirst(['button[data-testid="send-button"]', 'button[aria-label*="Send"]'])
  if (!sent) return { ok: false, reason: 'send_button_not_found', baseline: 0 }
  return { ok: true, reason: '', baseline }
})()`
  },

  pollScript() {
    return `${PAGE_HELPERS}
(() => {
  const generating = !!document.querySelector('button[data-testid="stop-button"]')
  const answers = document.querySelectorAll('[data-message-author-role="assistant"]')
  const last = answers.length > 0 ? answers[answers.length - 1] : null
  return { loggedIn: true, reason: '', inputReady: false, generating, answer: __bpText(last), answerSeq: answers.length }
})()`
  }
}

export const chatgptAdapter: AIPlatformAdapter = createScriptAdapter({
  id: 'chatgpt',
  displayName: 'ChatGPT',
  allowedHosts: CHATGPT_ALLOWED_HOSTS,
  homeURL: aiTestOrigin('chatgpt') ?? 'https://chatgpt.com/',
  ...chatgptScripts
})
