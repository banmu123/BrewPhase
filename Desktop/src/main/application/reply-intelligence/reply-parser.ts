import {
  REPLY_CATEGORIES,
  REPLY_MAX_SEGMENTS,
  type ParsedSegment,
  type ReplyCategory
} from '../../../shared/contracts/reply-intelligence'

/**
 * ReplyParser —— 本地规则解析器（Phase 2）。
 *
 * **纯函数、零副作用**：不调用模型 API、不调用 Shell、不写文件、不执行
 * 任何内容。它只做两件事：
 * 1. **结构识别**——按 Markdown 结构切块（标题 / 段落 / 列表 / 引用 /
 *    围栏代码块），保留原文偏移与代码块完整性；
 * 2. **多标签分类**——按规则给每块打 1..4 个类别标签，每条带 confidence
 *    与 reason。低置信度候选诚实标注，UI 显示「待确认」——这是规则候选，
 *    不是语义理解，不伪装成确定事实。
 *
 * 内容安全：AI 回复是不可信输入。这里所有「命令 / Patch / 路径」都只是
 * **候选文本**，被原样保存，绝不解析成可执行结构。
 */

/** Shell 类围栏语言：这些块默认是命令候选。 */
const SHELL_LANGS = new Set([
  'bash', 'sh', 'zsh', 'shell', 'powershell', 'pwsh', 'ps1', 'cmd', 'console', 'terminal'
])

/** Patch 类围栏语言。 */
const PATCH_LANGS = new Set(['diff', 'patch'])

/** 无语言标注时，按命令前缀识别的常见命令。 */
const COMMAND_PREFIXES = [
  'git ', 'npm ', 'npx ', 'pnpm ', 'yarn ', 'node ', 'python', 'pip ', 'pip3 ',
  'curl ', 'wget ', 'cd ', 'ls ', 'mkdir ', 'rm ', 'mv ', 'cp ', 'touch ',
  'cat ', 'echo ', 'sudo ', 'brew ', 'apt ', 'apt-get ', 'choco ', 'docker ',
  'kubectl ', 'make ', 'cargo ', 'dotnet ', 'git ', 'go ', 'rustup ',
  'remove-item ', 'new-item ', 'set-location ', 'copy-item ', 'get-content '
]

/** 脚本语言里「会执行进程/系统操作」的信号（只降置信度用）。 */
const PROCESS_CALL_SIGNALS = [
  'subprocess', 'os.system', 'child_process', 'execSync', 'spawn(', 'exec(',
  'Runtime.getRuntime', 'Popen'
]

const WARNING_WORDS = [
  '注意', '警告', '小心', '重要', '风险', '务必', 'caution', 'warning',
  'important', 'breaking change', 'deprecated'
]

const FOLLOWUP_WORDS = [
  '下一步', '接下来', '后续', '待办', 'todo', 'follow-up', 'follow up', 'next step'
]

const COPYWRITING_SECTION_WORDS = [
  '文案', 'slogan', '标语', '推广', '营销', '宣传', 'marketing', 'copywriting'
]

const FILE_OP_WORDS = [
  '创建', '新建', '修改', '删除', '重命名', '移动', '重构',
  'create', 'add a new', 'modify', 'delete', 'remove', 'rename', 'move', 'refactor', 'update'
]

/** 文件路径（含扩展名）：盘符绝对路径、~ 开头、或带 / 或 \ 的相对路径。 */
const FILE_PATH_RE = /(?:[A-Za-z]:[\\/][^\s'"`<>|*?]+|~[\\/][^\s'"`<>|*?]+|(?:\.\.?\/)?(?:[\w.@ -]+\/)+[\w.\-@]+\.[A-Za-z0-9]{1,8})/g

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

type BlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'quote'
  | 'code'
  | 'table'

type Block = {
  type: BlockType
  content: string
  startOffset: number
  endOffset: number
  /** 围栏代码块的语言标注（无标注为空串）。 */
  language?: string
  /** 标题级别（1..6）。 */
  level?: number
}

// MARK: - 结构切块

/**
 * 行级状态机切块：围栏代码块整体保留（含围栏行本身），其余按
 * 标题 / 引用 / 列表 / 表格 / 段落分组。offset 覆盖到块尾换行前。
 */
function splitBlocks(raw: string): Block[] {
  const blocks: Block[] = []
  const lines = raw.split('\n')
  let offset = 0
  let index = 0

  const pushBlock = (type: BlockType, start: number, end: number, extra?: Partial<Block>): void => {
    if (end <= start) return
    blocks.push({
      type,
      content: raw.slice(start, end),
      startOffset: start,
      endOffset: end,
      ...extra
    })
  }

  while (index < lines.length) {
    const line = lines[index]
    const lineStart = offset
    const lineEnd = offset + line.length
    const nextOffset = lineEnd + 1 // +1 = '\n'
    const trimmed = line.trim()

    // 围栏代码块：从 ``` 开始到配对 ```（或 EOF）。
    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim().toLowerCase()
      let cursor = nextOffset
      let closeIndex = index + 1
      while (closeIndex < lines.length && !lines[closeIndex].trim().startsWith('```')) {
        cursor += lines[closeIndex].length + 1
        closeIndex += 1
      }
      // 包含结尾围栏行（如果存在）。
      const end = closeIndex < lines.length ? cursor + lines[closeIndex].length : cursor
      pushBlock('code', lineStart, end, { language })
      offset = end + (closeIndex < lines.length ? 1 : 0)
      index = closeIndex < lines.length ? closeIndex + 1 : closeIndex
      continue
    }

    const headingMatch = /^(#{1,6})\s+/.exec(line)
    if (headingMatch) {
      pushBlock('heading', lineStart, lineEnd, { level: headingMatch[1].length })
      offset = nextOffset
      index += 1
      continue
    }

    if (trimmed.startsWith('>')) {
      // 引用块：连续 > 行。
      let cursor = lineEnd
      let quoteIndex = index
      while (quoteIndex + 1 < lines.length && lines[quoteIndex + 1].trim().startsWith('>')) {
        quoteIndex += 1
        cursor += 1 + lines[quoteIndex].length
      }
      pushBlock('quote', lineStart, cursor)
      offset = cursor + 1
      index = quoteIndex + 1
      continue
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      // 列表：连续列表行（允许空行连接）。
      let cursor = lineEnd
      let listIndex = index
      while (listIndex + 1 < lines.length) {
        const next = lines[listIndex + 1]
        if (/^\s*([-*+]|\d+[.)])\s+/.test(next)) {
          listIndex += 1
          cursor += 1 + next.length
        } else if (next.trim() === '' && listIndex + 2 < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[listIndex + 2])) {
          listIndex += 2
          cursor += 2 + next.length + lines[listIndex].length
        } else break
      }
      pushBlock('list', lineStart, cursor)
      offset = cursor + 1
      index = listIndex + 1
      continue
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      // 表格：连续 | 行。
      let cursor = lineEnd
      let tableIndex = index
      while (tableIndex + 1 < lines.length && lines[tableIndex + 1].trim().startsWith('|')) {
        tableIndex += 1
        cursor += 1 + lines[tableIndex].length
      }
      pushBlock('table', lineStart, cursor)
      offset = cursor + 1
      index = tableIndex + 1
      continue
    }

    if (trimmed === '') {
      offset = nextOffset
      index += 1
      continue
    }

    // 段落：连续非空、非特殊结构行。
    let cursor = lineEnd
    let paraIndex = index
    while (paraIndex + 1 < lines.length) {
      const next = lines[paraIndex + 1]
      const nextTrimmed = next.trim()
      if (
        nextTrimmed === '' ||
        nextTrimmed.startsWith('```') ||
        /^#{1,6}\s+/.test(next) ||
        nextTrimmed.startsWith('>') ||
        /^\s*([-*+]|\d+[.)])\s+/.test(next) ||
        (nextTrimmed.startsWith('|') && nextTrimmed.endsWith('|'))
      ) {
        break
      }
      paraIndex += 1
      cursor += 1 + next.length
    }
    pushBlock('paragraph', lineStart, cursor)
    offset = cursor + 1
    index = paraIndex + 1
  }

  return blocks
}

// MARK: - 分类规则

function extractFilePaths(text: string): string[] {
  const matches = text.match(FILE_PATH_RE) ?? []
  return [...new Set(matches.map((item) => item.trim()))].slice(0, 30)
}

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? []
  return [...new Set(matches)].slice(0, 30)
}

function looksLikeShellLine(line: string): boolean {
  const stripped = line.replace(/^\$\s*/, '').trim().toLowerCase()
  if (!stripped) return false
  return COMMAND_PREFIXES.some((prefix) => stripped.startsWith(prefix))
}

/** 风险升级信号：破坏性命令（只影响 riskLevel，不影响是否分类为命令）。 */
const RISKY_COMMAND_RE =
  /\b(rm\s+-[rfz]{1,3}|rm\s+-r\b|del\s+\/[sqf]{1,3}|rmdir|format\s|mkfs|dd\s+if=|shutdown|reboot|drop\s+(table|database)|--force|reset\s+--hard|git\s+push\s+(-f|--force))\b/i

/**
 * 分类一块内容。`sectionTitle` 是当前所在章节的最近标题（影响文案 /
 * 后续类别的上下文判断）；返回 null = 不产生分段（如空内容）。
 */
function classifyBlock(
  block: Block,
  sectionTitle: string,
  sequence: number
): ParsedSegment | null {
  const content = block.content
  const text = content.trim()
  if (!text) return null
  const lower = text.toLowerCase()

  const categories = new Set<ReplyCategory>()
  let confidence = 0.3
  const reasons: string[] = []

  const hasWarning = WARNING_WORDS.some((word) => lower.includes(word))
  const hasFollowup = FOLLOWUP_WORDS.some((word) => lower.includes(word))
  const sectionIsCopywriting = COPYWRITING_SECTION_WORDS.some((word) => sectionTitle.toLowerCase().includes(word))
  const sectionIsFollowup = FOLLOWUP_WORDS.some((word) => sectionTitle.toLowerCase().includes(word))
  const filePaths = extractFilePaths(text)
  const urls = extractUrls(text)
  const hasFileOpWord = FILE_OP_WORDS.some((word) => lower.includes(word))

  if (block.type === 'code') {
    const language = block.language ?? ''
    const bodyLines = text.split('\n').filter((line) => !line.trim().startsWith('```'))
    const isPatch =
      PATCH_LANGS.has(language) ||
      /^diff --git/m.test(text) ||
      (/^---\s/m.test(text) && /^\+\+\+\s/m.test(text)) ||
      (/^@@/m.test(text) && /^[+-]/m.test(text))

    if (isPatch) {
      categories.add('patch')
      categories.add('code_example')
      confidence = 0.85
      reasons.push(language ? `diff/patch 代码块（${language}）` : '内容符合 diff/patch 结构特征')
    } else if (SHELL_LANGS.has(language)) {
      categories.add('shell_command')
      categories.add('operation')
      confidence = 0.8
      reasons.push(`Shell 类代码块（${language || '未标注'}）`)
    } else if (!language) {
      // 无语言标注：命令前缀 / shebang 特征 → 待确认的命令候选。
      const nonPromptLines = bodyLines.map((line) => line.replace(/^\$\s*/, '').trim()).filter(Boolean)
      const isShebang = nonPromptLines.some((line) => line.startsWith('#!'))
      const commandish =
        isShebang ||
        (nonPromptLines.length > 0 && nonPromptLines.every((line) => looksLikeShellLine(line)))
      if (commandish && nonPromptLines.length <= 12) {
        categories.add('shell_command')
        categories.add('operation')
        confidence = 0.55
        reasons.push('无语言标注但呈命令行特征，待确认')
      } else {
        categories.add('code_example')
        confidence = 0.5
        reasons.push('无语言标注的代码块，按普通代码处理')
      }
    } else {
      categories.add('code_example')
      confidence = 0.7
      reasons.push(`代码块（${language}）`)
      const hasProcessCall = PROCESS_CALL_SIGNALS.some((signal) => lower.includes(signal))
      if (hasProcessCall) {
        categories.add('operation')
        confidence = 0.45
        reasons.push('脚本内容含进程/系统调用信号，待确认')
      }
    }

    if (hasWarning) {
      categories.add('warning')
      reasons.push('内容含警告性表述')
    }
  } else if (block.type === 'heading') {
    categories.add('key_point')
    confidence = 0.6
    reasons.push('标题行，通常是该节的核心结论')
    if (block.level !== undefined && block.level <= 2) {
      confidence = 0.7
      reasons.push('高级别标题')
    }
    if (hasFollowup) {
      categories.add('follow_up')
      reasons.push('标题指向后续步骤')
    }
    if (hasWarning) categories.add('warning')
    if (sectionIsCopywriting) {
      categories.add('copywriting')
      confidence = 0.5
      reasons.push('位于文案类章节下，待确认')
    }
  } else if (block.type === 'quote') {
    categories.add('knowledge')
    confidence = 0.45
    reasons.push('引用块，通常是强调或补充说明')
    if (urls.length > 0) {
      categories.add('resource')
      reasons.push('引用中包含链接')
    }
    if (hasWarning) categories.add('warning')
  } else if (block.type === 'list') {
    // 列表：按内容多标签。
    const listUrlCount = urls.length
    const isLinkList = listUrlCount >= 2 || (listUrlCount >= 1 && text.replace(URL_RE, '').trim().length < text.length * 0.5)
    if (sectionIsFollowup || hasFollowup) {
      categories.add('follow_up')
      confidence = 0.6
      reasons.push(sectionIsFollowup ? '位于「后续步骤」类章节下' : '内容含后续步骤表述')
    } else if (sectionIsCopywriting) {
      categories.add('copywriting')
      confidence = 0.5
      reasons.push('位于文案类章节下，待确认')
    } else if (isLinkList) {
      categories.add('resource')
      confidence = 0.7
      reasons.push('以链接为主的列表')
    } else if (filePaths.length > 0 && hasFileOpWord) {
      categories.add('operation')
      confidence = 0.6
      reasons.push('列表项提及文件路径与操作动词')
    } else {
      categories.add('key_point')
      confidence = 0.5
      reasons.push('列表内容，作为重点候选，待确认')
    }
    if (urls.length > 0 && !categories.has('resource')) categories.add('resource')
    if (hasWarning) categories.add('warning')
    if (hasFollowup && !categories.has('follow_up')) categories.add('follow_up')
  } else {
    // paragraph / table
    const isMostlyUrl = urls.length >= 1 && text.replace(URL_RE, '').trim().length < text.length * 0.4
    const boldOnly = /^\*\*[^*]+\*\*:?$/.test(text.trim())
    if (isMostlyUrl) {
      categories.add('resource')
      confidence = 0.7
      reasons.push('以链接为主的内容')
    } else if (boldOnly) {
      categories.add('key_point')
      confidence = 0.5
      reasons.push('粗体强调行，重点候选')
    } else if (filePaths.length > 0 && hasFileOpWord) {
      categories.add('operation')
      confidence = 0.6
      reasons.push('提及文件路径与操作动词')
    } else if (filePaths.length >= 2) {
      categories.add('operation')
      confidence = 0.5
      reasons.push('内容以文件路径为主，待确认')
    } else if (sectionIsCopywriting) {
      categories.add('copywriting')
      confidence = 0.5
      reasons.push('位于文案类章节下，待确认')
    } else if (sectionIsFollowup || hasFollowup) {
      categories.add('follow_up')
      confidence = 0.55
      reasons.push(sectionIsFollowup ? '位于「后续步骤」类章节下' : '内容含后续步骤表述')
    } else {
      categories.add('knowledge')
      confidence = 0.3
      reasons.push('普通段落，低置信度候选，待确认')
    }
    if (urls.length > 0 && !categories.has('resource')) {
      categories.add('resource')
      reasons.push('内容包含链接')
    }
    if (filePaths.length > 0 && !categories.has('operation')) {
      categories.add('operation')
      confidence = Math.max(confidence, 0.4)
      reasons.push('提及文件路径')
    }
    if (hasWarning) {
      categories.add('warning')
      reasons.push('内容含警告性表述')
    }
    if (boldOnly && !categories.has('key_point')) categories.add('key_point')
  }

  // 类别排序稳定：按 REPLY_CATEGORIES 顺序输出。
  const ordered = [...categories].sort(
    (a, b) => REPLY_CATEGORIES.indexOf(a) - REPLY_CATEGORIES.indexOf(b)
  )
  return {
    sequence,
    categories: ordered.slice(0, 4),
    content,
    startOffset: block.startOffset,
    endOffset: block.endOffset,
    confidence: Math.round(confidence * 100) / 100,
    reason: reasons.join('；').slice(0, 500)
  }
}

/** 主入口：原文 → 分类分段（保留偏移与顺序）。 */
export function parseReply(raw: string): ParsedSegment[] {
  const blocks = splitBlocks(raw)
  const segments: ParsedSegment[] = []
  let sequence = 0
  let sectionTitle = ''
  for (const block of blocks) {
    if (block.type === 'heading') {
      sectionTitle = block.content.replace(/^#{1,6}\s+/, '').trim()
    }
    if (segments.length >= REPLY_MAX_SEGMENTS) break
    const segment = classifyBlock(block, sectionTitle, sequence)
    if (segment) {
      segments.push(segment)
      sequence += 1
    }
  }
  return segments
}

/** 段落里的破坏性命令信号（草稿 riskLevel 用）。 */
export function hasRiskyCommand(text: string): boolean {
  return RISKY_COMMAND_RE.test(text)
}

/** 从分段内容提取结构化候选（草稿 payload 用）。 */
export function extractDraftCandidates(content: string): {
  commands: string[]
  codeBlocks: Array<{ language: string; content: string }>
  filePaths: string[]
} {
  const commands: string[] = []
  const codeBlocks: Array<{ language: string; content: string }> = []
  const fenced = /```([\w+-]*)\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fenced.exec(content)) !== null) {
    const language = (match[1] || '').toLowerCase()
    const body = match[2].replace(/\n$/, '')
    codeBlocks.push({ language, content: body.slice(0, 20_000) })
    if (SHELL_LANGS.has(language)) commands.push(body.slice(0, 2_000))
    else if (!language && looksLikeShellLine(body.split('\n')[0] ?? '')) {
      commands.push(body.slice(0, 2_000))
    }
  }
  if (commands.length === 0) {
    // 无围栏：行级命令候选（$ 前缀或命令前缀开头）。
    for (const line of content.split('\n')) {
      const stripped = line.trim()
      if (!stripped) continue
      if (/^\$\s+/.test(stripped) || looksLikeShellLine(stripped)) {
        commands.push(stripped.replace(/^\$\s*/, '').slice(0, 2_000))
      }
      if (commands.length >= 20) break
    }
  }
  return {
    commands: commands.slice(0, 20),
    codeBlocks: codeBlocks.slice(0, 10),
    filePaths: extractFilePaths(content)
  }
}
