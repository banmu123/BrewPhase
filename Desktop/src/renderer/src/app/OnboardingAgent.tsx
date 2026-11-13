import { useEffect, useState } from 'react'
import {
  MCP_SCOPES,
  MCP_SCOPE_PRESETS,
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
 * 三步：选 Agent → 选权限 → 生成配置。之后**必须**用一次真实调用验证：
 * 复制配置不等于连上，Bridge 在跑也不等于 Agent 连上了。唯一的证据是
 * 对应客户端的 `lastUsedAt` 被写上了——那是主进程在认证成功时更新的时间戳。
 *
 * 这里不做的事：不自动改用户的 Agent 配置文件，不替用户点「信任」，
 * 也不把 Token 写进任何日志。
 */

type AgentKind = 'workbuddy' | 'codex' | 'other'

/** 客户端名是专有名词，不随界面语言变。 */
const CLIENT_NAME: Record<AgentKind, string> = {
  workbuddy: 'WorkBuddy',
  codex: 'Codex',
  other: 'MCP client'
}

const POLL_INTERVAL_MS = 3_000
const TIMEOUT_SECONDS = 90

export function OnboardingAgent(props: { onBack: () => void; onDone: () => void }) {
  const { t } = useI18n()
  const [kind, setKind] = useState<AgentKind>('workbuddy')
  const [preset, setPreset] = useState<string>('personalGrowth')
  const [scopes, setScopes] = useState<McpScope[]>([...MCP_SCOPE_PRESETS[0].scopes])
  const [status, setStatus] = useState<McpBridgeStatus | null>(null)
  const [created, setCreated] = useState<McpClientCreated | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyNote, setCopyNote] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const [waitedSeconds, setWaitedSeconds] = useState(0)
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    void api.mcp
      .bridgeStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  // 验证：轮询当前客户端的 lastUsedAt，直到它被写上一次或超时。
  useEffect(() => {
    if (!created || verified) return
    let stopped = false
    let attempts = 0

    const tick = async (): Promise<void> => {
      attempts += 1
      try {
        const clients = await api.mcp.listClients()
        const mine = clients.find((client) => client.id === created.id)
        if (!stopped && mine?.lastUsedAt) {
          setVerified(true)
          return
        }
      } catch {
        // 读列表失败不改变结论：继续等，超时后会给出排查提示。
      }
      if (!stopped) setWaitedSeconds(attempts * (POLL_INTERVAL_MS / 1000))
    }

    void tick()
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [created, verified, retryToken])

  const supported = status?.platformSupported === true
  const target = configTargetFrom(status)
  const configText = !created || !target
    ? ''
    : kind === 'codex'
      ? codexConfig(target, created.token)
      : kind === 'workbuddy'
        ? workbuddyConfig(target, created.token)
        : genericConfig(target, created.token)

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

  async function create(): Promise<void> {
    if (scopes.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.mcp.createClient({ name: CLIENT_NAME[kind], scopes })
      setCreated(result)
      setCopyNote(null)
      setWaitedSeconds(0)
      setVerified(false)
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

      {supported && !created && (
        <>
          <h2 className="onboarding-subtitle">{t.onboarding.agent.kindTitle}</h2>
          <div className="agent-picker">
            {(['workbuddy', 'codex', 'other'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="agent-picker__item"
                data-selected={kind === option}
                onClick={() => setKind(option)}
              >
                <span className="agent-picker__name">{t.onboarding.agent.kinds[option]}</span>
                <span className="agent-picker__hint">{t.onboarding.agent.kindHints[option]}</span>
              </button>
            ))}
          </div>

          <h2 className="onboarding-subtitle">{t.onboarding.agent.scopeTitle}</h2>
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
                  {t.onboarding.agent.presets[item.key as keyof typeof t.onboarding.agent.presets]}
                </span>
                <span className="preset-list__hint">
                  {t.onboarding.agent.presetHints[item.key as keyof typeof t.onboarding.agent.presetHints]}
                </span>
              </button>
            ))}
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

          {error && <p className="onboarding-note" data-tone="error">{error}</p>}

          <div className="onboarding__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy || scopes.length === 0}
              onClick={() => void create()}
            >
              {busy ? t.onboarding.agent.creating : t.onboarding.agent.create}
            </button>
            <button type="button" className="button button--ghost" onClick={props.onBack}>
              {t.onboarding.agent.back}
            </button>
          </div>
        </>
      )}

      {created && (
        <>
          <h2 className="onboarding-subtitle">{t.onboarding.agent.created(created.name)}</h2>
          <p className="onboarding-note" data-tone="warn">{t.onboarding.agent.tokenOnce}</p>

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

          <p className="onboarding-hint">{t.onboarding.agent.configHint[kind]}</p>
          <pre className="onboarding-config mono">{configText}</pre>

          <h2 className="onboarding-subtitle">{t.onboarding.agent.verifyTitle}</h2>
          <p className="onboarding-hint">{t.onboarding.agent.verifyHint}</p>
          <blockquote className="onboarding-prompt">{t.onboarding.agent.verifyPrompt}</blockquote>

          {verified ? (
            <p className="onboarding-note" data-tone="ok">{t.onboarding.agent.verifySuccess}</p>
          ) : waitedSeconds >= TIMEOUT_SECONDS ? (
            <>
              <p className="onboarding-note" data-tone="warn">{t.onboarding.agent.verifyTimeout}</p>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setWaitedSeconds(0)
                  setRetryToken((current) => current + 1)
                }}
              >
                {t.onboarding.agent.verifyRetry}
              </button>
            </>
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
