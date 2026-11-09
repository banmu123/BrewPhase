import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bean, BeanDraft, Brew, BrewDraft, PhaseRule, Tasting } from '@shared/contracts'
import { dayAfterRoast, defaultRuleFor, phaseFor } from '@shared/domain/phase'
import { api, ratioText, toDateInput, toEpoch } from '../../shared/api'
import { useI18n } from '../../i18n'

/**
 * Coffee：豆子 → 冲煮 → 品鉴，三段同屏。
 *
 * 库存与阶段都不是界面自己算的：扣减/回补在主进程的 repository（复用
 * `inventory.ts` 的纯函数），阶段由 `phase.ts` 从烘焙日派生。界面只负责显示
 * 与提交，避免出现「界面算一套、落库算另一套」。
 */
export function CoffeePage() {
  const { t, formatDate, formatNumber } = useI18n()
  const [beans, setBeans] = useState<Bean[]>([])
  const [rules, setRules] = useState<PhaseRule[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [brews, setBrews] = useState<Brew[]>([])
  const [tastings, setTastings] = useState<Tasting[]>([])
  const [error, setError] = useState<string | null>(null)
  const [creatingBean, setCreatingBean] = useState(false)
  const [loggingBrew, setLoggingBrew] = useState(false)

  /** 详情浮层按需出现：点收藏架上的卡片打开，✕ 关闭。 */
  const [panelOpen, setPanelOpen] = useState(false)
  const selected = beans.find((bean) => bean.id === selectedId) ?? null

  const loadBeans = useCallback(async () => {
    try {
      const [nextBeans, nextRules] = await Promise.all([api.coffee.listBeans(), api.coffee.listPhaseRules()])
      setBeans(nextBeans)
      setRules(nextRules)
      setSelectedId((current) => (nextBeans.some((bean) => bean.id === current) ? current : null))
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  useEffect(() => {
    void loadBeans()
  }, [loadBeans])

  // Esc 关闭豆子详情：与 ✕ 同一语义。
  useEffect(() => {
    if (!panelOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) setPanelOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [panelOpen])

  const loadBeanDetails = useCallback(async (beanId: string) => {
    try {
      const [nextBrews, nextTastings] = await Promise.all([
        api.coffee.listBrews(beanId),
        api.coffee.listTastings(beanId)
      ])
      setBrews(nextBrews)
      setTastings(nextTastings)
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!selected) {
      setBrews([])
      setTastings([])
      return
    }
    void loadBeanDetails(selected.id)
  }, [selected?.id, loadBeanDetails])

  const rule = useMemo(() => {
    if (!selected) return null
    return rules.find((item) => item.roastLevel === selected.roastLevel) ?? defaultRuleFor(selected.roastLevel)
  }, [rules, selected])

  const day = selected ? dayAfterRoast(selected.roastDate) : null
  const phase = rule ? phaseFor(day, rule) : null

  async function refreshAll(): Promise<void> {
    await loadBeans()
    if (selected) await loadBeanDetails(selected.id)
  }

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__titles">
          <h1 className="page-title">{t.coffee.title}</h1>
          <p className="page-sub">{t.coffee.shelfSummary(beans.length)}</p>
        </div>
        <div className="page-header__actions">
          <button
            className={creatingBean ? 'button' : 'button button--primary'}
            onClick={() => {
              setCreatingBean((value) => !value)
              setPanelOpen(false)
            }}
          >
            {creatingBean ? t.coffee.collapseForm : t.coffee.addBean}
          </button>
        </div>
      </header>

      <div className="page-body">
        <div className="coffee-flow">
          {error && <div className="error">{error}</div>}

          <section className="coffee-section">
            <span className="overline">{t.coffee.currentlyBrewing}</span>

            {beans.length === 0 ? (
              <div className="empty">{t.coffee.empty.noBeans}</div>
            ) : (
              <div className="shelf">
                {beans.map((bean) => {
                  const beanRule =
                    rules.find((item) => item.roastLevel === bean.roastLevel) ?? defaultRuleFor(bean.roastLevel)
                  const beanPhase = phaseFor(dayAfterRoast(bean.roastDate), beanRule)
                  return (
                    <button
                      key={bean.id}
                      className="shelf-card"
                      data-active={panelOpen && bean.id === selected?.id}
                      onClick={() => {
                        setSelectedId(bean.id)
                        setPanelOpen(true)
                        setCreatingBean(false)
                      }}
                    >
                      <span className="shelf-card__name" title={bean.name || t.coffee.unnamedBean}>
                        {bean.name || t.coffee.unnamedBean}
                      </span>
                      <span className="shelf-card__meta">{bean.roaster || t.coffee.noRoaster}</span>
                      <span className="shelf-card__stock mono">
                        {bean.remainingG.toFixed(0)} / {bean.weightG.toFixed(0)}g
                      </span>
                      <div className="stock-bar">
                        <span
                          style={{
                            width: `${Math.min(100, Math.max(0, (bean.remainingG / Math.max(1, bean.weightG)) * 100))}%`
                          }}
                        />
                      </div>
                      {beanPhase && (
                        <span className={`badge badge--${beanPhase}`}>{t.coffee.phase[beanPhase].title}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {creatingBean && (
              <div className="panel" style={{ marginTop: 18, maxWidth: 460 }}>
                <BeanForm
                  title={t.coffee.newBean}
                  onCancel={() => setCreatingBean(false)}
                  onSubmit={async (draft) => {
                    await api.coffee.createBean(draft)
                    setCreatingBean(false)
                    await loadBeans()
                  }}
                />
              </div>
            )}
          </section>
        </div>
      </div>

      {panelOpen && selected && (
        <aside className="float-panel" role="dialog" aria-label={t.coffee.beanDetail}>
          <div className="row row--between" style={{ marginBottom: 14 }}>
            <span className="overline" style={{ margin: 0 }}>{t.coffee.beanProfile}</span>
            <button
              className="button button--ghost"
              aria-label={t.coffee.closeDetail}
              onClick={() => setPanelOpen(false)}
            >
              ✕
            </button>
          </div>

          <div className="hero">
            <h2 className="hero__name">{selected.name || t.coffee.unnamedBean}</h2>
            <div className="hero__meta">
              <span>{selected.roaster || t.coffee.noRoaster}</span>
              <span>{t.coffee.roastLevel[selected.roastLevel]}</span>
              <span>{t.coffee.roastedOn(selected.roastDate != null ? formatDate(selected.roastDate) : '—')}</span>
              {day != null && <span>{t.coffee.dayCount(day)}</span>}
              {phase && (
                <span className={`badge badge--${phase}`}>
                  {t.coffee.phase[phase].title} · {t.coffee.phase[phase].hint}
                </span>
              )}
            </div>

            <div className="hero__stock">
              <div className="row row--between">
                <span className="mono">
                  {selected.remainingG.toFixed(1)}g / {selected.weightG.toFixed(0)}g
                </span>
                <span style={{ fontSize: 10, color: 'var(--ink-faint)' }}>
                  {selected.status === 'finished' ? t.coffee.status.finished : t.coffee.status.active}
                </span>
              </div>
              <div className="stock-bar">
                <span
                  style={{
                    width: `${Math.min(100, Math.max(0, (selected.remainingG / Math.max(1, selected.weightG)) * 100))}%`
                  }}
                />
              </div>
              {rule && phase && (
                <div className="phase-track">
                  {(['resting', 'opening', 'peak', 'declining'] as const).map((item) => (
                    <div key={item} data-on={item === phase} data-phase={item} />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="float-panel__section">
            <div className="row row--between" style={{ marginBottom: 10 }}>
              <span className="overline" style={{ margin: 0 }}>
                {t.coffee.brews(brews.length)}
              </span>
              <button className="button button--primary" onClick={() => setLoggingBrew((value) => !value)}>
                {t.coffee.logBrew}
              </button>
            </div>

            {loggingBrew && (
              <BrewForm
                beanId={selected.id}
                onCancel={() => setLoggingBrew(false)}
                onSubmit={async (draft) => {
                  await api.coffee.createBrew(draft)
                  setLoggingBrew(false)
                  await refreshAll()
                }}
              />
            )}

            {brews.length === 0 ? (
              <div className="empty">{t.coffee.empty.noBrews}</div>
            ) : (
              brews.map((brew) => (
                <div key={brew.id} className="brew-row">
                  <span className="brew-row__date">{formatDate(brew.date)}</span>
                  <span className="mono">
                    {brew.coffeeG}g → {brew.waterG}g
                  </span>
                  <span style={{ color: 'var(--ink-soft)' }}>
                    {brew.method || t.coffee.noMethod} · {ratioText(brew.coffeeG, brew.waterG)}
                  </span>
                  <span className="mono" style={{ color: 'var(--ink-faint)' }}>
                    {formatSeconds(brew.timeSeconds)}
                  </span>
                  <button
                    className="button button--ghost"
                    title={t.coffee.deleteBrewTitle}
                    onClick={async () => {
                      await api.coffee.deleteBrew(brew.id)
                      await refreshAll()
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}

            <div className="hairline" />
            <span className="overline">{t.coffee.tastings(tastings.length)}</span>
            {tastings.length === 0 ? (
              <div className="empty">{t.coffee.empty.noTastings}</div>
            ) : (
              tastings.map((tasting) => (
                <div key={tasting.id} className="brew-row" style={{ gridTemplateColumns: '76px 1fr 1fr 60px' }}>
                  <span className="brew-row__date">{formatDate(tasting.date)}</span>
                  <span>{t.coffee.dayCount(tasting.dayAfterRoast)}</span>
                  <span style={{ color: 'var(--ink-soft)' }}>
                    {tasting.flavorTags.join(' · ') || t.coffee.noFlavor}
                  </span>
                  <span className="mono">{tasting.score ? formatNumber(tasting.score) : '—'}</span>
                </div>
              ))
            )}
          </div>

          <div className="hairline" />
          <span className="overline">{t.coffee.editProfile}</span>
          <BeanForm
            title={t.common.edit}
            bean={selected}
            onCancel={() => undefined}
            cancelLabel=""
            onSubmit={async (draft) => {
              await api.coffee.updateBean(selected.id, draft)
              await loadBeans()
            }}
          />

          <div className="hairline" />
          <span className="overline">{t.coffee.phaseWindow}</span>
          {rule ? (
            <>
              <div className="note">
                {t.coffee.windowNote(
                  rule.restMinDays,
                  rule.restMaxDays,
                  rule.peakStartDay,
                  rule.peakEndDay,
                  rule.declineStartDay
                )}
              </div>
              <div className="note" style={{ marginTop: 8 }}>
                {t.coffee.windowNoteHint}
              </div>
            </>
          ) : (
            <div className="empty">{t.coffee.empty.noRule}</div>
          )}

          <div className="hairline" />
          <button
            className="button button--danger"
            onClick={async () => {
              if (!window.confirm(t.coffee.confirmDeleteBean(selected.name))) return
              await api.coffee.deleteBean(selected.id)
              setPanelOpen(false)
              setSelectedId(null)
              await loadBeans()
            }}
          >
            {t.coffee.deleteBean}
          </button>
        </aside>
      )}
    </div>
  )
}

// MARK: - 表单

function BeanForm(props: {
  title: string
  bean?: Bean
  cancelLabel?: string
  onCancel: () => void
  onSubmit: (draft: BeanDraft) => Promise<void>
}) {
  const { t } = useI18n()
  const { bean } = props
  const [name, setName] = useState(bean?.name ?? '')
  const [roaster, setRoaster] = useState(bean?.roaster ?? '')
  const [roastLevel, setRoastLevel] = useState<Bean['roastLevel']>(bean?.roastLevel ?? 'medium')
  const [roastDate, setRoastDate] = useState(toDateInput(bean?.roastDate ?? null))
  const [openDate, setOpenDate] = useState(toDateInput(bean?.openDate ?? null))
  const [weightG, setWeightG] = useState(String(bean?.weightG ?? 200))
  const [remainingG, setRemainingG] = useState(String(bean?.remainingG ?? 200))
  const [price, setPrice] = useState(String(bean?.price ?? 0))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        try {
          await props.onSubmit({
            // 落库默认值不随界面语言变化：数据语义应稳定（展示层再翻译空名称）。
            name: name.trim() || '未命名豆子',
            roaster,
            roastLevel,
            roastDate: toEpoch(roastDate),
            openDate: toEpoch(openDate),
            weightG: Number(weightG) || 0,
            remainingG: Number(remainingG) || 0,
            price: Number(price) || 0
          })
        } catch (cause) {
          setError((cause as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <span className="overline" style={{ margin: 0 }}>
        {props.title}
      </span>
      <div className="field">
        <label>{t.coffee.form.name}</label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t.coffee.placeholder.name}
        />
      </div>
      <div className="field">
        <label>{t.coffee.form.roaster}</label>
        <input
          value={roaster}
          onChange={(event) => setRoaster(event.target.value)}
          placeholder={t.coffee.placeholder.roaster}
        />
      </div>
      <div className="field">
        <label>{t.coffee.form.roastLevel}</label>
        <select value={roastLevel} onChange={(event) => setRoastLevel(event.target.value as Bean['roastLevel'])}>
          <option value="light">{t.coffee.roastLevel.light}</option>
          <option value="medium">{t.coffee.roastLevel.medium}</option>
          <option value="mediumDark">{t.coffee.roastLevel.mediumDark}</option>
          <option value="dark">{t.coffee.roastLevel.dark}</option>
          <option value="espressoBlend">{t.coffee.roastLevel.espressoBlend}</option>
        </select>
      </div>
      <div className="field-row">
        <div className="field">
          <label>{t.coffee.form.roastDate}</label>
          <input type="date" value={roastDate} onChange={(event) => setRoastDate(event.target.value)} />
        </div>
        <div className="field">
          <label>{t.coffee.form.openDate}</label>
          <input type="date" value={openDate} onChange={(event) => setOpenDate(event.target.value)} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>{t.coffee.form.weightG}</label>
          <input type="number" value={weightG} onChange={(event) => setWeightG(event.target.value)} />
        </div>
        <div className="field">
          <label>{t.coffee.form.remainingG}</label>
          <input type="number" value={remainingG} onChange={(event) => setRemainingG(event.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>{t.coffee.form.price}</label>
        <input type="number" value={price} onChange={(event) => setPrice(event.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? t.common.saving : t.common.save}
        </button>
        {props.cancelLabel !== '' && (
          <button className="button button--ghost" type="button" onClick={props.onCancel}>
            {props.cancelLabel ?? t.common.cancel}
          </button>
        )}
      </div>
      {bean && (
        <div className="note">
          {t.coffee.stockNote}
        </div>
      )}
    </form>
  )
}

function BrewForm(props: {
  beanId: string
  onCancel: () => void
  onSubmit: (draft: BrewDraft) => Promise<void>
}) {
  const { t } = useI18n()
  const [method, setMethod] = useState('V60')
  const [coffeeG, setCoffeeG] = useState('15')
  const [waterG, setWaterG] = useState('250')
  const [waterTemp, setWaterTemp] = useState('92')
  const [timeSeconds, setTimeSeconds] = useState('150')
  // 研磨度是自由文本数据（会被保存并同步），默认值不跟随界面语言。
  const [grindSize, setGrindSize] = useState('中细')
  const [score, setScore] = useState('80')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      className="stack panel"
      style={{ marginBottom: 14 }}
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        try {
          await props.onSubmit({
            beanId: props.beanId,
            date: Date.now(),
            method,
            grinder: '',
            grindSize,
            waterTemp: Number(waterTemp) || 0,
            coffeeG: Number(coffeeG) || 0,
            waterG: Number(waterG) || 0,
            timeSeconds: Number(timeSeconds) || 0,
            score: Number(score) || 0,
            acidity: 0,
            sweetness: 0,
            bitterness: 0,
            body: 0,
            aftertaste: 0,
            flavorTags: [],
            notes
          })
        } catch (cause) {
          setError((cause as Error).message)
          setBusy(false)
        }
      }}
    >
      <div className="field-row">
        <div className="field">
          <label>{t.coffee.brew.method}</label>
          <input value={method} onChange={(event) => setMethod(event.target.value)} />
        </div>
        <div className="field">
          <label>{t.coffee.brew.grind}</label>
          <input value={grindSize} onChange={(event) => setGrindSize(event.target.value)} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>{t.coffee.brew.coffeeG}</label>
          <input type="number" value={coffeeG} onChange={(event) => setCoffeeG(event.target.value)} />
        </div>
        <div className="field">
          <label>{t.coffee.brew.waterG}</label>
          <input type="number" value={waterG} onChange={(event) => setWaterG(event.target.value)} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>{t.coffee.brew.waterTemp}</label>
          <input type="number" value={waterTemp} onChange={(event) => setWaterTemp(event.target.value)} />
        </div>
        <div className="field">
          <label>{t.coffee.brew.time}</label>
          <input type="number" value={timeSeconds} onChange={(event) => setTimeSeconds(event.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>{t.coffee.brew.score}</label>
        <input type="number" value={score} onChange={(event) => setScore(event.target.value)} />
      </div>
      <div className="field">
        <label>{t.coffee.brew.notes}</label>
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? t.common.saving : t.coffee.brew.save}
        </button>
        <button className="button button--ghost" type="button" onClick={props.onCancel}>
          {t.common.cancel}
        </button>
      </div>
    </form>
  )
}

function formatSeconds(seconds: number): string {
  if (!seconds) return '—'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${`${rest}`.padStart(2, '0')}`
}
