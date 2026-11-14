import { describe, expect, it } from 'vitest'
import {
  ROUNDTABLE_DRAFT_MAX,
  addParticipant,
  initialRoundtableSnapshot,
  removeParticipant,
  reorderParticipants,
  retainParticipants,
  setDetached,
  writeDraft,
  type RoundtableSnapshot
} from '../../src/shared/roundtable'

/**
 * 圆桌领域规则（Phase 3：主进程快照模型）。
 *
 * 最重要的断言仍是关系边界：加入 ≠ 打开，移除 ≠ 关闭。网页本身的生死在
 * BrowserTabManager，圆桌只持有 tabId 引用；detached 只是展示位置，
 * 拆出 / 归位不触碰参与者与草稿。
 */

describe('规格 §5：三种操作的边界', () => {
  it('加入圆桌：只记录 tabId 引用', () => {
    const table = addParticipant(initialRoundtableSnapshot(), 'tab-1')
    expect(table?.participantTabIds).toEqual(['tab-1'])
  })

  it('重复加入幂等：无变化返回 null（调用方不再提交版本号）', () => {
    const base = initialRoundtableSnapshot()
    const once = addParticipant(base, 'tab-1')
    expect(once).not.toBeNull()
    expect(addParticipant(once!, 'tab-1')).toBeNull()
    expect(addParticipant(base, '')).toBeNull()
  })

  it('移除参与者：只解除关系，不返回任何“关闭”语义', () => {
    const table = addParticipant(addParticipant(initialRoundtableSnapshot(), 'tab-1')!, 'tab-2')!
    const after = removeParticipant(table, 'tab-1')
    expect(after?.participantTabIds).toEqual(['tab-2'])
    // 原值不可变：调用方仍持有完整引用。
    expect(table.participantTabIds).toEqual(['tab-1', 'tab-2'])
  })

  it('移除不存在的参与者：无变化', () => {
    const base = initialRoundtableSnapshot()
    expect(removeParticipant(base, 'tab-x')).toBeNull()
  })

  it('标签关闭后的对账：只保留仍然存在的 tabId', () => {
    let table: RoundtableSnapshot = initialRoundtableSnapshot()
    for (const id of ['tab-1', 'tab-2', 'tab-3']) table = addParticipant(table, id)!
    const after = retainParticipants(table, ['tab-3', 'tab-1'])
    expect(after?.participantTabIds).toEqual(['tab-1', 'tab-3'])
  })

  it('对账无变化时返回 null（避免无意义的版本号推进）', () => {
    const table = addParticipant(initialRoundtableSnapshot(), 'tab-1')!
    expect(retainParticipants(table, ['tab-1'])).toBeNull()
  })
})

describe('参与者排序', () => {
  it('插到目标前面，源在目标前时不产生 off-by-one', () => {
    let table: RoundtableSnapshot = initialRoundtableSnapshot()
    for (const id of ['a', 'b', 'c']) table = addParticipant(table, id)!
    expect(reorderParticipants(table, 'c', 'a')?.participantTabIds).toEqual(['c', 'a', 'b'])
  })

  it('已经紧挨着目标前面：无变化（返回 null，不推进版本）', () => {
    let table: RoundtableSnapshot = initialRoundtableSnapshot()
    for (const id of ['a', 'b', 'c']) table = addParticipant(table, id)!
    expect(reorderParticipants(table, 'a', 'b')).toBeNull()
    expect(reorderParticipants(table, 'b', 'a')?.participantTabIds).toEqual(['b', 'a', 'c'])
  })

  it('拖到自己或未知 ID：不变', () => {
    const table = addParticipant(initialRoundtableSnapshot(), 'a')!
    expect(reorderParticipants(table, 'a', 'a')).toBeNull()
    expect(reorderParticipants(table, 'a', 'zzz')).toBeNull()
  })
})

describe('拆出 / 归位（detached 只是展示位置）', () => {
  it('初始圆桌停靠、无参与者、无草稿', () => {
    const snapshot = initialRoundtableSnapshot()
    expect(snapshot.detached).toBe(false)
    expect(snapshot.participantTabIds).toEqual([])
    expect(snapshot.draft).toBe('')
    expect(snapshot.version).toBe(0)
  })

  it('拆出与归位：参与者与草稿原样保留', () => {
    let snapshot = addParticipant(initialRoundtableSnapshot(), 'tab-1')!
    snapshot = writeDraft(snapshot, 'hello')!
    const detached = setDetached(snapshot, true)!
    expect(detached.detached).toBe(true)
    expect(detached.participantTabIds).toEqual(['tab-1'])
    expect(detached.draft).toBe('hello')
    const docked = setDetached(detached, false)!
    expect(docked.detached).toBe(false)
    expect(docked.participantTabIds).toEqual(['tab-1'])
    expect(docked.draft).toBe('hello')
  })

  it('重复拆出 / 归位幂等：无变化返回 null', () => {
    const base = initialRoundtableSnapshot()
    const detached = setDetached(base, true)!
    expect(setDetached(detached, true)).toBeNull()
    expect(setDetached(base, false)).toBeNull()
  })
})

describe('草稿', () => {
  it('内容不变时无变化', () => {
    const snapshot = writeDraft(initialRoundtableSnapshot(), 'q')!
    expect(writeDraft(snapshot, 'q')).toBeNull()
  })

  it('超长草稿在共享层截断（IPC 校验 + maxLength 是另外两道防线）', () => {
    const snapshot = writeDraft(initialRoundtableSnapshot(), 'a'.repeat(ROUNDTABLE_DRAFT_MAX + 50))
    expect(snapshot?.draft).toHaveLength(ROUNDTABLE_DRAFT_MAX)
  })
})
