/** 应用内更新提醒（全局 Banner）：只提示，不下载、不安装。 */
export const updateNotice = {
  region: '更新提醒',
  title: 'BrewPhase 发现新版本',
  description: (version: string) => `新版本 ${version} 已发布，可以前往下载页获取。`,
  /** 关闭提醒并记住这个版本；更高版本发布后会再次提醒。 */
  later: '稍后提醒',
  /** 打开 GitHub 下载页（URL 由主进程白名单校验后打开）。 */
  open: '查看更新'
}
