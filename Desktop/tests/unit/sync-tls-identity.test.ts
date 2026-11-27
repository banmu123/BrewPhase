import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { generateIdentity, loadOrCreateIdentity, rotateIdentity } from '../../src/main/sync/tls-identity'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  }
})

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bp-tls-id-'))
  tempDirs.push(dir)
  return dir
}

describe('sync TLS 证书身份', () => {
  it('生成的证书可被 Node X509Certificate 解析（结构合法）', () => {
    const identity = generateIdentity()
    const cert = new X509Certificate(identity.certPem)
    expect(cert.subject).toContain('brewphase-sync')
    expect(cert.issuer).toContain('brewphase-sync')
    // 自签：subject === issuer
    expect(cert.subject).toBe(cert.issuer)
  })

  it('指纹 = 证书 DER 的 SHA-256（与 iOS 端 SHA256(SecCertificateCopyData) 口径一致）', () => {
    const identity = generateIdentity()
    const cert = new X509Certificate(identity.certPem)
    // X509Certificate.raw 即证书 DER——与 iOS 的 SecCertificateCopyData 同一份字节
    const expected = createHash('sha256').update(cert.raw).digest('hex')
    expect(identity.fingerprintHex).toBe(expected)
    expect(identity.fingerprintHex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('TLS 栈接受生成的 PEM（createSecureContext 不抛错）', () => {
    const identity = generateIdentity()
    const context = createSecureContext({ key: identity.keyPem, cert: identity.certPem })
    expect(context).toBeDefined()
  })

  it('证书是 CA:FALSE 的自签叶证书（basicConstraints critical）', () => {
    const identity = generateIdentity()
    const cert = new X509Certificate(identity.certPem)
    expect(cert.ca).toBe(false)
  })

  it('loadOrCreateIdentity：持久化后指纹跨调用稳定，私钥文件 0600（POSIX）', () => {
    const dir = newDir()
    const first = loadOrCreateIdentity(dir)
    const second = loadOrCreateIdentity(dir)
    expect(second.fingerprintHex).toBe(first.fingerprintHex)
    if (process.platform !== 'win32') {
      const keyMode = statSync(join(dir, 'sync-key.pem')).mode & 0o777
      expect(keyMode).toBe(0o600)
    }
  })

  it('rotateIdentity：新指纹 ≠ 旧指纹（轮换语义），旧文件被覆盖', () => {
    const dir = newDir()
    const before = loadOrCreateIdentity(dir)
    const after = rotateIdentity(dir)
    expect(after.fingerprintHex).not.toBe(before.fingerprintHex)
    const reloaded = loadOrCreateIdentity(dir)
    expect(reloaded.fingerprintHex).toBe(after.fingerprintHex)
  })
})
