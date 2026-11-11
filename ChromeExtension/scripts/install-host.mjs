import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 开发环境的 Native Host 安装脚本（等价于 Desktop 设置页里的「安装」）。
 *
 * 用途：CI、调试、或在没有启动 Desktop 的情况下先注册好 Host。
 * 注意：Desktop 每次启动会重写 `host-config.json`（endpoint + token 轮换），
 * 所以用本脚本安装后，请重启一次 BrewPhase Desktop 让配置生效。
 */

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const HOST_NAME = 'com.brewphase.chrome'
const platform = process.platform
const binaryName = platform === 'win32' ? 'brewphase-chrome-host.exe' : 'brewphase-chrome-host'

const identity = JSON.parse(readFileSync(join(root, 'extension-id.json'), 'utf8'))
const source = join(root, 'native-host', 'target', 'release', binaryName)

if (!existsSync(source)) {
  console.error(`[install-host] missing ${source}`)
  console.error('               run `pnpm host:build` first')
  process.exit(1)
}

function hostDir() {
  if (platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'BrewPhase', 'ChromeCompanion')
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'BrewPhase', 'ChromeCompanion')
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'brewphase', 'chrome-companion')
}

function manifestPath() {
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`)
  }
  if (platform === 'win32') {
    return join(hostDir(), `${HOST_NAME}.json`)
  }
  return join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`)
}

const dir = hostDir()
const hostPath = join(dir, binaryName)
const configPath = join(dir, 'host-config.json')
const manifest = manifestPath()

mkdirSync(dir, { recursive: true })
copyFileSync(source, hostPath)
if (platform !== 'win32') chmodSync(hostPath, 0o755)

if (!existsSync(configPath)) {
  writeFileSync(
    configPath,
    `${JSON.stringify(
      { version: 1, endpoint: '', token: '', appVersion: '', installedAt: 0 },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
}

mkdirSync(dirname(manifest), { recursive: true })
writeFileSync(
  manifest,
  `${JSON.stringify(
    {
      name: HOST_NAME,
      description: 'BrewPhase Chrome Companion',
      path: hostPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${identity.id}/`]
    },
    null,
    2
  )}\n`
)

if (platform === 'win32') {
  execFileSync('reg', [
    'add',
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    '/ve',
    '/t',
    'REG_SZ',
    '/d',
    manifest,
    '/f'
  ])
}

console.log(`[install-host] host:      ${hostPath}`)
console.log(`[install-host] manifest:  ${manifest}`)
console.log(`[install-host] extension: ${identity.id}`)
console.log('[install-host] restart BrewPhase Desktop to refresh the token')
