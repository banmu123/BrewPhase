import type { AIProvider } from './types'

/**
 * 平台 Adapter：**只提供在目标页面里执行的脚本与域名白名单**，不持有任何
 * Electron 对象。这样选择器与平台逻辑收敛在一处，页面改版时只改这里。
 *
 * 脚本纪律：
 * - 全部包 try/catch，永远返回 JSON，绝不向页面抛错；
 * - 选择器写成多候选数组——平台改版通常改一个属性，多候选能多撑一段时间；
 * - 写入输入框用 execCommand('insertText')（contenteditable 上这是
 *   React/ProseMirror 最能感知的输入方式），失败再退回手动 InputEvent；
 * - 每个脚本自包含（executeJavaScript 不共享上下文）。
 */

export type PlatformAdapter = {
  provider: AIProvider
  /** 允许自动化的域名（host 精确或以其结尾）。其余一律 unsupported_page。 */
  readonly allowedHosts: readonly string[]
  /** 打开登录 / 主页用的入口地址。 */
  readonly homeURL: string
  /** 页面是否属于本平台（按 URL）。 */
  ownsURL: (url: string) => boolean
  /** 探测：登录态 + 输入框可用性。 */
  probeScript: () => string
  /** 写入问题并提交。返回提交时「已有回答数」作为基线，供完成判定比对。 */
  submitScript: (prompt: string) => string
  /** 轮询：是否在生成 + 最后一条回答文本。 */
  pollScript: () => string
}

/* ------------------------------------------------------------------ */
/* 页面内共享的辅助脚本（每次注入，保持自包含）                          */
/* ------------------------------------------------------------------ */

/**
 * 把文本写进 contenteditable 并让框架感知。
 * execCommand 已废弃但对两类受控编辑器（React 受控 div / ProseMirror）
 * 仍是最可靠的输入通道；失败时退回 InputEvent + textContent。
 */
const HELPERS = `
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
function literal(text: string): string {
  return JSON.stringify(text)
}

/* ------------------------------------------------------------------ */
/* ChatGPT                                                             */
/* ------------------------------------------------------------------ */

const CHATGPT: PlatformAdapter = {
  provider: 'chatgpt',
  allowedHosts: ['chatgpt.com', 'chat.openai.com'],
  homeURL: 'https://chatgpt.com/',

  ownsURL(url) {
    try {
      const host = new URL(url).hostname.toLowerCase()
      return this.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
    } catch {
      return false
    }
  },

  probeScript() {
    return `${HELPERS}
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

  submitScript(prompt) {
    return `${HELPERS}
(() => {
  const input = __bpPick(['#prompt-textarea', 'div[contenteditable="true"]#prompt-textarea'])
  if (!input) return { ok: false, reason: 'input_not_found', baseline: 0 }
  __bpTypeInto(input, ${literal(prompt)})
  const sent = __bpClickFirst(['button[data-testid="send-button"]', 'button[aria-label*="Send"]'])
  if (!sent) return { ok: false, reason: 'send_button_not_found', baseline: 0 }
  const baseline = document.querySelectorAll('[data-message-author-role="assistant"]').length
  return { ok: true, reason: '', baseline }
})()`
  },

  pollScript() {
    return `${HELPERS}
(() => {
  const generating = !!document.querySelector('button[data-testid="stop-button"]')
  const answers = document.querySelectorAll('[data-message-author-role="assistant"]')
  const last = answers.length > 0 ? answers[answers.length - 1] : null
  return { loggedIn: true, reason: '', inputReady: false, generating, answer: __bpText(last), answerSeq: answers.length }
})()`
  }
}

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */

const CLAUDE: PlatformAdapter = {
  provider: 'claude',
  allowedHosts: ['claude.ai'],
  homeURL: 'https://claude.ai/new',

  ownsURL(url) {
    try {
      const host = new URL(url).hostname.toLowerCase()
      return this.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
    } catch {
      return false
    }
  },

  probeScript() {
    return `${HELPERS}
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

  submitScript(prompt) {
    return `${HELPERS}
(() => {
  const input = __bpPick([
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][aria-label]',
    'fieldset div[contenteditable="true"]',
    'div[contenteditable="true"]'
  ])
  if (!input) return { ok: false, reason: 'input_not_found', baseline: 0 }
  __bpTypeInto(input, ${literal(prompt)})
  const sent = __bpClickFirst([
    'button[aria-label="Send message"]',
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]'
  ])
  if (!sent) return { ok: false, reason: 'send_button_not_found', baseline: 0 }
  const baseline = document.querySelectorAll(
    '[data-testid="assistant-message"], .font-claude-message'
  ).length
  return { ok: true, reason: '', baseline }
})()`
  },

  pollScript() {
    return `${HELPERS}
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

export const AI_ADAPTERS: Record<AIProvider, PlatformAdapter> = {
  chatgpt: CHATGPT,
  claude: CLAUDE
}
