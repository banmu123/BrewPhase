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
 *
 * 提交时序（Phase 4.1 加固）：**回答基线必须在点击发送之前统计**——
 * AI 响应快时，发送后新回答可能瞬间出现；基线取晚了会把本轮回答计入
 * 旧基线，完成判定（answerSeq > baseline）就永远不成立。写入之后还要
 * 校验文本真的进了编辑器（写入失败时点发送只会发出上一轮的问题）。
 *
 * 测试接缝：`BREWPHASE_AI_TEST_HOST=127.0.0.1:<port>` 时，两个平台的
 * homeURL 指向本地夹具页（`http://<host>/<provider>`），ownsURL 一并放行
 * 该前缀——E2E 用本地页面跑通完整的 probe → submit → poll 链路，不碰外网。
 * 生产环境不设置该变量，接缝完全不存在。
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

/** E2E 测试宿主（127.0.0.1:port）。空串表示生产环境，无接缝。 */
const AI_TEST_HOST = (process.env.BREWPHASE_AI_TEST_HOST ?? '').trim()

/** 测试宿主下某平台的夹具入口 URL；生产环境返回 null。 */
export function aiTestOrigin(provider: AIProvider, testHost: string = AI_TEST_HOST): string | null {
  if (!testHost) return null
  return `http://${testHost}/${provider}`
}

/**
 * 纯函数的域名判定（单测直接驱动，不需要环境变量）：
 * 平台自家域名 + （可选）测试宿主下的 `/<provider>` 前缀路径。
 */
export function ownsProviderURL(provider: AIProvider, allowedHosts: readonly string[], url: string, testHost = AI_TEST_HOST): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const onPlatform = allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
    if (onPlatform) return true
    if (testHost && host === testHost.split(':')[0].toLowerCase()) {
      // 端口也必须一致，避免同宿主其它服务被误认成平台页面；
      // 路径必须按段匹配（/chatgpt2 不能冒充 chatgpt）。
      const port = testHost.split(':')[1] ?? '80'
      const prefix = `/${provider}`
      const path = parsed.pathname.toLowerCase()
      return parsed.port === port && (path === prefix || path.startsWith(`${prefix}/`))
    }
    return false
  } catch {
    return false
  }
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
function literal(text: string): string {
  return JSON.stringify(text)
}

/* ------------------------------------------------------------------ */
/* ChatGPT                                                             */
/* ------------------------------------------------------------------ */

const CHATGPT: PlatformAdapter = {
  provider: 'chatgpt',
  allowedHosts: ['chatgpt.com', 'chat.openai.com'],
  homeURL: aiTestOrigin('chatgpt') ?? 'https://chatgpt.com/',

  ownsURL(url) {
    return ownsProviderURL('chatgpt', this.allowedHosts, url)
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
  homeURL: aiTestOrigin('claude') ?? 'https://claude.ai/new',

  ownsURL(url) {
    return ownsProviderURL('claude', this.allowedHosts, url)
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
