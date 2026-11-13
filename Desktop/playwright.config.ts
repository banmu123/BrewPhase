import { defineConfig } from '@playwright/test'

/**
 * 启动 Electron 前必须彻底**删掉** `ELECTRON_RUN_AS_NODE`，而不是置空。
 *
 * Windows 上 `ELECTRON_RUN_AS_NODE=''` 仍然是「已定义」，Electron 会以纯 Node
 * 身份启动，于是 Playwright 追加的 `--remote-debugging-port=0` 被 Node 判成
 * `bad option`，整批用例在 launch 阶段就 exit 9。有的 spec 里写了
 * `ELECTRON_RUN_AS_NODE: ''`，在 Linux/macOS 恰好没事，在 Windows 必炸。
 *
 * 所有 spec 的 env 都从 `process.env` 展开，所以在配置加载时删一次即可覆盖全部；
 * 工作区之外启动的壳进程（终端复用器、CI runner）设了这个变量也不会再影响测试。
 */
delete process.env.ELECTRON_RUN_AS_NODE

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 40_000,
  workers: 1,
  reporter: [['list']],
  // 显式准备：检查 out/ 产物、重建 ChromeExtension 的 dist。
  // 没有这一步时，chrome-companion 的安装用例会因为开发机没手工 build
  // 扩展而失败，看起来像产品问题，实际是环境没准备。
  globalSetup: './tests/e2e/global-setup.ts',
  use: { actionTimeout: 10_000 }
})
