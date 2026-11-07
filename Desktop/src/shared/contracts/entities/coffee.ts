import { z } from 'zod'

/**
 * 咖啡模块的契约。字段名与 iOS 的 `Bean` / `Brew` / `Tasting` / `PhaseRule` /
 * `PhaseReminder` 一一对应（见 docs/DATA_MODEL_MAPPING.md），不做「桌面端更好听」
 * 的改名——两端要能互相读懂同一份数据。
 */

export const ROAST_LEVELS = ['light', 'medium', 'mediumDark', 'dark', 'espressoBlend'] as const
export const roastLevelSchema = z.enum(ROAST_LEVELS)
export type RoastLevel = z.infer<typeof roastLevelSchema>

export const BEAN_STATUSES = ['active', 'finished'] as const
export const beanStatusSchema = z.enum(BEAN_STATUSES)
export type BeanStatus = z.infer<typeof beanStatusSchema>

export const TASTING_SOURCES = ['manual', 'brew'] as const
export const tastingSourceSchema = z.enum(TASTING_SOURCES)

export const beanSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  roaster: z.string().max(120).default(''),
  origin: z.string().max(120).default(''),
  process: z.string().max(120).default(''),
  roastLevel: roastLevelSchema.default('medium'),
  roastDate: z.number().int().nullable().default(null),
  purchaseDate: z.number().int().nullable().default(null),
  openDate: z.number().int().nullable().default(null),
  weightG: z.number().min(0).max(100_000).default(0),
  remainingG: z.number().min(0).max(100_000).default(0),
  price: z.number().min(0).max(1_000_000).default(0),
  channel: z.string().max(120).default(''),
  imagePath: z.string().nullable().default(null),
  flavorTags: z.array(z.string().max(40)).max(40).default([]),
  notes: z.string().max(4_000).default(''),
  status: beanStatusSchema.default('active'),
  stockCountedAt: z.number().int().nullable().default(null),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type Bean = z.infer<typeof beanSchema>

export const beanDraftSchema = beanSchema.omit({ id: true, createdAt: true, updatedAt: true }).partial({
  roaster: true,
  origin: true,
  process: true,
  roastLevel: true,
  roastDate: true,
  purchaseDate: true,
  openDate: true,
  weightG: true,
  remainingG: true,
  price: true,
  channel: true,
  imagePath: true,
  flavorTags: true,
  notes: true,
  status: true,
  stockCountedAt: true
})
export type BeanDraft = z.infer<typeof beanDraftSchema>

export const brewSchema = z.object({
  id: z.string().uuid(),
  beanId: z.string().uuid(),
  date: z.number().int(),
  method: z.string().max(80).default(''),
  grinder: z.string().max(80).default(''),
  grindSize: z.string().max(40).default(''),
  waterTemp: z.number().min(0).max(100).default(0),
  coffeeG: z.number().min(0).max(500).default(0),
  waterG: z.number().min(0).max(5_000).default(0),
  timeSeconds: z.number().int().min(0).max(3_600).default(0),
  score: z.number().int().min(0).max(100).default(0),
  acidity: z.number().int().min(0).max(5).default(0),
  sweetness: z.number().int().min(0).max(5).default(0),
  bitterness: z.number().int().min(0).max(5).default(0),
  body: z.number().int().min(0).max(5).default(0),
  aftertaste: z.number().int().min(0).max(5).default(0),
  flavorTags: z.array(z.string().max(40)).max(40).default([]),
  notes: z.string().max(4_000).default(''),
  /** 实际从库存扣掉的克数；旧数据可能为 null（按 coffeeG 退）。 */
  stockDeductedG: z.number().min(0).nullable().default(null),
  createdAt: z.number().int()
})
export type Brew = z.infer<typeof brewSchema>

export const brewDraftSchema = brewSchema.omit({ id: true, createdAt: true, stockDeductedG: true })
export type BrewDraft = z.infer<typeof brewDraftSchema>

export const tastingSchema = z.object({
  id: z.string().uuid(),
  beanId: z.string().uuid(),
  brewId: z.string().uuid().nullable().default(null),
  date: z.number().int(),
  dayAfterRoast: z.number().int().min(0).max(365).default(0),
  flavorTags: z.array(z.string().max(40)).max(40).default([]),
  score: z.number().int().min(0).max(100).default(0),
  notes: z.string().max(4_000).default(''),
  source: tastingSourceSchema.default('manual'),
  createdAt: z.number().int()
})
export type Tasting = z.infer<typeof tastingSchema>

export const tastingDraftSchema = tastingSchema.omit({ id: true, createdAt: true })
export type TastingDraft = z.infer<typeof tastingDraftSchema>

export const phaseRuleSchema = z.object({
  id: z.string().uuid(),
  roastLevel: roastLevelSchema,
  restMinDays: z.number().int().min(0).max(365),
  restMaxDays: z.number().int().min(0).max(365),
  peakStartDay: z.number().int().min(0).max(365),
  peakEndDay: z.number().int().min(0).max(365),
  declineStartDay: z.number().int().min(0).max(365),
  enabled: z.boolean().default(true),
  updatedAt: z.number().int()
})
export type PhaseRule = z.infer<typeof phaseRuleSchema>

export const REMINDER_KINDS = ['windowOpens', 'windowClosing'] as const
export const reminderKindSchema = z.enum(REMINDER_KINDS)

/**
 * 提醒只同步**意图**（哪包豆、什么时机、什么时候该响），不同步 iOS 的系统通知
 * identifier——它属于设备本地，各端收到意图后自己重建本地通知。
 */
export const phaseReminderSchema = z.object({
  id: z.string().uuid(),
  beanId: z.string().uuid(),
  kind: reminderKindSchema,
  fireDate: z.number().int(),
  enabled: z.boolean().default(true),
  createdAt: z.number().int()
})
export type PhaseReminder = z.infer<typeof phaseReminderSchema>

/** 烘焙后的阶段，纯派生：由 PhaseRule + 烘焙天数算出，不落库。 */
export const BEAN_PHASES = ['resting', 'opening', 'peak', 'declining'] as const
export type BeanPhase = (typeof BEAN_PHASES)[number]

export const beanPhaseWindowSchema = z.object({
  phase: z.enum(['resting', 'peak', 'declining']),
  start: z.number().int(),
  end: z.number().int()
})
export type BeanPhaseWindow = z.infer<typeof beanPhaseWindowSchema>
