import { describe, expect, it } from 'vitest'
import {
  JOURNEY_METADATA_MAX,
  JOURNEY_TEXT_LIMITS,
  TRUNCATION_MARKER,
  exceedsLimit,
  redactDeep,
  redactSecrets,
  sanitizeJourneyContent
} from '../../src/main/application/agent-journey/sanitize'

/**
 * 内容脱敏与限幅（R6-1 §19.3 / 任务 §五.6）。
 *
 * 三条要守住的性质：
 * 1. **已知凭证形态必须消失**——库里不能出现原值；
 * 2. **不过度过滤**——普通技术文本、中文、正常代码必须原样可读；
 * 3. **超长必须显式截断**——不能静默丢尾部，也不能把凭证从中间切断。
 *
 * 这里刻意**不**断言「不可能泄漏任何未知凭证」：正则是已知形态黑名单，
 * 不是绝对保证（见 sanitize.ts 头注）。
 */

describe('已知凭证形态被脱敏', () => {
  it('口令键值（password / secret / token / api_key / cookie / private_key）', () => {
    const cases: Array<[string, string]> = [
      ['password=Sup3rS3cret!', 'Sup3rS3cret!'],
      ['db_password: hunter2', 'hunter2'],
      ['api_key = "sk_live_abc123"', 'sk_live_abc123'],
      ['client_secret: "ghs_XXXXXXXXXXXXXXXXXXXX"', 'ghs_XXXXXXXXXXXXXXXXXXXX'],
      ['cookie: sid=abcdef123456', 'abcdef123456'],
      ['private_key: -----BEGIN-ish', 'BEGIN-ish'],
      ['Authorization: Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
      ['POSTGRES_PASSWORD=7c1f0b9d4e2a6835fa91c0d7e5b32468', '7c1f0b9d4e2a6835fa91c0d7e5b32468'],
      ['MY_SECRET_TOKEN=zzz', 'zzz']
    ]
    for (const [input, secret] of cases) {
      const out = redactSecrets(input)
      expect(out, input).not.toContain(secret)
      expect(out, input).toContain('[redacted]')
    }
  })

  it('PEM 私钥块整体消失（含 RSA / OPENSSH 变体）', () => {
    const rsa = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAyummy+private+material',
      '-----END RSA PRIVATE KEY-----'
    ].join('\n')
    const out = redactSecrets(`key below:\n${rsa}\ndone`)
    expect(out).not.toContain('MIIEpAIBAAKCAQEAyummy')
    expect(out).toContain('[redacted:private-key]')
    expect(out).toContain('done')
  })

  it('JWT 与 AWS 访问键', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    expect(redactSecrets(`token ${jwt}`)).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(redactSecrets(`token ${jwt}`)).toContain('[redacted:jwt]')

    expect(redactSecrets('aws_key=AKIAIOSFODNN7EXAMPLE')).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(redactSecrets('aws_key=AKIAIOSFODNN7EXAMPLE')).toContain('[redacted:aws-key]')
  })

  it('BREWPHASE_MCP_TOKEN 与 bp_mcp_* 形态', () => {
    expect(redactSecrets('BREWPHASE_MCP_TOKEN=bp_mcp_AbCdEfGhIjKlMnOpQrStUvWx')).not.toContain(
      'bp_mcp_AbCdEfGhIjKlMnOpQrStUvWx'
    )
    expect(redactSecrets('header bp_mcp_ZzYyXxWwVvUuTtSsRrQq')).not.toContain(
      'bp_mcp_ZzYyXxWwVvUuTtSsRrQq'
    )
  })

  it('带用户名的绝对路径被替换，路径本身保留', () => {
    expect(redactSecrets('open /Users/banmu/Brew/phase.db')).toBe('open /Users/<user>/Brew/phase.db')
    expect(redactSecrets('cd /home/alice/projects/x')).toBe('cd /home/<user>/projects/x')
    expect(redactSecrets('C:\\Users\\bob\\data.db')).toBe('C:\\Users\\<user>\\data.db')
  })
})

describe('不过度过滤', () => {
  it('普通技术文本、中文与正常代码原样可读', () => {
    const code = [
      'export async function fetchRecords(limit: number) {',
      '  const rows = await db.select().from(records).limit(limit)',
      '  return rows.map((row) => row.id)',
      '}'
    ].join('\n')
    expect(sanitizeJourneyContent(code, { max: JOURNEY_TEXT_LIMITS.content })).toBe(code)

    const chinese = '这次配对失败的原因是确认码输错了，不是网络问题；重试一次即可。'
    expect(sanitizeJourneyContent(chinese, { max: JOURNEY_TEXT_LIMITS.summary })).toBe(chinese)

    const prose = 'The password policy requires twelve characters and one symbol.'
    expect(sanitizeJourneyContent(prose, { max: JOURNEY_TEXT_LIMITS.summary })).toBe(prose)

    const cmd = 'docker compose --env-file .env.production up -d'
    expect(sanitizeJourneyContent(cmd, { max: JOURNEY_TEXT_LIMITS.content })).toBe(cmd)
  })
})

describe('限幅', () => {
  it('超长正文用 …[truncated] 明确标记，且总长不超过上限', () => {
    const long = 'a'.repeat(JOURNEY_TEXT_LIMITS.content + 5_000)
    const out = sanitizeJourneyContent(long, { max: JOURNEY_TEXT_LIMITS.content })
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(out.length).toBeLessThanOrEqual(JOURNEY_TEXT_LIMITS.content)
    expect(exceedsLimit(out, 'content')).toBe(false)
  })

  it('先脱敏后截断：长凭证不会被从中间切断留下半截', () => {
    const padding = 'x'.repeat(600)
    const secret = 'password=' + 'S'.repeat(300)
    const out = sanitizeJourneyContent(padding + secret, { max: 500 })
    expect(out).not.toContain('SSSSSSSSSS')
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(out.length).toBeLessThanOrEqual(500)
  })

  it('各字段上限与常量表一致', () => {
    expect(JOURNEY_TEXT_LIMITS.title).toBe(200)
    expect(JOURNEY_TEXT_LIMITS.summary).toBe(2_000)
    expect(JOURNEY_TEXT_LIMITS.content).toBe(20_000)
    expect(JOURNEY_TEXT_LIMITS.reason).toBe(2_000)
    expect(sanitizeJourneyContent('t'.repeat(300), { max: JOURNEY_TEXT_LIMITS.title }).length).toBeLessThanOrEqual(
      JOURNEY_TEXT_LIMITS.title
    )
  })
})

describe('metadata 递归脱敏', () => {
  it('只改叶子字符串，重新序列化仍是合法 JSON', () => {
    const meta = {
      command: 'psql',
      env: { POSTGRES_PASSWORD: 'raw-value-should-go', note: 'safe' },
      lines: ['token=abc123456', 'plain line']
    }
    const out = redactDeep(meta)
    const json = JSON.stringify(out)
    expect(() => JSON.parse(json)).not.toThrow()
    expect(json).not.toContain('raw-value-should-go')
    expect(json).not.toContain('abc123456')
    expect(json).toContain('safe')
    expect(json).toContain('plain line')
  })

  it('metadata 上限是 4000（Service 据此拒绝，而不是截断坏 JSON）', () => {
    expect(JOURNEY_METADATA_MAX).toBe(4_000)
  })
})
