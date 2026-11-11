import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 把 Rust Native Host 编译到 Desktop 的 resources 目录。
 *
 * 开发与打包共用同一份产物：
 * - 开发：`Desktop/resources/native-host/<platform>/`，Electron 直接读；
 * - 打包：electron-builder 的 extraResources 把它带到 `resources/native-host/`。
 */

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const nativeHost = join(root, 'native-host')
const platformKey = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
const binaryName = process.platform === 'win32' ? 'brewphase-chrome-host.exe' : 'brewphase-chrome-host'
const target = join(root, '..', 'Desktop', 'resources', 'native-host', platformKey, binaryName)

console.log(`[host] cargo build --release (${platformKey})`)
execFileSync('cargo', ['build', '--release'], { cwd: nativeHost, stdio: 'inherit' })

const built = join(nativeHost, 'target', 'release', binaryName)
if (!existsSync(built)) {
  console.error(`[host] build output not found: ${built}`)
  process.exit(1)
}

mkdirSync(dirname(target), { recursive: true })
copyFileSync(built, target)
console.log(`[host] ${(statSync(target).size / 1024).toFixed(1)} KB -> ${target}`)
