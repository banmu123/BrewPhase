import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * MCP STDIO Server 的独立构建。
 *
 * 为什么单独一个 config：electron-vite 只认识 main/preload/renderer 三个进程；
 * MCP 进程不是 Electron 的一部分（它是被 AI 客户端 spawn 的普通 Node 程序）。
 *
 * - 输出 `out/mcp/stdio.mjs`（ESM；SDK v2 的导入面按 ESM 组织）；
 * - 依赖全部 external：产物从 `Desktop/node_modules` 解析——这是有意的，
 *   避免把 SDK 的 optional 依赖（ajv / json-schema 校验器）打进单文件。
 *   因此产物必须留在 Desktop 目录内运行。
 */
export default defineConfig({
  build: {
    target: 'node20',
    outDir: resolve(__dirname, 'out/mcp'),
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/mcp/stdio.ts'),
      formats: ['es'],
      fileName: () => 'stdio.mjs'
    },
    rollupOptions: {
      // node: 内置 + 所有裸包说明符（从 node_modules 解析）都不打包。
      external: (id) => id.startsWith('node:') || (!id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0'))
    }
  }
})
