import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 清理开发环境注册的 Native Host。
 *
 * 只删自己写的东西：`com.brewphase.chrome` 的注册表项、manifest 与
 * `BrewPhase/ChromeCompanion` 目录；不碰其他应用。
 */

const HOST_NAME = 'com.brewphase.chrome'
const platform = process.platform

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

if (platform === 'win32') {
  try {
    execFileSync('reg', ['delete', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/f'])
  } catch {
    // 未注册：忽略。
  }
}

if (existsSync(manifestPath())) rmSync(manifestPath(), { force: true })
if (existsSync(hostDir())) rmSync(hostDir(), { recursive: true, force: true })

console.log('[uninstall-host] removed BrewPhase Chrome Companion registration')
