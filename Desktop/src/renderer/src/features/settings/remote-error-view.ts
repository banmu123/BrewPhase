/**
 * 设置页「最近错误」的展示逻辑（Phase 1.3.3-A-R1）。
 *
 * ## 为什么抽成纯函数
 *
 * 本仓库**没有** renderer 测试设施（无 `@testing-library/react`、无 jsdom，
 * vitest `environment: 'node'`）。把「空值怎么显示」留在 JSX 里，就没法用
 * 现有测试体系钉住——而「不显示 `null` / `undefined`」恰恰是最容易在重构中
 * 悄悄退化的一条（一个 `??` 被删掉，页面就会出现字面量 `null`）。
 *
 * 所以展示规则只在这里出现一次，组件只负责调用它。
 *
 * ## 不展示凭据
 *
 * `lastError` 来自 `RemoteStatus`，本身已由主进程保证不含 token / 私钥
 * （`buildStatus` 只拷贝 `link.lastError`，而它由 `connect()` / `onError` /
 * 注册失败分支写入，内容是固定文案或 transport 的错误描述）。这里只做
 * **空值归一**，不拼接任何请求上下文。
 */

/**
 * 把 `lastError` 归一成可直接渲染的字符串。
 *
 * - `null` / `undefined` / 空串 / 纯空白 → `emptyText`（明确的空状态，
 *   **不是** `null`、`undefined` 或 `""`）；
 * - 其余原样返回（含首尾空白也保留：transport 的错误描述本身不含多余空白，
 *   而 trim 会掩盖「错误文案被意外加了空白」这类问题）。
 */
export function formatLastError(lastError: string | null | undefined, emptyText: string): string {
  if (lastError === null || lastError === undefined) return emptyText;
  if (lastError.length === 0) return emptyText;
  if (lastError.trim().length === 0) return emptyText;
  return lastError;
}

/**
 * 是否需要把「最近错误」渲染成醒目区块（而不是列表里的一行）。
 *
 * 只在**开关已开**且**存在错误**时才提示：关闭状态下 `lastError` 可能是
 * 上一轮残留，此时把它标成告警只会制造噪音。
 */
export function shouldHighlightLastError(input: {
  enabled: boolean
  lastError: string | null | undefined
}): boolean {
  if (!input.enabled) return false
  return formatLastError(input.lastError, '') !== ''
}
