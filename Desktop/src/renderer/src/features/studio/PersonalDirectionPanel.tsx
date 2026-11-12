import { useCallback, useEffect, useState } from 'react'
import type { Direction, PersonalDirectionOverview } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { confirmAction } from '../../shared/ConfirmDialog'
import { DirectionWizard } from './DirectionWizard'

/**
 * Studio Home 底部的 Personal Direction 面板。
 *
 * 三栏（咖啡 / 画布 / 记录）讲的是「你有什么」，这一块讲的是「你要去哪」。
 * 所以它刻意排在 desk 之后、用更低的音量呈现：没有图表、没有进度百分比，
 * 只有现状一句话、方向几条、以及每条方向当前那一段。
 *
 * 不做的事：不打分、不排名、不催促。阶段完成与否由用户自己判定。
 */
export function PersonalDirectionPanel() {
  const { t } = useI18n()
  const [overview, setOverview] = useState<PersonalDirectionOverview | null>(null)
  /** null = 关闭；step 决定从向导的哪一步开始（更新现状 / 加阶段 / 全流程）。 */
  const [wizard, setWizard] = useState<{ step: number; directionId?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): void => {
    void api.direction
      .overview()
      .then(setOverview)
      .catch((cause) => {
        console.error('[direction] overview failed:', String(cause).slice(0, 200))
        setOverview((previous) => previous ?? null)
      })
  }, [])

  useEffect(() => {
    load()
    // Agent 经 MCP 写草稿、或其它窗口改动，都会广播这个域。
    return api.app.onChanged((domain) => {
      if (domain === 'personalDirection') load()
    })
  }, [load])

  const statusLabel = (status: string): string =>
    (t.direction.status as Record<string, string>)[status] ?? status

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      load()
    } catch (cause) {
      console.error('[direction] action failed:', String(cause).slice(0, 200))
      setError(t.direction.wizard.saveError)
    } finally {
      setBusy(false)
    }
  }

  if (!overview) return null

  // 待确认的提议：现状草稿优先（它影响「我在哪」，比新增一条方向更要紧），
  // 其次是方向、阶段。一次只呈现一条——同时弹三条只会让人直接关掉。
  const stateDraft = overview.currentStateDraft
  const directionProposal = overview.directions.find((item) => item.status === 'proposed')
  const stageProposal = overview.stages.find((item) => item.status === 'proposed')
  const proposal = stateDraft
    ? { kind: 'currentState' as const, id: stateDraft.id, label: t.direction.proposal.fromState }
    : directionProposal
      ? { kind: 'direction' as const, id: directionProposal.id, label: directionProposal.title }
      : stageProposal
        ? { kind: 'stage' as const, id: stageProposal.id, label: stageProposal.name }
        : null
  const pendingCount = Math.max(overview.proposalCount - (proposal ? 1 : 0), 0)

  // 正式列表只放用户认过的方向：proposed 属于「提示条」那一条，不能混进来，
  // 否则界面会给人一种「这已经是我方向了」的错觉。
  const visibleDirections = overview.directions.filter(
    (item) => item.status !== 'dropped' && item.status !== 'proposed'
  )
  const hasAnything = overview.currentState !== null || visibleDirections.length > 0

  const currentStageOf = (direction: Direction) => {
    const stages = overview.stages.filter((stage) => stage.directionId === direction.id)
    return stages.find((stage) => stage.status === 'active') ?? stages[0] ?? null
  }

  return (
    <section className="direction" aria-label={t.direction.title}>
      <header className="direction__head">
        <div>
          <span className="overline">{t.direction.overline}</span>
          <h2 className="direction__title">{t.direction.title}</h2>
          <p className="direction__sub">{t.direction.subtitle}</p>
        </div>
        {hasAnything && (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setWizard({ step: 0 })}
          >
            {t.direction.currentState.review}
          </button>
        )}
      </header>

      {error && <p className="direction__error">{error}</p>}

      {proposal && (
        <div className="direction__proposal">
          <div className="direction__proposal-text">
            <span className="overline">{t.direction.proposal.title}</span>
            <p className="direction__proposal-label">{proposal.label}</p>
            <p className="direction__hint">
              {t.direction.proposal.hint}
              {pendingCount > 0 ? ` · ${t.direction.proposal.more(pendingCount)}` : ''}
            </p>
          </div>
          <div className="direction__proposal-actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() =>
                void runAction(() => api.direction.resolveProposal(proposal.kind, proposal.id, 'confirm'))
              }
            >
              {t.direction.proposal.confirm}
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              onClick={() =>
                void runAction(() => api.direction.resolveProposal(proposal.kind, proposal.id, 'discard'))
              }
            >
              {t.direction.proposal.discard}
            </button>
          </div>
        </div>
      )}

      {!hasAnything ? (
        <div className="direction__empty">
          <h3>{t.direction.empty.title}</h3>
          <p>{t.direction.empty.body}</p>
          <button
            type="button"
            className="button button--primary"
            onClick={() => setWizard({ step: 0 })}
          >
            {t.direction.empty.action}
          </button>
        </div>
      ) : (
        <>
          <div className="direction__state">
            <div className="direction__state-head">
              <span className="overline">{t.direction.currentState.title}</span>
            </div>
            <p className="direction__state-body">
              {overview.currentState?.summary || t.direction.currentState.empty}
            </p>
          </div>

          {visibleDirections.length > 0 && (
            <div className="direction__list">
              {visibleDirections.map((direction) => {
                const stage = currentStageOf(direction)
                return (
                  <article key={direction.id} className="direction__card">
                    <div className="direction__card-head">
                      <h3 className="direction__card-title">{direction.title}</h3>
                      <span className="direction__badge" data-status={direction.status}>
                        {statusLabel(direction.status)}
                      </span>
                    </div>

                    {direction.description && (
                      <p className="direction__card-desc">{direction.description}</p>
                    )}

                    <div className="direction__stage">
                      <span className="overline">{t.direction.stage.current}</span>
                      {stage ? (
                        <>
                          <p className="direction__stage-name">{stage.name}</p>
                          <p className="direction__hint">
                            {t.direction.stage.criteria}：
                            {stage.completionCriteria || t.direction.stage.noCriteria}
                          </p>
                        </>
                      ) : (
                        <p className="direction__hint">{t.direction.stage.none}</p>
                      )}
                    </div>

                    <div className="direction__actions">
                      <button
                        type="button"
                        className="direction__link"
                        disabled={busy}
                        onClick={() =>
                          void runAction(() =>
                            api.direction.updateDirection(direction.id, direction.updatedAt, {
                              status: direction.status === 'active' ? 'paused' : 'active'
                            })
                          )
                        }
                      >
                        {direction.status === 'active'
                          ? t.direction.actions.pause
                          : t.direction.actions.resume}
                      </button>
                      <button
                        type="button"
                        className="direction__link"
                        onClick={() => setWizard({ step: 2, directionId: direction.id })}
                      >
                        {t.direction.actions.addStage}
                      </button>
                      <button
                        type="button"
                        className="direction__link direction__link--danger"
                        disabled={busy}
                        onClick={() => {
                          void (async () => {
                            const ok = await confirmAction({
                              title: t.direction.actions.removeConfirm,
                              confirmLabel: t.direction.actions.remove,
                              cancelLabel: t.common.cancel,
                              tone: 'danger'
                            })
                            if (!ok) return
                            await runAction(() => api.direction.deleteDirection(direction.id))
                          })()
                        }}
                      >
                        {t.direction.actions.remove}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}

      {wizard && (
        <DirectionWizard
          initialStep={wizard.step}
          initialDirectionId={wizard.directionId}
          currentState={overview.currentState}
          directions={overview.directions}
          onClose={() => setWizard(null)}
          onSaved={() => {
            setWizard(null)
            load()
          }}
        />
      )}
    </section>
  )
}
