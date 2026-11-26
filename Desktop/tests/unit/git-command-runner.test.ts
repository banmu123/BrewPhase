import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_GIT_COMMANDS,
  buildGitArgv,
  buildGitEnv,
  GitCommandError,
  runGit
} from '../../src/main/application/agent-journey/git-command-runner'

/**
 * 只读命令执行封装的安全边界（R6-4.3.2 §四）：
 * 白名单、argv 安全旗标、受控环境、结构化错误与消息脱敏。
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bp-git-runner-'))
  dirs.push(dir)
  return dir
}

describe('只读白名单（§4.3）', () => {
  it('白名单恰为 6 条只读命令', () => {
    expect([...ALLOWED_GIT_COMMANDS].sort()).toEqual([
      'cat-file',
      'ls-files',
      'ls-tree',
      'rev-parse',
      'status',
      'symbolic-ref'
    ])
  })

  it('所有写命令一律被拒（command_not_allowed，命令根本不会执行）', async () => {
    const dir = tempDir()
    const writeCommands = [
      'checkout',
      'reset',
      'clean',
      'stash',
      'add',
      'commit',
      'update-index',
      'fetch',
      'pull',
      'push',
      'submodule',
      'merge',
      'rebase'
    ]
    for (const command of writeCommands) {
      await expect(
        runGit(dir, command as never, ['HEAD']),
        `${command} 必须被拒绝`
      ).rejects.toMatchObject({ gitError: 'command_not_allowed' })
    }
  })
})

describe('argv 安全（§4.1/§4.2/§4.4）', () => {
  it('统一携带 --no-pager、--literal-pathspecs、-c core.fsmonitor=false', () => {
    const argv = buildGitArgv('status', ['--porcelain=v2', '-z'])
    expect(argv[0]).toBe('--no-pager')
    expect(argv).toContain('--literal-pathspecs')
    const cIndex = argv.indexOf('-c')
    expect(cIndex).toBeGreaterThan(-1)
    expect(argv[cIndex + 1]).toBe('core.fsmonitor=false')
    expect(argv).toContain('status')
    expect(argv).toContain('--porcelain=v2')
  })

  it('参数含 NUL 一律拒绝（无法经 execFile 安全传递）', () => {
    const nul = String.fromCharCode(0)
    expect(() => buildGitArgv('status', [`bad${nul}path`])).toThrow(GitCommandError)
    try {
      buildGitArgv('status', [`bad${nul}path`])
    } catch (error) {
      expect((error as GitCommandError).gitError).toBe('invalid_argument')
    }
  })

  it('路径以数组元素传递，绝不进 shell 字符串（含空格/引号/分号的参数原样保留）', () => {
    const tricky = 'a b; rm -rf /; $(whoami) "quoted"'
    const argv = buildGitArgv('ls-tree', ['-z', 'HEAD', '--', tricky])
    expect(argv[argv.length - 1]).toBe(tricky)
    expect(argv.some((part) => part.includes('&&'))).toBe(false)
  })
})

describe('受控环境（§4.2）', () => {
  it('清空继承的全部 GIT_*，保留非 GIT_ 变量', () => {
    const env = buildGitEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      GIT_DIR: '/evil/gitdir',
      GIT_WORK_TREE: '/evil/worktree',
      GIT_EXTERNAL_DIFF: '/evil/diff',
      GIT_CONFIG_PARAMETERS: 'core.evil=true',
      GIT_CONFIG_COUNT: '1'
    })
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined()
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
  })

  it('注入三个受控变量', () => {
    const env = buildGitEnv({})
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
  })
})

describe('结构化错误（§4.1）', () => {
  it('git 不存在 → git_not_found', async () => {
    const dir = tempDir()
    await expect(
      runGit(dir, 'rev-parse', ['--is-inside-work-tree'], { gitPath: '/no/such/git-binary' })
    ).rejects.toMatchObject({ gitError: 'git_not_found' })
  })

  it('git 非零退出 → git_failed；消息不含工作区绝对路径且有长度上限', async () => {
    const dir = tempDir()
    // 坏掉的 .git 文件：git 会报错，部分版本的 stderr 会回显路径
    writeFileSync(join(dir, '.git'), 'this is not a valid gitfile\\n')
    try {
      await runGit(dir, 'rev-parse', ['--is-inside-work-tree'])
      throw new Error('expected git_failed')
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError)
      const gitError = error as GitCommandError
      expect(gitError.gitError).toBe('git_failed')
      expect(gitError.message).not.toContain(dir)
      expect(gitError.message.length).toBeLessThanOrEqual(201)
    }
  })

  it('真实仓库里 rev-parse 正常返回', async () => {
    const dir = tempDir()
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const result = await runGit(dir, 'rev-parse', ['--is-inside-work-tree'])
    expect(result.text.trim()).toBe('true')
    expect(result.stdout.length).toBeGreaterThan(0)
  })
})
