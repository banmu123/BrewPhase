/**
 * AI 回答的 Markdown 解析（纯函数，无 JSX）。
 *
 * AI 的回答不可控：标题、代码块、列表、`#` 开头的行都可能出现。
 * 解析器把「认得的结构」变成块，「不认得的」原样放进段落——
 * 宁可显示得朴素，也不丢内容或把文本当结构吞掉。
 * 渲染（React 元素）在 markdown.tsx；测试直接吃这里。
 */

export type Block =
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'paragraph'; text: string }

/** 解析为块序列；单测直接吃这个函数，渲染交给 e2e。 */
export function parseMarkdownBlocks(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    // 代码块
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ''
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      index += 1 // 跳过闭合围栏（没有也无所谓）
      blocks.push({ kind: 'code', lang, lines: code })
      continue
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      index += 1
      continue
    }

    // 列表（连续行聚合；缩进层级第一版不区分，全部平铺）
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered)
      const items: string[] = []
      while (index < lines.length) {
        const item = isOrdered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[index]) : /^\s*[-*+]\s+(.*)$/.exec(lines[index])
        if (!item) break
        items.push(item[1])
        index += 1
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    // 空行：分段的天然分隔，跳过
    if (line.trim() === '') {
      index += 1
      continue
    }

    // 段落：连续非空非结构行
    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !/^\s*```/.test(lines[index]) &&
      !/^#{1,4}\s/.test(lines[index]) &&
      !/^\s*([-*+]|\d+[.)])\s/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
  }
  return blocks
}
