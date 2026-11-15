import { randomUUID } from 'node:crypto'
import type { Db } from '../../database/client'
import { selectWorkspace } from '../../database/repositories/local-workspaces'
import {
  CONTEXT_MAX_FILES,
  CONTEXT_TOTAL_CHAR_LIMIT,
  type ContextFilePart,
  type ContextPackage
} from '../../../shared/contracts/local-workspace'
import { ApplicationError } from '../errors'
import { WorkspaceFileService } from './workspace-file-service'

/**
 * ContextBuilder：把用户挑选的文件整理成结构化 AI 上下文（Phase 1）。
 *
 * - 每个 entry 保留**相对路径**（交给 AI 的内容里没有工作区绝对路径）；
 * - 单文件超 WORKSPACE_FILE_MAX_CHARS 截断并标记，总量超
 *   CONTEXT_TOTAL_CHAR_LIMIT 停止追加并标记 truncated；
 * - 敏感文件在 WorkspaceFileService.readFile 一层就被拒绝，这里不会出现；
 * - `formattedText` 是「复制到 AI 对话」进剪贴板的最终文本，主进程生成——
 *   两处（预览 / 复制）永远同源。
 */
export class ContextBuilder {
  constructor(
    private readonly db: Db,
    private readonly files: WorkspaceFileService
  ) {}

  async build(workspaceId: string, relativePaths: string[]): Promise<ContextPackage> {
    const workspace = selectWorkspace(this.db, workspaceId)
    if (!workspace) {
      throw new ApplicationError('NOT_FOUND', `workspace ${workspaceId} does not exist`)
    }
    // 相对路径去重、保持用户选择顺序。
    const seen = new Set<string>()
    const paths = relativePaths.filter((p) => {
      if (seen.has(p)) return false
      seen.add(p)
      return true
    })
    if (paths.length === 0) {
      throw new ApplicationError('VALIDATION_ERROR', '请先选择至少一个文件')
    }
    if (paths.length > CONTEXT_MAX_FILES) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        `一次最多加入 ${CONTEXT_MAX_FILES} 个文件`
      )
    }

    const selectedFiles: ContextFilePart[] = []
    let total = 0
    let truncated = false
    for (const relativePath of paths) {
      if (total >= CONTEXT_TOTAL_CHAR_LIMIT) {
        truncated = true
        break
      }
      const file = await this.files.readFile(workspaceId, relativePath)
      let content = file.content
      const remaining = CONTEXT_TOTAL_CHAR_LIMIT - total
      if (content.length > remaining) {
        content = content.slice(0, remaining)
        truncated = true
      }
      total += content.length
      selectedFiles.push({
        relativePath,
        content,
        truncated: file.truncated || content.length < file.content.length || file.truncated,
        totalCharacters: file.totalCharacters
      })
    }

    return {
      workspaceId,
      workspaceName: workspace.name,
      selectedFiles,
      totalCharacters: total,
      truncated,
      createdAt: Date.now(),
      formattedText: formatPackage(workspace.name, selectedFiles, truncated)
    }
  }
}

/** 「复制到 AI 对话」的最终文本。相对路径 + 围栏代码块，绝不包含绝对路径。 */
export function formatPackage(
  workspaceName: string,
  files: ContextFilePart[],
  truncated: boolean
): string {
  const lines: string[] = []
  lines.push(`# Workspace: ${workspaceName}`)
  lines.push('')
  for (const file of files) {
    lines.push(`## File: ${file.relativePath}`)
    if (file.truncated) {
      lines.push(
        `> [NOTE] 此文件内容被截断（完整 ${file.totalCharacters} 字符，只保留部分）。`
      )
    }
    lines.push('')
    lines.push('```' + languageOf(file.relativePath))
    lines.push(file.content)
    lines.push('```')
    lines.push('')
  }
  if (truncated) {
    lines.push('> [NOTE] 因总长度限制，部分文件未包含。')
  }
  return lines.join('\n')
}

function languageOf(relativePath: string): string {
  const ext = relativePath.slice(relativePath.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    swift: 'swift',
    kt: 'kotlin',
    java: 'java',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'shell',
    bash: 'shell',
    sql: 'sql',
    vue: 'vue',
    csv: 'csv',
    txt: 'text'
  }
  return map[ext] ?? ''
}

/** 测试用的最小构造（真实路径来自 randomUUID 主键）。 */
export function newContextId(): string {
  return randomUUID()
}
