import type { ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { api } from '../../shared/api'
import { UpdateProgress } from './UpdateProgress'
import { useUpdateStore } from './update-store'

/**
 * 应用内更新提醒（非阻塞通知条）。
 *
 * 同一条通知承担整个更新过程的状态展示：
 * 发现新版本 → 下载进度 → 正在安装并重启；失败时变成可重试的错误条。
 * 始终只有这一条——它由主进程唯一的状态推导，下载进度不会额外再弹一个。
 *
 * 定位与形态：
 * - 放在顶栏与工作区**之间**，占自己的一行高度：不覆盖任何内容，
 *   也就不可能挡住用户正在点的按钮；
 * - 没有遮罩、不抢焦点、不锁滚动——用户继续做手头的事；
 * - 只由主窗口渲染。独立圆桌窗口与浏览器浮窗在 App 里更早就 return 了，
 *   压根不会走到这里（不是靠 CSS 藏起来）。
 *
 * 语义：`role="status"` + `aria-live="polite"`，出现时朗读一次；所有操作都是
 * 真按钮，Tab 可达；焦点在提醒条内时 Esc 等于「稍后提醒」（仅提示阶段）。
 */
export function UpdateBanner() {
  const { t } = useI18n()
  const state = useUpdateStore((s) => s.state)
  const postpone = useUpdateStore((s) => s.postpone)
  const download = useUpdateStore((s) => s.download)
  const check = useUpdateStore((s) => s.check)

  if (!state) return null

  const version = state.latestVersion ?? state.currentVersion
  const openRelease = (): void => {
    void api.update.openRelease().catch(() => undefined)
  }

  const actions = ((): ReactNode => {
    if (state.phase === 'available') {
      return (
        <>
          <button type="button" className="button button--ghost" onClick={postpone}>
            {t.updateNotice.later}
          </button>
          {state.autoUpdate ? (
            <button type="button" className="button button--primary" onClick={() => void download()}>
              {t.updateNotice.updateNow}
            </button>
          ) : (
            <button type="button" className="button button--primary" onClick={openRelease}>
              {t.updateNotice.manual}
            </button>
          )}
        </>
      )
    }
    if (state.phase === 'error') {
      // 下载失败重试下载；检查失败重试检查——按失败发生的环节分派。
      const retry = state.failedAt === 'download' ? download : () => check(true)
      return (
        <>
          {state.downloadUrl && (
            <button type="button" className="button button--ghost" onClick={openRelease}>
              {t.updateNotice.manual}
            </button>
          )}
          <button type="button" className="button button--primary" onClick={() => void retry()}>
            {t.updateNotice.retry}
          </button>
        </>
      )
    }
    // 下载/安装期间没有可点的操作：重复触发已经由主进程挡掉，
    // 这里干脆不给按钮，避免用户以为点一下能更快。
    return null
  })()

  const body = ((): string => {
    switch (state.phase) {
      case 'downloading':
        // 进度条自己带「正在下载更新… 19%」，正文不再重复一遍。
        return ''
      case 'downloaded':
        return t.updateNotice.downloaded
      case 'installing':
        return t.updateNotice.installing
      case 'error':
        return state.error ?? t.updateNotice.failed
      default:
        return t.updateNotice.description(version)
    }
  })()

  const title = state.phase === 'error' ? t.updateNotice.failed : t.updateNotice.title
  const showRestartHint = state.phase === 'available' && state.autoUpdate
  const showProgress =
    state.phase === 'downloading' || state.phase === 'downloaded' || state.phase === 'installing'

  return (
    <aside
      className="update-banner"
      data-testid="update-banner"
      data-phase={state.phase}
      data-version={version}
      role="status"
      aria-live="polite"
      aria-label={t.updateNotice.region}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || state.phase !== 'available') return
        // 只处理落在提醒条内的 Esc，不去抢全局的 Esc（弹窗/面板还要用）。
        event.stopPropagation()
        postpone()
      }}
    >
      <div className="update-banner__row">
        <div className="update-banner__text">
          <p className="update-banner__title">{title}</p>
          {body && <p className="update-banner__body">{body}</p>}
          {showRestartHint && <p className="update-banner__hint">{t.updateNotice.restartHint}</p>}
        </div>
        {actions && <div className="update-banner__actions">{actions}</div>}
      </div>
      {showProgress && (
        <UpdateProgress
          percent={state.percent}
          transferred={state.transferred}
          total={state.total}
          label={
            state.phase === 'downloading'
              ? t.updateNotice.downloading(state.percent ?? 0)
              : state.phase === 'downloaded'
                ? t.updateNotice.downloaded
                : t.updateNotice.installing
          }
        />
      )}
    </aside>
  )
}
