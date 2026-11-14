import type { AIPlatformAdapter } from '../types'
import { aiTestOrigin } from '../host-match'
import { createScriptAdapter, literal, PAGE_HELPERS } from '../types'

/**
 * Claude 适配器（Phase 4.2 从 automation/adapters.ts 迁移）。
 * 与 ChatGPT 同一套提交时序纪律：基线先于发送、写入后校验。
 * 选择器随平台改版只改这里。
 */

export const CLAUDE_ALLOWED_HOSTS = ['claude.ai'] as const

export const claudeScripts = {
  probeScript() {
    return `${PAGE_HELPERS}
(() => {
  const input = __bpPick([
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][aria-label]',
    'fieldset div[contenteditable="true"]',
    'div[contenteditable="true"]'
  ])
  const url = location.href
  const generating = !!document.querySelector(
    'button[aria-label*="Stop"], button[data-testid*="stop"], [data-is-streaming="true"]'
  )
  if (input) return { loggedIn: true, reason: '', inputReady: true, generating, answer: '', answerSeq: 0 }
  const onAuth = /\\/login|\\/auth|signin/.test(url)
  if (onAuth) return { loggedIn: false, reason: 'login_page', inputReady: false, generating: false, answer: '', answerSeq: 0 }
  return { loggedIn: false, reason: 'input_not_found', inputReady: false, generating: false, answer: '', answerSeq: 0 }
})()`
  },

  submitScript(prompt: string) {
    return `${PAGE_HELPERS}
(() => {
  const input = __bpPick([
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][aria-label]',
    'fieldset div[contenteditable="true"]',
    'div[contenteditable="true"]'
  ])
  if (!input) return { ok: false, reason: 'input_not_found', baseline: 0 }
  __bpTypeInto(input, ${literal(prompt)})
  // 写入校验（与 ChatGPT 同一纪律）：没写进去就不点发送。
  if (__bpNormalize(__bpInputText(input)) !== __bpNormalize(${literal(prompt)})) {
    return { ok: false, reason: 'input_write_failed', baseline: 0 }
  }
  // 基线在点击发送**之前**统计。
  const baseline = document.querySelectorAll(
    '[data-testid="assistant-message"], .font-claude-message'
  ).length
  const sent = __bpClickFirst([
    'button[aria-label="Send message"]',
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]'
  ])
  if (!sent) return { ok: false, reason: 'send_button_not_found', baseline: 0 }
  return { ok: true, reason: '', baseline }
})()`
  },

  pollScript() {
    return `${PAGE_HELPERS}
(() => {
  const generating =
    !!document.querySelector('button[aria-label*="Stop"], button[data-testid*="stop"]') ||
    !!document.querySelector('[data-is-streaming="true"]')
  const answers = document.querySelectorAll('[data-testid="assistant-message"], .font-claude-message')
  const last = answers.length > 0 ? answers[answers.length - 1] : null
  return { loggedIn: true, reason: '', inputReady: false, generating, answer: __bpText(last), answerSeq: answers.length }
})()`
  }
}

export const claudeAdapter: AIPlatformAdapter = createScriptAdapter({
  id: 'claude',
  displayName: 'Claude',
  allowedHosts: CLAUDE_ALLOWED_HOSTS,
  homeURL: aiTestOrigin('claude') ?? 'https://claude.ai/new',
  ...claudeScripts
})
