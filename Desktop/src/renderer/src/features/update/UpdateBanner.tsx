import { useI18n } from '../../i18n'

/**
 * 应用内更新提醒（非阻塞通知条）。
 *
 * 定位与形态的选择：
 * - 放在顶栏与工作区**之间**，占自己的一行高度：不覆盖任何内容，也就不可能
 *   挡住用户正在点的按钮（左下角浮层会把设置页的更新区块压在下面）；
 * - 没有遮罩、不抢焦点、不锁滚动——用户继续做手头的事，它只是「在那里」；
 * - 只由主窗口渲染。独立圆桌窗口与浏览器浮窗在 App 里更早就 return 了，
 *   压根不会走到这里（不是靠 CSS 藏起来）。
 *
 * 语义：`role="status"` + `aria-live="polite"`，出现时朗读一次；两个操作都是
 * 真按钮，Tab 可达，Enter/Space 触发；焦点在提醒条内时 Esc 等于「稍后提醒」。
 */
export function UpdateBanner({
  version,
  onLater,
  onOpen
}: {
  version: string
  onLater: () => void
  onOpen: () => void
}) {
  const { t } = useI18n()

  return (
    <aside
      className="update-banner"
      data-testid="update-banner"
      data-version={version}
      role="status"
      aria-live="polite"
      aria-label={t.updateNotice.region}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // 只处理落在 Banner 内的 Esc，不去抢全局的 Esc（弹窗/面板还要用）。
        event.stopPropagation()
        onLater()
      }}
    >
      <div className="update-banner__text">
        <p className="update-banner__title">{t.updateNotice.title}</p>
        <p className="update-banner__body">{t.updateNotice.description(version)}</p>
      </div>
      <div className="update-banner__actions">
        <button type="button" className="button button--ghost" onClick={onLater}>
          {t.updateNotice.later}
        </button>
        <button type="button" className="button button--primary" onClick={onOpen}>
          {t.updateNotice.open}
        </button>
      </div>
    </aside>
  )
}
