import { useCallback, useEffect, useState } from 'react'
import type {
  ActionDraft,
  ReplyCategory,
  ReplyDetail,
  ReplySegment
} from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'

/**
 * ReplyPanel —— AI 回复整理（Phase 2）。
 *
 * 三个子视图：
 * 1. **导入**：来源信息 + 手动粘贴 / 剪贴板一次性导入（用户明确点击，
 *    主进程只读一次剪贴板——没有监听、没有轮询、不自动发往任何模型）；
 * 2. **分类结果**：本地规则解析的多标签分段，可改分类（user_edited）、
 *    可存为草稿、可删除；低置信度显示「待确认」；
 * 3. **操作草稿**：只是草稿——status 恒 draft、requiresApproval 恒 true，
 *    没有任何执行按钮；来源回复与工作区绑定一并保存。
 *
 * 内容安全：AI 回复是不可信输入——这里展示的一切命令 / Patch / 路径都是
 * 候选文本，不执行、不写文件、不应用 Patch。
 */

type PanelView = 'intake' | 'segments' | 'drafts'

/** 过滤 tab → 命中的分类集合（patch 归「代码」、follow_up 归「重点」、warning 归「知识」）。 */
const FILTER_TABS: Array<{ key: string; labelKey: 'filterAll' | 'filterKeyPoint' | 'filterKnowledge' | 'filterCopywriting' | 'filterResource' | 'filterOperation' | 'filterCode' | 'filterCommand'; categories: ReplyCategory[] | null }> = [
  { key: 'all', labelKey: 'filterAll', categories: null },
  { key: 'key_point', labelKey: 'filterKeyPoint', categories: ['key_point', 'follow_up'] },
  { key: 'knowledge', labelKey: 'filterKnowledge', categories: ['knowledge', 'warning'] },
  { key: 'copywriting', labelKey: 'filterCopywriting', categories: ['copywriting'] },
  { key: 'resource', labelKey: 'filterResource', categories: ['resource'] },
  { key: 'operation', labelKey: 'filterOperation', categories: ['operation'] },
  { key: 'code', labelKey: 'filterCode', categories: ['code_example', 'patch'] },
  { key: 'shell_command', labelKey: 'filterCommand', categories: ['shell_command'] }
]

const CATEGORY_LABELS: Record<ReplyCategory, string> = {
  key_point: '重点',
  knowledge: '知识',
  copywriting: '文案',
  resource: '资源',
  operation: '操作',
  shell_command: '命令',
  code_example: '代码',
  patch: 'Patch',
  follow_up: '后续',
  warning: '警告'
}

export function ReplyPanel(props: {
  tabId: string
  /** 当前卡片绑定的工作区名（展示用；null = 未绑定）。 */
  workspaceName: string | null
  variant: 'normal' | 'compact' | 'side'
  onBack: () => void
}) {
  const { t } = useI18n()
  const [view, setView] = useState<PanelView>('intake')
  const [detail, setDetail] = useState<ReplyDetail | null>(null)
  const [drafts, setDrafts] = useState<ActionDraft[]>([])
  const [pasted, setPasted] = useState('')
  const [filter, setFilter] = useState<string>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingCategories, setEditingCategories] = useState<ReplyCategory[]>([])
  const [editingContent, setEditingContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshDrafts = useCallback(async (replyId: string | null): Promise<void> => {
    try {
      setDrafts(await api.replyIntelligence.listDrafts(replyId, 100))
    } catch {
      // 草稿列表失败不打断主流程。
    }
  }, [])

  const importReply = async (method: 'clipboard' | 'paste'): Promise<void> => {
    setError(null)
    if (method === 'paste' && pasted.trim() === '') {
      setError(t.workspace.reply.pasteEmpty)
      return
    }
    setBusy(true)
    try {
      const result =
        method === 'clipboard'
          ? await api.replyIntelligence.captureFromClipboard(props.tabId)
          : await api.replyIntelligence.captureFromPaste(props.tabId, pasted)
      setDetail(result)
      setPasted('')
      setFilter('all')
      setView('segments')
      void refreshDrafts(result.reply.id)
    } catch (err) {
      setError(`${t.workspace.reply.importFailed}：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const saveSegmentEdit = async (segmentId: string): Promise<void> => {
    try {
      const updated = await api.replyIntelligence.updateSegment(
        segmentId,
        editingCategories,
        editingContent
      )
      setDetail((current) =>
        current
          ? { ...current, segments: current.segments.map((item) => (item.id === updated.id ? updated : item)) }
          : current
      )
      setEditingId(null)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const removeSegment = async (segmentId: string): Promise<void> => {
    try {
      await api.replyIntelligence.removeSegment(segmentId)
      setDetail((current) =>
        current ? { ...current, segments: current.segments.filter((item) => item.id !== segmentId) } : current
      )
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const saveDraft = async (segmentId: string | null): Promise<void> => {
    if (!detail) return
    try {
      const draft = await api.replyIntelligence.createDraft({ replyId: detail.reply.id, segmentId })
      setDrafts((current) => [draft, ...current.filter((item) => item.id !== draft.id)])
      setError(null)
      setView('drafts')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const removeDraft = async (draftId: string): Promise<void> => {
    try {
      await api.replyIntelligence.removeDraft(draftId)
      setDrafts((current) => current.filter((item) => item.id !== draftId))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const filteredSegments: ReplySegment[] =
    detail?.segments.filter((segment) => {
      const tab = FILTER_TABS.find((item) => item.key === filter)
      if (!tab || tab.categories === null) return true
      return segment.categories.some((category) => tab.categories!.includes(category))
    }) ?? []

  return (
    <div className="cwt__body cwt__body--files" data-reply-panel="">
      <div className="cwt__row">
        <button
          type="button"
          className="cwt__mini cwt__mini--icon"
          onClick={view === 'intake' ? props.onBack : () => setView('intake')}
          title={view === 'intake' ? t.workspace.backToWorkspace : t.workspace.reply.backToImport}
          aria-label={view === 'intake' ? t.workspace.backToWorkspace : t.workspace.reply.backToImport}
        >
          ‹
        </button>
        <span className="cwt__rowtitle">
          {view === 'intake' ? t.workspace.reply.entry : view === 'segments' ? t.workspace.reply.segmentsTitle : t.workspace.reply.draftsTitle}
        </span>
        <span className="spacer" />
        {detail && view === 'intake' && (
          <button type="button" className="cwt__mini" onClick={() => setView('segments')}>
            {t.workspace.reply.segmentsTitle}
          </button>
        )}
        {detail && view !== 'drafts' && (
          <button type="button" className="cwt__mini" onClick={() => setView('drafts')}>
            {t.workspace.reply.viewDrafts}
          </button>
        )}
      </div>

      {/* 来源信息：平台 / 网页 / 工作区——导入前先让用户确认在整理什么。 */}
      {view === 'intake' && (
        <div className="cwt__reply-source">
          <p className="cwt__pathline">
            {t.workspace.reply.sourceLabel}：{detail?.reply.providerName || detail?.reply.providerId || t.workspace.reply.unknownProvider}
            {detail?.reply.sourceTitle ? ` · ${detail.reply.sourceTitle}` : ''}
          </p>
          <p className="cwt__pathline">
            {t.workspace.reply.workspaceLabel}：{props.workspaceName ?? t.workspace.reply.workspaceNone}
          </p>
        </div>
      )}

      {error && <p className="cwt__error">{error}</p>}

      {view === 'intake' && (
        <div className="cwt__intake">
          <textarea
            className="cwt__textarea"
            placeholder={t.workspace.reply.pastePlaceholder}
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            rows={8}
          />
          <div className="cwt__side-actions">
            <button
              type="button"
              className="cwt__mini"
              disabled={busy}
              onClick={() => void importReply('clipboard')}
            >
              {t.workspace.reply.fromClipboard}
            </button>
            <button
              type="button"
              className="cwt__mini cwt__mini--primary"
              disabled={busy || pasted.trim() === ''}
              onClick={() => void importReply('paste')}
            >
              {t.workspace.reply.confirmImport}
            </button>
          </div>
        </div>
      )}

      {view === 'segments' && detail && (
        <>
          <div className="cwt__tabs">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className="cwt__tab"
                data-active={filter === tab.key}
                onClick={() => setFilter(tab.key)}
              >
                {t.workspace.reply[tab.labelKey]}
              </button>
            ))}
          </div>
          <div className="cwt__file-list">
            {filteredSegments.length === 0 && detail.segments.length === 0 && (
              <p className="cwt__stateline">{t.workspace.reply.emptyReplies}</p>
            )}
            {filteredSegments.length === 0 && detail.segments.length > 0 && (
              <p className="cwt__stateline">{t.workspace.reply.emptyReplies}</p>
            )}
            {filteredSegments.map((segment) =>
              editingId === segment.id ? (
                <div key={segment.id} className="cwt__seg cwt__seg--editing">
                  <div className="cwt__chips">
                    {Object.entries(CATEGORY_LABELS).map(([category, label]) => (
                      <button
                        key={category}
                        type="button"
                        className="cwt__chip"
                        data-active={editingCategories.includes(category as ReplyCategory)}
                        onClick={() =>
                          setEditingCategories((current) =>
                            current.includes(category as ReplyCategory)
                              ? current.filter((item) => item !== category)
                              : [...current, category as ReplyCategory]
                          )
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="cwt__stateline">{t.workspace.reply.multiTagHint}</p>
                  <textarea
                    className="cwt__textarea"
                    value={editingContent}
                    onChange={(event) => setEditingContent(event.target.value)}
                    rows={6}
                  />
                  <div className="cwt__row">
                    <span className="spacer" />
                    <button type="button" className="cwt__mini" onClick={() => setEditingId(null)}>
                      {t.workspace.reply.backToSegments}
                    </button>
                    <button
                      type="button"
                      className="cwt__mini cwt__mini--primary"
                      onClick={() => void saveSegmentEdit(segment.id)}
                    >
                      {t.workspace.reply.save}
                    </button>
                  </div>
                </div>
              ) : (
                <div key={segment.id} className="cwt__seg">
                  <div className="cwt__row">
                    <span className="cwt__chips">
                      {segment.categories.map((category) => (
                        <span key={category} className="cwt__chip" data-static="true">
                          {CATEGORY_LABELS[category]}
                        </span>
                      ))}
                    </span>
                    <span className="spacer" />
                    <span className="cwt__count" title={segment.reason}>
                      {segment.confidence < 0.6
                        ? t.workspace.reply.pendingConfirm
                        : t.workspace.reply.confidenceLabel(Math.round(segment.confidence * 100))}
                    </span>
                  </div>
                  <pre className="cwt__seg-content">{segment.content}</pre>
                  <div className="cwt__row">
                    <span className="cwt__count">{t.workspace.reply.sourceOffset(segment.sequence + 1)}</span>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="cwt__mini cwt__mini--primary"
                      onClick={() => void saveDraft(segment.id)}
                    >
                      {t.workspace.reply.saveDraft}
                    </button>
                    <button
                      type="button"
                      className="cwt__mini"
                      onClick={() => {
                        setEditingId(segment.id)
                        setEditingCategories(segment.categories)
                        setEditingContent(segment.content)
                      }}
                    >
                      {t.workspace.reply.edit}
                    </button>
                    <button
                      type="button"
                      className="cwt__mini"
                      onClick={() => void removeSegment(segment.id)}
                    >
                      {t.workspace.reply.delete}
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        </>
      )}

      {view === 'drafts' && (
        <div className="cwt__file-list">
          {drafts.length === 0 && <p className="cwt__stateline">{t.workspace.reply.emptyReplies}</p>}
          {drafts.map((draft) => (
            <div key={draft.id} className="cwt__seg">
              <div className="cwt__row">
                <span className="cwt__seg-title">{draft.title}</span>
                <span className="spacer" />
                <span className="cwt__chip" data-static="true">
                  {t.workspace.reply.draftStatus}
                </span>
              </div>
              <p className="cwt__pathline">
                {draft.riskLevel === 'caution' ? t.workspace.reply.riskCaution : t.workspace.reply.riskNormal} ·{' '}
                {t.workspace.reply.approvalRequired}
              </p>
              <p className="cwt__pathline">
                {t.workspace.reply.commandsLabel(draft.payload.commands.length)} ·{' '}
                {t.workspace.reply.pathsLabel(draft.payload.filePaths.length)}
                {draft.payload.pathsOutsideWorkspace ? ` · ${t.workspace.reply.pathsOutside}` : ''}
              </p>
              <p className="cwt__pathline">
                {t.workspace.reply.workspaceLabel}：{props.workspaceName ?? t.workspace.reply.workspaceNone}
              </p>
              <div className="cwt__row">
                <span className="spacer" />
                <button type="button" className="cwt__mini" onClick={() => void removeDraft(draft.id)}>
                  {t.workspace.reply.delete}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
