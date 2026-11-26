import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CredentialStore, type SecretBox, type StoredAccount } from '../../src/main/account/credentials'

/**
 * 凭据存储测试：加密、解密、密文损坏、安全存储不可用。
 *
 * 用假 SecretBox（XOR + 前缀）代替 safeStorage：真 safeStorage 需要 Electron
 * 运行时与系统钥匙串，在 CI/沙箱里既不可用也不该被依赖。假实现同样会「加密后
 * 无法直接读出明文」，足以证明落盘内容不是明文。
 */

function fakeSecretBox(): SecretBox {
  const key = 0x5a
  return {
    available: () => true,
    encrypt: (plain) => {
      const body = Buffer.from(plain, 'utf8').map((byte) => byte ^ key)
      return Buffer.concat([Buffer.from('v1:', 'utf8'), Buffer.from(body)])
    },
    decrypt: (payload) => {
      if (payload.subarray(0, 3).toString('utf8') !== 'v1:') {
        throw new Error('bad envelope')
      }
      const body = payload.subarray(3).map((byte) => byte ^ key)
      return Buffer.from(body).toString('utf8')
    }
  }
}

function sampleAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    provider: 'google',
    userId: 'user_01H',
    displayName: '半木',
    avatarUrl: 'https://example.invalid/a.png',
    createdAt: '2026-01-02T03:04:05.000Z',
    refreshToken: 'refresh-token-value-that-must-not-appear-on-disk',
    ...overrides
  }
}

describe('CredentialStore', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'brewphase-account-'))
    filePath = join(dir, 'account', 'credentials.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('保存后可原样读回', () => {
    const store = new CredentialStore({ filePath, secretBox: fakeSecretBox() })
    const account = sampleAccount()
    expect(store.save(account)).toEqual({ ok: true, storage: 'encrypted' })

    const loaded = store.load()
    expect(loaded).toEqual({ status: 'ok', account, storage: 'encrypted' })
  })

  it('落盘内容里没有明文 Refresh Token / userId', () => {
    const store = new CredentialStore({ filePath, secretBox: fakeSecretBox() })
    store.save(sampleAccount())

    const raw = readFileSync(filePath, 'utf8')
    expect(raw).not.toContain('refresh-token-value-that-must-not-appear-on-disk')
    expect(raw).not.toContain('user_01H')
    expect(raw).not.toContain('半木')
    // 外层只有版本、算法与密文。
    expect(JSON.parse(raw)).toMatchObject({ version: 1, alg: 'safeStorage-v1' })
  })

  it('文件权限是 0600（仅当前用户可读）', () => {
    const store = new CredentialStore({ filePath, secretBox: fakeSecretBox() })
    store.save(sampleAccount())
    const mode = statSync(filePath).mode & 0o777
    // Windows 不实现 POSIX 位；那里由 DPAPI 与用户目录 ACL 承担同等职责。
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
  })

  it('文件损坏（不是 JSON）→ unreadable，且不删除原文件', () => {
    const store = new CredentialStore({ filePath, secretBox: fakeSecretBox() })
    store.save(sampleAccount())
    writeFileSync(filePath, '{ not json', 'utf8')

    expect(store.load()).toEqual({ status: 'failed', reason: 'unreadable' })
    expect(existsSync(filePath)).toBe(true)
  })

  it('信封结构不认识（版本不符）→ unreadable', () => {
    const store = new CredentialStore({ filePath, secretBox: fakeSecretBox() })
    store.save(sampleAccount())
    writeFileSync(filePath, JSON.stringify({ version: 2, alg: 'safeStorage-v1', payload: 'AAAA' }), 'utf8')

    expect(store.load()).toEqual({ status: 'failed', reason: 'unreadable' })
  })

  it('密文损坏 → decrypt-failed，按未登录处理', () => {
    const store = new CredentialStore({ filePath, secretBox: fakeSecretBox() })
    store.save(sampleAccount())
    // 合法信封 + 随手乱写的 payload：解密一定失败。
    writeFileSync(filePath, JSON.stringify({ version: 1, alg: 'safeStorage-v1', payload: 'YmFk' }), 'utf8')

    expect(store.load()).toEqual({ status: 'failed', reason: 'decrypt-failed' })
  })

  it('解密后结构与预期不符 → unreadable', () => {
    const box = fakeSecretBox()
    const store = new CredentialStore({ filePath, secretBox: box })
    store.save(sampleAccount())
    // 用同一个加密器写一个「能解密但字段不对」的载荷。
    const payload = box.encrypt(JSON.stringify({ provider: 'google' })).toString('base64')
    writeFileSync(filePath, JSON.stringify({ version: 1, alg: 'safeStorage-v1', payload }), 'utf8')

    expect(store.load()).toEqual({ status: 'failed', reason: 'unreadable' })
  })

  it('没有文件 → empty', () => {
    const store = new CredentialStore({ filePath, secretBox: fakeSecretBox() })
    expect(store.load()).toEqual({ status: 'empty' })
  })

  it('安全存储不可用：不写、不读，也不退化成明文', () => {
    const unavailable: SecretBox = {
      available: () => false,
      encrypt: () => {
        throw new Error('must not be called')
      },
      decrypt: () => {
        throw new Error('must not be called')
      }
    }
    const store = new CredentialStore({ filePath, secretBox: unavailable })
    expect(store.canPersist).toBe(false)
    expect(store.save(sampleAccount())).toEqual({ ok: false, reason: 'unavailable' })
    expect(existsSync(filePath)).toBe(false)
    expect(store.load()).toEqual({ status: 'unavailable' })
  })

  it('加密抛错 → write-failed，不留临时文件', () => {
    const broken: SecretBox = {
      available: () => true,
      encrypt: () => {
        throw new Error('keychain locked')
      },
      decrypt: () => ''
    }
    const store = new CredentialStore({ filePath, secretBox: broken })
    expect(store.save(sampleAccount())).toEqual({ ok: false, reason: 'write-failed' })
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
  })

  it('clear() 只删凭据文件，之后再读是 empty', () => {
    const store = new CredentialStore({ filePath, secretBox: fakeSecretBox() })
    store.save(sampleAccount())
    store.clear()
    expect(existsSync(filePath)).toBe(false)
    expect(store.load()).toEqual({ status: 'empty' })
    // 幂等：重复 clear 不抛错。
    expect(() => store.clear()).not.toThrow()
  })

  it('覆盖保存：新会话替换旧凭据（Refresh Token Rotation 的落点）', () => {
    const store = new CredentialStore({ filePath, secretBox: fakeSecretBox() })
    store.save(sampleAccount({ refreshToken: 'old-token' }))
    store.save(sampleAccount({ refreshToken: 'new-token' }))

    const loaded = store.load()
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') return
    expect(loaded.account.refreshToken).toBe('new-token')
    expect(readFileSync(filePath, 'utf8')).not.toContain('new-token')
  })
})
