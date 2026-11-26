import type {
  RemoteConfirmFailure,
  RemoteConfirmResult,
  RemotePairingPhase,
  RemoteStatus
} from '@shared/contracts/remote'
import { REMOTE_BUSY_PAIRING_PHASES } from '@shared/contracts/remote'

/**
 * 设置页「配对」区块的展示规则（R5-R3.4.1）。
 *
 * ## 为什么抽成纯函数
 *
 * 本仓库**没有** renderer 测试设施（无 `@testing-library/react`、无 jsdom，
 * vitest `environment: 'node'`）——与 `remote-error-view.ts` 同一个理由。
 * 「凭据没领到时不能显示配对完成」「已有设备时不能静默覆盖」这类规则一旦
 * 留在 JSX 里就钉不住，而它们恰恰是最容易在重构中悄悄退化的一条
 * （把 `result.ok ? done : failed` 改成 `done`，编译期不会有任何动静）。
 *
 * 所以按钮文案、禁用判据、提示文案只在这里出现一次，组件只负责调用。
 *
 * ## 不展示凭据
 *
 * 入参全部来自 `RemoteStatus` / `RemoteConfirmResult`，两者都由主进程保证
 * 不含 `device_token` / 私钥 / `claim_secret`。这里只做**取值与翻译**，
 * 不拼接任何请求上下文。
 */

/** 确认按钮可能显示的文案键（对应 i18n `settings.remote.*`）。 */
export type PairingButtonLabelKey =
  | 'confirmDevice'
  | 'confirmingDevice'
  | 'claimingCredentials'
  | 'savingCredential'
  | 'retryClaim'

/**
 * 确认按钮显示哪一句话。
 *
 * 优先级是**具体阶段 > Renderer 本地的「已点确认」**：主进程广播来的
 * `claiming` / `saving` 比 Renderer 自己记的 `confirming` 更准确——
 * 后台轮询也可能正在领取，那时用户并没有点过确认，但按钮同样该说真话。
 *
 * `idle` / `awaiting_confirm` / `failed` 都落在 `confirmDevice`：
 * 前两个是「等你点」，第三个只可能在 `pendingRegistration` 已经变 null 时
 * 出现（终态失败会清掉 pending），而那时整个区块根本不渲染——
 * 真正的信息由 `pairingNotice` 承担。
 */
export function pairingButtonLabelKey(input: {
  phase: RemotePairingPhase
  /** Renderer 本地的「确认 IPC 已发出」，用于广播到达前的兜底。 */
  confirming: boolean
}): PairingButtonLabelKey {
  switch (input.phase) {
    case 'claiming':
      return 'claimingCredentials'
    case 'saving':
      return 'savingCredential'
    case 'confirming':
      return 'confirmingDevice'
    case 'claim_incomplete':
      return 'retryClaim'
    default:
      return input.confirming ? 'confirmingDevice' : 'confirmDevice'
  }
}

/**
 * 配对相关的按钮是否必须禁用。
 *
 * 两个来源缺一不可：
 * - `pairingAction` 是 Renderer 本地的「我发起了这个 IPC」——广播还没到时
 *   它是唯一能挡住「确认中又点确认」的信号；
 * - `phase` 是主进程广播的「其实有活在跑」——后台轮询领取/落盘时，
 *   Renderer 可能压根没发过任何 IPC，只有它能挡住并发操作。
 */
export function isPairingBusy(
  phase: RemotePairingPhase | null | undefined,
  pairingAction: 'confirm' | 'cancel' | null
): boolean {
  if (pairingAction !== null) return true
  if (!phase) return false
  return (REMOTE_BUSY_PAIRING_PHASES as readonly RemotePairingPhase[]).includes(phase)
}

/**
 * 「配对新设备」能不能点。
 *
 * 两条硬约束（R5-R3.4.1 §9）：
 * 1. **已有 pendingRegistration** → 必须先确认或取消，否则会静默顶替掉
 *    一台 Cloud 上还停着的 pending 设备，确认码也还在用户手上；
 * 2. **已有 deviceId** → 这个 userData 目录只保存一份设备身份，
 *    再注册会把可用凭据顶掉（用户会莫名其妙掉线）。必须先「忘记此设备」。
 *
 * 主进程 `register()` 有同样的两道守卫——Renderer 禁用按钮只是**第一道**，
 * 不能只依赖它（IPC 可以被绕过，测试也必须能在主进程层直接撞到它）。
 */
export function canStartPairing(
  status: Pick<RemoteStatus, 'pendingRegistration' | 'deviceId' | 'pairingPhase'> | null | undefined
): boolean {
  if (!status) return false
  if (status.pendingRegistration) return false
  if (status.deviceId !== null) return false
  return !isPairingBusy(status.pairingPhase, null)
}

/** 「配对新设备」被禁用的原因：用来在按钮旁边给出**可执行**的下一步。 */
export function pairingBlocker(
  status: Pick<RemoteStatus, 'pendingRegistration' | 'deviceId' | 'pairingPhase'> | null | undefined
): 'in_progress' | 'already_paired' | null {
  if (!status) return null
  if (status.pendingRegistration) return 'in_progress'
  if (status.deviceId !== null) return 'already_paired'
  return null
}

export type PairingNotice =
  | { kind: 'done' }
  | { kind: 'cancelled'; revoked: boolean }
  | { kind: 'failed'; reason: RemoteConfirmFailure }

/**
 * 把一次确认的结果翻译成界面提示。
 *
 * **`ok: true` 才是 `done`**——而主进程只在 `device_token` 已经写进安全存储
 * 之后才返回 `ok: true`（Cloud 的 confirm 通过本身不构成配对完成）。
 * 这里因此只做映射、不做任何「看起来差不多就算成功」的兜底：
 * `reason` 缺失时归到 `invalid_response`，那是一句「服务端返回了无法
 * 识别的响应」，绝不会被显示成成功。
 */
export function pairingNoticeOf(result: RemoteConfirmResult): PairingNotice {
  if (result.ok) return { kind: 'done' }
  return { kind: 'failed', reason: result.reason ?? 'invalid_response' }
}
