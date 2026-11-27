/**
 * `verify-release-tag.mjs` 的最小类型声明。
 * 脚本本身是纯 ESM（发布链路不依赖 TS 运行时），单测通过这份声明直接调用。
 */

export type ReleaseTagArg = { version: string; kind: 'desktop' | 'generic' }

export function parseReleaseTagArg(raw: string): ReleaseTagArg | null

export function verifyReleaseTag(options?: {
  pushedTag?: string
  targetTag?: string
  packagePath?: string
}): { ok: boolean; message: string }
