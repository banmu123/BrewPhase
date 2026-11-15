import { promises as fsp } from 'node:fs'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Db } from '../../database/client'
import { selectWorkspace } from '../../database/repositories/local-workspaces'
import {
  WORKSPACE_LIST_LIMIT,
  WORKSPACE_SEARCH_LIMIT,
  WORKSPACE_SEARCH_MAX_DEPTH,
  WORKSPACE_SEARCH_MAX_FILES,
  WORKSPACE_FILE_MAX_BYTES,
  WORKSPACE_FILE_MAX_CHARS,
  type WorkspaceFileContent,
  type WorkspaceFileEntry,
  type WorkspaceFileListing,
  type WorkspaceSearchResult
} from '../../../shared/contracts/local-workspace'
import { ApplicationError } from '../errors'

/**
 * WorkspaceFileService：本地工作区的**只读**文件访问（Phase 1）。
 *
 * 三条铁律：
 * 1. 只接受 `workspaceId + POSIX 相对路径`——渲染层传不进任意绝对路径；
 * 2. 一切访问先 realpath 解析真实路径，再与工作区真实根比对——`..` 穿越
 *    与符号链接逃逸在同一个检查里被拦下；
 * 3. 只读：没有任何写文件 / 执行 / 删除的口子。
 *
 * 忽略与敏感规则可扩展：常量集中在一处（供测试直接引用），后续按需追加。
 */

/** 目录遍历时跳过的目录名（构建产物 / 版本库 / 依赖）。 */
export const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'vendor'
])

/** 敏感文件：列表阶段就不显示，读取阶段也拒绝（双保险）。 */
export const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa(\..*)?$/i,
  /^id_ed25519(\..*)?$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)$/i
]

/** 文本扩展名白名单（进入上下文 / 读取的候选）。 */
export const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.txt',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.yml', '.yaml', '.toml',
  '.ini', '.cfg', '.conf', '.swift', '.kt', '.kts', '.java', '.py', '.rb',
  '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash',
  '.zsh', '.sql', '.graphql', '.vue', '.svelte', '.astro', '.dart', '.scala',
  '.gitignore', '.editorconfig', '.npmrc', '.prettierrc', '.eslintrc',
  '.babelrc', '.lock', '.csv', '.svg'
])

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip',
  '.gz', '.tar', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.webm',
  '.wav', '.flac', '.sqlite', '.db', '.class', '.jar', '.node', '.wasm',
  '.icns', '.pak', '.dat'
])

export class WorkspaceFileError extends ApplicationError {
  constructor(
    code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'PERMISSION_DENIED',
    message: string
  ) {
    super(code, message)
    this.name = 'WorkspaceFileError'
  }
}

export class WorkspaceFileService {
  constructor(private readonly db: Db) {}

  // MARK: - 列目录

  /** 按目录读取（不递归整棵树）：忽略规则 + 条目上限。 */
  async listFiles(workspaceId: string, relativePath: string): Promise<WorkspaceFileListing> {
    const root = this.rootOf(workspaceId)
    const dirReal = this.resolveInside(root, relativePath, { mustBeDirectory: true })
    const rawEntries = await fsp.readdir(dirReal, { withFileTypes: true })

    const entries: WorkspaceFileEntry[] = []
    let truncated = false
    for (const item of rawEntries) {
      if (entries.length >= WORKSPACE_LIST_LIMIT) {
        truncated = true
        break
      }
      if (item.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(item.name)) continue
        entries.push({
          name: item.name,
          relativePath: joinRelative(relativePath, item.name),
          kind: 'directory',
          size: 0,
          readable: false,
          oversize: false
        })
        continue
      }
      if (!item.isFile() && !item.isSymbolicLink()) continue
      if (isSensitiveName(item.name)) continue
      const entry = await this.statEntry(dirReal, relativePath, item.name)
      if (entry) entries.push(entry)
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return { workspaceId, relativePath, entries, truncated }
  }

  // MARK: - 读文件

  async readFile(workspaceId: string, relativePath: string): Promise<WorkspaceFileContent> {
    const root = this.rootOf(workspaceId)
    const real = this.resolveInside(root, relativePath, { mustBeDirectory: false })
    const name = path.basename(real)
    if (isSensitiveName(name)) {
      throw new WorkspaceFileError('PERMISSION_DENIED', '敏感文件不参与上下文')
    }
    const ext = path.extname(name).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) {
      throw new WorkspaceFileError('VALIDATION_ERROR', '二进制文件不作为文本上下文读取')
    }
    if (!isTextCandidate(ext)) {
      throw new WorkspaceFileError('VALIDATION_ERROR', '不支持的文件类型')
    }
    const stat = await fsp.stat(real)
    if (!stat.isFile()) {
      throw new WorkspaceFileError('VALIDATION_ERROR', '目标不是文件')
    }
    if (stat.size > WORKSPACE_FILE_MAX_BYTES) {
      throw new WorkspaceFileError(
        'VALIDATION_ERROR',
        `文件超过大小限制（${Math.round(WORKSPACE_FILE_MAX_BYTES / 1024)} KB）`
      )
    }
    const buffer = await fsp.readFile(real)
    // NUL 字节是二进制内容的可靠特征（文本文件不该有）；扩展名漏网时兜底。
    if (buffer.includes(0)) {
      throw new WorkspaceFileError('VALIDATION_ERROR', '二进制文件不作为文本上下文读取')
    }
    const full = buffer.toString('utf-8')
    const totalCharacters = full.length
    const truncated = totalCharacters > WORKSPACE_FILE_MAX_CHARS
    return {
      workspaceId,
      relativePath,
      content: truncated ? full.slice(0, WORKSPACE_FILE_MAX_CHARS) : full,
      truncated,
      totalCharacters
    }
  }

  // MARK: - 文件名搜索

  /**
   * 文件名包含匹配（大小写不敏感）。遵守忽略规则；遍历深度与文件数都有
   * 上限，超限时结果标记 incomplete（不是全量扫描的承诺）。
   */
  async searchFiles(workspaceId: string, rawQuery: string): Promise<WorkspaceSearchResult> {
    const query = rawQuery.trim().toLowerCase()
    if (!query) throw new WorkspaceFileError('VALIDATION_ERROR', '搜索词不能为空')
    const root = this.rootOf(workspaceId)
    const entries: WorkspaceFileEntry[] = []
    let visited = 0
    let incomplete = false

    const walk = async (dirReal: string, rel: string, depth: number): Promise<void> => {
      if (entries.length >= WORKSPACE_SEARCH_LIMIT) return
      if (visited >= WORKSPACE_SEARCH_MAX_FILES) {
        incomplete = true
        return
      }
      if (depth > WORKSPACE_SEARCH_MAX_DEPTH) return
      let dirents
      try {
        dirents = await fsp.readdir(dirReal, { withFileTypes: true })
      } catch {
        return // 无权限 / 已消失：跳过，不把错误冒泡给用户。
      }
      for (const item of dirents) {
        if (entries.length >= WORKSPACE_SEARCH_LIMIT) return
        if (visited >= WORKSPACE_SEARCH_MAX_FILES) {
          incomplete = true
          return
        }
        if (item.isDirectory()) {
          if (IGNORED_DIRECTORY_NAMES.has(item.name)) continue
          visited += 1
          await walk(path.join(dirReal, item.name), joinRelative(rel, item.name), depth + 1)
          continue
        }
        if (!item.isFile() && !item.isSymbolicLink()) continue
        visited += 1
        if (isSensitiveName(item.name)) continue
        if (!item.name.toLowerCase().includes(query)) continue
        const entry = await this.statEntry(dirReal, rel, item.name)
        if (entry) entries.push(entry)
      }
    }

    await walk(root, '', 0)
    return {
      workspaceId,
      query: rawQuery.trim(),
      entries,
      truncated: entries.length >= WORKSPACE_SEARCH_LIMIT,
      incomplete
    }
  }

  // MARK: - 内部

  private rootOf(workspaceId: string): string {
    const row = selectWorkspace(this.db, workspaceId)
    if (!row) throw new WorkspaceFileError('NOT_FOUND', `workspace ${workspaceId} does not exist`)
    return resolveWorkspaceRoot(row.absolutePath, row.name)
  }

  /**
   * 把 POSIX 相对路径解析到真实根内的绝对路径——路径穿越与符号链接逃逸的
   * 唯一闸门：
   * - 拒绝绝对路径 / 盘符 / 反斜杠 / NUL；
   * - realpath 解析后必须仍在真实根内（`..` 与 symlink 都逃不出去）。
   */
  private resolveInside(
    root: string,
    relativePath: string,
    options: { mustBeDirectory: boolean }
  ): string {
    if (relativePath.includes('\\') || relativePath.includes('\u0000')) {
      throw new WorkspaceFileError('VALIDATION_ERROR', '非法路径')
    }
    if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
      throw new WorkspaceFileError('VALIDATION_ERROR', '非法路径')
    }
    const joined = path.resolve(root, relativePath)
    let real: string
    try {
      real = realpathSync(joined)
    } catch {
      throw new WorkspaceFileError('NOT_FOUND', '文件或目录不存在')
    }
    const relFromRoot = path.relative(root, real)
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      throw new WorkspaceFileError('PERMISSION_DENIED', '访问超出工作区范围')
    }
    if (options.mustBeDirectory && !isDirectorySync(real)) {
      throw new WorkspaceFileError('VALIDATION_ERROR', '目标不是文件夹')
    }
    return real
  }

  private async statEntry(
    parentReal: string,
    parentRelative: string,
    name: string
  ): Promise<WorkspaceFileEntry | null> {
    try {
      const stat = await fsp.stat(path.join(parentReal, name))
      if (!stat.isFile()) return null
      const ext = path.extname(name).toLowerCase()
      const readable = !BINARY_EXTENSIONS.has(ext) && stat.size <= WORKSPACE_FILE_MAX_BYTES
      return {
        name,
        relativePath: joinRelative(parentRelative, name),
        kind: 'file',
        size: stat.size,
        readable,
        oversize: stat.size > WORKSPACE_FILE_MAX_BYTES
      }
    } catch {
      return null // 已消失 / 无权限的条目：安静跳过。
    }
  }
}

// MARK: - 纯函数（可独立单测）

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

export function isIgnoredDirectoryName(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name)
}

/** 白名单 + 未知扩展兜底（readFile 里还有 NUL 字节检测）。 */
export function isTextCandidate(extension: string): boolean {
  if (TEXT_EXTENSIONS.has(extension)) return true
  if (BINARY_EXTENSIONS.has(extension)) return false
  return true
}

export function isDirectorySync(realPath: string): boolean {
  try {
    return statSync(realPath).isDirectory()
  } catch {
    return false
  }
}

/**
 * 工作区根的最终闸门：**lstat 不跟随叶子链接**。目录被整体替换成指向
 * 外部的 symlink / junction 时拒绝服务（否则 realpath 会默默把「根」
 * 挪到链接目标，工作区边界就跟着漂移）。正常目录的 lstat 就是 directory。
 */
export function resolveWorkspaceRoot(absolutePath: string, name: string): string {
  try {
    const stat = lstatSync(absolutePath)
    if (!stat.isDirectory()) {
      throw new WorkspaceFileError('NOT_FOUND', `工作区文件夹已失效：${name}`)
    }
    return realpathSync(absolutePath)
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error
    throw new WorkspaceFileError('NOT_FOUND', `工作区文件夹已不存在：${name}`)
  }
}

export function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}
