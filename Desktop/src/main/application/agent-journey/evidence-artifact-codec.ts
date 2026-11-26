/**
 * Diff Artifact codec（R6-4.3.4，P4）：`GitDiffArtifact` ↔ `artifact_ref` 列的
 * **唯一**编码与解析入口。
 *
 * 存储格式（版本化，P5 靠 codec 而非猜测字符串格式）：
 *
 * ```
 * v1:<kind>:<JSON.stringify(整个 artifact)>
 * ```
 *
 * - `v1`：版本前缀——将来演进格式时先读前缀，旧数据可按版本分支解析；
 * - `<kind>`：判别标签（无冒号），`artifactRefKind()` 只扫头部、**不 JSON.parse**，
 *   供 `agent-journey:evidence` 轻量 DTO 使用（列表页不解析正文）；
 * - 载荷是完整 artifact 的 JSON（自描述、无自造转义歧义）。
 *
 * 三条硬规则：
 * 1. **空正文不是成功 Diff**：`kind:'diff'` 的 `text === ''` 一律拒绝
 *    （encode 抛错、parse 返回 null）——绝不把空字符串当成功结果；
 * 2. `byte_size` 由 encode 按 **UTF-8 字节**重算（`Buffer.byteLength`），
 *    不信任调用方；parse 时复核一致性，不一致视为损坏；
 * 3. parse 一律走共享契约的严格 zod 判别联合（多余字段拒绝）——
 *    codec 是 Main 内的实现细节，**契约才是格式的权威定义**。
 *
 * 隐私：正文进本 codec 前已由引擎完成敏感硬排除与 `redactSecrets()`；
 * 本层不再读文件、不跑 git，只做编码与预算降级。
 */
import {
  journeyArtifactBodySchema,
  type JourneyArtifactBody
} from '../../../shared/contracts/entities/agent-journey'
import type {
  EvidenceBudgetHook,
  EvidenceFileInsert
} from '../../database/repositories/agent-journey-evidence'
import {
  GIT_DIFF_MAX_BYTES_PER_FILE,
  GIT_DIFF_MAX_BYTES_PER_JOURNEY,
  GIT_DIFF_MAX_BYTES_PER_SNAPSHOT,
  type GitDiffArtifact,
  type GitFileDiff
} from './git-snapshot-types'

/** 当前存储格式版本。改格式必须升版本并保留旧版本解析分支。 */
export const ARTIFACT_REF_VERSION = 'v1'

/** 与契约判别联合一一对应的 kind 集合（头部扫描用）。 */
const ARTIFACT_KINDS = [
  'diff',
  'binary',
  'sensitive',
  'mode_only',
  'symlink',
  'over_budget',
  'unavailable'
] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

// MARK: - 编码 / 解析

/**
 * 编码为 `artifact_ref` 存储串。
 *
 * - `diff`：重算 UTF-8 字节数；**正文为空直接抛错**（空串不是成功 Diff）；
 * - 其余 kind：无正文，只有结构化事实 / 省略原因。
 */
export function encodeArtifactRef(artifact: GitDiffArtifact): string {
  let body: GitDiffArtifact = artifact
  if (artifact.kind === 'diff') {
    if (artifact.text.length === 0) {
      throw new Error('empty diff text is not a valid artifact')
    }
    body = { ...artifact, byte_size: Buffer.byteLength(artifact.text) }
  }
  return `${ARTIFACT_REF_VERSION}:${body.kind}:${JSON.stringify(body)}`
}

function readRefHeader(ref: string): { kind: ArtifactKind; payload: string } | null {
  if (!ref.startsWith(`${ARTIFACT_REF_VERSION}:`)) return null
  const kindStart = ARTIFACT_REF_VERSION.length + 1
  const kindEnd = ref.indexOf(':', kindStart)
  if (kindEnd === -1) return null
  const kind = ref.slice(kindStart, kindEnd)
  if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) return null
  return { kind: kind as ArtifactKind, payload: ref.slice(kindEnd + 1) }
}

/**
 * 解析存储串 → Artifact。任何不一致（坏版本 / 坏 JSON / 契约不符 /
 * 头部与载荷 kind 不一致 / 空正文 / byte_size 与正文不符）→ `null`，
 * **绝不返回半可信的结构**。
 */
export function parseArtifactRef(ref: string): GitDiffArtifact | null {
  const header = readRefHeader(ref)
  if (!header) return null
  let raw: unknown
  try {
    raw = JSON.parse(header.payload)
  } catch {
    return null
  }
  const parsed = journeyArtifactBodySchema.safeParse(raw)
  if (!parsed.success) return null
  const body = parsed.data
  if (body.kind !== header.kind) return null
  if (body.kind === 'diff') {
    // 空正文不是成功 Diff；byte_size 必须与 UTF-8 字节一致（防篡改/防编码错误）
    if (body.text.length === 0) return null
    if (body.byte_size !== Buffer.byteLength(body.text)) return null
  }
  return body as JourneyArtifactBody as GitDiffArtifact
}

/** 只读头部拿 kind（轻量 DTO 用；不解析正文）。版本/kind 不认识 → null。 */
export function artifactRefKind(ref: string): ArtifactKind | null {
  return readRefHeader(ref)?.kind ?? null
}

// MARK: - 轻量描述（`agent-journey:evidence` DTO）

export type ArtifactRefDescription = {
  /** null = 没有可识别的 artifact（未存 / 损坏）。 */
  kind: string | null
  /** available = 正文或结构化事实可读；omitted = 按策略省略；absent = 未存。 */
  status: 'available' | 'omitted' | 'absent'
  /** omitted 的具体原因；其余 null。 */
  omission: string | null
}

/**
 * `artifact_ref` → 轻量元数据：列表页只拿类型与省略原因，
 * **绝不携带 Diff 正文**（正文只经 `agent-journey:evidence:artifact`）。
 *
 * 走完整解析：损坏数据（坏版本 / 坏 JSON / 契约不符）一律报 `absent`，
 * 绝不把读不出内容的行装作 `available`。
 */
export function describeArtifactRef(ref: string | null): ArtifactRefDescription {
  if (ref === null) return { kind: null, status: 'absent', omission: null }
  const body = parseArtifactRef(ref)
  if (!body) return { kind: null, status: 'absent', omission: null }
  if (body.kind === 'over_budget' || body.kind === 'unavailable') {
    return { kind: body.kind, status: 'omitted', omission: body.reason }
  }
  return { kind: body.kind, status: 'available', omission: null }
}

// MARK: - 预算（设计文档 §9.3）

/**
 * 单快照持久化的**防御性**预算（§9.3：沿用引擎常量，双保险）：
 * 正文按 **UTF-8 字节**（不是 JS 字符数）核对；超限的 `diff` 降级为
 * `over_budget`（保留 insertions/deletions 统计），**文件元数据一行不少**。
 *
 * 只处理有正文的 `diff`；binary/sensitive/mode_only/symlink 等结构化标记
 * 不占正文预算、永远保留（它们本身就是诚实的省略/事实说明）。
 * 空正文的 `diff` 原样传下去——`encodeArtifactRef` 会拒绝，由调用方折叠成失败。
 */
export function applyPersistenceDiffBudget(diffs: readonly GitFileDiff[]): GitFileDiff[] {
  let snapshotBytes = 0
  return diffs.map((diff) => {
    if (diff.artifact.kind !== 'diff') return diff
    const bytes = Buffer.byteLength(diff.artifact.text)
    if (bytes > GIT_DIFF_MAX_BYTES_PER_FILE) {
      return {
        ...diff,
        artifact: {
          kind: 'over_budget',
          reason: 'file_budget',
          insertions: diff.insertions,
          deletions: diff.deletions
        } as GitDiffArtifact
      }
    }
    if (snapshotBytes + bytes > GIT_DIFF_MAX_BYTES_PER_SNAPSHOT) {
      return {
        ...diff,
        artifact: {
          kind: 'over_budget',
          reason: 'snapshot_budget',
          insertions: diff.insertions,
          deletions: diff.deletions
        } as GitDiffArtifact
      }
    }
    snapshotBytes += bytes
    return diff
  })
}

/**
 * Journey 总量预算（§9.3，2 MB 的 **Diff 正文**）——**在仓储事务内执行**
 * （hook 由 `finalizeSnapshot` / `insertSnapshotWithFiles` 在同一事务里调用）：
 *
 * - `journeyBytesUsed` 来自 SQLite 已落库的 `v1:diff:*` 字节统计
 *   （`sum(length(CAST(… AS BLOB)))` = UTF-8 字节），检查与写入同事务 →
 *   **无先查后写的超额竞态**；
 * - 只有带正文的 `diff` 参与预算并可能降级为 `over_budget/journey_budget`
 *   （保留 insertions/deletions 统计）；binary/sensitive/over_budget 等
 *   元数据标记**恒存且不计费**——它们是省略原因本身，删掉就失去诚实性；
 * - **绝不删除或改写历史快照**，只影响本次写入。
 */
export const applyJourneyArtifactBudget: EvidenceBudgetHook = (files, journeyBytesUsed) => {
  let used = journeyBytesUsed
  return files.map((file: EvidenceFileInsert): EvidenceFileInsert => {
    const ref = file.artifactRef
    if (ref === null) return file
    if (artifactRefKind(ref) !== 'diff') return file // 元数据标记：恒存、不计费
    const bytes = Buffer.byteLength(ref)
    if (used + bytes > GIT_DIFF_MAX_BYTES_PER_JOURNEY) {
      return {
        ...file,
        artifactRef: encodeArtifactRef({
          kind: 'over_budget',
          reason: 'journey_budget',
          insertions: file.insertions,
          deletions: file.deletions
        })
      }
    }
    used += bytes
    return file
  })
}
