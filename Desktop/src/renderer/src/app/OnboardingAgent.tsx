import { useEffect, useMemo, useState } from 'react'
import {
  MCP_SCOPES,
  MCP_SCOPE_PRESETS,
  type AgentApplyOutcome,
  type AgentConfigPlan,
  type AgentDetection,
  type AgentKind,
  type McpBridgeStatus,
  type McpClientCreated,
  type McpScope
} from '@shared/contracts'
import { api } from '../shared/api'
import { useI18n } from '../i18n'
import {
  codexConfig,
  configTargetFrom,
  genericConfig,
  workbuddyConfig
} from '../features/settings/mcp-config'

/**
 * 首次启动的 AI 接入流程。
 *
 * 两条路：
 * - **自动**：检测到 Agent 与配置路径 → 预览将要写入的内容 → 用户确认 →
 *   主进程备份后写入。Token 由主进程直接写进配置文件，不经过界面。
 * - **手动**：一直保留。自动不可用（路径未知、配置解析不了、权限不足）时
 *   它就是唯一的路，也是自动失败后的兜底。
 *
 * 连接验证只看一件事：该客户端的 `lastUsedAt` 是否在创建之后被写过一次。
 * 配置写完、Bridge 在跑，都不算连上。
 */

type AgentCardKind = AgentKind | 'other'

/** 客户端名是专有名词，不随界面语言变。 */
const CLIENT_NAME: Record<AgentCardKind, string> = {
  workbuddy: 'WorkBuddy',
  codex: 'Codex',
  other: 'MCP client'
}

const POLL_INTERVAL_MS = 3_000
const TIMEOUT_MS = 90_000

export function OnboardingAgent(props: { onBack: () => void; onDone: () => void }) {
  const { t } = useI18n()
  const [kind, setKind] = useState<AgentCardKind>('workbuddy')
  // 默认就是第一档全量：用户装 Agent 是为了让它干活，不是来勾权限的。
  // 想收紧可以往下点一档，或展开逐项调整。
  const [preset, setPreset] = useState<string>(MCP_SCOPE_PRESETS[0].key)
  const [scopes, setScopes] = useState<McpScope[]>([...MCP_SCOPE_PRESETS[0].scopes])
  /** 权限默认折叠：默认值就是全给，不该让每个人先读五个选项。 */
  const [scopeOpen, setScopeOpen] = useState(false)
  const [status, setStatus] = useState<McpBridgeStatus | null>(null)
  const [detections, setDetections] = useState<AgentDetection[] | null>(null)

  const [created, setCreated] = useState<McpClientCreated | null>(null)
  const [plan, setPlan] = useState<AgentConfigPlan | null>(null)
  const [outcome, setOutcome] = useState<AgentApplyOutcome | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyNote, setCopyNote] = useState<string | null>(null)

  const [verifyClientId, setVerifyClientId] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const [verifyExpired, setVerifyExpired] = useState(false)

  useEffect(() => {
    void api.mcp
      .bridgeStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
    void api.agents
      .detect()
      .then(setDetections)
      .catch(() => setDetections([]))
  }, [])

  // 验证：以「创建时刻」为基准算截止时间，超时立刻停表并清理定时器；
  // 上一轮没回就不发下一轮，避免请求堆积。
  useEffect(() => {
    if (!verifyClientId || verified) return
    const deadline = Date.now() + TIMEOUT_MS
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setInterval> | null = null

    const stop = (): void => {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }

    const tick = async (): Promise<void> => {
      if (running || stopped) return
      running = true
      try {
        const clients = await api.mcp.listClients()
        const mine = clients.find((client) => client.id === verifyClientId)
        if (!stopped && mine?.lastUsedAt) {
          setVerified(true)
          stop()
          return
        }
      } catch {
        // 读列表失败不改变结论：继续等，超时后给排查提示。
      } finally {
        running = false
      }
      if (!stopped && Date.now() >= deadline) {
        setVerifyExpired(true)
        stop()
      }
    }

    void tick()
    timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
    return stop
  }, [verifyClientId, verified])

  const detectionOf = (target: AgentCardKind): AgentDetection | null =>
    target === 'other' ? null : (detections?.find((item) => item.kind === target) ?? null)

  const supported = status?.platformSupported === true
  // Bridge 没跑起来时，创建 Client 或写配置都没有意义——必须先把这件事说清楚，
  // 而不是让用户以为是 Agent 配置的问题。
  const bridgeReady = supported && status?.running === true

  const currentDetection = detectionOf(kind)
  const canAuto = bridgeReady && currentDetection?.canAutoConfigure === true
  const target = configTargetFrom(status)
  const configText =
    !created || !target
      ? ''
      : kind === 'codex'
        ? codexConfig(target, created.token)
        : kind === 'workbuddy'
          ? workbuddyConfig(target, created.token)
          : genericConfig(target, created.token)

  const badge = useMemo(() => {
    if (!currentDetection) return null
    if (!currentDetection.canAutoConfigure) {
      switch (currentDetection.blockedReason) {
        case 'invalid_config':
          return { label: t.onboarding.agent.auto.badgeInvalid, tone: 'warn' }
        case 'config_path_unknown':
        case 'permission_denied':
          return { label: t.onboarding.agent.auto.badgeUnknown, tone: 'warn' }
        default:
          return { label: t.onboarding.agent.auto.badgeNotDetected, tone: 'muted' }
      }
    }
    return currentDetection.hasBrewphaseEntry
      ? { label: t.onboarding.agent.auto.badgeConfigured, tone: 'ok' }
      : { label: t.onboarding.agent.auto.badgeReady, tone: 'ok' }
  }, [currentDetection, t])

  function applyPreset(key: string): void {
    setPreset(key)
    const found = MCP_SCOPE_PRESETS.find((item) => item.key === key)
    if (found) setScopes([...found.scopes])
  }

  function toggleScope(scope: McpScope): void {
    setPreset('custom')
    setScopes((previous) =>
      previous.includes(scope) ? previous.filter((item) => item !== scope) : [...previous, scope]
    )
  }

  async function startPlan(): Promise<void> {
    if (kind === 'other') return
    setBusy(true)
    setError(null)
    try {
      setPlan(await api.agents.plan(kind))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function confirmPlan(): Promise<void> {
    if (!plan || kind === 'other') return
    setBusy(true)
    setError(null)
    try {
      const result = await api.agents.apply({
        kind,
        name: CLIENT_NAME[kind],
        scopes,
        replaceExisting: plan.conflict
      })
      setOutcome(result)
      setPlan(null)
      if (result.ok) {
        setVerifyExpired(false)
        setVerified(false)
        setVerifyClientId(result.clientId)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function createManually(): Promise<void> {
    if (scopes.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.mcp.createClient({ name: CLIENT_NAME[kind], scopes })
      setCreated(result)
      setCopyNote(null)
      setVerifyExpired(false)
      setVerified(false)
      setVerifyClientId(result.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function copy(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopyNote(label)
    } catch {
      setCopyNote(t.common.copyFailed)
    }
  }

  const scopeLabel = (scope: string): string =>
    (t.onboarding.agent.scopeLabel as Record<string, string>)[scope] ?? scope

  const setupVisible = !created && !plan && !outcome
  const autoSucceeded = outcome?.ok === true

  return (
    <div className="onboarding__card onboarding__card--wide">
      <span className="overline">{t.onboarding.overline}</span>
      <h1 className="onboarding__title">{t.onboarding.agent.title}</h1>
      <p className="onboarding__lead">{t.onboarding.agent.lead}</p>

      {!supported && (
        <div className="onboarding-note" data-tone="warn">
          <strong>{t.onboarding.agent.unsupportedTitle}</strong>
          <p>{t.onboarding.agent.unsupportedBody}</p>
        </div>
      )}

      {supported && status && !status.running && (
        <div className="onboarding-note" data-tone="warn">
          <strong>{t.onboarding.agent.bridgeDownTitle}</strong>
          <p>{t.onboarding.agent.bridgeDownBody}</p>
        </div>
      )}

      {setupVisible && (
        <>
          <h2 className="onboarding-subtitle">{t.onboarding.agent.kindTitle}</h2>
          <div className="agent-picker">
            {(['workbuddy', 'codex', 'other'] as const).map((option) => {
              const detection = detectionOf(option)
              return (
                <button
                  key={option}
                  type="button"
                  className="agent-picker__item"
                  data-selected={kind === option}
                  onClick={() => setKind(option)}
                >
                  <span className="agent-picker__name">{t.onboarding.agent.kinds[option]}</span>
                  <span className="agent-picker__hint">{t.onboarding.agent.kindHints[option]}</span>
                  {detection && (
                    <span
                      className="agent-picker__badge"
                      data-tone={detection.canAutoConfigure ? 'ok' : 'muted'}
                    >
                      {detection.canAutoConfigure
                        ? detection.hasBrewphaseEntry
                          ? t.onboarding.agent.auto.badgeConfigured
                          : t.onboarding.agent.auto.badgeReady
                        : t.onboarding.agent.auto.badgeNotDetected}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {badge && kind !== 'other' && (
            <p className="onboarding-hint">
              {badge.label} · {t.onboarding.agent.auto.planPath}：
              <span className="mono">{currentDetection?.configPath ?? '—'}</span>
            </p>
          )}

          {/*
              权限默认就是全给，所以默认只显示一行摘要。
              需要收紧的人点开才看到档位与逐项清单——不必让所有人先读五个选项。
          */}
          <div className="scope-summary">
            <span className="scope-summary__text">
              <span className="onboarding-subtitle">{t.onboarding.agent.scopeTitle}</span>
              {/*
                  摘要按实际数量说，不按 preset 名字说——否则选了「只看记录」
                  还会显示「全部 14 项」，界面就在撒谎。
              */}
              <span className="scope-summary__value">
                {scopes.length === MCP_SCOPES.length
                  ? t.onboarding.agent.scopeSummaryAll(MCP_SCOPES.length)
                  : t.onboarding.agent.scopeCount(scopes.length, MCP_SCOPES.length)}
              </span>
            </span>
            <button
              type="button"
              className="direction__link"
              onClick={() => setScopeOpen((open) => !open)}
            >
              {scopeOpen ? t.onboarding.agent.scopeCollapse : t.onboarding.agent.scopeAdjust}
            </button>
          </div>

          {scopeOpen && (
            <>
              <div className="preset-list">
                {MCP_SCOPE_PRESETS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="preset-list__item"
                    data-selected={preset === item.key}
                    onClick={() => applyPreset(item.key)}
                  >
                    <span className="preset-list__name">
                      {
                        t.onboarding.agent.presets[
                          item.key as keyof typeof t.onboarding.agent.presets
                        ]
                      }
                    </span>
                    <span className="preset-list__hint">
                      {
                        t.onboarding.agent.presetHints[
                          item.key as keyof typeof t.onboarding.agent.presetHints
                        ]
                      }
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  className="preset-list__item"
                  data-selected={preset === 'custom'}
                  onClick={() => setPreset('custom')}
                >
                  <span className="preset-list__name">{t.onboarding.agent.custom}</span>
                  <span className="preset-list__hint">
                    {t.onboarding.agent.scopeCount(scopes.length, MCP_SCOPES.length)}
                  </span>
                </button>
              </div>

              {preset === 'custom' && (
                <div className="scope-checklist">
                  {MCP_SCOPES.map((scope) => (
                    <label key={scope} className="scope-checklist__item">
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      <span>
                        <span className="mono">{scope}</span>
                        <span className="scope-checklist__label">{scopeLabel(scope)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}

          {error && (
            <p className="onboarding-note" data-tone="error">
              {error}
            </p>
          )}

          <div className="onboarding__actions">
            {canAuto ? (
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => void startPlan()}
              >
                {t.onboarding.agent.auto.oneClick}
              </button>
            ) : (
              <button
                type="button"
                className="button button--primary"
                disabled={busy || scopes.length === 0}
                onClick={() => void createManually()}
              >
                {busy ? t.onboarding.agent.creating : t.onboarding.agent.create}
              </button>
            )}
            <button type="button" className="button button--ghost" onClick={props.onBack}>
              {t.onboarding.agent.back}
            </button>
          </div>
        </>
      )}

      {plan && (
        <>
          <h2 className="onboarding-subtitle">{t.onboarding.agent.auto.planTitle}</h2>
          <p className="onboarding-hint">
            {t.onboarding.agent.auto.planPath}：<span className="mono">{plan.configPath}</span>
          </p>
          <p className="onboarding-hint">
            {t.onboarding.agent.auto.planBackup}：<span className="mono">{plan.backupPath}</span>
          </p>
          <p className="onboarding-note" data-tone={plan.conflict ? 'warn' : 'ok'}>
            {plan.conflict
              ? t.onboarding.agent.auto.planConflict
              : t.onboarding.agent.auto.planNoConflict}
          </p>
          <pre className="onboarding-config mono">{plan.preview}</pre>

          {error && (
            <p className="onboarding-note" data-tone="error">
              {error}
            </p>
          )}

          <div className="onboarding__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => void confirmPlan()}
            >
              {busy ? t.onboarding.agent.auto.writing : t.onboarding.agent.auto.confirm}
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              onClick={() => setPlan(null)}
            >
              {t.onboarding.agent.auto.cancel}
            </button>
          </div>
        </>
      )}

      {outcome && !outcome.ok && (
        <>
          <p className="onboarding-note" data-tone="error">
            {outcome.rollbackFailed
              ? t.onboarding.agent.auto.rollbackFailed
              : t.onboarding.agent.auto.failed}
          </p>
          <p className="onboarding-hint mono">{outcome.configPath}</p>
          <div className="onboarding__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                setOutcome(null)
                void createManually()
              }}
            >
              {t.onboarding.agent.auto.fallback}
            </button>
          </div>
        </>
      )}

      {autoSucceeded && (
        <>
          <h2 className="onboarding-subtitle">{t.onboarding.agent.auto.successTitle}</h2>
          <p className="onboarding-hint">
            {t.onboarding.agent.auto.planPath}：<span className="mono">{outcome.configPath}</span>
          </p>
          {outcome.backupPath && (
            <p className="onboarding-hint">
              {t.onboarding.agent.auto.backupHint(outcome.backupPath)}
            </p>
          )}
          <p className="onboarding-note" data-tone="warn">
            {t.onboarding.agent.auto.successHint(outcome.clientName)}
          </p>

          <h2 className="onboarding-subtitle">{t.onboarding.agent.verifyTitle}</h2>
          <p className="onboarding-hint">{t.onboarding.agent.verifyHint}</p>
          <blockquote className="onboarding-prompt">{t.onboarding.agent.verifyPrompt}</blockquote>
          {verified ? (
            <p className="onboarding-note" data-tone="ok">
              {t.onboarding.agent.verifySuccess}
            </p>
          ) : verifyExpired ? (
            <>
              <p className="onboarding-note" data-tone="warn">
                {t.onboarding.agent.verifyTimeout}
              </p>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setVerifyExpired(false)
                  setVerified(false)
                  setVerifyClientId(null)
                  setTimeout(() => setVerifyClientId(outcome.clientId), 0)
                }}
              >
                {t.onboarding.agent.verifyRetry}
              </button>
            </>
          ) : (
            <p className="onboarding-hint">{t.onboarding.agent.verifyWaiting}</p>
          )}

          <div className="onboarding__actions">
            <button type="button" className="button button--primary" onClick={props.onDone}>
              {t.onboarding.agent.done}
            </button>
          </div>
        </>
      )}

      {created && (
        <>
          <h2 className="onboarding-subtitle">{t.onboarding.agent.created(created.name)}</h2>
          <p className="onboarding-note" data-tone="warn">
            {t.onboarding.agent.tokenOnce}
          </p>

          <div className="onboarding-token mono">{created.token}</div>
          <div className="onboarding-copy-row">
            <button
              type="button"
              className="button"
              onClick={() => void copy(created.token, t.onboarding.agent.copyToken)}
            >
              {t.onboarding.agent.copyToken}
            </button>
            <button
              type="button"
              className="button"
              disabled={!configText}
              onClick={() => void copy(configText, t.onboarding.agent.copyConfig)}
            >
              {t.onboarding.agent.copyConfig}
            </button>
            {copyNote && <span className="field-hint field-hint__ok">{copyNote}</span>}
          </div>

          <p className="onboarding-hint">
            {kind === 'other'
              ? t.onboarding.agent.configHint.other
              : t.onboarding.agent.configHint[kind]}
          </p>
          <pre className="onboarding-config mono">{configText}</pre>

          <h2 className="onboarding-subtitle">{t.onboarding.agent.verifyTitle}</h2>
          <p className="onboarding-hint">{t.onboarding.agent.verifyHint}</p>
          <blockquote className="onboarding-prompt">{t.onboarding.agent.verifyPrompt}</blockquote>
          {verified ? (
            <p className="onboarding-note" data-tone="ok">
              {t.onboarding.agent.verifySuccess}
            </p>
          ) : verifyExpired ? (
            <p className="onboarding-note" data-tone="warn">
              {t.onboarding.agent.verifyTimeout}
            </p>
          ) : (
            <p className="onboarding-hint">{t.onboarding.agent.verifyWaiting}</p>
          )}

          <p className="onboarding-hint">{t.onboarding.agent.revokeHint}</p>

          <div className="onboarding__actions">
            <button type="button" className="button button--primary" onClick={props.onDone}>
              {t.onboarding.agent.done}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
