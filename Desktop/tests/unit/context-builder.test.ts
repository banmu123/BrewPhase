import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { LocalWorkspaceService } from '../../src/main/application/local-workspace/local-workspace-service'
import { WorkspaceFileService } from '../../src/main/application/local-workspace/workspace-file-service'
import {
  ContextBuilder,
  formatPackage
} from '../../src/main/application/local-workspace/context-builder'
import type { ContextFilePart } from '../../src/shared/contracts/local-workspace'

/**
 * ContextBuilder（Phase 1）：选文件 → 结构化上下文包。
 * 相对路径 / 敏感排除 / 总量截断 / formattedText 同源。
 */

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) }
}))

let dir = ''
let handle: DatabaseHandle
let builder: ContextBuilder
let workspaceId = ''
let root = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-context-'))
  handle = openDatabase(join(dir, 'brewphase.db'))
  const workspaces = new LocalWorkspaceService(handle.db, { emit: () => undefined } as never)
  builder = new ContextBuilder(handle.db, new WorkspaceFileService(handle.db))
  root = join(dir, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# BrewPhase\ncontent of readme')
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42\n')
  writeFileSync(join(root, '.env'), 'SECRET=1\n')
  workspaceId = workspaces.add(root, 'BrewPhase').id
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('多文件上下文生成', () => {
  it('按选择顺序打包，相对路径正确，不含绝对路径', async () => {
    const pkg = await builder.build(workspaceId, ['src/index.ts', 'README.md'])
    expect(pkg.workspaceName).toBe('BrewPhase')
    expect(pkg.selectedFiles.map((file) => file.relativePath)).toEqual(['src/index.ts', 'README.md'])
    expect(pkg.selectedFiles[0].content).toContain('export const answer = 42')
    expect(pkg.totalCharacters).toBeGreaterThan(0)
    expect(pkg.truncated).toBe(false)
    // 绝对路径绝不进包（含 formattedText）。
    expect(JSON.stringify(pkg)).not.toContain(root)
    expect(pkg.formattedText).not.toContain(root)
    expect(pkg.formattedText).toContain('## File: src/index.ts')
    expect(pkg.formattedText).toContain('# Workspace: BrewPhase')
  })

  it('重复选择的文件去重', async () => {
    const pkg = await builder.build(workspaceId, ['README.md', 'README.md'])
    expect(pkg.selectedFiles).toHaveLength(1)
  })

  it('空选择 / 非法 workspaceId 拒绝', async () => {
    await expect(builder.build(workspaceId, [])).rejects.toThrow(/至少/)
    await expect(
      builder.build('11111111-1111-4111-8111-111111111111', ['README.md'])
    ).rejects.toThrow(/does not exist/)
  })

  it('敏感文件在读取层就被拒绝，进不了上下文', async () => {
    await expect(builder.build(workspaceId, ['.env'])).rejects.toThrow(/敏感文件/)
  })

  it('单文件超长截断并标记', async () => {
    const bigPath = join(root, 'src', 'big.ts')
    writeFileSync(bigPath, 'a'.repeat(100 * 1024))
    const pkg = await builder.build(workspaceId, ['src/big.ts'])
    const entry = pkg.selectedFiles[0]
    expect(entry.truncated).toBe(true)
    expect(entry.content.length).toBe(64_000)
    expect(entry.totalCharacters).toBe(100 * 1024)
    expect(pkg.formattedText).toContain('此文件内容被截断')
  })

  it('总字符上限：达到上限即停止追加并标记 truncated', async () => {
    // readFile 层先按单文件上限截断（64K 字符/文件）；总量 200K 需要
    // 多个文件叠加：3 个 64K = 192K，第 4 个只能放下 8K。
    const paths: string[] = []
    for (const letter of ['a', 'b', 'c', 'd', 'e']) {
      const p = join(root, 'src', `${letter}.ts`)
      writeFileSync(p, letter.repeat(160 * 1024))
      paths.push(`src/${letter}.ts`)
    }
    const pkg = await builder.build(workspaceId, paths)
    expect(pkg.truncated).toBe(true)
    expect(pkg.totalCharacters).toBe(200_000)
    expect(pkg.selectedFiles).toHaveLength(4)
    expect(pkg.selectedFiles[3].content.length).toBe(8_000)
    expect(pkg.selectedFiles[3].truncated).toBe(true)
    expect(pkg.formattedText).toContain('部分文件未包含')
  })

  it('文件超过上限后格式化文本仍可用（预览可复制）', async () => {
    const pkg = await builder.build(workspaceId, ['README.md'])
    expect(pkg.formattedText.length).toBeGreaterThan(pkg.totalCharacters)
    expect(pkg.formattedText).toContain('```')
  })
})

describe('formattedText 生成', () => {
  it('语言推断与截断提示', () => {
    const files: ContextFilePart[] = [
      {
        relativePath: 'src/main.ts',
        content: 'const x = 1',
        truncated: false,
        totalCharacters: 11
      },
      {
        relativePath: 'notes/readme.md',
        content: 'hello',
        truncated: true,
        totalCharacters: 900_000
      }
    ]
    const text = formatPackage('BrewPhase', files, false)
    expect(text).toContain('```typescript')
    expect(text).toContain('```markdown')
    expect(text).toContain('## File: notes/readme.md')
    expect(text).toContain('900000 字符')
    expect(text).not.toContain('部分文件未包含')
  })
})
