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

  it('metadata 上限是 16000（R6-4.2 预算；仍拒绝而非截断坏 JSON）', () => {
    // 4_000 装不下「3 个文件各自完整修改记录 + 决策 + 验证」，
    // 所以按字段上限推算后提到 16_000——见 sanitize.ts 的预算注释。
    expect(JOURNEY_METADATA_MAX).toBe(16_000)
  })

  it('预算边界：等于上限算通过，超 1 字符即超限（判定是长度比较，不是截断）', () => {
    // Service 的 serializeMetadata 就是 `json.length > JOURNEY_METADATA_MAX → 抛错`，
    // 这里把那条判定复刻一遍，锁住「拒绝而非截断」的语义：
    // 超限时拿到的仍是完整字符串，不会被裁成解析不了的半截 JSON。
    // JSON.stringify 会给这个形状加上固定外壳（`{"blob":""}` = 12 字符），
    // 先量出来再算，别把外壳长度写死在断言里。
    const overhead = JSON.stringify({ blob: '' }).length
    const make = (blobLength: number) => JSON.stringify({ blob: 'x'.repeat(blobLength) })
    const atLimit = make(JOURNEY_METADATA_MAX - overhead)
    const overLimit = make(JOURNEY_METADATA_MAX - overhead + 1)
    const isOver = (json: string) => json.length > JOURNEY_METADATA_MAX

    expect(atLimit.length).toBe(JOURNEY_METADATA_MAX)
    expect(isOver(atLimit)).toBe(false)
    expect(isOver(overLimit)).toBe(true)
    // 关键：被判定超限的字符串仍然是完整可解析的 JSON（没有被截断）
    expect(() => JSON.parse(overLimit)).not.toThrow()
    expect(JSON.parse(overLimit).blob).toHaveLength(JOURNEY_METADATA_MAX - overhead + 1)
  })
})

describe('metadata：敏感父级整棵子树被替换（不许靠子键名漏网）', () => {
  const SECRET = 'plain-secret-value-abc123'

  it('1) 敏感父级对象下的普通字符串字段被整块替换', () => {
    const out = redactDeep({ authorization: { scheme: 'Bearer', value: SECRET } })
    // 注意子键是 `value` / `scheme`——它们本身**不**含敏感词，
    // 只有「整棵子树替换」这条规则能挡住。
    expect(out).toEqual({ authorization: '[redacted]' })
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })

  it('2) 敏感父级下的多层嵌套对象同样整块替换', () => {
    const out = redactDeep({ client_secret: { outer: { inner: { deeper: SECRET } } } })
    expect(out).toEqual({ client_secret: '[redacted]' })
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })

  it('3) 敏感父级数组整块替换', () => {
    const out = redactDeep({ tokens: ['first', SECRET, 'third'] })
    expect(out).toEqual({ tokens: '[redacted]' })
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })

  it('4) 敏感对象内部包含数组也整块替换', () => {
    const out = redactDeep({ credentials: { list: [SECRET, { nested: SECRET }] } })
    expect(out).toEqual({ credentials: '[redacted]' })
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })

  it('5) 非敏感父级的普通字段与嵌套结构原样保留', () => {
    const normal = {
      note: 'keep me',
      list: ['a', 'b'],
      nested: { title: 'keep too', items: [{ k: 'v' }] },
      count: 3
    }
    expect(redactDeep(normal)).toEqual(normal)
    // 混合：敏感的折叠，其余的保留
    const mixed = { note: 'keep me', password: { value: SECRET } }
    expect(redactDeep(mixed)).toEqual({ note: 'keep me', password: '[redacted]' })
  })

  it('6) JSON 序列化后原始敏感值完全不存在，且仍是合法 JSON', () => {
    const meta = {
      authorization: { scheme: 'Bearer', value: SECRET },
      api_key: { provider: 'acme', value: SECRET },
      client_secret: { nested: [SECRET] },
      password: { value: SECRET },
      credentials: { user: 'alice', pass: SECRET },
      keep: 'visible'
    }
    const json = JSON.stringify(redactDeep(meta))
    expect(() => JSON.parse(json)).not.toThrow()
    expect(json).not.toContain(SECRET)
    expect(json).not.toContain('alice')
    expect(json).toContain('visible')
    // 五个键名都确实命中了敏感规则
    for (const key of ['authorization', 'api_key', 'client_secret', 'password', 'credentials']) {
      expect(json, key).toContain(`"${key}":"[redacted]"`)
    }
  })
})

describe('goal 字段独立上限（设计文档 §7.2 ≤2000）', () => {
  it('1999 / 2000 字符原样保存', () => {
    expect(JOURNEY_TEXT_LIMITS.goal).toBe(2_000)
    expect(sanitizeJourneyContent('g'.repeat(1_999), { max: JOURNEY_TEXT_LIMITS.goal })).toHaveLength(
      1_999
    )
    const atLimit = sanitizeJourneyContent('g'.repeat(2_000), { max: JOURNEY_TEXT_LIMITS.goal })
    expect(atLimit).toHaveLength(2_000)
    expect(atLimit.endsWith(TRUNCATION_MARKER)).toBe(false)
  })

  it('超过 2000 字符明确截断', () => {
    const out = sanitizeJourneyContent('g'.repeat(3_000), { max: JOURNEY_TEXT_LIMITS.goal })
    expect(out).toHaveLength(JOURNEY_TEXT_LIMITS.goal)
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(exceedsLimit(out, 'goal')).toBe(false)
  })

  it('超长敏感文本仍然先脱敏后截断', () => {
    const input = 'x'.repeat(2_100) + 'password=' + 'S'.repeat(3_000)
    const out = sanitizeJourneyContent(input, { max: JOURNEY_TEXT_LIMITS.goal })
    expect(out).not.toContain('SSSSSSSSSS')
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(out.length).toBeLessThanOrEqual(JOURNEY_TEXT_LIMITS.goal)
  })

  it('普通中文 Goal 不被误删', () => {
    const zh = '目标：把设备配对问题定位并修复，保持现有协议与工具面不变。'
    expect(sanitizeJourneyContent(zh, { max: JOURNEY_TEXT_LIMITS.goal })).toBe(zh)
  })
})
