import { describe, expect, it } from 'vitest'
import {
  buildUnifiedDiff,
  changeKindFromStatusCode,
  countTrackedPaths,
  decodeUtf8Strict,
  diffLineOps,
  gitModeFromStat,
  identityOf,
  isProbablyBinary,
  isSensitiveRepoPath,
  parseLsTree,
  parseLsTreeAll,
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

// MARK: - R6-4.3.2.2：mode 解析与 Tree malformed（修复二/三）

describe('porcelain v2 的 mH / mI / mW 解析（修复三）', () => {
  it('type 1 记录：三个 mode 字段与 hash 字段不混', () => {
    const text = `1 MM S... 100644 100755 100755 aaaa bbbb script.sh${NUL}`
    const { entries } = parsePorcelainV2(text)
    expect(entries[0].headMode).toBe('100644')
    expect(entries[0].indexMode).toBe('100755')
    expect(entries[0].worktreeMode).toBe('100755')
    expect(entries[0].hH).toBe('aaaa')
    expect(entries[0].hI).toBe('bbbb')
  })

  it('type 2（重命名）与 unmerged 记录的 mode', () => {
    const rename = `2 R. N... 120000 120000 120000 aaaa bbbb R100 link${NUL}old${NUL}`
    const r = parsePorcelainV2(rename).entries[0]
    expect(r.headMode).toBe('120000')
    expect(r.worktreeMode).toBe('120000')

    const unmerged = `u UU N... 100644 100644 100644 100755 h1 h2 h3 conf${NUL}`
    const u = parsePorcelainV2(unmerged).entries[0]
    expect(u.worktreeMode).toBe('100755') // mW
    expect(u.headMode).toBeNull() // 冲突态没有单一 head/index mode
    expect(u.indexMode).toBeNull()
  })

  it('untracked / ignored 记录没有 mode 字段（由 lstat 归一）', () => {
    const parsed = parsePorcelainV2(`? new.txt${NUL}! build/${NUL}`)
    expect(parsed.entries[0].worktreeMode).toBeNull()
    expect(parsed.entries[1].worktreeMode).toBeNull()
  })
})

describe('gitModeFromStat（lstat → git mode 归一）', () => {
  it('symlink → 120000；可执行 → 100755；普通 → 100644', () => {
    expect(gitModeFromStat(0o755, true)).toBe('120000') // symlink 分支优先
    expect(gitModeFromStat(0o755, false)).toBe('100755')
    expect(gitModeFromStat(0o744, false)).toBe('100755') // 任一 x 位
    expect(gitModeFromStat(0o644, false)).toBe('100644')
    expect(gitModeFromStat(0o664, false)).toBe('100644')
  })
})

describe('parseLsTreeAll 的 malformed 计数（修复二：绝不静默跳过）', () => {
  it('坏记录逐条计数，好记录照常解析', () => {
    const NUL2 = String.fromCharCode(0)
    const good = `100644 blob ${'a'.repeat(40)}\tfine.txt`
    const bad1 = 'no-tab-here'
    const bad2 = `100644 blob ${'b'.repeat(40)}` // 缺 TAB 与路径
    const { entries, malformed } = parseLsTreeAll(`${good}${NUL2}${bad1}${NUL2}${bad2}${NUL2}`)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('fine.txt')
    expect(malformed).toBe(2)
  })

  it('空输入 → 空清单、0 malformed（不虚报）', () => {
    expect(parseLsTreeAll('')).toEqual({ entries: [], malformed: 0 })
  })
})

// MARK: - 修复二：ls-tree 记录严格校验（规格 §四 13 项）

describe('ls-tree 记录严格校验（规格 §四）', () => {
  const SHA1 = 'a'.repeat(40)
  const SHA256 = 'b'.repeat(64)
  const one = (record: string) => parseLsTreeAll(record + String.fromCharCode(0))

  it('1-3) 合法 blob / tree / gitlink commit 正常解析', () => {
    const blob = one(`100644 blob ${SHA1}\tf.txt`)
    expect(blob).toEqual({
      entries: [{ mode: '100644', type: 'blob', sha: SHA1, path: 'f.txt' }],
      malformed: 0
    })
    const tree = one(`040000 tree ${SHA1}\tsubdir`)
    expect(tree.entries[0].type).toBe('tree')
    expect(tree.malformed).toBe(0)
    const gitlink = one(`160000 commit ${SHA1}\tkid`)
    expect(gitlink.entries[0].type).toBe('commit')
    expect(gitlink.entries[0].mode).toBe('160000')
    expect(gitlink.malformed).toBe(0)
  })

  it('4) 非法 mode → malformed（绝不当作正常模式）', () => {
    expect(one(`999999 blob ${SHA1}\tf`).malformed).toBe(1)
    expect(one(`10064x blob ${SHA1}\tf`).malformed).toBe(1)
    expect(one(`1006444 blob ${SHA1}\tf`).malformed).toBe(1)
    expect(one(`abcde blob ${SHA1}\tf`).malformed).toBe(1)
  })

  it('5) 非法 type → malformed（绝不降级成 blob）', () => {
    expect(one(`100644 blobb ${SHA1}\tf`).malformed).toBe(1)
    expect(one(`100644 submod ${SHA1}\tf`).malformed).toBe(1)
    expect(one(`100644 BLOB ${SHA1}\tf`).malformed).toBe(1)
    expect(one(`100644 ${'x'.repeat(4)} ${SHA1}\tf`).malformed).toBe(1)
  })

  it('6) 非法 SHA（非 hex）→ malformed', () => {
    expect(one(`100644 blob ${'z'.repeat(40)}\tf`).malformed).toBe(1)
    expect(one(`100644 blob ${'A'.repeat(40)}\tf`).malformed).toBe(1) // 大写非规范
    expect(one(`100644 blob not-a-sha-at-all-here-but-long-enough\tf`).malformed).toBe(1)
  })

  it('7) SHA 长度错误 → malformed；40（SHA-1）与 64（SHA-256）都合法', () => {
    for (const bad of ['a'.repeat(39), 'a'.repeat(41), 'a'.repeat(43), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(one(`100644 blob ${bad}\tf`).malformed, `len=${bad.length}`).toBe(1)
    }
    expect(one(`100644 blob ${SHA1}\tf`).malformed).toBe(0)
    expect(one(`100644 blob ${SHA256}\tf`).malformed).toBe(0)
  })

  it('8) 缺少 TAB（用空格分隔 path）→ malformed', () => {
    expect(one(`100644 blob ${SHA1} f.txt`).malformed).toBe(1)
    expect(one(`100644 blob ${SHA1}`).malformed).toBe(1)
  })

  it('9) Header 字段数量错误 → malformed', () => {
    expect(one(`100644 blob ${SHA1} extra\tf`).malformed).toBe(1) // 4 段
    expect(one(`100644 blob\tf`).malformed).toBe(1) // 2 段
    expect(one(` blob ${SHA1}\tf`).malformed).toBe(1) // 首段为空 → 4 段含空串
  })

  it('10) 空路径 → malformed', () => {
    expect(one(`100644 blob ${SHA1}\t`).malformed).toBe(1)
  })

  it('11) 特殊文件名（Tab / 换行 / 空格 / 中文 / 前导连字符）正常解析', () => {
    const weird = 'weird\t\n name-中文.txt'
    const parsed = one(`100644 blob ${SHA1}\t${weird}`)
    expect(parsed.malformed).toBe(0)
    expect(parsed.entries[0].path).toBe(weird)
  })

  it('12) SHA-256 对象格式（64 位）整体解析正常', () => {
    const parsed = one(`100755 blob ${SHA256}\tbin.sh`)
    expect(parsed.malformed).toBe(0)
    expect(parsed.entries[0].sha).toBe(SHA256)
  })

  it('13) 合法与非法记录混合：合法保留、非法逐条计数', () => {
    const NUL2 = String.fromCharCode(0)
    const good1 = `100644 blob ${SHA1}\tgood1.ts`
    const bad1 = `999999 blob ${SHA1}\tbad-mode.ts`
    const bad2 = `100644 alien ${SHA1}\tbad-type.ts`
    const good2 = `120000 blob ${SHA1}\tlink`
    const text = [good1, bad1, bad2, good2].join(NUL2) + NUL2
    const parsed = parseLsTreeAll(text)
    expect(parsed.malformed).toBe(2)
    expect(parsed.entries.map((e) => e.path)).toEqual(['good1.ts', 'link'])
  })
})

// MARK: - R6-4.3.2.4 修复二：mode/type 对应与路径规则（规格 §二）

describe('ls-tree mode/type 对应与路径规则（R6-4.3.2.4 §二）', () => {
  const SHA = 'a'.repeat(40)
  const one = (record: string) => parseLsTreeAll(record + NUL)

  it('每种合法 mode/type 组合都通过', () => {
    const legal: Array<[string, string]> = [
      ['040000', 'tree'],
      ['100644', 'blob'],
      ['100664', 'blob'],
      ['100755', 'blob'],
      ['120000', 'blob'],
      ['160000', 'commit']
    ]
    for (const [mode, type] of legal) {
      const parsed = one(`${mode} ${type} ${SHA}\tpath-${mode}`)
      expect(parsed.malformed, `${mode}/${type}`).toBe(0)
      expect(parsed.entries[0].mode).toBe(mode)
      expect(parsed.entries[0].type).toBe(type)
    }
  })

  it('非法 mode/type 组合一律 malformed（至少两种，绝不产生有效 entry）', () => {
    const illegal: Array<[string, string]> = [
      ['040000', 'blob'], // tree 的 mode 配 blob
      ['160000', 'blob'], // gitlink 的 mode 配 blob
      ['100644', 'tree'],
      ['120000', 'commit'],
      ['100755', 'tree'],
      ['999999', 'blob']
    ]
    for (const [mode, type] of illegal) {
      const parsed = one(`${mode} ${type} ${SHA}\tx`)
      expect(parsed.malformed, `${mode}/${type}`).toBe(1)
      expect(parsed.entries).toHaveLength(0)
    }
  })

  it('路径规则：绝对路径 / 路径穿越 / 非法路径段 → malformed', () => {
    const badPaths = [
      '/etc/passwd', // POSIX 绝对路径
      'C:/win/system32', // Windows 盘符绝对路径
      '../evil', // 上穿
      'a/../b', // 中段穿越
      'a//b', // 空路径段
      './x', // 当前段
      'a/', // 尾部空段
      '.', // 当前段整体
      '..' // 上穿整体
    ]
    for (const path of badPaths) {
      const parsed = one(`100644 blob ${SHA}\t${path}`)
      expect(parsed.malformed, JSON.stringify(path)).toBe(1)
      expect(parsed.entries, JSON.stringify(path)).toHaveLength(0)
    }
  })

  it('合法特殊文件名仍正确解析（前导连字符/空格/Tab/换行/中文/点文件）', () => {
    const good = [
      '-leading.txt',
      'a b.txt',
      'tab\there.txt',
      'nl\nhere.txt',
      '中文文件.txt',
      '.hidden',
      'dir/.keep',
      ':(magic).txt',
      'star*.txt'
    ]
    for (const path of good) {
      const parsed = one(`100644 blob ${SHA}\t${path}`)
      expect(parsed.malformed, JSON.stringify(path)).toBe(0)
      expect(parsed.entries[0].path).toBe(path)
    }
  })

  it('混合：合法 entries 保留，非法记录逐条计数（含 mode/type 错配与坏路径）', () => {
    const records = [
      `100644 blob ${SHA}\tgood.ts`,
      `040000 blob ${SHA}\tbad-combo`, // mode/type 错配
      `100644 blob ${SHA}\t../traversal`, // 路径穿越
      `120000 commit ${SHA}\tbad-link`, // mode/type 错配
      `100644 blob ${'b'.repeat(40)}\tfine-two.txt`
    ]
    const parsed = parseLsTreeAll(records.join(NUL) + NUL)
    expect(parsed.malformed).toBe(3)
    expect(parsed.entries.map((e) => e.path)).toEqual(['good.ts', 'fine-two.txt'])
  })
})
