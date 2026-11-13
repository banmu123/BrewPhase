import { Fragment, type ReactNode } from 'react'
import { parseMarkdownBlocks, type Block } from './markdown-parse'

/**
 * 极简 Markdown 渲染。
 *
 * 不引第三方解析器：AI 回答要的格式其实就是标题、列表、粗体、行内代码、
 * 代码块和链接，一百来行足够，而且**输出是纯 React 元素**——没有
 * dangerouslySetInnerHTML，网页内容永远无法变成脚本。链接只显示文字，
 * 不给 href（网页 URL 在卡片头上的「查看原网页」里走浏览器）。
 */


/** 行内：`code`、**bold**、*italic*、[text](url)。顺序处理，先代码避免嵌套。 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const id = `${keyPrefix}-${key}`
    key += 1
    if (token.startsWith('`')) {
      nodes.push(<code key={id} className="md-inline-code">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={id}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={id}>{token.slice(1, -1)}</em>)
    } else {
      const label = /^\[([^\]]+)\]/.exec(token)?.[1] ?? token
      nodes.push(<span key={id} className="md-link">{label}</span>)
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdownBlocks(source)
  return (
    <div className="md">
      {blocks.map((block, i) => {
        const key = `b${i}`
        switch (block.kind) {
          case 'code':
            return (
              <pre key={key} className="md-code">
                <code>{block.lines.join('\n')}</code>
              </pre>
            )
          case 'heading': {
            const Tag = (block.level <= 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5'
            return <Tag key={key}>{inline(block.text, key)}</Tag>
          }
          case 'list':
            return (
              <Fragment key={key}>
                {block.items.map((item, j) =>
                  block.ordered ? (
                    <p key={`${key}-${j}`} className="md-ol">
                      <span className="md-ol__num">{j + 1}.</span>
                      {inline(item, `${key}-${j}`)}
                    </p>
                  ) : (
                    <p key={`${key}-${j}`} className="md-ul">
                      <span className="md-ul__dot" aria-hidden="true" />
                      <span>{inline(item, `${key}-${j}`)}</span>
                    </p>
                  )
                )}
              </Fragment>
            )
          default:
            return <p key={key}>{inline(block.text, key)}</p>
        }
      })}
    </div>
  )
}
