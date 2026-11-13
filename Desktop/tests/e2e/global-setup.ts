import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * E2E 全局准备（Playwright `globalSetup`）。
 *
 * 只做两件事，都是为了把「环境没准备好」从隐性失败变成显式步骤：
 *
 * 1. **验证 Desktop 构建产物存在**。E2E 跑的是 `out/`（不是 dev server），
 *    没有产物时所有用例都会在启动阶段莫名其妙地失败。这里直接抛错并给出
 *    该跑哪条命令。
 *
 * 2. **构建 ChromeExtension**。`chrome-companion` 的安装用例断言
 *    `extensionDir` 指向可加载的扩展；产品的 `extensionDir()` 只认带
 *    `manifest.json` 的 `dist/`（源码目录没有，指过去 Chrome 会报错）。
 *    所以 `dist/` 是测试的真实依赖，不能靠开发机上一次手工构建的残留：
 *    每次全量 E2E 都重建一次（约 0.5s），保证产物与当前源码一致。
 *
 * 依赖缺失时先 `pnpm install --frozen-lockfile`——这是唯一需要联网的步骤，
 * 且只在首次或清过 node_modules 后发生。
 */

const DESKTOP_ROOT = join(__dirname, '../..')
const EXTENSION_ROOT = join(__dirname, '../../../ChromeExtension')
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function requireFile(path: string, hint: string): void {
  if (existsSync(path)) return
  throw new Error(`[e2e] missing build output: ${path}\n[e2e] run: ${hint}`)
}

export default function globalSetup(): void {
  requireFile(join(DESKTOP_ROOT, 'out', 'renderer', 'index.html'), 'cd Desktop && pnpm build')
  requireFile(join(DESKTOP_ROOT, 'out', 'mcp', 'stdio.mjs'), 'cd Desktop && pnpm mcp:build')

  if (!existsSync(join(EXTENSION_ROOT, 'node_modules'))) {
    console.log('[e2e] ChromeExtension deps missing — installing (one time)')
    execFileSync(PNPM, ['install', '--frozen-lockfile'], {
      cwd: EXTENSION_ROOT,
      stdio: 'inherit'
    })
  }

  console.log('[e2e] building ChromeExtension (loadable dist for install test)')
  execFileSync(PNPM, ['build'], { cwd: EXTENSION_ROOT, stdio: 'inherit' })
  requireFile(
    join(EXTENSION_ROOT, 'dist', 'manifest.json'),
    'cd ChromeExtension && pnpm build'
  )
}
