import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type {
  McpClientCreateInput,
  McpClientCreated,
  McpClientInfo,
  McpScope
} from '../../../shared/contracts/mcp'
import { MCP_SCOPES } from '../../../shared/contracts/mcp'
import type { Db } from '../../database/client'
import { mcpClients } from '../../database/schema'
import { ApplicationError } from '../errors'

/**
 * MCP 客户端授权：创建 / 列出 / 撤销 / 每请求认证。
 *
 * 安全约束（见 docs/MCP_SECURITY.md）：
 * - token 明文只在 `create` 的返回值里出现一次，库中只存 sha256；
 * - `authenticate` 每个请求查库，**不使用进程内授权缓存**——撤销立即生效；
 * - last_used_at 最多每 60s 写一次，避免每次读取都产生写入。
 */

const TOKEN_PREFIX = 'bp_mcp_'
const LAST_USED_THROTTLE_MS = 60_000

export type AuthenticatedClient = { id: string; name: string; scopes: McpScope[] }

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export class McpClientService {
  constructor(private readonly db: Db) {}

  list(): McpClientInfo[] {
    return this.db.select().from(mcpClients).orderBy(desc(mcpClients.createdAt)).all().map(toInfo)
  }

  count(): number {
    return this.db.select({ id: mcpClients.id }).from(mcpClients).all().length
  }

  create(input: McpClientCreateInput): McpClientCreated {
    const name = input.name.trim()
    if (!name) throw new ApplicationError('VALIDATION_ERROR', 'client name must not be empty')
    const scopes = [...new Set(input.scopes)]
    if (scopes.length === 0) throw new ApplicationError('VALIDATION_ERROR', 'at least one scope is required')
    for (const scope of scopes) {
      if (!MCP_SCOPES.includes(scope)) {
        throw new ApplicationError('VALIDATION_ERROR', `unknown scope: ${scope}`)
      }
    }

    const id = randomUUID()
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const at = Date.now()
    this.db
      .insert(mcpClients)
      .values({
        id,
        name,
        tokenHash: hashToken(token),
        scopes: JSON.stringify(scopes),
        createdAt: at
      })
      .run()

    return {
      id,
      name,
      scopes,
      createdAt: at,
      lastUsedAt: null,
      revokedAt: null,
      token
    }
  }

  revoke(id: string): McpClientInfo {
    const row = this.db.select().from(mcpClients).where(eq(mcpClients.id, id)).get()
    if (!row) throw new ApplicationError('NOT_FOUND', `MCP client ${id} not found`)
    if (row.revokedAt === null) {
      this.db.update(mcpClients).set({ revokedAt: Date.now() }).where(eq(mcpClients.id, id)).run()
    }
    const updated = this.db.select().from(mcpClients).where(eq(mcpClients.id, id)).get()!
    return toInfo(updated)
  }

  /**
   * 每请求调用。token 缺失/未知/已撤销一律 `UNAUTHORIZED`——
   * 不区分「不存在」与「已撤销」，避免探测。
   */
  authenticate(token: string): AuthenticatedClient {
    if (!token || !token.startsWith(TOKEN_PREFIX)) {
      throw new ApplicationError('UNAUTHORIZED', 'invalid or missing access token')
    }
    const row = this.db
      .select()
      .from(mcpClients)
      .where(eq(mcpClients.tokenHash, hashToken(token)))
      .get()
    if (!row || row.revokedAt !== null) {
      throw new ApplicationError('UNAUTHORIZED', 'invalid or missing access token')
    }
    const now = Date.now()
    if (row.lastUsedAt === null || now - row.lastUsedAt > LAST_USED_THROTTLE_MS) {
      this.db.update(mcpClients).set({ lastUsedAt: now }).where(eq(mcpClients.id, row.id)).run()
    }
    return { id: row.id, name: row.name, scopes: parseScopes(row.scopes) }
  }
}

function parseScopes(raw: string): McpScope[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((scope): scope is McpScope => typeof scope === 'string' && MCP_SCOPES.includes(scope as McpScope))
  } catch {
    return []
  }
}

function toInfo(row: typeof mcpClients.$inferSelect): McpClientInfo {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt
  }
}
