import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 构建后校验：dist 必须是一个**自洽**的 MV3 扩展。
 *
 * 这里不跑 Chrome（本机 Chrome 156 已移除 `--load-extension`），而是把
 * Chrome 加载时会检查的东西提前查一遍：
 * - manifest 的 key 能推导出 extension-id.json 里的 ID（否则 Host 白名单失配）；
 * - popup / service worker / 图标都存在；
 * - popup.html 引用的 js/css、service-worker import 的 chunk 都在包里。
 */

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const dist = join(root, 'dist')
const manifestPath = join(dist, 'manifest.json')

if (!existsSync(manifestPath)) {
  console.error('[postbuild] dist/manifest.json is missing; did vite build run?')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const identity = JSON.parse(readFileSync(join(root, 'extension-id.json'), 'utf8'))

if (manifest.key !== identity.key) {
  console.error('[postbuild] manifest key does not match extension-id.json')
  console.error('           run `node scripts/extension-id.mjs` and rebuild')
  process.exit(1)
}

/** Chrome：SHA-256(公钥 DER) 前 16 字节，每个半字节映射 a–p。 */
const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
const derivedId = [...digest].map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16))).join('')
if (derivedId !== identity.id) {
  console.error(`[postbuild] key derives ${derivedId}, expected ${identity.id}`)
  process.exit(1)
}

const missing = []
const requireFile = (relativePath) => {
  if (!relativePath) return
  if (!existsSync(join(dist, relativePath))) missing.push(relativePath)
}

requireFile(manifest.action?.default_popup)
requireFile(manifest.background?.service_worker)
for (const icon of Object.values(manifest.icons ?? {})) requireFile(icon)
for (const icon of Object.values(manifest.action?.default_icon ?? {})) requireFile(icon)

// popup.html 的本地资源
const popup = manifest.action?.default_popup
if (popup && existsSync(join(dist, popup))) {
  const html = readFileSync(join(dist, popup), 'utf8')
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = match[1]
    if (/^(https?:|data:|chrome-extension:|#)/.test(ref)) continue
    requireFile(ref.replace(/^\//, ''))
  }
}

// service worker 的 import（chunk 拆包后必须一起打包）
const worker = manifest.background?.service_worker
if (worker && existsSync(join(dist, worker))) {
  const source = readFileSync(join(dist, worker), 'utf8')
  for (const match of source.matchAll(/from\s*["']([^"']+)["']/g)) {
    const ref = match[1]
    if (!ref.startsWith('.')) continue
    const target = resolve(dist, ref)
    if (!existsSync(target)) missing.push(relative(dist, target))
  }
}

if (missing.length > 0) {
  console.error(`[postbuild] missing referenced files: ${[...new Set(missing)].join(', ')}`)
  process.exit(1)
}

const files = readdirSync(dist, { recursive: true }).length
console.log(`[postbuild] extension id: ${identity.id} (key verified)`)
console.log(`[postbuild] dist ready: ${files} files`)
