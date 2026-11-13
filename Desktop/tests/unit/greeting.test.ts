import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GREETING_BOUNDARY_HOURS,
  GREETING_KEYS,
  GREETING_RULES,
  getTimeGreeting,
  msUntilNextBoundary,
  nextGreetingBoundary,
  type GreetingKey
} from '../../src/shared/greeting'
import { zhCN } from '../../src/renderer/src/i18n/messages/zh-CN'
import { enUS } from '../../src/renderer/src/i18n/messages/en-US'

/**
 * 动态问候的时间规则。
 *
 * 时间一律用 `new Date(y, m, d, h, mi)` 构造——这是**本地时间**构造器，
 * 无论 CI 跑在哪个时区，04:59 就是设备本地 04:59，不会因为 runner 时区
 * 把边界点挪走。UTC 相关行为单独用 getUTCHours 对照验证。
 */

function local(hour: number, minute = 0, day = 13, month = 10, year = 2026): Date {
  return new Date(year, month, day, hour, minute, 0, 0)
}

describe('getTimeGreeting：五段时间区间', () => {
  it.each([
    [0, 0, 'lateNight'],
    [4, 59, 'lateNight'],
    [5, 0, 'morning'],
    [10, 59, 'morning'],
    [11, 0, 'midday'],
    [13, 59, 'midday'],
    [14, 0, 'afternoon'],
    [17, 59, 'afternoon'],
    [18, 0, 'evening'],
    [23, 59, 'evening']
  ] as const)('%s:%s → %s', (hour, minute, expected) => {
    expect(getTimeGreeting(local(hour, minute))).toBe(expected)
  })

  it('区间内每一分钟都落在唯一一段，没有重叠也没有空档', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      for (let minute = 0; minute < 60; minute += 1) {
        const key = getTimeGreeting(local(hour, minute))
        expect(GREETING_KEYS, `${hour}:${minute}`).toContain(key)
        // 同一分钟内不会有两段同时命中（函数只返回一个值），这里验证
        // 该分钟落在规则表里唯一的一个半开区间内。
        const hits = GREETING_RULES.filter((rule) => {
          const nextStart = GREETING_BOUNDARY_HOURS.find((boundary) => boundary > rule.startHour) ?? 24
          return hour >= rule.startHour && hour < nextStart
        })
        expect(hits, `${hour}:${minute} 应恰好命中一条规则`).toHaveLength(1)
        expect(hits[0]!.key).toBe(key)
      }
    }
  })

  it('规则表本身覆盖 0–23 点、边界升序、首段从 0 点开始', () => {
    expect(GREETING_BOUNDARY_HOURS).toEqual([0, 5, 11, 14, 18])
    expect(GREETING_RULES[0]!.startHour).toBe(0)
    const sorted = [...GREETING_BOUNDARY_HOURS].sort((a, b) => a - b)
    expect(GREETING_BOUNDARY_HOURS).toEqual(sorted)
  })

  it('传入 locale 不改变标识：文案由 i18n 决定，与时段判断正交', () => {
    const cases: Array<[number, GreetingKey]> = [
      [0, 'lateNight'], [5, 'morning'], [11, 'midday'], [14, 'afternoon'], [18, 'evening']
    ]
    for (const [hour, key] of cases) {
      expect(getTimeGreeting(local(hour), 'zh-CN')).toBe(key)
      expect(getTimeGreeting(local(hour), 'en-US')).toBe(key)
      expect(getTimeGreeting(local(hour), 'xx-YY')).toBe(key)
    }
  })
})

describe('严格使用设备本地时间', () => {
  const originalTZ = process.env.TZ
  afterEach(() => {
    if (originalTZ === undefined) delete process.env.TZ
    else process.env.TZ = originalTZ
    vi.unstubAllEnvs()
  })

  it('同一 UTC 时刻，在 UTC 与 Asia/Shanghai 下得到不同问候（不是按 UTC 小时算）', () => {
    // 2026-11-13 16:30 UTC = 上海 11-14 00:30（midnight），UTC 本地仍是 16:30。
    const instant = new Date('2026-11-13T16:30:00.000Z')
    process.env.TZ = 'UTC'
    expect(getTimeGreeting(instant)).toBe('afternoon')
    expect(instant.getUTCHours()).toBe(16)

    process.env.TZ = 'Asia/Shanghai'
    expect(instant.getHours()).toBe(0)
    expect(instant.getUTCHours()).toBe(16)
    expect(getTimeGreeting(instant)).toBe('lateNight')
  })

  it('系统时区切换后，下一次读取立即反映新时区', () => {
    const instant = new Date('2026-11-13T01:30:00.000Z') // UTC 01:30 / 上海 09:30
    process.env.TZ = 'UTC'
    expect(getTimeGreeting(instant)).toBe('lateNight')
    process.env.TZ = 'Asia/Shanghai'
    expect(getTimeGreeting(instant)).toBe('morning')
  })
})

describe('下一次时段边界与延时', () => {
  it.each([
    [0, 30, 5],
    [4, 59, 5],
    [5, 0, 11],
    [10, 59, 11],
    [11, 0, 14],
    [13, 59, 14],
    [14, 0, 18],
    [17, 59, 18],
    [18, 0, 0],
    [23, 59, 0]
  ] as const)('%s:%s → 下一边界 %s 点', (hour, minute, nextHour) => {
    const boundary = nextGreetingBoundary(local(hour, minute))
    expect(boundary.getHours()).toBe(nextHour)
    expect(boundary.getMinutes()).toBe(0)
    expect(boundary.getSeconds()).toBe(0)
    expect(boundary.getMilliseconds()).toBe(0)
  })

  it('18 点之后的边界是次日 0 点，跨月/跨年交给 Date 构造', () => {
    const beforeMidnight = nextGreetingBoundary(local(23, 59))
    expect(beforeMidnight.getDate()).toBe(14)

    const monthEnd = nextGreetingBoundary(local(23, 59, 30, 9)) // 10 月 30 日 23:59
    expect(monthEnd.getMonth()).toBe(9)
    expect(monthEnd.getDate()).toBe(31)

    const yearEnd = nextGreetingBoundary(local(23, 59, 31, 11)) // 12 月 31 日
    expect(yearEnd.getFullYear()).toBe(2027)
    expect(yearEnd.getMonth()).toBe(0)
    expect(yearEnd.getDate()).toBe(1)
  })

  it('延时 = 边界 - 当前时间；不会出现 0 / 负数 / 超过一天', () => {
    const now = local(10, 30)
    expect(msUntilNextBoundary(now)).toBe(30 * 60 * 1000)
    // 构造一个「时间被回拨」的场景：手工造的 Date 不可能让 delta 为负，
    // 但防御性下限与上限仍要可验证。
    const boundary = nextGreetingBoundary(now)
    expect(msUntilNextBoundary(new Date(boundary.getTime() - 1))).toBe(1)
    expect(msUntilNextBoundary(now)).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })
})

describe('i18n：问候与辅助文案都走语言包', () => {
  const zh = zhCN.studio
  const en = enUS.studio

  it('中英字典都有全部 5 个标识，且均为非空字符串', () => {
    for (const key of GREETING_KEYS) {
      expect(typeof zh.greeting[key], `zh ${key}`).toBe('string')
      expect(zh.greeting[key].length, `zh ${key}`).toBeGreaterThan(0)
      expect(typeof en.greeting[key], `en ${key}`).toBe('string')
      expect(en.greeting[key].length, `en ${key}`).toBeGreaterThan(0)
    }
  })

  it('中文文案与需求逐条一致', () => {
    expect(zh.greeting).toEqual({
      lateNight: '夜深了',
      morning: '上午好',
      midday: '中午好',
      afternoon: '下午好',
      evening: '晚上好'
    })
    expect(zh.greetingSubtitle).toBe('今天，也按自己的节奏来。')
  })

  it('英文使用自然表达，不逐字直译「中午好」', () => {
    expect(en.greeting.morning).toBe('Good morning')
    expect(en.greeting.midday).toBe('Good afternoon')
    expect(en.greeting.afternoon).toBe('Good afternoon')
    expect(en.greeting.evening).toBe('Good evening')
    expect(en.greeting.lateNight).toBe("It's late")
    expect(en.greetingSubtitle).toBe('Take today at your own pace.')
  })

  it('同一时段切换语言：标识不变、文案立即换', () => {
    const key = getTimeGreeting(local(9, 0))
    expect(key).toBe('morning')
    expect(zh.greeting[key]).toBe('上午好')
    expect(en.greeting[key]).toBe('Good morning')
    expect(zh.greetingSubtitle).not.toBe(en.greetingSubtitle)
  })

  it('原品牌主文案保留，没有随本次改动被删除', () => {
    expect(zh.title).toBe('为在意的事，留出位置。')
    expect(en.title).toBe('Make room for what matters.')
    // 首页不再用它们，但字典仍在，供 About / 宣传等场景复用。
    expect(zh.subtitle).toBe('你的桌面、你的收藏、你的想法。')
    expect(en.subtitle).toBe('Your desk. Your collections. Your ideas.')
  })
})
