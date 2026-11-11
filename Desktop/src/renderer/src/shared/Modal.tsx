import { useEffect, useId, type ReactNode } from 'react'
import { useI18n } from '../i18n'

/**
 * 创建/录入类表单的浮窗容器。
 *
 * 复用设计体系里已有的 `.dialog-backdrop` / `.dialog`（z-index 100，高于详情
 * 侧栏的 60）：表单不再挤进页面流，标题、关闭、遮罩与 Esc 的语义统一收口。
 * 内容仍由调用方提供——这里不碰任何表单状态、校验或提交逻辑。
 *
 * 底栏用 `footer` 传入：动作区与正文分层，长表单滚动时按钮不会被卷走。
 */
export function Modal(props: {
  title: string
  onClose: () => void
  /** sm 400 / md 480 / lg 560，按字段多少选，避免一律窄或一律宽。 */
  width?: 'sm' | 'md' | 'lg'
  /** 右侧对齐的动作区；不传则不渲染底栏（画布那种单输入框的短弹窗）。 */
  footer?: ReactNode
  children: ReactNode
}) {
  const { t } = useI18n()
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      props.onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [props.onClose])

  return (
    <div
      className="dialog-backdrop"
      // 只认遮罩本身的按下；在卡片内部拖拽/选择文字不会误关。
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        className="dialog"
        data-width={props.width ?? 'md'}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        aria-labelledby={titleId}
      >
        <div className="dialog__head">
          <h2 className="dialog__title" id={titleId}>
            {props.title}
          </h2>
          <button
            className="dialog__close"
            type="button"
            aria-label={t.common.close}
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>
        <div className="dialog__body">{props.children}</div>
        {props.footer ? <div className="dialog__foot">{props.footer}</div> : null}
      </div>
    </div>
  )
}
