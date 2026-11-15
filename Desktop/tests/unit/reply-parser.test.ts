import { describe, expect, it } from 'vitest'
import {
  extractDraftCandidates,
  hasRiskyCommand,
  parseReply
} from '../../src/main/application/reply-intelligence/reply-parser'

/**
 * ReplyParser 的规则分类（Phase 2）：结构识别 / 多标签 / 命令与 Patch /
 * 路径与 URL / 低置信度诚实标注。解析是纯函数，不执行任何内容。
 */

const SAMPLE = `# 项目重构方案

## 重点结论

先把 **数据库层** 抽成 repository，再动 UI。

## 修改文件

- 请修改 \`src/main/index.ts\` 中的装配顺序
- 新建文件 \`src/main/db/pool.ts\`

## 执行命令

\`\`\`bash
pnpm typecheck && pnpm test
\`\`\`

\`\`\`ts
export function hello(): string {
  return 'hi'
}
\`\`\`

\`\`\`diff
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -1,3 +1,4 @@
+import './pool'
\`\`\`

> 注意：rm -rf 之前先备份。

参考文档：https://example.com/docs

下一步：跑通 CI 后再合并。`

describe('结构识别与分段', () => {
  it('标题 / 段落 / 列表 / 引用 / 代码块各自成段，顺序与偏移正确', () => {
    const segments = parseReply(SAMPLE)
    expect(segments.length).toBeGreaterThan(8)
    // 偏移能还原原文（首段从 0 开始；相邻段不重叠且递增）。
    expect(segments[0].startOffset).toBe(0)
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i].startOffset).toBeGreaterThanOrEqual(segments[i - 1].endOffset)
    }
    // 每段的原文都能在 raw 中找到（偏移可信）。
    for (const segment of segments) {
      expect(SAMPLE.slice(segment.startOffset, segment.endOffset).trim()).toBe(
        segment.content.trim()
      )
    }
  })

  it('代码块完整保留（含围栏与内部内容）', () => {
    const segments = parseReply(SAMPLE)
    const code = segments.find((item) => item.content.includes('pnpm typecheck'))
    expect(code?.categories).toContain('shell_command')
    expect(code?.content).toContain('```bash')
  })

  it('空输入与纯空白不产生分段', () => {
    expect(parseReply('')).toEqual([])
    expect(parseReply('\n\n  \n')).toEqual([])
  })

  it('超长输入不崩（分段数封顶）', () => {
    const long = Array.from({ length: 3000 }, (_, i) => `第 ${i} 段说明文字。`).join('\n\n')
    const segments = parseReply(long)
    expect(segments.length).toBeLessThanOrEqual(500)
  })
})

describe('分类规则', () => {
  it('标题是重点候选', () => {
    const segments = parseReply('# 核心结论\n正文。')
    expect(segments[0].categories).toContain('key_point')
  })

  it('Shell 代码块 = operation + shell_command 双标签', () => {
    const segments = parseReply('```bash\npnpm build\n```')
    const block = segments[0]
    expect(block.categories).toContain('operation')
    expect(block.categories).toContain('shell_command')
  })

  it('普通语言代码块只归 code_example，不当命令', () => {
    const segments = parseReply('```ts\nconst a = 1\n```')
    expect(segments[0].categories).toContain('code_example')
    expect(segments[0].categories).not.toContain('shell_command')
  })

  it('无语言标注的命令行特征 → 低置信度命令候选（待确认）', () => {
    const segments = parseReply('```\ngit status\nnpm install\n```')
    const block = segments[0]
    expect(block.categories).toContain('shell_command')
    expect(block.confidence).toBeLessThan(0.6)
    expect(block.reason).toContain('待确认')
  })

  it('diff 结构识别为 patch（含语言标注与结构特征两条路径）', () => {
    const withLang = parseReply('```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+a\n```')
    expect(withLang[0].categories).toContain('patch')
    const bare = parseReply('```\ndiff --git a/x b/x\nindex 111..222 100644\n```')
    expect(bare[0].categories).toContain('patch')
  })

  it('URL 内容归 resource', () => {
    const segments = parseReply('文档在这里：https://example.com/guide')
    expect(segments[0].categories).toContain('resource')
  })

  it('文件路径 + 操作动词归 operation；payload 能提取路径', () => {
    const segments = parseReply('请修改 src/main/index.ts 的装配顺序')
    expect(segments[0].categories).toContain('operation')
    const candidates = extractDraftCandidates(segments[0].content)
    expect(candidates.filePaths.some((path) => path.includes('src/main/index.ts'))).toBe(true)
  })

  it('警告词触发 warning 多标签', () => {
    const segments = parseReply('> 注意：这一步不可逆。')
    expect(segments[0].categories).toContain('warning')
    expect(segments[0].categories).toContain('knowledge')
  })

  it('「下一步」内容归 follow_up', () => {
    const segments = parseReply('下一步：跑通 CI。')
    expect(segments[0].categories).toContain('follow_up')
  })

  it('文案章节下的段落归 copywriting（上下文判断）', () => {
    const segments = parseReply('# 产品文案\n这一版主打轻量与专注。')
    expect(segments[1].categories).toContain('copywriting')
  })

  it('普通段落是低置信度 knowledge（不伪装成确定事实）', () => {
    const segments = parseReply('这只是随便一段说明文字而已。')
    expect(segments[0].categories).toContain('knowledge')
    expect(segments[0].confidence).toBeLessThan(0.6)
    expect(segments[0].reason).toContain('待确认')
  })

  it('中英混排与特殊字符不崩、路径不丢', () => {
    const raw = '修改 `D:\\work\\BrewPhase\\README.md` 之后运行 pnpm test 🎉 —— 注意备份！'
    const segments = parseReply(raw)
    expect(segments.length).toBeGreaterThan(0)
    const candidates = extractDraftCandidates(raw)
    expect(candidates.filePaths.length).toBeGreaterThan(0)
  })
})

describe('草稿候选与风险', () => {
  it('extractDraftCandidates 提取命令 / 代码块 / 路径', () => {
    const raw = '```bash\npnpm build\n```\n然后改 src/index.ts'
    const candidates = extractDraftCandidates(raw)
    expect(candidates.commands).toContain('pnpm build')
    expect(candidates.codeBlocks[0].language).toBe('bash')
    expect(candidates.filePaths.length).toBeGreaterThan(0)
  })

  it('行级 $ 前缀命令也能提取', () => {
    const candidates = extractDraftCandidates('在终端运行：\n$ npm ci\n$ npm test')
    expect(candidates.commands).toContain('npm ci')
    expect(candidates.commands).toContain('npm test')
  })

  it('破坏性命令标记 caution 信号', () => {
    expect(hasRiskyCommand('rm -rf ./build')).toBe(true)
    expect(hasRiskyCommand('git reset --hard HEAD~1')).toBe(true)
    expect(hasRiskyCommand('pnpm build')).toBe(false)
  })
})
