import { describe, expect, it } from 'vitest'
import {
  buildUnifiedDiff,
  changeKindFromStatusCode,
  countTrackedPaths,
  decodeUtf8Strict,
  diffLineOps,
  identityOf,
  isProbablyBinary,
  isSensitiveRepoPath,
  parseLsTree,
  parsePorcelainV2,
  sha256Hex,
  splitLines
} from '../../src/main/application/agent-journey/git-snapshot-utils'

/**
 * 纯函数层（R6-4.3.2）：porcelain/ls-files/ls-tree 解析（含特殊文件名）、
 * Myers 差分与 Unified Diff 格式、配额、敏感路径判定、哈希与身份。
 * 这里全部离线构造输入——真实仓库行为由 `git-snapshot-engine.test.ts` 覆盖。
 */

const NUL = String.fromCharCode(0)

// MARK: - 解析

describe('git 输出解析（§4.4 按 NUL 切分）', () => {
  it('type 1 记录：XY / hash / 路径（含空格与连续空格）', () => {
    const text = [
      `1 .M N... 100644 100644 100644 aaaa bbbb my file.txt`,
      `1 MM N... 100644 100644 100644 aaaa bbbb double  spaces.txt`
    ].join(NUL) + NUL
    const { entries } = parsePorcelainV2(text)
    expect(entries).toHaveLength(2)
    expect(entries[0].path).toBe('my file.txt')
    expect(entries[0].indexStatus).toBe('.')
    expect(entries[0].worktreeStatus).toBe('M')
    expect(entries[0].hH).toBe('aaaa')
    expect(entries[0].hI).toBe('bbbb')
    expect(entries[1].path).toBe('double  spaces.txt')
    expect(entries[1].indexStatus).toBe('M')
    expect(entries[1].worktreeStatus).toBe('M')
  })

  it('type 2 重命名记录：原路径取下一段 NUL 字段', () => {
    const text = `2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.txt${NUL}old path.txt${NUL}`
    const { entries } = parsePorcelainV2(text)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('new name.txt')
    expect(entries[0].renameFrom).toBe('old path.txt')
    expect(entries[0].indexStatus).toBe('R')
  })

  it('带换行与 Tab 的文件名原样保留（绝不按换行拆）', () => {
    const weird = 'with\nnewline and\ttab.txt'
    const text = `1 .M N... 100644 100644 100644 aaaa bbbb ${weird}${NUL}`
    const { entries } = parsePorcelainV2(text)
    expect(entries[0].path).toBe(weird)
    expect(entries).toHaveLength(1)
  })

  it('unmerged / untracked / ignored / branch 头各自正确计数', () => {
    const text = [
      `u UU N... 100644 100644 100644 100644 h1 h2 h3 conflicted.txt`,
      `? new.txt`,
      `! node_modules/`,
      `# branch.head main`
    ].join(NUL) + NUL
    const parsed = parsePorcelainV2(text)
    expect(parsed.conflictedCount).toBe(1)
    expect(parsed.untrackedCount).toBe(1)
    expect(parsed.ignoredCount).toBe(1)
    expect(parsed.entries).toHaveLength(3) // branch 头不进 manifest
    expect(parsed.entries[0].kind).toBe('unmerged')
    expect(parsed.entries[1].kind).toBe('untracked')
    expect(parsed.entries[1].path).toBe('new.txt')
    expect(parsed.entries[2].kind).toBe('ignored')
    expect(parsed.entries[2].path).toBe('node_modules/')
  })

  it('子模块 `<sub>` 字段（S 开头）被保留', () => {
    const text = `1 .S S.m. 100644 100644 100644 aaaa bbbb kid${NUL}`
    const { entries } = parsePorcelainV2(text)
    expect(entries[0].subField.startsWith('S')).toBe(true)
  })

  it('countTrackedPaths 按去重路径计数（冲突多 stage 不重复算）', () => {
    const text = [
      `100644 aaaa 0\tkeep.txt`,
      `100644 h1 1\tconf.txt`,
      `100644 h2 2\tconf.txt`,
      `100644 h3 3\tconf.txt`
    ].join(NUL) + NUL
    expect(countTrackedPaths(text)).toBe(2)
  })

  it('parseLsTree：mode/type/sha/tab/path', () => {
    const rec = `100644 blob c0ffee1234567890c0ffee1234567890c0ffee12\t中文/文件.txt${NUL}`
    const parsed = parseLsTree(rec)
    expect(parsed).toEqual({
      mode: '100644',
      type: 'blob',
      sha: 'c0ffee1234567890c0ffee1234567890c0ffee12',
      path: '中文/文件.txt'
    })
    expect(parseLsTree('')).toBeNull()
    expect(parseLsTree(`garbage${NUL}`)).toBeNull()
  })

  it('状态码 → 变更种类', () => {
    expect(changeKindFromStatusCode('M')).toBe('modified')
    expect(changeKindFromStatusCode('A')).toBe('added')
    expect(changeKindFromStatusCode('D')).toBe('deleted')
    expect(changeKindFromStatusCode('R')).toBe('renamed')
    expect(changeKindFromStatusCode('T')).toBe('type_changed')
    expect(changeKindFromStatusCode('C')).toBe('added')
    expect(changeKindFromStatusCode('.')).toBeNull()
    expect(changeKindFromStatusCode('u')).toBeNull()
  })
})

// MARK: - 哈希 / 身份 / 敏感

describe('哈希与身份', () => {
  it('sha256Hex 有已知向量（空串）', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  it('身份不含绝对路径本身，identifier 可读且带短哈希', () => {
    const identity = identityOf('/Users/someone/secret-project')
    expect(identity.repository_identity).toHaveLength(32)
    expect(identity.repository_root_identifier).toBe(
      `secret-project#${sha256Hex('/Users/someone/secret-project').slice(0, 8)}`
    )
    expect(identity.repository_identity).not.toContain('Users')
    expect(identity.repository_root_identifier).not.toContain('/Users')
  })

  it('二进制启发：前 8000 字节有 NUL；严格 UTF-8 解码失败返回 null', () => {
    expect(isProbablyBinary(Buffer.from([1, 2, 0, 3]))).toBe(true)
    expect(isProbablyBinary(Buffer.from('plain text'))).toBe(false)
    expect(decodeUtf8Strict(Buffer.from('中文 ok'))).toBe('中文 ok')
    expect(decodeUtf8Strict(Buffer.from([0xff, 0xfe, 0xfd]))).toBeNull()
  })

  it('敏感路径：复用共享清单 + .git 纵深防御', () => {
    expect(isSensitiveRepoPath('.env')).toBe(true)
    expect(isSensitiveRepoPath('cfg/.env.production')).toBe(true)
    expect(isSensitiveRepoPath('certs/server.pem')).toBe(true)
    expect(isSensitiveRepoPath('id_rsa')).toBe(true)
    expect(isSensitiveRepoPath('secrets.txt')).toBe(true)
    expect(isSensitiveRepoPath('cert.p12')).toBe(true)
    expect(isSensitiveRepoPath('app.keystore')).toBe(true)
    expect(isSensitiveRepoPath('.git/config')).toBe(true)
    expect(isSensitiveRepoPath('.git/hooks/pre-commit')).toBe(true)
    expect(isSensitiveRepoPath('src/app.ts')).toBe(false)
    expect(isSensitiveRepoPath('.env.local')).toBe(true) // /^\\.env(\\..*)?$/ 命中
  })
})

// MARK: - 行切分与差分

describe('splitLines', () => {
  it('结尾换行语义与空行保留', () => {
    expect(splitLines('')).toEqual({ lines: [], trailingNewline: true })
    expect(splitLines('a')).toEqual({ lines: ['a'], trailingNewline: false })
    expect(splitLines('a\n')).toEqual({ lines: ['a'], trailingNewline: true })
    expect(splitLines('a\n\n')).toEqual({ lines: ['a', ''], trailingNewline: true })
    expect(splitLines('\n')).toEqual({ lines: [''], trailingNewline: true })
  })
})

describe('Myers 差分与 Unified Diff（§八）', () => {
  it('编辑脚本：等长替换的 del/ins/eq 数量正确', () => {
    const ops = diffLineOps(['a', 'b', 'c'], ['a', 'B', 'c'])
    expect(ops).not.toBeNull()
    const counts = { eq: 0, del: 0, ins: 0 }
    for (const op of ops!) counts[op.type] += 1
    expect(counts).toEqual({ eq: 2, del: 1, ins: 1 })
  })

  it('算法预算耗尽 → null（不返回半截脚本）', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`)
    expect(diffLineOps(a, b, 10)).toBeNull()
    expect(diffLineOps(a, b)).not.toBeNull() // 默认预算足够
  })

  it('精确的 hunk 头与上下文（3 行）', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n'
    const after = before.replace('l10', 'l10-x')
    const outcome = buildUnifiedDiff(before, after)
    expect(outcome.kind).toBe('diff')
    if (outcome.kind === 'diff') {
      expect(outcome.text).toBe(
        ['@@ -8,7 +8,7 @@', ' l7', ' l8', ' l9', '-l10', '+l10-x', ' l11', ' l12', ' l13'].join('\n')
      )
      expect(outcome.insertions).toBe(1)
      expect(outcome.deletions).toBe(1)
    }
  })

  it('count=1 的范围省略 `,1`（git 风格）；纯新增/纯删除头为 0', () => {
    const outcome = buildUnifiedDiff('a\n', 'a\nb\n')
    expect(outcome.kind).toBe('diff')
    if (outcome.kind === 'diff') expect(outcome.text).toContain('@@ -1 +1,2 @@')

    const added = buildUnifiedDiff('', 'x\ny\n')
    if (added.kind === 'diff') expect(added.text).toContain('@@ -0,0 +1,2 @@')

    const removed = buildUnifiedDiff('x\ny\n', '')
    if (removed.kind === 'diff') expect(removed.text).toContain('@@ -1,2 +0,0 @@')
  })

  it('无结尾换行 → \\ No newline at end of file', () => {
    const outcome = buildUnifiedDiff('alpha', 'alpha\nbeta')
    expect(outcome.kind).toBe('diff')
    if (outcome.kind === 'diff') {
      expect(outcome.text).toContain('\\ No newline at end of file')
      expect(outcome.text).toContain('+beta')
    }
  })

  it('Unicode 内容原样（不转义、不乱码）', () => {
    const outcome = buildUnifiedDiff('# 标题\n第一段\n', '# 标题\n第一段\n新增行\n')
    expect(outcome.kind).toBe('diff')
    if (outcome.kind === 'diff') {
      expect(outcome.text).toContain('+新增行')
      expect(outcome.insertions).toBe(1)
    }
  })

  it('单文件配额：渲染超行数上限 → file_budget 且保留统计', () => {
    const before = Array.from({ length: 1200 }, (_, i) => `x${i}`).join('\n') + '\n'
    const after = Array.from({ length: 1200 }, (_, i) => `y${i}`).join('\n') + '\n'
    const outcome = buildUnifiedDiff(before, after)
    expect(outcome.kind).toBe('file_budget')
    if (outcome.kind === 'file_budget') {
      expect(outcome.insertions).toBe(1200)
      expect(outcome.deletions).toBe(1200)
    }
  })

  it('内容一致 → 空 diff（insertions/deletions 都为 0）', () => {
    const outcome = buildUnifiedDiff('same\n', 'same\n')
    expect(outcome).toEqual({ kind: 'diff', text: '', insertions: 0, deletions: 0 })
  })
})
