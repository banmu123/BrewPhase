import { useI18n } from '../../i18n'
import {
  artifactBodyView,
  parseUnifiedDiff,
  type ArtifactLoadState,
  type ArtifactTarget
} from './journey-artifact-view'

/**
 * 单文件 Diff Viewer（R6-P5.2，设计文档 §11.3）。
 *
 * - **正文只按需读取**：组件自身不发请求——由 JourneyDetail 在用户点击
 *   「查看证据」时经 `createArtifactController` 触发，这里只渲染状态；
 * - **React 安全文本渲染**：unified diff 逐行放进 `<span>` 文本节点
 *   （`parseUnifiedDiff` 先分类），**绝不使用危险 HTML 注入**；
 * - **非 Diff Artifact 分区表达**：二进制 / 敏感 / 权限位 / 链接 / 超预算 /
 *   不可生成各有结构化说明——「正文不可用」永远不等于「没有变化」，
 *   「无法观察」与「无法读取」绝不混成一个状态；
 * - 长文件：正文受引擎 64 KB / 2000 行配额约束，弹层再以 max-height +
 *   双向滚动兜底，不撑破界面；深浅色主题走既有 design token。
 */
export function DiffViewer(props: {
  target: ArtifactTarget
  state: ArtifactLoadState | undefined
  onClose: () => void
  onRetry: () => void
}) {
  const { t } = useI18n()
  const evidenceT = t.records.journey.evidence
  const { target, state } = props

  const body = state?.status === 'loaded' ? artifactBodyView(state.artifact.artifact) : null
  const lines = body?.render === 'diff' ? parseUnifiedDiff(body.text) : null
  const kindKey = target.changeKind as keyof typeof evidenceT.changeKind

  return (
    <div
      className="journey-diff-modal"
      role="dialog"
      aria-modal="true"
      aria-label={target.path}
      onClick={(event) => {
        // 点击遮罩关闭（点面板本身不关闭）
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="journey-diff-modal__panel">
        <div className="journey-diff-modal__head">
          <code className="journey-diff-modal__path">{target.path}</code>
          <span className="journey-diff-modal__kind">
            {evidenceT.changeKind[kindKey] ?? target.changeKind}
          </span>
          <button
            type="button"
            className="button button--ghost journey-diff-modal__close"
            aria-label={t.records.detail.close}
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>

        <div className="journey-diff-modal__body">
          {(!state || state.status === 'loading') && (
            <p className="page-sub" role="status">
              {evidenceT.viewerLoading}
            </p>
          )}

          {state?.status === 'failed' && (
            <div className="journey-inline">
              <p className="page-sub journey-inline__feedback">{evidenceT.viewerLoadFailed}</p>
              <button type="button" className="button" onClick={props.onRetry}>
                {evidenceT.retry}
              </button>
            </div>
          )}

          {body?.render === 'diff' && lines && (
            <pre className="journey-diff-viewer" aria-label={target.path}>
              {lines.map((line, index) => (
                <span
                  key={index}
                  className={`journey-diff-viewer__line journey-diff-viewer__line--${line.type}`}
                >
                  {line.content}
                </span>
              ))}
            </pre>
          )}

          {body?.render === 'marker' && (
            <p className="journey-artifact-info">
              <strong>{evidenceT.artifactKind[body.kind]}</strong>
              {' · '}
              {body.kind === 'binary' ? evidenceT.binaryNote : evidenceT.sensitiveNote}
            </p>
          )}

          {body?.render === 'modes' && (
            <p className="journey-artifact-info">
              <strong>{evidenceT.artifactKind.mode_only}</strong>
              {` · ${body.modeBefore} → ${body.modeAfter}`}
            </p>
          )}

          {body?.render === 'symlink' && (
            <p className="journey-artifact-info">
              <strong>{evidenceT.artifactKind.symlink}</strong>
              {` · ${evidenceT.symlinkTargets(body.targetBefore, body.targetAfter)}`}
              <br />
              <span className="journey-artifact-info__note">{evidenceT.symlinkNote}</span>
            </p>
          )}

          {body?.render === 'stats' && (
            <div className="journey-artifact-info">
              <p>
                <strong>
                  {evidenceT.artifactKind[body.kind] ?? body.kind}
                  {body.reason
                    ? `（${evidenceT.artifactOmission[
                        body.reason as keyof typeof evidenceT.artifactOmission
                      ] ?? body.reason}）`
                    : ''}
                </strong>
                {body.insertions !== null && body.deletions !== null && (
                  <> · {evidenceT.diffStat(body.insertions, body.deletions)}</>
                )}
              </p>
              {/* 关键语义：正文省略 / 不可生成 ≠ 没有发生变化 */}
              <p className="journey-artifact-info__note">
                {body.kind === 'over_budget'
                  ? evidenceT.bodyOmittedNote
                  : evidenceT.bodyUnavailableNote}
              </p>
            </div>
          )}

          {body?.render === 'unknown' && (
            <p className="journey-artifact-info">
              {evidenceT.unknownArtifact}：{body.kind}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
