import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 真实网络 smoke 专用配置（§第四轮 六）。
 *
 * 与 `vitest.config.ts` 完全分开：`pnpm test` / CI 不会碰这里的任何用例，
 * 外部站点临时故障也不会把普通测试拖红。手动跑：`pnpm test:live`。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['tests/live/**/*.smoke.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
