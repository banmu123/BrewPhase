import { useCallback, useEffect, useState } from 'react'
import type {
  RemoteConfirmFailure,
  RemoteDiagnosis,
  RemoteScope,
  RemoteStatus
} from '@shared/contracts/remote'
import { REMOTE_SCOPES } from '@shared/contracts/remote'
import { useI18n } from '../../i18n'
import { api } from '../../shared/api'
import { formatLastError, shouldHighlightLastError } from './remote-error-view'
import {
  canStartPairing,
  isPairingBusy,
  pairingBlocker,
  pairingButtonLabelKey,
  pairingNoticeOf
} from './remote-pairing-view'

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
  /**
   * 配对动作的进行态。用一个字段而不是两个布尔：同一时刻只可能有一个动作
   * 在跑，分开存就会出现「确认中点取消」这种不该有的组合。
   */
  const [pairingAction, setPairingAction] = useState<'confirm' | 'cancel' | null>(null)
  const [pairingNotice, setPairingNotice] = useState<
    | { kind: 'done' }
    | { kind: 'cancelled'; revoked: boolean }
    | { kind: 'failed'; reason: RemoteConfirmFailure }
    | null
  >(null)

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

  /**
   * 配对新设备：只发起注册。
   *
   * 刻意**不**在这里确认、也不在这里开开关——注册只产生一台 pending 设备，
   * 用户还需要一步「确认信任这台设备」，远程访问开关也必须由他自己打开。
   */
  const startPairing = async (): Promise<void> => {
    setPairingNotice(null)
    setBusy(true)
    try {
      await api.remote.register()
      setError(null)
    } catch (registerError) {
      setError(registerError instanceof Error ? registerError.message : String(registerError))
    } finally {
      setBusy(false)
    }
  }

  const confirmPairing = async (): Promise<void> => {
    setPairingAction('confirm')
    setPairingNotice(null)
    try {
      const result = await api.remote.confirmRegistration()
      setStatus(result.status)
      // `ok` 只在主进程完成凭据落盘后才为 true（见 remote-pairing-view）。
      setPairingNotice(pairingNoticeOf(result))
      setError(null)
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : String(confirmError))
    } finally {
      setPairingAction(null)
    }
  }

  const cancelPairing = async (): Promise<void> => {
    setPairingAction('cancel')
    setPairingNotice(null)
    try {
      const result = await api.remote.cancelRegistration()
      setStatus(result.status)
      // 本地取消一定成功；`revoked` 表示云端那台 pending 设备是否也撤掉了。
      setPairingNotice({ kind: 'cancelled', revoked: result.revoked })
      setError(null)
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError))
    } finally {
      setPairingAction(null)
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
          disabled={busy || !canStartPairing(status)}
          data-testid="remote-register"
          onClick={() => void startPairing()}
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

      {/* 禁用「配对新设备」时必须给出**可执行**的下一步，
          否则用户只看到一个点不动的按钮（R5-R3.4.1 §9）。 */}
      {pairingBlocker(status) === 'in_progress' && (
        <p className="settings-hint" data-testid="remote-pairing-blocker">
          {copy.pairingInProgress}
        </p>
      )}
      {pairingBlocker(status) === 'already_paired' && (
        <p className="settings-hint" data-testid="remote-pairing-blocker">
          {copy.alreadyPaired}
        </p>
      )}

      {status?.pendingRegistration && (
        <div className="settings-callout" data-tone="warning" data-testid="remote-pending-device">
          <p className="settings-callout__title">{copy.pendingTitle}</p>
          <p className="settings-callout__body">{copy.pendingLead}</p>
          <dl className="settings-facts">
            <div>
              <dt>{copy.pendingDevice}</dt>
              <dd>{status.pendingRegistration.deviceName}</dd>
            </div>
            <div>
              <dt>{copy.pendingPlatform}</dt>
              <dd>{status.pendingRegistration.platform}</dd>
            </div>
            <div>
              <dt>{copy.pendingAccount}</dt>
              <dd>{status.pendingRegistration.accountLabel ?? copy.pendingAccountUnknown}</dd>
            </div>
            <div>
              <dt>{copy.pendingExpires}</dt>
              <dd>{formatDateTime(status.pendingRegistration.expiresAt)}</dd>
            </div>
          </dl>
          <p className="settings-row__label">{copy.pendingCode}</p>
          <p className="settings-code" data-testid="remote-pending-code">
            {status.pendingRegistration.confirmCode}
          </p>
          <p className="settings-hint">{copy.pendingCodeHint}</p>
          <p className="settings-hint">{copy.pendingTrustHint}</p>
          <div className="settings-row__actions">
            <button
              className="button"
              data-variant="primary"
              data-testid="remote-confirm-device"
              disabled={isPairingBusy(status.pairingPhase, pairingAction)}
              onClick={() => void confirmPairing()}
            >
              {copy[
                pairingButtonLabelKey({
                  phase: status.pairingPhase,
                  confirming: pairingAction === 'confirm'
                })
              ]}
            </button>
            <button
              className="button"
              data-testid="remote-cancel-pairing"
              disabled={isPairingBusy(status.pairingPhase, pairingAction)}
              onClick={() => void cancelPairing()}
            >
              {pairingAction === 'cancel' ? copy.cancellingPairing : copy.cancelPairing}
            </button>
          </div>
        </div>
      )}

      {pairingNotice && (
        <div
          className="settings-callout"
          data-tone={pairingNotice.kind === 'failed' ? 'danger' : undefined}
          data-testid="remote-pairing-notice"
        >
          {pairingNotice.kind === 'done' && (
            <p className="settings-callout__body">{copy.pairingDone}</p>
          )}
          {pairingNotice.kind === 'cancelled' && (
            <p className="settings-callout__body">
              {pairingNotice.revoked ? copy.pairingRevoked : copy.pairingRevokePending}
            </p>
          )}
          {pairingNotice.kind === 'failed' && (
            <p className="settings-callout__body">{copy.confirmFailures[pairingNotice.reason]}</p>
          )}
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
