import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 集成测试共享同一个 PostgreSQL 实例（容器内），按文件串行执行，避免相互干扰。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: "./tests/global-setup.ts",
    env: {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://brewphase:brewphase@127.0.0.1:54329/brewphase_cloud_test",
    },
  },
});
