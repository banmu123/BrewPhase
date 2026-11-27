import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseReleaseTag } from '../../src/shared/contracts/update'
import { parseReleaseTagArg } from '../../scripts/verify-release-tag.mjs'

/**
 * `scripts/verify-release-tag.mjs` 是发布工作流的版本闸门：
 * 目标 Release tag 的版本必须等于 Desktop/package.json 的 version。
 *
 * 这里用真实子进程跑它（退出码就是工作流看到的结果），而不是只测内部函数——
 * 发布链路出错的方式通常是「脚本没被调用 / 参数没传进去」，那类问题只有
 * 跑入口才能发现。
 */

const SCRIPT = join(process.cwd(), 'scripts', 'verify-release-tag.mjs')

type RunResult = { code: number | null; stdout: string; stderr: string }

function run(args: string[]): RunResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function currentPackageVersion(): string {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version as string
}

let tempDir = ''
let pkg020 = ''
let pkg021 = ''
let pkgBroken = ''

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bp-release-tag-'))
  pkg020 = join(tempDir, 'package-0.2.0.json')
  pkg021 = join(tempDir, 'package-0.2.1.json')
  pkgBroken = join(tempDir, 'package-broken.json')
  writeFileSync(pkg020, JSON.stringify({ name: 'brewphase-desktop', version: '0.2.0' }))
  writeFileSync(pkg021, JSON.stringify({ name: 'brewphase-desktop', version: '0.2.1' }))
  writeFileSync(pkgBroken, '{ not json')
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('verify-release-tag: 手动触发（workflow_dispatch）', () => {
  it('不填 release_tag：只构建，直接放行', () => {
    const result = run(['--pushed', '', '--target', ''])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('build-only')
  })

  it('补发 desktop-v0.2.1，package.json 为 0.2.1 时通过', () => {
    const result = run(['--target', 'desktop-v0.2.1', '--package', pkg021])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('desktop-v0.2.1')
    expect(result.stdout).toContain('0.2.1')
  })

  it('补发历史写法 v0.2.0，package.json 为 0.2.0 时通过', () => {
    const result = run(['--target', 'v0.2.0', '--package', pkg020])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('generic')
  })

  it('目标 tag 与当前 package.json 不一致时失败，且说明不支持旧版本补发', () => {
    const result = run(['--target', 'desktop-v0.2.1', '--package', pkg020])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('::error::')
    expect(result.stderr).toContain('0.2.1')
    expect(result.stderr).toContain('0.2.0')
    expect(result.stderr).toContain('不支持')
    // 失败时不能给出任何「可以上传」的信号。
    expect(result.stdout).toBe('')
  })

  it('默认读取仓库当前的 package.json（未显式指定 --package）', () => {
    const result = run(['--target', `desktop-v${currentPackageVersion()}`])
    expect(result.code).toBe(0)
  })
})

describe('verify-release-tag: tag 推送', () => {
  it('--pushed 走同一条校验', () => {
    expect(run(['--pushed', 'desktop-v0.2.1', '--package', pkg021]).code).toBe(0)
    expect(run(['--pushed', 'desktop-v0.2.1', '--package', pkg020]).code).toBe(1)
  })

  it('手动补发与 tag 推送同时给出时以 --target 为准', () => {
    // dispatch 只会在分支 ref 上跑，pushed 为空；这里固定住优先级，避免歧义。
    expect(run(['--pushed', 'desktop-v0.2.0', '--target', 'desktop-v0.2.1', '--package', pkg021]).code).toBe(0)
    expect(run(['--pushed', 'desktop-v0.2.1', '--target', 'desktop-v0.2.0', '--package', pkg020]).code).toBe(0)
  })
})

describe('verify-release-tag: 非法输入', () => {
  it('非 Desktop tag（ios-v1.1）失败', () => {
    const result = run(['--target', 'ios-v1.1', '--package', pkg020])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('不是可识别的 Desktop Release tag')
  })

  it('带预发布后缀的 tag 失败', () => {
    expect(run(['--target', 'desktop-v0.2.1-beta', '--package', pkg021]).code).toBe(1)
    expect(run(['--target', 'v0.2.1-rc.1', '--package', pkg021]).code).toBe(1)
  })

  it('--target 缺少值时报用法错误，不静默降级为「只构建」', () => {
    const result = run(['--target'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('requires a value')
  })

  it('package.json 缺失或损坏时失败', () => {
    expect(run(['--target', 'desktop-v0.2.1', '--package', join(tempDir, 'nope.json')]).code).toBe(1)
    expect(run(['--target', 'desktop-v0.2.1', '--package', pkgBroken]).code).toBe(1)
  })
})

describe('脚本与 shared 契约的 tag 语法一致', () => {
  it('parseReleaseTagArg 与 parseReleaseTag 逐条对拍', () => {
    const tags = [
      'desktop-v0.1.0',
      'desktop-v0.1.4',
      'v0.2.0',
      'desktop-v0.2.1',
      'v1',
      'desktop-v1.10.0',
      'desktop-v0.1.2-beta',
      'v0.2.0-rc.1',
      'ios-v1.1',
      'v',
      'desktop-v',
      ''
    ]
    for (const tag of tags) {
      const shared = parseReleaseTag(tag)
      const script = parseReleaseTagArg(tag)
      expect(script?.version ?? null, `version for ${JSON.stringify(tag)}`).toBe(shared?.version ?? null)
      expect(script?.kind ?? null, `kind for ${JSON.stringify(tag)}`).toBe(shared?.kind ?? null)
    }
  })
})

/**
 * 工作流接线本身也要盯住：脚本再正确，只要 YAML 里没把目标 tag 传进去，
 * 手动补发的校验就会静默退化成「只构建」——而那正是本阶段要堵的绕过。
 * 这类退化在本地跑不出来，只能断言配置本身。
 */
describe('发布工作流接线', () => {
  const workflow = readFileSync(
    join(process.cwd(), '..', '.github', 'workflows', 'desktop-release.yml'),
    'utf8'
  )

  it('校验步骤同时接收 tag 推送与手动补发的目标 tag', () => {
    expect(workflow).toMatch(/node\s+scripts\/verify-release-tag\.mjs/)
    expect(workflow).toMatch(/PUSHED_TAG:\s*\$\{\{\s*github\.ref_type/)
    expect(workflow).toMatch(/TARGET_RELEASE_TAG:\s*\$\{\{\s*inputs\.release_tag\s*\}\}/)
    expect(workflow).toMatch(/--pushed\s+"?\$\{?PUSHED_TAG/)
    expect(workflow).toMatch(/--target\s+"?\$\{?TARGET_RELEASE_TAG/)
  })

  it('校验排在打包与上传之前（同一构建作业内）', () => {
    const verifyAt = workflow.indexOf('Verify release tag matches package.json version')
    const packageAt = workflow.indexOf('Package macOS')
    const uploadAt = workflow.indexOf('Upload to existing release (manual)')
    expect(verifyAt).toBeGreaterThan(0)
    expect(verifyAt).toBeLessThan(packageAt)
    expect(verifyAt).toBeLessThan(uploadAt)
  })
})
