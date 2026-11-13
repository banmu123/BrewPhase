import { describe, expect, it } from 'vitest'
import { parseMarkdownBlocks } from '../../src/renderer/src/features/ai-workspace/markdown-parse'

/**
 * AI 回答的 Markdown 解析。
 *
 * AI 的回答不可控：中文、代码块、嵌套列表、`#` 开头的行都会出现。
 * 解析器必须把「认得的结构」变成块，「不认得的」原样放进段落——
 * 宁可显示得朴素一点，也不能丢内容或把文本当结构吞掉。
 */

describe('AI 回答 Markdown 解析', () => {
  it('标题、段落、列表各归其位', () => {
    const blocks = parseMarkdownBlocks('# 方案\n\n先说结论。\n\n- 第一点\n- 第二点\n\n1. 甲\n2. 乙')
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: '方案' },
      { kind: 'paragraph', text: '先说结论。' },
      { kind: 'list', ordered: false, items: ['第一点', '第二点'] },
      { kind: 'list', ordered: true, items: ['甲', '乙'] }
    ])
  })

  it('代码块整体保留，不做行内解析', () => {
    const source = '示例：\n\n```ts\nconst a: number = 1\n# 这不是标题\n```\n\n完。'
    const blocks = parseMarkdownBlocks(source)
    expect(blocks[0]).toEqual({ kind: 'paragraph', text: '示例：' })
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'ts', lines: ['const a: number = 1', '# 这不是标题'] })
    expect(blocks[2]).toEqual({ kind: 'paragraph', text: '完。' })
  })

  it('未闭合的代码块不吞掉后面的内容', () => {
    const blocks = parseMarkdownBlocks('```js\nlet x = 1')
    expect(blocks).toEqual([{ kind: 'code', lang: 'js', lines: ['let x = 1'] }])
  })

  it('中文全角与特殊字符原样保留', () => {
    const blocks = parseMarkdownBlocks('「引用」与 **重点**，`code`，[链接](https://a.com)')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'paragraph' })
  })

  it('AI 输出的多余空行不会产生空段', () => {
    const blocks = parseMarkdownBlocks('a\n\n\n\n\nb')
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'a' },
      { kind: 'paragraph', text: 'b' }
    ])
  })
})
