import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useAppStore } from './store'
import { OnboardingAgent } from './OnboardingAgent'

/**
 * 首次启动引导（统一入口）。
 *
 * 三条路：连接 AI Agent / 配对移动设备 / 先进入。两条配置路径都是可选的，
 * 引导本身必须随时可退出——它不是许可证协议。
 *
 * 版本标记的兼容是这里最容易被忽略的一点：
 * - 旧版只有一个 `bp.onboarding.seen`，看过它的老用户不该因为升级又被弹一次；
 * - 已配对过的用户也不该被突然拦住。
 * 所以判定顺序是「看过新版 → 退出」「看过旧版或已配对 → 静默补标记 → 退出」，
 * 只有真正的新用户才会看到引导。
 */

const SEEN_KEY = 'bp.onboarding.seen'
const SEEN_V2_KEY = 'bp.onboarding.v2.seen'

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'yes'
  } catch {
    // localStorage 不可用（极端隐私配置）就当看过：引导不该变成每次启动的拦截。
    return true
  }
}

/** 旧版标记，保留导出供设置页与测试判断历史行为。 */
export function hasSeenOnboarding(): boolean {
  return readFlag(SEEN_KEY)
}

export function hasSeenOnboardingV2(): boolean {
  return readFlag(SEEN_V2_KEY)
}

/** 两个标记一起写：老版本回退时也不会再弹。 */
export function markOnboardingSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, 'yes')
    localStorage.setItem(SEEN_V2_KEY, 'yes')
  } catch {
    // 写不进去也不阻塞流程。
  }
}

type Stage = 'welcome' | 'pairing' | 'agent'

export function Onboarding({
  onClose,
  initialStage = 'welcome'
}: {
  onClose: () => void
  /** 从设置页重新打开时直接进 AI 分支，不必再看一遍欢迎页。 */
  initialStage?: Stage
}) {
  const { t } = useI18n()
  const { openSettings } = useAppStore()
  const [stage, setStage] = useState<Stage>(initialStage)
  const steps = [t.onboarding.step1, t.onboarding.step2, t.onboarding.step3]

  function finish(goToSettings: boolean): void {
    markOnboardingSeen()
    if (goToSettings) openSettings('sync')
    onClose()
  }

  // Esc = 先逛逛：无论停在哪一步都必须能离开。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) finish(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-label={t.onboarding.title}>
      {stage === 'agent' ? (
        <OnboardingAgent onBack={() => setStage('welcome')} onDone={() => finish(false)} />
      ) : (
        <div className="onboarding__card">
          <span className="overline">{t.onboarding.overline}</span>

          {stage === 'welcome' ? (
            <>
              <h1 className="onboarding__title">{t.onboarding.welcome.title}</h1>
              <p className="onboarding__lead">{t.onboarding.welcome.lead}</p>

              <div className="onboarding__choices">
                <button
                  type="button"
                  className="onboarding-choice"
                  onClick={() => setStage('agent')}
                >
                  <span className="onboarding-choice__label">
                    {t.onboarding.welcome.connectAgent}
                  </span>
                </button>
                <button
                  type="button"
                  className="onboarding-choice"
                  onClick={() => setStage('pairing')}
                >
                  <span className="onboarding-choice__label">{t.onboarding.welcome.pairDevice}</span>
                </button>
              </div>

              <div className="onboarding__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => finish(false)}
                >
                  {t.onboarding.welcome.skip}
                </button>
              </div>

              <p className="onboarding__note">{t.onboarding.welcome.note}</p>
            </>
          ) : (
            <>
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
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => finish(true)}
                >
                  {t.onboarding.openSettings}
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => setStage('welcome')}
                >
                  {t.onboarding.agent.back}
                </button>
              </div>

              <p className="onboarding__note">{t.onboarding.privacyNote}</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
