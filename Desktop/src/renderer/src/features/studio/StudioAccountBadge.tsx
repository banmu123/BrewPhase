import { useEffect, useState } from 'react'
import type { AccountSnapshot } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { useAppStore } from '../../app/store'

/**
 * 首页问候区右上角的账户标识：头像 + 名称。
 *
 * 纪律：
 * - **未登录时什么都不渲染**：首页的默认形态不因为「有云账户这回事」而多一行占位；
 * - 只读 `AccountSnapshot` 的安全 DTO，拿不到也不需要任何 Token；
 * - 头像加载失败/缺失时退回首字母，不留破图；
 * - 点击直达设置页的「云账户」分类（复用 store 已有的 openSettings）。
 */
export function StudioAccountBadge() {
  const { t } = useI18n()
  const openSettings = useAppStore((state) => state.openSettings)
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null)
  const [avatarFailed, setAvatarFailed] = useState(false)

  useEffect(() => {
    let alive = true
    void api.account
      .status()
      .then((next) => {
        if (alive) setSnapshot(next)
      })
      .catch(() => {
        // 主进程异常时首页照常可用：只是不显示账户标识。
      })
    // 登录/退出/校验结果都会广播过来，首页跟着变，不需要轮询。
    const off = api.account.onChanged((next) => {
      if (alive) setSnapshot(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!snapshot || snapshot.state !== 'signed-in' || !snapshot.user) return null

  const user = snapshot.user
  const name =
    user.displayName?.trim() ||
    (snapshot.provider ? t.settings.account.providerName[snapshot.provider] : null) ||
    t.settings.account.signedIn
  const avatar = user.avatarUrl
  const showImage = Boolean(avatar) && !avatarFailed

  return (
    <button
      type="button"
      className="studio-account"
      title={t.settings.account.title}
      aria-label={`${t.settings.account.title}：${name}`}
      onClick={() => openSettings('account')}
    >
      {showImage ? (
        <img
          className="studio-account__avatar"
          src={avatar ?? ''}
          alt=""
          // 头像来自第三方 CDN：不带 Referer，也不参与缓存指纹。
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          onError={() => setAvatarFailed(true)}
        />
      ) : (
        <span className="studio-account__avatar studio-account__avatar--initial" aria-hidden="true">
          {Array.from(name)[0]?.toUpperCase() ?? '·'}
        </span>
      )}
      <span className="studio-account__name">{name}</span>
    </button>
  )
}
