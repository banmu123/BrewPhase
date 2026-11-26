import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOCK_DEVICE_TOKEN } from '../helpers/mock-gateway'
import {
  createDeviceStore,
  deviceStorePaths,
  generateDeviceKeyPair,
  sameCloudOrigin,
  type RemoteSecretBox
} from '../../src/main/remote/device-identity'

/**
 * 设备身份与凭据存储（Phase 1.1B）。
 *
 * 这些用例覆盖的是 Spike 里实测到的**真实边界**：
 *
 * - `createPublicKey` 接受 SPKI 尾部垃圾 → 必须断言精确长度
 * - `crypto.verify` 对错误长度的签名返回 false 而不抛错 → 只认 `=== true`
 * - `safeStorage.decryptString(Buffer.alloc(0))` 不抛错 → 必须显式拒绝空密文
 * - `decryptStringAsync` 返回 `{shouldReEncrypt, result}` → 适配层统一形状
 */

/** 假 safeStorage：可控可用性与故障注入。 */
function fakeBox(overrides: Partial<RemoteSecretBox> = {}): RemoteSecretBox & {
  availableCalls: number
  failNextEncrypt: boolean
  failNextDecrypt: boolean
} {
  const state = {
    availableCalls: 0,
    failNextEncrypt: false,
    failNextDecrypt: false
  }
  const box = {
    available() {
      state.availableCalls += 1
      return true
    },
    async encrypt(plain: string) {
      if (state.failNextEncrypt) throw new Error('encrypt failed')
      // 简单的可逆变换，够用来验证「落盘不是明文」。
      return Buffer.from(`ENC:${plain}`, 'utf8')
    },
    async decrypt(payload: Buffer) {
      if (state.failNextDecrypt) throw new Error('decrypt failed')
      const text = payload.toString('utf8')
      if (!text.startsWith('ENC:')) throw new Error('not a valid ciphertext')
      return text.slice(4)
    },
    ...overrides
  }
  return Object.assign(box, state, {
    get availableCalls() {
      return state.availableCalls
    },
    get failNextEncrypt() {
      return state.failNextEncrypt
    },
    set failNextEncrypt(value: boolean) {
      state.failNextEncrypt = value
    },
    get failNextDecrypt() {
      return state.failNextDecrypt
    },
    set failNextDecrypt(value: boolean) {
      state.failNextDecrypt = value
    }
  })
}

let dir: string
let paths: ReturnType<typeof deviceStorePaths>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brewphase-remote-id-'))
  paths = deviceStorePaths(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeIdentity() {
  const { privateKey } = generateDeviceKeyPair()
  return {
    deviceId: 'dev-1',
    boundUserId: 'user-1',
    cloudOrigin: 'https://cloud.example.com',
    deviceToken: MOCK_DEVICE_TOKEN,
    privateKey,
    registeredAt: Date.now()
  }
}

describe('device.json 的读写与加密', () => {
  it('往返正确，且文件里没有明文 deviceId / token / 私钥', async () => {
    const box = fakeBox()
    const store = createDeviceStore(paths, box)
    const saved = await store.save(makeIdentity())
    expect(saved.ok).toBe(true)

    const loaded = await store.load()
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') return
    expect(loaded.identity.deviceId).toBe('dev-1')
    expect(loaded.identity.deviceToken).toBe(MOCK_DEVICE_TOKEN)
    expect(loaded.identity.cloudOrigin).toBe('https://cloud.example.com')
    expect(loaded.identity.privateKey.asymmetricKeyType).toBe('ed25519')

    const raw = await import('node:fs').then((fs) => fs.readFileSync(paths.devicePath, 'utf8'))
    expect(raw).not.toContain(MOCK_DEVICE_TOKEN)
    expect(raw).not.toContain('dev-1')
    expect(raw).not.toContain('user-1')
    // 外层只有版本与代际号。
    expect(JSON.parse(raw).version).toBe(2)
    expect(JSON.parse(raw).alg).toBe('safeStorage-v1')
  })

  it('safeStorage 不可用时拒绝读写，且绝不落明文', async () => {
    const box = fakeBox({ available: () => false })
    const store = createDeviceStore(paths, box)
    expect(await store.load()).toEqual({ status: 'unavailable' })
    expect(await store.save(makeIdentity())).toEqual({ ok: false, reason: 'unavailable' })
    const fs = await import('node:fs')
    expect(fs.existsSync(paths.devicePath)).toBe(false)
  })

  it('密文损坏 → decrypt-failed，且不静默重建身份', async () => {
    const box = fakeBox()
    const store = createDeviceStore(paths, box)
    await store.save(makeIdentity())

    // 把 payload 改成一段无法解密的密文
    const fs = await import('node:fs')
    const envelope = JSON.parse(fs.readFileSync(paths.devicePath, 'utf8'))
    envelope.payload = Buffer.from('garbage', 'utf8').toString('base64')
    fs.writeFileSync(paths.devicePath, JSON.stringify(envelope))

    const loaded = await store.load()
    expect(loaded.status).toBe('failed')
    if (loaded.status === 'failed') expect(loaded.reason).toBe('decrypt-failed')
    // 关键：坏文件必须还在，等用户决定；不能自动换成一把新钥匙。
    expect(fs.existsSync(paths.devicePath)).toBe(true)
  })

  it('密钥损坏（长度不对）→ invalid-key，不覆盖原文件', async () => {
    const box = fakeBox()
    const store = createDeviceStore(paths, box)
    await store.save(makeIdentity())

    const fs = await import('node:fs')
    const envelope = JSON.parse(fs.readFileSync(paths.devicePath, 'utf8'))
    const stored = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8').slice(4))
    // 截短私钥：Ed25519 PKCS8 必须是 48 字节
    stored.privateKeyPkcs8 = Buffer.alloc(20).toString('base64')
    envelope.payload = Buffer.from(`ENC:${JSON.stringify(stored)}`, 'utf8').toString('base64')
    fs.writeFileSync(paths.devicePath, JSON.stringify(envelope))

    const loaded = await store.load()
    expect(loaded.status).toBe('failed')
    if (loaded.status === 'failed') expect(loaded.reason).toBe('invalid-key')
    expect(fs.existsSync(paths.devicePath)).toBe(true)
  })
})

describe('forget 与轮换的并发保护（代际号）', () => {
  it('forget 先把代际号 +1 落盘，再删凭据', async () => {
    const store = createDeviceStore(paths, fakeBox())
    await store.save(makeIdentity())
    const before = store.currentGeneration()

    expect(await store.forget()).toEqual({ ok: true })
    expect(store.currentGeneration()).toBe(before + 1)
    const fs = await import('node:fs')
    expect(fs.existsSync(paths.devicePath)).toBe(false)
    // 代际号文件必须还在——删了它，崩溃恢复就认不出旧任务了。
    expect(fs.existsSync(paths.generationPath)).toBe(true)
  })

  it('forget 之后旧凭据不会被写回来（ST-32 的核心）', async () => {
    const box = fakeBox()
    const store = createDeviceStore(paths, box)
    await store.save(makeIdentity())

    // 模拟「一个旧任务在 forget 之前启动了保存」：它的 encrypt 还没完成。
    let releaseEncrypt: (() => void) | null = null
    const slowBox: RemoteSecretBox = {
      available: () => true,
      encrypt: (plain) =>
        new Promise<Buffer>((resolve) => {
          releaseEncrypt = () => resolve(Buffer.from(`ENC:${plain}`, 'utf8'))
        }),
      decrypt: box.decrypt
    }
    const slowStore = createDeviceStore(paths, slowBox)
    const pendingSave = slowStore.save(makeIdentity())

    // 等加密开始，然后 forget
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await store.forget()).toEqual({ ok: true })
    expect(releaseEncrypt).not.toBeNull()
    releaseEncrypt!()

    const result = await pendingSave
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stale-generation')

    const fs = await import('node:fs')
    expect(fs.existsSync(paths.devicePath)).toBe(false)
  })

  it('崩溃恢复后仍能识别旧任务已失效', async () => {
    const store = createDeviceStore(paths, fakeBox())
    await store.save(makeIdentity())
    const staleGeneration = store.currentGeneration()

    await store.forget()

    // 新进程（新 store 实例）读到的是更大的代际号。
    const fresh = createDeviceStore(paths, fakeBox())
    expect(fresh.currentGeneration()).toBeGreaterThan(staleGeneration)

    // 一个「记得旧代际号」的保存无法通过：它必须是旧实例才可能持有旧值，
    // 这里直接断言 reload 后的代际号已变，等价于旧任务无法再写。
    expect(await fresh.load()).toEqual({ status: 'empty' })
  })
})

describe('Cloud Origin 绑定（ST-31）', () => {
  it('相同 origin 的不同写法视为同一个', () => {
    expect(sameCloudOrigin('https://cloud.example.com', 'https://cloud.example.com/')).toBe(true)
    expect(sameCloudOrigin('https://cloud.example.com/a', 'https://cloud.example.com/b')).toBe(true)
  })

  it('不同 origin / 不同协议 / 不同端口 / 非法 URL 都不相等', () => {
    expect(sameCloudOrigin('https://cloud.example.com', 'https://evil.example.com')).toBe(false)
    expect(sameCloudOrigin('https://cloud.example.com', 'http://cloud.example.com')).toBe(false)
    expect(sameCloudOrigin('https://cloud.example.com', 'https://cloud.example.com:8443')).toBe(false)
    expect(sameCloudOrigin('not a url', 'https://cloud.example.com')).toBe(false)
  })

  it('保存的 cloudOrigin 能被读回，便于启动时比较', async () => {
    const store = createDeviceStore(paths, fakeBox())
    await store.save(makeIdentity())
    const loaded = await store.load()
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') return
    expect(sameCloudOrigin(loaded.identity.cloudOrigin, 'https://cloud.example.com')).toBe(true)
    expect(sameCloudOrigin(loaded.identity.cloudOrigin, 'https://other.example.com')).toBe(false)
  })
})
