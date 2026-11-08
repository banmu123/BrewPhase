import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bean, BeanDraft, Brew, BrewDraft, PhaseRule, Tasting } from '@shared/contracts'
import { dayAfterRoast, defaultRuleFor, phaseFor, PHASE_LABELS } from '@shared/domain/phase'
import { api, formatDate, ratioText, toDateInput, toEpoch } from '../../shared/api'

/**
 * Coffee：豆子 → 冲煮 → 品鉴，三段同屏。
 *
 * 库存与阶段都不是界面自己算的：扣减/回补在主进程的 repository（复用
 * `inventory.ts` 的纯函数），阶段由 `phase.ts` 从烘焙日派生。界面只负责显示
 * 与提交，避免出现「界面算一套、落库算另一套」。
 */
export function CoffeePage() {
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
          <h1 className="page-title">Coffee</h1>
          <p className="page-sub">Your personal coffee shelf · {beans.length} 包在架</p>
        </div>
        <div className="page-header__actions">
          <button
            className={creatingBean ? 'button' : 'button button--primary'}
            onClick={() => {
              setCreatingBean((value) => !value)
              setPanelOpen(false)
            }}
          >
            {creatingBean ? '收起表单' : '新增豆子'}
          </button>
        </div>
      </header>

      <div className="page-body">
        <div className="coffee-flow">
          {error && <div className="error">{error}</div>}

          <section className="coffee-section">
            <span className="overline">Currently Brewing</span>

            {beans.length === 0 ? (
              <div className="empty">还没有豆子。先记一包，冲煮与品鉴会挂到它下面。</div>
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
                      <span className="shelf-card__name">{bean.name || '未命名豆子'}</span>
                      <span className="shelf-card__meta">{bean.roaster || '未填烘焙商'}</span>
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
                        <span className={`badge badge--${beanPhase}`}>{PHASE_LABELS[beanPhase].title}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {creatingBean && (
              <div className="panel" style={{ marginTop: 18, maxWidth: 460 }}>
                <BeanForm
                  title="新的一包豆"
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
        <aside className="float-panel" role="dialog" aria-label="豆子详情">
          <div className="row row--between" style={{ marginBottom: 14 }}>
            <span className="overline" style={{ margin: 0 }}>豆子档案</span>
            <button
              className="button button--ghost"
              aria-label="关闭详情"
              onClick={() => setPanelOpen(false)}
            >
              ✕
            </button>
          </div>

          <div className="hero">
            <h2 className="hero__name">{selected.name || '未命名豆子'}</h2>
            <div className="hero__meta">
              <span>{selected.roaster || '未填烘焙商'}</span>
              <span>{roastLabel(selected.roastLevel)}</span>
              <span>烘焙 {formatDate(selected.roastDate)}</span>
              {day != null && <span>第 {day} 天</span>}
              {phase && (
                <span className={`badge badge--${phase}`}>
                  {PHASE_LABELS[phase].title} · {PHASE_LABELS[phase].hint}
                </span>
              )}
            </div>

            <div className="hero__stock">
              <div className="row row--between">
                <span className="mono">
                  {selected.remainingG.toFixed(1)}g / {selected.weightG.toFixed(0)}g
                </span>
                <span style={{ fontSize: 10, color: 'var(--ink-faint)' }}>
                  {selected.status === 'finished' ? '已喝完' : '在喝'}
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
                冲煮 · {brews.length}
              </span>
              <button className="button button--primary" onClick={() => setLoggingBrew((value) => !value)}>
                记一杯
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
              <div className="empty">还没有冲煮记录。记一杯，库存会按实际粉量扣。</div>
            ) : (
              brews.map((brew) => (
                <div key={brew.id} className="brew-row">
                  <span className="brew-row__date">{formatDate(brew.date)}</span>
                  <span className="mono">
                    {brew.coffeeG}g → {brew.waterG}g
                  </span>
                  <span style={{ color: 'var(--ink-soft)' }}>
                    {brew.method || '未填手法'} · {ratioText(brew.coffeeG, brew.waterG)}
                  </span>
                  <span className="mono" style={{ color: 'var(--ink-faint)' }}>
                    {formatSeconds(brew.timeSeconds)}
                  </span>
                  <button
                    className="button button--ghost"
                    title="删除这次冲煮，库存按实扣量退回"
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
            <span className="overline">品鉴 · {tastings.length}</span>
            {tastings.length === 0 ? (
              <div className="empty">还没有品鉴。记一杯之后会自动留下一条。</div>
            ) : (
              tastings.map((tasting) => (
                <div key={tasting.id} className="brew-row" style={{ gridTemplateColumns: '76px 1fr 1fr 60px' }}>
                  <span className="brew-row__date">{formatDate(tasting.date)}</span>
                  <span>第 {tasting.dayAfterRoast} 天</span>
                  <span style={{ color: 'var(--ink-soft)' }}>
                    {tasting.flavorTags.join(' · ') || '未记风味'}
                  </span>
                  <span className="mono">{tasting.score || '—'}</span>
                </div>
              ))
            )}
          </div>

          <div className="hairline" />
          <span className="overline">编辑档案</span>
          <BeanForm
            title="编辑"
            bean={selected}
            onCancel={() => undefined}
            cancelLabel=""
            onSubmit={async (draft) => {
              await api.coffee.updateBean(selected.id, draft)
              await loadBeans()
            }}
          />

          <div className="hairline" />
          <span className="overline">风味窗口</span>
          {rule ? (
            <>
              <div className="note">
                养豆 {rule.restMinDays}–{rule.restMaxDays} 天 · 黄金 {rule.peakStartDay}–{rule.peakEndDay} 天 ·
                第 {rule.declineStartDay} 天起衰减
              </div>
              <div className="note" style={{ marginTop: 8 }}>
                基于默认窗口估算，不是保质期结论。
              </div>
            </>
          ) : (
            <div className="empty">没有可用规则。</div>
          )}

          <div className="hairline" />
          <button
            className="button button--danger"
            onClick={async () => {
              if (!window.confirm(`删除「${selected.name}」？它的冲煮与品鉴会一并删除。`)) return
              await api.coffee.deleteBean(selected.id)
              setPanelOpen(false)
              setSelectedId(null)
              await loadBeans()
            }}
          >
            删除这包豆子
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
        <label>名字</label>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：哥伦比亚 粉波旁" />
      </div>
      <div className="field">
        <label>烘焙商</label>
        <input value={roaster} onChange={(event) => setRoaster(event.target.value)} placeholder="例如：Onibus" />
      </div>
      <div className="field">
        <label>烘焙度</label>
        <select value={roastLevel} onChange={(event) => setRoastLevel(event.target.value as Bean['roastLevel'])}>
          <option value="light">浅烘</option>
          <option value="medium">中烘</option>
          <option value="mediumDark">中深烘</option>
          <option value="dark">深烘</option>
          <option value="espressoBlend">意式拼配</option>
        </select>
      </div>
      <div className="field-row">
        <div className="field">
          <label>烘焙日期</label>
          <input type="date" value={roastDate} onChange={(event) => setRoastDate(event.target.value)} />
        </div>
        <div className="field">
          <label>开封日期</label>
          <input type="date" value={openDate} onChange={(event) => setOpenDate(event.target.value)} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>总量 g</label>
          <input type="number" value={weightG} onChange={(event) => setWeightG(event.target.value)} />
        </div>
        <div className="field">
          <label>剩余 g</label>
          <input type="number" value={remainingG} onChange={(event) => setRemainingG(event.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>价格</label>
        <input type="number" value={price} onChange={(event) => setPrice(event.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        {props.cancelLabel !== '' && (
          <button className="button button--ghost" type="button" onClick={props.onCancel}>
            {props.cancelLabel ?? '取消'}
          </button>
        )}
      </div>
      {bean && (
        <div className="note">
          改「剩余 g」等于一次盘点：之前的冲煮不再参与自动退粉。
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
  const [method, setMethod] = useState('V60')
  const [coffeeG, setCoffeeG] = useState('15')
  const [waterG, setWaterG] = useState('250')
  const [waterTemp, setWaterTemp] = useState('92')
  const [timeSeconds, setTimeSeconds] = useState('150')
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
          <label>手法</label>
          <input value={method} onChange={(event) => setMethod(event.target.value)} />
        </div>
        <div className="field">
          <label>研磨</label>
          <input value={grindSize} onChange={(event) => setGrindSize(event.target.value)} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>粉量 g</label>
          <input type="number" value={coffeeG} onChange={(event) => setCoffeeG(event.target.value)} />
        </div>
        <div className="field">
          <label>水量 g</label>
          <input type="number" value={waterG} onChange={(event) => setWaterG(event.target.value)} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>水温 ℃</label>
          <input type="number" value={waterTemp} onChange={(event) => setWaterTemp(event.target.value)} />
        </div>
        <div className="field">
          <label>时间 秒</label>
          <input type="number" value={timeSeconds} onChange={(event) => setTimeSeconds(event.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>评分</label>
        <input type="number" value={score} onChange={(event) => setScore(event.target.value)} />
      </div>
      <div className="field">
        <label>备注</label>
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? '保存中…' : '保存这杯'}
        </button>
        <button className="button button--ghost" type="button" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </form>
  )
}

function roastLabel(level: Bean['roastLevel']): string {
  return (
    {
      light: '浅烘',
      medium: '中烘',
      mediumDark: '中深烘',
      dark: '深烘',
      espressoBlend: '意式拼配'
    } as Record<Bean['roastLevel'], string>
  )[level]
}

function formatSeconds(seconds: number): string {
  if (!seconds) return '—'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${`${rest}`.padStart(2, '0')}`
}
