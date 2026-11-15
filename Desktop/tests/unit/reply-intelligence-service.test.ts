import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { LocalWorkspaceService } from '../../src/main/application/local-workspace/local-workspace-service'
import { ReplyIntelligenceService } from '../../src/main/application/reply-intelligence/reply-intelligence-service'

/**
 * ReplyIntelligenceService（Phase 2）：导入 → 解析 → 分段 → 草稿。
 * 真实 SQLite（mkdtemp + openDatabase）；electron mock 只覆盖剪贴板——
 * 测试通过 vi.mock 控制「用户复制了什么」。
 */

const clipboardState = { text: '' }

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  clipboard: {
    readText: vi.fn(async () => clipboardState.text),
    writeText: vi.fn(async () => undefined)
  }
}))

let dir = ''
let handle: DatabaseHandle
let workspaces: LocalWorkspaceService
let service: ReplyIntelligenceService
let workspaceId: string
let tabId: string

const SOURCE = { url: 'https://chatgpt.com/c/abc', title: 'ChatGPT - 重构方案' }

function makeService(): ReplyIntelligenceService {
  return new ReplyIntelligenceService(handle.db, { emit: () => undefined } as never, workspaces, () => SOURCE)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bp-reply-'))
  handle = openDatabase(join(dir, 'brewphase.db'))
  workspaces = new LocalWorkspaceService(handle.db, { emit: () => undefined } as never)
  service = makeService()

  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), '# demo\n')
  workspaceId = workspaces.add(root, 'demo').id
  tabId = 'tab-reply-1'
  workspaces.setBinding(tabId, workspaceId)
  clipboardState.text = ''
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

const LONG_REPLY = `# 重构方案

把数据库层抽成 repository。

## 修改文件

- 修改 \`src/main/index.ts\`
- 新建 \`src/main/db/pool.ts\`

\`\`\`bash
pnpm typecheck
\`\`\`

\`\`\`diff
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -1 +1,2 @@
+import './pool'
\`\`\`

参考：https://example.com/guide

下一步：跑通 CI。`

describe('导入', () => {
  it('手动粘贴：保存完整原文 + 来源 + 工作区绑定 + 分段', async () => {
    const detail = service.captureFromPaste(tabId, LONG_REPLY)
    expect(detail.reply.rawContent).toBe(LONG_REPLY)
    expect(detail.reply.captureMethod).toBe('manual_paste')
    expect(detail.reply.providerId).toBe('chatgpt')
    expect(detail.reply.providerName).toBe('ChatGPT')
    expect(detail.reply.sourceUrl).toBe(SOURCE.url)
    expect(detail.reply.workspaceId).toBe(workspaceId)
    expect(detail.segments.length).toBeGreaterThan(5)
    // 偏移可信：能还原原文片段。
    const first = detail.segments[0]
    expect(LONG_REPLY.slice(first.startOffset, first.endOffset).trim()).toBe(first.content.trim())
  })

  it('从剪贴板导入（用户点击时主进程读一次）', async () => {
    clipboardState.text = `# 来自剪贴板\n内容 abc。`
    const detail = await service.captureFromClipboard(tabId)
    expect(detail.reply.captureMethod).toBe('clipboard_import')
    expect(detail.reply.rawContent).toContain('来自剪贴板')
  })

  it('剪贴板为空 / 粘贴为空 → 明确报错，不落库', async () => {
    await expect(service.captureFromClipboard(tabId)).rejects.toThrow(/剪贴板/)
    expect(() => service.captureFromPaste(tabId, '   ')).toThrow(/为空/)
    expect(service.list(50)).toHaveLength(0)
  })

  it('超长回复被拒（上限保护）', () => {
    const huge = 'x'.repeat(300_001)
    expect(() => service.captureFromPaste(tabId, huge)).toThrow(/长度/)
  })

  it('tab 已关闭（来源取不到）也能导入，来源字段为空', () => {
    const orphan = new ReplyIntelligenceService(
      handle.db,
      { emit: () => undefined } as never,
      workspaces,
      () => null
    )
    const detail = orphan.captureFromPaste('tab-gone', '# 无来源回复\n正文。')
    expect(detail.reply.sourceUrl).toBe('')
    expect(detail.reply.providerId).toBe('')
    // 工作区绑定按 tabId 查——查不到就是 null（待绑定）。
    expect(detail.reply.workspaceId).toBeNull()
  })

  it('不同卡片导入互不影响（tabId 隔离 + 各自绑定）', () => {
    const otherTab = 'tab-reply-2'
    workspaces.setBinding(otherTab, null)
    const d1 = service.captureFromPaste(tabId, '# 回复一\n内容一。')
    const d2 = service.captureFromPaste(otherTab, '# 回复二\n内容二。')
    expect(d1.reply.workspaceId).toBe(workspaceId)
    expect(d2.reply.workspaceId).toBeNull()
    expect(d1.reply.id).not.toBe(d2.reply.id)
  })
})

describe('分段编辑', () => {
  it('用户改分类后 user_edited 置真', async () => {
    const detail = service.captureFromPaste(tabId, LONG_REPLY)
    const segment = detail.segments[0]
    const updated = service.updateSegment(segment.id, ['copywriting'], segment.content)
    expect(updated.userEdited).toBe(true)
    expect(updated.categories).toEqual(['copywriting'])
  })

  it('删除单段不影响回复本体', () => {
    const detail = service.captureFromPaste(tabId, LONG_REPLY)
    const before = detail.segments.length
    service.removeSegment(detail.segments[0].id)
    const after = service.detail(detail.reply.id)
    expect(after.segments).toHaveLength(before - 1)
    expect(after.reply.id).toBe(detail.reply.id)
  })
})

describe('操作草稿', () => {
  it('从分段创建草稿：来源关系 + 工作区 + payload 候选', () => {
    const detail = service.captureFromPaste(tabId, LONG_REPLY)
    const shellSegment = detail.segments.find((item) => item.categories.includes('shell_command'))!
    expect(shellSegment).toBeTruthy()
    const draft = service.createDraft({ replyId: detail.reply.id, segmentId: shellSegment.id })
    expect(draft.replyId).toBe(detail.reply.id)
    expect(draft.segmentId).toBe(shellSegment.id)
    expect(draft.workspaceId).toBe(workspaceId)
    expect(draft.status).toBe('draft')
    expect(draft.requiresApproval).toBe(true)
    expect(draft.payload.commands.length).toBeGreaterThan(0)
    // Patch / 路径候选。
    const patchSegment = detail.segments.find((item) => item.categories.includes('patch'))!
    const patchDraft = service.createDraft({ replyId: detail.reply.id, segmentId: patchSegment.id })
    expect(patchDraft.payload.codeBlocks.length).toBeGreaterThan(0)
  })

  it('破坏性命令 → riskLevel=caution（仍是草稿、永不执行）', () => {
    const detail = service.captureFromPaste(tabId, '清理时执行 `rm -rf ./node_modules`。')
    const draft = service.createDraft({ replyId: detail.reply.id })
    expect(draft.riskLevel).toBe('caution')
    expect(draft.status).toBe('draft')
    expect(draft.requiresApproval).toBe(true)
  })

  it('工作区内路径相对化；外部路径标记 pathsOutsideWorkspace', () => {
    const inside = service.captureFromPaste(tabId, '新建 README.md 到项目里。')
    const draftInside = service.createDraft({ replyId: inside.reply.id })
    expect(draftInside.payload.pathsOutsideWorkspace).toBe(false)

    const outside = service.captureFromPaste(
      tabId,
      '把 C:\\Windows\\system32\\config 改一下配置。'
    )
    const draftOutside = service.createDraft({ replyId: outside.reply.id })
    expect(draftOutside.payload.pathsOutsideWorkspace).toBe(true)
  })

  it('草稿更新 / 删除 / 列表', () => {
    const detail = service.captureFromPaste(tabId, LONG_REPLY)
    const draft = service.createDraft({ replyId: detail.reply.id })
    const updated = service.updateDraft(draft.id, { title: '跑通类型检查', riskLevel: 'caution' })
    expect(updated.title).toBe('跑通类型检查')
    expect(updated.riskLevel).toBe('caution')
    expect(service.listDrafts(detail.reply.id, 100)).toHaveLength(1)
    service.removeDraft(draft.id)
    expect(service.listDrafts(null, 100)).toHaveLength(0)
  })

  it('工作目录只存相对路径：剥掉工作区根前缀', () => {
    const detail = service.captureFromPaste(tabId, '正文。')
    const draft = service.createDraft({ replyId: detail.reply.id })
    const absolute = join(
      workspaces.get(draft.workspaceId!)!.absolutePath,
      'src',
      'main'
    )
    const updated = service.updateDraft(draft.id, { workingDirectory: absolute })
    expect(updated.workingDirectory).toBe('src/main')
    expect(updated.workingDirectory).not.toContain(':')
  })
})

describe('持久化与删除', () => {
  it('重启后回复、分段、草稿都在（真实 SQLite）', () => {
    const detail = service.captureFromPaste(tabId, LONG_REPLY)
    service.createDraft({ replyId: detail.reply.id, segmentId: detail.segments[0].id })

    const reopened = makeService()
    const restored = reopened.detail(detail.reply.id)
    expect(restored.reply.rawContent).toBe(LONG_REPLY)
    expect(restored.segments.length).toBe(detail.segments.length)
    expect(reopened.listDrafts(detail.reply.id, 100)).toHaveLength(1)
  })

  it('删除回复级联删除分段与草稿', () => {
    const detail = service.captureFromPaste(tabId, LONG_REPLY)
    service.createDraft({ replyId: detail.reply.id })
    service.remove(detail.reply.id)
    expect(service.list(50)).toHaveLength(0)
    expect(service.listDrafts(null, 100)).toHaveLength(0)
    expect(() => service.detail(detail.reply.id)).toThrow(/does not exist/)
  })
})
