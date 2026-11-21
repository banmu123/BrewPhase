import { useCallback, useEffect, useState } from 'react'
import type { RemoteDiagnosis, RemoteScope, RemoteStatus } from '@shared/contracts/remote'
import { REMOTE_SCOPES } from '@shared/contracts/remote'
import { useI18n } from '../../i18n'
import { api } from '../../shared/api'
import { formatLastError, shouldHighlightLastError } from './remote-error-view'

/**
 * 设置页「远程访问」面板（Phase 1.1B）。
 *
 * 展示的是**安全状态**，不是控制台：
 *
 * - 没有任何 device_token / 私钥 / claim_secret；
 * - 没有请求参数与结果；
 * - 没有 `remote:call` 之类的「手动触发一次远程工具」按钮。
 *
 * 开启开关必须经过一次**明确的授权范围确认**——因为用户一旦打开，云端 AI
 * 就能读他的记录、豆子与画布。默认是关闭的。
 */

const SCOPE_LABEL_KEYS: Record<RemoteScope, 'records' | 'tags' | 'coffee' | 'canvas'> = {
  'records:read': 'records',
  'tags:read': 'tags',
  'coffee:read': 'coffee',
  'canvas:read': 'canvas'
}

export function RemoteAccessPanel(): React.JSX.Element {
  const { t, formatDateTime } = useI18n()
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [diagnosis, setDiagnosis] = useState<RemoteDiagnosis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 开启前的范围确认。null = 未在确认流程中。 */
  const [confirming, setConfirming] = useState(false)
  const [pendingDevice, setPendingDevice] = useState<{ deviceId: string; confirmCode: string } | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await api.remote.status())
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    }
  }, [])

  useEffect(() => {
    void load()
    // 主进程是唯一事实来源：状态变化一律由它广播。
    return api.remote.onChanged((next) => setStatus(next))
  }, [load])

  const run = async (action: () => Promise<RemoteStatus>): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await action())
      setError(null)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusy(false)
    }
  }

  const enable = async (): Promise<void> => {
    setConfirming(false)
    await run(() => api.remote.enable())
  }

  const loadDiagnosis = async (): Promise<void> => {
    setBusy(true)
    try {
      setDiagnosis(await api.remote.diagnose())
    } catch (diagnoseError) {
      setError(diagnoseError instanceof Error ? diagnoseError.message : String(diagnoseError))
    } finally {
      setBusy(false)
    }
  }

  const copy = t.settings.remote

  return (
    <section className="settings-subsection">
      <h2 className="settings-subsection__title">{copy.title}</h2>
      <p className="settings-lead">{copy.lead}</p>

      {error && <p className="settings-error">{error}</p>}

      {/* ---- 开关 ---- */}
      <div className="settings-row">
        <div className="settings-row__text">
          <span className="settings-row__label">{copy.toggle}</span>
          <span className="settings-row__hint">
            {status?.enabled ? copy.toggleOnHint : copy.toggleOffHint}
          </span>
        </div>
        <button
          className="button"
          disabled={busy || !status}
          data-variant={status?.enabled ? 'danger' : 'primary'}
          onClick={() => {
            if (status?.enabled) void run(() => api.remote.disable())
            else setConfirming(true)
          }}
        >
          {status?.enabled ? copy.disable : copy.enable}
        </button>
      </div>

      {/* ---- 开启前的范围确认 ---- */}
      {confirming && (
        <div className="settings-callout" data-tone="warning">
          <p className="settings-callout__title">{copy.confirmTitle}</p>
          <p className="settings-callout__body">{copy.confirmBody}</p>
          <ul className="settings-scope-list">
            {REMOTE_SCOPES.map((scope) => (
              <li key={scope}>
                <code>{scope}</code>
                <span>{copy.scopeLabels[SCOPE_LABEL_KEYS[scope]]}</span>
              </li>
            ))}
          </ul>
          <p className="settings-callout__body">{copy.confirmReadonly}</p>
          <div className="settings-row__actions">
            <button className="button" onClick={() => setConfirming(false)} disabled={busy}>
              {copy.cancel}
            </button>
            <button className="button" data-variant="primary" onClick={() => void enable()} disabled={busy}>
              {copy.confirm}
            </button>
          </div>
        </div>
      )}

      {/* ---- 当前状态 ---- */}
      {status && (
        <dl className="settings-facts">
          <div>
            <dt>{copy.state}</dt>
            <dd>{copy.states[status.linkState]}</dd>
          </div>
          <div>
            <dt>{copy.device}</dt>
            <dd>{status.deviceId ?? copy.notPaired}</dd>
          </div>
          <div>
            <dt>{copy.boundUser}</dt>
            <dd>{status.boundUserId ?? copy.noUser}</dd>
          </div>
          <div>
            <dt>{copy.serviceable}</dt>
            <dd>
              {status.serviceable
                ? copy.yes
                : `${copy.no}${status.unserviceableReason ? ` (${copy.reasons[status.unserviceableReason]})` : ''}`}
            </dd>
          </div>
          <div>
            <dt>{copy.lastActive}</dt>
            <dd>{status.lastPongAt ? formatDateTime(status.lastPongAt) : copy.never}</dd>
          </div>
          {/* 最近错误：主进程 `RemoteStatus.lastError`，成功握手后被清空。
              空状态显示「无」，绝不显示 null / undefined。 */}
          <div data-testid="remote-last-error">
            <dt>{copy.lastError}</dt>
            <dd>{formatLastError(status.lastError, copy.noError)}</dd>
          </div>
          <div>
            <dt>{copy.reconnectAttempt}</dt>
            <dd>{status.reconnectAttempt}</dd>
          </div>
        </dl>
      )}

      {/* ---- 最近连接错误（开关开着且确实有错才提示） ---- */}
      {status && shouldHighlightLastError({ enabled: status.enabled, lastError: status.lastError }) && (
        <div className="settings-callout" data-tone="warning" data-testid="remote-last-error-callout">
          <p className="settings-callout__title">{copy.lastError}</p>
          <p className="settings-callout__body">{status.lastError}</p>
          <p className="settings-callout__body">{copy.lastErrorHint}</p>
        </div>
      )}

      {/* ---- 阻塞原因 / 需要重新配对 ---- */}
      {status?.blockedReason && (
        <div className="settings-callout" data-tone="warning">
          <p className="settings-callout__title">{copy.blockedTitle}</p>
          <p className="settings-callout__body">{status.blockedReason}</p>
          {status.needsReauth && (
            <div className="settings-row__actions">
              <button className="button" onClick={() => void run(() => api.remote.unbind())} disabled={busy}>
                {copy.unbind}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ---- 授权摘要（逐 Client，不合并） ---- */}
      <div className="settings-block">
        <h3 className="settings-block__title">{copy.grants}</h3>
        {status && status.grants.length > 0 ? (
          <ul className="settings-grant-list">
            {status.grants.map((grant) => (
              <li key={grant.grantCtx}>
                <span className="settings-grant-list__client">{grant.clientName}</span>
                <span className="settings-grant-list__scopes">
                  {grant.scopes.length > 0 ? grant.scopes.join(' · ') : copy.noScopes}
                </span>
                <span className="settings-grant-list__epoch">v{grant.epoch}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-hint">{copy.noGrants}</p>
        )}
      </div>

      {/* ---- 审计告警（进程内计数，重启归零） ---- */}
      {status && status.auditStatus.consecutiveFailures > 0 && (
        <div className="settings-callout" data-tone="danger">
          <p className="settings-callout__title">
            {copy.auditWarning.replace('{count}', String(status.auditStatus.consecutiveFailures))}
          </p>
          <p className="settings-callout__body">
            {copy.auditWarningBody}
            {status.auditStatus.lastFailureAt
              ? ` ${copy.auditLastFailure} ${formatDateTime(status.auditStatus.lastFailureAt)}`
              : ''}
          </p>
          <p className="settings-callout__body">{copy.auditHonesty}</p>
        </div>
      )}

      {/* ---- 配对 / 忘记 / 诊断 ---- */}
      <div className="settings-row__actions">
        <button
          className="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              const registration = await api.remote.register()
              setPendingDevice({ deviceId: registration.deviceId, confirmCode: registration.confirmCode })
              setError(null)
            } catch (registerError) {
              setError(registerError instanceof Error ? registerError.message : String(registerError))
            } finally {
              setBusy(false)
            }
          }}
        >
          {copy.register}
        </button>
        <button className="button" disabled={busy} onClick={() => void loadDiagnosis()}>
          {copy.diagnose}
        </button>
        <button
          className="button"
          data-variant="danger"
          disabled={busy || !status?.deviceId}
          onClick={() => void run(() => api.remote.forget())}
        >
          {copy.forget}
        </button>
      </div>

      {pendingDevice && (
        <div className="settings-callout">
          <p className="settings-callout__title">{copy.pendingTitle}</p>
          <p className="settings-callout__body">{copy.pendingBody}</p>
          <p className="settings-code">{pendingDevice.confirmCode}</p>
          <p className="settings-hint">{copy.pendingMockNote}</p>
        </div>
      )}

      {diagnosis && (
        <div className="settings-block">
          <h3 className="settings-block__title">{copy.diagnose}</h3>
          <dl className="settings-facts">
            <div>
              <dt>{copy.socket}</dt>
              <dd>{diagnosis.socketOpen ? copy.yes : copy.no}</dd>
            </div>
            <div>
              <dt>{copy.inflight}</dt>
              <dd>{diagnosis.inflight}</dd>
            </div>
            <div>
              <dt>{copy.cache}</dt>
              <dd>
                {diagnosis.cacheEntries} / {Math.round(diagnosis.cacheBytes / 1024)} KiB
              </dd>
            </div>
            <div>
              <dt>{copy.lastClose}</dt>
              <dd>
                {diagnosis.lastCloseCode === null
                  ? copy.never
                  : `${diagnosis.lastCloseCode}${diagnosis.lastCloseReason ? ` · ${diagnosis.lastCloseReason}` : ''}`}
              </dd>
            </div>
            {/* 诊断区同样给出最近错误：关掉开关时状态区可能已不再展示它。 */}
            <div data-testid="diagnosis-last-error">
              <dt>{copy.lastError}</dt>
              <dd>{formatLastError(diagnosis.lastError, copy.noError)}</dd>
            </div>
            <div>
              <dt>{copy.reconnectAttempt}</dt>
              <dd>{diagnosis.reconnectAttempt}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  )
}
