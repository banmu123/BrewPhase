import { useCallback, useEffect, useState } from 'react'
import type {
  AppInfo,
  McpBridgeStatus,
  McpClientCreated,
  McpClientInfo,
  McpScope,
  SyncConflictItem,
  SyncStatus
} from '@shared/contracts'
import { MCP_SCOPE_GROUPS } from '@shared/contracts'
import { api } from '../../shared/api'
import { SUPPORTED_LOCALES, useI18n } from '../../i18n'
import { useAppStore, type SettingsCategory } from '../../app/store'

/**
 * 更多 / Settings。
 *
 * 二级导航 + 内容页（常规 / 设备同步 / AI 连接）：导航只切分类，每个分类
 * 独立滚动；内容仍在同一个 SettingsPage 里，页面切换不重建连接状态——
 * 同步的轮询与 MCP 的客户端列表都各自在组件内维护，切走再回来会自己刷新。
 *
 * 全部文案走 i18n 字典（`t.settings.*` / `t.sync.*` / `t.mcp.*`）；
 * 用户数据（设备名、客户端名、token、路径）不翻译。
 */

export function SettingsPage({ info }: { info: AppInfo | null }) {
  const { t } = useI18n()
  // 跨页直达（引导页「打开设备同步设置」）：mount 时消费一次挂起的请求，
  // 之后每次新请求跟随切换。用户手动点子导航不经过 store，不受影响。
  const requested = useAppStore((state) => state.openSettingsCategory)
  const consumeRequested = useAppStore((state) => state.consumeOpenSettings)
  const [category, setCategory] = useState<SettingsCategory>('general')

  useEffect(() => {
    const target = requested ?? consumeRequested()
    if (target) setCategory(target)
  }, [requested, consumeRequested])

  const categories: Array<{ key: SettingsCategory; label: string }> = [
    { key: 'general', label: t.settings.nav.general },
    { key: 'sync', label: t.settings.nav.sync },
    { key: 'mcp', label: t.settings.nav.mcp }
  ]

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__titles">
          <h1 className="page-title">{t.settings.title}</h1>
          <p className="page-sub">{t.settings.subtitle}</p>
        </div>
      </header>

      <div className="page-body">
        <div className="settings-shell">
          <nav className="settings-nav" aria-label={t.settings.title}>
            {categories.map((item) => (
              <button
                key={item.key}
                className="settings-nav__item"
                data-active={category === item.key}
                onClick={() => setCategory(item.key)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {category === 'general' && <GeneralSection info={info} />}
            {category === 'sync' && <SyncSection />}
            {category === 'mcp' && <McpSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 常规：语言、应用信息、本地数据、关于。 */
function GeneralSection({ info }: { info: AppInfo | null }) {
  const { t, locale, setLocale } = useI18n()

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">{t.settings.general.title}</h2>

      <section className="settings-subsection">
        <h2 className="settings-subsection__title">{t.settings.general.language}</h2>
        <p className="note" style={{ marginBottom: 10 }}>
          {t.settings.general.languageHint}
        </p>
        <div className="segmented" role="group" aria-label={t.settings.general.language}>
          {SUPPORTED_LOCALES.map((item) => (
            <button
              key={item}
              className="segmented__item"
              data-active={locale === item}
              onClick={() => setLocale(item)}
            >
              {t.settings.general.languageName[item]}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-subsection">
        <h2 className="settings-subsection__title">{t.settings.general.appInfo}</h2>
        <dl className="info-list">
          <dt>{t.settings.general.version}</dt>
          <dd>{info?.appVersion ?? '—'}</dd>
          <dt>{t.settings.general.schemaVersion}</dt>
          <dd>v{info?.dbSchemaVersion ?? '—'}</dd>
          <dt>{t.settings.general.syncProtocol}</dt>
          <dd>v{info?.syncProtocolVersion ?? '—'}</dd>
          <dt>{t.settings.general.platform}</dt>
          <dd>{info?.platform ?? '—'}</dd>
        </dl>
      </section>

      <section className="settings-subsection">
        <h2 className="settings-subsection__title">{t.settings.general.localData}</h2>
        <p className="note">{t.settings.general.localDataNote}</p>
        <dl className="info-list">
          <dt>{t.settings.general.dataDir}</dt>
          <dd className="mono" style={{ fontSize: 11 }}>
            {info?.dataDir ?? '—'}
          </dd>
        </dl>
      </section>

      <section className="settings-subsection">
        <h2 className="settings-subsection__title">{t.settings.general.about}</h2>
        <p className="note">{t.settings.general.aboutText}</p>
        <div className="overline" style={{ marginTop: 14 }}>
          {t.settings.general.notDone}
        </div>
        <ul className="note" style={{ paddingLeft: 18, lineHeight: 2, marginTop: 6 }}>
          {t.settings.general.notDoneItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/** 设备同步：启用 → 扫码配对 → 设备管理 → 冲突。 */
function SyncSection() {
  const { t, formatDateTime } = useI18n()
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
          t.sync.devices.wiped(
            result.records,
            result.tags,
            result.canvases,
            result.beans,
            result.brews,
            result.tastings,
            result.mediaFiles
          )
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
    <div className="settings-section">
      <h2 className="settings-section__title">{t.settings.nav.sync}</h2>
      <p className="settings-lead">{t.sync.headline}</p>

      <div className="row" style={{ gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <button
          className={status?.enabled ? 'button' : 'button button--primary'}
          disabled={busy}
          onClick={() => void toggleSync(!status?.enabled)}
        >
          {status?.enabled ? t.sync.disable : t.sync.enable}
        </button>
        {status?.enabled && (
          <button
            className="button button--primary"
            disabled={busy || pairingActive}
            onClick={() => void startPairing()}
          >
            {t.sync.pairNew}
          </button>
        )}
        {status?.running && (
          <span className="note mono">
            {t.sync.running(status.port ?? 0, status.addresses[0] ?? '—')}
          </span>
        )}
        {status?.enabled && !status.running && <span className="error">{t.sync.startFailed}</span>}
      </div>

      {error && (
        <div className="error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {status?.pairing && (
        <div className="panel" style={{ maxWidth: 360, marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <img
              src={status.pairing.qrDataUrl}
              alt={t.sync.pairing.alt}
              width={148}
              height={148}
              style={{ borderRadius: 10, border: '1px solid var(--hairline)' }}
            />
            <div className="stack" style={{ flex: 1 }}>
              <span className="overline" style={{ margin: 0 }}>
                {t.sync.pairing.scanHint}
              </span>
              <div className="note">{t.sync.pairing.instructions}</div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--roast)' }}>
                {t.sync.pairing.expiresIn(
                  `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`
                )}
              </div>
              <button className="button button--ghost" onClick={() => void startPairing()}>
                {t.sync.pairing.regenerate}
              </button>
            </div>
          </div>
        </div>
      )}

      <span className="overline">{t.sync.devices.title}</span>
      {status?.devices.length === 0 ? (
        <div className="empty">{t.sync.devices.empty}</div>
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
                      <span>{t.sync.devices.lastSync(formatDateTime(device.lastSyncAt))}</span>
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
                    {t.sync.devices.revoke}
                  </button>
                )}
              </div>

              {/* 「撤销」与「撤销并清空」后果不同，分两个按钮，不塞进一个确认框。 */}
              {revokingId === device.id && (
                <div className="stack" style={{ gap: 8 }}>
                  <span className="note" style={{ margin: 0 }}>
                    {t.sync.devices.revokeExplain}
                  </span>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <button
                      className="button button--ghost"
                      disabled={busy}
                      onClick={() => setRevokingId(null)}
                    >
                      {t.sync.devices.cancel}
                    </button>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => void confirmRevoke(device.id, false)}
                    >
                      {t.sync.devices.revokeOnly}
                    </button>
                    <button
                      className="button button--danger"
                      disabled={busy}
                      onClick={() => void confirmRevoke(device.id, true)}
                    >
                      {t.sync.devices.revokeAndWipe}
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
      <span className="overline">
        {conflicts.length > 0 ? t.sync.conflicts.titleWithCount(conflicts.length) : t.sync.conflicts.title}
      </span>
      {conflicts.length === 0 ? (
        <div className="note">{t.sync.conflicts.empty}</div>
      ) : (
        <div className="stack" style={{ maxWidth: 520 }}>
          {conflicts.map((conflict) => (
            <div key={conflict.id} className="panel">
              <div className="row row--between" style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 500, fontSize: 13 }}>
                  {conflict.entityType} · {conflict.remoteSummary}
                </span>
                <span className="note mono" style={{ fontSize: 10 }}>
                  {formatDateTime(conflict.createdAt)}
                </span>
              </div>
              {conflict.remoteOperation === 'delete' && (
                <div className="note" style={{ marginBottom: 8 }}>
                  {t.sync.conflicts.deleteExplain}
                </div>
              )}
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button
                  className="button"
                  onClick={async () => {
                    setStatus(await api.sync.resolveConflict(conflict.id, 'local'))
                    setConflicts(await api.sync.conflicts())
                  }}
                >
                  {t.sync.conflicts.keepLocal}
                </button>
                <button
                  className="button button--primary"
                  onClick={async () => {
                    const message =
                      conflict.remoteOperation === 'delete' ? t.sync.conflicts.confirmDelete : undefined
                    if (message && !window.confirm(message)) return
                    setStatus(await api.sync.resolveConflict(conflict.id, 'remote'))
                    setConflicts(await api.sync.conflicts())
                  }}
                >
                  {conflict.remoteOperation === 'delete'
                    ? t.sync.conflicts.acceptDelete
                    : t.sync.conflicts.acceptRemote}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * AI 连接（MCP）：创建客户端 → 勾选 scope → 一次性展示 token → 复制配置 → 撤销。
 *
 * 诚实性原则：Bridge 是否在跑、socket 在哪、MCP 入口路径是什么，都直接显示
 * 真实值；明文 token 只在创建成功的那一次出现在这个组件里，关闭即不可再取。
 */
function McpSection() {
  const { t, formatDateTime } = useI18n()
  const [clients, setClients] = useState<McpClientInfo[]>([])
  const [status, setStatus] = useState<McpBridgeStatus | null>(null)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<McpScope[]>(['records:read', 'coffee:read', 'canvas:read'])
  const [created, setCreated] = useState<McpClientCreated | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyNote, setCopyNote] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [nextClients, nextStatus] = await Promise.all([api.mcp.listClients(), api.mcp.bridgeStatus()])
      setClients(nextClients)
      setStatus(nextStatus)
      setError(null)
    } catch (loadError) {
      setError(errorMessage(loadError))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggleScope = (scope: McpScope): void => {
    setScopes((previous) =>
      previous.includes(scope) ? previous.filter((item) => item !== scope) : [...previous, scope]
    )
  }

  const create = async (): Promise<void> => {
    if (!name.trim() || scopes.length === 0) return
    setBusy(true)
    try {
      const result = await api.mcp.createClient({ name: name.trim(), scopes })
      setCreated(result)
      setName('')
      setCopyNote(null)
      await load()
    } catch (createError) {
      setError(errorMessage(createError))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await api.mcp.revokeClient(id)
      setRevokingId(null)
      await load()
    } catch (revokeError) {
      setError(errorMessage(revokeError))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyNote(label)
    } catch {
      setCopyNote(t.common.copyFailed)
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">{t.settings.nav.mcp}</h2>
      <p className="settings-lead">{t.mcp.headline}</p>
      <p className="note" style={{ marginBottom: 8 }}>
        {t.mcp.intro}
      </p>
      <div className="settings-code mono" style={{ marginBottom: 14 }}>
        {status?.running
          ? t.mcp.bridge.running(status.socketPath ?? '—')
          : t.mcp.bridge.stopped}
        {status && !status.platformSupported ? t.mcp.bridge.unsupported : ''}
      </div>

      {error && <div className="field-hint field-hint--error">{error}</div>}

      {created ? (
        <div className="panel" style={{ marginBottom: 20 }}>
          <span className="overline" style={{ marginTop: 0 }}>
            {t.mcp.created.title(created.name)}
          </span>
          <div className="note" style={{ margin: '8px 0' }}>
            <span className="mono" style={{ wordBreak: 'break-all', fontSize: 11 }}>
              {created.token}
            </span>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <button className="button" onClick={() => void copy(created.token, t.mcp.created.copyToken)}>
              {t.mcp.created.copyToken}
            </button>
            <button
              className="button"
              onClick={() => void copy(codexConfig(status, created.token), t.mcp.created.copyCodex)}
            >
              {t.mcp.created.copyCodex}
            </button>
            <button
              className="button"
              onClick={() => void copy(workbuddyConfig(status, created.token), t.mcp.created.copyWorkBuddy)}
            >
              {t.mcp.created.copyWorkBuddy}
            </button>
            <button className="button button--ghost" onClick={() => setCreated(null)}>
              {t.mcp.created.dismiss}
            </button>
          </div>
          {copyNote && <div className="field-hint field-hint__ok">{copyNote}</div>}
          <pre
            className="note mono"
            style={{ fontSize: 10, whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.03)', padding: 10 }}
          >
            {codexConfig(status, created.token)}
          </pre>
        </div>
      ) : (
        <div className="panel" style={{ marginBottom: 20 }}>
          <span className="overline" style={{ marginTop: 0 }}>
            {t.mcp.create.title}
          </span>
          <div className="settings-form-row">
            <div className="field">
              <label htmlFor="mcp-client-name">{t.mcp.create.name}</label>
              <input
                id="mcp-client-name"
                value={name}
                placeholder={t.mcp.create.namePlaceholder}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <button
              className="button button--primary"
              disabled={busy || !name.trim() || scopes.length === 0}
              onClick={() => void create()}
            >
              {t.mcp.create.submit}
            </button>
          </div>
          <div className="note" style={{ marginTop: 10 }}>
            {MCP_SCOPE_GROUPS.map((group) => (
              <div key={group.group} className="scope-group">
                <span className="scope-group__label">{t.mcp.create.scopeGroup[group.group]}</span>
                {group.scopes.map((scope) => (
                  <label key={scope} className="scope-option">
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                    />
                    <span className="mono" style={{ fontSize: 10 }}>
                      {scope}
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <span className="overline">{t.mcp.clients.title}</span>
      {clients.length === 0 ? (
        <div className="note" style={{ marginTop: 6 }}>
          {t.mcp.clients.empty}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          {clients.map((client) => {
            const revoked = client.revokedAt !== null
            return (
              <div key={client.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {client.name}
                    {revoked && <span className="note">{t.mcp.clients.revoked}</span>}
                  </div>
                  <div className="mono" style={{ fontSize: 10, opacity: 0.7 }}>
                    {client.scopes.join(' · ')}
                  </div>
                  <div className="note" style={{ fontSize: 10 }}>
                    {t.mcp.clients.lastUsed(
                      client.lastUsedAt ? formatDateTime(client.lastUsedAt) : t.common.never
                    )}
                  </div>
                </div>
                {!revoked &&
                  (revokingId === client.id ? (
                    <button
                      className="button button--danger"
                      disabled={busy}
                      onClick={() => void revoke(client.id)}
                    >
                      {t.mcp.clients.revokeConfirm}
                    </button>
                  ) : (
                    <button className="button button--ghost" onClick={() => setRevokingId(client.id)}>
                      {t.mcp.clients.revoke}
                    </button>
                  ))}
              </div>
            )
          })}
        </div>
      )}

      <div className="hairline" />
      <details className="settings-details">
        <summary>{t.mcp.local.title}</summary>
        <div className="note" style={{ fontSize: 10, lineHeight: 1.9 }}>
          {t.mcp.local.entry}：<span className="mono">{status?.mcpEntryPath ?? '—'}</span>
          <br />
          {t.mcp.local.dataDir}：<span className="mono">{status?.userDataDir ?? '—'}</span>
          <br />
          {t.mcp.local.command}：<span className="mono">node {status?.mcpEntryPath ?? '<out/mcp/stdio.mjs>'}</span>
          <br />
          {t.mcp.local.buildHint('pnpm mcp:build')}
        </div>
        {status && (
          <button
            className="button"
            style={{ marginTop: 8 }}
            onClick={() =>
              void copy(
                `node ${status.mcpEntryPath}\nuser-data: ${status.userDataDir}\nbridge: ${status.socketPath ?? 'n/a'} (v${status.protocolVersion})`,
                t.mcp.local.copyInfo
              )
            }
          >
            {t.mcp.local.copyInfo}
          </button>
        )}
      </details>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codexConfig(status: McpBridgeStatus | null, token: string): string {
  return `[mcp_servers.brewphase]
command = "node"
args = ["${status?.mcpEntryPath ?? '<Desktop>/out/mcp/stdio.mjs'}"]

[mcp_servers.brewphase.env]
BREWPHASE_MCP_TOKEN = "${token}"
BREWPHASE_MCP_USER_DATA_DIR = "${status?.userDataDir ?? '<BrewPhase userData>'}"`
}

function workbuddyConfig(status: McpBridgeStatus | null, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        brewphase: {
          type: 'stdio',
          command: 'node',
          args: [status?.mcpEntryPath ?? '<Desktop>/out/mcp/stdio.mjs'],
          env: {
            BREWPHASE_MCP_TOKEN: token,
            BREWPHASE_MCP_USER_DATA_DIR: status?.userDataDir ?? '<BrewPhase userData>'
          },
          timeout: 30000
        }
      }
    },
    null,
    2
  )
}
