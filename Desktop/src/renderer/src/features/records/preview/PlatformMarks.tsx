/**
 * 平台品牌标识：一颗一份的内联 SVG，与 shared/icons 的线性图标集分开——
 * 这些是品牌形（fill），不是产品图标（stroke）。不引第三方图标库。
 */

type MarkProps = { size?: number }

/** GitHub Octocat 轮廓（官方 octicon 16 视框）。 */
export function GitHubMark({ size = 16 }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/** YouTube：圆角屏 + 播放三角。 */
export function YouTubeMark({ size = 16 }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M21.6 7.2c-.23-.86-.9-1.54-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.83.43c-.87.23-1.54.9-1.77 1.77C2 8.75 2 12 2 12s0 3.25.4 4.8c.23.86.9 1.54 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.83-.43a2.52 2.52 0 0 0 1.77-1.77c.4-1.55.4-4.8.4-4.8s0-3.25-.4-4.8Z" />
      <path d="M10 15.5v-7l6 3.5-6 3.5Z" fill="#fff" />
    </svg>
  )
}

/** 哔哩哔哩：TV 天线形（线性，品牌粉由调用方 currentColor 控制）。 */
export function BilibiliMark({ size = 16 }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7.5 3 11 7M16.5 3 13 7" />
      <rect x="3" y="7" width="18" height="13" rx="3.5" />
      <path d="M8.5 11.5v3M15.5 11.5v3" />
    </svg>
  )
}

/** X（Twitter）官方字形。 */
export function XMark({ size = 15 }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.41l-5.8-7.58-6.64 7.58H.47l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93Zm-1.29 19.5h2.04L6.48 3.24H4.3l13.31 17.41Z" />
    </svg>
  )
}

/** 播放按钮的三角（叠在封面圆钮里用白色）。 */
export function PlayGlyph({ size = 14 }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13l11-6.5-11-6.5Z" />
    </svg>
  )
}

/** Star / Fork 线形小图标（仓库统计行用）。 */
export function StarGlyph({ size = 12 }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      <path d="M10 2.8l2.3 4.7 5.2.7-3.8 3.6.9 5.1L10 14.4l-4.6 2.5.9-5.1L2.5 8.2l5.2-.7L10 2.8Z" />
    </svg>
  )
}

export function ForkGlyph({ size = 12 }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <circle cx="6" cy="4.5" r="2" />
      <circle cx="14" cy="4.5" r="2" />
      <circle cx="10" cy="15.5" r="2" />
      <path d="M6 6.5v1.8c0 1.4 1.1 2.2 2.6 2.7 1 .3 2.1.5 2.9 1M14 6.5v1.8c0 1.4-1.1 2.2-2.6 2.7-1 .3-2.1.5-2.9 1" />
    </svg>
  )
}
