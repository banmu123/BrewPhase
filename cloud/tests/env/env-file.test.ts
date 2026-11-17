import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadLocalEnvFile } from "../../src/env-file.js";

/**
 * `.env` 加载是本地联调的前置条件：`pnpm dev` 与 `pnpm db:migrate` 都是纯 Node 进程，
 * 不加载就等于配置没配。这里锁住四条行为，尤其是「进程环境优先」与「生产不读」。
 */

const dir = mkdtempSync(join(tmpdir(), "bp-cloud-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const originalNodeEnv = process.env.NODE_ENV;

function writeEnvFile(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body, "utf8");
  return file;
}

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("loadLocalEnvFile", () => {
  it("文件不存在时返回 null 且不注入任何变量", () => {
    delete process.env.BP_ENV_FILE_MISSING;
    const result = loadLocalEnvFile(join(dir, "absent.env"));
    expect(result).toBeNull();
    expect(process.env.BP_ENV_FILE_MISSING).toBeUndefined();
  });

  it("文件存在时加载变量并返回绝对路径", () => {
    delete process.env.BP_ENV_FILE_LOADED;
    const file = writeEnvFile("basic.env", "BP_ENV_FILE_LOADED=from-file\n");

    const result = loadLocalEnvFile(file);

    expect(result).toBe(file);
    expect(process.env.BP_ENV_FILE_LOADED).toBe("from-file");
  });

  it("不覆盖已注入的进程环境变量（容器 / CI / shell 始终优先）", () => {
    process.env.BP_ENV_FILE_PRECEDENCE = "from-process";
    const file = writeEnvFile("precedence.env", "BP_ENV_FILE_PRECEDENCE=from-file\n");

    loadLocalEnvFile(file);

    expect(process.env.BP_ENV_FILE_PRECEDENCE).toBe("from-process");
    delete process.env.BP_ENV_FILE_PRECEDENCE;
  });

  it("NODE_ENV=production 时直接跳过，不读文件", () => {
    process.env.NODE_ENV = "production";
    delete process.env.BP_ENV_FILE_PROD;
    const file = writeEnvFile("prod.env", "BP_ENV_FILE_PROD=leaked\n");

    const result = loadLocalEnvFile(file);

    expect(result).toBeNull();
    expect(process.env.BP_ENV_FILE_PROD).toBeUndefined();
  });
});
