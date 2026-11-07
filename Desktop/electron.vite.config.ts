import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * 三个进程各自打包，职责不混：
 * * main —— Node 全权限，持有数据库与文件系统；
 * * preload —— 只有 contextBridge 与白名单 IPC；
 * * renderer —— 纯浏览器环境，拿不到 Node、也拿不到数据库。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
    // 注意：preload **不能** external 业务依赖——沙箱化的 preload 里只有
    // electron 可以 require。electron-vite 6 默认把 dependencies 全部
    // external（zod 就是这样漏出去的），必须显式 exclude 收进 bundle；
    // 否则 preload 加载即失败 → window.brewphase 不存在 → 页面整块空白。
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
})
