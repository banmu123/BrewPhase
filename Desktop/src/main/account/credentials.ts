import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { AccountProvider } from '../../shared/contracts/account'

/**
 * Cloud Account 凭据存储。
 *
 * 三条硬约束：
 *
 * 1. **Refresh Token 绝不落明文**。落盘的是 safeStorage 密文（macOS Keychain /
 *    Windows DPAPI / Linux keyring 派生密钥），外层只留 `{version, alg, payload}`，
 *    连 userId、邮箱都不在明文里。文件权限收到 0600，目录 0700。
 * 2. **不使用 localStorage，也不写进任何业务配置文件**。凭据单独一个文件
 *    （默认 `<userData>/account/credentials.json`），与数据库、偏好、同步 token
 *    完全分离——退出登录只删这一个文件，本地记录一条不动。
 * 3. **解密失败/安全存储不可用一律按未登录处理**，绝不「退化成明文继续存」。
 *    安全存储不可用时连写都不写：本次会话只在内存里，界面会如实提示重启需重新登录。
 *
 * Electron 依赖通过 `SecretBox` 注入：单测用假实现即可覆盖加密、损坏、
 * 不可用三条分支，不需要真的起 Electron。
 */

export interface SecretBox {
  /** `safeStorage.isEncryptionAvailable()` */
  available(): boolean
  /** `safeStorage.encryptString()` */
  encrypt(plain: string): Buffer
  /** `safeStorage.decryptString()`；失败时抛错。 */
  decrypt(payload: Buffer): string
}

export interface StoredAccount {
  provider: AccountProvider
  userId: string
  displayName: string | null
  avatarUrl: string | null
  createdAt: string
  /** 明文只在这个对象与主进程内存里出现；`save()` 会立刻加密。 */
  refreshToken: string
}

export type CredentialLoad =
  | { status: 'empty' }
  | { status: 'ok'; account: StoredAccount; storage: 'encrypted' }
  /** 系统安全存储不可用：不读也不写，按未登录处理。 */
  | { status: 'unavailable' }
  /**
   * 读到了文件但没法用：
   * - `unreadable`：JSON 坏 / 结构不对 / 读文件失败；
   * - `decrypt-failed`：密文损坏或系统密钥变了。
   * 两种情况都保留原文件（不删），下次登录成功会覆盖它。
   */
  | { status: 'failed'; reason: 'unreadable' | 'decrypt-failed' }

export type CredentialSave =
  | { ok: true; storage: 'encrypted' }
  | { ok: false; reason: 'unavailable' | 'write-failed' }

const envelopeSchema = z.object({
  version: z.literal(1),
  alg: z.literal('safeStorage-v1'),
  payload: z.string().min(1)
})

const accountSchema = z.object({
  provider: z.enum(['google', 'github']),
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAt: z.string(),
  refreshToken: z.string().min(1)
})

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export class CredentialStore {
  constructor(
    private readonly params: {
      filePath: string
      secretBox: SecretBox
      /** 只在主进程终端里打印路径与原因，绝不打印凭据内容。 */
      log?: (message: string) => void
    }
  ) {}

  get path(): string {
    return this.params.filePath
  }

  /** 当前系统是否能安全落盘。界面据此显示「本次登录不会保存」。 */
  get canPersist(): boolean {
    try {
      return this.params.secretBox.available()
    } catch {
      return false
    }
  }

  load(): CredentialLoad {
    if (!this.canPersist) return { status: 'unavailable' }
    if (!existsSync(this.params.filePath)) return { status: 'empty' }

    let envelope: z.infer<typeof envelopeSchema>
    try {
      const raw = readFileSync(this.params.filePath, 'utf8')
      const parsed = envelopeSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        this.log('credentials file has an unknown shape')
        return { status: 'failed', reason: 'unreadable' }
      }
      envelope = parsed.data
    } catch {
      // 读失败与解析失败同处理：都当作「没有可用凭据」，不阻塞启动。
      this.log('credentials file is unreadable')
      return { status: 'failed', reason: 'unreadable' }
    }

    let plain: string
    try {
      plain = this.params.secretBox.decrypt(Buffer.from(envelope.payload, 'base64'))
    } catch {
      // 密钥换了 / 密文被改：安全降级为未登录，不尝试任何「修复」。
      this.log('credentials could not be decrypted')
      return { status: 'failed', reason: 'decrypt-failed' }
    }

    try {
      const account = accountSchema.parse(JSON.parse(plain))
      return { status: 'ok', account, storage: 'encrypted' }
    } catch {
      this.log('decrypted credentials have an unknown shape')
      return { status: 'failed', reason: 'unreadable' }
    }
  }

  save(account: StoredAccount): CredentialSave {
    if (!this.canPersist) return { ok: false, reason: 'unavailable' }

    let payload: string
    try {
      const encrypted = this.params.secretBox.encrypt(JSON.stringify(account))
      payload = encrypted.toString('base64')
    } catch {
      this.log('credentials could not be encrypted')
      return { ok: false, reason: 'write-failed' }
    }

    const body = JSON.stringify({ version: 1, alg: 'safeStorage-v1', payload })
    const target = this.params.filePath
    const temp = `${target}.tmp`
    try {
      mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE })
      // 先写临时文件再改名：中途崩掉不会留下半截 JSON（那会被判成 unreadable）。
      writeFileSync(temp, body, { encoding: 'utf8', mode: FILE_MODE })
      chmodSync(temp, FILE_MODE)
      renameSync(temp, target)
      return { ok: true, storage: 'encrypted' }
    } catch {
      this.log('credentials could not be written')
      try {
        rmSync(temp, { force: true })
      } catch {
        // 清理失败不影响结论：调用方拿到的仍是 write-failed。
      }
      return { ok: false, reason: 'write-failed' }
    }
  }

  /** 退出登录：只删凭据文件，不碰数据库、媒体与任何本地记录。 */
  clear(): void {
    try {
      rmSync(this.params.filePath, { force: true })
    } catch {
      this.log('credentials could not be removed')
    }
    try {
      rmSync(`${this.params.filePath}.tmp`, { force: true })
    } catch {
      // 同上：残留临时文件无害，下次 save 会覆盖。
    }
  }

  private log(message: string): void {
    this.params.log?.(`[account] ${message} (${this.params.filePath})`)
  }
}
