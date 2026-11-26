import { describe, expect, it } from 'vitest'
import {
  canStartPairing,
  isPairingBusy,
  pairingBlocker,
  pairingButtonLabelKey,
  pairingNoticeOf
} from '../../src/renderer/src/features/settings/remote-pairing-view'
import { buildStatus, createLinkState } from '../../src/main/remote/link-state'
import type {
  RemoteConfirmFailure,
  RemoteConfirmResult,
  RemotePairingPhase,
  RemoteStatus
} from '../../src/shared/contracts/remote'
import { REMOTE_BUSY_PAIRING_PHASES, REMOTE_PAIRING_PHASES } from '../../src/shared/contracts/remote'
import { zhCN } from '../../src/renderer/src/i18n/messages/zh-CN'
import { enUS } from '../../src/renderer/src/i18n/messages/en-US'

/**
 * 设置页配对区块的展示规则（R5-R3.4.1 §10 / §11 UI 组）。
 *
 * 本仓库没有 renderer 测试设施（无 testing-library、无 jsdom），所以规则
 * 被抽成纯函数——与 `remote-error-view.ts` 同一个理由。这里钉住的是五件事：
 *
 * 1. **凭据没领到就绝不显示「配对完成」**；
 * 2. 网络异常给**可重试**的提示，保存失败给**重新配对**的提示；
 * 3. 进行中的操作会禁用按钮；
 * 4. 已有 pending / 已有 device 时**不会静默覆盖**；
 * 5. 文案里没有任何凭据。
 */

const zh = zhCN.settings.remote
const en = enUS.settings.remote

function statusOf(
  overrides: Partial<Pick<RemoteStatus, 'pendingRegistration' | 'deviceId' | 'pairingPhase'>> = {}
): RemoteStatus {
  return buildStatus({
    link: createLinkState(),
    enabled: false,
    deviceId: null,
    boundUserId: null,
    needsReauth: false,
    cloudOrigin: null,
    verdict: { serviceable: false, reason: 'remote_disabled' },
    grants: [],
    grantEpoch: 0,
    audit: { consecutiveFailures: 0, totalFailures: 0, lastFailureAt: null },
    pairingPhase: 'idle',
    ...overrides
  })
}

const PENDING = {
  deviceId: 'dev_ui_1',
  deviceName: 'this-machine',
  platform: 'darwin',
  confirmCode: '123456',
  expiresAt: Date.now() + 300_000,
  accountLabel: 'tester@example.com'
}

function resultOf(ok: boolean, reason: RemoteConfirmFailure | null): RemoteConfirmResult {
  return { ok, reason, status: statusOf() }
}

/** 所有「还没真正配对成功」的原因。 */
const NOT_DONE: RemoteConfirmFailure[] = [
  'claim_pending',
  'claim_network',
  'credentials_already_issued',
  'credential_save_failed',
  'credential_cleanup_failed',
  'superseded',
  'unauthorized',
  'invalid_code',
  'expired',
  'not_found',
  'device_state',
  'rate_limited',
  'account_changed',
  'network',
  'invalid_response'
]

describe('凭据没领到时绝不显示「配对完成」', () => {
  it('每一个失败原因都渲染成 failed，而不是 done', () => {
    for (const reason of NOT_DONE) {
      const notice = pairingNoticeOf(resultOf(false, reason))
      expect(notice.kind, reason).toBe('failed')
      if (notice.kind === 'failed') expect(notice.reason).toBe(reason)
    }
  })

  it('reason 缺失时退回 invalid_response，仍然不是成功', () => {
    const notice = pairingNoticeOf({ ok: false, reason: null, status: statusOf() })
    expect(notice).toEqual({ kind: 'failed', reason: 'invalid_response' })
  })

  it('只有 ok=true 才是 done', () => {
    expect(pairingNoticeOf(resultOf(true, null))).toEqual({ kind: 'done' })
  })

  it('配对进行中不显示成「已完成」的任何阶段', () => {
    // 进行中的阶段只能影响按钮文案，不能被当成完成态。
    const busy: RemotePairingPhase[] = ['confirming', 'claiming', 'saving']
    for (const phase of busy) {
      expect(REMOTE_BUSY_PAIRING_PHASES).toContain(phase)
      expect(pairingButtonLabelKey({ phase, confirming: false })).not.toBe('confirmDevice')
    }
  })
})

describe('失败提示必须给出可执行的下一步', () => {
  it('网络异常 → 可重试（中英都明确说 retry）', () => {
    const notice = pairingNoticeOf(resultOf(false, 'claim_network'))
    expect(notice.kind).toBe('failed')
    if (notice.kind !== 'failed') return

    expect(zh.confirmFailures[notice.reason]).toMatch(/重试/)
    expect(en.confirmFailures[notice.reason]).toMatch(/retry/i)
    // 而且必须说清「配对还有效」，否则用户会去重新配对。
    expect(zh.confirmFailures[notice.reason]).toMatch(/配对仍然有效/)
    expect(pairingButtonLabelKey({ phase: 'claim_incomplete', confirming: false })).toBe('retryClaim')
  })

  it('领取还在 pending → 同样是可重试，不是终态', () => {
    const notice = pairingNoticeOf(resultOf(false, 'claim_pending'))
    expect(notice.kind).toBe('failed')
    if (notice.kind !== 'failed') return
    expect(zh.confirmFailures[notice.reason]).toMatch(/重试/)
    expect(zh.confirmFailures[notice.reason]).toMatch(/配对仍然有效/)
    expect(pairingButtonLabelKey({ phase: 'claim_incomplete', confirming: false })).toBe('retryClaim')
  })

  it('保存失败 / 凭据已签发 → 明确要求重新配对', () => {
    for (const reason of ['credential_save_failed', 'credentials_already_issued'] as const) {
      expect(zh.confirmFailures[reason], reason).toMatch(/重新配对|重新「配对新设备」/)
      expect(en.confirmFailures[reason], reason).toMatch(/pair again|Pair a new device/i)
    }
  })

  it('撤销也失败 → 要求人工处理（不能显示成已清理）', () => {
    expect(zh.confirmFailures.credential_cleanup_failed).toMatch(/手动删除/)
    expect(zh.confirmFailures.credential_cleanup_failed).toMatch(/重新配对/)
    expect(en.confirmFailures.credential_cleanup_failed).toMatch(/manually/i)
    expect(en.confirmFailures.credential_cleanup_failed).toMatch(/pair again/i)
  })

  it('中英文都有全部新增原因，且不是空串', () => {
    for (const reason of NOT_DONE) {
      expect(zh.confirmFailures[reason], `zh:${reason}`).toBeTruthy()
      expect(en.confirmFailures[reason], `en:${reason}`).toBeTruthy()
      expect(zh.confirmFailures[reason].trim().length).toBeGreaterThan(0)
      expect(en.confirmFailures[reason].trim().length).toBeGreaterThan(0)
    }
  })

  it('每一种进行中的阶段都有对应的中英文案', () => {
    const labels: Array<Parameters<typeof pairingButtonLabelKey>[0]['phase']> = [
      'confirming',
      'claiming',
      'saving',
      'claim_incomplete'
    ]
    for (const phase of labels) {
      const key = pairingButtonLabelKey({ phase, confirming: false })
      expect(zh[key], `zh:${phase}`).toBeTruthy()
      expect(en[key], `en:${phase}`).toBeTruthy()
      expect(zh[key]).not.toBe(en[key])
    }
    expect(pairingButtonLabelKey({ phase: 'awaiting_confirm', confirming: false })).toBe('confirmDevice')
    // 广播还没到时用本地的「已点确认」兜底，不能停在「确认信任这台设备」。
    expect(pairingButtonLabelKey({ phase: 'awaiting_confirm', confirming: true })).toBe('confirmingDevice')
  })
})

describe('进行中的操作会禁用按钮', () => {
  it('confirming / claiming / saving 都算忙', () => {
    for (const phase of REMOTE_BUSY_PAIRING_PHASES) {
      expect(isPairingBusy(phase, null), phase).toBe(true)
    }
    for (const phase of ['idle', 'awaiting_confirm', 'claim_incomplete', 'failed'] as const) {
      expect(isPairingBusy(phase, null), phase).toBe(false)
    }
  })

  it('Renderer 本地的 confirm / cancel 动作同样算忙（广播到达前的兜底）', () => {
    expect(isPairingBusy('awaiting_confirm', 'confirm')).toBe(true)
    expect(isPairingBusy('awaiting_confirm', 'cancel')).toBe(true)
    expect(isPairingBusy(null, null)).toBe(false)
    expect(isPairingBusy(undefined, null)).toBe(false)
  })

  it('忙的时候既不能开始新配对，也不能点确认', () => {
    expect(canStartPairing(statusOf({ pairingPhase: 'confirming' }))).toBe(false)
    expect(canStartPairing(statusOf({ pairingPhase: 'saving' }))).toBe(false)
    expect(canStartPairing(statusOf({ pairingPhase: 'awaiting_confirm' }))).toBe(true)
  })
})

describe('已有配对 / 已有设备时不会静默覆盖', () => {
  it('pending 存在 → 禁止新配对，并给出「先确认或取消」的下一步', () => {
    const status = statusOf({ pendingRegistration: PENDING })
    expect(canStartPairing(status)).toBe(false)
    expect(pairingBlocker(status)).toBe('in_progress')
    expect(zh.pairingInProgress).toMatch(/确认或取消/)
    expect(en.pairingInProgress).toMatch(/Confirm or cancel/i)
  })

  it('已有 deviceId → 禁止新配对，并指向「忘记此设备」', () => {
    const status = statusOf({ deviceId: 'dev_existing' })
    expect(canStartPairing(status)).toBe(false)
    expect(pairingBlocker(status)).toBe('already_paired')
    expect(zh.alreadyPaired).toMatch(/忘记此设备/)
    expect(en.alreadyPaired).toMatch(/Forget this device/i)
  })

  it('两者都没有 → 可以开始配对，且没有多余的提示', () => {
    const status = statusOf()
    expect(canStartPairing(status)).toBe(true)
    expect(pairingBlocker(status)).toBeNull()
    // status 还没加载出来时保守地禁用，且不编造提示。
    expect(canStartPairing(null)).toBe(false)
    expect(pairingBlocker(null)).toBeNull()
  })

  it('pending 优先于 deviceId 报原因（用户该先处理正在跑的那次）', () => {
    const status = statusOf({ pendingRegistration: PENDING, deviceId: 'dev_existing' })
    expect(pairingBlocker(status)).toBe('in_progress')
  })
})

describe('文案不展示任何凭据', () => {
  it('配对相关文案里没有 token / 私钥 / claim_secret 的痕迹', () => {
    const blob = JSON.stringify(zh) + JSON.stringify(en)
    for (const forbidden of ['bp_dev_', 'device_token', 'claim_secret', 'privateKey', 'PRIVATE KEY']) {
      expect(blob, forbidden).not.toContain(forbidden)
    }
  })

  it('每一条失败文案都只说人该做什么，不回显响应体', () => {
    for (const reason of NOT_DONE) {
      expect(zh.confirmFailures[reason]).not.toMatch(/\{|\}|status\s*[:=]/)
      expect(en.confirmFailures[reason]).not.toMatch(/\{|\}|status\s*[:=]/)
    }
  })
})

describe('阶段集合本身', () => {
  it('没有「配对完成」这个阶段：完成靠 pendingRegistration/deviceId 判定', () => {
    expect(REMOTE_PAIRING_PHASES).not.toContain('paired')
    expect(REMOTE_PAIRING_PHASES).not.toContain('done')
    expect(REMOTE_PAIRING_PHASES).toContain('idle')
    expect(REMOTE_PAIRING_PHASES).toContain('claim_incomplete')
    expect(REMOTE_PAIRING_PHASES).toContain('failed')
  })
})
