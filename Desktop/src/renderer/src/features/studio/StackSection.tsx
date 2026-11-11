import type { CSSProperties, ReactNode } from 'react'

/**
 * 首页三个空间的共用外壳：只负责「这是一层内容」的标题、进入入口与点击语义。
 * 堆叠本身由各自的 Stack 组件渲染，三种表现不混在一起。
 *
 * Phase 1.1：外壳**不再是一块面板**——没有背景、没有边框、没有圆角，
 * 只有一条压在标题上方的发丝线。空间靠留白、字号与构图区分，而不是靠
 * 三个灰绿色矩形把内容装起来。
 *
 * 入口按钮的 aria-label 用空间名（t.navigation.*），让键盘/读屏与既有
 * e2e 流程都能稳定找到它；整个 section 也可点击，但不嵌套 button。
 * `count` 只有在数据源能给出**准确总数**时才传（Coffee / Canvas）；
 * Records 的列表是分页预览，报「8 条」会骗人，所以不给。
 */
export function StackSection(props: {
  space: 'coffee' | 'records' | 'canvas'
  overline: string
  label: string
  hint: string
  count?: string
  openLabel: string
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <section
      className={`studio-space studio-space--${props.space}`}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onOpen()
        }
      }}
      tabIndex={0}
      aria-label={props.label}
    >
      <div className="studio-space__head">
        <div className="studio-space__meta">
          <span className="overline">{props.overline}</span>
          {props.count && <span className="studio-space__count">{props.count}</span>}
        </div>

        <div className="studio-space__heading">
          <h2 className="studio-space__title">{props.label}</h2>
          <button
            type="button"
            className="studio-space__open"
            aria-label={props.label}
            onClick={(event) => {
              event.stopPropagation()
              props.onOpen()
            }}
          >
            {props.openLabel}
            <span aria-hidden="true">↗</span>
          </button>
        </div>

        <p className="studio-space__hint">{props.hint}</p>
      </div>

      <div className="studio-space__stage">{props.children}</div>
    </section>
  )
}

/**
 * 给每张堆叠卡片传索引与初始倾角：CSS 用 `--i` 算错位与展开量，
 * 用 `--r` 做「随手摆上去」的轻微旋转（Records 不倾斜，保持可读）。
 */
export function stackStyle(index: number, tilt = 0): CSSProperties {
  return { '--i': index, '--r': `${tilt}deg` } as CSSProperties
}
