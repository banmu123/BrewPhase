import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BeanDraft, BrewDraft, RecordDraft } from '@shared/contracts'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { changeLog } from '../../src/main/database/schema'
import { DEFAULT_PHASE_RULES } from '@shared/domain/phase'
import * as coffee from '../../src/main/database/repositories/coffee'
import * as recordsRepo from '../../src/main/database/repositories/records'
import * as canvasRepo from '../../src/main/database/repositories/canvas'

/**
 * Repository 的集成测试：**真实 SQLite 文件**，不是内存库。
 *
 * 内存库能过、磁盘库不过的问题（外键没开、事务没提交、迁移没跑）只有这种测试
 * 抓得到。每个用例一个临时目录，跑完删掉。
 */
let dir: string
let handle: DatabaseHandle

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-desktop-test-'))
  handle = openDatabase(join(dir, 'test.db'))
  coffee.seedPhaseRulesIfEmpty(handle.db, DEFAULT_PHASE_RULES)
})

afterEach(() => {
  handle.close()
  rmSync(dir, { recursive: true, force: true })
})

function beanDraft(overrides: Partial<BeanDraft> = {}): BeanDraft {
  return {
    name: '哥伦比亚 粉波旁',
    roaster: 'Onibus',
    roastLevel: 'medium',
    roastDate: Date.now() - 6 * 86_400_000,
    weightG: 200,
    remainingG: 200,
    price: 120,
    ...overrides
  }
}

function brewDraft(beanId: string, overrides: Partial<BrewDraft> = {}): BrewDraft {
  return {
    beanId,
    date: Date.now(),
    method: 'V60',
    grinder: 'C40',
    grindSize: '中细',
    waterTemp: 92,
    coffeeG: 15,
    waterG: 250,
    timeSeconds: 150,
    score: 82,
    acidity: 3,
    sweetness: 3,
    bitterness: 1,
    body: 2,
    aftertaste: 3,
    flavorTags: ['柑橘', '红茶'],
    notes: '',
    ...overrides
  }
}

function recordDraft(overrides: Partial<RecordDraft> = {}): RecordDraft {
  return {
    carrier: 'text',
    title: '一条笔记',
    note: '正文',
    urlString: '',
    canonicalURL: null,
    platformContentID: null,
    provider: 'generic',
    sourceName: '',
    authorName: '',
    summary: '',
    mediaPath: null,
    previewPath: null,
    tagIds: [],
    ...overrides
  }
}

const delay = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

describe('豆子与阶段规则', () => {
  it('新建豆子：剩余量默认等于总量，五档规则已就位', () => {
    const bean = coffee.createBean(handle.db, handle.deviceId, beanDraft())
    expect(bean.remainingG).toBe(200)
    expect(coffee.listBeans(handle.db)).toHaveLength(1)
    expect(coffee.listPhaseRules(handle.db)).toHaveLength(5)
  })

  it('人工改剩余量会记盘点时刻', () => {
    const bean = coffee.createBean(handle.db, handle.deviceId, beanDraft())
    expect(bean.stockCountedAt).toBeNull()
    const updated = coffee.updateBean(handle.db, handle.deviceId, bean.id, beanDraft({ remainingG: 150 }))
    expect(updated.stockCountedAt).not.toBeNull()
  })
})

describe('冲煮与库存', () => {
  it('记一杯按粉量扣库存，并留下一条镜像品鉴', () => {
    const bean = coffee.createBean(handle.db, handle.deviceId, beanDraft())
    const brew = coffee.createBrew(handle.db, handle.deviceId, brewDraft(bean.id))

    expect(coffee.getBean(handle.db, bean.id)?.remainingG).toBe(185)
    expect(brew.stockDeductedG).toBe(15)
    const tastings = coffee.listTastings(handle.db, bean.id)
    expect(tastings).toHaveLength(1)
    expect(tastings[0].brewId).toBe(brew.id)
    expect(tastings[0].source).toBe('brew')
  })

  it('袋里不够时只扣得掉剩下的，实扣量小于粉量', () => {
    const bean = coffee.createBean(handle.db, handle.deviceId, beanDraft({ remainingG: 5 }))
    const brew = coffee.createBrew(handle.db, handle.deviceId, brewDraft(bean.id, { coffeeG: 18 }))

    expect(brew.stockDeductedG).toBe(5)
    expect(coffee.getBean(handle.db, bean.id)?.remainingG).toBe(0)
  })

  it('删一杯退的是实扣量，不是粉量', () => {
    const bean = coffee.createBean(handle.db, handle.deviceId, beanDraft({ remainingG: 5 }))
    const brew = coffee.createBrew(handle.db, handle.deviceId, brewDraft(bean.id, { coffeeG: 18 }))
    coffee.deleteBrew(handle.db, handle.deviceId, brew.id)

    expect(coffee.getBean(handle.db, bean.id)?.remainingG).toBe(5)
    expect(coffee.listBrews(handle.db, bean.id)).toHaveLength(0)
    expect(coffee.listTastings(handle.db, bean.id)).toHaveLength(0)
  })

  it('编辑粉量按差值调整库存', () => {
    const bean = coffee.createBean(handle.db, handle.deviceId, beanDraft())
    const brew = coffee.createBrew(handle.db, handle.deviceId, brewDraft(bean.id))
    coffee.updateBrew(handle.db, handle.deviceId, brew.id, brewDraft(bean.id, { coffeeG: 20 }))

    expect(coffee.getBean(handle.db, bean.id)?.remainingG).toBe(180)
    expect(coffee.listBrews(handle.db, bean.id)[0].stockDeductedG).toBe(20)
  })

  it('盘点之前记的冲煮：删除时不退粉', async () => {
    const bean = coffee.createBean(handle.db, handle.deviceId, beanDraft())
    const brew = coffee.createBrew(handle.db, handle.deviceId, brewDraft(bean.id))
    // 盘点发生在冲煮之后：这一次剩余量是用户称出来的。
    await delay()
    coffee.updateBean(handle.db, handle.deviceId, bean.id, beanDraft({ remainingG: 150 }))
    coffee.deleteBrew(handle.db, handle.deviceId, brew.id)

    expect(coffee.getBean(handle.db, bean.id)?.remainingG).toBe(150)
  })
})

describe('标签多对多', () => {
  it('一条记录挂多个标签，同一标签挂多条记录，按标签筛得出来', () => {
    const tagA = recordsRepo.createTag(handle.db, handle.deviceId, '咖啡')
    const tagB = recordsRepo.createTag(handle.db, handle.deviceId, '阅读')

    const first = recordsRepo.createRecord(handle.db, handle.deviceId, recordDraft({ title: 'A', tagIds: [tagA.id, tagB.id] }))
    const second = recordsRepo.createRecord(handle.db, handle.deviceId, recordDraft({ title: 'B', tagIds: [tagA.id] }))

    expect(recordsRepo.getRecord(handle.db, first.id)?.tagIds.sort()).toEqual([tagA.id, tagB.id].sort())
    expect(recordsRepo.listRecords(handle.db, { search: '', carrier: null, tagId: tagA.id, limit: 50, offset: 0 })).toHaveLength(2)
    expect(recordsRepo.listRecords(handle.db, { search: '', carrier: null, tagId: tagB.id, limit: 50, offset: 0 })).toHaveLength(1)
    expect(recordsRepo.listRecords(handle.db, { search: '', carrier: null, tagId: null, limit: 50, offset: 0 })).toHaveLength(2)
    expect(second.title).toBe('B')
  })

  it('同名标签复用同一条，不制造重复', () => {
    const first = recordsRepo.createTag(handle.db, handle.deviceId, '手冲')
    const second = recordsRepo.createTag(handle.db, handle.deviceId, '手冲')
    expect(second.id).toBe(first.id)
  })
})

describe('画布节点', () => {
  it('同一画布重复添加同一记录只产生一个节点', () => {
    const canvas = canvasRepo.createCanvas(handle.db, handle.deviceId, 'AI 应用开发学习')
    const record = recordsRepo.createRecord(handle.db, handle.deviceId, recordDraft({ title: 'FastAPI' }))

    const first = canvasRepo.addNode(handle.db, handle.deviceId, canvas.id, record.id)
    const second = canvasRepo.addNode(handle.db, handle.deviceId, canvas.id, record.id)

    expect(second.id).toBe(first.id)
    expect(canvasRepo.listNodes(handle.db, canvas.id)).toHaveLength(1)
  })

  it('拖动落库：位置持久化，其他节点不动', () => {
    const canvas = canvasRepo.createCanvas(handle.db, handle.deviceId, '画布')
    const a = recordsRepo.createRecord(handle.db, handle.deviceId, recordDraft({ title: 'A' }))
    const b = recordsRepo.createRecord(handle.db, handle.deviceId, recordDraft({ title: 'B' }))
    const nodeA = canvasRepo.addNode(handle.db, handle.deviceId, canvas.id, a.id)
    const nodeB = canvasRepo.addNode(handle.db, handle.deviceId, canvas.id, b.id)

    canvasRepo.moveNode(handle.db, handle.deviceId, nodeA.id, 321.5, -45.25)

    const nodes = canvasRepo.listNodes(handle.db, canvas.id)
    expect(nodes.find((node) => node.id === nodeA.id)?.positionX).toBe(321.5)
    expect(nodes.find((node) => node.id === nodeA.id)?.positionY).toBe(-45.25)
    expect(nodes.find((node) => node.id === nodeB.id)?.positionX).toBe(nodeB.positionX)
  })

  it('移除节点不删源记录', () => {
    const canvas = canvasRepo.createCanvas(handle.db, handle.deviceId, '画布')
    const record = recordsRepo.createRecord(handle.db, handle.deviceId, recordDraft())
    const node = canvasRepo.addNode(handle.db, handle.deviceId, canvas.id, record.id)

    canvasRepo.removeNode(handle.db, handle.deviceId, node.id)

    expect(canvasRepo.listNodes(handle.db, canvas.id)).toHaveLength(0)
    expect(recordsRepo.getRecord(handle.db, record.id)).not.toBeNull()
  })

  it('删除记录时，引用它的画布节点被级联清掉', () => {
    const canvas = canvasRepo.createCanvas(handle.db, handle.deviceId, '画布')
    const record = recordsRepo.createRecord(handle.db, handle.deviceId, recordDraft())
    canvasRepo.addNode(handle.db, handle.deviceId, canvas.id, record.id)

    recordsRepo.deleteRecord(handle.db, handle.deviceId, record.id)

    expect(canvasRepo.listNodes(handle.db, canvas.id)).toHaveLength(0)
  })

  it('删除画布时节点一起消失，记录保留', () => {
    const canvas = canvasRepo.createCanvas(handle.db, handle.deviceId, '画布')
    const record = recordsRepo.createRecord(handle.db, handle.deviceId, recordDraft())
    canvasRepo.addNode(handle.db, handle.deviceId, canvas.id, record.id)

    canvasRepo.deleteCanvas(handle.db, handle.deviceId, canvas.id)

    expect(recordsRepo.getRecord(handle.db, record.id)).not.toBeNull()
    expect(canvasRepo.listCanvases(handle.db)).toHaveLength(0)
  })
})

describe('磁盘持久化', () => {
  it('关掉应用再打开：节点位置与画布都还在', () => {
    const canvas = canvasRepo.createCanvas(handle.db, handle.deviceId, '持久化')
    const record = recordsRepo.createRecord(handle.db, handle.deviceId, recordDraft({ title: '留下的卡片' }))
    const node = canvasRepo.addNode(handle.db, handle.deviceId, canvas.id, record.id)
    canvasRepo.moveNode(handle.db, handle.deviceId, node.id, 613.5, -128.25)

    const file = handle.sqlite.name
    const deviceId = handle.deviceId
    handle.close()
    handle = openDatabase(file)

    const reopened = canvasRepo.listNodes(handle.db, canvas.id)
    expect(reopened).toHaveLength(1)
    expect(reopened[0].positionX).toBe(613.5)
    expect(reopened[0].positionY).toBe(-128.25)
    expect(reopened[0].recordTitle).toBe('留下的卡片')
    expect(handle.deviceId).toBe(deviceId)
  })

  it('每次写操作都留一条 change log（同步的原料）', () => {
    const bean = coffee.createBean(handle.db, handle.deviceId, beanDraft())
    const entries = handle.db.select().from(changeLog).where(eq(changeLog.entityId, bean.id)).all()
    expect(entries).toHaveLength(1)
    expect(entries[0].operation).toBe('create')
    expect(entries[0].revision).toBe(1)
  })
})

describe('链接元数据持久化（§五 / §九）', () => {
  function linkDraft(overrides: Partial<RecordDraft> = {}): RecordDraft {
    return recordDraft({
      carrier: 'link',
      title: '',
      note: '',
      urlString: 'https://github.com/banmu123/BrewPhase',
      canonicalURL: 'https://github.com/banmu123/BrewPhase',
      platformContentID: 'banmu123/BrewPhase',
      provider: 'github',
      ...overrides
    })
  }

  function resolved(overrides: Partial<import('../../src/main/metadata/metadata-normalizer').ResolvedLinkMetadata> = {}) {
    return {
      provider: 'github' as const,
      contentId: 'banmu123/BrewPhase',
      canonicalUrl: 'https://github.com/banmu123/BrewPhase',
      title: 'banmu123/BrewPhase',
      description: 'Coffee studio',
      thumbnailUrl: 'https://opengraph.githubassets.com/1/banmu123/BrewPhase',
      sourceName: 'GitHub',
      authorName: 'banmu123',
      repositoryLanguage: 'Swift',
      repositoryStars: 12,
      repositoryForks: 3,
      repositoryLicense: 'MIT',
      status: 'success' as const,
      ...overrides
    }
  }

  it('新建链接记录：pending 状态，draft 里的 canonicalURL/contentId 落库', () => {
    const created = recordsRepo.createRecord(handle.db, handle.deviceId, linkDraft())
    expect(created.metadataStatus).toBe('pending')
    expect(created.canonicalURL).toBe('https://github.com/banmu123/BrewPhase')
    expect(created.platformContentID).toBe('banmu123/BrewPhase')
    expect(created.provider).toBe('github')
  })

  it('补全元数据：空字段被填，用户写过的标题/备注不被覆盖', () => {
    const withTitle = recordsRepo.createRecord(
      handle.db,
      handle.deviceId,
      linkDraft({ title: '我自己的标题', note: '我的备注' })
    )
    const updated = recordsRepo.applyResolvedMetadata(handle.db, handle.deviceId, withTitle.id, resolved())
    expect(updated?.title).toBe('我自己的标题')
    expect(updated?.note).toBe('我的备注')
    expect(updated?.summary).toBe('Coffee studio')
    expect(updated?.repositoryStars).toBe(12)
    expect(updated?.metadataStatus).toBe('ok')

    const emptyTitle = recordsRepo.createRecord(handle.db, handle.deviceId, linkDraft())
    const filled = recordsRepo.applyResolvedMetadata(handle.db, handle.deviceId, emptyTitle.id, resolved())
    expect(filled?.title).toBe('banmu123/BrewPhase')
  })

  it('刷新失败但已有成功结果：保留 ok 与旧数据', () => {
    const created = recordsRepo.createRecord(handle.db, handle.deviceId, linkDraft())
    recordsRepo.applyResolvedMetadata(handle.db, handle.deviceId, created.id, resolved())
    const failed = recordsRepo.applyResolvedMetadata(
      handle.db,
      handle.deviceId,
      created.id,
      resolved({ status: 'failed', thumbnailUrl: null, repositoryStars: null, description: null })
    )
    expect(failed?.metadataStatus).toBe('ok')
    expect(failed?.thumbnailURLString).toBe('https://opengraph.githubassets.com/1/banmu123/BrewPhase')
    expect(failed?.repositoryStars).toBe(12)
  })

  it('URL 修改后旧平台元数据被清空；标题保留', () => {
    const created = recordsRepo.createRecord(handle.db, handle.deviceId, linkDraft({ title: '旧标题' }))
    recordsRepo.applyResolvedMetadata(handle.db, handle.deviceId, created.id, resolved())

    const updated = recordsRepo.updateRecord(handle.db, handle.deviceId, created.id, {
      ...linkDraft({ title: '旧标题' }),
      urlString: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      canonicalURL: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      platformContentID: 'dQw4w9WgXcQ',
      provider: 'youtube'
    })
    expect(updated.provider).toBe('youtube')
    expect(updated.platformContentID).toBe('dQw4w9WgXcQ')
    expect(updated.thumbnailURLString).toBeNull()
    expect(updated.summary).toBe('')
    expect(updated.authorName).toBe('')
    expect(updated.repositoryStars).toBeNull()
    expect(updated.metadataStatus).toBe('pending')
    expect(updated.title).toBe('旧标题')
  })

  it('URL 未变时更新不清元数据', () => {
    const created = recordsRepo.createRecord(handle.db, handle.deviceId, linkDraft())
    recordsRepo.applyResolvedMetadata(handle.db, handle.deviceId, created.id, resolved())
    const updated = recordsRepo.updateRecord(handle.db, handle.deviceId, created.id, {
      ...linkDraft({ title: '改个标题' })
    })
    expect(updated.thumbnailURLString).toBe('https://opengraph.githubassets.com/1/banmu123/BrewPhase')
    expect(updated.metadataStatus).toBe('ok')
  })

  it('非 link 载体：metadataStatus 为 idle，元数据写入不改变载体', () => {
    const created = recordsRepo.createRecord(handle.db, handle.deviceId, recordDraft({ carrier: 'text' }))
    expect(created.metadataStatus).toBe('idle')
  })
})
