import type { ReactNode } from 'react'
import { useAppStore } from '../../app/store'
import { useI18n } from '../../i18n'

/**
 * 三个空间各自的空状态：不是「暂无数据 + 按钮」，而是这个空间
 * **尚未被使用时的样子**——架子、卡片堆、创作桌的空白载体。
 *
 * 装饰元素全部是纯 UI（div / span，aria-hidden），不进任何业务数据流；
 * 按钮只调用既有的 `requestCreate` 流程（由目标空间页消费），
 * 这里不重复实现任何表单。
 */

/** 空状态公共骨架：一小段文案 + 一组轻入口 + 装饰舞台（children）。 */
function EmptyShell(props: {
  variant: 'coffee' | 'records' | 'canvas'
  title: string
  hint: string
  actions: ReactNode
  children: ReactNode
}) {
  return (
    <div className={`studio-empty studio-empty--${props.variant}`}>
      <div className="studio-empty__stage" aria-hidden="true">
        {props.children}
      </div>
      <div className="studio-empty__copy">
        <p className="studio-empty__title">{props.title}</p>
        <p className="studio-empty__hint">{props.hint}</p>
        <div className="studio-empty__actions">{props.actions}</div>
      </div>
    </div>
  )
}

function EmptyAction(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="studio-empty__action"
      onClick={(event) => {
        event.stopPropagation()
        props.onClick()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span aria-hidden="true">+</span> {props.label}
    </button>
  )
}

/** Coffee：空的收藏架——几只错位摆放的豆袋轮廓，等着被真实包装替换。 */
export function CoffeeEmpty() {
  const { t } = useI18n()
  const requestCreate = useAppStore((state) => state.requestCreate)
  return (
    <EmptyShell
      variant="coffee"
      title={t.studio.coffee.emptyTitle}
      hint={t.studio.coffee.emptyHint}
      actions={<EmptyAction label={t.studio.coffee.emptyAction} onClick={() => requestCreate('bean')} />}
    >
      <span className="studio-empty-coffee__bag studio-empty-coffee__bag--a" />
      <span className="studio-empty-coffee__bag studio-empty-coffee__bag--b" />
      <span className="studio-empty-coffee__bag studio-empty-coffee__bag--c" />
      {/* 第四只是更淡的轮廓：架子上还有空位，等着被真实的包装填满。 */}
      <span className="studio-empty-coffee__bag studio-empty-coffee__bag--d" />
      <span className="studio-empty-coffee__shelfline" />
    </EmptyShell>
  )
}

/** Records：空白灵感卡堆——三张未填写的收藏卡，轻轻叠在桌上。 */
export function RecordsEmpty() {
  const { t } = useI18n()
  const requestCreate = useAppStore((state) => state.requestCreate)
  return (
    <EmptyShell
      variant="records"
      title={t.studio.records.emptyTitle}
      hint={t.studio.records.emptyHint}
      actions={
        <>
          <EmptyAction label={t.studio.records.emptyNote} onClick={() => requestCreate('text')} />
          <EmptyAction label={t.studio.records.emptyLink} onClick={() => requestCreate('link')} />
        </>
      }
    >
      {/* 最前一张：照片轮廓 + 文字线条；后面两张只露出纸边 */}
      <span className="studio-empty-records__card studio-empty-records__card--back">
        <span className="studio-empty-records__lines" />
      </span>
      <span className="studio-empty-records__card studio-empty-records__card--middle">
        <span className="studio-empty-records__linkline" />
        <span className="studio-empty-records__lines" />
      </span>
      <span className="studio-empty-records__card studio-empty-records__card--front">
        <span className="studio-empty-records__frame" />
        <span className="studio-empty-records__lines">
          <span style={{ width: '86%' }} />
          <span style={{ width: '70%' }} />
          <span style={{ width: '78%' }} />
        </span>
      </span>
    </EmptyShell>
  )
}

/** Canvas：空白创作桌——两张错位的画布纸，浅网格提示这里可以开始构思。 */
export function CanvasEmpty() {
  const { t } = useI18n()
  const requestCreate = useAppStore((state) => state.requestCreate)
  return (
    <EmptyShell
      variant="canvas"
      title={t.studio.canvas.emptyTitle}
      hint={t.studio.canvas.emptyHint}
      actions={<EmptyAction label={t.studio.canvas.emptyAction} onClick={() => requestCreate('canvas')} />}
    >
      <span className="studio-empty-canvas__sheet studio-empty-canvas__sheet--back" />
      <span className="studio-empty-canvas__sheet studio-empty-canvas__sheet--front">
        <span className="studio-empty-canvas__grid" />
        <span className="studio-empty-canvas__node studio-empty-canvas__node--a" />
        <span className="studio-empty-canvas__node studio-empty-canvas__node--b" />
        <span className="studio-empty-canvas__link" />
      </span>
    </EmptyShell>
  )
}
