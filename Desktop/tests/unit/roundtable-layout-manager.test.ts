import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { selectRoundtablePanels } from '../../src/main/database/repositories/roundtable-panels'
import { RoundtableLayoutManager } from '../../src/main/roundtable/roundtable-layout-manager'
import {
  rectsIntersect,
  ROUNDTABLE_PANEL_MIN_HEIGHT,
  ROUNDTABLE_PANEL_MIN_WIDTH
} from '../../src/shared/roundtable'

/**
 * 圆桌布局管理器（Phase 4.2 workspace）：
 * 1. 成员对账——新成员级联默认位、离开成员清行（持久化同步删）；
 * 2. 拖动 live 路径只改内存 + 防抖落库，flush 后一定在库里；
 * 3. 置顶 z = max + 1；吸附开关持久化；
 * 4. 工作区尺寸变化 → 布局适配且仍可达；
 * 5. 重建管理器（模拟重启）能从 SQLite 恢复。
 */

describe('RoundtableLayoutManager', () => {
  let dir = ''
  let handle: DatabaseHandle
  let broadcasts: Array<Record<string, unknown>>
  let manager: RoundtableLayoutManager

  function make(): RoundtableLayoutManager {
    return new RoundtableLayoutManager({
      db: handle.db,
      broadcast: (snapshot) => broadcasts.push(snapshot as unknown as Record<string, unknown>)
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-rt-layout-'))
    handle = openDatabase(join(dir, 'brewphase.db'))
    broadcasts = []
    manager = make()
  })

  afterEach(() => {
    manager.dispose()
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('syncMembers：新成员默认位互不重叠并落库；离开成员清行', () => {
    manager.setWorkspaceSize({ width: 1200, height: 800 })
    broadcasts.length = 0

    manager.syncMembers(['tab-1', 'tab-2', 'tab-3'])
    const snapshot = manager.snapshot()
    expect(snapshot.panels.map((panel) => panel.tabId).sort()).toEqual(['tab-1', 'tab-2', 'tab-3'])
    // 防重叠（产品规则）：默认落位两两不相交。
    for (let i = 0; i < snapshot.panels.length; i += 1) {
      for (let j = i + 1; j < snapshot.panels.length; j += 1) {
        expect(rectsIntersect(snapshot.panels[i], snapshot.panels[j])).toBe(false)
      }
    }
    manager.flushPersist()
    expect(selectRoundtablePanels(handle.db, 'roundtable-main')).toHaveLength(3)

    // 移除：布局行同步删除（不留孤儿）。
    manager.syncMembers(['tab-1'])
    expect(manager.snapshot().panels.map((panel) => panel.tabId)).toEqual(['tab-1'])
    expect(selectRoundtablePanels(handle.db, 'roundtable-main')).toHaveLength(1)
  })

  it('移除成员清布局（规格 §11.3）；重新加入拿到新的默认位', () => {
    manager.setWorkspaceSize({ width: 1200, height: 800 })
    manager.syncMembers(['tab-1'])
    manager.movePanel('tab-1', 500, 300)
    manager.flushPersist()
    manager.syncMembers([])
    expect(selectRoundtablePanels(handle.db, 'roundtable-main')).toHaveLength(0)
    manager.syncMembers(['tab-1'])
    // 重新加入 = 新成员：默认级联位（不是上次的位置）。
    expect(manager.panelOf('tab-1')?.x).toBeLessThan(500)
  })

  it('movePanelLive：位置即时更新、防抖后落库；flush 强制落库', async () => {
    manager.setWorkspaceSize({ width: 1200, height: 800 })
    manager.syncMembers(['tab-1'])
    broadcasts.length = 0

    manager.movePanelLive('tab-1', 640, 420)
    // 内存与广播即时；库可能还没写（防抖）。
    expect(manager.panelOf('tab-1')?.x).toBe(640)
    expect(broadcasts.length).toBeGreaterThan(0)

    manager.flushPersist()
    const rows = selectRoundtablePanels(handle.db, 'roundtable-main')
    expect(rows.find((row) => row.tabId === 'tab-1')?.x).toBe(640)
  })

  it('movePanelLive 的位置被 clamp：面板至少 KEEP_VISIBLE 留在工作区内', () => {
    manager.setWorkspaceSize({ width: 800, height: 600 })
    manager.syncMembers(['tab-1'])
    manager.movePanelLive('tab-1', 5000, 5000)
    const panel = manager.panelOf('tab-1')!
    expect(panel.x).toBeLessThanOrEqual(800 - 180)
    expect(panel.y).toBeLessThanOrEqual(600 - 120)
  })

  it('bringToFront：z = max + 1；重复置顶不推进版本', () => {
    manager.setWorkspaceSize({ width: 1200, height: 800 })
    manager.syncMembers(['tab-1', 'tab-2'])
    const z1 = manager.panelOf('tab-1')!.z
    const z2 = manager.panelOf('tab-2')!.z
    manager.bringToFront('tab-1')
    expect(manager.panelOf('tab-1')!.z).toBeGreaterThan(z2)
    const version = manager.snapshot().version
    manager.bringToFront('tab-1')
    expect(manager.snapshot().version).toBe(version) // 已是顶层：无变化
    expect(manager.snapshot().activeTabId).toBe('tab-1')
    void z1
  })

  it('setWorkspaceSize：只更新参照系不改写面板位置（拆出归位往返不降级）', () => {
    manager.setWorkspaceSize({ width: 1200, height: 800 })
    manager.syncMembers(['tab-1'])
    manager.movePanel('tab-1', 1000, 400)
    manager.flushPersist()

    manager.setWorkspaceSize({ width: 700, height: 500 })
    // 存储位置原样保留（显示层按工作区 clamp）；meta 已持久化。
    expect(manager.panelOf('tab-1')?.x).toBe(1000)
    expect(manager.panelOf('tab-1')?.y).toBe(400)
    manager.flushPersist()
    const row = selectRoundtablePanels(handle.db, 'roundtable-main')[0]
    expect(row?.x).toBe(1000)
    const reborn = make()
    try {
      expect(reborn.snapshot().workspace).toEqual({ width: 700, height: 500 })
      expect(reborn.panelOf('tab-1')?.x).toBe(1000)
    } finally {
      reborn.dispose()
    }
  })

  it('防重叠：拖到已占用位置被推到最近空位，落库后仍无重叠', () => {
    manager.setWorkspaceSize({ width: 1600, height: 1000 })
    manager.syncMembers(['tab-1', 'tab-2'])
    const first = manager.panelOf('tab-1')!
    const second = manager.panelOf('tab-2')!
    // 把 tab-2 拖到 tab-1 的正中心：解析后必须无重叠，且离意图最近。
    manager.movePanel('tab-2', first.x + first.width / 2 - second.width / 2, first.y + first.height / 2 - second.height / 2)
    const moved = manager.panelOf('tab-2')!
    expect(rectsIntersect(moved, first)).toBe(false)
    // 落库一致。
    manager.flushPersist()
    const rows = selectRoundtablePanels(handle.db, 'roundtable-main')
    expect(rows).toHaveLength(2)
  })

  it('防重叠缩放：向东长高被邻居挡住时停在其左缘，不越过', () => {
    manager.setWorkspaceSize({ width: 1600, height: 1000 })
    manager.syncMembers(['tab-1'])
    manager.movePanel('tab-1', 0, 0)
    manager.syncMembers(['tab-1', 'tab-2'])
    manager.movePanel('tab-2', 800, 0)
    manager.flushPersist()
    // tab-1 向东猛拉（会穿过 tab-2 的左缘 800）：必须停在 800。
    manager.resizePanel('tab-1', 0, 0, 1200, 420, 'se')
    const grown = manager.panelOf('tab-1')!
    expect(grown.width).toBe(800)
    const neighbor = manager.panelOf('tab-2')!
    expect(rectsIntersect(grown, neighbor)).toBe(false)
  })

  it('缩放到极小：clamp 到最小尺寸，仍不与邻居重叠', () => {
    manager.setWorkspaceSize({ width: 1600, height: 1000 })
    manager.syncMembers(['tab-1'])
    manager.movePanel('tab-1', 0, 0)
    manager.resizePanel('tab-1', 0, 0, 40, 40, 'se')
    const shrunk = manager.panelOf('tab-1')!
    expect(shrunk.width).toBe(ROUNDTABLE_PANEL_MIN_WIDTH)
    expect(shrunk.height).toBe(ROUNDTABLE_PANEL_MIN_HEIGHT)
  })

  it('rebindPanel：幽灵面板重开保留原几何（清旧行写新行）', () => {
    manager.setWorkspaceSize({ width: 1200, height: 800 })
    manager.syncMembers(['tab-1'])
    manager.movePanel('tab-1', 500, 300)
    manager.flushPersist()

    const reborn = make()
    try {
      reborn.setWorkspaceSize({ width: 1200, height: 800 })
      reborn.syncMembers(['tab-old']) // 模拟恢复出的旧行
      reborn.movePanel('tab-old', 500, 300)
      reborn.flushPersist()
      reborn.rebindPanel('tab-old', 'tab-new')
      const panel = reborn.panelOf('tab-new')!
      expect(panel.x).toBe(500)
      expect(panel.y).toBe(300)
      expect(reborn.panelOf('tab-old')).toBeNull()
      expect(selectRoundtablePanels(handle.db, 'roundtable-main').find((row) => row.tabId === 'tab-new')?.x).toBe(500)
    } finally {
      reborn.dispose()
    }
  })

  it('handleTabClosed：清布局；重建管理器（模拟重启）能恢复', () => {
    manager.setWorkspaceSize({ width: 1200, height: 800 })
    manager.syncMembers(['tab-1', 'tab-2'])
    manager.movePanel('tab-1', 300, 200)
    manager.flushPersist()

    manager.handleTabClosed('tab-2')
    expect(manager.snapshot().panels.map((panel) => panel.tabId)).toEqual(['tab-1'])

    // 模拟应用重启：同一库新管理器恢复布局。
    const reborn = make()
    try {
      const restored = reborn.snapshot()
      expect(restored.panels.map((panel) => panel.tabId)).toEqual(['tab-1'])
      expect(restored.panels[0]?.x).toBe(300)
      expect(restored.workspace).toEqual({ width: 1200, height: 800 })
    } finally {
      reborn.dispose()
    }
  })

  it('setSnapEnabled：持久化到元数据，重建后保留', () => {
    manager.setSnapEnabled(false)
    const reborn = make()
    try {
      expect(reborn.snapshot().snapEnabled).toBe(false)
    } finally {
      reborn.dispose()
    }
  })
})
