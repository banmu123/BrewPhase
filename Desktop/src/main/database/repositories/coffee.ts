import { and, desc, eq, sql } from 'drizzle-orm'
import type { Bean, BeanDraft, Brew, BrewDraft, PhaseRule, Tasting, TastingDraft } from '../../../shared/contracts'
import type { Db } from '../client'
import { beans, brews, phaseRules, tastings } from '../schema'
import { recordChange } from './sync-log'
import { appliedDeduction, adjustForEdit, deductStock, isSettledForStock, refundStock } from '../../../shared/domain/inventory'

const TAG_SEPARATOR = '\u001F'

export function splitTags(raw: string): string[] {
  return raw
    .split(TAG_SEPARATOR)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

export function joinTags(tags: string[]): string {
  return tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .join(TAG_SEPARATOR)
}

// MARK: - Beans

export function listBeans(db: Db): Bean[] {
  return db.select().from(beans).orderBy(desc(beans.updatedAt)).all().map(toBean)
}

export function getBean(db: Db, id: string): Bean | null {
  const row = db.select().from(beans).where(eq(beans.id, id)).get()
  return row ? toBean(row) : null
}

export function createBean(db: Db, deviceId: string, draft: BeanDraft): Bean {
  const at = Date.now()
  const id = crypto.randomUUID()
  const weight = draft.weightG ?? 0
  // 新建时「剩余量」默认等于总量：用户不必为了买一包豆填两次数字。
  const remaining = draft.remainingG ?? weight

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped
      .insert(beans)
      .values({
        id,
        name: draft.name,
        roaster: draft.roaster ?? '',
        origin: draft.origin ?? '',
        process: draft.process ?? '',
        roastLevel: draft.roastLevel ?? 'medium',
        roastDate: draft.roastDate ?? null,
        purchaseDate: draft.purchaseDate ?? null,
        openDate: draft.openDate ?? null,
        weightG: weight,
        remainingG: remaining,
        price: draft.price ?? 0,
        channel: draft.channel ?? '',
        imagePath: draft.imagePath ?? null,
        flavorTagsRaw: joinTags(draft.flavorTags ?? []),
        notes: draft.notes ?? '',
        status: draft.status ?? 'active',
        stockCountedAt: draft.stockCountedAt ?? null,
        createdAt: at,
        updatedAt: at
      })
      .run()
    recordChange(scoped, { deviceId, entityType: 'bean', entityId: id, operation: 'create' })
  })

  return getBean(db, id)!
}

export function updateBean(db: Db, deviceId: string, id: string, draft: BeanDraft): Bean {
  const existing = getBean(db, id)
  if (!existing) throw new Error('bean not found')
  const at = Date.now()

  // 人工改剩余量 = 一次盘点：记下时刻，之前的冲煮不再参与自动退粉。
  const counted =
    draft.remainingG !== undefined && Math.abs(draft.remainingG - existing.remainingG) > 0.001
  const stockCountedAt = counted ? at : existing.stockCountedAt

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped
      .update(beans)
      .set({
        name: draft.name,
        roaster: draft.roaster ?? existing.roaster,
        origin: draft.origin ?? existing.origin,
        process: draft.process ?? existing.process,
        roastLevel: draft.roastLevel ?? existing.roastLevel,
        roastDate: draft.roastDate ?? existing.roastDate,
        purchaseDate: draft.purchaseDate ?? existing.purchaseDate,
        openDate: draft.openDate ?? existing.openDate,
        weightG: draft.weightG ?? existing.weightG,
        remainingG: draft.remainingG ?? existing.remainingG,
        price: draft.price ?? existing.price,
        channel: draft.channel ?? existing.channel,
        imagePath: draft.imagePath ?? existing.imagePath,
        flavorTagsRaw: draft.flavorTags ? joinTags(draft.flavorTags) : joinTags(existing.flavorTags),
        notes: draft.notes ?? existing.notes,
        status: draft.status ?? existing.status,
        stockCountedAt,
        updatedAt: at
      })
      .where(eq(beans.id, id))
      .run()
    recordChange(scoped, { deviceId, entityType: 'bean', entityId: id, operation: 'update' })
  })

  return getBean(db, id)!
}

export function deleteBean(db: Db, deviceId: string, id: string): void {
  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped.delete(beans).where(eq(beans.id, id)).run()
    recordChange(scoped, { deviceId, entityType: 'bean', entityId: id, operation: 'delete' })
  })
}

// MARK: - Brews

export function listBrews(db: Db, beanId: string | null): Brew[] {
  const rows = db
    .select()
    .from(brews)
    .where(beanId ? eq(brews.beanId, beanId) : undefined)
    .orderBy(desc(brews.date))
    .all()
  return rows.map(toBrew)
}

/**
 * 记一杯。
 *
 * 与 iOS `BrewRecorder.save` 同一个顺序：先扣库存（返回实扣量），再插记录，
 * 同一事务里写同步日志；库存扣减和记录必须一起成功或一起失败。
 */
export function createBrew(db: Db, deviceId: string, draft: BrewDraft): Brew {
  const bean = getBean(db, draft.beanId)
  if (!bean) throw new Error('bean not found')
  const at = Date.now()
  const id = crypto.randomUUID()
  const deduction = deductStock(bean.remainingG, draft.coffeeG)
  const day = dayAfterRoast(bean.roastDate, draft.date)

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    scoped
      .update(beans)
      .set({
        remainingG: deduction.remainingG,
        status: deduction.remainingG <= 0 ? 'finished' : bean.status,
        updatedAt: at
      })
      .where(eq(beans.id, bean.id))
      .run()

    scoped
      .insert(brews)
      .values({
        id,
        beanId: bean.id,
        date: draft.date,
        method: draft.method,
        grinder: draft.grinder,
        grindSize: draft.grindSize,
        waterTemp: draft.waterTemp,
        coffeeG: draft.coffeeG,
        waterG: draft.waterG,
        timeSeconds: draft.timeSeconds,
        score: draft.score,
        acidity: draft.acidity,
        sweetness: draft.sweetness,
        bitterness: draft.bitterness,
        body: draft.body,
        aftertaste: draft.aftertaste,
        flavorTagsRaw: joinTags(draft.flavorTags),
        notes: draft.notes,
        stockDeductedG: deduction.appliedG,
        createdAt: at
      })
      .run()

    // 镜像风味记录：一次冲煮同时留下一条品鉴，和 iOS 一致。
    if (day != null) {
      scoped
        .insert(tastings)
        .values({
          id: crypto.randomUUID(),
          beanId: bean.id,
          brewId: id,
          date: draft.date,
          dayAfterRoast: day,
          flavorTagsRaw: joinTags(draft.flavorTags),
          score: draft.score,
          notes: draft.notes,
          source: 'brew',
          createdAt: at
        })
        .run()
    }

    recordChange(scoped, { deviceId, entityType: 'brew', entityId: id, operation: 'create' })
    recordChange(scoped, { deviceId, entityType: 'bean', entityId: bean.id, operation: 'update' })
  })

  const created = db.select().from(brews).where(eq(brews.id, id)).get()
  if (!created) throw new Error('brew insert failed')
  return toBrew(created)
}

/**
 * 删一杯：退**实扣量**（不是粉量），带走它的镜像风味记录，并把豆子从
 * finished 恢复成 active。已被盘点结算过的一分不退。
 */
export function deleteBrew(db: Db, deviceId: string, id: string): void {
  const brew = db.select().from(brews).where(eq(brews.id, id)).get()
  if (!brew) return
  const bean = getBean(db, brew.beanId)
  const settled = bean ? isSettledForStock(brew.createdAt, bean.stockCountedAt) : true
  const at = Date.now()

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    if (bean && !settled) {
      const refunded = refundStock(bean.remainingG, appliedDeduction(toBrew(brew)))
      scoped
        .update(beans)
        .set({
          remainingG: refunded,
          status: bean.status === 'finished' && refunded > 0 ? 'active' : bean.status,
          updatedAt: at
        })
        .where(eq(beans.id, bean.id))
        .run()
    }

    scoped.delete(tastings).where(eq(tastings.brewId, id)).run()
    scoped.delete(brews).where(eq(brews.id, id)).run()
    recordChange(scoped, { deviceId, entityType: 'brew', entityId: id, operation: 'delete' })
    if (bean) recordChange(scoped, { deviceId, entityType: 'bean', entityId: bean.id, operation: 'update' })
  })
}

/**
 * 编辑一杯：按实扣量的**差值**调整库存（`adjustForEdit`），已结算的记录不改库存。
 * 编辑不重建记录，id 与 createdAt 都不变。
 */
export function updateBrew(db: Db, deviceId: string, id: string, draft: BrewDraft): Brew {
  const existing = db.select().from(brews).where(eq(brews.id, id)).get()
  if (!existing) throw new Error('brew not found')
  const bean = getBean(db, existing.beanId)
  if (!bean) throw new Error('bean not found')
  const settled = isSettledForStock(existing.createdAt, bean.stockCountedAt)
  const previousApplied = existing.stockDeductedG ?? existing.coffeeG
  const at = Date.now()

  db.transaction((tx) => {
    const scoped = tx as unknown as Db
    let stockDeductedG = existing.stockDeductedG
    if (!settled) {
      const adjusted = adjustForEdit({
        remainingG: bean.remainingG,
        nextCoffeeG: draft.coffeeG,
        previousAppliedG: previousApplied
      })
      scoped
        .update(beans)
        .set({ remainingG: adjusted.remainingG, updatedAt: at })
        .where(eq(beans.id, bean.id))
        .run()
      stockDeductedG = adjusted.appliedG
    } else {
      stockDeductedG = 0
    }

    scoped
      .update(brews)
      .set({
        date: draft.date,
        method: draft.method,
        grinder: draft.grinder,
        grindSize: draft.grindSize,
        waterTemp: draft.waterTemp,
        coffeeG: draft.coffeeG,
        waterG: draft.waterG,
        timeSeconds: draft.timeSeconds,
        score: draft.score,
        acidity: draft.acidity,
        sweetness: draft.sweetness,
        bitterness: draft.bitterness,
        body: draft.body,
        aftertaste: draft.aftertaste,
        flavorTagsRaw: joinTags(draft.flavorTags),
        notes: draft.notes,
        stockDeductedG
      })
      .where(eq(brews.id, id))
      .run()

    recordChange(scoped, { deviceId, entityType: 'brew', entityId: id, operation: 'update' })
    if (!settled) recordChange(scoped, { deviceId, entityType: 'bean', entityId: bean.id, operation: 'update' })
  })

  return toBrew(db.select().from(brews).where(eq(brews.id, id)).get()!)
}

// MARK: - Tastings

export function listTastings(db: Db, beanId: string | null): Tasting[] {
  const rows = db
    .select()
    .from(tastings)
    .where(beanId ? eq(tastings.beanId, beanId) : undefined)
    .orderBy(desc(tastings.date))
    .all()
  return rows.map(toTasting)
}

// MARK: - Phase rules

export function listPhaseRules(db: Db): PhaseRule[] {
  return db.select().from(phaseRules).all().map((row) => ({
    id: row.id,
    roastLevel: row.roastLevel as PhaseRule['roastLevel'],
    restMinDays: row.restMinDays,
    restMaxDays: row.restMaxDays,
    peakStartDay: row.peakStartDay,
    peakEndDay: row.peakEndDay,
    declineStartDay: row.declineStartDay,
    enabled: row.enabled,
    updatedAt: row.updatedAt
  }))
}

export type PhaseRuleDefaults = {
  roastLevel: string
  restMinDays: number
  restMaxDays: number
  peakStartDay: number
  peakEndDay: number
  declineStartDay: number
}

/** 首次启动写入五档默认规则（之后由用户/同步决定，不覆盖）。 */
export function seedPhaseRulesIfEmpty(db: Db, defaults: PhaseRuleDefaults[]): void {
  const count = db.select({ count: sql<number>`count(*)` }).from(phaseRules).get()?.count ?? 0
  if (count > 0) return
  const at = Date.now()
  db.insert(phaseRules)
    .values(
      defaults.map((rule) => ({
        id: crypto.randomUUID(),
        roastLevel: rule.roastLevel,
        restMinDays: rule.restMinDays,
        restMaxDays: rule.restMaxDays,
        peakStartDay: rule.peakStartDay,
        peakEndDay: rule.peakEndDay,
        declineStartDay: rule.declineStartDay,
        enabled: true,
        updatedAt: at
      }))
    )
    .run()
}

// MARK: - 行 → 契约

type BeanRow = typeof beans.$inferSelect
type BrewRow = typeof brews.$inferSelect
type TastingRow = typeof tastings.$inferSelect

function toBean(row: BeanRow): Bean {
  return {
    id: row.id,
    name: row.name,
    roaster: row.roaster,
    origin: row.origin,
    process: row.process,
    roastLevel: row.roastLevel as Bean['roastLevel'],
    roastDate: row.roastDate,
    purchaseDate: row.purchaseDate,
    openDate: row.openDate,
    weightG: row.weightG,
    remainingG: row.remainingG,
    price: row.price,
    channel: row.channel,
    imagePath: row.imagePath,
    flavorTags: splitTags(row.flavorTagsRaw),
    notes: row.notes,
    status: row.status as Bean['status'],
    stockCountedAt: row.stockCountedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toBrew(row: BrewRow): Brew {
  return {
    id: row.id,
    beanId: row.beanId,
    date: row.date,
    method: row.method,
    grinder: row.grinder,
    grindSize: row.grindSize,
    waterTemp: row.waterTemp,
    coffeeG: row.coffeeG,
    waterG: row.waterG,
    timeSeconds: row.timeSeconds,
    score: row.score,
    acidity: row.acidity,
    sweetness: row.sweetness,
    bitterness: row.bitterness,
    body: row.body,
    aftertaste: row.aftertaste,
    flavorTags: splitTags(row.flavorTagsRaw),
    notes: row.notes,
    stockDeductedG: row.stockDeductedG,
    createdAt: row.createdAt
  }
}

function toTasting(row: TastingRow): Tasting {
  return {
    id: row.id,
    beanId: row.beanId,
    brewId: row.brewId,
    date: row.date,
    dayAfterRoast: row.dayAfterRoast,
    flavorTags: splitTags(row.flavorTagsRaw),
    score: row.score,
    notes: row.notes,
    source: row.source as Tasting['source'],
    createdAt: row.createdAt
  }
}

function dayAfterRoast(roastDate: number | null, at: number): number | null {
  if (roastDate == null) return null
  const diff = Math.floor((at - roastDate) / 86_400_000)
  return Math.max(0, diff)
}
