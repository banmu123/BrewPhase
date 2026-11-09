import type { Bean, Brew, Tasting } from '../../../shared/contracts'
import type { Db } from '../../database/client'
import { getBean, listBeans, listBrews, listTastings } from '../../database/repositories/coffee'
import { ApplicationError } from '../errors'

/**
 * 咖啡模块的业务入口。**V1 全部只读**：库存扣减/退还只存在于 Repository 的
 * 冲煮写入路径（Renderer 与 iOS 同步），MCP 不提供任何写工具。
 *
 * 返回体按 AI 阅读习惯转成 snake_case；`image_path` 不进响应，只给 `has_image`。
 */

const DEFAULT_PAGE = 20
const MAX_PAGE = 100

export class CoffeeService {
  constructor(private readonly db: Db) {}

  listBeansForMcp(input: { status?: 'active' | 'finished'; limit?: number; offset?: number }) {
    const limit = clampPage(input.limit, DEFAULT_PAGE, MAX_PAGE)
    const offset = input.offset ?? 0
    const all = input.status ? listBeans(this.db).filter((bean) => bean.status === input.status) : listBeans(this.db)
    const items = all.slice(offset, offset + limit)
    return { items: items.map(beanDto), limit, offset, has_more: all.length > offset + limit }
  }

  getBeanForMcp(beanId: string) {
    const bean = requireBean(this.db, beanId)
    const brews = listBrews(this.db, beanId)
    const tastings = listTastings(this.db, beanId)
    return {
      bean: beanDto(bean),
      brew_count: brews.length,
      tasting_count: tastings.length,
      recent_brews: brews.slice(0, 5).map(brewDto)
    }
  }

  listBrewsForMcp(input: { beanId?: string; sinceMs?: number; limit?: number; offset?: number }) {
    const limit = clampPage(input.limit, DEFAULT_PAGE, MAX_PAGE)
    const offset = input.offset ?? 0
    if (input.beanId) requireBean(this.db, input.beanId)
    const all = listBrews(this.db, input.beanId ?? null).filter(
      (brew) => input.sinceMs === undefined || brew.date >= input.sinceMs
    )
    const items = all.slice(offset, offset + limit)
    return { items: items.map(brewDto), limit, offset, has_more: all.length > offset + limit }
  }

  listTastingsForMcp(input: { beanId?: string; sinceMs?: number; limit?: number; offset?: number }) {
    const limit = clampPage(input.limit, DEFAULT_PAGE, MAX_PAGE)
    const offset = input.offset ?? 0
    if (input.beanId) requireBean(this.db, input.beanId)
    const all = listTastings(this.db, input.beanId ?? null).filter(
      (tasting) => input.sinceMs === undefined || tasting.date >= input.sinceMs
    )
    const items = all.slice(offset, offset + limit)
    return { items: items.map(tastingDto), limit, offset, has_more: all.length > offset + limit }
  }

  summaryForMcp() {
    const beans = listBeans(this.db)
    const brews = listBrews(this.db, null)
    const tastings = listTastings(this.db, null)
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000
    const scored = tastings.filter((tasting) => tasting.score > 0)
    return {
      beans: {
        total: beans.length,
        active: beans.filter((bean) => bean.status === 'active').length,
        finished: beans.filter((bean) => bean.status === 'finished').length
      },
      brews: {
        total: brews.length,
        last_30_days: brews.filter((brew) => brew.date >= since).length
      },
      tastings: {
        total: tastings.length,
        average_score:
          scored.length > 0
            ? Math.round((scored.reduce((sum, tasting) => sum + tasting.score, 0) / scored.length) * 10) / 10
            : null
      }
    }
  }
}

function requireBean(db: Db, beanId: string): Bean {
  const bean = getBean(db, beanId)
  if (!bean) throw new ApplicationError('NOT_FOUND', `bean ${beanId} not found`)
  return bean
}

function beanDto(bean: Bean) {
  const { imagePath, ...rest } = bean
  return {
    id: rest.id,
    name: rest.name,
    roaster: rest.roaster,
    origin: rest.origin,
    process: rest.process,
    roast_level: rest.roastLevel,
    roast_date: rest.roastDate,
    purchase_date: rest.purchaseDate,
    open_date: rest.openDate,
    weight_g: rest.weightG,
    remaining_g: rest.remainingG,
    price: rest.price,
    channel: rest.channel,
    has_image: imagePath !== null,
    flavor_tags: rest.flavorTags,
    notes: rest.notes,
    status: rest.status,
    stock_counted_at: rest.stockCountedAt,
    /** 由 roast_date 现算；没有烘焙日期就是 null（不写 0 冒充 Day 0）。 */
    days_since_roast: daysSince(rest.roastDate),
    created_at: rest.createdAt,
    updated_at: rest.updatedAt
  }
}

function brewDto(brew: Brew) {
  return {
    id: brew.id,
    bean_id: brew.beanId,
    date: brew.date,
    method: brew.method,
    grinder: brew.grinder,
    grind_size: brew.grindSize,
    water_temp: brew.waterTemp,
    coffee_g: brew.coffeeG,
    water_g: brew.waterG,
    time_seconds: brew.timeSeconds,
    score: brew.score,
    acidity: brew.acidity,
    sweetness: brew.sweetness,
    bitterness: brew.bitterness,
    body: brew.body,
    aftertaste: brew.aftertaste,
    flavor_tags: brew.flavorTags,
    notes: brew.notes,
    stock_deducted_g: brew.stockDeductedG,
    created_at: brew.createdAt
  }
}

function tastingDto(tasting: Tasting) {
  return {
    id: tasting.id,
    bean_id: tasting.beanId,
    brew_id: tasting.brewId,
    date: tasting.date,
    day_after_roast: tasting.dayAfterRoast,
    flavor_tags: tasting.flavorTags,
    score: tasting.score,
    notes: tasting.notes,
    source: tasting.source,
    created_at: tasting.createdAt
  }
}

function daysSince(timestamp: number | null): number | null {
  if (timestamp === null) return null
  const day = 24 * 60 * 60 * 1000
  return Math.floor((Date.now() - timestamp) / day)
}

function clampPage(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}
