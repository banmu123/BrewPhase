import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
  type KeyObject
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 局域网同步服务的**证书身份**（TLS 改造，协议 v2）。
 *
 * 安全模型（与 docs/SYNC_PROTOCOL.md §0 对应）：
 * - 桌面端首次启用同步时生成 **ECDSA P-256 自签证书**，私钥只存本机
 *   userData 目录（0600，Windows 靠用户目录 ACL）；
 * - 证书身份 = **leaf 证书 SPKI 的 SHA-256 指纹**（hex，小写）；
 * - 指纹通过**配对二维码**交给 iOS（用户面对面扫码 = 带外信任），iOS 存
 *   Keychain 并对之后每一次 TLS 连接做 SPKI pinning；
 * - 指纹不匹配 → 连接必须拒绝，**不存在明文回退**（服务端只监听 TLS）；
 * - 重新配对会重新交付当前指纹（证书轮换后旧指纹失效，两端重新配对即可）。
 *
 * 为什么手写 DER：Node 没有内置 X.509 签发 API；为不引入第三方依赖
 * （forge 等会拉进整棵依赖树），这里实现最小 ASN.1 DER 编码器，只编码
 * 自签证书需要的结构。所有输入都是本文件内的常量或 CSPRNG 输出。
 */

export type SyncTlsIdentity = {
  /** PEM 编码证书（单张 leaf）。 */
  certPem: string
  /** PEM 编码私钥（PKCS#8）。 */
  keyPem: string
  /** leaf 证书 SPKI 的 SHA-256（hex 小写）——二维码与 iOS pinning 使用的身份。 */
  fingerprintHex: string
}

const CERT_FILE = 'sync-cert.pem'
const KEY_FILE = 'sync-key.pem'

// DER 编码 ------------------------------------------------------------------

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let value = length
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value = Math.floor(value / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

function derSequence(...parts: Buffer[]): Buffer {
  return derTlv(0x30, Buffer.concat(parts))
}

function derIntegerSmall(value: number): Buffer {
  if (value === 0) return derTlv(0x02, Buffer.from([0]))
  const bytes: number[] = []
  let v = value
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  if (bytes[0]! >= 0x80) bytes.unshift(0)
  return derTlv(0x02, Buffer.from(bytes))
}

/** DER 正整数（Buffer 形式，保证非负：高位为 1 时补 0x00）。 */
function derIntegerBuffer(value: Buffer): Buffer {
  const padded = value.length > 0 && value[0]! >= 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value
  return derTlv(0x02, padded)
}

/** OID 点分十进制 → DER 内容字节（base-128 变长，首字节编码前两段）。 */
function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number)
  const bytes: number[] = [parts[0]! * 40 + parts[1]!]
  for (const part of parts.slice(2)) {
    if (part < 0x80) {
      bytes.push(part)
      continue
    }
    const stack: number[] = []
    let v = part
    while (v > 0) {
      stack.unshift(v & 0x7f)
      v >>= 7
    }
    for (let index = 0; index < stack.length - 1; index += 1) {
      bytes.push(stack[index]! | 0x80)
    }
    bytes.push(stack[stack.length - 1]!)
  }
  return derTlv(0x06, Buffer.from(bytes))
}

function derBitString(content: Buffer): Buffer {
  // unused bits = 0
  return derTlv(0x03, Buffer.concat([Buffer.from([0]), content]))
}

function derUtf8(value: string): Buffer {
  return derTlv(0x0c, Buffer.from(value, 'utf8'))
}

function derUtcTime(date: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const yy = date.getUTCFullYear() % 100
  const text = `${pad(yy)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  return derTlv(0x17, Buffer.from(text, 'ascii'))
}

function derContextTag(tagNumber: number, content: Buffer): Buffer {
  return derTlv(0xa0 | tagNumber, content)
}

// OID 常量 ------------------------------------------------------------------

const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1'
const OID_EC_P256 = '1.2.840.10045.3.1.7'
const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2'
const OID_COMMON_NAME = '2.5.4.3'
const OID_BASIC_CONSTRAINTS = '2.5.29.19'

// 证书构造 ------------------------------------------------------------------

/** 从 Node 生成的 SPKI DER 里抽出 subjectPublicKey 的未压缩点（04||X||Y）。 */
function extractEcPoint(spkiDer: Buffer): Buffer {
  const walk = (buffer: Buffer, offset: number, end: number, wantLastBit: boolean): Buffer | null => {
    let cursor = offset
    let lastBit: Buffer | null = null
    while (cursor < end) {
      const tag = buffer[cursor]!
      cursor += 1
      let length = buffer[cursor]!
      cursor += 1
      if (length & 0x80) {
        const lenBytes = length & 0x7f
        length = 0
        for (let index = 0; index < lenBytes; index += 1) {
          length = (length << 8) | buffer[cursor]!
          cursor += 1
        }
      }
      if (tag === 0x03 && wantLastBit) {
        // BIT STRING：首字节 unused bits
        return buffer.subarray(cursor + 1, cursor + length)
      }
      if ((tag & 0x20) !== 0) {
        // 构造类型（SEQUENCE / SET / context tag）：递归进去
        const found = walk(buffer, cursor, cursor + length, wantLastBit)
        if (found) return found
      }
      cursor += length
    }
    return lastBit
  }
  const point = walk(spkiDer, 0, spkiDer.length, true)
  if (!point) throw new Error('SPKI 中找不到 EC 公钥点')
  return point
}

function ecPublicKeyInfo(publicKey: KeyObject): Buffer {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const point = extractEcPoint(spkiDer)
  const algorithm = derSequence(derOid(OID_EC_PUBLIC_KEY), derOid(OID_EC_P256))
  return derSequence(algorithm, derBitString(point))
}

function commonName(value: string): Buffer {
  const atv = derSequence(derOid(OID_COMMON_NAME), derUtf8(value))
  return derSequence(derTlv(0x31, atv))
}

/** 序列号：随机 16 字节（DER 正整数；derIntegerBuffer 负责非负填充）。 */
function randomSerial(): Buffer {
  return derIntegerBuffer(randomBytes(16))
}

/** 生成自签证书 DER（ECDSA P-256 + SHA256，10 年有效期，CN=brewphase-sync）。 */
function selfSignedCertDer(publicKey: KeyObject, privateKey: KeyObject, now: Date): Buffer {
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000) // 时钟偏差容忍
  const notAfter = new Date(now.getTime() + 10 * 365 * 24 * 3600 * 1000)
  const serial = derIntegerBuffer(randomSerial())
  const signatureAlgorithm = derSequence(derOid(OID_ECDSA_WITH_SHA256))
  const issuer = commonName('brewphase-sync')
  const validity = derSequence(derUtcTime(notBefore), derUtcTime(notAfter))
  const subject = commonName('brewphase-sync')
  const spki = ecPublicKeyInfo(publicKey)

  // 扩展：basicConstraints critical CA:FALSE（这张证书不能当 CA 签发）
  const basicConstraints = derSequence(
    derOid(OID_BASIC_CONSTRAINTS),
    derTlv(0x01, Buffer.from([0])), // critical = TRUE
    derTlv(0x04, derSequence())
  )
  const extensions = derContextTag(3, derSequence(basicConstraints))

  const tbs = derSequence(
    derContextTag(0, derIntegerSmall(2)), // version v3
    serial,
    signatureAlgorithm,
    issuer,
    validity,
    subject,
    spki,
    extensions
  )

  const signature = createSign('sha256').update(tbs).sign(privateKey)
  return derSequence(tbs, signatureAlgorithm, derBitString(signature))
}

// 指纹与持久化 --------------------------------------------------------------

/**
 * leaf 证书 PEM → 证书 DER 的 SHA-256（hex 小写）。
 * 口径与 iOS 端对齐：iOS 侧 `SHA256(SecCertificateCopyData(leaf))`（整个
 * 证书 DER）；Node 侧用 `X509Certificate.raw`（同一份 DER）。证书轮换
 * （新密钥对重签）必然改变指纹，与轮换语义一致。
 */
export function fingerprintOfCertPem(certPem: string): string {
  const cert = new X509Certificate(certPem)
  return createHash('sha256').update(cert.raw).digest('hex')
}

function toPem(label: string, der: Buffer): string {
  const base64 = der.toString('base64')
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/** 生成新的证书身份（ECDSA P-256，10 年有效期）。 */
export function generateIdentity(): SyncTlsIdentity {
  const now = new Date()
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const certDer = selfSignedCertDer(publicKey, privateKey, now)
  const certPem = toPem('CERTIFICATE', certDer)
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  return { certPem, keyPem, fingerprintHex: fingerprintOfCertPem(certPem) }
}

/**
 * 加载或创建证书身份。文件位于 `<dataDir>/sync-cert.pem` / `sync-key.pem`；
 * 已存在则直接加载（指纹跨启动稳定，已配对设备不受重启影响）。
 */
export function loadOrCreateIdentity(dataDir: string): SyncTlsIdentity {
  const certPath = join(dataDir, CERT_FILE)
  const keyPath = join(dataDir, KEY_FILE)
  if (existsSync(certPath) && existsSync(keyPath)) {
    const certPem = readFileSync(certPath, 'utf8')
    const keyPem = readFileSync(keyPath, 'utf8')
    // 从 PEM 抽 DER 算指纹（PEM base64 解码即 DER）
    const certBase64 = certPem
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('-----'))
      .join('')
    const certDer = Buffer.from(certBase64, 'base64')
    return { certPem, keyPem, fingerprintHex: fingerprintOfCertPem(certPem) }
  }
  const identity = generateIdentity()
  mkdirSync(dataDir, { recursive: true })
  // 0600：Node 的 writeFileSync 在 Windows 上 mode 仅只读位生效；用户目录
  // ACL 兜底（与 sync DB / bridge-info.json 同一威胁模型）。
  writeFileSync(join(dataDir, CERT_FILE), identity.certPem, { mode: 0o600 })
  writeFileSync(keyPath, identity.keyPem, { mode: 0o600 })
  return identity
}

/** 证书轮换：生成新身份并覆盖旧文件，返回新身份（调用方负责重启 server）。 */
export function rotateIdentity(dataDir: string): SyncTlsIdentity {
  const identity = generateIdentity()
  writeFileSync(join(dataDir, CERT_FILE), identity.certPem, { mode: 0o600 })
  writeFileSync(join(dataDir, KEY_FILE), identity.keyPem, { mode: 0o600 })
  return identity
}
