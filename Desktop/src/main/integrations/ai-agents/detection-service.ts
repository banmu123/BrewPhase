import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectCodex } from './adapters/codex-adapter'
import { detectWorkBuddy } from './adapters/workbuddy-adapter'
import type { AgentDetection, AgentWriteTarget } from './types'

/**
 * Agent 检测。
 *
 * 只查三类地方，绝不遍历用户磁盘：
 *   1. PATH 里的可执行文件（官方 CLI / 应用本体）；
 *   2. 官方文档确认的配置目录（~/.codex、~/.workbuddy）；
 *   3. 少量常见安装位置（仅作为"装了但没进 PATH"的补充证据）。
 *
 * 检测结论要分开表达：装了没有 / 配置在哪 / 能不能写。
 * 「~/.codex 存在」不等于「Codex 装了」，更不等于「能连上」。
 */

const CODE_PATH_NAMES = ['codex']
const WORKBUDDY_PATH_NAMES =
  process.platform === 'win32'
    ? ['workbuddy', 'WorkBuddy']
    : ['workbuddy', 'WorkBuddy', 'work buddy']

/** 已知安装位置：只用于补充判断，找不到也不影响配置能力。 */
function knownInstallCandidates(): Record<'workbuddy', string[]> {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    const programFiles = process.env.ProgramFiles
    if (local) candidates.push(join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'))
    if (programFiles) candidates.push(join(programFiles, 'WorkBuddy', 'WorkBuddy.exe'))
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/WorkBuddy.app')
  }
  return { workbuddy: candidates }
}

function findInPath(names: string[]): string | null {
  const raw = process.env.PATH ?? ''
  if (raw.length === 0) return null
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions =
    process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']

  for (const dir of raw.split(separator)) {
    if (dir.trim().length === 0) continue
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = join(dir, `${name}${extension}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

function findWorkBuddyExecutable(): string | null {
  const fromPath = findInPath(WORKBUDDY_PATH_NAMES)
  if (fromPath) return fromPath
  for (const candidate of knownInstallCandidates().workbuddy) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Agent 配置所在的 home。
 *
 * 默认就是用户真实 home；`BREWPHASE_AGENT_HOME` 只给测试用——E2E 必须能在
 * 不碰开发者真实 `~/.codex`、`~/.workbuddy` 的前提下验证写入。
 * 不用改 HOME/USERPROFILE，那会让 Electron 自己找不到 appData。
 */
export function agentHome(): string {
  const override = process.env.BREWPHASE_AGENT_HOME?.trim()
  return override && override.length > 0 ? override : homedir()
}

/** 一次返回两个 Agent 的检测结果；顺序固定，UI 不必自己排。 */
export function detectAgents(
  target: AgentWriteTarget | null,
  homeDir: string = agentHome()
): AgentDetection[] {
  return [
    detectWorkBuddy(findWorkBuddyExecutable(), target, homeDir),
    detectCodex(findInPath(CODE_PATH_NAMES), target, homeDir)
  ]
}

/** 单个 Agent 的检测，供 config-service 在写入前复核。 */
export function detectAgent(
  kind: 'workbuddy' | 'codex',
  target: AgentWriteTarget | null,
  homeDir: string = agentHome()
): AgentDetection {
  const all = detectAgents(target, homeDir)
  const found = all.find((item) => item.kind === kind)
  if (!found) throw new Error(`unknown agent kind: ${kind}`)
  return found
}
