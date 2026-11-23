import type { JourneyDetailV1 } from '@shared/contracts'
import { useI18n } from '../i18n'

/**
 * 结构化执行详情的**唯一渲染实现**（R6-4.2 §9.2 / §9.3）。
 *
 * Records 的 Journey 详情与 Canvas 的 Event Inspector 共用这一份——
 * 两处各写一遍迟早会漂移成「同一事件在两个页面长得不一样」。
 *
 * 分区顺序按「先看改了什么，再看为什么，最后看怎么验证的」排：
 * 修改位置 → 决策依据 → 实际观察 → 实际验证 → 证据来源 → 尚未解决。
 *
 * **没有结构化详情时返回 null**：旧事件继续显示原始 summary / content，
 * 由父级渲染「尚无详细执行信息」——不放空卡片占位，更不编造内容（场景 E）。
 */
export function EventDetailSections(props: {
  detail: JourneyDetailV1 | null
  evidenceLevel: string
  metadata: Record<string, unknown> | null
}) {
  const { t } = useI18n()
  const detail = props.detail
  if (!detail) return null

  const copy = t.records.journey.detail
  /*
   * 证据等级只有 `agent_reported`（Service 层拒绝其它值，R6-4.2 §7）。
   * 这里仍然做「不认识就原样显示」的兜底：未来接入真实运行时证据时，
   * 旧 UI 不会因为多出一个等级就把整块渲染打崩。
   */
  const evidenceLabel =
    props.evidenceLevel === 'agent_reported' ? copy.agentReported : props.evidenceLevel

  return (
    <>
      {/* ── 修改位置 + 具体修改 + 为什么改在这里 ──
          三者都来自同一个 `changes[]`，按文件成卡比拆成三个列表更好读：
          一眼看到「哪个文件 → 改了什么 → 为什么在这里改」。 */}
      {detail.changes && detail.changes.length > 0 && (
        <section className="journey-detail__section">
          <h4 className="journey-detail__section-title">{copy.changes}</h4>
          <ol className="journey-file-list">
            {detail.changes.map((change) => (
              <li key={change.file_path} className="journey-file-card">
                <div className="journey-file-card__head">
                  <code className="journey-file-card__path">{change.file_path}</code>
                  <span className="journey-chip journey-chip--change" data-type={change.change_type}>
                    {copy.changeType[change.change_type] ?? change.change_type}
                  </span>
                </div>

                {change.symbols && change.symbols.length > 0 && (
                  <div className="journey-file-card__symbols">
                    <span className="journey-detail__label">{copy.symbols}</span>
                    {change.symbols.map((symbol) => (
                      <code key={symbol} className="journey-symbol">
                        {symbol}
                      </code>
                    ))}
                  </div>
                )}

                <p className="journey-file-card__summary">{change.change_summary}</p>

                {/* 修改前后：只有数据存在才出现，绝不拿空框占位 */}
                {(change.before_behavior || change.after_behavior) && (
                  <div className="journey-diff">
                    {change.before_behavior && (
                      <div className="journey-diff__side journey-diff__side--before">
                        <span className="journey-detail__label">{copy.before}</span>
                        <p>{change.before_behavior}</p>
                      </div>
                    )}
                    {change.after_behavior && (
                      <div className="journey-diff__side journey-diff__side--after">
                        <span className="journey-detail__label">{copy.after}</span>
                        <p>{change.after_behavior}</p>
                      </div>
                    )}
                  </div>
                )}

                <div className="journey-file-card__why">
                  <span className="journey-detail__label">{copy.why}</span>
                  <p>{change.why_this_location}</p>
                </div>

                {change.line_range && (
                  <div className="journey-file-card__lines">
                    L{change.line_range.start}–{change.line_range.end}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ── 决策依据 ── */}
      {detail.decision && (
        <section className="journey-detail__section">
          <h4 className="journey-detail__section-title">{copy.decision}</h4>
          <div className="journey-decision">
            <p className="journey-decision__selected">
              <span className="journey-detail__label">{copy.selected}</span>
              {detail.decision.selected_approach}
            </p>
            <p className="journey-decision__rationale">
              <span className="journey-detail__label">{copy.rationale}</span>
              {detail.decision.rationale}
            </p>

            {detail.decision.alternatives && detail.decision.alternatives.length > 0 && (
              <div className="journey-decision__alts">
                <span className="journey-detail__label">{copy.alternatives}</span>
                <ul>
                  {detail.decision.alternatives.map((alt) => (
                    <li key={alt.approach}>
                      <strong>{alt.approach}</strong>
                      <span>{alt.reason_not_selected}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.decision.tradeoffs && detail.decision.tradeoffs.length > 0 && (
              <div className="journey-decision__tradeoffs">
                <span className="journey-detail__label">{copy.tradeoffs}</span>
                <ul>
                  {detail.decision.tradeoffs.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── 实际观察 ── */}
      {detail.observations && detail.observations.length > 0 && (
        <section className="journey-detail__section">
          <h4 className="journey-detail__section-title">{copy.observations}</h4>
          <ul className="journey-observations">
            {detail.observations.map((item, index) => (
              <li key={`${item.finding}-${index}`}>
                <p className="journey-observations__finding">{item.finding}</p>
                {item.impact && <p className="journey-observations__impact">{item.impact}</p>}
                {item.source && (
                  <p className="journey-observations__source">
                    <span className="journey-detail__label">{copy.source}</span>
                    {item.source}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── 实际验证：结果 Chip 区分通过/失败/未运行 ── */}
      {detail.verification && detail.verification.length > 0 && (
        <section className="journey-detail__section">
          <h4 className="journey-detail__section-title">{copy.verification}</h4>
          <ul className="journey-verify-list">
            {detail.verification.map((item, index) => (
              <li key={`${item.target}-${index}`} className="journey-verify">
                <div className="journey-verify__head">
                  <span className="journey-verify__result" data-result={item.result}>
                    {copy.result[item.result] ?? item.result}
                  </span>
                  <span className="journey-verify__target">{item.target}</span>
                  {typeof item.exit_code === 'number' && (
                    <span className="journey-verify__exit">
                      {copy.exitCode} {item.exit_code}
                    </span>
                  )}
                </div>
                {item.command && <code className="journey-verify__command">{item.command}</code>}
                <p className="journey-verify__summary">{item.summary}</p>
                {item.evidence_reference && (
                  <p className="journey-verify__ref">
                    <span className="journey-detail__label">{copy.evidenceRef}</span>
                    <code>{item.evidence_reference}</code>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── 证据来源：明确区分「Agent 自述」与可追溯引用 ── */}
      <section className="journey-detail__section">
        <h4 className="journey-detail__section-title">{copy.evidence}</h4>
        <div className="journey-evidence">
          <span className="journey-chip journey-chip--evidence" data-level={props.evidenceLevel}>
            {evidenceLabel}
          </span>
          <p className="journey-evidence__hint">{copy.agentReportedHint}</p>
          {detail.references && detail.references.length > 0 && (
            <ul className="journey-refs">
              {detail.references.map((ref) => (
                <li key={`${ref.kind}-${ref.value}`}>
                  <span className="journey-chip">
                    {copy.refKind[ref.kind as keyof typeof copy.refKind] ?? ref.kind}
                  </span>
                  <code>{ref.value}</code>
                  {ref.label && <span className="journey-refs__label">{ref.label}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── 尚未解决 ── */}
      {detail.limitations && detail.limitations.length > 0 && (
        <section className="journey-detail__section">
          <h4 className="journey-detail__section-title">{copy.limitations}</h4>
          <ul className="journey-limitations">
            {detail.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
