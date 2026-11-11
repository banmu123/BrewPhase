import { test, expect, _electron as electronLauncher } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinLocale } from './locale'

/**
 * Chrome Companion 的真实端到端验收。
 *
 * 链路与用户路径一致，只有 Chrome 扩展的 popup 用脚本代替：
 *
 *   模拟 Chrome（本文件）
 *     → Native Messaging Host（真实 Rust 可执行文件）
 *     → 本地 IPC（真实 Named Pipe / Unix socket）
 *     → ChromeBridgeServer（真实 Electron 主进程）
 *     → RecordService.createFromChrome（真实应用服务）
 *     → SQLite（真实临时库）
 *     → 响应原路返回
 *
 * Host 安装到 `BREWPHASE_CHROME_HOST_DIR` 指定的临时目录，不写真实注册表，
 * 也不碰用户的 Chrome 配置。
 */

const platformKey = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
const binaryName = process.platform === 'win32' ? 'brewphase-chrome-host.exe' : 'brewphase-chrome-host'
// Playwright 的 cwd 是 Desktop/（配置文件所在），与其他 e2e 的路径约定一致。
const HOST_PATH = join(process.cwd(), 'resources', 'native-host', platformKey, binaryName)

async function launch(): Promise<{
  app: ElectronApplication
  page: Page
  dataDir: string
  hostDir: string
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bp-chrome-e2e-data-'))
  const hostDir = mkdtempSync(join(tmpdir(), 'bp-chrome-e2e-host-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: dataDir,
    BREWPHASE_CHROME_HOST_DIR: hostDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.BREWPHASE_FORCE_ONBOARDING

  const app = await electronLauncher.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env
  })
  const page = await app.firstWindow()
  await pinLocale(page, 'zh-CN')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.studio-home')).toBeVisible()
  return { app, page, dataDir, hostDir }
}

function startHost(configPath: string): ChildProcessWithoutNullStreams {
  const host = spawn(HOST_PATH, [], {
    env: { ...process.env, BREWPHASE_CHROME_HOST_CONFIG: configPath },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  host.stderr.setEncoding('utf8')
  host.stderr.on('data', () => undefined)
  return host
}

/** 按 Chrome 的帧协议发一条消息并读回一条响应。 */
function roundTrip(
  host: ChildProcessWithoutNullStreams,
  request: unknown
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      host.stdout.off('data', onData)
      reject(new Error('native host did not answer in time'))
    }, 12_000)

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return
      const size = buffer.readUInt32LE(0)
      if (buffer.length < 4 + size) return
      clearTimeout(timer)
      host.stdout.off('data', onData)
      resolve(JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')) as Record<string, unknown>)
    }

    host.stdout.on('data', onData)
    const body = Buffer.from(JSON.stringify(request), 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(body.length, 0)
    host.stdin.write(Buffer.concat([length, body]))
  })
}

test('设置页安装 Native Host，扩展 ID 与固定公钥一致', async () => {
  test.setTimeout(90_000)
  const { app, page, dataDir, hostDir } = await launch()
  try {
    const before = await page.evaluate(() => (window as never as { brewphase: any }).brewphase.chrome.status())
    expect(before.bridgeRunning).toBe(true)
    expect(before.hostInstalled).toBe(false)

    const outcome = await page.evaluate(() => (window as never as { brewphase: any }).brewphase.chrome.install())
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    expect(outcome.status.hostInstalled).toBe(true)
    expect(outcome.status.extensionId).toBe('fohjelihijmiefmjadckiajickopdojn')
    expect(outcome.status.hostPath).toContain(hostDir)
    expect(String(outcome.status.extensionDir)).toContain('ChromeExtension')

    // manifest 里绑定的正是这个扩展 ID，且 path 是绝对路径。
    const manifest = JSON.parse(
      readFileSync(join(hostDir, 'com.brewphase.chrome.json'), 'utf8')
    ) as { path: string; allowed_origins: string[] }
    expect(manifest.path).toBe(outcome.status.hostPath)
    expect(manifest.allowed_origins).toEqual(['chrome-extension://fohjelihijmiefmjadckiajickopdojn/'])

    // 设置页能看到真实状态。
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: 'Chrome 扩展', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Chrome 扩展', exact: true })).toBeVisible()
    await expect(page.getByText('已安装', { exact: true })).toBeVisible()
    await expect(page.getByText('fohjelihijmiefmjadckiajickopdojn')).toBeVisible()
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(hostDir, { recursive: true, force: true })
  }
})

test('模拟 Chrome → Host → Desktop → Records：保存成功且重复 requestId 不重复落库', async () => {
  test.setTimeout(120_000)
  const { app, page, dataDir, hostDir } = await launch()
  let host: ChildProcessWithoutNullStreams | null = null
  try {
    const outcome = await page.evaluate(() => (window as never as { brewphase: any }).brewphase.chrome.install())
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)

    host = startHost(join(hostDir, 'host-config.json'))

    const payload = {
      title: 'Chrome Companion 端到端验收',
      url: 'https://example.com/chrome-companion-e2e',
      domain: 'example.com',
      faviconUrl: 'https://example.com/favicon.ico',
      description: '这是一段页面描述，来自模拟的 Chrome。',
      selectedText: '这是用户选中的文字，必须原样进入备注。'
    }

    const first = await roundTrip(host, {
      version: 1,
      requestId: 'e2e-save-1',
      type: 'SAVE_PAGE',
      payload
    })
    expect(first.success).toBe(true)
    expect(first.code).toBe('OK')
    const recordId = (first.data as { recordId?: string }).recordId
    expect(recordId).toBeTruthy()

    const records = await page.evaluate(() =>
      (window as never as { brewphase: any }).brewphase.records.list({
        search: '',
        carrier: null,
        tagId: null,
        limit: 50,
        offset: 0
      })
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: recordId,
      carrier: 'link',
      title: payload.title,
      urlString: payload.url,
      note: payload.selectedText,
      summary: payload.description
    })

    // 同 requestId 再发一次：Desktop 幂等，Records 里仍然只有一条。
    const second = await roundTrip(host, {
      version: 1,
      requestId: 'e2e-save-1',
      type: 'SAVE_PAGE',
      payload
    })
    expect((second.data as { recordId?: string }).recordId).toBe(recordId)

    const after = await page.evaluate(() =>
      (window as never as { brewphase: any }).brewphase.records.list({
        search: '',
        carrier: null,
        tagId: null,
        limit: 50,
        offset: 0
      })
    )
    expect(after).toHaveLength(1)
  } finally {
    host?.kill()
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(hostDir, { recursive: true, force: true })
  }
})
