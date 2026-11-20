import type { z } from "zod";

/**
 * Desktop `TOOL_DEFINITIONS` 的**运行时**加载器（Phase 1.3.2，任务书 §6.1）。
 *
 * 为什么是动态 import + 手写类型：Cloud 是独立 pnpm 项目（ESM）而 Desktop
 * 的 `package.json` 没有 `"type": "module"`——把 Desktop 源文件纳入 Cloud 的
 * `tsc --noEmit` 会触发 NodeNext 的 CJS/ESM 归属错误（TS1295/1287），
 * 而生产构建（`tsconfig.build`）更不该依赖 Desktop 源码。
 *
 * vitest（vite）在运行时按路径解析 `.ts` 源文件，因此**测试进程里拿到的
 * 就是 Desktop 当前的真实定义**（不是拷贝、不是快照）——一致性比较仍然
 * 针对权威事实源，任何一侧漂移都会让 `schema.test.ts` 转红。
 *
 * 路径用变量拼接：静态字面量会被 tsc 解析并把 Desktop 文件拉进类型图。
 */
export interface DesktopToolDefinition {
  scope: string;
  write: boolean;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
}

declare global {
  interface ImportMeta {
    /** vitest/vite 提供的静态 glob（本文件只为它补一个类型声明）。 */
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

export async function loadDesktopToolDefinitions(): Promise<Record<string, DesktopToolDefinition>> {
  // `import.meta.glob` 由 vite 在**构建期**展开成静态解析路径——动态字符串
  // import 在 vite-node 下无法稳定解析，glob 是 vite 原生的可靠通道。
  const matched = import.meta.glob("../../../Desktop/src/shared/mcp/tool-schemas.ts");
  const loader = Object.values(matched)[0];
  if (!loader) throw new Error("Desktop TOOL_DEFINITIONS source not found");
  const mod = (await loader()) as { TOOL_DEFINITIONS: Record<string, DesktopToolDefinition> };
  return mod.TOOL_DEFINITIONS;
}
