import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_REF_VERSION,
  applyJourneyArtifactBudget,
  applyPersistenceDiffBudget,
  artifactRefKind,
  describeArtifactRef,
  encodeArtifactRef,
  parseArtifactRef
} from '../../src/main/application/agent-journey/evidence-artifact-codec'
import {
  GIT_DIFF_MAX_BYTES_PER_FILE,
  GIT_DIFF_MAX_BYTES_PER_JOURNEY,
  GIT_DIFF_MAX_BYTES_PER_SNAPSHOT,
  type GitDiffArtifact,
  type GitFileDiff
} from '../../src/main/application/agent-journey/git-snapshot-types'
import type { EvidenceFileInsert } from '../../src/main/database/repositories/agent-journey-evidence'

/**
 * Diff Artifact codec（R6-4.3.4）单元测试：
 * 版本化编码 / 全类型映射 / 空正文拒绝 / UTF-8 字节预算 / 三级容量闸门。
 * 纯函数——不碰 SQLite、git 或文件系统。
 */

const SAMPLES: GitDiffArtifact[] = [
  { kind: 'diff', text: '@@ -1,2 +1,2 @@\n-old\n+new\n', insertions: 1, deletions: 1, byte_size: 0 },
  { kind: 'binary' },
  { kind: 'sensitive' },
  { kind: 'mode_only', mode_before: '100644', mode_after: '100755' },
  { kind: 'symlink', target_before: 'old-target', target_after: null },
  { kind: 'over_budget', reason: 'journey_budget', insertions: 42, deletions: null },
  { kind: 'unavailable', reason: 'baseline_not_stored', insertions: null, deletions: 7 }
]

function fileWith(artifact: GitDiffArtifact, overrides: Partial<EvidenceFileInsert> = {}): EvidenceFileInsert {
  return {
    repoRelativePath: 'src/a.ts',
    changeKind: 'modified',
    statusOrigin: 'worktree',
    contentHashBefore: 'h1',
    contentHashAfter: 'h2',
    preExistingDirty: 0,
    headMoved: 0,
    renameFromPath: null,
    insertions: artifact.kind === 'diff' ? artifact.insertions : null,
    deletions: artifact.kind === 'diff' ? artifact.deletions : null,
    lineRanges: null,
    artifactRef: encodeArtifactRef(artifact),
    observationStatus: 'changed',
    attribution: null,
    attributionConfidence: null,
    ...overrides
  }
}

function diffOf(text: string, insertions = 1): GitFileDiff {
  return {
    repo_relative_path: 'src/a.ts',
    change_kind: 'modified',
    status_origin: 'worktree',
    observation: 'changed',
    content_hash_before: 'h1',
    content_hash_after: 'h2',
    pre_existing_dirty: false,
    head_moved: false,
    rename_from_path: null,
    mode_before: null,
    mode_after: null,
    insertions,
    deletions: 0,
    artifact: { kind: 'diff', text, insertions, deletions: 0, byte_size: Buffer.byteLength(text) }
  }
}

describe('Artifact codec：版本化编码与解析', () => {
  it('七种 GitDiffArtifact 全部往返一致（v1:<kind>:<json> 头部可读）', () => {
    for (const artifact of SAMPLES) {
      const ref = encodeArtifactRef(artifact)
      expect(ref.startsWith(`${ARTIFACT_REF_VERSION}:${artifact.kind}:`)).toBe(true)
      expect(artifactRefKind(ref)).toBe(artifact.kind)
      const parsed = parseArtifactRef(ref)
      // diff 的 byte_size 由 encode 重算（样本里的 0 是故意的错值）
      const expected =
        artifact.kind === 'diff'
          ? { ...artifact, byte_size: Buffer.byteLength(artifact.text) }
          : artifact
      expect(parsed, artifact.kind).toEqual(expected)
    }
  })

  it('byte_size 由 encode 按 UTF-8 重算（不信调用方），parse 复核', () => {
    const text = '+ 你好世界\n'
    const ref = encodeArtifactRef({
      kind: 'diff',
      text,
      insertions: 1,
      deletions: 0,
      byte_size: 999_999 // 谎报的字节数必须被纠正
    })
    const parsed = parseArtifactRef(ref)
    expect(parsed).not.toBeNull()
    expect(parsed!.kind).toBe('diff')
    if (parsed!.kind === 'diff') {
      expect(parsed!.byte_size).toBe(Buffer.byteLength(text)) // UTF-8 字节，不是字符数
      expect(parsed!.byte_size).not.toBe(text.length) // 多字节：两者不等
    }
  })

  it('空字符串不是成功 Diff：encode 拒绝、parse 返回 null', () => {
    expect(() =>
      encodeArtifactRef({ kind: 'diff', text: '', insertions: 0, deletions: 0, byte_size: 0 })
    ).toThrow(/empty diff text/)
    // 手工拼出的空正文存储串同样解析不出来
    const forged = `v1:diff:${JSON.stringify({
      kind: 'diff',
      text: '',
      insertions: 0,
      deletions: 0,
      byte_size: 0
    })}`
    expect(parseArtifactRef(forged)).toBeNull()
    expect(describeArtifactRef(forged)).toEqual({ kind: null, status: 'absent', omission: null })
  })

  it('损坏 / 猜测格式一律拒绝：坏版本、坏 kind、坏 JSON、多余字段、头部载荷不一致、byte_size 不符', () => {
    expect(parseArtifactRef('v2:diff:{}')).toBeNull()
    expect(parseArtifactRef('v1:guess:{}')).toBeNull()
    expect(parseArtifactRef('v1:diff:{not json')).toBeNull()
    expect(parseArtifactRef('no-prefix')).toBeNull()
    // 契约 strict：多余字段 = 不是我们的格式
    expect(
      parseArtifactRef(
        `v1:diff:${JSON.stringify({
          kind: 'diff',
          text: '+x\n',
          insertions: 1,
          deletions: 0,
          byte_size: 3,
          sneaky: true
        })}`
      )
    ).toBeNull()
    // 头部 kind 与载荷 kind 不一致
    expect(
      parseArtifactRef(`v1:sensitive:${JSON.stringify({ kind: 'binary' })}`)
    ).toBeNull()
    // byte_size 与正文 UTF-8 字节不符（篡改/编码错误）
    expect(
      parseArtifactRef(
        `v1:diff:${JSON.stringify({
          kind: 'diff',
          text: '+你好\n',
          insertions: 1,
          deletions: 0,
          byte_size: 4
        })}`
      )
    ).toBeNull()
    // 非法 reason（不在契约枚举内）
    expect(
      parseArtifactRef(
        `v1:over_budget:${JSON.stringify({
          kind: 'over_budget',
          reason: 'made_up',
          insertions: null,
          deletions: null
        })}`
      )
    ).toBeNull()
  })

  it('describeArtifactRef：轻量三态（正文绝不外泄）', () => {
    expect(describeArtifactRef(null)).toEqual({ kind: null, status: 'absent', omission: null })
    const diffRef = encodeArtifactRef(SAMPLES[0])
    expect(describeArtifactRef(diffRef)).toEqual({
      kind: 'diff',
      status: 'available',
      omission: null
    })
    expect(describeArtifactRef(diffRef)).not.toContain('@@') // 描述里没有正文
    expect(describeArtifactRef(encodeArtifactRef(SAMPLES[1]))).toEqual({
      kind: 'binary',
      status: 'available',
      omission: null
    })
    expect(describeArtifactRef(encodeArtifactRef(SAMPLES[2]))).toEqual({
      kind: 'sensitive',
      status: 'available',
      omission: null
    })
    expect(
      describeArtifactRef(
        encodeArtifactRef({ kind: 'over_budget', reason: 'file_budget', insertions: 1, deletions: 0 })
      )
    ).toEqual({ kind: 'over_budget', status: 'omitted', omission: 'file_budget' })
    expect(
      describeArtifactRef(
        encodeArtifactRef({ kind: 'unavailable', reason: 'blob_missing', insertions: null, deletions: null })
      )
    ).toEqual({ kind: 'unavailable', status: 'omitted', omission: 'blob_missing' })
    // 损坏数据不当作可读
    expect(describeArtifactRef('v1:diff:{broken')).toEqual({
      kind: null,
      status: 'absent',
      omission: null
    })
  })
})

describe('持久化预算（§9.3）', () => {
  it('单文件 64 KB：超限降级为 over_budget/file_budget，统计保留', () => {
    const big = 'x'.repeat(GIT_DIFF_MAX_BYTES_PER_FILE + 1)
    const [out] = applyPersistenceDiffBudget([diffOf(big, 123)])
    expect(out.artifact.kind).toBe('over_budget')
    if (out.artifact.kind === 'over_budget') {
      expect(out.artifact.reason).toBe('file_budget')
      expect(out.artifact.insertions).toBe(123) // 统计不丢
    }
    // 行级元数据不因省略正文而消失
    expect(out.insertions).toBe(123)
    expect(out.repo_relative_path).toBe('src/a.ts')
  })

  it('UTF-8 多字节按字节算（30,000 个汉字 = 90,000 字节 > 64 KB，字符数不作数）', () => {
    const multibyte = '你'.repeat(30_000) // length = 30_000 < 65_536
    expect(multibyte.length).toBeLessThan(GIT_DIFF_MAX_BYTES_PER_FILE)
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(GIT_DIFF_MAX_BYTES_PER_FILE)
    const [out] = applyPersistenceDiffBudget([diffOf(multibyte)])
    expect(out.artifact.kind).toBe('over_budget') // 按字节判定 → 省略正文
  })

  it('单快照 512 KB：累计超限的后续文件降级，先写入的保留，累计不越界', () => {
    const chunk = 'y'.repeat(60_000)
    const diffs = Array.from({ length: 10 }, (_, i) => diffOf(`${i}${chunk}`, i + 1))
    const out = applyPersistenceDiffBudget(diffs)
    const kept = out.filter((file) => file.artifact.kind === 'diff')
    const omitted = out.filter(
      (file) => file.artifact.kind === 'over_budget' && file.artifact.reason === 'snapshot_budget'
    )
    expect(kept).toHaveLength(8) // 8 × 60 000 = 480 000 ≤ 512 KB；第 9 个越界
    expect(omitted).toHaveLength(2)
    const keptBytes = kept.reduce(
      (sum, file) => sum + (file.artifact.kind === 'diff' ? Buffer.byteLength(file.artifact.text) : 0),
      0
    )
    expect(keptBytes).toBeLessThanOrEqual(GIT_DIFF_MAX_BYTES_PER_SNAPSHOT)
    // 被省略的文件仍保留统计（insertions/deletions 来自原 diff）
    for (const file of omitted) {
      expect(file.insertions).not.toBeNull()
    }
  })

  it('无正文的结构化标记（binary/sensitive/mode/symlink）不占正文预算、永不被降级', () => {
    const diffs: GitFileDiff[] = [
      { ...diffOf('z'.repeat(60_000)), artifact: { kind: 'binary' } },
      { ...diffOf('z'.repeat(60_000)), artifact: { kind: 'sensitive' } },
      { ...diffOf('z'.repeat(60_000)), artifact: { kind: 'mode_only', mode_before: '100644', mode_after: '100755' } },
      { ...diffOf('z'.repeat(60_000)), artifact: { kind: 'symlink', target_before: null, target_after: 't' } },
      diffOf('z'.repeat(60_000))
    ]
    const out = applyPersistenceDiffBudget(diffs)
    expect(out.slice(0, 4).map((file) => file.artifact.kind)).toEqual([
      'binary',
      'sensitive',
      'mode_only',
      'symlink'
    ])
    expect(out[4].artifact.kind).toBe('diff') // 只有正文占预算
  })

  it('Journey 2 MB：超限的 diff 降级 journey_budget，统计保留；元数据标记恒存', () => {
    const nearLimit = GIT_DIFF_MAX_BYTES_PER_JOURNEY - 1_000
    const bigDiff = fileWith({
      kind: 'diff',
      text: 'x'.repeat(60_000),
      insertions: 5,
      deletions: 2,
      byte_size: 60_000
    })
    const meta = fileWith({ kind: 'binary' }, { repoRelativePath: 'img.bin' })

    // 已用接近上限：大 diff 必须降级，但元数据标记保留
    const [converted, keptMeta] = applyJourneyArtifactBudget([bigDiff, meta], nearLimit)
    expect(converted.artifactRef).toMatch(/^v1:over_budget:/)
    expect(describeArtifactRef(converted.artifactRef)).toEqual({
      kind: 'over_budget',
      status: 'omitted',
      omission: 'journey_budget'
    })
    // 统计保留（不写 0、不丢行数）
    expect(converted.insertions).toBe(5)
    expect(converted.deletions).toBe(2)
    expect(keptMeta.artifactRef).toBe(meta.artifactRef)

    // 未超限：原样保留
    const [untouched] = applyJourneyArtifactBudget([bigDiff], 0)
    expect(untouched.artifactRef).toBe(bigDiff.artifactRef)

    // 同批次内累计（先算已用、再逐条累加）：第一条吃掉剩余额度后第二条降级
    const second = fileWith(
      { kind: 'diff', text: 'w'.repeat(60_000), insertions: 1, deletions: 0, byte_size: 60_000 },
      { repoRelativePath: 'src/b.ts' }
    )
    const firstBytes = Buffer.byteLength(bigDiff.artifactRef ?? '')
    const [first, secondOut] = applyJourneyArtifactBudget(
      [bigDiff, second],
      GIT_DIFF_MAX_BYTES_PER_JOURNEY - firstBytes
    )
    expect(first.artifactRef).toBe(bigDiff.artifactRef) // 刚好放得下
    expect(describeArtifactRef(secondOut.artifactRef).omission).toBe('journey_budget')
  })

  it('多字节正文按 UTF-8 字节参与 Journey 预算（字符数不作数）', () => {
    const multibyteRef = encodeArtifactRef({
      kind: 'diff',
      text: '你'.repeat(30_000), // 30 000 字符 / 90 000 字节
      insertions: 1,
      deletions: 0,
      byte_size: 90_000
    })
    const bytes = Buffer.byteLength(multibyteRef)
    expect(bytes).toBeGreaterThan(90_000) // 编码后 ≥ 正文字节
    // 差一点到上限：多字节 diff 必须按字节被拒
    const [out] = applyJourneyArtifactBudget(
      [fileWith({ kind: 'diff', text: '你'.repeat(30_000), insertions: 1, deletions: 0, byte_size: 90_000 })],
      GIT_DIFF_MAX_BYTES_PER_JOURNEY - bytes + 1
    )
    expect(describeArtifactRef(out.artifactRef).omission).toBe('journey_budget')
  })
})
