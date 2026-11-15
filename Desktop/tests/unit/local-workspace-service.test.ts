import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { LocalWorkspaceService } from '../../src/main/application/local-workspace/local-workspace-service'
import type { AppDomain } from '../../src/main/application/events/application-events'

/**
 * LocalWorkspaceService：授权登记 + 卡片绑定（Phase 1）。
 * 真实 SQLite（mkdtemp + openDatabase）验证持久化与规则边界。
 */

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) }
}))

let dir = ''
let handle: DatabaseHandle
let service: LocalWorkspaceService
const domains: AppDomain[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-local-workspace-'))
  handle = openDatabase(join(dir, 'brewphase.db'))
  service = new LocalWorkspaceService(handle.db, { emit: (domain: AppDomain) => domains.push(domain) } as never)
  domains.length = 0
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeProject(name: string): string {
  const root = join(dir, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), `# ${name}\n`)
  return root
}

describe('工作区登记', () => {
  it('添加 → realpath 规范化 → 列表可见且 available', () => {
    const root = makeProject('brewphase')
    const ws = service.add(root, 'BrewPhase')
    expect(ws.name).toBe('BrewPhase')
    expect(ws.availability).toBe('available')
    expect(ws.absolutePath.toLowerCase()).toBe(root.toLowerCase())
    expect(service.list()).toHaveLength(1)
    expect(domains).toContain('localWorkspaces')
  })

  it('重复路径（含大小写不同）拒绝登记', () => {
    const root = makeProject('brewping')
    service.add(root)
    // 只差大小写：Windows / macOS 默认盘上是同一目录。
    const variant = root.replace('brewping', 'BrewPing')
    expect(() => service.add(variant)).toThrow(/已登记/)
    expect(service.list()).toHaveLength(1)
  })

  it('不存在的路径 / 文件路径拒绝', () => {
    expect(() => service.add(join(dir, 'no-such-dir'))).toThrow(/不存在/)
    const file = join(dir, 'plain.txt')
    writeFileSync(file, 'x')
    expect(() => service.add(file)).toThrow(/文件夹/)
  })

  it('重命名后名称更新', () => {
    const root = makeProject('loomflow')
    const ws = service.add(root, 'old-name')
    const renamed = service.rename(ws.id, 'LoomFlow')
    expect(renamed.name).toBe('LoomFlow')
    expect(service.get(ws.id)?.name).toBe('LoomFlow')
  })

  it('删除登记不影响真实文件夹；目录被外部删除后 availability=missing', () => {
    const root = makeProject('brewphase')
    const ws = service.add(root)
    service.remove(ws.id)
    expect(service.list()).toHaveLength(0)
    expect(() => service.remove(ws.id)).toThrow(/does not exist/)
    // 真实文件夹还在。
    expect(require('node:fs').existsSync(root)).toBe(true)

    const ws2 = service.add(root, 'again')
    rmSync(root, { recursive: true, force: true })
    expect(service.list()[0]?.availability).toBe('missing')
    // 根目录消失时文件服务不能拿到有效根。
    expect(() => service.resolveRoot(ws2.id)).toThrow(/不存在/)
  })

  it('登记数量上限', () => {
    for (let i = 0; i < 16; i += 1) service.add(makeProject(`p-${i}`))
    expect(() => service.add(makeProject('overflow'))).toThrow(/最多/)
  })
})

describe('卡片绑定（tabId → workspaceId）', () => {
  it('绑定 / 换绑 / 解绑：每张卡独立，互不影响', () => {
    const brewphase = service.add(makeProject('brewphase'))
    const brewping = service.add(makeProject('brewping'))

    expect(service.binding('tab-1').workspace).toBeNull()
    service.setBinding('tab-1', brewphase.id)
    service.setBinding('tab-2', brewping.id)
    service.setBinding('tab-3', brewphase.id) // 多卡可绑同一工作区

    expect(service.binding('tab-1').workspace?.id).toBe(brewphase.id)
    expect(service.binding('tab-2').workspace?.id).toBe(brewping.id)
    expect(service.binding('tab-3').workspace?.id).toBe(brewphase.id)

    service.setBinding('tab-1', brewping.id)
    expect(service.binding('tab-1').workspace?.id).toBe(brewping.id)
    expect(service.binding('tab-2').workspace?.id).toBe(brewping.id) // 不被波及

    service.setBinding('tab-1', null)
    expect(service.binding('tab-1')).toMatchObject({ workspace: null, missing: false })
  })

  it('绑定不存在的工作区被拒绝', () => {
    expect(() => service.setBinding('tab-1', '11111111-1111-4111-8111-111111111111')).toThrow(
      /does not exist/
    )
  })

  it('删除工作区后绑定显示失效（missing），而不是静默回未绑定', () => {
    const ws = service.add(makeProject('brewphase'))
    service.setBinding('tab-1', ws.id)
    service.remove(ws.id)
    const binding = service.binding('tab-1')
    expect(binding.missing).toBe(true)
    expect(binding.workspace).toBeNull()
  })

  it('标签关闭清理绑定（clearBinding）', () => {
    const ws = service.add(makeProject('brewphase'))
    service.setBinding('tab-9', ws.id)
    service.clearBinding('tab-9')
    expect(service.binding('tab-9')).toMatchObject({ workspace: null, missing: false })
  })

  it('重启后绑定仍在（真实 SQLite 持久化）', () => {
    const ws = service.add(makeProject('brewphase'))
    service.setBinding('tab-42', ws.id)
    const reopened = new LocalWorkspaceService(handle.db, { emit: () => undefined } as never)
    expect(reopened.binding('tab-42').workspace?.id).toBe(ws.id)
  })
})
