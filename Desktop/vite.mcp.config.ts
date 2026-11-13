import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * MCP STDIO Server 的独立构建。
 *
 * 为什么单独一个 config：electron-vite 只认识 main/preload/renderer 三个进程；
 * MCP 进程不是 Electron 的一部分（它是被 AI 客户端 spawn 的普通 Node 程序）。
 *
 * 输出 `out/mcp/stdio.mjs`（ESM）。
 *
 * **除 node: 内置模块外，全部打进单文件。** 早期版本只 external 掉
 * `@modelcontextprotocol/*`、期望运行时从 node_modules 解析——开发态没问题，
 * 打包后是错的：
 *
 *   - pnpm 的 node_modules 是符号链接，`@modelcontextprotocol/core` 并不在
 *     根的 `node_modules/@modelcontextprotocol/` 下，electron-builder 复制
 *     extraResources 时只会拿到 `server`，外部 Node 启动即
 *     ERR_MODULE_NOT_FOUND；
 *   - 即便补齐依赖，入口一旦落进 app.asar，外部 Node 也读不到。
 *
 * 打成单文件后，MCP runtime 只有一个 .mjs，复制到 <resources>/mcp 即可运行，
 * 与包管理器布局、与 asar 都无关。
 */
export default defineConfig({
  // Vite 默认的解析条件里包含 `browser`，而 SDK 的 `_shims` 子路径按
  // workerd → browser → node 的顺序匹配——条件里留着 browser，构建就会
  // 静态选中 shimsBrowser，产出的 server 一碰 process.stdin 就抛
  // 「StdioServerTransport is not supported in this environment」。
  // MCP 是被 Node spawn 的进程，这里必须显式只保留 node 条件。
  resolve: {
    conditions: ['node', 'import', 'module', 'default'],
    mainFields: ['module', 'main']
  },
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
      // 只保留 node: 内置模块，其余裸包全部内联。
      external: (id) => id.startsWith('node:')
    }
  }
})
