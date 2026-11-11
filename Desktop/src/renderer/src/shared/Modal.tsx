import { useEffect, type ReactNode } from 'react'
import { useI18n } from '../i18n'

/**
 * 创建/录入类表单的浮窗容器。
 *
 * 复用设计体系里已有的 `.dialog-backdrop` / `.dialog`（z-index 100，高于详情
 * 侧栏的 60）：表单不再挤进页面流，标题、关闭、遮罩与 Esc 的语义统一收口。
 * 内容仍由调用方提供——这里不碰任何表单状态、校验或提交逻辑。
 */
export function Modal(props: {
  title: string
  onClose: () => void
  /** sm 400 / md 480 / lg 560，按字段多少选，避免一律窄或一律宽。 */
  width?: 'sm' | 'md' | 'lg'
  children: ReactNode
}) {
  const { t } = useI18n()

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
      >
        <div className="dialog__head">
          <span className="overline">{props.title}</span>
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
      </div>
    </div>
  )
}
