/**
 * 只读 Git 命令执行封装（R6-4.3.2 §四）。
 *
 * 安全策略（每条都有对应测试）：
 *
 * 1. **execFile + 参数数组**：全程无 shell（禁 `exec`/`execSync`），
 *    路径与文件名永远是数组元素，不进命令字符串；
 * 2. **子命令白名单**：`runGit` 只接受 §4.3 的只读命令，白名单外直接抛
 *    `command_not_allowed`——即便未来调用方写错也不会跑到写命令；
 * 3. **受控环境**：继承环境里**所有 `GIT_*` 变量一律清空**（`GIT_DIR`、
 *    `GIT_EXTERNAL_DIFF`、`GIT_CONFIG_PARAMETERS`…），再注入明确需要的三个：
 *    - `GIT_OPTIONAL_LOCKS=0`：status/diff 不刷新索引 → **不产生任何写锁**；
 *    - `GIT_TERMINAL_PROMPT=0`：绝不弹凭据对话框；
 *    - `GIT_CONFIG_NOSYSTEM=1`：忽略系统级 gitconfig（**仅 POSIX**；Windows
 *      例外及原因见 `buildGitEnv` 注释——系统 config 承载 autocrlf 等落盘语义）。
 * 4. **仓库配置防触发**：每条命令统一加 `--no-pager`、`--literal-pathspecs`
 *    （文件名里的 `*`、`:(…)` 等 pathspec 魔法按字面处理，§4.4）与
 *    `-c core.fsmonitor=false`（仓库/用户配置里的 fsmonitor 钩子不会被拉起）。
 *    **本引擎不执行 `git diff`**——窗口 Diff 在内存内生成（见
 *    `git-snapshot-utils.ts`），因此 §4.2 的 `--no-ext-diff` / `--no-textconv`
 *    通过「根本不运行 diff」满足；若未来引入 diff，必须先加入白名单并强制
 *    这三个旗标（`buildGitArgv` 是唯一 argv 构造点）；
 * 5. **超时与输出上限**：默认 5s / 16MB，均可通过 options 注入（测试用）；
 * 6. **结构化错误**：git 不存在 / 超时 / 权限 / 输出超限 / 非零退出各有
 *    错误码；消息自行拼装——首行截断 200 字、工作区根与家目录替换为
 *    占位符，**不含绝对路径与环境变量**；失败绝不返回「看似成功的空结果」。
 */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import type { GitErrorCode } from './git-snapshot-types'
import { GIT_COMMAND_MAX_OUTPUT_BYTES, GIT_SNAPSHOT_TIMEOUT_MS } from './git-snapshot-types'

/** §4.3 只读白名单（实际使用 6 条；`diff` 见文件头第 4 点）。 */
export const ALLOWED_GIT_COMMANDS: ReadonlySet<string> = new Set([
  'rev-parse',
  'symbolic-ref',
  'status',
  'ls-files',
  'ls-tree',
  'cat-file'
])

export type GitAllowedCommand =
  | 'rev-parse'
  | 'symbolic-ref'
  | 'status'
  | 'ls-files'
  | 'ls-tree'
  | 'cat-file'

/** 结构化错误：`gitError` 是给上层分支用的，message 只给人看（已脱敏）。 */
export class GitCommandError extends Error {
  constructor(
    readonly gitError: GitErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'GitCommandError'
  }
}

export type GitRunOptions = {
  /** 单条命令超时（默认 5s；测试注入更小值）。 */
  timeoutMs?: number
  /** stdout+stderr 合计上限（默认 16MB）。 */
  maxOutputBytes?: number
  /** git 可执行文件（默认 `git`；测试注入不存在的路径）。 */
  gitPath?: string
}

export type GitRunResult = {
  stdout: Buffer
  /** stdout 的 UTF-8 解码；`-z` 流的记录分隔符是 U+0000，按它切分安全。 */
  text: string
  stderr: string
}

/** NUL 分隔符（用 fromCharCode 写，避免源码里出现字面控制字符）。 */
const NUL = String.fromCharCode(0)

/**
 * 构造最终 argv（导出以便单测直接断言安全旗标）。
 * `-c core.fsmonitor=false` 对所有子命令无害；diff 的强制旗标必须在
 * `diff` **之后**（它们是 diff 的参数）。
 */
export function buildGitArgv(subcommand: GitAllowedCommand, args: readonly string[]): string[] {
  for (const arg of args) {
    if (arg.includes(NUL)) {
      throw new GitCommandError('invalid_argument', 'git argument must not contain NUL')
    }
  }
  const argv = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', subcommand]
  argv.push(...args)
  return argv
}

/**
 * 受控环境：清掉继承的全部 `GIT_*`，再注入白名单变量。
 * 其余（PATH、HOME、LANG…）原样保留——git 需要它们，且它们不是 git 的
 * 命令注入面。
 *
 * **Windows 例外（实测）**：不设 `GIT_CONFIG_NOSYSTEM`。Git for Windows 把
 * `core.autocrlf`（文件**落盘形态**的转换设置）放在系统级 config 里；禁掉
 * 系统 config 后 autocrlf 回落到 false，工作区里按 CRLF 落盘的文件与 index
 * 里的 LF blob 不再等值，git 会把干净的工作区（乃至干净的 submodule）报成
 * `modified`（porcelain v2 出现 `1 .M` / `S.M.`），快照出现幽灵变更。
 * 系统 config 里真正有注入风险的项已被显式覆盖：`core.fsmonitor=false`
 * （防外部钩子进程）、`--no-pager`（防 pager 启动）。alias 只影响高层命令名，
 * 引擎只调用底层的 ls-files/status/rev-parse 等。
 */
export function buildGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('GIT_')) continue
    env[key] = value
  }
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  // POSIX 上系统级 config 基本为空，隔离它是纯收益；Windows 上它会改变
  // 「工作区文件 vs index」的判定语义（见上），保留才是与平台一致的行为。
  if (process.platform !== 'win32') env.GIT_CONFIG_NOSYSTEM = '1'
  return env
}

/** 消息脱敏：首行、200 字截断、工作区根与家目录换成占位符。 */
function sanitizeGitMessage(stderr: Buffer | string, rootPath: string): string {
  const raw = typeof stderr === 'string' ? stderr : stderr.toString('utf8')
  const firstLine = raw.split('\n', 1)[0] ?? ''
  const clipped = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
  let out = clipped
  if (rootPath) out = out.split(rootPath).join('<workspace>')
  try {
    const home = homedir()
    if (home) out = out.split(home).join('<home>')
  } catch {
    // 拿不到家目录就算了——不影响正确性
  }
  return out || 'git command failed'
}

function translateError(error: unknown, rootPath: string): GitCommandError {
  const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
  if (err.code === 'ENOENT') {
    return new GitCommandError('git_not_found', 'git executable was not found')
  }
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return new GitCommandError('permission_denied', 'git executable is not permitted to run')
  }
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new GitCommandError('output_limit', 'git output exceeded the size limit')
  }
  if (err.killed && (err.signal === 'SIGTERM' || err.signal === 'SIGKILL')) {
    return new GitCommandError('git_timeout', 'git command timed out')
  }
  // git 非零退出：消息脱敏（execFile 的 message 首行就是命令失败摘要）
  const detail = typeof err.message === 'string' ? err.message : ''
  return new GitCommandError('git_failed', sanitizeGitMessage(detail, rootPath))
}

/**
 * 执行一条只读 git 命令。成功返回原始 stdout（Buffer）+ UTF-8 文本；
 * 失败一律抛 `GitCommandError`——**不存在「失败但看起来成功」的返回形态**。
 */
export async function runGit(
  rootPath: string,
  subcommand: GitAllowedCommand,
  args: readonly string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  if (!ALLOWED_GIT_COMMANDS.has(subcommand)) {
    throw new GitCommandError('command_not_allowed', `git command "${subcommand}" is not allowed`)
  }
  const argv = buildGitArgv(subcommand, args)
  const gitPath = options.gitPath ?? 'git'
  const timeoutMs = options.timeoutMs ?? GIT_SNAPSHOT_TIMEOUT_MS
  const maxBuffer = options.maxOutputBytes ?? GIT_COMMAND_MAX_OUTPUT_BYTES

  try {
    const { stdout, stderr } = await new Promise<{ stdout: Buffer; stderr: Buffer }>(
      (resolve, reject) => {
        execFile(
          gitPath,
          argv,
          {
            cwd: rootPath,
            timeout: timeoutMs,
            maxBuffer,
            encoding: 'buffer',
            env: buildGitEnv(),
            windowsHide: true
          },
          (error, out, errOut) => {
            if (error) reject(error)
            else resolve({ stdout: out, stderr: errOut })
          }
        )
      }
    )
    return { stdout, text: stdout.toString('utf8'), stderr: stderr.toString('utf8') }
  } catch (error) {
    throw translateError(error, rootPath)
  }
}

/**
 * 结构性失败（环境问题）与「仓库层面的正常失败」（如对象不存在、
 * detached HEAD）区分开：后者允许调用方降级处理，前者必须向上抛。
 */
export function isStructuralGitError(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false
  return (
    error.gitError === 'git_not_found' ||
    error.gitError === 'git_timeout' ||
    error.gitError === 'output_limit' ||
    error.gitError === 'permission_denied' ||
    error.gitError === 'command_not_allowed' ||
    error.gitError === 'invalid_argument'
  )
}
