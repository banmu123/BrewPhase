import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { LocalWorkspaceService } from '../../src/main/application/local-workspace/local-workspace-service'
import {
  WorkspaceFileService,
  isSensitiveName,
  isIgnoredDirectoryName
} from '../../src/main/application/local-workspace/workspace-file-service'

/**
 * WorkspaceFileService 的文件安全（Phase 1）：
 * 路径穿越 / 符号链接逃逸 / 敏感文件 / 二进制 / 大文件 / 搜索限制。
 * 真实文件系统（mkdtemp）+ 真实 SQLite。
 */

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) }
}))

let dir = ''
let handle: DatabaseHandle
let workspaces: LocalWorkspaceService
let files: WorkspaceFileService
let workspaceId = ''
let root = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-ws-files-'))
  handle = openDatabase(join(dir, 'brewphase.db'))
  workspaces = new LocalWorkspaceService(handle.db, { emit: () => undefined } as never)
  files = new WorkspaceFileService(handle.db)

  root = join(dir, 'project')
  mkdirSync(join(root, 'src', 'main', 'browser'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# BrewPhase\n')
  writeFileSync(join(root, 'src', 'main', 'index.ts'), 'console.log(1)\n')
  writeFileSync(join(root, 'src', 'main', 'browser', 'manager.ts'), 'export {}\n')
  writeFileSync(join(root, '.env'), 'SECRET=1\n')
  writeFileSync(join(root, 'server.key'), 'PRIVATE\n')
  writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(root, 'data.bin'), Buffer.from([1, 0, 2, 0, 3]))
  writeFileSync(join(root, 'node_modules', 'dep.ts'), 'export {}\n')
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: main\n')

  workspaceId = workspaces.add(root, 'project').id
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('listFiles：按目录读取与排除规则', () => {
  it('根目录列表：目录在前、忽略规则生效、敏感文件不出现', async () => {
    const listing = await files.listFiles(workspaceId, '')
    const names = listing.entries.map((entry) => entry.name)
    // 忽略目录不出现；敏感文件（.env / server.key）不出现。
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('.git')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('server.key')
    // 二进制文件仍在列表里（用户能看到、但不可读）。
    expect(names).toContain('logo.png')
    expect(names).toContain('README.md')
    expect(names).toContain('src')
    const first = listing.entries[0]
    expect(first.kind).toBe('directory')
  })

  it('子目录列表带 POSIX 相对路径；binary 标记 readable=false', async () => {
    const listing = await files.listFiles(workspaceId, 'src/main')
    const index = listing.entries.find((entry) => entry.name === 'index.ts')
    expect(index?.relativePath).toBe('src/main/index.ts')
    expect(index?.readable).toBe(true)
    const png = (await files.listFiles(workspaceId, '')).entries.find((e) => e.name === 'logo.png')
    expect(png?.readable).toBe(false)
    expect(png?.oversize).toBe(false)
  })

  it('穿越路径与非法路径在列表层就被拒绝', async () => {
    await expect(files.listFiles(workspaceId, '..')).rejects.toThrow()
    await expect(files.listFiles(workspaceId, 'src\\main')).rejects.toThrow()
    await expect(files.listFiles(workspaceId, '/etc')).rejects.toThrow()
    await expect(files.listFiles(workspaceId, 'C:/Windows')).rejects.toThrow()
    await expect(files.listFiles(workspaceId, 'src/no-such-dir')).rejects.toThrow(/不存在/)
  })

  it('非法 workspaceId 拒绝', async () => {
    await expect(files.listFiles('11111111-1111-4111-8111-111111111111', '')).rejects.toThrow(
      /does not exist/
    )
  })
})

describe('readFile：读取边界', () => {
  it('正常文本读取', async () => {
    const content = await files.readFile(workspaceId, 'src/main/index.ts')
    expect(content.content).toBe('console.log(1)\n')
    expect(content.truncated).toBe(false)
    expect(content.totalCharacters).toBe(15)
  })

  it('敏感文件读取被拒（双保险）', async () => {
    await expect(files.readFile(workspaceId, '.env')).rejects.toThrow(/敏感文件/)
    await expect(files.readFile(workspaceId, 'server.key')).rejects.toThrow(/敏感文件/)
  })

  it('二进制文件拒绝（扩展名 + NUL 字节双检）', async () => {
    await expect(files.readFile(workspaceId, 'logo.png')).rejects.toThrow(/二进制/)
    await expect(files.readFile(workspaceId, 'data.bin')).rejects.toThrow(/二进制/)
  })

  it('路径穿越（.. / 绝对路径 / 反斜杠）拒绝', async () => {
    await expect(files.readFile(workspaceId, '../outside.txt')).rejects.toThrow()
    await expect(files.readFile(workspaceId, 'src/../../../etc/passwd')).rejects.toThrow()
    await expect(files.readFile(workspaceId, '\\windows\\system32')).rejects.toThrow()
    await expect(files.readFile(workspaceId, 'D:/secret.txt')).rejects.toThrow()
  })

  it('符号链接（junction）逃逸被拦：真实根比对兜底', async () => {
    // Windows 上 junction 不需要管理员权限；其它平台用普通 symlink。
    const outside = join(dir, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'top secret\n')
    const linkPath = join(root, 'escape')
    try {
      symlinkSync(outside, linkPath, 'junction')
    } catch {
      try {
        symlinkSync(outside, linkPath, 'dir')
      } catch {
        // 环境完全不支持 symlink：跳过（CI 无权限时不算失败）。
        return
      }
    }
    await expect(files.readFile(workspaceId, 'escape/secret.txt')).rejects.toThrow(/超出工作区范围/)
    await expect(files.readFile(workspaceId, 'escape')).rejects.toThrow(/超出工作区范围/)
  })

  it('超大文件拒绝，中等文件读取时截断', async () => {
    // > 512KB：直接拒绝读取。
    const bigPath = join(root, 'huge.ts')
    writeFileSync(bigPath, 'x'.repeat(600 * 1024))
    await expect(files.readFile(workspaceId, 'huge.ts')).rejects.toThrow(/超过大小限制/)

    // 100KB（< 512KB 但 > 64K 字符）：可读，内容截断并标记。
    const midPath = join(root, 'mid.ts')
    writeFileSync(midPath, 'a'.repeat(100 * 1024))
    const content = await files.readFile(workspaceId, 'mid.ts')
    expect(content.truncated).toBe(true)
    expect(content.content.length).toBe(64_000)
    expect(content.totalCharacters).toBe(100 * 1024)
  })

  it('不存在的文件 NOT_FOUND', async () => {
    await expect(files.readFile(workspaceId, 'src/nope.ts')).rejects.toThrow(/不存在/)
  })
})

describe('searchFiles：文件名搜索', () => {
  it('命中目标文件；忽略目录与敏感文件不参与', async () => {
    writeFileSync(join(root, 'node_modules', 'index.js'), 'export {}\n')
    writeFileSync(join(root, '.env.local'), 'X=1\n')
    const result = await files.searchFiles(workspaceId, 'INDEX')
    const paths = result.entries.map((entry) => entry.relativePath)
    expect(paths).toContain('src/main/index.ts')
    expect(paths).not.toContain('node_modules/index.js')
    expect(paths).not.toContain('.env.local')
    expect(result.incomplete).toBe(false)
  })

  it('空搜索词 / 非法 workspaceId 拒绝', async () => {
    await expect(files.searchFiles(workspaceId, '   ')).rejects.toThrow(/搜索词/)
    await expect(files.searchFiles('11111111-1111-4111-8111-111111111111', 'x')).rejects.toThrow(
      /does not exist/
    )
  })
})

describe('纯函数规则', () => {
  it('敏感名与忽略目录判定', () => {
    expect(isSensitiveName('.env')).toBe(true)
    expect(isSensitiveName('.env.production')).toBe(true)
    expect(isSensitiveName('id_rsa')).toBe(true)
    expect(isSensitiveName('server.pem')).toBe(true)
    expect(isSensitiveName('api-key.key')).toBe(true)
    expect(isSensitiveName('credentials.json')).toBe(true)
    expect(isSensitiveName('secrets.txt')).toBe(true)
    expect(isSensitiveName('README.md')).toBe(false)
    expect(isIgnoredDirectoryName('node_modules')).toBe(true)
    expect(isIgnoredDirectoryName('coverage')).toBe(true)
    expect(isIgnoredDirectoryName('docs')).toBe(false)
  })
})

describe('工作区目录被替换后仍守边界', () => {
  it('根目录变成指向外部的 junction 时拒绝服务', async () => {
    rmSync(root, { recursive: true, force: true })
    const outside = join(dir, 'replacement')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'leak.txt'), 'leak\n')
    try {
      symlinkSync(outside, root, 'junction')
    } catch {
      return // 环境不支持 symlink：跳过。
    }
    await expect(files.readFile(workspaceId, 'leak.txt')).rejects.toThrow()
  })
})

// existsSync 引用保留：删除登记的文件存在性断言在 service 测试里。
void existsSync
