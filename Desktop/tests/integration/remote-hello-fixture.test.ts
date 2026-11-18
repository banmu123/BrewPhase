import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto'
import {
  helloSigningPayload,
  signHello,
  encodeRawPublicKey,
  decodeRawPublicKey,
  type HelloSigningInput
} from '../../src/main/remote/device-identity'
import { buildHelloFrame } from '../../src/main/remote/link-client'
import { remoteHelloSchema } from '../../src/shared/contracts/remote'

/**
 * hello v1 的 **golden fixture**（`fixtures/remote-mcp/hello-v1.json`）。
 *
 * ## 为什么这个文件必须存在
 *
 * Cloud 与 Desktop 各有一份 `helloSigningPayload` —— 它们不能共享代码
 * （`cloud/` 是独立发布单元，不能依赖桌面端源码）。而「两端各自测自己的
 * 签名」是**零证据**：两边都自洽、都对同一份错误实现满意时，握手在线上
 * 永远失败，而两边的测试全绿。
 *
 * 所以判据只有一个：**对同一份固定向量得出同一个字节串与同一个签名**。
 * Cloud 的 `tests/link/schemas.test.ts` 读的是同一个文件，断言的是同一个
 * `canonical_payload` 与同一个 `signature_base64url`。
 *
 * 私钥是全 `0x01..0x20` 的测试种子（文件里也写了），绝不用于生产。
 */

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'remote-mcp',
  'hello-v1.json'
)

interface GoldenFixture {
  protocol: string
  private_key: { seed_base64url: string }
  public_key: { base64url: string; spki_der_base64url: string }
  hello: HelloSigningInput & { sig: string }
  canonical_payload: string
  signature_base64url: string
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture

/** 由固定 seed 重建私钥：PKCS8 = 16 字节固定头 + 32 字节 seed。 */
function fixturePrivateKey() {
  const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
  const seed = Buffer.from(fixture.private_key.seed_base64url, 'base64url')
  expect(seed).toHaveLength(32)
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
}

const { sig: _sig, ...signingInput } = fixture.hello

describe('hello v1 golden fixture（与 Cloud 共用）', () => {
  it('Desktop 的规范串逐字节等于 fixture', () => {
    expect(helloSigningPayload(signingInput).toString('utf8')).toBe(fixture.canonical_payload)
  })

  it('Desktop 用同一把私钥签出同一个签名（Ed25519 确定性）', () => {
    expect(signHello(fixturePrivateKey(), signingInput)).toBe(fixture.signature_base64url)
  })

  it('fixture 的 sig 与 signature_base64url 是同一个值（防止文件内部自相矛盾）', () => {
    expect(fixture.hello.sig).toBe(fixture.signature_base64url)
  })

  it('裸公钥 ↔ SPKI 的互相转换与 fixture 一致', () => {
    const spki = Buffer.from(fixture.public_key.spki_der_base64url, 'base64url')
    expect(spki).toHaveLength(44)
    // 裸 32 字节（Cloud 存的就是这个）
    expect(spki.subarray(12).toString('base64url')).toBe(fixture.public_key.base64url)

    // Desktop 侧两个转换函数
    const key = decodeRawPublicKey(fixture.public_key.base64url)
    expect(key.asymmetricKeyType).toBe('ed25519')
    expect(encodeRawPublicKey(key)).toBe(fixture.public_key.base64url)
  })

  it('fixture 能被 Desktop 自己的 hello schema 接受（闭合键集）', () => {
    const parsed = remoteHelloSchema.safeParse(fixture.hello)
    expect(parsed.success).toBe(true)
  })

  it('buildHelloFrame 产出的帧结构能被 fixture 的字段集解释（无多余键）', () => {
    // 注意 buildHelloFrame 收的是 **camelCase** 的构造参数，产出的是 snake_case 的线上帧。
    // 这里刻意走这条真实构造函数，而不是手写一个 JSON：手写只能证明「我会打字」。
    const frame = JSON.parse(
      buildHelloFrame({
        ts: signingInput.ts,
        deviceId: signingInput.device_id,
        nonce: signingInput.nonce,
        minVersion: signingInput.min_version,
        maxVersion: signingInput.max_version,
        appVersion: signingInput.app_version,
        platform: signingInput.platform,
        capabilities: signingInput.capabilities,
        serviceable: signingInput.serviceable,
        sig: fixture.signature_base64url
      })
    ) as Record<string, unknown>
    expect(Object.keys(frame).sort()).toEqual(Object.keys(fixture.hello).sort())
    expect(frame.sig).toBe(fixture.signature_base64url)
    // 逐字段相等 → 构造出的帧就是 fixture 那一帧
    expect(frame).toEqual(fixture.hello)
  })

  it('改动任意一个被签字段都会让签名失效（端到端验一遍覆盖面）', () => {
    const privateKey = fixturePrivateKey()
    const publicKey = createPublicKey(privateKey)
    const original = Buffer.from(fixture.canonical_payload, 'utf8')
    const mutations: Array<Partial<HelloSigningInput>> = [
      { ts: fixture.hello.ts + 1 },
      { device_id: 'another-device' },
      { nonce: 'AAAAAAAAAAAAAAAAAAAAAA' },
      { min_version: 2 },
      { max_version: 2 },
      { app_version: '9.9.9' },
      { platform: 'win32' },
      { capabilities: ['cancel'] },
      { serviceable: false }
    ]

    for (const mutation of mutations) {
      const payload = helloSigningPayload({ ...signingInput, ...mutation })
      expect(payload.equals(original), `${Object.keys(mutation)[0]} 必须进签名`).toBe(false)

      // 用旧签名验证新内容 → 必须失败
      const { verify } = require('node:crypto') as typeof import('node:crypto')
      const ok = verify(null, payload, publicKey, Buffer.from(fixture.signature_base64url, 'base64url'))
      expect(ok, `${Object.keys(mutation)[0]} 被改动后旧签名仍通过`).toBe(false)
    }
  })

  it('签名本身是 64 字节 base64url（Cloud 侧会按严格长度校验）', () => {
    const sig = Buffer.from(fixture.signature_base64url, 'base64url')
    expect(sig).toHaveLength(64)
    expect(sig.toString('base64url')).toBe(fixture.signature_base64url)
  })

  it('capabilities 的书写顺序不影响规范串（两端都要排序后连接）', () => {
    const reordered = { ...signingInput, capabilities: ['tools.call', 'cancel', 'drain'] }
    expect(helloSigningPayload(reordered).toString('utf8')).toBe(fixture.canonical_payload)
    // 而签名结果也必须相同
    expect(signHello(fixturePrivateKey(), reordered)).toBe(fixture.signature_base64url)
  })

  it('私钥唯一地对应 fixture 的公钥（防止两边用了不同的密钥）', () => {
    const spki = createPublicKey(fixturePrivateKey()).export({ type: 'spki', format: 'der' })
    expect(spki.subarray(12).toString('base64url')).toBe(fixture.public_key.base64url)
    expect(cryptoSign(null, Buffer.from(fixture.canonical_payload), fixturePrivateKey()).length).toBe(64)
  })
})
