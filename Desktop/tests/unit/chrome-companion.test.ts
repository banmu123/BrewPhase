import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseHandle } from '../../src/main/database/client'
import { ApplicationEvents } from '../../src/main/application/events/application-events'
import { RecordService } from '../../src/main/application/records/record-service'
import { ChromeBridgeServer, chromeBridgePaths } from '../../src/main/integrations/chrome/chrome-bridge-server'
import { ChromeMessageHandler } from '../../src/main/integrations/chrome/chrome-message-handler'
import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_HOST_NAME,
  CHROME_MAX_DESCRIPTION,
  CHROME_MAX_SELECTED_TEXT,
  CHROME_MAX_TITLE,
  chromeCompanionRequestSchema,
  isSupportedPageURL,
  type ChromePagePayload
} from '../../src/shared/contracts/chrome-bridge'

/**
 * Chrome Companion 的三条边界：
 * 1. 请求结构（长度、协议、版本）在进入业务前就被 Zod 拒绝；
 * 2. 保存只走 RecordService，字段落到 title / note / summary；
 * 3. 本地 IPC 必须握手（token）后才接受请求，坏 JSON 只回结构化错误。
 */

const SAMPLE: ChromePagePayload = {
  title: '一篇值得留下的文章',
  url: 'https://example.com/articles/1',
  domain: 'example.com',
  faviconUrl: 'https://example.com/favicon.ico',
  description: '这是页面的 meta description。',
  selectedText: '这是用户选中的一段文字。'
}

describe('Chrome Companion：协议与落库', () => {
  let dir = ''
  let handle: DatabaseHandle
  let records: RecordService
  let handler: ChromeMessageHandler

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-chrome-'))
    handle = openDatabase(join(dir, 'brewphase.db'))
    const events = new ApplicationEvents()
    records = new RecordService(handle.db, handle.deviceId, events, () => undefined)
    handler = new ChromeMessageHandler(records, '0.1.1-test')
  })

  afterEach(() => {
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('PING 只报告 Desktop 版本，不写库', () => {
    const response = handler.handle({
      version: 1,
      requestId: 'ping-1',
      type: 'PING'
    })

    expect(response.success).toBe(true)
    expect(response.code).toBe('OK')
    expect(response.data?.appVersion).toBe('0.1.1-test')
    expect(records.list({ search: '', carrier: null, tagId: null, limit: 50, offset: 0 })).toHaveLength(0)
  })

  it('SAVE_PAGE 把标题 / 选中文字 / 描述落到既有字段', () => {
    const response = handler.handle({
      version: 1,
      requestId: 'save-1',
      type: 'SAVE_PAGE',
      payload: SAMPLE
    })

    expect(response.success).toBe(true)
    expect(response.code).toBe('OK')
    const record = records.get(response.data!.recordId!)
    expect(record).not.toBeNull()
    expect(record!.carrier).toBe('link')
    expect(record!.title).toBe(SAMPLE.title)
    expect(record!.urlString).toBe(SAMPLE.url)
    expect(record!.note).toBe(SAMPLE.selectedText)
    expect(record!.summary).toBe(SAMPLE.description)
    expect(record!.provider).toBe('generic')
  })

  it('重复 requestId 只产生一条记录（Popup 连点 / Host 重发）', () => {
    const request = {
      version: 1 as const,
      requestId: 'dup-1',
      type: 'SAVE_PAGE' as const,
      payload: SAMPLE
    }
    const first = handler.handle(request)
    const second = handler.handle(request)

    expect(second.data?.recordId).toBe(first.data?.recordId)
    expect(records.list({ search: '', carrier: null, tagId: null, limit: 50, offset: 0 })).toHaveLength(1)
  })

  it('拒绝 javascript: / data: / file: 等非 http(s) 地址', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'chrome://settings']) {
      expect(isSupportedPageURL(url)).toBe(false)
      const parsed = chromeCompanionRequestSchema.safeParse({
        version: 1,
        requestId: 'bad-url',
        type: 'SAVE_PAGE',
        payload: { ...SAMPLE, url }
      })
      expect(parsed.success).toBe(false)
    }
    expect(isSupportedPageURL('https://example.com')).toBe(true)
  })

  it('超长字段在 schema 层被拒绝，不进入数据库', () => {
    const parsed = chromeCompanionRequestSchema.safeParse({
      version: 1,
      requestId: 'long',
      type: 'SAVE_PAGE',
      payload: {
        ...SAMPLE,
        title: 'x'.repeat(CHROME_MAX_TITLE + 1),
        selectedText: 'y'.repeat(CHROME_MAX_SELECTED_TEXT + 1),
        description: 'z'.repeat(CHROME_MAX_DESCRIPTION + 1)
      }
    })
    expect(parsed.success).toBe(false)
  })

  it('缺少 payload 的 SAVE_PAGE 被拒绝，PING 不需要 payload', () => {
    expect(
      chromeCompanionRequestSchema.safeParse({ version: 1, requestId: 'no-payload', type: 'SAVE_PAGE' })
        .success
    ).toBe(false)
    expect(
      chromeCompanionRequestSchema.safeParse({ version: 1, requestId: 'ok-ping', type: 'PING' }).success
    ).toBe(true)
  })

  it('handler 对绕过 schema 的非法 URL 返回 UNSUPPORTED_URL', () => {
    const response = handler.handle({
      version: 1,
      requestId: 'bypass',
      type: 'SAVE_PAGE',
      payload: { ...SAMPLE, url: 'javascript:alert(1)' }
    })

    expect(response.success).toBe(false)
    expect(response.code).toBe('UNSUPPORTED_URL')
  })

  it('扩展侧协议常量与 Desktop 权威定义一致', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../ChromeExtension/src/shared/protocol.ts', import.meta.url)),
      'utf8'
    )
    expect(source).toContain(`PROTOCOL_VERSION = ${CHROME_BRIDGE_PROTOCOL_VERSION}`)
    expect(source).toContain(`HOST_NAME = '${CHROME_HOST_NAME}'`)

    const numeric = (name: string): number => {
      const match = source.match(new RegExp(`${name}\\s*=\\s*([0-9_]+)`))
      return Number((match?.[1] ?? '').replace(/_/g, ''))
    }
    expect(numeric('MAX_TITLE')).toBe(CHROME_MAX_TITLE)
    expect(numeric('MAX_DESCRIPTION')).toBe(CHROME_MAX_DESCRIPTION)
    expect(numeric('MAX_SELECTED_TEXT')).toBe(CHROME_MAX_SELECTED_TEXT)
  })
})

describe('ChromeBridgeServer：本地 IPC', () => {
  let dir = ''
  let server: ChromeBridgeServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-chrome-bridge-'))
    server = new ChromeBridgeServer(
      chromeBridgePaths(dir),
      (request) => ({
        version: 1,
        requestId: request.requestId,
        success: true,
        code: 'OK',
        data: { appVersion: 'test' }
      }),
      'test'
    )
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  async function openSocket(): Promise<{ socket: Socket; next: () => Promise<string> }> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const client = connect(server.endpoint())
      client.once('connect', () => resolve(client))
      client.once('error', reject)
    })
    socket.setEncoding('utf8')
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]()
    return {
      socket,
      next: async () => {
        const { value } = await lines.next()
        return String(value ?? '')
      }
    }
  }

  it('正确 token 握手后可以发 PING', async () => {
    const { socket, next } = await openSocket()
    socket.write(
      `${JSON.stringify({ type: 'hello', token: server.authToken(), version: 1 })}\n`
    )
    const ack = JSON.parse(await next())
    expect(ack.ok).toBe(true)

    socket.write(`${JSON.stringify({ version: 1, requestId: 'r-1', type: 'PING' })}\n`)
    const response = JSON.parse(await next())
    expect(response.requestId).toBe('r-1')
    expect(response.code).toBe('OK')
    socket.destroy()
  })

  it('错误 token 直接断开，不进入业务', async () => {
    const { socket, next } = await openSocket()
    socket.write(`${JSON.stringify({ type: 'hello', token: 'wrong-token-1234567890', version: 1 })}\n`)
    const ack = JSON.parse(await next())
    expect(ack.ok).toBe(false)
    await new Promise((resolve) => socket.once('close', resolve))
  })

  it('坏 JSON 返回 INVALID_REQUEST，连接继续可用', async () => {
    const { socket, next } = await openSocket()
    socket.write(`${JSON.stringify({ type: 'hello', token: server.authToken(), version: 1 })}\n`)
    await next()

    socket.write('{not json}\n')
    const bad = JSON.parse(await next())
    expect(bad.success).toBe(false)
    expect(bad.code).toBe('INVALID_REQUEST')

    socket.write(`${JSON.stringify({ version: 1, requestId: 'r-2', type: 'PING' })}\n`)
    const ok = JSON.parse(await next())
    expect(ok.code).toBe('OK')
    socket.destroy()
  })

  it('stop 之后 endpoint 不再可连接', async () => {
    const endpoint = server.endpoint()
    await server.stop()
    await expect(
      new Promise((resolve, reject) => {
        const client = connect(endpoint)
        client.once('connect', () => {
          client.destroy()
          resolve('connected')
        })
        client.once('error', reject)
      })
    ).rejects.toBeTruthy()
  })
})
