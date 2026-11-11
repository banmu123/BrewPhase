import { useEffect, useId, useRef, useSyncExternalStore } from 'react'

/**
 * 确认框：全应用只有这一份呈现。
 *
 * 以前删除走 `window.confirm()`（系统对话框，样式不可控、与应用完全两个世界），
 * 画布那块又是手写的裸 DOM——直接塞进不带内边距的 `.dialog` 里，文字会顶到
 * 卡片边缘。现在两种用法共用同一套壳：
 *
 * 1. `<ConfirmDialog />` 受控用法（调用方自己持有开关状态）；
 * 2. `await confirmAction({...})` 命令用法，替换 `window.confirm` 的同步分支。
 *
 * 语义上按 `role="alertdialog"` 处理：打开时焦点落在**取消**（破坏性动作永远
 * 不该是默认回车目标），Esc 与点遮罩都取消。
 */

export type ConfirmTone = 'default' | 'danger'

export type ConfirmRequest = {
  /** 一句话说明要发生什么，如「删除这块画布？」 */
  title: string
  /** 后果与边界，可省略；不要重复标题。 */
  description?: string
  confirmLabel: string
  cancelLabel: string
  tone?: ConfirmTone
}

export function ConfirmDialog(
  props: ConfirmRequest & { onConfirm: () => void; onCancel: () => void }
) {
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      props.onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [props.onCancel])

  const danger = props.tone === 'danger'

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onCancel()
      }}
    >
      <div
        className="dialog dialog--confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="dialog__head">
          <h2 className="dialog__title" id={titleId}>
            {props.title}
          </h2>
        </div>
        {props.description ? (
          <div className="dialog__body">
            <p className="dialog__note">{props.description}</p>
          </div>
        ) : null}
        <div className="dialog__foot">
          <button ref={cancelRef} className="button" type="button" onClick={props.onCancel}>
            {props.cancelLabel}
          </button>
          <button
            className={danger ? 'button button--danger-solid' : 'button button--primary'}
            type="button"
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
   命令式入口：`await confirmAction(...)` 直接拿 boolean，调用点保持
   「if (!ok) return」的形状，不必为每个页面各写一份弹窗状态。
   ------------------------------------------------------------------------- */

type PendingConfirm = { request: ConfirmRequest; resolve: (confirmed: boolean) => void }

let pending: PendingConfirm | null = null
let snapshot: ConfirmRequest | null = null
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = pending?.request ?? null
  for (const listener of listeners) listener()
}

/**
 * 打开确认框并等待结果。
 *
 * 同一时刻只允许一个：后来的请求直接返回 false，而不是把两个弹窗叠在一起。
 * 调用方都包在 `if (!(await ...)) return` 里，false 就是「什么都不做」。
 */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  if (pending) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    pending = { request, resolve }
    publish()
  })
}

function settle(confirmed: boolean): void {
  const current = pending
  pending = null
  publish()
  current?.resolve(confirmed)
}

/** 挂在 App 根部；`confirmAction` 的弹窗就渲染在这里。 */
export function ConfirmHost() {
  const request = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => snapshot,
    () => null
  )

  if (!request) return null
  return <ConfirmDialog {...request} onConfirm={() => settle(true)} onCancel={() => settle(false)} />
}
