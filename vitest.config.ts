import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // SQLite 文件测试串行跑：多个 worker 同时开同一个临时目录会互相踩。
    pool: 'forks',
    fileParallelism: false
  }
})
