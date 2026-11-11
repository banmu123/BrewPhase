import type { BrowserLoadError } from '@shared/contracts'

/**
 * Chromium 的错误码 → 界面上的一句人话（纯函数，可单测）。
 *
 * 为什么不在主进程就把文案拼好：文案要跟着语言切换，而主进程不知道用户此刻
 * 选中哪种语言。主进程只给 `code` / `kind` / `reason`，翻译留在渲染层。
 * `description`（Chromium 原文）只作次要信息展示。
 */
export type BrowserErrorKey =
  | 'blockedScheme'
  | 'emptyInput'
  | 'malformed'
  | 'notFound'
  | 'offline'
  | 'timeout'
  | 'refused'
  | 'certificate'
  | 'crashed'
  | 'generic'

/** net::ERR_* 里我们真的会遇到的几类；其余归入 generic。 */
const NOT_FOUND_CODES = new Set([-105, -137, -300])
const OFFLINE_CODES = new Set([-106, -21, -109])
const TIMEOUT_CODES = new Set([-7, -118])
const REFUSED_CODES = new Set([-100, -101, -102, -104, -324])

export function browserErrorKey(error: BrowserLoadError): BrowserErrorKey {
  if (error.reason === 'blocked-scheme') return 'blockedScheme'
  if (error.reason === 'empty') return 'emptyInput'
  if (error.reason === 'malformed') return 'malformed'
  if (error.kind === 'crash' || error.code === -1) return 'crashed'
  if (NOT_FOUND_CODES.has(error.code)) return 'notFound'
  if (OFFLINE_CODES.has(error.code)) return 'offline'
  if (TIMEOUT_CODES.has(error.code)) return 'timeout'
  if (REFUSED_CODES.has(error.code)) return 'refused'
  // -200..-299 是证书族（过期、域名不匹配、链不可信、HSTS…），全部按一类处理。
  if (error.code <= -200 && error.code > -300) return 'certificate'
  return 'generic'
}

/** 这类错误重试有意义（输入错误重试同一串只会再错一次）。 */
export function isRetryableError(error: BrowserLoadError): boolean {
  return browserErrorKey(error) !== 'blockedScheme' &&
    browserErrorKey(error) !== 'emptyInput' &&
    browserErrorKey(error) !== 'malformed'
}
