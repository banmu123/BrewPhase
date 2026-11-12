import { useState } from 'react'
import type { CurrentState, CurrentStateDraft, Direction } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { Modal } from '../../shared/Modal'

/**
 * 首次引导：四步把「我在哪 → 想去哪 → 这一段怎么走 → 确认」走完。
 *
 * 为什么不是与 WorkBuddy 的对话：桌面端没有任何模型调用能力，聊天窗口
 * 这里做不出来；真正的对话发生在 WorkBuddy 客户端，它经 MCP 写草稿，
 * 再由这个面板上的确认条落地。所以这一步是**表单**，而它确实是当前
 * 没有 AI 时最诚实的形式——每一句都是用户自己写的。
 *
 * 每一步都可以跳过：不要求一次填满，是规格里反复强调的一条。
 */

const TOTAL_STEPS = 4

type WizardProps = {
  initialStep: number
  initialDirectionId?: string
  currentState: CurrentState | null
  directions: Direction[]
  onClose: () => void
  onSaved: () => void
}

function hasStateContent(draft: CurrentStateDraft): boolean {
  return Object.values(draft).some((value) => value.trim().length > 0)
}

export function DirectionWizard(props: WizardProps) {
  const { t } = useI18n()
  const [step, setStep] = useState(Math.min(Math.max(props.initialStep, 0), TOTAL_STEPS - 1))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [state, setState] = useState<CurrentStateDraft>({
    summary: props.currentState?.summary ?? '',
    workStatus: props.currentState?.workStatus ?? '',
    capabilities: props.currentState?.capabilities ?? '',
    ongoing: props.currentState?.ongoing ?? '',
    capacity: props.currentState?.capacity ?? '',
    constraints: props.currentState?.constraints ?? '',
    other: props.currentState?.other ?? ''
  })

  const [direction, setDirection] = useState({
    title: '',
    description: '',
    motivation: ''
  })

  const [stage, setStage] = useState({
    name: '',
    goal: '',
    completionCriteria: '',
    timeHorizon: ''
  })

  const [directionId, setDirectionId] = useState<string>(
    props.initialDirectionId ?? props.directions[0]?.id ?? ''
  )

  const canSave =
    hasStateContent(state) || direction.title.trim().length > 0 || stage.name.trim().length > 0

  /** 保存时按三步各自判断：填了什么就存什么，空的那层不产生记录。 */
  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      if (hasStateContent(state)) {
        await api.direction.saveCurrentState(state)
      }

      let targetDirectionId = directionId
      if (direction.title.trim().length > 0) {
        const created = await api.direction.createDirection({
          title: direction.title,
          description: direction.description,
          motivation: direction.motivation
        })
        targetDirectionId = created.id
      }

      if (targetDirectionId && stage.name.trim().length > 0) {
        await api.direction.createStage({
          directionId: targetDirectionId,
          name: stage.name,
          goal: stage.goal,
          completionCriteria: stage.completionCriteria,
          timeHorizon: stage.timeHorizon
        })
      }

      props.onSaved()
    } catch (cause) {
      console.error('[direction] save failed:', String(cause).slice(0, 200))
      setError(t.direction.wizard.saveError)
    } finally {
      setSaving(false)
    }
  }

  const stateFields: Array<{ key: keyof CurrentStateDraft; label: string; placeholder?: string }> = [
    { key: 'summary', label: t.direction.wizard.state.summary, placeholder: t.direction.wizard.state.summaryPlaceholder },
    { key: 'workStatus', label: t.direction.wizard.state.workStatus },
    { key: 'capabilities', label: t.direction.wizard.state.capabilities },
    { key: 'ongoing', label: t.direction.wizard.state.ongoing },
    { key: 'capacity', label: t.direction.wizard.state.capacity },
    { key: 'constraints', label: t.direction.wizard.state.constraints },
    { key: 'other', label: t.direction.wizard.state.other }
  ]

  const body = (() => {
    if (step === 0) {
      return (
        <div className="direction-form">
          <p className="direction-form__hint">{t.direction.wizard.state.hint}</p>
          {stateFields.map((field) => (
            <label key={field.key} className="direction-form__field">
              <span className="direction-form__label">{field.label}</span>
              <textarea
                rows={field.key === 'summary' ? 4 : 2}
                value={state[field.key]}
                placeholder={field.placeholder}
                onChange={(event) =>
                  setState((previous) => ({ ...previous, [field.key]: event.target.value }))
                }
              />
            </label>
          ))}
        </div>
      )
    }

    if (step === 1) {
      return (
        <div className="direction-form">
          <p className="direction-form__hint">{t.direction.wizard.dir.hint}</p>
          <label className="direction-form__field">
            <span className="direction-form__label">{t.direction.wizard.dir.name}</span>
            <input
              type="text"
              value={direction.title}
              placeholder={t.direction.wizard.dir.namePlaceholder}
              onChange={(event) =>
                setDirection((previous) => ({ ...previous, title: event.target.value }))
              }
            />
          </label>
          <label className="direction-form__field">
            <span className="direction-form__label">{t.direction.wizard.dir.description}</span>
            <textarea
              rows={3}
              value={direction.description}
              placeholder={t.direction.wizard.dir.descriptionPlaceholder}
              onChange={(event) =>
                setDirection((previous) => ({ ...previous, description: event.target.value }))
              }
            />
          </label>
          <label className="direction-form__field">
            <span className="direction-form__label">{t.direction.wizard.dir.motivation}</span>
            <textarea
              rows={2}
              value={direction.motivation}
              onChange={(event) =>
                setDirection((previous) => ({ ...previous, motivation: event.target.value }))
              }
            />
          </label>
        </div>
      )
    }

    if (step === 2) {
      // 没有方向可挂：这一步没有意义，直接说清楚，而不是让用户填完再报错。
      const hasTarget = directionId.length > 0 || direction.title.trim().length > 0
      return (
        <div className="direction-form">
          <p className="direction-form__hint">{t.direction.wizard.stage.hint}</p>

          {props.directions.length > 1 && (
            <label className="direction-form__field">
              <span className="direction-form__label">{t.direction.wizard.review.directionLabel}</span>
              <select
                value={directionId}
                onChange={(event) => setDirectionId(event.target.value)}
              >
                {props.directions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!hasTarget && <p className="direction-form__warning">{t.direction.stage.none}</p>}

          <label className="direction-form__field">
            <span className="direction-form__label">{t.direction.wizard.stage.name}</span>
            <input
              type="text"
              value={stage.name}
              placeholder={t.direction.wizard.stage.namePlaceholder}
              disabled={!hasTarget}
              onChange={(event) => setStage((previous) => ({ ...previous, name: event.target.value }))}
            />
          </label>
          <label className="direction-form__field">
            <span className="direction-form__label">{t.direction.wizard.stage.goal}</span>
            <textarea
              rows={2}
              value={stage.goal}
              disabled={!hasTarget}
              onChange={(event) => setStage((previous) => ({ ...previous, goal: event.target.value }))}
            />
          </label>
          <label className="direction-form__field">
            <span className="direction-form__label">{t.direction.wizard.stage.criteria}</span>
            <textarea
              rows={2}
              value={stage.completionCriteria}
              placeholder={t.direction.wizard.stage.criteriaPlaceholder}
              disabled={!hasTarget}
              onChange={(event) =>
                setStage((previous) => ({ ...previous, completionCriteria: event.target.value }))
              }
            />
          </label>
          <label className="direction-form__field">
            <span className="direction-form__label">{t.direction.wizard.stage.horizon}</span>
            <input
              type="text"
              value={stage.timeHorizon}
              placeholder={t.direction.wizard.stage.horizonPlaceholder}
              disabled={!hasTarget}
              onChange={(event) =>
                setStage((previous) => ({ ...previous, timeHorizon: event.target.value }))
              }
            />
          </label>
        </div>
      )
    }

    // 第四步：只做一次如实的摘要，不写「你已迈出重要一步」这种话。
    const summaryLines: Array<{ label: string; value: string }> = []
    if (state.summary.trim()) {
      summaryLines.push({ label: t.direction.wizard.review.state, value: state.summary.trim() })
    }
    if (direction.title.trim()) {
      summaryLines.push({ label: t.direction.wizard.review.directionLabel, value: direction.title.trim() })
    }
    if (stage.name.trim()) {
      summaryLines.push({ label: t.direction.wizard.review.stageLabel, value: stage.name.trim() })
    }

    return (
      <div className="direction-form">
        <p className="direction-form__hint">{t.direction.wizard.review.hint}</p>
        {summaryLines.length === 0 ? (
          <p className="direction-form__warning">{t.direction.wizard.review.nothing}</p>
        ) : (
          <dl className="direction-form__summary">
            {summaryLines.map((line) => (
              <div key={line.label}>
                <dt>{line.label}</dt>
                <dd>{line.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    )
  })()

  return (
    <Modal
      title={t.direction.wizard.title}
      width="md"
      onClose={props.onClose}
      footer={
        <div className="direction-form__foot">
          <span className="direction-form__step">
            {t.direction.wizard.step(step + 1, TOTAL_STEPS)}
          </span>
          <div className="direction-form__nav">
            {step > 0 && (
              <button
                type="button"
                className="button button--ghost"
                disabled={saving}
                onClick={() => setStep((current) => current - 1)}
              >
                {t.direction.wizard.back}
              </button>
            )}
            {step < TOTAL_STEPS - 1 ? (
              <>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={saving}
                  onClick={() => setStep((current) => current + 1)}
                >
                  {t.direction.wizard.skip}
                </button>
                <button
                  type="button"
                  className="button button--primary"
                  disabled={saving}
                  onClick={() => setStep((current) => current + 1)}
                >
                  {t.direction.wizard.next}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button button--primary"
                disabled={saving || !canSave}
                onClick={() => void save()}
              >
                {saving ? t.direction.wizard.saving : t.direction.wizard.finish}
              </button>
            )}
          </div>
        </div>
      }
    >
      {error && <p className="direction-form__error">{error}</p>}
      {body}
    </Modal>
  )
}
