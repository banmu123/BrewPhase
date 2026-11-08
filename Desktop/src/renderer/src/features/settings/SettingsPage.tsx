import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, SyncConflictItem, SyncStatus } from '@shared/contracts'
import { SYNC_PROTOCOL_VERSION } from '@shared/contracts'
import { api } from '../../shared/api'

/**
 * 更多：应用信息、数据位置、设备同步。
 *
 * 诚实性原则不变：状态栏只显示真实存在的状态（服务是否在跑、端口、设备、
 * 冲突数），不做假开关。同步只覆盖第一版真实实现的：启用服务、扫码配对、
 * 设备管理、冲突列表。
 */
export function SettingsPage({ info }: { info: AppInfo | null }) {
  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__titles">
          <h1 className="page-title">更多</h1>
          <p className="page-sub">本地优先 · 不传云端</p>
        </div>
      </header>

      <div className="page-body">
        <div className="columns" data-inspector="off">
          <section className="column">
            <div className="section">
              <span className="overline">应用</span>
              <div className="note">
                版本 {info?.appVersion ?? '—'}
                <br />
                数据库 schema v{info?.dbSchemaVersion ?? '—'}
                <br />
                同步协议 v{SYNC_PROTOCOL_VERSION}
                <br />
                平台 {info?.platform ?? '—'}
              </div>
            </div>

            <div className="section">
              <span className="overline">数据</span>
              <div className="note">
                全部数据存在本机的 SQLite 与 media 目录里，不上传、不登录、不需要网络。
                <br />
                <span className="mono" style={{ fontSize: 10 }}>
                  {info?.dataDir ?? '—'}
                </span>
              </div>
            </div>

            <div className="hairline" />
            <span className="overline">这一版明确没有做</span>
            <ul className="note" style={{ paddingLeft: 18, lineHeight: 2 }}>
              <li>Bonjour 自动发现（二维码直连已可用）</li>
              <li>TLS 传输加密（现行为局域网 HTTP + token/签名，见同步协议文档）</li>
              <li>Reminders 的系统通知调度（只存意图）</li>
              <li>画布手绘工具、连线与分组</li>
              <li>视频播放器（视频文件完整保存，暂只有信息展示）</li>
            </ul>
          </section>

          <section className="column column--main">
            <div className="detail-body">
              <SyncSection />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

/** 设备同步：启用 → 扫码配对 → 设备管理 → 冲突。 */
function SyncSection() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [conflicts, setConflicts] = useState<SyncConflictItem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 正在确认撤销的设备：撤销与「撤销并清空」是两个不同后果，不能一个按钮带过。 */
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokeNote, setRevokeNote] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.sync.status())
      setConflicts(await api.sync.conflicts())
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = api.sync.onChanged(() => void refresh())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [refresh])

  /**
   * 撤销配对。`wipe` 为真时先清空同步实体，再撤销授权。
   *
   * 顺序不能反：撤销之后这台设备的 token 立即失效，虽然本机 IPC 不受影响，
   * 但语义上应当「先处置数据、再断开授权」——中途失败时用户还能重试，
   * 而不是面对一台已经断开、内容却还在的机器。
   */
  async function confirmRevoke(id: string, wipe: boolean): Promise<void> {
    setBusy(true)
    setError(null)
    setRevokeNote(null)
    try {
      if (wipe) {
        const result = await api.sync.wipeData()
        setRevokeNote(
          `已清空 ${result.records} 条记录、${result.tags} 个标签、${result.canvases} 块画布、${result.mediaFiles} 个媒体文件`
        )
      }
      setStatus(await api.sync.revokeDevice(id))
      setRevokingId(null)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function toggleSync(enabled: boolean): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setStatus(await api.sync.enable(enabled))
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function startPairing(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setStatus(await api.sync.startPairing())
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pairingActive = status?.pairing != null
  const remainingSeconds = status?.pairing
    ? Math.max(0, Math.ceil((status.pairing.expiresAt - now) / 1000))
    : 0

  return (
    <>
      <span className="overline">设备同步</span>
      <h2 className="detail-title">iPhone 记录的内容，回到电脑就在这里。</h2>

      <div className="row" style={{ gap: 12, marginBottom: 14 }}>
        <button
          className={status?.enabled ? 'button' : 'button button--primary'}
          disabled={busy}
          onClick={() => void toggleSync(!status?.enabled)}
        >
          {status?.enabled ? '停用局域网同步' : '启用局域网同步'}
        </button>
        {status?.enabled && (
          <button
            className="button button--primary"
            disabled={busy || pairingActive}
            onClick={() => void startPairing()}
          >
            连接新手机
          </button>
        )}
        {status?.running && (
          <span className="note mono">
            运行中 · 端口 {status.port} · {status.addresses[0] ?? '—'}
          </span>
        )}
        {status?.enabled && !status.running && <span className="error">服务未能启动</span>}
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {status?.pairing && (
        <div className="panel" style={{ maxWidth: 360, marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <img
              src={status.pairing.qrDataUrl}
              alt="配对二维码"
              width={148}
              height={148}
              style={{ borderRadius: 10, border: '1px solid var(--hairline)' }}
            />
            <div className="stack" style={{ flex: 1 }}>
              <span className="overline" style={{ margin: 0 }}>
                用 BrewPhase iOS 扫码
              </span>
              <div className="note">
                在 iPhone 的「更多 → 桌面同步」里打开相机扫描。配对码两分钟内有效、
                只能使用一次。
              </div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--roast)' }}>
                {Math.floor(remainingSeconds / 60)}:{String(remainingSeconds % 60).padStart(2, '0')} 后失效
              </div>
              <button className="button button--ghost" onClick={() => void startPairing()}>
                换一个码
              </button>
            </div>
          </div>
        </div>
      )}

      <span className="overline">已配对设备</span>
      {status?.devices.length === 0 ? (
        <div className="empty">还没有配对的设备。</div>
      ) : (
        <div className="list" style={{ maxWidth: 420 }}>
          {status?.devices.map((device) => (
            <div
              key={device.id}
              className="list-item"
              style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}
            >
              <div className="row row--between">
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="list-item__title">{device.name}</span>
                  <span className="list-item__meta">
                    <span className="mono">{device.id}</span>
                    {device.lastSyncAt && (
                      <span>上次同步 {new Date(device.lastSyncAt).toLocaleString()}</span>
                    )}
                  </span>
                </span>
                {revokingId !== device.id && (
                  <button
                    className="button button--danger"
                    disabled={busy}
                    onClick={() => {
                      setRevokeNote(null)
                      setRevokingId(device.id)
                    }}
                  >
                    撤销授权
                  </button>
                )}
              </div>

              {/* 「撤销」与「撤销并清空」后果不同，分两个按钮，不塞进一个确认框。 */}
              {revokingId === device.id && (
                <div className="stack" style={{ gap: 8 }}>
                  <span className="note" style={{ margin: 0 }}>
                    撤销后这台手机不能再同步。也可以同时清空它同步过来的内容：
                    记录、标签、画布和媒体文件会被删除；豆子、冲煮、品鉴保留。
                    清空不可恢复。
                  </span>
                  <div className="row">
                    <button
                      className="button button--ghost"
                      disabled={busy}
                      onClick={() => setRevokingId(null)}
                    >
                      取消
                    </button>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => void confirmRevoke(device.id, false)}
                    >
                      只撤销授权
                    </button>
                    <button
                      className="button button--danger"
                      disabled={busy}
                      onClick={() => void confirmRevoke(device.id, true)}
                    >
                      撤销并清空内容
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {revokeNote && (
        <div className="note" style={{ color: 'var(--sage)' }}>
          {revokeNote}
        </div>
      )}

      <div className="hairline" />
      <span className="overline">冲突{conflicts.length > 0 ? ` · ${conflicts.length}` : ''}</span>
      {conflicts.length === 0 ? (
        <div className="note">
          同一份数据在两端都被修改时会停在这里等你裁决，绝不静默覆盖。
        </div>
      ) : (
        <div className="stack" style={{ maxWidth: 520 }}>
          {conflicts.map((conflict) => (
            <div key={conflict.id} className="panel">
              <div className="row row--between" style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 500, fontSize: 13 }}>
                  {conflict.entityType} · {conflict.remoteSummary}
                </span>
                <span className="note mono" style={{ fontSize: 10 }}>
                  {new Date(conflict.createdAt).toLocaleString()}
                </span>
              </div>
              {conflict.remoteOperation === 'delete' && (
                <div className="note" style={{ marginBottom: 8 }}>
                  手机端删除了这条记录，但电脑端修改过它。保留则两端各留一份；
                  接受将删除电脑端的这条记录。
                </div>
              )}
              <div className="row">
                <button
                  className="button"
                  onClick={async () => {
                    setStatus(await api.sync.resolveConflict(conflict.id, 'local'))
                    setConflicts(await api.sync.conflicts())
                  }}
                >
                  保留电脑版本
                </button>
                <button
                  className="button button--primary"
                  onClick={async () => {
                    const message =
                      conflict.remoteOperation === 'delete'
                        ? '确认删除电脑端的这条记录？（手机端已删除）'
                        : undefined
                    if (message && !window.confirm(message)) return
                    setStatus(await api.sync.resolveConflict(conflict.id, 'remote'))
                    setConflicts(await api.sync.conflicts())
                  }}
                >
                  {conflict.remoteOperation === 'delete' ? '接受删除' : '接受手机版本'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
