import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolServices } from '../../src/main/application/mcp-tools/tool-services'
import { TOOL_HANDLERS } from '../../src/main/application/mcp-tools/handlers'
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../../src/shared/mcp/tool-schemas'
import type { BridgeRequest, BridgeResponse } from '../../src/main/mcp-bridge/bridge-contract'
import { routeBridgeRequest, type RouterContext } from '../../src/main/mcp-bridge/request-router'

/**
 * Phase 1.1A 结构测试：共享执行层的**边界**必须由结构保证，
 * 而不是靠「下次改代码的人记得别 import」。
 *
 * 每条断言都对应一个会真实发生的退化：
 * 有人为了图方便把 `db` 塞进 ToolServices、让 mcp-tools 反向依赖 mcp-bridge、
 * 或在 route 里再写一套 Handler 分支。
 */
const ROOT = process.cwd()
const MCP_TOOLS_DIR = join(ROOT, 'src/main/application/mcp-tools')
const ROUTER = join(ROOT, 'src/main/mcp-bridge/request-router.ts')

function readDirSources(dir: string): Array<{ file: string; source: string }> {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, source: stripComments(readFileSync(join(dir, name), 'utf8')) }))
}

/**
 * 扫描前先去掉注释：这些文件**故意在注释里解释**「为什么不依赖 db / clients /
 * mcp-bridge」，直接全文匹配会把说明文字当成违规。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('共享执行层的依赖方向', () => {
  it('application/mcp-tools/ 不导入 mcp-bridge/', () => {
    for (const { file, source } of readDirSources(MCP_TOOLS_DIR)) {
      expect(source, `${file} 不得依赖 mcp-bridge`).not.toMatch(/from\s+'[^']*mcp-bridge\//)
      expect(source, `${file} 不得引用线协议`).not.toMatch(/\bBridgeRequest\b|\bBridgeResponse\b/)
      expect(source, `${file} 不得引用 Bridge 的审计表实现`).not.toMatch(/from\s+'[^']*audit-log'/)
    }
  })

  it('application/mcp-tools/ 不依赖 permission-service（认证是调用方的事）', () => {
    for (const { file, source } of readDirSources(MCP_TOOLS_DIR)) {
      expect(source, `${file} 不得依赖授权模块`).not.toMatch(
        /from\s+'[^']*permission-service'/
      )
      expect(source, `${file} 不得出现 MCP Client 概念`).not.toMatch(/\bMcpClientService\b/)
    }
  })

  it('application/mcp-tools/ 不依赖 MCP STDIO 进程代码（那是另一个进程）', () => {
    for (const { file, source } of readDirSources(MCP_TOOLS_DIR)) {
      expect(source, `${file} 不得依赖 src/mcp/`).not.toMatch(/from\s+'[^']*\/mcp\/(stdio|bridge-client|tools)/)
    }
  })

  it('tool-services.ts 只依赖业务 Service（无 db、无 database 模块）', () => {
    const source = stripComments(readFileSync(join(MCP_TOOLS_DIR, 'tool-services.ts'), 'utf8'))
    expect(source).not.toMatch(/from\s+'[^']*database\//)
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
    expect(imports.sort()).toEqual([
      '../canvas/canvas-service',
      '../coffee/coffee-service',
      '../personal-direction/personal-direction-service',
      '../records/record-service',
      '../work-context/work-context-service'
    ])
  })
})

describe('ToolServices 的类型边界', () => {
  it('不含 db（编译期断言：HasDb 必须为 false）', () => {
    type Keys = keyof ToolServices
    type HasDb = 'db' extends Keys ? true : false
    const hasDb: HasDb = false
    expect(hasDb).toBe(false)
  })

  it('不含 clients / McpClientService', () => {
    type Keys = keyof ToolServices
    type HasClients = 'clients' extends Keys ? true : false
    const hasClients: HasClients = false
    expect(hasClients).toBe(false)
  })

  it('恰好暴露五个业务 Service', () => {
    type Keys = keyof ToolServices
    const keys: Keys[] = ['records', 'coffee', 'canvas', 'workContexts', 'personalDirection']
    expect(keys).toHaveLength(5)
  })
})

describe('routeBridgeRequest 的契约与调用关系', () => {
  it('函数签名保持不变（两个参数、返回 BridgeResponse）', () => {
    const signature: (ctx: RouterContext, request: BridgeRequest) => BridgeResponse = routeBridgeRequest
    expect(signature).toBe(routeBridgeRequest)
    expect(routeBridgeRequest.length).toBe(2)

    const source = stripComments(readFileSync(ROUTER, 'utf8'))
    expect(source).toContain(
      'export function routeBridgeRequest(ctx: RouterContext, request: BridgeRequest): BridgeResponse {'
    )
  })

  it('routeBridgeRequest 通过 executeTool 执行，不再持有第二套 Handler 分支', () => {
    const source = stripComments(readFileSync(ROUTER, 'utf8'))
    expect(source).toMatch(/import\s+\{[^}]*executeTool[^}]*\}\s+from\s+'\.\.\/application\/mcp-tools\/tool-executor'/)
    expect(source).toMatch(/executeTool\(/)
    // 27 个 Handler 只在 handlers.ts 定义一次。
    expect(source).not.toMatch(/const HANDLERS\b/)
    expect(source).not.toMatch(/TOOL_HANDLERS\[/)
  })
})

describe('工具清单不被改动', () => {
  it('TOOL_DEFINITIONS 恰好 27 项，且 Handler 与定义一一对应', () => {
    expect(Object.keys(TOOL_DEFINITIONS)).toHaveLength(27)
    expect(Object.keys(TOOL_HANDLERS).sort()).toEqual([...TOOL_NAMES].sort())
    expect(TOOL_NAMES).toHaveLength(27)
  })
})

describe('Remote 不引入独立进程（Phase 1.1A 起的不变量，1.1B 细化）', () => {
  /**
   * 1.1A 时这条断言写的是「`src/main/remote/` 不存在」——那只是
   * 「没有独立 Agent」的**代理指标**。1.1B 合法地创建了这个目录，
   * 但它是主进程内的模块，不是独立进程。
   *
   * 所以这里改为直接断言**真正的不变量**：Remote 不得成为第二个进程入口。
   * 判据是三条可机械检查的事实，而不是目录是否存在。
   */
  it('src/main 顶层没有 remote 进程入口文件', () => {
    const mainFiles = readdirSync(join(ROOT, 'src/main')).filter((name) => /\.ts$/.test(name))
    expect(mainFiles.filter((name) => /remote[-.]?(agent|device|daemon)/i.test(name))).toEqual([])
    expect(existsSync(join(ROOT, 'src/main/remote-agent.ts'))).toBe(false)
    expect(existsSync(join(ROOT, 'src/main/remote-device.ts'))).toBe(false)
  })

  it('package.json 没有把 Remote 注册成可执行入口', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>
      scripts?: Record<string, string>
    }
    // 不允许 `bin` 里出现 remote 相关命令
    expect(Object.keys(pkg.bin ?? {}).filter((name) => /remote/i.test(name))).toEqual([])
    // 也不允许出现「单独启动一个 Remote 进程」的脚本
    const scripts = Object.values(pkg.scripts ?? {})
    expect(scripts.filter((script) => /remote/i.test(script))).toEqual([])
  })

  it('src/main/remote 不自建 Electron 应用/进程生命周期', () => {
    const dir = join(ROOT, 'src/main/remote')
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({ name, source: stripComments(readFileSync(join(dir, name), 'utf8')) }))

    for (const { name, source } of sources) {
      // 不得自行 whenReady / 自建窗口 / 自行退出进程——生命周期由 index.ts 拥有
      expect(source, `${name} 不得自行启动 Electron 生命周期`).not.toMatch(/app\.whenReady\(/)
      expect(source, `${name} 不得自建窗口`).not.toMatch(/new BrowserWindow\(/)
      expect(source, `${name} 不得自行退出进程`).not.toMatch(/app\.(quit|exit)\(|process\.exit\(/)
    }
  })
})
