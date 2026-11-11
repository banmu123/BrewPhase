import { useEffect } from 'react'
import { useI18n } from '../i18n'
import { useAppStore } from './store'

/**
 * 首次启动引导（配对指引）。
 *
 * 只在打包版且「未看过、未配对」时出现（判定在 App.tsx：`info.onboardingEligible`
 * + localStorage 标记 + `sync.status().devices`）。使命只有一个——让用户完成
 * 一次配对；所以只有三步配对指引和两个出口，不写功能清单。
 */
const SEEN_KEY = 'bp.onboarding.seen'

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === 'yes'
  } catch {
    // localStorage 不可用（极端隐私配置）就当看过：引导不该变成每次启动的拦截。
    return true
  }
}

export function markOnboardingSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, 'yes')
  } catch {
    // 同上：写不进去也不阻塞流程。
  }
}

export function Onboarding({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const { openSettings } = useAppStore()
  const steps = [t.onboarding.step1, t.onboarding.step2, t.onboarding.step3]

  // Esc = 「先逛逛」：引导必须是可逃离的。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) finish(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function finish(goToSettings: boolean): void {
    markOnboardingSeen()
    if (goToSettings) openSettings('sync')
    onClose()
  }

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-label={t.onboarding.title}>
      <div className="onboarding__card">
        <span className="overline">{t.onboarding.overline}</span>
        <h1 className="onboarding__title">{t.onboarding.title}</h1>
        <p className="onboarding__lead">{t.onboarding.lead}</p>

        <ol className="onboarding__steps">
          {steps.map((step, index) => (
            <li key={step} className="onboarding__step">
              <span className="onboarding__step-index">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        <div className="onboarding__actions">
          <button className="button button--primary" onClick={() => finish(true)}>
            {t.onboarding.openSettings}
          </button>
          <button className="button button--ghost" onClick={() => finish(false)}>
            {t.onboarding.later}
          </button>
        </div>

        <p className="onboarding__note">{t.onboarding.privacyNote}</p>
      </div>
    </div>
  )
}
