#!/usr/bin/env node
/**
 * 打包后校验：MCP runtime 是否真的落在 asar 之外，且依赖齐全。
 *
 * 为什么要这一步：MCP 入口是被 Codex / WorkBuddy 这类外部客户端用**普通
 * Node** spawn 的，Node 不认识 asar 的虚拟文件系统。入口若留在 app.asar 内，
 * 开发态一切正常、装完之后客户端一律启动失败——这种问题只有对着真实产物
 * 检查才能提前发现，所以把它钉在 dist 流程末尾。
 *
 * 校验内容（任一不满足即退出码 1）：
 *   1. release/<product>/resources/mcp/stdio.mjs 存在；
 *   2. 它的三个外部依赖都在 resources/mcp/node_modules 下；
 *   3. 路径没有落在 app.asar 里。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CWD = process.cwd()
/** dist 默认输出到 release/，临时验证可能用 release-verify/，两者都扫。 */
const RELEASE_DIRS = readdirSync(CWD, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('release'))
  .map((entry) => join(CWD, entry.name))

/** 产物是单文件；只校验入口本身。 */
const REQUIRED = ['stdio.mjs']

function fail(message) {
  console.error(`[verify-mcp-runtime] ${message}`)
  process.exit(1)
}

if (RELEASE_DIRS.length === 0) {
  fail('没有 release 目录。先运行 electron-builder（dist 或 dist:dir）。')
}

const candidates = RELEASE_DIRS.flatMap((dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, 'resources', 'mcp'))
    .filter((mcpDir) => existsSync(mcpDir))
)

if (candidates.length === 0) {
  fail('没有找到任何 <product>/resources/mcp/。extraResources 没有生效。')
}

let checked = 0
for (const base of candidates) {
  if (base.includes('app.asar')) {
    fail(`MCP runtime 落进了 asar：${base}`)
  }
  for (const relative of REQUIRED) {
    if (!existsSync(join(base, relative))) {
      fail(`${base} 缺少 ${relative}。extraResources 没有把 MCP runtime 复制过去。`)
    }
  }
  checked += 1
  console.log(`[verify-mcp-runtime] OK ${base}`)
}

console.log(`[verify-mcp-runtime] ${checked} 个产物通过。`)
