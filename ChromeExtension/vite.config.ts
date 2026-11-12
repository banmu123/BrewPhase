import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * MV3 的三个入口：
 * - popup.html：React 渲染的扩展弹窗；
 * - capture.html：截图编辑页（草稿来自 storage.session）；
 * - service-worker.ts：Native Messaging 桥（module worker）。
 *
 * 文件名固定为 `service-worker.js` / `popup.js` / `capture.js`，
 * manifest 与 tabs.create 按这些名字引用。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    rollupOptions: {
      input: {
        popup: fileURLToPath(new URL('./popup.html', import.meta.url)),
        capture: fileURLToPath(new URL('./capture.html', import.meta.url)),
        'service-worker': fileURLToPath(new URL('./src/background/service-worker.ts', import.meta.url))
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
})
