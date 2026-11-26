/**
 * Agent Journey 内容脱敏 + 限幅（R6-1 §19.3 / §15.3）。
 *
 * ## 什么时候执行
 *
 * **落库之前**。脱敏前的原始凭证不写数据库、不写审计、不进调试日志——
 * 事后在导出或展示层再过滤已经太晚，原始值早就在磁盘上了。
 *
 * ## 这是尽力而为，不是绝对保证
 *
 * 下面是一组**已知形态**的正则黑名单（口令键值、PEM 私钥块、JWT、
 * AWS 凭证、`bp_mcp_*`、Bearer、敏感环境变量、带用户名的绝对路径）。
 * 它们能挡住今天能想到的写法，**不能**保证发现所有未知形态的凭证——
 * 产品文案与测试断言都不得把它表述为「保证无泄漏」。
 * 真正的边界是：**Journey 只保存用户/Agent 主动提交的文本，系统从不自动
 * 采集环境、进程或网络里的秘密。**
 *
 * ## 不过度过滤
 *
 * 键值规则要求形如 `key: value` / `key = value`，因此「password policy
 * requires 12 characters」这类散文不会被误伤；普通代码、中文段落、
 * 命令行在没有敏感键赋值时原样保留（见测试）。
 */

/** 各字段的字符上限（与设计文档 §7.2 一致）。 */
export const JOURNEY_TEXT_LIMITS = {
  title: 200,
  /** `goal` 有独立上限：它与 `summary` 同级（≤2000），不是正文（≤20000）。 */
  goal: 2_000,
  summary: 2_000,
  content: 20_000,
  reason: 2_000,
  /** `source_agent` / `model` 等短标签。 */
  label: 120
} as const

export type JourneyTextField = keyof typeof JOURNEY_TEXT_LIMITS

export type SanitizeLimits = { max: number }

export const TRUNCATION_MARKER = '…[truncated]'

/**
 * `metadata` 序列化后的上限（R6-4.2 从 4_000 提到 16_000）。
 *
 * **预算怎么算出来的**（不是拍脑袋放大）：
 * - 结构化详情里最贵的是 `changes[]`。按字段上限估一条：
 *   `file_path` 400 + `symbols` 12×200 + `change_summary` 600 +
 *   `before/after` 各 500 + `why_this_location` 600 ≈ **2.5K**；
 * - 场景 A 要求「2–3 个文件各自完整表达」≈ **7.5K**；
 * - 再加一条 decision（alternatives 6×800 ≈ 5K 上限内实际 ~1.5K）、
 *   3 条 verification（各 ~1.1K）与 references，整包落在 **12–14K**。
 *
 * 所以 16_000 能装下「一份诚实的多文件修改记录」，同时仍是**拒绝而非
 * 截断**——截断会留下解析不了的坏 JSON。字段级上限（`journeyChangeSchema`
 * 等）已经卡死单条上限，靠无限放大 JSON 解决不了的问题这里也解决不了。
 *
 * 边界测试见 `tests/unit/agent-journey-sanitize.test.ts`。
 */
export const JOURNEY_METADATA_MAX = 16_000

const REDACTED = '[redacted]'

/** PEM 私钥块（含 RSA / EC / OPENSSH / ENCRYPTED 变体）。 */
const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g

/** `Authorization: Bearer …` / `Basic …`。必须在键值规则之前跑，否则只剩半个值。 */
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi

/** JWT（三个 base64url 段，首段以 `eyJ` 开头）。 */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g

/** AWS 访问键形态。 */
const AWS_KEY = /\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA)[0-9A-Z]{16}\b/g

/** BrewPhase 自己的 MCP token 形态（`bp_mcp_<base64url>`）。 */
const MCP_TOKEN = /\bbp_mcp_[A-Za-z0-9_-]{8,}\b/g

/**
 * 敏感键赋值：`KEY=value` / `KEY: value`，KEY 含 PASSWORD / SECRET / TOKEN 等片段
 * （允许 `POSTGRES_`、`db_`、`my` 这类前后缀，因此与键值规则互补）。
 * 比键值规则更宽（允许 `POSTGRES_`、`my` 这类前后缀），因此两者互补。
 */
const ENV_ASSIGN =
  /\b([A-Za-z][A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIALS?|COOKIE)[A-Za-z0-9_]*)\s*[:=]\s*[^\s,;"')\]]+/gi

/**
 * 敏感键的 `key: value` / `key = value`。
 *
 * 值的候选里**必须**包含 `[…]` 形态：否则前面规则刚替换出的 `[redacted]`
 * 会被截成 `[redacted` 并留下一个孤立的 `]`。
 */
const KEY_VALUE =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|auth[_-]?header|cookie|set-cookie|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?(?:id|key)|credentials?|brewhase_mcp_token)\b(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|\[[^\]\n]*\]|[^\s,;)\]}]+)/gi

/** 带用户名的绝对路径（macOS / Linux / Windows）。 */
const MACOS_USER_PATH = /(\/Users\/)[^/\s]+/g
const LINUX_USER_PATH = /(\/home\/)[^/\s]+/g
const WINDOWS_USER_PATH = /(C:\\Users\\)[^\\\s]+/gi

function apply(text: string, pattern: RegExp, replacement: string): string {
  // 每次调用都重置 lastIndex：这些是全局正则，跨调用残留会造成漏匹配。
  pattern.lastIndex = 0
  return text.replace(pattern, replacement)
}

/**
 * 只做凭证形态的替换，**不截断**。用于叶子字符串与 metadata 递归。
 *
 * 顺序有讲究：先 PEM / Bearer / JWT 这类「整体 token」，再键值规则——
 * 反过来会把 `Bearer` 当成值替换掉，把真正的 token 留在后面。
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text

  let out = apply(text, PEM_BLOCK, '[redacted:private-key]')
  out = apply(out, BEARER, '$1 ' + REDACTED)
  out = apply(out, JWT, '[redacted:jwt]')
  out = apply(out, AWS_KEY, '[redacted:aws-key]')
  out = apply(out, MCP_TOKEN, '[redacted:mcp-token]')
  out = apply(out, ENV_ASSIGN, '$1=' + REDACTED)
  out = apply(out, KEY_VALUE, '$1$2' + REDACTED)
  out = apply(out, MACOS_USER_PATH, '$1<user>')
  out = apply(out, LINUX_USER_PATH, '$1<user>')
  out = apply(out, WINDOWS_USER_PATH, '$1<user>')
  return out
}

/**
 * 脱敏 + 限幅。`limits.max` 是该字段的字符上限。
 *
 * **先脱敏后截断**：反过来会把一个长凭证从中间切断，前半段留在库里。
 * 超长时用明确的 `…[truncated]` 标记，不静默丢弃尾部。
 */
export function sanitizeJourneyContent(text: string, limits: SanitizeLimits): string {
  const redacted = redactSecrets(text ?? '')
  const max = limits.max
  if (!Number.isFinite(max) || max <= 0) return ''
  if (redacted.length <= max) return redacted
  if (max <= TRUNCATION_MARKER.length) return redacted.slice(0, max)
  return redacted.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
}

/**
 * 递归脱敏一个 JSON 可序列化的值（用于 `metadata`）。
 *
 * 两件事：
 * 1. **键名本身可能携带敏感性**——`{ POSTGRES_PASSWORD: "raw" }` 的叶子串
 *    `raw` 不含任何凭证形态，只跑 `redactSecrets` 会原样漏出去。
 * 2. **敏感键命中后整棵子树替换**（方案 A），绝不下钻。
 *
 * ## 为什么不能下钻
 *
 * `{ authorization: { scheme: "Bearer", value: "secret-value" } }` 里，
 * 父级键命中敏感规则，但子级 `value` 既不是敏感键、内容也不符合任何已知
 * Token 正则——继续递归就会把它原样留下。数组同理（`{ tokens: [...] }`）。
 * 与其给每个后代都挂上「我来自敏感父级」的状态（状态一多就必然漏一个），
 * 直接把整棵子树换成 `[redacted]` 更简单、更安全、更好测。
 *
 * 结构上仍然安全：只有**敏感**子树被折叠，普通 metadata 的嵌套与数组原样
 * 保留；替换值是普通字符串，`JSON.stringify` 结果必然仍是合法 JSON。
 *
 * 只触碰**叶子**的那一半仍然保留：普通对象继续下钻，叶子字符串跑
 * `redactSecrets`（对整段 JSON 文本跑正则会吃掉成对引号，产出坏 JSON）。
 */
export function redactDeep<T>(value: T, key?: string): T {
  if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) {
    // 整棵子树替换：不区分原语 / 对象 / 数组。
    return REDACTED as unknown as T
  }
  if (typeof value === 'string') return redactSecrets(value) as unknown as T
  if (Array.isArray(value)) {
    // 数组元素没有自己的键名，交给 redactSecrets 按内容判断。
    return value.map((item) => redactDeep(item)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactDeep(item, childKey)
    }
    return out as unknown as T
  }
  return value
}

/** 字段是否超出上限（供 Zod/Service 在脱敏后复核）。 */
export function exceedsLimit(text: string, field: JourneyTextField): boolean {
  return text.length > JOURNEY_TEXT_LIMITS[field]
}

/** 敏感键名清单（导出给测试断言用，避免测试里再抄一份会漂移的列表）。 */
export const SENSITIVE_KEY_PATTERN =
  /password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential/i
