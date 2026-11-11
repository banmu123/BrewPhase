import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Native Messaging Host 的**真实进程**测试。
 *
 * 这里不用替身：spawn 编译好的 Host 可执行文件，按 Chrome 的帧协议
 * （4 字节 native-endian 长度 + UTF-8 JSON）写 stdin，再从一个模拟的
 * Desktop IPC 服务读转发结果。覆盖分段读取、Desktop 未运行、握手失败、
 * 超大帧与坏 JSON。
 */

const platformKey = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
const binaryName = process.platform === 'win32' ? 'brewphase-chrome-host.exe' : 'brewphase-chrome-host'
const HOST_PATH = fileURLToPath(
  new URL(`../../resources/native-host/${platformKey}/${binaryName}`, import.meta.url)
)

describe('Native Messaging Host（真实进程）', () => {
  let dir = ''
  let server: Server | null = null
  let sockets: Socket[] = []
  let host: ChildProcessWithoutNullStreams | null = null
  let endpoint = ''
  let token = ''
  let configPath = ''
  let received: string[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-native-host-'))
    token = randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64)
    endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\bp-chrome-test-${randomUUID()}`
        : join(dir, 'bridge.sock')
    configPath = join(dir, 'host-config.json')
    received = []
  })

  afterEach(async () => {
    host?.kill()
    host = null
    for (const socket of sockets) socket.destroy()
    sockets = []
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
    rmSync(dir, { recursive: true, force: true })
  })

  async function startFakeDesktop(expectToken = token): Promise<void> {
    server = createServer((socket) => {
      sockets.push(socket)
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (!line.trim()) continue

          const message = JSON.parse(line) as Record<string, unknown>
          if (message.type === 'hello') {
            const ok = message.token === expectToken
            socket.write(`${JSON.stringify({ type: 'hello', ok, appVersion: 'test' })}\n`)
            if (!ok) socket.destroy()
            continue
          }

          if (message.type !== 'PING' && message.type !== 'SAVE_PAGE') {
            socket.write(
              `${JSON.stringify({
                version: 1,
                requestId: typeof message.requestId === 'string' ? message.requestId : '',
                success: false,
                code: 'INVALID_REQUEST'
              })}\n`
            )
            continue
          }

          received.push(line)
          socket.write(
            `${JSON.stringify({
              version: 1,
              requestId: message.requestId,
              success: true,
              code: 'OK',
              data: { appVersion: 'test' }
            })}\n`
          )
        }
      })
    })
    await new Promise<void>((resolve) => server!.listen(endpoint, () => resolve()))
  }

  function writeConfig(): void {
    writeFileSync(
      configPath,
      `${JSON.stringify({
        version: 1,
        endpoint,
        token,
        appVersion: 'test',
        installedAt: Date.now()
      })}\n`
    )
  }

  function startHost(): void {
    writeConfig()
    host = spawn(HOST_PATH, [], {
      env: { ...process.env, BREWPHASE_CHROME_HOST_CONFIG: configPath },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    host.stderr.setEncoding('utf8')
    host.stderr.on('data', () => undefined)
  }

  function frame(payload: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(body.length, 0)
    return Buffer.concat([length, body])
  }

  function nextFrame(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const timer = setTimeout(() => {
        host?.stdout.off('data', onData)
        reject(new Error('timed out waiting for a native message frame'))
      }, 8_000)

      const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length < 4) return
        const size = buffer.readUInt32LE(0)
        if (buffer.length < 4 + size) return
        clearTimeout(timer)
        host?.stdout.off('data', onData)
        resolve(JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')) as Record<string, unknown>)
      }
      host?.stdout.on('data', onData)
    })
  }

  it('正常 PING：握手后返回 Desktop 的响应', async () => {
    await startFakeDesktop()
    startHost()

    const pending = nextFrame()
    host!.stdin.write(
      frame({ version: 1, requestId: 'ping-1', type: 'PING' })
    )
    const response = await pending

    expect(response.code).toBe('OK')
    expect(response.requestId).toBe('ping-1')
    expect(received).toHaveLength(1)
  }, 20_000)

  it('分段读取：一帧拆成两次写入仍能组装', async () => {
    await startFakeDesktop()
    startHost()

    const payload = frame({ version: 1, requestId: 'split-1', type: 'PING' })
    const pending = nextFrame()
    host!.stdin.write(payload.subarray(0, 3))
    await new Promise((resolve) => setTimeout(resolve, 60))
    host!.stdin.write(payload.subarray(3))

    const response = await pending
    expect(response.requestId).toBe('split-1')
    expect(response.code).toBe('OK')
  }, 20_000)

  it('Desktop 未运行：返回 APP_NOT_RUNNING，不假装成功', async () => {
    // 不启动模拟 Desktop，endpoint 指向一个不存在的 pipe / socket。
    endpoint =
      process.platform === 'win32' ? `\\\\.\\pipe\\bp-missing-${randomUUID()}` : join(dir, 'missing.sock')
    startHost()

    const pending = nextFrame()
    host!.stdin.write(frame({ version: 1, requestId: 'offline-1', type: 'PING' }))
    const response = await pending

    expect(response.success).toBe(false)
    expect(response.code).toBe('APP_NOT_RUNNING')
    expect(response.requestId).toBe('offline-1')
  }, 20_000)

  it('握手 token 不匹配：Host 不透传请求', async () => {
    await startFakeDesktop('another-token-value-1234567890')
    startHost()

    const pending = nextFrame()
    host!.stdin.write(frame({ version: 1, requestId: 'bad-token', type: 'PING' }))
    const response = await pending

    expect(response.code).toBe('APP_NOT_RUNNING')
    // Desktop 没有收到任何业务请求。
    expect(received).toHaveLength(0)
  }, 20_000)

  it('超大帧：只写长度前缀就返回 INVALID_REQUEST', async () => {
    await startFakeDesktop()
    startHost()

    const pending = nextFrame()
    const length = Buffer.alloc(4)
    length.writeUInt32LE(9 * 1024 * 1024, 0)
    host!.stdin.write(length)

    const response = await pending
    expect(response.success).toBe(false)
    expect(response.code).toBe('INVALID_REQUEST')
  }, 20_000)

  it('坏 JSON：原样转发给 Desktop，由 Desktop 决定拒绝', async () => {
    await startFakeDesktop()
    startHost()

    const pending = nextFrame()
    host!.stdin.write(frame({ requestId: 'not-a-request' }))
    const response = await pending

    expect(response.success).toBe(false)
    expect(response.code).toBe('INVALID_REQUEST')
    expect(response.requestId).toBe('not-a-request')
  }, 20_000)
})
