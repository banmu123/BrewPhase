/**
 * Chrome 采集内容的备注格式。
 *
 * 三种内容必须可区分：
 * - 网页里选中的原文（`selectedText`）；
 * - 用户自己写的备注（`note`）；
 * - 来源地址。
 *
 * 格式稳定、纯文本、可编辑；不引入 JSON 或额外数据库字段。空段不输出。
 */

export function formatChromeCaptureNote(input: {
  selectedText: string
  note: string
  sourceUrl: string
}): string {
  const sections: string[] = []
  const selected = input.selectedText.trim()
  const note = input.note.trim()

  if (selected) sections.push(`【网页摘录】\n${selected}`)
  if (note) sections.push(`【我的备注】\n${note}`)
  if (input.sourceUrl.trim()) sections.push(`【来源】\n${input.sourceUrl.trim()}`)

  return sections.join('\n\n')
}
