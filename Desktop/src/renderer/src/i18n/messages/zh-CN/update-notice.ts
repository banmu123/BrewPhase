/** 应用内更新提醒与下载进度：只负责表达，不下载、不安装。 */
export const updateNotice = {
  region: '更新提醒',
  title: 'BrewPhase 发现新版本',
  description: (version: string) => `新版本 ${version} 已发布。`,
  /** 下载**开始前**就要让用户看到：之后不会再问第二次。 */
  restartHint: '更新完成后应用会自动重启，请先保存正在编辑的内容。',
  /** 关闭提醒并记住这个版本；更高版本发布后会再次提醒。 */
  later: '稍后提醒',
  /** 后台下载 → 校验 → 静默安装 → 自动重启。 */
  updateNow: '立即更新',
  /** 本机不能自动更新时的兜底：打开 GitHub 下载页。 */
  manual: '前往下载',
  downloading: (percent: number) => `正在下载更新… ${percent}%`,
  downloaded: '下载完成，正在准备安装…',
  installing: '正在安装并重启…',
  failed: '更新失败',
  retry: '重试'
}
