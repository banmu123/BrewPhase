// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPageMetadata } from '../src/lib/page-metadata'

/**
 * 页面提取函数的真实 DOM 行为。
 *
 * `readPageMetadata` 会被 Chrome 序列化后注入页面，所以它只能依赖
 * document / window / location 这些全局对象——这里在 happy-dom 里直接跑它。
 */

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  document.title = ''
  vi.restoreAllMocks()
})

describe('readPageMetadata', () => {
  it('读取标题、meta description、图标与选中文字', () => {
    // 先写 head 再设 title：head.innerHTML 会替换掉 <title> 节点。
    document.head.innerHTML = `
      <meta name="description" content="页面自己的描述" />
      <link rel="icon" href="/favicon.ico" />
    `
    document.title = '一篇文章'
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '  被选中的一段文字  '
    } as unknown as Selection)

    const raw = readPageMetadata()

    expect(raw.title).toBe('一篇文章')
    expect(raw.description).toBe('页面自己的描述')
    expect(raw.selectedText).toContain('被选中的一段文字')
    // happy-dom 的默认地址是 localhost；相对图标必须解析成绝对地址。
    expect(raw.faviconUrl).toMatch(/^https?:\/\/.+\/favicon\.ico$/)
  })

  it('没有选中文字时返回空串', () => {
    document.title = '没有选区'
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => ''
    } as unknown as Selection)

    expect(readPageMetadata().selectedText).toBe('')
  })

  it('缺少 meta 时回退 og:description，再缺就是空串', () => {
    document.head.innerHTML = '<meta property="og:description" content="og 描述" />'
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => ''
    } as unknown as Selection)
    expect(readPageMetadata().description).toBe('og 描述')

    document.head.innerHTML = ''
    expect(readPageMetadata().description).toBe('')
  })

  it('标题缺失时返回空串，由上层回退到域名', () => {
    document.title = ''
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => ''
    } as unknown as Selection)
    expect(readPageMetadata().title).toBe('')
  })
})
