import { join } from 'node:path'

/**
 * 打包版的 userData 目录名。
 *
 * electron-builder 的 `productName: BrewPhase` 只改了 app bundle 与
 * Info.plist 的 CFBundleName；Electron 的 `app.getName()` 读的是
 * package.json 的 `name`（`brewphase-desktop`）。于是开发构建与正式安装包
 * 默认共用同一个 `~/Library/Application Support/brewphase-desktop`。
 *
 * 2026-11-10 实测：新下载的桌面端一打开就有 7 支豆子——那是开发联调
 * 留在共享库里的数据（打包产物本身没有任何预置数据库，干净目录下首屏
 * 显示空态）。让打包版显式切到与产品名一致的独立目录即可根治。
 *
 * 旧目录**不删不搬**：里面是开发/联调数据，搬过去等于把污染带进正式版。
 * 真正需要的用户可以手动复制 `brewphase.db` 与 `media/`。
 */
export const PACKAGED_USER_DATA_NAME = 'BrewPhase'

/**
 * 返回需要显式设置的 userData 路径；`null` = 沿用 Electron 默认目录。
 *
 * 优先级：便携/测试的环境变量覆盖 > 打包版隔离 > 开发态默认。
 * 开发态必须保持默认值：`tests/e2e/smoke.spec.ts` 跑在真实库上，
 * 改了目录会让一整套 e2e 悄悄换成另一个库。
 */
export function resolveUserDataDir(
  appData: string,
  isPackaged: boolean,
  override?: string | null
): string | null {
  if (override) return override
  return isPackaged ? join(appData, PACKAGED_USER_DATA_NAME) : null
}
