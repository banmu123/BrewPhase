import { formatProgressBytes } from './format'

/**
 * 下载进度：设置页与提醒条共用。
 *
 * 进度条用原生 `role="progressbar"` + `aria-valuenow`，屏幕阅读器能读到；
 * 百分比与字节数来自主进程推送的真实事件，不做任何插值或模拟。
 */
export function UpdateProgress({
  percent,
  transferred,
  total,
  label
}: {
  percent: number | null
  transferred: number | null
  total: number | null
  label: string
}) {
  const value = Math.max(0, Math.min(100, percent ?? 0))
  return (
    <div className="update-progress" data-testid="update-progress">
      <div className="update-progress__head">
        <span className="update-progress__label">{label}</span>
        <span className="update-progress__bytes">{formatProgressBytes(transferred, total)}</span>
      </div>
      <div
        className="update-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <div className="update-progress__bar" style={{ width: `${value}%` }} />
      </div>
    </div>
  )
}
