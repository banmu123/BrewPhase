/**
 * 下载进度的展示格式化。
 *
 * 只做一件事：把 electron-updater 给的字节数变成人能读的大小。
 * 单位用 KB/MB（两种语言通用），不做本地化数字格式——进度是连续变化的，
 * 千分位分隔反而会让整行数字不停跳。
 */

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '0 B'
  let size = value
  let unit = 0
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  // 字节数保持整数；MB 级别留一位小数，够看又不抖。
  const rounded = unit === 0 || size >= 100 ? Math.round(size) : Math.round(size * 10) / 10
  return `${rounded} ${UNITS[unit]}`
}

/** `1.2 MB / 4.5 MB`；总大小未知时只显示已下载。 */
export function formatProgressBytes(
  transferred: number | null | undefined,
  total: number | null | undefined
): string {
  const done = formatBytes(transferred)
  if (total == null || total <= 0) return done
  return `${done} / ${formatBytes(total)}`
}
