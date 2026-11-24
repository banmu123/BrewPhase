import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  truncateSync,
  utimesSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitSnapshotEngine } from '../../src/main/application/agent-journey/git-snapshot-engine'
import type {
  GitFileDiff,
  GitWorkspaceSnapshot
} from '../../src/main/application/agent-journey/git-snapshot-types'
import { parseLsTreeAll, sha256Hex } from '../../src/main/application/agent-journey/git-snapshot-utils'
import { runGit } from '../../src/main/application/agent-journey/git-command-runner'

/**
 * Git Snapshot Engine 的**真实 Git 仓库**集成测试（R6-4.3.2 §十一）。
 *
 * 不 mock 任何 git 输出：每个用例自建临时仓库（fixture 允许写操作——
 * 生产引擎没有这些能力），断言以引擎真实返回值为准。
 *
 * 覆盖：普通仓库 / staged / unstaged / 双重变化 / untracked / 删除 / 重命名 /
 * 二进制 / ignored / Dirty 基线（B→C）/ 改后恢复 / HEAD 移动 / Worktree /
 * Submodule / 非 Git 目录 / 空仓库 / 特殊文件名 / 敏感排除 / 超大文件 /
 * Diff 配额 / 基线预算 / 超时 / git 不存在 / 根被移动与不可访问 / symlink
 * 指向外部 / 跨仓库身份，以及**只读保证**（HEAD、index、工作区、config、
 * 对象库、hooks、fsmonitor、外部 diff 全都不许动）。
 */

const engine = new GitSnapshotEngine()

const createdDirs: string[] = []

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
    try {
      chmodSync(dir, 0o755)
    } catch {
      // 已删除或不可访问：清理尽力而为
    }
  }
})

/** fixture 用的 git 调用（写操作仅限测试构造，不在生产引擎里）。 */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(dir: string, files: Record<string, string | Buffer> = { 'README.md': '# hi\n' }): void {
  mkdirSync(dir, { recursive: true })
  git(['init', '-q'], dir)
  git(['config', 'user.email', 'e2e@brewphase.test'], dir)
  git(['config', 'user.name', 'e2e'], dir)
  for (const [path, content] of Object.entries(files)) write(dir, path, content)
  git(['add', '-A', '.'], dir)
  git(['commit', '-qm', 'init'], dir)
}

function write(root: string, path: string, content: string | Buffer): void {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function fileOf(diff: { files: GitFileDiff[] }, path: string): GitFileDiff | undefined {
  return diff.files.find((entry) => entry.repo_relative_path === path)
}

function snapOf(snapshot: GitWorkspaceSnapshot, path: string) {
  return snapshot.files.find((entry) => entry.repo_relative_path === path)
}

function text(artifact: GitFileDiff['artifact']): string {
  return artifact.kind === 'diff' ? artifact.text : `<${artifact.kind}>`
}

// MARK: - §6.1 普通仓库

describe('普通 Git 仓库（§6.1）', () => {
  it('干净仓库：ok、有 HEAD/分支/index 指纹、无文件条目', async () => {
    const dir = makeDir('bp-snap-clean-')
    initRepo(dir, { 'a.txt': 'one\n' })
    const snapshot = await engine.capture(dir)

    expect(snapshot.capture_status).toBe('ok')
    expect(snapshot.error_code).toBeNull()
    expect(snapshot.is_git).toBe(true)
    expect(snapshot.is_worktree).toBe(false)
    expect(snapshot.is_submodule).toBe(false)
    expect(snapshot.has_unborn_head).toBe(false)
    expect(snapshot.branch).toBeTruthy()
    expect(snapshot.head_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(snapshot.tree_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(snapshot.index_state_hash).toBeTruthy()
    expect(snapshot.worktree_state_hash).toBeTruthy()
    expect(snapshot.counts.tracked).toBe(1)
    expect(snapshot.files).toEqual([])
    // 身份不含绝对路径
    expect(JSON.stringify(snapshot)).not.toContain(dir)
    expect(snapshot.repository_root_identifier).toContain('#')
  })

  it('修改 tracked file → unstaged 条目（worktree 来源）', async () => {
    const dir = makeDir('bp-snap-mod-')
    initRepo(dir, { 'a.txt': 'one\n' })
    write(dir, 'a.txt', 'one\ntwo\n')
    const snapshot = await engine.capture(dir)
    const entry = snapOf(snapshot, 'a.txt')
    expect(entry).toBeDefined()
    expect(entry?.index_status).toBe('.')
    expect(entry?.worktree_status).toBe('M')
    expect(entry?.worktree_change).toBe('modified')
    expect(entry?.staged_change).toBeNull()
    expect(entry?.pre_existing_dirty).toBe(true)
    expect(entry?.worktree_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshot.counts.unstaged).toBe(1)
    expect(snapshot.counts.staged).toBe(0)
  })
})

// MARK: - §7 状态组合

describe('staged / unstaged / 双重变化（§7）', () => {
  it('staged 修改：index 来源', async () => {
    const dir = makeDir('bp-snap-staged-')
    initRepo(dir, { 'a.txt': 'one\n' })
    write(dir, 'a.txt', 'one\ntwo\n')
    git(['add', 'a.txt'], dir)
    const entry = snapOf(await engine.capture(dir), 'a.txt')
    expect(entry?.index_status).toBe('M')
    expect(entry?.worktree_status).toBe('.')
    expect(entry?.staged_change).toBe('modified')
    expect(entry?.worktree_change).toBeNull()
  })

  it('同一文件 staged + unstaged 同时变化：两列分记，不合并', async () => {
    const dir = makeDir('bp-snap-both-')
    initRepo(dir, { 'a.txt': 'one\n' })
    write(dir, 'a.txt', 'one\ntwo\n')
    git(['add', 'a.txt'], dir)
    write(dir, 'a.txt', 'one\ntwo\nthree\n') // add 之后又改
    const entry = snapOf(await engine.capture(dir), 'a.txt')
    expect(entry?.index_status).toBe('M')
    expect(entry?.worktree_status).toBe('M')
    expect(entry?.staged_change).toBe('modified')
    expect(entry?.worktree_change).toBe('modified')
  })

  it('untracked 新增 / 删除 / conflicted 各自成条目', async () => {
    const dir = makeDir('bp-snap-kinds-')
    initRepo(dir, { 'keep.txt': 'k\n', 'gone.txt': 'g\n', 'conf.txt': 'base\n' })
    // ① 先在干净树上构造冲突（merge 退出码 1 是预期的）
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim()
    git(['checkout', '-q', '-b', 'side'], dir)
    write(dir, 'conf.txt', 'side\n')
    git(['commit', '-qam', 'side'], dir)
    git(['checkout', '-q', branch], dir)
    write(dir, 'conf.txt', 'main\n')
    git(['commit', '-qam', 'main'], dir)
    try {
      git(['merge', 'side'], dir)
    } catch {
      /* 冲突正是要构造的状态 */
    }
    // ② 再做 untracked / 删除（与冲突互不干扰）
    write(dir, 'new.txt', 'n\n')
    rmSync(join(dir, 'gone.txt'))

    const snapshot = await engine.capture(dir)
    expect(snapOf(snapshot, 'new.txt')?.untracked).toBe(true)
    expect(snapOf(snapshot, 'gone.txt')?.worktree_change).toBe('deleted')
    expect(snapOf(snapshot, 'conf.txt')?.conflicted).toBe(true)
    expect(snapshot.counts.untracked).toBe(1)
    expect(snapshot.counts.conflicted).toBe(1)
  })

  it('ignored 文件只计数、不进文件明细（§7.4）', async () => {
    const dir = makeDir('bp-snap-ignored-')
    initRepo(dir, { '.gitignore': 'build/\n', 'a.txt': 'a\n' })
    write(dir, 'build/out.js', 'artifact\n')
    const snapshot = await engine.capture(dir)
    expect(snapshot.counts.ignored).toBeGreaterThanOrEqual(1)
    expect(snapshot.files.some((entry) => entry.repo_relative_path.startsWith('build/'))).toBe(false)
  })

  it('重命名（staged git mv）→ renamed + rename_from_path', async () => {
    const dir = makeDir('bp-snap-rename-')
    initRepo(dir, { 'old.txt': 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n' })
    const baseline = await engine.capture(dir) // mv 之前：基线是干净的 old.txt
    git(['mv', 'old.txt', 'renamed.txt'], dir)

    const diff = await engine.compare(baseline, await engine.capture(dir))
    expect(diff.status).toBe('ok')
    const entry = fileOf(diff, 'renamed.txt')
    expect(entry?.change_kind).toBe('renamed')
    expect(entry?.rename_from_path).toBe('old.txt')
    // 旧路径不出现在清单里（git 只报新路径 + orig）
    expect(fileOf(diff, 'old.txt')).toBeUndefined()
  })

  it('重命名（未暂存：删除 + 同内容新增）→ 按内容配对成 renamed', async () => {
    const dir = makeDir('bp-snap-rename2-')
    initRepo(dir, { 'src.txt': 'alpha\nbeta\ngamma\n' })
    const baseline = await engine.capture(dir)

    rmSync(join(dir, 'src.txt'))
    write(dir, 'dst.txt', 'alpha\nbeta\ngamma\n')
    const diff = await engine.compare(baseline, await engine.capture(dir))

    const entry = fileOf(diff, 'dst.txt')
    expect(entry?.change_kind).toBe('renamed')
    expect(entry?.rename_from_path).toBe('src.txt')
    expect(fileOf(diff, 'src.txt')).toBeUndefined()
    expect(diff.stats.renamed).toBe(1)
  })

  it('二进制文件变化 → binary artifact、行数为 null（不冒充 0）', async () => {
    const dir = makeDir('bp-snap-binary-')
    initRepo(dir, { 'img.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) })
    write(dir, 'img.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 4, 5, 6])) // 基线时已脏
    const baseline = await engine.capture(dir)
    expect(snapOf(baseline, 'img.bin')?.is_binary).toBe(true)

    write(dir, 'img.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]))
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'img.bin')
    expect(entry?.artifact.kind).toBe('binary')
    expect(entry?.insertions).toBeNull()
    expect(entry?.deletions).toBeNull()
    expect(diff.stats.omitted_binary).toBe(1)
  })

  it('type_changed（文件换成 symlink）', async () => {
    const dir = makeDir('bp-snap-type-')
    initRepo(dir, { 'f.txt': 'real\n', 'g.txt': 'target\n' })
    const baseline = await engine.capture(dir)

    rmSync(join(dir, 'f.txt'))
    symlinkSync('g.txt', join(dir, 'f.txt'))
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'f.txt')
    expect(entry?.change_kind).toBe('type_changed')
    expect(entry?.status_origin).toBe('worktree')
  })
})

// MARK: - §7 Dirty 基线（核心正确性）

describe('Dirty 基线与净变化（§7）', () => {
  it('基线已脏 B → 任务后 C：Diff 是 B→C，绝不是 HEAD→C', async () => {
    const dir = makeDir('bp-snap-dirty-')
    initRepo(dir, { 'file.ts': 'A\n' }) // HEAD 内容 = A
    write(dir, 'file.ts', 'B\n') // 基线时已脏 = B
    const baseline = await engine.capture(dir)
    expect(snapOf(baseline, 'file.ts')?.pre_existing_dirty).toBe(true)
    expect(snapOf(baseline, 'file.ts')?.baseline_content.kind).toBe('stored')

    write(dir, 'file.ts', 'C\n') // 任务结束 = C
    const diff = await engine.compare(baseline, await engine.capture(dir))

    const entry = fileOf(diff, 'file.ts')
    expect(entry).toBeDefined()
    const body = text(entry!.artifact)
    expect(body).toContain('-B')
    expect(body).toContain('+C')
    expect(body).not.toContain('-A') // 关键：绝不能把 HEAD 内容当基线
    expect(entry?.pre_existing_dirty).toBe(true)
    expect(entry?.insertions).toBe(1)
    expect(entry?.deletions).toBe(1)
  })

  it('干净基线 A → 改成 B：Diff A→B（基线内容走 cat-file 重建）', async () => {
    const dir = makeDir('bp-snap-cleanbase-')
    initRepo(dir, { 'file.ts': 'A\n' })
    const baseline = await engine.capture(dir)
    expect(snapOf(baseline, 'file.ts')).toBeUndefined() // 干净文件不进 manifest

    write(dir, 'file.ts', 'A\nB\n')
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const body = text(fileOf(diff, 'file.ts')!.artifact)
    expect(body).toContain('+B')
    expect(fileOf(diff, 'file.ts')?.pre_existing_dirty).toBe(false)
  })

  it('改后恢复原样 → 净变化 0（无条目）', async () => {
    const dir = makeDir('bp-snap-restore-')
    initRepo(dir, { 'file.ts': 'A\n' })
    const baseline = await engine.capture(dir)

    write(dir, 'file.ts', 'A\nB\n')
    write(dir, 'file.ts', 'A\n') // 恢复
    const diff = await engine.compare(baseline, await engine.capture(dir))
    expect(diff.files).toEqual([])
    expect(diff.stats.changed_files).toBe(0)
  })

  it('基线脏、期间恢复原状（相对基线无净变化）→ 无条目', async () => {
    const dir = makeDir('bp-snap-restore2-')
    initRepo(dir, { 'file.ts': 'A\n' })
    write(dir, 'file.ts', 'B\n')
    const baseline = await engine.capture(dir)

    write(dir, 'file.ts', 'B\nX\n')
    write(dir, 'file.ts', 'B\n') // 回到基线状态 B
    const diff = await engine.compare(baseline, await engine.capture(dir))
    expect(diff.files).toEqual([])
  })

  it('基线内容超预算未存 → 明确 unavailable，baseline_complete=false（§九 API 表达）', async () => {
    const dir = makeDir('bp-snap-budget-')
    initRepo(dir, { 'file.ts': 'A\n' })
    write(dir, 'file.ts', 'B'.repeat(600) + '\n')
    const small = new GitSnapshotEngine({ baselineStoreBytes: 50 })
    const baseline = await small.capture(dir)
    expect(baseline.baseline_store_complete).toBe(false)
    expect(snapOf(baseline, 'file.ts')?.baseline_content).toEqual({
      kind: 'not_stored',
      reason: 'budget'
    })

    write(dir, 'file.ts', 'C\n')
    const diff = await small.compare(baseline, await small.capture(dir))
    const entry = fileOf(diff, 'file.ts')
    expect(entry?.artifact.kind).toBe('unavailable')
    expect(entry?.insertions).toBeNull()
    expect(diff.baseline_store_complete).toBe(false)
    // 绝不回退成 HEAD→C
    expect(text(entry!.artifact)).not.toContain('+C')
  })
})

// MARK: - §7 HEAD 移动

describe('HEAD 在窗口内移动（§7）', () => {
  it('仅 commit（工作区内容不变）→ head_moved=true、无文件条目', async () => {
    const dir = makeDir('bp-snap-head-')
    initRepo(dir, { 'f.txt': 'v1\n' })
    write(dir, 'f.txt', 'v2\n')
    git(['add', 'f.txt'], dir)
    const baseline = await engine.capture(dir) // staged：index=worktree=v2

    git(['commit', '-qm', 'v2'], dir) // HEAD 前进，工作区内容仍是 v2
    const current = await engine.capture(dir)
    const diff = await engine.compare(baseline, current)

    expect(diff.head_moved).toBe(true)
    expect(diff.files).toEqual([])
  })

  it('HEAD 移动且另有文件被改 → 该条目 head_moved=true', async () => {
    const dir = makeDir('bp-snap-head2-')
    initRepo(dir, { 'f.txt': 'v1\n', 'g.txt': 'g1\n' })
    const baseline = await engine.capture(dir)

    write(dir, 'f.txt', 'v2\n')
    git(['add', 'f.txt'], dir)
    git(['commit', '-qm', 'v2'], dir)
    write(dir, 'g.txt', 'g2\n')

    const diff = await engine.compare(baseline, await engine.capture(dir))
    expect(diff.head_moved).toBe(true)
    expect(fileOf(diff, 'g.txt')?.head_moved).toBe(true)
  })
})

// MARK: - §6.2/6.3/6.4/6.5 仓库形态

describe('仓库形态识别（§6）', () => {
  it('Git Worktree：is_worktree=true、身份独立、基线互不干扰', async () => {
    const base = makeDir('bp-snap-wt-')
    const main = join(base, 'main')
    initRepo(main, { 'f.txt': 'v1\n' })
    const wt = join(base, 'linked')
    git(['worktree', 'add', '-q', wt], main)

    const mainSnap = await engine.capture(main)
    const wtSnap = await engine.capture(wt)
    expect(mainSnap.is_worktree).toBe(false)
    expect(wtSnap.is_worktree).toBe(true)
    expect(wtSnap.repository_identity).not.toBe(mainSnap.repository_identity)

    // 只改 linked worktree：主仓库快照不受影响
    write(wt, 'f.txt', 'changed in linked\n')
    const wtAfter = await engine.capture(wt)
    const mainAfter = await engine.capture(main)
    expect(snapOf(wtAfter, 'f.txt')).toBeDefined()
    expect(snapOf(mainAfter, 'f.txt')).toBeUndefined()
    const diff = await engine.compare(wtSnap, wtAfter)
    expect(fileOf(diff, 'f.txt')?.change_kind).toBe('modified')
  })

  it('Submodule：子模块自身 is_submodule=true；父仓库只记一个特殊路径、不下钻', async () => {
    const base = makeDir('bp-snap-sub-')
    const child = join(base, 'child')
    initRepo(child, { 'sub.txt': 'v1\n' })
    const parent = join(base, 'parent')
    initRepo(parent, { 'main.txt': 'm\n' })
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'kid'], parent)
    git(['commit', '-qm', 'add kid'], parent)

    const kidCheckout = join(parent, 'kid')
    const childSnap = await engine.capture(kidCheckout)
    expect(childSnap.capture_status).toBe('ok')
    expect(childSnap.is_submodule).toBe(true)

    const parentSnap = await engine.capture(parent)
    expect(parentSnap.is_submodule).toBe(false)
    expect(parentSnap.files.some((entry) => entry.repo_relative_path === 'kid')).toBe(false) // 干净

    // 子模块检出内提交 → 父仓库只看到 kid 一个路径
    write(kidCheckout, 'sub.txt', 'v2\n')
    git(['add', '-A', '.'], kidCheckout)
    git(['commit', '-qm', 'v2'], kidCheckout)
    const parentAfter = await engine.capture(parent)
    const kid = snapOf(parentAfter, 'kid')
    expect(kid).toBeDefined()
    expect(kid?.submodule_path).toBe(true)
    // 不下钻：没有 kid/... 的条目
    expect(parentAfter.files.some((entry) => entry.repo_relative_path.startsWith('kid/'))).toBe(false)
  })

  it('非 Git 目录 → not_a_repository 结构化状态（不抛异常）', async () => {
    const dir = makeDir('bp-snap-nogit-')
    write(dir, 'plain.txt', 'hello\n')
    const snapshot = await engine.capture(dir)
    expect(snapshot.capture_status).toBe('not_a_repository')
    expect(snapshot.error_code).toBeNull()
    expect(snapshot.is_git).toBe(false)
    expect(snapshot.files).toEqual([])
    expect(snapshot.counts.tracked).toBe(0)
  })

  it('空仓库（unborn HEAD）：has_unborn_head=true、head_sha=null、分支仍在', async () => {
    const dir = makeDir('bp-snap-empty-')
    mkdirSync(dir, { recursive: true })
    git(['init', '-q'], dir)
    git(['config', 'user.email', 'e2e@brewphase.test'], dir)
    git(['config', 'user.name', 'e2e'], dir)

    const snapshot = await engine.capture(dir)
    expect(snapshot.capture_status).toBe('ok')
    expect(snapshot.has_unborn_head).toBe(true)
    expect(snapshot.head_sha).toBeNull()
    expect(snapshot.tree_sha).toBeNull()
    expect(snapshot.branch).toBeTruthy()

    write(dir, 'first.txt', 'hello\n')
    const withFile = await engine.capture(dir)
    expect(snapOf(withFile, 'first.txt')?.untracked).toBe(true)
    expect(withFile.counts.untracked).toBe(1)
  })
})

// MARK: - §4.4 特殊文件名

describe('特殊文件名（§4.4 / §十一 18–19）', () => {
  it('中文 / 空格 / Tab / 换行 / 前导连字符 / pathspec 魔法字符都不拆坏', async () => {
    const dir = makeDir('bp-snap-names-')
    const names = [
      '中文文件.txt',
      'with space.txt',
      'with\ttab.txt',
      'with\nline.txt',
      '-leading.txt',
      'star*.txt',
      ':(magic).txt'
    ]
    const initial: Record<string, string> = {}
    for (const name of names) initial[name] = `content of ${name}\n`
    initRepo(dir, initial)

    // 改其中两个：一个中文、一个带换行
    write(dir, '中文文件.txt', 'content of 中文文件.txt\n第二行\n')
    write(dir, 'with\nline.txt', 'content of with\nline.txt\n改过了\n')

    const snapshot = await engine.capture(dir)
    expect(snapshot.capture_status).toBe('ok')
    // 两个被改的文件各成一条、路径原样
    expect(snapOf(snapshot, '中文文件.txt')).toBeDefined()
    expect(snapOf(snapshot, 'with\nline.txt')).toBeDefined()
    expect(snapshot.files).toHaveLength(2)

    const baseline = await engine.capture(dir)
    write(dir, '中文文件.txt', 'content of 中文文件.txt\n第二行\n第三行\n')
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, '中文文件.txt')
    expect(entry).toBeDefined()
    expect(entry?.repo_relative_path).toBe('中文文件.txt')
    expect(text(entry!.artifact)).toContain('+第三行')
    // 带换行的文件名不会被当成两条
    expect(diff.files.every((f) => !f.repo_relative_path.includes('content of'))).toBe(true)
  })
})

// MARK: - §十 敏感文件

describe('敏感文件硬排除（§十）', () => {
  it('.env 全程不读：hash 为 null、diff 只给省略态、内容绝不出现', async () => {
    const dir = makeDir('bp-snap-env-')
    initRepo(dir, { 'app.ts': 'x\n' })
    const secret = 'SUPER_SECRET_VALUE_12345'
    write(dir, '.env', `TOKEN=${secret}\n`)
    const baseline = await engine.capture(dir)

    const envEntry = snapOf(baseline, '.env')
    expect(envEntry?.unread_reason).toBe('sensitive')
    expect(envEntry?.worktree_hash).toBeNull() // 没读过 → 没有 hash
    expect(envEntry?.baseline_content).toEqual({ kind: 'not_stored', reason: 'sensitive' })

    // 状态变化（git add）后出现在对照里，但只给省略态
    git(['add', '.env'], dir)
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, '.env')
    expect(entry?.artifact.kind).toBe('sensitive')
    expect(entry?.insertions).toBeNull()
    expect(entry?.deletions).toBeNull()
    expect(JSON.stringify(diff)).not.toContain(secret)
    expect(diff.stats.omitted_sensitive).toBe(1)
  })

  it('敏感文件状态未变 → 完全不出现（从不检查内容）', async () => {
    const dir = makeDir('bp-snap-env2-')
    initRepo(dir, { 'app.ts': 'x\n' })
    write(dir, '.env', 'A=1\n')
    const baseline = await engine.capture(dir)

    write(dir, '.env', 'A=2\n') // 只改内容、仍 untracked → 状态没变
    const diff = await engine.compare(baseline, await engine.capture(dir))
    expect(fileOf(diff, '.env')).toBeUndefined()
  })

  it('共享清单扩展生效：.p12 / .keystore 同样硬排除', async () => {
    const dir = makeDir('bp-snap-p12-')
    initRepo(dir, { 'app.ts': 'x\n' })
    write(dir, 'cert.p12', 'binary-ish')
    write(dir, 'app.keystore', 'store')
    const snapshot = await engine.capture(dir)
    expect(snapOf(snapshot, 'cert.p12')?.unread_reason).toBe('sensitive')
    expect(snapOf(snapshot, 'app.keystore')?.unread_reason).toBe('sensitive')
    expect(snapOf(snapshot, 'cert.p12')?.worktree_hash).toBeNull()
  })
})

// MARK: - §9 容量配额

describe('容量配额（§9）', () => {
  it('超大文件：不整读（hash=null），变化时给 over_budget 而非伪造统计', async () => {
    const dir = makeDir('bp-snap-huge-')
    initRepo(dir, { 'app.ts': 'x\n' })
    write(dir, 'huge.txt', 'a'.repeat(8 * 1024 * 1024 + 10))
    const baseline = await engine.capture(dir)
    const entry = snapOf(baseline, 'huge.txt')
    expect(entry?.unread_reason).toBe('too_large')
    expect(entry?.worktree_hash).toBeNull()

    write(dir, 'huge.txt', 'b'.repeat(8 * 1024 * 1024 + 20))
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const changed = fileOf(diff, 'huge.txt')
    expect(changed?.artifact.kind).toBe('over_budget')
    expect(changed?.insertions).toBeNull()
  })

  it('超过单文件行数/字节配额 → over_budget（file_budget）但保留 insertions/deletions', async () => {
    const dir = makeDir('bp-snap-lines-')
    initRepo(dir, { 'big.txt': Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n') + '\n' })
    const baseline = await engine.capture(dir)

    write(
      dir,
      'big.txt',
      Array.from({ length: 1200 }, (_, i) => `CHANGED line ${i}`).join('\n') + '\n'
    )
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'big.txt')
    expect(entry?.artifact.kind).toBe('over_budget')
    if (entry?.artifact.kind === 'over_budget') {
      expect(entry.artifact.reason).toBe('file_budget')
      expect(entry.artifact.insertions).toBe(1200) // 统计保留（§九）
      expect(entry.artifact.deletions).toBe(1200)
    }
    expect(diff.stats.omitted_over_budget).toBe(1)
    expect(diff.stats.insertions_total).toBe(1200)
  })

  it('快照总量配额：超出的文件标 snapshot_budget，先到的保留完整 Diff', async () => {
    const dir = makeDir('bp-snap-total-')
    const files: Record<string, string> = {}
    const makeLines = (tag: string, count: number): string =>
      Array.from({ length: count }, (_, i) => `${tag} ${i} ${'x'.repeat(50)}`).join('\n') + '\n'
    for (let i = 0; i < 12; i++) files[`f${i}.txt`] = makeLines('base', 500)
    initRepo(dir, files)
    const baseline = await engine.capture(dir)

    for (let i = 0; i < 12; i++) write(dir, `f${i}.txt`, makeLines('CHANGED', 500))
    const diff = await engine.compare(baseline, await engine.capture(dir))

    const kinds = diff.files.map((entry) =>
      entry.artifact.kind === 'diff'
        ? 'diff'
        : entry.artifact.kind === 'over_budget'
          ? entry.artifact.reason
          : entry.artifact.kind
    )
    expect(kinds).toContain('diff')
    expect(kinds).toContain('snapshot_budget')
    // 超预算的条目仍保留统计
    const over = diff.files.find(
      (entry) => entry.artifact.kind === 'over_budget' && entry.artifact.reason === 'snapshot_budget'
    )
    expect(over?.insertions).toBe(500)
  })
})

// MARK: - §十一 错误与边界

describe('错误与边界（§十一 24–27）', () => {
  it('git 命令超时 → 结构化 git_timeout（超时可注入）', async () => {
    const dir = makeDir('bp-snap-timeout-')
    initRepo(dir)
    const slow = new GitSnapshotEngine({ timeoutMs: 1 })
    const snapshot = await slow.capture(dir)
    expect(snapshot.capture_status).toBe('error')
    expect(snapshot.error_code).toBe('git_timeout')
  })

  it('git 不存在 → 结构化 git_not_found', async () => {
    const dir = makeDir('bp-snap-nogit-bin-')
    initRepo(dir)
    const broken = new GitSnapshotEngine({ gitPath: '/definitely/not/a/git-binary' })
    const snapshot = await broken.capture(dir)
    expect(snapshot.capture_status).toBe('error')
    expect(snapshot.error_code).toBe('git_not_found')
  })

  it('工作区根被移动 → root_unavailable（不抛异常）', async () => {
    const dir = makeDir('bp-snap-moved-')
    initRepo(dir)
    rmSync(dir, { recursive: true, force: true })
    const snapshot = await engine.capture(dir)
    expect(snapshot.capture_status).toBe('error')
    expect(snapshot.error_code).toBe('root_unavailable')
  })

  it('工作区根不可访问（权限拒绝）→ 结构化 error', async () => {
    const dir = makeDir('bp-snap-perm-')
    initRepo(dir)
    chmodSync(dir, 0o000)
    try {
      const snapshot = await engine.capture(dir)
      expect(snapshot.capture_status).toBe('error')
      expect(['permission_denied', 'git_failed', 'root_unavailable']).toContain(
        snapshot.error_code
      )
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  it('symlink 指向工作区外部：只取目标字符串，绝不读取外部内容', async () => {
    const outside = makeDir('bp-snap-outside-')
    write(outside, 'secret.txt', 'OUTSIDE_SECRET_CONTENT_MUST_NOT_APPEAR\n')
    const dir = makeDir('bp-snap-link-')
    initRepo(dir, { 'g.txt': 'target\n' })
    // 链接保持 untracked：基线 manifest 才会包含它（干净文件不进 manifest）
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'evil.txt'))

    const baseline = await engine.capture(dir)
    const entry = snapOf(baseline, 'evil.txt')
    expect(entry?.is_symlink).toBe(true)
    expect(entry?.worktree_hash).not.toBeNull()
    expect(JSON.stringify(baseline)).not.toContain('OUTSIDE_SECRET_CONTENT')

    // 外部内容变化 → 链接本身没变 → 无条目
    write(outside, 'secret.txt', 'CHANGED_OUTSIDE\n')
    const diff = await engine.compare(baseline, await engine.capture(dir))
    expect(diff.files).toEqual([])
    expect(JSON.stringify(diff)).not.toContain('CHANGED_OUTSIDE')

    // 删除链接 → deleted + **独立 symlink artifact**（修复二 §四.7-9）：
    // 绝对目标替换为占位符，绝不把机器绝对路径或外部内容写进对外 Diff。
    rmSync(join(dir, 'evil.txt'))
    const diff2 = await engine.compare(baseline, await engine.capture(dir))
    const removed = fileOf(diff2, 'evil.txt')
    expect(removed?.change_kind).toBe('deleted')
    expect(removed?.artifact.kind).toBe('symlink')
    if (removed?.artifact.kind === 'symlink') {
      expect(removed.artifact.target_before).toBe('<absolute-target>')
      expect(removed.artifact.target_after).toBeNull()
    }
    expect(JSON.stringify(diff2)).not.toContain(join(outside, 'secret.txt'))
    expect(JSON.stringify(diff2)).not.toContain('OUTSIDE_SECRET_CONTENT')
  })
})

// MARK: - §五 身份与 compare 边界

describe('身份与 compare 边界（§五）', () => {
  it('不同仓库身份 → repository_mismatch；采集失败的一侧 → 对应错误', async () => {
    const a = makeDir('bp-snap-id-a-')
    const b = makeDir('bp-snap-id-b-')
    initRepo(a)
    initRepo(b)
    const plain = makeDir('bp-snap-id-plain-')
    write(plain, 'x', 'y')

    const snapA = await engine.capture(a)
    const snapB = await engine.capture(b)
    const notRepo = await engine.capture(plain)

    const cross = await engine.compare(snapA, snapB)
    expect(cross.status).toBe('error')
    expect(cross.error_code).toBe('repository_mismatch')

    const bad = await engine.compare(notRepo, snapA)
    expect(bad.status).toBe('error')
    expect(bad.error_code).toBe('baseline_not_ok')

    const bad2 = await engine.compare(snapA, notRepo)
    expect(bad2.status).toBe('error')
    expect(bad2.error_code).toBe('current_not_ok')
  })

  it('基线时干净、窗口内删除 → deleted 且 diff 展示旧内容', async () => {
    const dir = makeDir('bp-snap-del-')
    initRepo(dir, { 'doomed.txt': 'old line 1\nold line 2\n' })
    const baseline = await engine.capture(dir)

    rmSync(join(dir, 'doomed.txt'))
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'doomed.txt')
    expect(entry?.change_kind).toBe('deleted')
    expect(entry?.content_hash_before).toMatch(/^[0-9a-f]{64}$/)
    expect(entry?.content_hash_after).toBeNull()
    expect(text(entry!.artifact)).toContain('-old line 1')
    expect(diff.stats.deleted).toBe(1)
  })

  it('基线时干净、窗口内新增 → added 且 diff 展示新增内容', async () => {
    const dir = makeDir('bp-snap-add-')
    initRepo(dir, { 'base.txt': 'b\n' })
    const baseline = await engine.capture(dir)

    write(dir, 'brand.txt', 'brand new\nsecond\n')
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'brand.txt')
    expect(entry?.change_kind).toBe('added')
    expect(entry?.content_hash_before).toBeNull()
    expect(text(entry!.artifact)).toContain('+brand new')
    expect(diff.stats.added).toBe(1)
  })

  it('Unicode diff 正确（中文行增删 + 统计）', async () => {
    const dir = makeDir('bp-snap-uni-')
    initRepo(dir, { '说明.md': '# 标题\n第一段\n' })
    const baseline = await engine.capture(dir)

    write(dir, '说明.md', '# 标题\n第一段\n新增的中文行\n')
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, '说明.md')
    expect(entry?.insertions).toBe(1)
    expect(entry?.deletions).toBe(0)
    expect(text(entry!.artifact)).toContain('+新增的中文行')
    expect(text(entry!.artifact)).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@|@@ -\d+ \+\d+ @@/)
  })

  it('Unified Diff 的 hunk 头格式与上下文正确', async () => {
    const dir = makeDir('bp-snap-hunk-')
    const initial = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n'
    initRepo(dir, { 'f.txt': initial })
    const baseline = await engine.capture(dir)

    const changed = Array.from({ length: 20 }, (_, i) => (i === 10 ? 'l10-CHANGED' : `l${i}`)).join(
      '\n'
    ) + '\n'
    write(dir, 'f.txt', changed)
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const body = text(fileOf(diff, 'f.txt')!.artifact)
    expect(body).toContain('@@ -8,7 +8,7 @@') // 行 10 ±3 上下文
    expect(body).toContain('-l10')
    expect(body).toContain('+l10-CHANGED')
    expect(body).toContain(' l9') // 上下文行
  })

  it('文件无结尾换行 → 输出 \\ No newline at end of file', async () => {
    const dir = makeDir('bp-snap-nonl-')
    initRepo(dir, { 'f.txt': 'alpha' }) // 无结尾 \n
    const baseline = await engine.capture(dir)

    write(dir, 'f.txt', 'alpha\nbeta') // 仍无结尾 \n
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const body = text(fileOf(diff, 'f.txt')!.artifact)
    expect(body).toContain('\\ No newline at end of file')
    expect(body).toContain('+beta')
  })
})

// MARK: - §十一 额外：只读保证

describe('只读保证（§十一 额外）', () => {
  /** 指纹：HEAD、整个 .git（含 index 与对象库）与工作区文件的内容级哈希。 */
  function fingerprint(dir: string): { head: string; git: string; worktree: string } {
    const hash = createHash('sha256')
    const walk = (base: string, prefix: string): string[] => {
      const out: string[] = []
      for (const name of readdirSync(base, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${name.name}` : name.name
        if (name.isDirectory()) out.push(...walk(join(base, name.name), rel))
        else out.push(`${rel}:${createHash('sha256').update(readFileSync(join(base, name.name))).digest('hex')}`)
      }
      return out.sort()
    }
    const head = git(['rev-parse', 'HEAD'], dir).trim()
    hash.update(walk(join(dir, '.git'), '.git').join('\n'))
    const gitTree = hash.digest('hex')
    const worktree = createHash('sha256')
      .update(
        walk(dir, '')
          .filter((line) => !line.startsWith('.git/'))
          .join('\n')
      )
      .digest('hex')
    return { head, git: gitTree, worktree }
  }

  it('capture + compare 不改 HEAD / index / 对象库 / config / 工作区；hooks 与外部程序不执行', async () => {
    const dir = makeDir('bp-snap-ro-')
    initRepo(dir, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
    write(dir, 'a.txt', 'one\ndirty\n') // 让 manifest 有内容

    // 注入「会写 marker 的外部程序」：fsmonitor 钩子、外部 diff、textconv、hooks
    const markers = makeDir('bp-snap-ro-markers-')
    const script = (name: string): string => {
      const path = join(markers, `${name}.sh`)
      writeFileSync(path, `#!/bin/sh\necho x >> "${join(markers, name)}.marker"\nexit 1\n`)
      chmodSync(path, 0o755)
      return path
    }
    git(['config', 'core.fsmonitor', script('fsmonitor')], dir)
    git(['config', 'diff.external', script('extdiff')], dir)
    git(['config', 'diff.a.textconv', script('textconv')], dir)
    for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'pre-push', 'post-merge']) {
      const path = join(dir, '.git', 'hooks', hook)
      writeFileSync(path, `#!/bin/sh\necho x >> "${join(markers, hook)}.marker"\nexit 0\n`)
      chmodSync(path, 0o755)
    }

    // 第一轮：capture 前后指纹一致
    const before1 = fingerprint(dir)
    const snap1 = await engine.capture(dir)
    expect(snap1.capture_status).toBe('ok')
    expect(fingerprint(dir)).toEqual(before1)

    // 第二轮：窗口内改动（测试自己的动作）→ capture + compare 前后指纹一致
    write(dir, 'b.txt', 'two\nchanged\n')
    const before2 = fingerprint(dir)
    const snap2 = await engine.capture(dir)
    const diff = await engine.compare(snap1, snap2)
    expect(diff.status).toBe('ok')
    expect(fileOf(diff, 'b.txt')).toBeDefined()
    expect(fingerprint(dir)).toEqual(before2)

    // 没有新 commit、没有新对象（指纹已覆盖）、index 内容未变（指纹已覆盖）
    expect(snap2.head_sha).toBe(snap1.head_sha)

    // 任何外部程序 / hook 都没有被执行
    const executed = readdirSync(markers).filter((name) => name.endsWith('.marker'))
    expect(executed).toEqual([])
  })
})


// MARK: - 修复一：HEAD Tree 清单与 Commit 场景（规格 §三 A–F）

describe('HEAD Tree 清单与 Commit 场景（修复一）', () => {
  it('Tree 清单字段：path/mode/type/sha，按 NUL 解析特殊文件名', async () => {
    const dir = makeDir('bp-tree-fields-')
    initRepo(dir, { '中文 文件.txt': 'x\n', 'tab\there.txt': 'y\n', 'plain.ts': 'z\n' })
    const snapshot = await engine.capture(dir)
    expect(snapshot.head_tree.status).toBe('ok')
    const paths = snapshot.head_tree.entries.map((entry) => entry.path).sort()
    expect(paths).toEqual(['plain.ts', 'tab\there.txt', '中文 文件.txt'].sort())
    for (const entry of snapshot.head_tree.entries) {
      expect(entry.mode).toMatch(/^\d{6}$/)
      expect(['blob', 'tree', 'commit']).toContain(entry.type)
      expect(entry.sha).toMatch(/^[0-9a-f]{40}$/)
    }
    // 只存元数据：序列化结果不含文件内容
    expect(JSON.stringify(snapshot.head_tree)).not.toContain('x\n')
    // 身份/序列化仍不含绝对路径
    expect(JSON.stringify(snapshot)).not.toContain(dir)
  })

  it('空仓库 → 明确的空 Tree 状态（empty，不是 unavailable）', async () => {
    const dir = makeDir('bp-tree-empty-')
    mkdirSync(dir, { recursive: true })
    git(['init', '-q'], dir)
    git(['config', 'user.email', 'e2e@brewphase.test'], dir)
    git(['config', 'user.name', 'e2e'], dir)
    const snapshot = await engine.capture(dir)
    expect(snapshot.head_tree.status).toBe('empty')
    expect(snapshot.head_tree.entries).toEqual([])
    expect(snapshot.head_tree.error_code).toBeNull()
  })

  it('输出上限是硬限制：超限 → 结构化 output_limit（不假装完整）', async () => {
    const dir = makeDir('bp-tree-limit-')
    initRepo(dir, { 'a.txt': 'one\n' })
    const tiny = new GitSnapshotEngine({ maxOutputBytes: 50 })
    const snapshot = await tiny.capture(dir)
    expect(snapshot.capture_status).toBe('error')
    expect(snapshot.error_code).toBe('output_limit')
    // error 快照的 Tree 状态同样明确为 unavailable，而非空清单
    expect(snapshot.head_tree.status).toBe('unavailable')
    expect(snapshot.head_tree.error_code).toBe('output_limit')
  })

  it('Tree 清单不可用 → compare 不把受影响路径伪装成「无变化」', async () => {
    const dir = makeDir('bp-tree-unavail-')
    initRepo(dir, { 'a.txt': 'one\n' })
    const baseline = await engine.capture(dir)
    const current = await engine.capture(dir)
    // 人为把 baseline 的 Tree 标成不可用（等价于超限/读取失败后的快照）
    const broken: GitWorkspaceSnapshot = {
      ...baseline,
      head_tree: { status: 'unavailable', error_code: 'output_limit', entries: [], malformed_records: 0 }
    }
    const diff = await engine.compare(broken, current)
    expect(diff.status).toBe('ok')
    // a.txt 在 current Tree 里、baseline 侧存在性未知 → 不可判定条目，而不是静默跳过
    const entry = fileOf(diff, 'a.txt')
    expect(entry).toBeDefined()
    expect(entry?.observation).toBe('unavailable')
    expect(entry?.artifact.kind).toBe('unavailable')
    expect(diff.stats.undetermined).toBeGreaterThanOrEqual(1)
    expect(diff.stats.changed_files).toBe(0)
  })

  it('场景 A：窗口内 commit（A→B）→ head_moved + Diff 不丢失', async () => {
    const dir = makeDir('bp-scen-a-')
    initRepo(dir, { 'file.ts': 'A\n' })
    const baseline = await engine.capture(dir) // T1 干净 A

    write(dir, 'file.ts', 'B\n') // T2 修改
    git(['add', 'file.ts'], dir)
    git(['commit', '-qm', 'B'], dir) // T3 提交
    const current = await engine.capture(dir) // T4 干净 B

    const diff = await engine.compare(baseline, current)
    expect(diff.head_moved).toBe(true)
    const entry = fileOf(diff, 'file.ts')
    expect(entry, 'commit 后工作区干净，变化也不许丢').toBeDefined()
    expect(entry?.observation).toBe('changed')
    expect(entry?.status_origin).toBe('committed') // 不是普通 index 变化
    expect(entry?.pre_existing_dirty).toBe(false)
    const body = text(entry!.artifact)
    expect(body).toContain('-A')
    expect(body).toContain('+B')
  })

  it('场景 B：提交新增文件 → added（origin committed）', async () => {
    const dir = makeDir('bp-scen-b-')
    initRepo(dir, { 'base.ts': 'b\n' })
    const baseline = await engine.capture(dir)

    write(dir, 'new.ts', 'brand new\n')
    git(['add', 'new.ts'], dir)
    git(['commit', '-qm', 'add new'], dir)
    const diff = await engine.compare(baseline, await engine.capture(dir))

    const entry = fileOf(diff, 'new.ts')
    expect(entry?.change_kind).toBe('added')
    expect(entry?.status_origin).toBe('committed')
    expect(text(entry!.artifact)).toContain('+brand new')
  })

  it('场景 C：提交删除文件 → deleted（origin committed）', async () => {
    const dir = makeDir('bp-scen-c-')
    initRepo(dir, { 'doomed.ts': 'bye\n', 'keep.ts': 'k\n' })
    const baseline = await engine.capture(dir)

    rmSync(join(dir, 'doomed.ts'))
    git(['add', '-A', '.'], dir)
    git(['commit', '-qm', 'remove doomed'], dir)
    const diff = await engine.compare(baseline, await engine.capture(dir))

    const entry = fileOf(diff, 'doomed.ts')
    expect(entry?.change_kind).toBe('deleted')
    expect(entry?.status_origin).toBe('committed')
    expect(text(entry!.artifact)).toContain('-bye')
    expect(fileOf(diff, 'keep.ts')).toBeUndefined()
  })

  it('场景 D：提交重命名 → 恰好一条 renamed，不重复 added/deleted', async () => {
    const dir = makeDir('bp-scen-d-')
    initRepo(dir, { 'old.ts': 'alpha\nbeta\ngamma\ndelta\n' })
    const baseline = await engine.capture(dir)

    git(['mv', 'old.ts', 'new.ts'], dir)
    git(['commit', '-qm', 'rename'], dir)
    const diff = await engine.compare(baseline, await engine.capture(dir))

    expect(diff.stats.renamed).toBe(1)
    expect(diff.stats.added).toBe(0)
    expect(diff.stats.deleted).toBe(0)
    const renamed = diff.files.filter((entry) => entry.change_kind === 'renamed')
    expect(renamed).toHaveLength(1)
    expect(renamed[0].repo_relative_path).toBe('new.ts')
    expect(renamed[0].rename_from_path).toBe('old.ts')
    // 旧路径绝不再单独报 deleted
    expect(fileOf(diff, 'old.ts')).toBeUndefined()
  })

  it('场景 E：提交 B 后继续改 C → 窗口净变化是 A→C（不是 B→C）', async () => {
    const dir = makeDir('bp-scen-e-')
    initRepo(dir, { 'file.ts': 'A\n' })
    const baseline = await engine.capture(dir)

    write(dir, 'file.ts', 'B\n')
    git(['add', 'file.ts'], dir)
    git(['commit', '-qm', 'B'], dir)
    write(dir, 'file.ts', 'C\n') // 提交后继续修改
    const diff = await engine.compare(baseline, await engine.capture(dir))

    const entry = fileOf(diff, 'file.ts')
    expect(entry).toBeDefined()
    const body = text(entry!.artifact)
    expect(body).toContain('-A')
    expect(body).toContain('+C')
    expect(body).not.toContain('-B') // B 只是窗口中间态，不是基线
    expect(entry?.status_origin).toBe('worktree') // 终点是工作区脏态
  })

  it('场景 F：HEAD 移动但工作区内容无净变化 → head_moved=true、零文件条目', async () => {
    const dir = makeDir('bp-scen-f-')
    initRepo(dir, { 'file.ts': 'A\n' })
    write(dir, 'file.ts', 'B\n')
    git(['add', 'file.ts'], dir)
    const baseline = await engine.capture(dir) // staged：内容已是 B

    git(['commit', '-qm', 'B'], dir) // 只是提交，内容不变
    const diff = await engine.compare(baseline, await engine.capture(dir))
    expect(diff.head_moved).toBe(true)
    expect(diff.files).toEqual([])
    expect(diff.stats.changed_files).toBe(0)
  })
})

// MARK: - 修复二：Symlink 安全（规格 §四）

describe('Symlink 安全（修复二）', () => {
  it('指向含敏感内容的外部文件：内容与绝对路径都不进 Diff / JSON', async () => {
    const outside = makeDir('bp-link-secret-out-')
    write(outside, 'creds.txt', 'AWS_SECRET=AKIA_SUPER_SECRET_VALUE\n')
    const dir = makeDir('bp-link-secret-')
    initRepo(dir, { 'app.ts': 'x\n' })
    symlinkSync(join(outside, 'creds.txt'), join(dir, 'creds.link'))
    git(['add', '-A', '.'], dir)
    git(['commit', '-qm', 'link'], dir)

    const baseline = await engine.capture(dir)
    expect(JSON.stringify(baseline)).not.toContain('AKIA_SUPER_SECRET_VALUE')
    expect(JSON.stringify(baseline)).not.toContain(outside)

    rmSync(join(dir, 'creds.link'))
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'creds.link')
    expect(entry?.change_kind).toBe('deleted')
    expect(entry?.artifact.kind).toBe('symlink')
    expect(JSON.stringify(diff)).not.toContain('AKIA_SUPER_SECRET_VALUE')
    expect(JSON.stringify(diff)).not.toContain(outside)
  })

  it('baseline 后把链接换成另一个外部目标 → 链接事实变化（两侧绝对目标都变占位符）', async () => {
    const outA = makeDir('bp-link-out-a-')
    const outB = makeDir('bp-link-out-b-')
    write(outA, 'a.txt', 'CONTENT_A_MUST_NOT_APPEAR\n')
    write(outB, 'b.txt', 'CONTENT_B_MUST_NOT_APPEAR\n')
    const dir = makeDir('bp-link-swap-')
    initRepo(dir, { 'app.ts': 'x\n' })
    symlinkSync(join(outA, 'a.txt'), join(dir, 'link.txt'))
    git(['add', '-A', '.'], dir)
    git(['commit', '-qm', 'link a'], dir)
    const baseline = await engine.capture(dir)

    rmSync(join(dir, 'link.txt'))
    symlinkSync(join(outB, 'b.txt'), join(dir, 'link.txt'))
    const diff = await engine.compare(baseline, await engine.capture(dir))

    const entry = fileOf(diff, 'link.txt')
    expect(entry?.observation).toBe('changed')
    expect(entry?.artifact.kind).toBe('symlink')
    if (entry?.artifact.kind === 'symlink') {
      expect(entry.artifact.target_before).toBe('<absolute-target>')
      expect(entry.artifact.target_after).toBe('<absolute-target>')
    }
    expect(JSON.stringify(diff)).not.toContain('CONTENT_A_MUST_NOT_APPEAR')
    expect(JSON.stringify(diff)).not.toContain('CONTENT_B_MUST_NOT_APPEAR')
    expect(JSON.stringify(diff)).not.toContain(outA)
    expect(JSON.stringify(diff)).not.toContain(outB)
  })

  it('相对路径目标：目标字符串原样保留（不含机器信息）', async () => {
    const dir = makeDir('bp-link-rel-')
    initRepo(dir, { 'g.txt': 'g\n', 'other.txt': 'o\n' })
    symlinkSync('g.txt', join(dir, 'link.txt'))
    git(['add', '-A', '.'], dir)
    git(['commit', '-qm', 'rel link'], dir)
    const baseline = await engine.capture(dir)

    // 换成另一个相对目标
    rmSync(join(dir, 'link.txt'))
    symlinkSync('other.txt', join(dir, 'link.txt'))
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'link.txt')
    expect(entry?.artifact.kind).toBe('symlink')
    if (entry?.artifact.kind === 'symlink') {
      expect(entry.artifact.target_before).toBe('g.txt')
      expect(entry.artifact.target_after).toBe('other.txt')
    }
    // 仍是 symlink → git 报 M（modified），type_changed 只属于 file↔link 互换
    expect(entry?.change_kind).toBe('modified')
  })

  it('父级目录被换成指向外部的 symlink → 拒绝触碰（symlink_escape），不读外部内容', async () => {
    const outside = makeDir('bp-link-parent-out-')
    write(outside, 'f.txt', 'OUTSIDE_PARENT_CONTENT\n')
    const dir = makeDir('bp-link-parent-')
    initRepo(dir, { 'sub/f.txt': 'inside\n' })
    const baseline = await engine.capture(dir)
    // 干净文件不进 status manifest，但必须在 HEAD Tree 清单里
    expect(baseline.head_tree.entries.some((e) => e.path === 'sub/f.txt')).toBe(true)

    // 窗口内：把 sub 目录换成指向外部的链接
    rmSync(join(dir, 'sub'), { recursive: true, force: true })
    symlinkSync(outside, join(dir, 'sub'))
    const current = await engine.capture(dir)

    const entry = snapOf(current, 'sub/f.txt')
    // git 仍会报 sub/f.txt 的状态，但引擎拒绝跟随父级 symlink
    if (entry) {
      expect(entry.unread_reason).toBe('symlink_escape')
      expect(entry.worktree_hash).toBeNull()
      expect(entry.baseline_content).toEqual({ kind: 'not_stored', reason: 'symlink_escape' })
    }
    const diff = await engine.compare(baseline, current)
    expect(JSON.stringify(diff)).not.toContain('OUTSIDE_PARENT_CONTENT')
    expect(JSON.stringify(diff)).not.toContain(outside)
    // 不能读到外部内容就绝不产出「看似准确」的文本 Diff
    for (const file of diff.files) {
      if (file.repo_relative_path.startsWith('sub')) {
        expect(file.artifact.kind).not.toBe('diff')
      }
    }
  })

  it('全链路序列化：capture 与 compare 的 JSON 都不含外部内容与绝对目标', async () => {
    const outside = makeDir('bp-link-json-out-')
    write(outside, 'hidden.txt', 'HIDDEN_OUTSIDE_BODY\n')
    const dir = makeDir('bp-link-json-')
    initRepo(dir, { 'app.ts': 'x\n' })
    symlinkSync(join(outside, 'hidden.txt'), join(dir, 'h.link'))
    const baseline = await engine.capture(dir)
    rmSync(join(dir, 'h.link'))
    const diff = await engine.compare(baseline, await engine.capture(dir))

    for (const payload of [JSON.stringify(baseline), JSON.stringify(diff)]) {
      expect(payload).not.toContain('HIDDEN_OUTSIDE_BODY')
      expect(payload).not.toContain(outside)
      expect(payload).not.toContain('hidden.txt') // 目标文件名（绝对目标已占位）
    }
  })
})

// MARK: - 修复三：Snapshot 时间点一致性（规格 §五）

describe('Snapshot 时间点一致性（修复三）', () => {
  it('capture current 后、compare 前修改文件 → Diff 用采集时刻内容（B，不是 C）', async () => {
    const dir = makeDir('bp-consist-mod-')
    initRepo(dir, { 'file.ts': 'A\n' })
    const baseline = await engine.capture(dir)

    write(dir, 'file.ts', 'B\n')
    const current = await engine.capture(dir)
    write(dir, 'file.ts', 'C\n') // compare 之前才改的：必须被无视

    const diff = await engine.compare(baseline, current)
    const entry = fileOf(diff, 'file.ts')
    const body = text(entry!.artifact)
    expect(body).toContain('-A')
    expect(body).toContain('+B')
    expect(body).not.toContain('+C')
    // 内容 hash 与采集时刻一致（不产生与 hash 不一致的 Diff）
    expect(entry?.content_hash_after).toBe(sha256Hex(Buffer.from('B\n')))
  })

  it('capture current 后把文件替换成 symlink → 不跟随、Diff 仍是采集内容', async () => {
    const outside = makeDir('bp-consist-out-')
    write(outside, 'x.txt', 'EXTERNAL_AFTER_CAPTURE\n')
    const dir = makeDir('bp-consist-link-')
    initRepo(dir, { 'file.ts': 'A\n' })
    const baseline = await engine.capture(dir)

    write(dir, 'file.ts', 'B\n')
    const current = await engine.capture(dir)
    rmSync(join(dir, 'file.ts'))
    symlinkSync(join(outside, 'x.txt'), join(dir, 'file.ts'))

    const diff = await engine.compare(baseline, current)
    const body = text(fileOf(diff, 'file.ts')!.artifact)
    expect(body).toContain('-A')
    expect(body).toContain('+B')
    expect(JSON.stringify(diff)).not.toContain('EXTERNAL_AFTER_CAPTURE')
    expect(JSON.stringify(diff)).not.toContain(outside)
  })

  it('capture current 后删除文件 → Diff 仍用采集时刻内容', async () => {
    const dir = makeDir('bp-consist-del-')
    initRepo(dir, { 'file.ts': 'A\n' })
    const baseline = await engine.capture(dir)

    write(dir, 'file.ts', 'B\n')
    const current = await engine.capture(dir)
    rmSync(join(dir, 'file.ts')) // compare 之前才删的

    const diff = await engine.compare(baseline, current)
    const body = text(fileOf(diff, 'file.ts')!.artifact)
    expect(body).toContain('-A')
    expect(body).toContain('+B')
    expect(fileOf(diff, 'file.ts')?.content_hash_after).toBe(sha256Hex(Buffer.from('B\n')))
  })

  it('大文件绝不无上限读取：>8MB 只标记、不产出文本 Diff', async () => {
    const dir = makeDir('bp-consist-huge-')
    initRepo(dir, { 'app.ts': 'x\n' })
    write(dir, 'huge.txt', 'a'.repeat(8 * 1024 * 1024 + 5))
    const baseline = await engine.capture(dir)
    expect(snapOf(baseline, 'huge.txt')?.unread_reason).toBe('too_large')
    expect(snapOf(baseline, 'huge.txt')?.worktree_hash).toBeNull() // 没整读

    write(dir, 'huge.txt', 'b'.repeat(8 * 1024 * 1024 + 9))
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'huge.txt')
    expect(entry?.artifact.kind).not.toBe('diff')
    expect(entry?.insertions).toBeNull()
  })
})

// MARK: - 修复四：不可观测状态（规格 §六）

describe('不可观测状态（修复四）', () => {
  it('同一大小的大文件内容变化（size 与 status 都相同）→ unavailable 条目，绝不跳过', async () => {
    const dir = makeDir('bp-unknown-same-')
    initRepo(dir, { 'app.ts': 'x\n' })
    const size = 9 * 1024 * 1024
    write(dir, 'big.bin.txt', 'a'.repeat(size))
    const baseline = await engine.capture(dir)
    expect(snapOf(baseline, 'big.bin.txt')?.unread_reason).toBe('too_large')

    write(dir, 'big.bin.txt', 'b'.repeat(size)) // 同尺寸、同 status（仍 untracked）
    const current = await engine.capture(dir)
    expect(snapOf(current, 'big.bin.txt')?.size_bytes).toBe(size)

    const diff = await engine.compare(baseline, current)
    const entry = fileOf(diff, 'big.bin.txt')
    expect(entry, '无法确认时必须给出条目，不能伪装无变化').toBeDefined()
    // 判定不可用（没有 hash、尺寸又相同 → 无法确认），但内容本身是「超限拿不到」
    expect(entry?.observation).toBe('unavailable')
    expect(entry?.artifact.kind).toBe('over_budget')
    if (entry?.artifact.kind === 'over_budget') {
      expect(entry.artifact.reason).toBe('source_too_large')
      expect(entry.artifact.insertions).toBeNull() // 绝不伪造 0
    }
    expect(diff.stats.undetermined).toBe(1)
    expect(diff.stats.changed_files).toBe(0)
  })

  it('大文件大小变化 → 可确认 changed（尺寸是证据）', async () => {
    const dir = makeDir('bp-unknown-size-')
    initRepo(dir, { 'app.ts': 'x\n' })
    write(dir, 'big.txt', 'a'.repeat(9 * 1024 * 1024))
    const baseline = await engine.capture(dir)

    write(dir, 'big.txt', 'b'.repeat(9 * 1024 * 1024 + 64))
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'big.txt')
    expect(entry?.observation).toBe('changed')
    expect(entry?.artifact.kind).toBe('over_budget')
    if (entry?.artifact.kind === 'over_budget') {
      expect(entry.artifact.reason).toBe('source_too_large')
      expect(entry.artifact.insertions).toBeNull()
    }
  })

  it('基线侧读取权限消失（unreadable、size 相同）→ unavailable，不按「status 相同」跳过', async () => {
    const dir = makeDir('bp-unknown-perm-')
    initRepo(dir, { 'app.ts': 'x\n', 'locked.txt': 'original\n' })
    write(dir, 'locked.txt', 'modified\n') // 变脏，让基线有条目
    const file = join(dir, 'locked.txt')
    chmodSync(file, 0o000)
    let baseline: GitWorkspaceSnapshot
    try {
      baseline = await engine.capture(dir)
    } finally {
      chmodSync(file, 0o644)
    }
    expect(snapOf(baseline, 'locked.txt')?.unread_reason).toBe('unreadable')
    expect(snapOf(baseline, 'locked.txt')?.worktree_hash).toBeNull()

    // 窗口内恢复可读，内容与基线相同 → 仍不能凭空断言「没变」（基线无 hash）
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'locked.txt')
    expect(entry).toBeDefined()
    expect(entry?.observation).toBe('unavailable')
    expect(entry?.insertions).toBeNull()
  })

  it('当前侧读取权限消失（unreadable、size 相同）→ unavailable', async () => {
    const dir = makeDir('bp-unknown-perm2-')
    initRepo(dir, { 'app.ts': 'x\n', 'locked.txt': 'original\n' })
    const baseline = await engine.capture(dir)

    write(dir, 'locked.txt', 'modified\n')
    const file = join(dir, 'locked.txt')
    chmodSync(file, 0o000)
    let current: GitWorkspaceSnapshot
    try {
      current = await engine.capture(dir)
    } finally {
      chmodSync(file, 0o644)
    }
    expect(snapOf(current, 'locked.txt')?.unread_reason).toBe('unreadable')

    const diff = await engine.compare(baseline, current)
    const entry = fileOf(diff, 'locked.txt')
    expect(entry).toBeDefined()
    expect(entry?.observation).toBe('unavailable')
    expect(entry?.insertions).toBeNull()
  })

  it('无法重建 Git blob → unavailable(blob_missing)，不是无变化', async () => {
    const dir = makeDir('bp-unknown-blob-')
    initRepo(dir, { 'file.ts': 'A\n' })
    const baseline = await engine.capture(dir)
    const current = await engine.capture(dir)
    expect(current.capture_status).toBe('ok')

    // 篡改 baseline 的 Tree sha（等价于对象被 gc 后无法 cat-file）
    const broken: GitWorkspaceSnapshot = {
      ...baseline,
      head_tree: {
        ...baseline.head_tree,
        entries: baseline.head_tree.entries.map((entry) =>
          entry.path === 'file.ts' ? { ...entry, sha: 'a'.repeat(40) } : entry
        )
      }
    }
    const diff = await engine.compare(broken, current)
    const entry = fileOf(diff, 'file.ts')
    expect(entry).toBeDefined()
    expect(entry?.observation).toBe('changed') // git sha 已证实 HEAD 变了
    expect(entry?.artifact.kind).toBe('unavailable')
    if (entry?.artifact.kind === 'unavailable') {
      expect(entry.artifact.reason).toBe('blob_missing')
      expect(entry.artifact.insertions).toBeNull()
    }
  })

  it('驻留字节与快照 hash 不一致 → stale（完整性守卫，拒绝产出 Diff）', async () => {
    const dir = makeDir('bp-unknown-stale-')
    initRepo(dir, { 'file.ts': 'A\n' })
    write(dir, 'file.ts', 'B\n')
    const baseline = await engine.capture(dir)
    expect(snapOf(baseline, 'file.ts')?.baseline_content.kind).toBe('stored')

    // 篡改驻留字节（模拟内存态被破坏）
    const tampered: GitWorkspaceSnapshot = {
      ...baseline,
      baselineStore: new Map([[ 'file.ts', Buffer.from('TAMPERED\n') ]])
    }
    write(dir, 'file.ts', 'C\n')
    const diff = await engine.compare(tampered, await engine.capture(dir))
    const entry = fileOf(diff, 'file.ts')
    expect(entry).toBeDefined()
    expect(entry?.artifact.kind).toBe('unavailable')
    if (entry?.artifact.kind === 'unavailable') {
      expect(entry.artifact.reason).toBe('stale')
    }
    expect(JSON.stringify(diff)).not.toContain('TAMPERED')
  })

  it('baseline_store_complete 只表达预算语义；单文件可否重建看 artifact 原因', async () => {
    const dir = makeDir('bp-unknown-budget-')
    initRepo(dir, { 'file.ts': 'A\n' })
    write(dir, 'file.ts', 'B'.repeat(600) + '\n')
    const small = new GitSnapshotEngine({ baselineStoreBytes: 50 })
    const baseline = await small.capture(dir)
    // 预算溢出 → 旗标 false（预算语义）
    expect(baseline.baseline_store_complete).toBe(false)
    // 未溢出的快照 → true（即便它有 dirty 文件）
    const normal = await engine.capture(dir)
    expect(normal.baseline_store_complete).toBe(true)

    write(dir, 'file.ts', 'C\n')
    const diff = await small.compare(baseline, await small.capture(dir))
    expect(diff.baseline_store_complete).toBe(false)
    const entry = fileOf(diff, 'file.ts')
    expect(entry?.artifact.kind).toBe('unavailable')
    if (entry?.artifact.kind === 'unavailable') {
      expect(entry.artifact.reason).toBe('baseline_not_stored')
    }
    // 有 hash 的一侧仍可确认「变了」，只是产不出内容
    expect(entry?.observation).toBe('changed')
  })
})


// MARK: - 修复一：HEAD 与 Tree 绑定同一 Commit（规格 §三）

/** 可注入 Runner：在确定的调用点插入并发动作（不依赖 sleep）。 */
function countingRunner(mutate: (event: { sub: string; args: readonly string[]; nth: number }) => void) {
  let headReads = 0
  let lsTreeReads = 0
  return async (
    root: string,
    sub: 'rev-parse' | 'symbolic-ref' | 'status' | 'ls-files' | 'ls-tree' | 'cat-file',
    args: readonly string[],
    opts?: Parameters<typeof runGit>[3]
  ) => {
    if (sub === 'rev-parse' && args.includes('HEAD^{commit}')) {
      headReads += 1
      mutate({ sub, args, nth: headReads })
    }
    if (sub === 'ls-tree') {
      lsTreeReads += 1
      mutate({ sub, args, nth: lsTreeReads })
    }
    return runGit(root, sub, args, opts)
  }
}

describe('HEAD 与 Tree 绑定同一 Commit（修复一）', () => {
  it('正常采集：head_sha / tree_sha / head_tree 三者对应同一个 Commit', async () => {
    const dir = makeDir('bp-bind-ok-')
    initRepo(dir, { 'a.ts': 'A\n', 'b.ts': 'B\n' })
    const snapshot = await engine.capture(dir)
    expect(snapshot.capture_status).toBe('ok')
    expect(snapshot.head_sha).toBeTruthy()

    // 独立用 git 校验：Tree 清单必须精确等于该 Commit 的树
    const raw = execFileSync(
      'git',
      ['ls-tree', '-r', '-z', '--full-tree', snapshot.head_sha as string],
      { cwd: dir, encoding: 'utf8' }
    )
    const independent = parseLsTreeAll(raw)
    expect(independent.malformed).toBe(0)
    expect(snapshot.head_tree.status).toBe('ok')
    expect(snapshot.head_tree.malformed_records).toBe(0)
    expect(snapshot.head_tree.entries).toEqual(independent.entries)
    // tree_sha 也由同一 Commit 派生
    const treeSha = execFileSync('git', ['rev-parse', `${snapshot.head_sha}^{tree}`], {
      cwd: dir,
      encoding: 'utf8'
    }).trim()
    expect(snapshot.tree_sha).toBe(treeSha)
  })

  it('初始读 HEAD 之后发生新 Commit → 收尾核验发现漂移 → 重试一次后成功', async () => {
    const dir = makeDir('bp-bind-retry-')
    initRepo(dir, { 'a.ts': 'A\n' })
    let midSha = ''
    const engine2 = new GitSnapshotEngine({
      runner: countingRunner(({ sub, nth }) => {
        // 第 2 次 HEAD^{commit} 读取 = 第一次采集的收尾核验：
        // 在它之前提交 → 开头/收尾的 HEAD 必然不一致
        if (sub === 'rev-parse' && nth === 2) {
          write(dir, 'a.ts', 'A\nmid\n')
          git(['add', '-A', '.'], dir)
          git(['commit', '-qm', 'mid'], dir)
          midSha = git(['rev-parse', 'HEAD'], dir).trim()
        }
      })
    })

    const snapshot = await engine2.capture(dir)
    expect(snapshot.capture_status).toBe('ok')
    // 重试后的快照自洽：head 是那次中途提交，Tree 与它对应（没有混合版本）
    expect(snapshot.head_sha).toBe(midSha)
    const raw = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', midSha], {
      cwd: dir,
      encoding: 'utf8'
    })
    expect(snapshot.head_tree.entries).toEqual(parseLsTreeAll(raw).entries)
  })

  it('Tree 采集过程中 HEAD 变化 → 钉住的 Commit 仍自洽，收尾核验触发重试成功', async () => {
    const dir = makeDir('bp-bind-tree-')
    initRepo(dir, { 'a.ts': 'A\n' })
    let firstLsTree = true
    const engine2 = new GitSnapshotEngine({
      runner: countingRunner(({ sub }) => {
        // 第一次 ls-tree（钉住旧 Commit）执行前提交：ls-tree 仍返回旧树，
        // 但收尾 HEAD 已变 → 必须检测到漂移而不是拼出混合快照
        if (sub === 'ls-tree' && firstLsTree) {
          firstLsTree = false
          write(dir, 'a.ts', 'A\nchanged\n')
          git(['add', '-A', '.'], dir)
          git(['commit', '-qm', 'during-ls-tree'], dir)
        }
      })
    })

    const snapshot = await engine2.capture(dir)
    expect(snapshot.capture_status).toBe('ok')
    // 最终快照对应的是「重试后」的 HEAD，Tree 与它一致
    const head = git(['rev-parse', 'HEAD'], dir).trim()
    expect(snapshot.head_sha).toBe(head)
    const raw = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', head], {
      cwd: dir,
      encoding: 'utf8'
    })
    expect(snapshot.head_tree.entries).toEqual(parseLsTreeAll(raw).entries)
  })

  it('重试仍不稳定（每次收尾 HEAD 都变）→ 明确的 snapshot_unstable', async () => {
    const dir = makeDir('bp-bind-unstable-')
    initRepo(dir, { 'a.ts': 'A\n' })
    const engine2 = new GitSnapshotEngine({
      runner: countingRunner(({ sub, nth }) => {
        // 每次收尾核验读 HEAD（第 2、4 次）之前都提交 → 两次尝试全部漂移
        if (sub === 'rev-parse' && nth >= 2 && nth % 2 === 0) {
          write(dir, `drift-${nth}.txt`, 'x')
          git(['add', '-A', '.'], dir)
          git(['commit', '-qm', `drift ${nth}`], dir)
        }
      })
    })

    const snapshot = await engine2.capture(dir)
    expect(snapshot.capture_status).toBe('error')
    expect(snapshot.error_code).toBe('snapshot_unstable')
    expect(snapshot.head_tree.status).toBe('unavailable')
    expect(snapshot.head_tree.error_code).toBe('snapshot_unstable')
    // 失败快照绝不伪装成正常结果
    expect(snapshot.files).toEqual([])
  })
})

// MARK: - 修复二：Tree 完整性的全局表达（规格 §四）

describe('Tree 完整性（修复二）', () => {
  const withTree = (
    snap: GitWorkspaceSnapshot,
    patch: Partial<GitWorkspaceSnapshot['head_tree']>
  ): GitWorkspaceSnapshot => {
    const next: GitWorkspaceSnapshot = {
      ...snap,
      head_tree: { ...snap.head_tree, ...patch }
    }
    // rootPath / baselineStore 是**不可枚举**内部字段，对象展开会丢——手动还原
    Object.defineProperties(next, {
      rootPath: { value: snap.rootPath, enumerable: false, configurable: true },
      baselineStore: { value: snap.baselineStore, enumerable: false, configurable: true }
    })
    return next
  }

  it('baseline Tree unavailable / current ok → partial + 原因透出', async () => {
    const dir = makeDir('bp-comp-partial-b-')
    initRepo(dir, { 'a.ts': 'A\n' })
    const baseline = await engine.capture(dir)
    const current = await engine.capture(dir)
    const broken = withTree(baseline, { status: 'unavailable', error_code: 'output_limit', entries: [] })

    const diff = await engine.compare(broken, current)
    expect(diff.status).toBe('ok')
    expect(diff.manifest_completeness).toBe('partial')
    expect(diff.baseline_tree_status).toBe('unavailable')
    expect(diff.current_tree_status).toBe('ok')
    expect(diff.manifest_unavailable_reason).toBe('output_limit')
  })

  it('baseline ok / current Tree unavailable → partial（镜像）', async () => {
    const dir = makeDir('bp-comp-partial-c-')
    initRepo(dir, { 'a.ts': 'A\n' })
    const baseline = await engine.capture(dir)
    const current = await engine.capture(dir)
    const broken = withTree(current, { status: 'unavailable', error_code: 'git_failed', entries: [] })

    const diff = await engine.compare(baseline, broken)
    expect(diff.manifest_completeness).toBe('partial')
    expect(diff.baseline_tree_status).toBe('ok')
    expect(diff.current_tree_status).toBe('unavailable')
    expect(diff.manifest_unavailable_reason).toBe('git_failed')
  })

  it('两侧 Tree 均 unavailable 且 Status 为空 → 绝不返回「完整成功」的空结果', async () => {
    const dir = makeDir('bp-comp-unavail-')
    initRepo(dir, { 'a.ts': 'A\n' }) // 干净仓库：status 为空
    const baseline = await engine.capture(dir)
    const current = await engine.capture(dir)
    expect(baseline.files).toEqual([])

    const b = withTree(baseline, { status: 'unavailable', error_code: 'output_limit', entries: [] })
    const c = withTree(current, { status: 'unavailable', error_code: 'output_limit', entries: [] })
    const diff = await engine.compare(b, c)

    // 文件列表可以为空（确实没有可枚举路径），但全局完整性必须明确「不可用」
    expect(diff.files).toEqual([])
    expect(diff.status).toBe('ok')
    expect(diff.manifest_completeness).toBe('unavailable')
    expect(diff.baseline_tree_status).toBe('unavailable')
    expect(diff.current_tree_status).toBe('unavailable')
    expect(diff.manifest_unavailable_reason).toBe('output_limit')
  })

  it('两侧 Tree 均 unavailable 但 HEAD 不同 → head_moved 仍成立 + 完整性 unavailable', async () => {
    const dir = makeDir('bp-comp-unavail-head-')
    initRepo(dir, { 'a.ts': 'A\n' })
    const baseline = await engine.capture(dir)
    write(dir, 'a.ts', 'A\nmore\n')
    git(['add', '-A', '.'], dir)
    git(['commit', '-qm', 'move head'], dir)
    const current = await engine.capture(dir)

    const b = withTree(baseline, { status: 'unavailable', error_code: 'output_limit', entries: [] })
    const c = withTree(current, { status: 'unavailable', error_code: 'output_limit', entries: [] })
    const diff = await engine.compare(b, c)
    expect(diff.head_moved).toBe(true)
    expect(diff.manifest_completeness).toBe('unavailable')
    // stats.undetermined 是文件级的，与全局完整性互不替代
    expect(diff.stats.undetermined).toBe(0)
  })

  it('Tree 记录格式异常 → malformed 计数、绝不标完整（parser 不静默跳过）', async () => {
    const dir = makeDir('bp-comp-malformed-')
    initRepo(dir, { 'a.ts': 'A\n' })
    const corruptRunner = async (
      root: string,
      sub: 'rev-parse' | 'symbolic-ref' | 'status' | 'ls-files' | 'ls-tree' | 'cat-file',
      args: readonly string[],
      opts?: Parameters<typeof runGit>[3]
    ) => {
      const result = await runGit(root, sub, args, opts)
      if (sub === 'ls-tree') {
        // 混入一条没有 TAB 的坏记录
        const corrupt = `${result.text}garbage-record-without-tab${String.fromCharCode(0)}`
        return { ...result, text: corrupt, stdout: Buffer.from(corrupt, 'utf8') }
      }
      return result
    }
    const bad = new GitSnapshotEngine({ runner: corruptRunner })
    const good = new GitSnapshotEngine()

    const baseline = await bad.capture(dir) // baseline 侧 malformed
    const current = await good.capture(dir)
    expect(baseline.head_tree.status).toBe('ok')
    expect(baseline.head_tree.malformed_records).toBe(1)
    // 已解析的记录仍然保留（能确定的路径照常可用）
    expect(baseline.head_tree.entries.some((e) => e.path === 'a.ts')).toBe(true)

    const diff = await engine.compare(baseline, current)
    expect(diff.manifest_completeness).toBe('partial')
    expect(diff.manifest_unavailable_reason).toBe('tree_malformed')

    // 两侧都 malformed → unavailable
    const both = await engine.compare(baseline, await bad.capture(dir))
    expect(both.manifest_completeness).toBe('unavailable')
    expect(both.manifest_unavailable_reason).toBe('tree_malformed')
  })

  it('partial：可枚举的一侧照常比较，不可枚举的一侧给出不可判定条目', async () => {
    const dir = makeDir('bp-comp-partial-ranges-')
    initRepo(dir, { 'a.ts': 'A\n', 'b.ts': 'B\n' })
    const baseline = await engine.capture(dir)

    write(dir, 'b.ts', 'B\nchanged\n') // b.ts 双侧 status 可比
    const currentOk = await engine.capture(dir)
    const currentBroken = withTree(currentOk, {
      status: 'unavailable',
      error_code: 'output_limit',
      entries: []
    })

    // baseline 干净的 a.ts：current 侧 Tree 不可枚举 → 不可判定条目（不伪装无变化）
    const diff = await engine.compare(baseline, currentBroken)
    const a = fileOf(diff, 'a.ts')
    expect(a).toBeDefined()
    expect(a?.observation).toBe('unavailable')

    // 双侧 Tree 都完好时同一场景是正常的（对照）
    const diffOk = await engine.compare(baseline, currentOk)
    expect(diffOk.manifest_completeness).toBe('complete')
    expect(fileOf(diffOk, 'a.ts')).toBeUndefined() // a.ts 真的没变 → 无条目
    expect(fileOf(diffOk, 'b.ts')?.observation).toBe('changed') // status 路径照常比较
  })
})

// MARK: - 修复三：文件 Mode 变化（规格 §五）

describe('文件 mode 变化（修复三）', () => {
  function initWithMode(dir: string): void {
    initRepo(dir, { 'script.sh': '#!/bin/sh\necho hi\n', 'plain.txt': 'p\n' })
    git(['config', 'core.filemode', 'true'], dir) // 明确开启 mode 追踪（测试确定性）
  }

  it('1) 普通文件 chmod +x（未暂存）→ mode_changed + mode_only，origin=worktree', async () => {
    const dir = makeDir('bp-mode-chmod-')
    initWithMode(dir)
    const baseline = await engine.capture(dir)
    expect(baseline.head_tree.entries.find((e) => e.path === 'script.sh')?.mode).toBe('100644')

    chmodSync(join(dir, 'script.sh'), 0o755)
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'script.sh')
    expect(entry?.change_kind).toBe('mode_changed')
    expect(entry?.observation).toBe('changed')
    expect(entry?.status_origin).toBe('worktree')
    expect(entry?.mode_before).toBe('100644')
    expect(entry?.mode_after).toBe('100755')
    expect(entry?.artifact.kind).toBe('mode_only')
    if (entry?.artifact.kind === 'mode_only') {
      expect(entry.artifact.mode_before).toBe('100644')
      expect(entry.artifact.mode_after).toBe('100755')
    }
    // 内容没变：hash 相同、行数不可知（不伪造 0 行的“内容 Diff”）
    expect(entry?.content_hash_before).toBe(entry?.content_hash_after)
    expect(entry?.insertions).toBeNull()
    expect(diff.stats.mode_changed).toBe(1)
    // 内容相同的另一文件不受影响
    expect(fileOf(diff, 'plain.txt')).toBeUndefined()
  })

  it('2) mode 变化后 git add → origin=index', async () => {
    const dir = makeDir('bp-mode-add-')
    initWithMode(dir)
    const baseline = await engine.capture(dir)

    chmodSync(join(dir, 'script.sh'), 0o755)
    git(['add', 'script.sh'], dir)
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'script.sh')
    expect(entry?.change_kind).toBe('mode_changed')
    expect(entry?.status_origin).toBe('index')
    expect(entry?.mode_after).toBe('100755')
    expect(entry?.artifact.kind).toBe('mode_only')
  })

  it('3)+4) 仅提交 100644→100755 → origin=committed、内容相同、mode_only', async () => {
    const dir = makeDir('bp-mode-commit-up-')
    initWithMode(dir)
    const baseline = await engine.capture(dir)

    chmodSync(join(dir, 'script.sh'), 0o755)
    git(['add', '-A', '.'], dir)
    git(['commit', '-qm', 'chmod +x'], dir)
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'script.sh')
    expect(entry?.change_kind).toBe('mode_changed')
    expect(entry?.status_origin).toBe('committed')
    expect(entry?.mode_before).toBe('100644')
    expect(entry?.mode_after).toBe('100755')
    expect(entry?.artifact.kind).toBe('mode_only')
    // blob sha 相同（内容没变）但绝不能判成 confirmed_unchanged
    expect(entry?.observation).toBe('changed')
    expect(diff.stats.mode_changed).toBe(1)
  })

  it('5) 仅提交 100755→100644（反向）', async () => {
    const dir = makeDir('bp-mode-commit-down-')
    initRepo(dir, { 'script.sh': '#!/bin/sh\n' })
    git(['config', 'core.filemode', 'true'], dir)
    chmodSync(join(dir, 'script.sh'), 0o755)
    git(['add', '-A', '.'], dir)
    git(['commit', '-qm', 'exec first'], dir)
    const baseline = await engine.capture(dir)
    expect(baseline.head_tree.entries.find((e) => e.path === 'script.sh')?.mode).toBe('100755')

    chmodSync(join(dir, 'script.sh'), 0o644)
    git(['add', '-A', '.'], dir)
    git(['commit', '-qm', 'back to 644'], dir)
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'script.sh')
    expect(entry?.change_kind).toBe('mode_changed')
    expect(entry?.mode_before).toBe('100755')
    expect(entry?.mode_after).toBe('100644')
    expect(entry?.artifact.kind).toBe('mode_only')
  })

  it('6) 内容 hash 相同、只有 mode 变化 → 不产出内容 Diff 文本', async () => {
    const dir = makeDir('bp-mode-only-')
    initWithMode(dir)
    const baseline = await engine.capture(dir)
    chmodSync(join(dir, 'script.sh'), 0o755)
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'script.sh')
    expect(entry?.artifact.kind).not.toBe('diff')
    expect(entry?.content_hash_before).toBe(entry?.content_hash_after)
  })

  it('7) 文件↔symlink 类型变化优先于 mode_changed', async () => {
    const dir = makeDir('bp-mode-type-')
    initWithMode(dir)
    const baseline = await engine.capture(dir)

    rmSync(join(dir, 'script.sh'))
    symlinkSync('plain.txt', join(dir, 'script.sh'))
    const diff = await engine.compare(baseline, await engine.capture(dir))
    const entry = fileOf(diff, 'script.sh')
    // mode 确实不同（100644→120000），但类型变化必须赢
    expect(entry?.change_kind).toBe('type_changed')
    expect(entry?.change_kind).not.toBe('mode_changed')
    expect(entry?.mode_before).toBe('100644')
    expect(entry?.mode_after).toBe('120000')
  })

  it('8) 子模块 gitlink（160000）与不下钻策略兼容：不产生伪 mode_changed', async () => {
    const base = makeDir('bp-mode-gitlink-')
    const child = join(base, 'child')
    initRepo(child, { 'sub.txt': 'v1\n' })
    const parent = join(base, 'parent')
    initRepo(parent, { 'main.txt': 'm\n' })
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'kid'], parent)
    git(['commit', '-qm', 'add kid'], parent)

    const baseline = await engine.capture(parent)
    expect(baseline.head_tree.entries.find((e) => e.path === 'kid')?.mode).toBe('160000')

    write(join(parent, 'kid'), 'sub.txt', 'v2\n')
    git(['add', '-A', '.'], join(parent, 'kid'))
    git(['commit', '-qm', 'v2'], join(parent, 'kid'))
    const diff = await engine.compare(baseline, await engine.capture(parent))
    const kid = fileOf(diff, 'kid')
    expect(kid).toBeDefined()
    expect(kid?.change_kind).not.toBe('mode_changed')
    expect(kid?.mode_before).toBe('160000')
    expect(kid?.mode_after).toBe('160000')
    // 仍然不下钻
    expect(diff.files.every((f) => !f.repo_relative_path.startsWith('kid/'))).toBe(true)
  })
})

// MARK: - 修复四：Symlink 父级/文件替换竞态（规格 §六，确定性注入点）

describe('Symlink 路径竞态（修复四）', () => {
  it('打开文件前父级目录被替换成外部 symlink → 身份复核拒绝，绝不读外部内容', async () => {
    const outside = makeDir('bp-race-parent-out-')
    write(outside, 'f.txt', 'RACE_OUTSIDE_CONTENT\n')
    const dir = makeDir('bp-race-parent-')
    initRepo(dir, { 'sub/f.txt': 'inside\n' })
    write(dir, 'sub/f.txt', 'inside changed\n') // 让它进 status（触发读取）
    const baseline = await engine.capture(dir)

    let swapped = false
    const engine2 = new GitSnapshotEngine({
      hooks: {
        beforeFileOpen: (full) => {
          // 确定性注入：lstat/父级复核之后、open 之前，把父级换成外部链接
          if (!swapped && full.endsWith(`${sep}sub${sep}f.txt`)) {
            swapped = true
            rmSync(join(dir, 'sub'), { recursive: true, force: true })
            symlinkSync(outside, join(dir, 'sub'))
          }
        }
      }
    })
    const current = await engine2.capture(dir)
    expect(swapped, '注入点必须真的触发').toBe(true)

    const entry = snapOf(current, 'sub/f.txt')
    // 身份复核（ino/dev 不匹配）→ 按链接逃逸处理
    expect(entry?.unread_reason).toBe('symlink_escape')
    expect(entry?.worktree_hash).toBeNull()

    const diff = await engine.compare(baseline, current)
    expect(JSON.stringify(diff)).not.toContain('RACE_OUTSIDE_CONTENT')
    expect(JSON.stringify(diff)).not.toContain(outside)
    for (const file of diff.files) {
      if (file.repo_relative_path === 'sub/f.txt') {
        expect(file.artifact.kind).not.toBe('diff')
      }
    }
  })

  it('打开前最终文件被替换成外部 symlink → O_NOFOLLOW 拒绝（ELOOP），不读外部内容', async () => {
    const outside = makeDir('bp-race-file-out-')
    write(outside, 'x.txt', 'SWAPPED_FILE_CONTENT\n')
    const dir = makeDir('bp-race-file-')
    initRepo(dir, { 'target.txt': 'original\n' })
    write(dir, 'target.txt', 'original changed\n')
    const baseline = await engine.capture(dir)

    let swapped = false
    const engine2 = new GitSnapshotEngine({
      hooks: {
        beforeFileOpen: (full) => {
          if (!swapped && full.endsWith(`${sep}target.txt`)) {
            swapped = true
            rmSync(full)
            symlinkSync(join(outside, 'x.txt'), full)
          }
        }
      }
    })
    const current = await engine2.capture(dir)
    expect(swapped).toBe(true)

    const entry = snapOf(current, 'target.txt')
    expect(entry, '条目必须存在').toBeDefined()
    // 两条诚实路径之一：① 读取窗口内被换 → O_NOFOLLOW/ELOOP 拒绝（escape）；
    // ② 状态漂移触发重试后，文件已是 symlink → 按链接合法采集（readlink 不跟随）。
    // 任何路径都不得读取外部文件内容。
    const rejected = entry?.unread_reason === 'symlink_escape'
    const capturedAsLink = entry?.is_symlink === true
    expect(rejected || capturedAsLink, JSON.stringify(entry)).toBe(true)
    if (capturedAsLink) expect(entry?.worktree_hash).not.toBeNull()

    const diff = await engine.compare(baseline, current)
    expect(JSON.stringify(diff)).not.toContain('SWAPPED_FILE_CONTENT')
    expect(JSON.stringify(diff)).not.toContain(outside)
  })

  it('读取窗口内文件被修改（torn read）→ 拒绝采用撕裂内容，判定不可用', async () => {
    const dir = makeDir('bp-race-torn-')
    initRepo(dir, { 'torn.txt': 'first\n' })
    write(dir, 'torn.txt', 'dirty\n') // 先变脏：status1==status2（porcelain 不含内容哈希），
    const baseline = await engine.capture(dir) // 这样 torn 才能存活到最终快照

    const engine2 = new GitSnapshotEngine({
      hooks: {
        beforeFileOpen: (full) => {
          if (full.endsWith(`${sep}torn.txt`)) {
            // 在 lstat 与 fstat 之间改写：大小/mtime 必然漂移
            appendFileSync(full, 'more\n')
          }
        }
      }
    })
    const current = await engine2.capture(dir)

    const entry = snapOf(current, 'torn.txt')
    expect(entry?.unread_reason).toBe('torn_read')
    expect(entry?.worktree_hash).toBeNull()
    expect(entry?.baseline_content).toEqual({ kind: 'not_stored', reason: 'torn_read' })

    const diff = await engine.compare(baseline, current)
    const file = fileOf(diff, 'torn.txt')
    expect(file).toBeDefined()
    expect(file?.observation).toBe('unavailable')
    expect(file?.insertions).toBeNull()
  })
})

// MARK: - 修复五：采集期间 Index / Status 漂移（规格 §七）

describe('采集一致性核验（修复五）', () => {
  it('采集期间 Index 变化（git add）→ 收尾核验发现 → 重试一次后成功', async () => {
    const dir = makeDir('bp-stable-index-')
    initRepo(dir, { 'a.ts': 'A\n' })
    write(dir, 'staged.txt', 'soon\n') // status1 视角：untracked
    const baseline = await engine.capture(dir)

    let added = false
    const engine2 = new GitSnapshotEngine({
      hooks: {
        beforeFinalize: () => {
          if (!added) {
            added = true
            git(['add', 'staged.txt'], dir) // 收尾前 index 漂移
          }
        }
      }
    })
    const current = await engine2.capture(dir)
    expect(added).toBe(true)
    expect(current.capture_status).toBe('ok')
    // 重试后的快照反映 add 之后的状态（staged 而非 untracked）
    expect(snapOf(current, 'staged.txt')?.index_status).toBe('A')
    expect(snapOf(current, 'staged.txt')?.untracked).toBe(false)
    // 首次基线是 untracked 视角 → 对照仍然正确
    const diff = await engine.compare(baseline, current)
    expect(diff.status).toBe('ok')
  })

  it('采集期间 Status 每次都漂移（不断新增文件）→ 两次尝试都不稳定 → snapshot_unstable', async () => {
    const dir = makeDir('bp-stable-status-')
    initRepo(dir, { 'a.ts': 'A\n' })
    let created = 0
    const engine2 = new GitSnapshotEngine({
      hooks: {
        beforeFinalize: () => {
          created += 1
          write(dir, `drift-${created}.txt`, 'x') // 每次收尾都让 status 变化
        }
      }
    })

    const snapshot = await engine2.capture(dir)
    expect(created).toBeGreaterThanOrEqual(2) // 两次尝试都走到收尾核验
    expect(snapshot.capture_status).toBe('error')
    expect(snapshot.error_code).toBe('snapshot_unstable')
  })

  it('正常采集（无并发动作）在双重核验下仍然成功——核验不误伤', async () => {
    const dir = makeDir('bp-stable-ok-')
    initRepo(dir, { 'a.ts': 'A\n' })
    write(dir, 'dirty.txt', 'd\n')
    const snapshot = await engine.capture(dir)
    expect(snapshot.capture_status).toBe('ok')
    expect(snapshot.files.some((f) => f.repo_relative_path === 'dirty.txt')).toBe(true)
  })
})


// MARK: - 修复一：完整读取窗口 T1–T8（规格 §三 A–H）

describe('文件读取窗口完整性（规格 §三）', () => {
  /** 建仓并让目标文件先变脏：status1==status2，注入不会被「状态漂移重试」掩盖。 */
  function dirtyRepo(prefix: string, committed: string, dirty: string): string {
    const dir = makeDir(prefix)
    initRepo(dir, { 'target.txt': committed })
    write(dir, 'target.txt', dirty)
    return dir
  }
  const isTarget = (full: string): boolean => full.endsWith(`${sep}target.txt`)

  it('A) open 前（T1 之后）内容被同尺寸改写 → torn_read（mtime/ctime 证据）', async () => {
    const dir = dirtyRepo('bp-window-a-', 'committed\n', 'aaaa\n')
    const baseline = await engine.capture(dir)
    expect(snapOf(baseline, 'target.txt')?.worktree_hash).toBeTruthy()

    const engine2 = new GitSnapshotEngine({
      hooks: {
        beforeFileOpen: (full) => {
          if (isTarget(full)) writeFileSync(full, 'bbbb\n') // 同尺寸：size 证据失效
        }
      }
    })
    const current = await engine2.capture(dir)
    const entry = snapOf(current, 'target.txt')
    expect(entry?.unread_reason).toBe('torn_read')
    expect(entry?.worktree_hash).toBeNull() // 撕裂内容绝不产生 hash
    expect(entry?.baseline_content).toEqual({ kind: 'not_stored', reason: 'torn_read' })

    const diff = await engine.compare(baseline, current)
    const file = fileOf(diff, 'target.txt')
    expect(file?.observation).toBe('unavailable')
    expect(file?.insertions).toBeNull()
  })

  it('B) open 后、读取前文件被替换（新 inode）→ 路径复核拒绝', async () => {
    const dir = dirtyRepo('bp-window-b-', 'committed\n', 'original dirty\n')
    const baseline = await engine.capture(dir)

    const engine2 = new GitSnapshotEngine({
      hooks: {
        afterFileOpen: (full) => {
          if (isTarget(full)) {
            rmSync(full)
            writeFileSync(full, 'REPLACED_AFTER_OPEN\n')
          }
        }
      }
    })
    const current = await engine2.capture(dir)
    const entry = snapOf(current, 'target.txt')
    expect(entry?.unread_reason).toBe('torn_read')
    expect(entry?.worktree_hash).toBeNull()

    const diff = await engine.compare(baseline, current)
    expect(JSON.stringify(diff)).not.toContain('REPLACED_AFTER_OPEN')
    expect(fileOf(diff, 'target.txt')?.observation).toBe('unavailable')
  })

  it('C) 读取第一段后追加内容 → T7 尺寸漂移 → torn_read', async () => {
    const dir = dirtyRepo('bp-window-c-', 'committed\n', 'x'.repeat(9000) + '\n')
    const baseline = await engine.capture(dir)

    const engine2 = new GitSnapshotEngine({
      hooks: {
        afterFirstChunkRead: (full) => {
          if (isTarget(full)) appendFileSync(full, 'appended-during-read\n')
        }
      }
    })
    const current = await engine2.capture(dir)
    const entry = snapOf(current, 'target.txt')
    expect(entry?.unread_reason).toBe('torn_read')
    expect(entry?.worktree_hash).toBeNull()
  })

  it('D) 读取第一段后截断文件 → bytesRead 与预期不符 → torn_read', async () => {
    const dir = dirtyRepo('bp-window-d-', 'committed\n', 'y'.repeat(9000) + '\n')
    const baseline = await engine.capture(dir)

    const engine2 = new GitSnapshotEngine({
      hooks: {
        afterFirstChunkRead: (full) => {
          if (isTarget(full)) truncateSync(full, 100)
        }
      }
    })
    const current = await engine2.capture(dir)
    const entry = snapOf(current, 'target.txt')
    expect(entry?.unread_reason).toBe('torn_read')
    expect(entry?.worktree_hash).toBeNull()
  })

  it('E) 读取期间同尺寸内容改写 → mtimeNs/ctimeNs 漂移 → torn_read', async () => {
    const dir = dirtyRepo('bp-window-e-', 'committed\n', 'a'.repeat(5000))
    const baseline = await engine.capture(dir)

    const engine2 = new GitSnapshotEngine({
      hooks: {
        afterFirstChunkRead: (full) => {
          if (isTarget(full)) writeFileSync(full, 'b'.repeat(5000)) // 同字节数
        }
      }
    })
    const current = await engine2.capture(dir)
    const entry = snapOf(current, 'target.txt')
    expect(entry?.unread_reason).toBe('torn_read')
    expect(entry?.worktree_hash).toBeNull()
  })

  it('F) 读取期间 mtime 被拨动（内容不变）→ 时间元数据漂移 → torn_read', async () => {
    const dir = dirtyRepo('bp-window-f-', 'committed\n', 'stable content\n')
    const baseline = await engine.capture(dir)

    const engine2 = new GitSnapshotEngine({
      hooks: {
        afterFirstChunkRead: (full) => {
          if (isTarget(full)) {
            const epoch = new Date(0)
            utimesSync(full, epoch, epoch) // 只动时间：不能只凭内容相同就放行
          }
        }
      }
    })
    const current = await engine2.capture(dir)
    const entry = snapOf(current, 'target.txt')
    expect(entry?.unread_reason).toBe('torn_read')
    expect(entry?.worktree_hash).toBeNull()
  })

  it('G) 读取窗口内文件保持稳定 → 正常读取（注入点触发但不修改）', async () => {
    const dir = dirtyRepo('bp-window-g-', 'committed\n', 'stable-after-hook\n')
    let hookFired = 0
    const engine2 = new GitSnapshotEngine({
      hooks: {
        afterFirstChunkRead: () => {
          hookFired += 1 // 只观察，不修改
        }
      }
    })
    const current = await engine2.capture(dir)
    expect(hookFired).toBe(1) // 注入点确实覆盖了读取期间
    const entry = snapOf(current, 'target.txt')
    expect(entry?.unread_reason).toBeNull()
    expect(entry?.worktree_hash).toBe(sha256Hex(Buffer.from('stable-after-hook\n')))
  })

  it('H) 读取异常时 FileHandle 一定被关闭（finally 保证）', async () => {
    const dir = dirtyRepo('bp-window-h-', 'committed\n', 'z'.repeat(9000) + '\n')
    let captured: unknown = null
    let fdDuringRead: number | undefined
    const engine2 = new GitSnapshotEngine({
      hooks: {
        afterFirstChunkRead: (full, handle) => {
          if (isTarget(full)) {
            captured = handle
            fdDuringRead = (handle as { fd?: number }).fd
            truncateSync(full, 10) // 制造读取中异常
          }
        }
      }
    })
    const current = await engine2.capture(dir)
    expect(captured, '必须拿到读取句柄').not.toBeNull()
    expect(snapOf(current, 'target.txt')?.unread_reason).toBe('torn_read')
    // 读取期间句柄是打开的（fd ≥ 0）；异常路径走 finally 后 fd 置 -1 = 已关闭
    expect(fdDuringRead).toBeGreaterThanOrEqual(0)
    expect((captured as { fd?: number }).fd).toBe(-1)
  })
})

// MARK: - 修复三：malformed Tree 下的路径存在性（规格 §五）

describe('malformed Tree 的路径存在性（规格 §五）', () => {
  /** 把指定路径的 ls-tree 记录替换成坏记录（该路径因此解析不出来）。 */
  function damagingRunner(watchPath: string): typeof runGit {
    return async (root, sub, args, opts) => {
      const result = await runGit(root, sub, args, opts)
      if (sub === 'ls-tree') {
        const sep0 = String.fromCharCode(0)
        const text = result.text
          .split(sep0)
          .map((record) => (record.endsWith(`\t${watchPath}`) ? 'BROKEN-RECORD' : record))
          .join(sep0)
        return { ...result, text, stdout: Buffer.from(text, 'utf8') }
      }
      return result
    }
  }

  it('A) baseline 侧目标路径未解析出来 → unavailable，绝不是 added', async () => {
    const dir = makeDir('bp-mal-a-')
    initRepo(dir, { 'watched.ts': 'W\n', 'other.ts': 'O\n' })
    const bad = new GitSnapshotEngine({ runner: damagingRunner('watched.ts') })

    const baseline = await bad.capture(dir)
    expect(baseline.head_tree.malformed_records).toBe(1)
    expect(baseline.head_tree.entries.some((e) => e.path === 'watched.ts')).toBe(false)

    const current = await engine.capture(dir) // 完整 Tree，watched.ts 存在
    const diff = await engine.compare(baseline, current)
    const entry = fileOf(diff, 'watched.ts')
    expect(entry, '无法确认时必须给出条目').toBeDefined()
    expect(entry?.observation).toBe('unavailable')
    expect(entry?.change_kind).not.toBe('added')
    expect(entry?.insertions).toBeNull()
    expect(diff.manifest_completeness).toBe('partial')
  })

  it('B) current 侧目标路径未解析出来 → unavailable，绝不是 deleted', async () => {
    const dir = makeDir('bp-mal-b-')
    initRepo(dir, { 'watched.ts': 'W\n', 'other.ts': 'O\n' })
    const bad = new GitSnapshotEngine({ runner: damagingRunner('watched.ts') })

    const baseline = await engine.capture(dir) // 完整 Tree
    const current = await bad.capture(dir) // 损坏 Tree
    expect(current.head_tree.malformed_records).toBe(1)

    const diff = await engine.compare(baseline, current)
    const entry = fileOf(diff, 'watched.ts')
    expect(entry).toBeDefined()
    expect(entry?.observation).toBe('unavailable')
    expect(entry?.change_kind).not.toBe('deleted')
    expect(diff.manifest_completeness).toBe('partial')
  })

  it('F) 损坏一侧的**其它合法路径**照常比较（不作废整份清单）', async () => {
    const dir = makeDir('bp-mal-f-')
    initRepo(dir, { 'watched.ts': 'W\n', 'other.ts': 'O\n' })
    const bad = new GitSnapshotEngine({ runner: damagingRunner('other.ts') })

    const baseline = await bad.capture(dir) // other.ts 记录损坏，watched.ts 正常
    expect(baseline.head_tree.malformed_records).toBe(1)
    expect(baseline.head_tree.entries.some((e) => e.path === 'watched.ts')).toBe(true)

    write(dir, 'watched.ts', 'W\nchanged\n')
    git(['add', '-A', '.'], dir)
    git(['commit', '-qm', 'change watched'], dir)
    const diff = await engine.compare(baseline, await engine.capture(dir))

    // 合法路径：正常产出有效 Diff，而不是 unavailable
    const entry = fileOf(diff, 'watched.ts')
    expect(entry?.observation).toBe('changed')
    expect(entry?.artifact.kind).toBe('diff')
    if (entry?.artifact.kind === 'diff') {
      expect(entry.artifact.text).toContain('+changed')
    }
    expect(diff.manifest_completeness).toBe('partial') // 全局仍诚实降级
  })
})

// MARK: - 修复四：Symlink lstat/readlink 一致性（规格 §六）

describe('Symlink lstat/readlink 一致性（规格 §六）', () => {
  /** 已提交的链接 + 窗口内换目标（让链接在 current capture 时是脏的、会被读取）。 */
  async function linkFixture(prefix: string): Promise<{ dir: string; baseline: GitWorkspaceSnapshot }> {
    const dir = makeDir(prefix)
    initRepo(dir, { 'app.ts': 'x\n', 'g1.txt': 'one\n', 'g2.txt': 'two\n', 'g3.txt': 'three\n' })
    symlinkSync('g1.txt', join(dir, 'link.txt'))
    git(['add', '-A', '.'], dir)
    git(['commit', '-qm', 'link'], dir)
    const baseline = await engine.capture(dir)
    // 窗口：换目标 → current capture 时链接是脏的（status M，会触发 readlink）
    rmSync(join(dir, 'link.txt'))
    symlinkSync('g2.txt', join(dir, 'link.txt'))
    return { dir, baseline }
  }

  it('readlink 窗口前半被替换（before 钩子）→ torn_read，不采用本次 target', async () => {
    const { dir, baseline } = await linkFixture('bp-link-win-before-')
    const engine2 = new GitSnapshotEngine({
      hooks: {
        aroundReadlink: (full, phase) => {
          if (phase === 'before' && full.endsWith(`${sep}link.txt`)) {
            rmSync(full)
            symlinkSync('g3.txt', full) // lstat1 之后、readlink 之前换掉
          }
        }
      }
    })
    const current = await engine2.capture(dir)
    const entry = snapOf(current, 'link.txt')
    expect(entry?.unread_reason).toBe('torn_read')
    expect(entry?.worktree_hash).toBeNull() // 不采用被污染的 target

    const diff = await engine.compare(baseline, current)
    const file = fileOf(diff, 'link.txt')
    expect(file?.observation).toBe('unavailable')
    expect(file?.artifact.kind).not.toBe('diff')
  })

  it('readlink 窗口后半被替换（after 钩子）→ torn_read', async () => {
    const { dir, baseline } = await linkFixture('bp-link-win-after-')
    const engine2 = new GitSnapshotEngine({
      hooks: {
        aroundReadlink: (full, phase) => {
          if (phase === 'after' && full.endsWith(`${sep}link.txt`)) {
            rmSync(full)
            symlinkSync('g3.txt', full) // readlink 之后、lstat2 之前换掉
          }
        }
      }
    })
    const current = await engine2.capture(dir)
    const entry = snapOf(current, 'link.txt')
    expect(entry?.unread_reason).toBe('torn_read')
    expect(entry?.worktree_hash).toBeNull()

    const diff = await engine.compare(baseline, current)
    expect(fileOf(diff, 'link.txt')?.observation).toBe('unavailable')
  })

  it('窗口稳定时：链接目标字符串正常采集，且从不跟随读取目标内容', async () => {
    const { dir, baseline } = await linkFixture('bp-link-win-stable-')
    const current = await engine.capture(dir) // 不注入：g2 目标正常读取
    const entry = snapOf(current, 'link.txt')
    expect(entry?.is_symlink).toBe(true)
    expect(entry?.unread_reason).toBeNull()
    // 目标是相对路径字符串的 hash（g2.txt），不是目标文件内容（two）
    expect(entry?.worktree_hash).toBe(sha256Hex(Buffer.from('g2.txt')))

    const diff = await engine.compare(baseline, current)
    const file = fileOf(diff, 'link.txt')
    expect(file?.artifact.kind).toBe('symlink')
    if (file?.artifact.kind === 'symlink') {
      expect(file.artifact.target_before).toBe('g1.txt')
      expect(file.artifact.target_after).toBe('g2.txt')
    }
    // 目标文件的内容（one/two/three）绝不出现
    expect(JSON.stringify(diff)).not.toContain('two')
  })
})
