import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject
} from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_CLOUD_ORIGIN } from '../../shared/contracts/remote'

/**
 * 设备身份与凭据持久化。
 *
 * 与 `account/credentials.ts` 的分工（**不许合并**）：
 *
 * | | `account/credentials.json` | `remote/device.json` |
 * |---|---|---|
 * | 证明什么 | 「这个人在浏览器里登录过」 | 「这台机器是已确认的那台设备」 |
 * | 凭据 | 用户 refresh token | `bp_dev_*` + Ed25519 私钥 |
 * | 谁撤销 | 用户登出 / Cloud 撤销会话 | 用户「忘记设备」/ Cloud 撤销设备 |
 *
 * **设备永不持有用户 access token，也永不持有 `bp_mcp_*`**——两条都是越权面。
 *
 * ## 落盘格式
 *
 * ```jsonc
 * { "version": 2, "alg": "safeStorage-v1", "generation": 3, "payload": "<base64 密文>" }
 * ```
 *
 * 外层只有版本与代际号，**连 deviceId 都不在明文里**。代际号在外层是刻意的：
 * 见 `remote-generation.ts` 的 tombstone 说明。
 *
 * ## Spike 结论如何影响本文件（Electron 45.2.3 实测）
 *
 * | 实测发现 | 本文件的防守 |
 * |---|---|
 * | `crypto.verify` 对**错误长度的签名**返回 `false` 而不是抛错 | 不依赖抛错，只信 `=== true` |
 * | `createPublicKey` **接受 SPKI 尾部垃圾**（多一个字节仍解析成功） | 断言 SPKI 必须**恰好 44 字节**且 `asymmetricKeyType === 'ed25519'` |
 * | `safeStorage.decryptString(Buffer.alloc(0))` **不抛错** | 解密前显式拒绝空密文 |
 * | `decryptStringAsync` 返回 `{ shouldReEncrypt, result }` 而非字符串 | 用适配层统一形状（`SecretBox`） |
 * | `isEncryptionAvailable/encryptString/decryptString` 在 45 已 deprecated | 优先异步 API，同步仅作老版本回退 |
 */

/** Ed25519 的 DER 长度是固定的：私钥 PKCS8 48 字节、公钥 SPKI 44 字节。 */
const ED25519_PKCS8_BYTES = 48
const ED25519_SPKI_BYTES = 44

export type RemoteSecretBox = {
  available(): boolean
  encrypt(plain: string): Promise<Buffer>
  decrypt(payload: Buffer): Promise<string>
}

export type DeviceIdentity = {
  deviceId: string
  boundUserId: string
  cloudOrigin: string
  deviceToken: string
  /** PKCS8 DER，只在主进程内存里出现。 */
  privateKey: KeyObject
  publicKey: KeyObject
  registeredAt: number
}

const storedSchema = z.object({
  deviceId: z.string().min(1).max(128),
  boundUserId: z.string().min(1).max(128),
  cloudOrigin: z.string().min(1).max(256),
  deviceToken: z.string().min(1).max(512),
  privateKeyPkcs8: z.string().min(1).max(512),
  registeredAt: z.number().int()
})
type StoredDevice = z.infer<typeof storedSchema>

const envelopeSchema = z.object({
  version: z.literal(2),
  alg: z.literal('safeStorage-v1'),
  generation: z.number().int().nonnegative(),
  payload: z.string()
})
type Envelope = z.infer<typeof envelopeSchema>

export type DeviceLoad =
  | { status: 'empty' }
  | { status: 'ok'; identity: DeviceIdentity; generation: number }
  /** 安全存储不可用：不读也不写，按「无设备身份」处理（**绝不退化明文**）。 */
  | { status: 'unavailable' }
  /** 读到了但没法用。reason 决定是否需要用户重新配对。 */
  | { status: 'failed'; reason: 'unreadable' | 'decrypt-failed' | 'invalid-key' }

export type DeviceSave =
  | { ok: true; generation: number }
  | { ok: false; reason: 'unavailable' | 'write-failed' | 'stale-generation' }

/** `safeStorage` 的适配层；单测注入假实现即可覆盖三条失败分支。 */
export function electronSecretBox(safeStorage: {
  isEncryptionAvailable?: () => boolean
  isAsyncEncryptionAvailable?: () => Promise<boolean>
  encryptString?: (plain: string) => Buffer
  encryptStringAsync?: (plain: string) => Promise<Buffer>
  decryptString?: (payload: Buffer) => string
  decryptStringAsync?: (payload: Buffer) => Promise<{ shouldReEncrypt: boolean; result: string } | string>
}): RemoteSecretBox {
  return {
    available() {
      // 同步版本在 Electron 45 已 deprecated，但判断可用性没有异步等价物
      // 之外的成本；优先用它（同步、无 await），并在实现里兼容老版本。
      if (typeof safeStorage.isEncryptionAvailable === 'function') {
        return safeStorage.isEncryptionAvailable()
      }
      return false
    },
    async encrypt(plain: string) {
      if (typeof safeStorage.encryptStringAsync === 'function') {
        const out = await safeStorage.encryptStringAsync(plain)
        if (!Buffer.isBuffer(out)) throw new Error('safeStorage returned a non-buffer ciphertext')
        return out
      }
      if (typeof safeStorage.encryptString === 'function') return safeStorage.encryptString(plain)
      throw new Error('safeStorage encryption is unavailable')
    },
    async decrypt(payload: Buffer) {
      // Spike 实测：空密文在 Electron 45 **不抛错**，会「成功」解密出空串。
      // 不显式拒绝的话，一个被截断成 0 字节的凭据文件会被当成合法空载荷。
      if (payload.length === 0) throw new Error('empty ciphertext')
      if (typeof safeStorage.decryptStringAsync === 'function') {
        const out = await safeStorage.decryptStringAsync(payload)
        // Spike 实测：异步版返回 `{ shouldReEncrypt, result }`。
        if (typeof out === 'string') return out
        if (out && typeof out.result === 'string') return out.result
        throw new Error('safeStorage returned an unexpected payload shape')
      }
      if (typeof safeStorage.decryptString === 'function') return safeStorage.decryptString(payload)
      throw new Error('safeStorage decryption is unavailable')
    }
  }
}

/**
 * 校验一段 SPKI/PKCS8 DER 确实是 Ed25519，且长度精确。
 *
 * **必须做长度断言**：Spike 实测 `createPublicKey` 会接受「44 字节合法 SPKI + 1 字节垃圾」，
 * 仅靠「能不能解析」会把脏数据当成合法公钥。
 */
export function assertEd25519Private(pkcs8: Buffer): KeyObject {
  if (pkcs8.length !== ED25519_PKCS8_BYTES) {
    throw new Error(`ed25519 private key must be ${ED25519_PKCS8_BYTES} bytes, got ${pkcs8.length}`)
  }
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`expected ed25519 private key, got ${key.asymmetricKeyType}`)
  }
  return key
}

export function assertEd25519Public(spki: Buffer): KeyObject {
  if (spki.length !== ED25519_SPKI_BYTES) {
    throw new Error(`ed25519 public key must be ${ED25519_SPKI_BYTES} bytes, got ${spki.length}`)
  }
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`expected ed25519 public key, got ${key.asymmetricKeyType}`)
  }
  return key
}

/** 生成一对 Ed25519。 */
export function generateDeviceKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey }
}

/**
 * 握手签名的规范串（协议 §4.2，**唯一实现**）。
 *
 * ## 为什么不是「只签 device_id + nonce + ts」的旧写法
 *
 * 旧文档写的是三元组，旧代码签的是另一套 5 行串——两边都自称权威，实际互不兼容。
 * 真正的问题是：**只签三个字段会放过版本降级与能力伪造**。若 `min_version` /
 * `max_version` / `capabilities` 不在签名内，一条被篡改的帧可以让 Cloud 以为
 * 这台设备只支持更老的版本，从而关掉它本可以用的保护。
 *
 * 所以 v1 的规则是：**除 `sig` 之外，`hello` 的每个字段都进签名**，
 * 顺序固定为下面的声明顺序，`capabilities` 排序后逗号连接。
 *
 * ```
 * brewphase.remote.hello.v1
 * v=1
 * type=hello
 * ts=1763400000123
 * device_id=0b7c…
 * nonce=…
 * min_version=1
 * max_version=1
 * app_version=0.1.5
 * platform=darwin
 * capabilities=cancel,drain,tools.call
 * serviceable=true
 * ```
 *
 * 首行是**域分隔**：没有它，同一把私钥在别处（例如 §3.5 的 rotate）签的消息
 * 可能与本协议的消息在字节上同形，形成跨协议签名复用。
 *
 * 字段集合在 v1 内冻结；新增字段属于兼容变更，但**必须**同时定义新的规范串
 * 前缀（`brewphase.remote.hello.v2`），否则新旧实现的签名会静默错配。
 */
export function helloSigningPayload(input: {
  v: number
  type: string
  ts: number
  device_id: string
  nonce: string
  min_version: number
  max_version: number
  app_version: string
  platform: string
  capabilities: readonly string[]
  serviceable: boolean
}): Buffer {
  const text = [
    'brewphase.remote.hello.v1',
    `v=${input.v}`,
    `type=${input.type}`,
    `ts=${input.ts}`,
    `device_id=${assertNoSeparators('device_id', input.device_id)}`,
    `nonce=${assertNoSeparators('nonce', input.nonce)}`,
    `min_version=${input.min_version}`,
    `max_version=${input.max_version}`,
    `app_version=${assertNoSeparators('app_version', input.app_version)}`,
    `platform=${assertNoSeparators('platform', input.platform)}`,
    `capabilities=${[...input.capabilities].sort().map((c) => assertNoSeparators('capabilities', c)).join(',')}`,
    `serviceable=${input.serviceable ? 'true' : 'false'}`
  ].join('\n')
  return Buffer.from(text, 'utf8')
}

/**
 * 规范串是「换行 + 等号」分隔的，所以字段值里出现换行会让两个不同的
 * 字段组合产生同一段字节（canonical ambiguity）。签名前必须显式拒绝。
 */
function assertNoSeparators(field: string, value: string): string {
  if (/[\n\r]/.test(value)) throw new Error(`${field} must not contain line breaks`)
  return value
}

export type HelloSigningInput = Parameters<typeof helloSigningPayload>[0]

export function signHello(privateKey: KeyObject, input: HelloSigningInput): string {
  // base64url：与协议文档一致，且不含 `+` `/` `=`，放进 JSON 与头里都不用转义。
  return cryptoSign(null, helloSigningPayload(input), privateKey).toString('base64url')
}

/**
 * 验签（Mock Gateway 与单测使用）。
 *
 * **只认 `=== true`**：Spike 实测错误长度的签名不会抛错，而是返回 `false`。
 */
export function verifyHello(publicKey: KeyObject, input: HelloSigningInput, sigBase64Url: string): boolean {
  try {
    // 同时接受 base64url 与 base64：Cloud 侧实现可能用标准 base64 解码。
    const sig = Buffer.from(sigBase64Url, 'base64url')
    if (sig.length !== 64) return false
    return cryptoVerify(null, helloSigningPayload(input), publicKey, sig) === true
  } catch {
    return false
  }
}

/** Ed25519 SPKI DER 的固定前缀（12 字节），其后是裸 32 字节公钥。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * 取裸 32 字节公钥（协议 §3.2 的 `public_key` 字段）。
 *
 * Cloud 只存裸公钥（与现有 `sync` 设备表一致），而本机内存里是 SPKI DER，
 * 所以注册时必须做这一步显式转换——**不能直接发 DER**，否则 Cloud 会按
 * 「32 字节」校验失败，而错误文案只会说 `invalid_public_key`。
 */
export function ed25519RawPublicKey(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  if (spki.length !== ED25519_SPKI_BYTES) {
    throw new Error(`ed25519 public key must be ${ED25519_SPKI_BYTES} bytes, got ${spki.length}`)
  }
  if (!spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('public key is not an ed25519 SPKI key')
  }
  const raw = spki.subarray(ED25519_SPKI_PREFIX.length)
  if (raw.length !== 32) throw new Error(`ed25519 raw public key must be 32 bytes, got ${raw.length}`)
  return raw
}

/** 裸 32 字节 → SPKI DER 的 KeyObject（Mock 与将来 Cloud 侧的自检用）。 */
export function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error(`ed25519 raw public key must be 32 bytes, got ${raw.length}`)
  // 拼回 SPKI 后再走同一个长度/类型断言，避免绕过上面那条不变量。
  return assertEd25519Public(Buffer.concat([ED25519_SPKI_PREFIX, raw]))
}

/** 裸公钥的 base64url 文本（43 字符）。 */
export function encodeRawPublicKey(publicKey: KeyObject): string {
  return ed25519RawPublicKey(publicKey).toString('base64url')
}

export function decodeRawPublicKey(text: string): KeyObject {
  return ed25519PublicKeyFromRaw(Buffer.from(text, 'base64url'))
}

/** 随机 nonce（base64url，16 字节 = 22 字符）。 */
export function makeNonce(): string {
  return randomBytes(16).toString('base64url')
}

// MARK: - 持久化

export type DeviceStorePaths = {
  dir: string
  devicePath: string
  /** 代际 tombstone：**独立文件**，删 device.json 也不丢。 */
  generationPath: string
  statePath: string
}

export function deviceStorePaths(baseDir: string): DeviceStorePaths {
  const dir = join(baseDir, 'remote')
  return {
    dir,
    devicePath: join(dir, 'device.json'),
    generationPath: join(dir, 'generation'),
    statePath: join(dir, 'state.json')
  }
}

export type DeviceStore = {
  load(): Promise<DeviceLoad>
  save(identity: Omit<DeviceIdentity, 'privateKey' | 'publicKey'> & { privateKey: KeyObject }): Promise<DeviceSave>
  /** 删除设备凭据并**先把代际号 +1 落盘**，使旧的异步保存全部失效。 */
  forget(): Promise<{ ok: true } | { ok: false; reason: 'write-failed' }>
  /** 当前持久化代际号（测试与 diagnose 用）。 */
  currentGeneration(): number
  paths: DeviceStorePaths
}

/**
 * 创建设备凭据存储。
 *
 * ## 代际号为什么必须独立成文件
 *
 * 「忘记设备」要删 `device.json`，而 `generation` 若存在该文件内部，
 * 删除时就一起消失了——于是**在删除前就已经启动的异步保存**会把旧凭据
 * 原样写回来，用户以为忘了，其实没忘。把 generation 放在独立文件里，
 * forget 的语义就变成「先把代际号 +1 并落盘，再删凭据」，
 * 旧写入在写之前比对代际号即可失败。崩溃恢复后同样有效：
 * 代际号仍然比旧任务记住的值大。
 */
export function createDeviceStore(paths: DeviceStorePaths, box: RemoteSecretBox): DeviceStore {
  /**
   * **每次都读盘，不做内存缓存**。
   *
   * 这是持久化层面的不变量：`forget` 可能来自另一个 `DeviceStore` 实例
   * （测试里是这样，将来若出现多窗口/多进程也是），缓存会让「旧任务」
   * 看不见别人刚做的 +1，于是把该丢弃的保存写成功。
   * 文件只有几个字节，保存本身是低频操作，读盘成本可以忽略。
   */
  const readGeneration = (): number => {
    try {
      const raw = readFileSync(paths.generationPath, 'utf8').trim()
      const value = Number.parseInt(raw, 10)
      return Number.isFinite(value) && value >= 0 ? value : 0
    } catch {
      return 0
    }
  }

  const writeGeneration = (value: number): void => {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(paths.dir, 0o700)
    } catch {
      /* Windows 忽略 */
    }
    atomicWrite(paths.generationPath, `${value}\n`)
  }

  return {
    paths,

    currentGeneration: readGeneration,

    async load(): Promise<DeviceLoad> {
      // 顺序：**先判安全存储可用性**。
      // 反过来的话，一台安全存储坏掉的机器会得到「没有设备」——用户会去
      // 重新配对，而重新配对同样写不进去，最后卡在一个说不清的状态。
      // 报 `unavailable` 才能让界面说「系统安全存储不可用」。
      if (!box.available()) return { status: 'unavailable' }
      if (!existsSync(paths.devicePath)) return { status: 'empty' }

      let envelope: Envelope
      try {
        const parsed = envelopeSchema.safeParse(JSON.parse(readFileSync(paths.devicePath, 'utf8')))
        if (!parsed.success) return { status: 'failed', reason: 'unreadable' }
        envelope = parsed.data
      } catch {
        return { status: 'failed', reason: 'unreadable' }
      }

      let plain: string
      try {
        plain = await box.decrypt(Buffer.from(envelope.payload, 'base64'))
      } catch {
        return { status: 'failed', reason: 'decrypt-failed' }
      }

      let stored: StoredDevice
      try {
        const parsed = storedSchema.safeParse(JSON.parse(plain))
        if (!parsed.success) return { status: 'failed', reason: 'unreadable' }
        stored = parsed.data
      } catch {
        return { status: 'failed', reason: 'unreadable' }
      }

      let privateKey: KeyObject
      let publicKey: KeyObject
      try {
        privateKey = assertEd25519Private(Buffer.from(stored.privateKeyPkcs8, 'base64'))
        publicKey = createPublicKey(privateKey)
      } catch {
        // 密钥坏了**绝不静默重建**：那会让用户在不知情的情况下换了一把身份，
        // 而 Cloud 侧仍挂着旧公钥。必须走「忘记设备 → 重新配对」。
        return { status: 'failed', reason: 'invalid-key' }
      }

      return {
        status: 'ok',
        generation: envelope.generation,
        identity: {
          deviceId: stored.deviceId,
          boundUserId: stored.boundUserId,
          cloudOrigin: stored.cloudOrigin,
          deviceToken: stored.deviceToken,
          privateKey,
          publicKey,
          registeredAt: stored.registeredAt
        }
      }
    },

    async save(input): Promise<DeviceSave> {
      if (!box.available()) return { ok: false, reason: 'unavailable' }

      // 写入前取一次代际号；忘了设备之后这个值会比旧任务记住的大。
      const observed = readGeneration()

      const stored: StoredDevice = {
        deviceId: input.deviceId,
        boundUserId: input.boundUserId,
        cloudOrigin: input.cloudOrigin,
        deviceToken: input.deviceToken,
        privateKeyPkcs8: input.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        registeredAt: input.registeredAt
      }
      const plain = JSON.stringify(stored)

      let cipher: Buffer
      try {
        cipher = await box.encrypt(plain)
      } catch {
        return { ok: false, reason: 'write-failed' }
      }

      // 加密是异步的：这里必须**再读一次**代际号，期间可能发生了 forget。
      if (readGeneration() !== observed) return { ok: false, reason: 'stale-generation' }

      const envelope: Envelope = {
        version: 2,
        alg: 'safeStorage-v1',
        generation: observed,
        payload: cipher.toString('base64')
      }
      try {
        mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
        try {
          chmodSync(paths.dir, 0o700)
        } catch {
          /* Windows */
        }
        atomicWrite(paths.devicePath, `${JSON.stringify(envelope, null, 2)}\n`, 0o600)
      } catch {
        return { ok: false, reason: 'write-failed' }
      }
      return { ok: true, generation: observed }
    },

    async forget() {
      try {
        // 顺序不可反：**先**把代际号 +1 落盘，**再**删凭据。
        // 反过来的话，两步之间到达的旧保存会写出旧凭据，而删除随后发生，
        // 表面上没事——但崩溃在删除之前就复活了。
        writeGeneration(readGeneration() + 1)
      } catch {
        return { ok: false, reason: 'write-failed' }
      }
      try {
        rmSync(paths.devicePath, { force: true })
      } catch {
        return { ok: false, reason: 'write-failed' }
      }
      return { ok: true }
    }
  }
}

// MARK: - 非敏感状态（开关 + cloudOrigin）

const stateSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  cloudOrigin: z.string().min(1).max(256)
})
export type RemoteLocalState = z.infer<typeof stateSchema>

export function readRemoteState(paths: DeviceStorePaths): RemoteLocalState {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(paths.statePath, 'utf8')))
    if (parsed.success) return parsed.data
  } catch {
    /* 不存在或坏了：用默认值 */
  }
  return { version: 1, enabled: false, cloudOrigin: DEFAULT_CLOUD_ORIGIN }
}

export function writeRemoteState(paths: DeviceStorePaths, state: RemoteLocalState): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  atomicWrite(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600)
}

/**
 * Cloud Origin 校验。
 *
 * 目的不是「防 DNS 劫持」（TLS 已经做了），而是防**配置串台**：
 * 切换后端之后，绝不能把旧后端的 device_token 发到新后端去——
 * 那是把一份凭据交给一个从未见过它的服务。
 */
export function sameCloudOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

function atomicWrite(path: string, content: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, mode === undefined ? undefined : { mode })
  // Windows 的 rename 不能覆盖已存在文件。
  if (existsSync(path)) rmSync(path, { force: true })
  renameSync(tmp, path)
}
