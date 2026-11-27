#!/usr/bin/env node
/**
 * 发布前的版本闸门：**目标 Release tag 必须与 Desktop/package.json 的 version 一致**。
 *
 * 为什么必须拦：安装包文件名是 `BrewPhase-${version}-${os}-${arch}.${ext}`，
 * 其中 version 来自 package.json；而客户端（Desktop/src/shared/contracts/update.ts）
 * 是按 Release tag 的版本去找这个文件名。两者不一致时 Release 能发出去，
 * 但所有客户端都会看到「已是最新」——这类错配没有报错、只有沉默的失效。
 *
 * 三种入口，行为不同：
 * - tag 推送：`--pushed desktop-v0.2.1`；
 * - 手动补发：`--target desktop-v0.2.1`（要上传资产的那个已有 Release）；
 * - 手动触发但只产出 artifacts：两个都不给 → 直接放行（没有目标 tag 要校验）。
 *
 * 明确**不支持**「拿当前代码给旧版本补发资产」：版本对不上就是失败，
 * 不要用关闭校验的方式绕过，回到该 tag 对应的提交重跑。
 *
 * 注意：tag 解析与 `shared/contracts/update.ts` 的 `parseReleaseTag` 是同一套
 * 语法（单测里逐条对拍）。这里刻意不 import TS 源码——发布链路不该依赖
 * Node 的实验性类型擦除。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE =
  'usage: node scripts/verify-release-tag.mjs [--pushed <tag>] [--target <tag>] [--package <path>]'

/** 旧写法 `desktop-vX.Y.Z` 与 0.2.0 用的 `vX.Y.Z`；带预发布后缀的一律不认。 */
const TAG_PATTERN = /^(desktop-)?v(\d+(?:\.\d+)*)$/
const VERSION_PATTERN = /^\d+(?:\.\d+)*$/

/** tag → 版本号 + 写法；不是 Desktop Release tag 时返回 null。 */
export function parseReleaseTagArg(raw) {
  const tag = typeof raw === 'string' ? raw.trim() : ''
  const match = TAG_PATTERN.exec(tag)
  if (!match) return null
  return { version: match[2], kind: match[1] ? 'desktop' : 'generic' }
}

function parseArgs(argv) {
  const options = { pushed: '', target: '', packagePath: './package.json' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') {
      options.help = true
      continue
    }
    if (flag !== '--pushed' && flag !== '--target' && flag !== '--package') {
      throw new Error(`unknown argument: ${flag}\n${USAGE}`)
    }
    const value = argv[i + 1]
    // 缺值必须报错：把 `--target` 当成空串会静默退化成「只构建」，
    // 那正好是这道闸门要防的绕过。
    if (typeof value !== 'string') throw new Error(`${flag} requires a value\n${USAGE}`)
    i += 1
    if (flag === '--pushed') options.pushed = value
    else if (flag === '--target') options.target = value
    else options.packagePath = value
  }
  return options
}

function readPackageVersion(packagePath) {
  let raw
  try {
    raw = readFileSync(packagePath, 'utf8')
  } catch (error) {
    return { error: `读取 ${packagePath} 失败：${error instanceof Error ? error.message : error}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: `${packagePath} 不是合法 JSON` }
  }
  const version = typeof parsed?.version === 'string' ? parsed.version.trim() : ''
  if (!VERSION_PATTERN.test(version)) {
    return { error: `${packagePath} 的 version 不是 x.y.z 形式：${JSON.stringify(parsed?.version)}` }
  }
  return { version }
}

/**
 * 校验主逻辑（纯函数，便于单测直接调用）。
 * 返回 `{ ok, message }`，由 CLI 决定退出码与 `::error::` 注解。
 */
export function verifyReleaseTag(rawOptions) {
  const targetTag = typeof rawOptions?.targetTag === 'string' ? rawOptions.targetTag.trim() : ''
  const pushedTag = typeof rawOptions?.pushedTag === 'string' ? rawOptions.pushedTag.trim() : ''
  const packagePath = rawOptions?.packagePath ?? './package.json'

  // 手动触发但不填 release_tag：只产出 artifacts，没有目标 tag。
  const tag = targetTag || pushedTag
  if (!tag) {
    return { ok: true, message: 'no target tag: build-only run, nothing to verify' }
  }

  const parsed = parseReleaseTagArg(tag)
  if (!parsed) {
    return {
      ok: false,
      message:
        `不是可识别的 Desktop Release tag：${tag}。` +
        '只接受 desktop-vX.Y.Z 或历史写法 vX.Y.Z（不带预发布后缀）。'
    }
  }

  const { version, error } = readPackageVersion(packagePath)
  if (error) return { ok: false, message: error }

  if (version !== parsed.version) {
    return {
      ok: false,
      message:
        `tag ${tag} 的版本 ${parsed.version} 与 ${packagePath} 的 version ${version} 不一致。` +
        '安装包文件名取自 package.json，客户端却按 tag 版本匹配安装包，' +
        '放行只会得到「发布成功但没人能更新」。' +
        '本工作流只支持从与目标 Tag 同版本的提交构建，**不支持**用当前代码给旧版本补发资产；' +
        '请切到该 Tag 对应的提交后重跑，或先提升 package.json 并重新发布。'
    }
  }

  return { ok: true, message: `tag ${tag} (${parsed.kind}) matches ${packagePath} version ${version}` }
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const result = verifyReleaseTag({
    pushedTag: options.pushed,
    targetTag: options.target,
    packagePath: options.packagePath
  })
  if (!result.ok) {
    console.error(`::error::${result.message}`)
    return 1
  }
  console.log(`OK: ${result.message}`)
  return 0
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}
