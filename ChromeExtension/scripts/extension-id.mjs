import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 生成（或复用）开发用的固定 Extension ID。
 *
 * Chrome 的 Load Unpacked 默认按目录路径推导 ID，换机器 / 换路径就变；
 * manifest 里的 `key` 是公钥，可以把 ID 钉死。Native Host 的
 * `allowed_origins` 必须绑定这个 ID，所以它是安装链路的一部分。
 *
 * - 公钥写进 `public/manifest.json` 与 `extension-id.json`（都是公开信息）；
 * - **不生成也不保存私钥**：第一版不打包 .crx / 不发布商店，Load Unpacked 不需要它。
 *   将来发布时重新生成密钥对，并用新 ID 重新注册 Host。
 */

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const idPath = join(root, 'extension-id.json')
const manifestPath = join(root, 'public', 'manifest.json')

function main() {
  const record = existsSync(idPath) ? JSON.parse(readFileSync(idPath, 'utf8')) : null

  let key = record?.key
  let id = record?.id

  if (!key || !id) {
    const { publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    key = publicKey.toString('base64')
    id = extensionIdFromKey(publicKey)
    writeFileSync(idPath, `${JSON.stringify({ key, id }, null, 2)}\n`)
    console.log(`[extension-id] generated ${id}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.key = key
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`[extension-id] ${id}`)
}

/** Chrome：SHA-256(公钥 DER) 前 16 字节，每个半字节映射到 a–p。 */
function extensionIdFromKey(der) {
  const digest = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...digest].map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16))).join('')
}

main()
