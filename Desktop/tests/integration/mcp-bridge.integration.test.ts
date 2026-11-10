import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpScope } from '@shared/contracts/mcp'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { RecordService } from '../../src/main/application/records/record-service'
import { CoffeeService } from '../../src/main/application/coffee/coffee-service'
import { CanvasService } from '../../src/main/application/canvas/canvas-service'
import { McpClientService } from '../../src/main/application/authorization/permission-service'
import { BridgeServer } from '../../src/main/mcp-bridge/bridge-server'
import { BRIDGE_PROTOCOL_VERSION, bridgePaths, platformSupportsBridge, type BridgeInfo } from '../../src/main/mcp-bridge/bridge-contract'
import type { RouterContext } from '../../src/main/mcp-bridge/request-router'
import { BridgeClient, BridgeError } from '../../src/mcp/bridge-client'

/**
 * Local Bridge 的真实 socket 测试：Unix domain socket + NDJSON + bridge-info.json。
 *
 * 覆盖：正常调用、错误 token、撤销立即生效、协议版本、请求超限、
 * Bridge 停止后 `APP_NOT_RUNNING`、socket/info 文件的生命周期。
 */
// Bridge V1 明确不支持 Windows（Named Pipe ACL 未验证，见
// `bridge-contract.ts` 的 `platformSupportsBridge`），socket 集成测试
// 随产品边界走：不支持的平台整个跳过，而不是把 listen 失败当成 bug。
describe.skipIf(!platformSupportsBridge())('MCP Bridge socket 集成 — 仅 darwin/linux', () => {
  let dir: string
  let handle: DatabaseHandle
  let ctx: RouterContext
  let server: BridgeServer

  const ALL_SCOPES: McpScope[] = [
    'records:read',
    'records:create',
    'records:update',
    'tags:read',
    'tags:create',
    'coffee:read',
    'canvas:read',
    'canvas:write'
  ]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'brewphase-bridge-test-'))
    handle = openDatabase(join(dir, 'test.db'))
    const events = new ApplicationEvents()
    const records = new RecordService(handle.db, handle.deviceId, events, () => undefined)
    ctx = {
      db: handle.db,
      clients: new McpClientService(handle.db),
      records,
      coffee: new CoffeeService(handle.db),
      canvas: new CanvasService(handle.db, handle.deviceId, events)
    }
    server = new BridgeServer(bridgePaths(dir), ctx, '0.1.0-test')
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeClient(scopes: McpScope[] = ALL_SCOPES): { id: string; token: string } {
    const created = ctx.clients.create({ name: 'Bridge Test', scopes })
    return { id: created.id, token: created.token }
  }

  describe('Bridge 生命周期', () => {
    it('启动后发布 bridge-info.json（不含 token），socket 存在', () => {
      const paths = bridgePaths(dir)
      expect(existsSync(paths.socketPath)).toBe(true)
      const info = JSON.parse(readFileSync(paths.infoPath, 'utf8')) as BridgeInfo
      expect(info.socketPath).toBe(paths.socketPath)
      expect(info.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION)
      expect(info.pid).toBe(process.pid)
      expect(JSON.stringify(info)).not.toContain('bp_mcp_')
      expect(server.isRunning()).toBe(true)
    })

    it('stop 后 socket 与 info 都被清理', async () => {
      await server.stop()
      const paths = bridgePaths(dir)
      expect(existsSync(paths.socketPath)).toBe(false)
      expect(existsSync(paths.infoPath)).toBe(false)
    })
  })

  describe('Bridge 调用链', () => {
    it('合法 token 真实写入数据库（MCP 进程视角）', async () => {
      const client = makeClient()
      const bridge = new BridgeClient(dir, client.token)
      const data = (await bridge.call('create_record', {
        carrier: 'text',
        title: '来自 MCP 进程',
        note: '真链',
        idempotency_key: 'bridge-1'
      })) as { record_id: string; sync_status: string }
      expect(data.sync_status).toBe('desktop_local_only')

      const again = (await bridge.call('get_record', { record_id: data.record_id })) as { title: string }
      expect(again.title).toBe('来自 MCP 进程')
    })

    it('错误 token → UNAUTHORIZED；撤销后同一 token 立即失效', async () => {
      const client = makeClient()
      const good = new BridgeClient(dir, client.token)
      const bad = new BridgeClient(dir, 'bp_mcp_invalid')
      await expect(bad.call('search_records', {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

      ctx.clients.revoke(client.id)
      await expect(good.call('search_records', {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    })

    it('scope 不足 → PERMISSION_DENIED', async () => {
      const client = makeClient(['records:read'])
      const bridge = new BridgeClient(dir, client.token)
      await expect(
        bridge.call('create_record', { carrier: 'text', idempotency_key: 'x' })
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })

    it('Bridge 未运行时 BridgeClient → APP_NOT_RUNNING', async () => {
      await server.stop()
      const bridge = new BridgeClient(dir, 'bp_mcp_whatever')
      await expect(bridge.call('search_records', {})).rejects.toMatchObject({ code: 'APP_NOT_RUNNING' })
    })

    it('协议版本不匹配 → BRIDGE_PROTOCOL_MISMATCH（原始 socket）', async () => {
      const client = makeClient()
      const raw = await rawExchange(
        bridgePaths(dir).socketPath,
        JSON.stringify({
          requestId: 'raw-1',
          protocolVersion: 99,
          method: 'tools.call',
          tool: 'search_records',
          token: client.token,
          params: {}
        })
      )
      expect((raw.error as { code: string }).code).toBe('BRIDGE_PROTOCOL_MISMATCH')
    })

    it('超过 1MB 的单行 → REQUEST_TOO_LARGE 并断开', async () => {
      const huge = 'x'.repeat(1024 * 1024 + 10)
      const response = await new Promise<{ error?: { code: string } }>((resolve, reject) => {
        const socket = connect(bridgePaths(dir).socketPath)
        let buffer = ''
        socket.setEncoding('utf8')
        socket.on('connect', () => socket.write(huge))
        socket.on('data', (chunk: string) => {
          buffer += chunk
          const newline = buffer.indexOf('\n')
          if (newline === -1) return
          resolve(JSON.parse(buffer.slice(0, newline)))
          socket.destroy()
        })
        socket.on('error', reject)
        socket.setTimeout(5000, () => reject(new Error('timeout waiting for REQUEST_TOO_LARGE')))
      })
      expect(response.error?.code).toBe('REQUEST_TOO_LARGE')
    })

    it('非法 JSON → VALIDATION_ERROR（不断开连接）', async () => {
      const response = await rawExchange(bridgePaths(dir).socketPath, 'not json at all')
      expect((response.error as { code: string }).code).toBe('VALIDATION_ERROR')
    })

    it('同一连接连续两次请求各自拿到对应响应（requestId 不混淆）', async () => {
      const client = makeClient()
      const socket = connect(bridgePaths(dir).socketPath)
      const responses: Array<{ requestId: string; success: boolean }> = []
      let buffer = ''
      socket.setEncoding('utf8')
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => {
          for (const id of ['a', 'b']) {
            socket.write(
              `${JSON.stringify({
                requestId: id,
                protocolVersion: BRIDGE_PROTOCOL_VERSION,
                method: 'tools.call',
                tool: 'list_record_tags',
                token: client.token,
                params: {}
              })}\n`
            )
          }
        })
        socket.on('data', (chunk: string) => {
          buffer += chunk
          let newline = buffer.indexOf('\n')
          while (newline !== -1) {
            responses.push(JSON.parse(buffer.slice(0, newline)))
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
          }
          if (responses.length === 2) {
            socket.destroy()
            resolve()
          }
        })
        socket.on('error', reject)
        socket.setTimeout(5000, () => reject(new Error('timeout waiting for two responses')))
      })
      expect(responses.map((item) => item.requestId).sort()).toEqual(['a', 'b'])
      expect(responses.every((item) => item.success)).toBe(true)
    })
  })
})

async function rawExchange(socketPath: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${line}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      resolve(JSON.parse(buffer.slice(0, newline)))
      socket.destroy()
    })
    socket.on('error', reject)
    socket.setTimeout(5000, () => reject(new Error('timeout waiting for bridge response')))
  })
}

void BridgeError
