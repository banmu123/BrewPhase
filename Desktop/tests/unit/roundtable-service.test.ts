import { describe, expect, it } from 'vitest'
import { RoundtableService } from '../../src/main/roundtable/roundtable-service'
import type { RoundtableSnapshot } from '../../src/shared/roundtable'

/**
 * RoundtableService（Phase 3）：主进程唯一状态。
 *
 * 两个 Renderer（主窗口 + 圆桌独立窗口）订阅同一份快照，所以这里最重要
 * 的断言是：写入护栏（join 校验真实标签、draft 版本并发控制）、对账
 * （标签关闭摘除参与者）、生命周期（detach/dock 不丢数据、不重复开窗）。
 */

function makeService(options?: { alive?: (tabId: string) => boolean }) {
  const snapshots: RoundtableSnapshot[] = []
  const calls: { createWindow: number; closeWindow: number; focus: number; focusResult: boolean } = {
    createWindow: 0,
    closeWindow: 0,
    focus: 0,
    focusResult: true
  }
  const service = new RoundtableService({
    isTabAlive: options?.alive ?? ((tabId) => tabId.startsWith('tab-')),
    broadcast: (snapshot) => snapshots.push(snapshot),
    createWindow: () => {
      calls.createWindow += 1
    },
    closeWindow: () => {
      calls.closeWindow += 1
    },
    focusWindow: () => {
      calls.focus += 1
      return calls.focusResult
    },
    now: () => 1_000 + snapshots.length
  })
  return { service, snapshots, calls }
}

describe('join / leave：参与者引用与校验', () => {
  it('join 校验 tabId 是活着的真实标签：不存在则拒绝且不推进版本', () => {
    const { service, snapshots } = makeService({ alive: () => false })
    const snapshot = service.join('tab-ghost')
    expect(snapshot.participantTabIds).toEqual([])
    expect(snapshot.version).toBe(0)
    expect(snapshots).toHaveLength(0)
  })

  it('join 有效标签：追加参与者 + 广播 + 版本推进', () => {
    const { service, snapshots } = makeService()
    const snapshot = service.join('tab-1')
    expect(snapshot.participantTabIds).toEqual(['tab-1'])
    expect(snapshot.version).toBe(1)
    expect(snapshots).toHaveLength(1)
  })

  it('重复 join 幂等：无变化不广播', () => {
    const { service, snapshots } = makeService()
    service.join('tab-1')
    const again = service.join('tab-1')
    expect(again.version).toBe(1)
    expect(snapshots).toHaveLength(1)
  })

  it('leave：只解除关系，不影响其他参与者', () => {
    const { service } = makeService()
    service.join('tab-1')
    service.join('tab-2')
    const snapshot = service.leave('tab-1')
    expect(snapshot.participantTabIds).toEqual(['tab-2'])
  })

  it('reorder：插到目标前面；未知 ID 不变', () => {
    const { service } = makeService()
    service.join('tab-a')
    service.join('tab-b')
    service.join('tab-c')
    expect(service.reorder('tab-c', 'tab-a').participantTabIds).toEqual(['tab-c', 'tab-a', 'tab-b'])
    expect(service.reorder('tab-a', 'tab-zzz').participantTabIds).toEqual(['tab-c', 'tab-a', 'tab-b'])
  })
})

describe('setDraft：共享草稿（后写者胜出）', () => {
  it('写入成功并广播', () => {
    const { service, snapshots } = makeService()
    service.join('tab-1')
    const snapshot = service.setDraft('hello')
    expect(snapshot.draft).toBe('hello')
    expect(snapshots).toHaveLength(2)
  })

  it('后写者胜出：两个窗口先后写入，最终值一致广播', () => {
    const { service, snapshots } = makeService()
    service.setDraft('来自主窗口')
    const snapshot = service.setDraft('来自圆桌窗口')
    expect(snapshot.draft).toBe('来自圆桌窗口')
    // 每次真实写入都广播：两个窗口最终看到同一份值。
    expect(snapshots.at(-1)?.draft).toBe('来自圆桌窗口')
  })

  it('内容不变：无变化不广播', () => {
    const { service, snapshots } = makeService()
    service.setDraft('q')
    const before = snapshots.length
    service.setDraft('q')
    expect(snapshots.length).toBe(before)
  })

  it('草稿跨 detach/dock 保留', () => {
    const { service } = makeService()
    service.join('tab-1')
    service.setDraft('问题草稿')
    service.detach()
    expect(service.snapshot().draft).toBe('问题草稿')
    expect(service.snapshot().detached).toBe(true)
    service.dock()
    expect(service.snapshot().draft).toBe('问题草稿')
    expect(service.snapshot().detached).toBe(false)
  })
})

describe('detach / dock：独立窗口生命周期', () => {
  it('首次 detach：翻状态 + 建窗口 + 广播', () => {
    const { service, calls, snapshots } = makeService()
    const snapshot = service.detach({ x: -300, y: 200 })
    expect(snapshot.detached).toBe(true)
    expect(calls.createWindow).toBe(1)
    expect(snapshots.at(-1)?.detached).toBe(true)
  })

  it('重复 detach：只聚焦现有窗口，绝不重复创建（规格 §4.8）', () => {
    const { service, calls } = makeService()
    service.detach()
    service.detach({ x: 10, y: 10 })
    expect(calls.createWindow).toBe(1)
    expect(calls.focus).toBe(1)
  })

  it('dock：关窗口、状态保留、广播 detached=false', () => {
    const { service, calls, snapshots } = makeService()
    service.join('tab-1')
    service.detach()
    const snapshot = service.dock()
    expect(calls.closeWindow).toBe(1)
    expect(snapshot.detached).toBe(false)
    expect(snapshot.participantTabIds).toEqual(['tab-1'])
    expect(snapshots.at(-1)?.detached).toBe(false)
  })

  it('未拆出时 dock 是空操作', () => {
    const { service, calls } = makeService()
    service.dock()
    expect(calls.closeWindow).toBe(0)
  })

  it('focus：只在拆出时聚焦', () => {
    const { service, calls } = makeService()
    service.focus()
    expect(calls.focus).toBe(0)
    service.detach()
    service.focus()
    expect(calls.focus).toBe(1)
  })
})

describe('syncTabs：标签关闭的对账', () => {
  it('关闭的标签自动摘出圆桌（两个窗口都看到同一份结果）', () => {
    const { service, snapshots } = makeService()
    service.join('tab-1')
    service.join('tab-2')
    const snapshot = service.syncTabs(['tab-2'])
    expect(snapshot.participantTabIds).toEqual(['tab-2'])
    expect(snapshots).toHaveLength(3)
  })

  it('无变化时不广播（避免状态抖动）', () => {
    const { service, snapshots } = makeService()
    service.join('tab-1')
    const before = snapshots.length
    service.syncTabs(['tab-1', 'tab-other'])
    expect(snapshots.length).toBe(before)
  })
})
