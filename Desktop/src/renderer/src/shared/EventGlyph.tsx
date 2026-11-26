import type { ReactNode } from 'react'

/**
 * 事件类型字形 —— **DOM 版**（R6-4.1.1 §4.2）。
 *
 * Konva 画不了 DOM/SVG，所以画布上的字形在 `JourneyGroupShape.tsx` 里用
 * `sceneFunc` 描边；这里是同一组形状的 SVG 版本，供 Records 卡片、
 * Journey 详情、Inspector 使用——**两套必须长得一样**，否则同一个事件
 * 在画布和详情里认不出来。
 *
 * 只用 `currentColor` + `fill="none"`：颜色由外层 CSS 变量给，
 * 这里不持有任何色值，也不引入图标依赖。
 */

export type JourneyEventType =
  | 'user_input'
  | 'plan'
  | 'decision'
  | 'execution'
  | 'observation'
  | 'revision'
  | 'verification'
  | 'outcome'
  | 'user_annotation'

/** 九类事件的 CSS 变量名（与 app.css 的 --event-* 一一对应）。 */
export const EVENT_ACCENT_VAR: Record<JourneyEventType, string> = {
  user_input: '--event-user-input',
  plan: '--event-plan',
  decision: '--event-decision',
  execution: '--event-execution',
  observation: '--event-observation',
  revision: '--event-revision',
  verification: '--event-verification',
  outcome: '--event-outcome',
  user_annotation: '--event-user-annotation'
}

/** 未知类型退回一个中性圆点，绝不因为多一个类型就崩掉整块 UI。 */
export function eventTypeAccent(type: string): string {
  return EVENT_ACCENT_VAR[type as JourneyEventType] ?? '--ink-faint'
}

const PATHS: Record<JourneyEventType, ReactNode> = {
  /* 用户需求：对话气泡 */
  user_input: (
    <>
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="3" />
      <path d="M5 11 L5 14.5 L8.5 11" />
    </>
  ),
  /* 计划：三条带项目点的横线 */
  plan: (
    <>
      <path d="M6.5 4.2 L14.5 4.2 M6.5 8.5 L14.5 8.5 M6.5 12.8 L14.5 12.8" />
      <circle cx="3.2" cy="4.2" r="1.3" />
      <circle cx="3.2" cy="8.5" r="1.3" />
      <circle cx="3.2" cy="12.8" r="1.3" />
    </>
  ),
  /* 决策：菱形 */
  decision: <path d="M8 1.5 L14.5 8 L8 14.5 L1.5 8 Z" />,
  /* 执行：播放三角 */
  execution: <path d="M4.5 2.5 L14 8 L4.5 13.5 Z" />,
  /* 观察：眼睛 */
  observation: (
    <>
      <path d="M1.5 8 Q8 1.8 14.5 8 Q8 14.2 1.5 8 Z" />
      <circle cx="8" cy="8" r="2.3" />
    </>
  ),
  /* 修订：环形箭头 */
  revision: (
    <>
      <path d="M12.6 4.9 A5.4 5.4 0 1 0 12.9 9.6" />
      <path d="M11.4 4.6 L13.9 6.4 L11.9 8.6" />
    </>
  ),
  /* 验证：对勾 */
  verification: <path d="M2 8.6 L6.4 13.2 L14 3.4" />,
  /* 结果：旗帜 */
  outcome: (
    <>
      <path d="M4.2 14.5 L4.2 2.4" />
      <path d="M4.2 3 L13.6 5.6 L4.2 8.4 Z" />
    </>
  ),
  /* 用户补充：铅笔（与 Agent 事件的几何形明显不同） */
  user_annotation: (
    <>
      <path d="M2.4 13.6 L4 9.8 L11.8 2.6 L14.2 5 L6.6 12.6 Z" />
      <path d="M2.4 13.6 L6.6 12.6" />
    </>
  )
}

export function EventGlyph(props: {
  type: string
  size?: number
  /** 传 CSS 变量名或直接传色值；不传则继承 currentColor。 */
  accent?: string
  className?: string
}) {
  const size = props.size ?? 16
  const path = PATHS[props.type as JourneyEventType]
  /*
   * 颜色走 CSS 变量：`var(--…)` 作为**样式**比作为呈现属性更可靠
   * （呈现属性的 var() 支持在不同引擎上不一致）。不传 accent 就继承
   * currentColor，让外层文字色决定字形色。
   */
  const strokeStyle = props.accent
    ? {
        stroke: `var(${props.accent.startsWith('--') ? props.accent : `--${props.accent}`})`
      }
    : undefined
  return (
    <svg
      className={props.className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none', ...strokeStyle }}
    >
      {path ?? <circle cx="8" cy="8" r="6" />}
    </svg>
  )
}
