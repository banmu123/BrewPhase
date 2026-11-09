import { parseLink } from '../../shared/link-parser'
import { emptyMetadata, type TextFetcher } from './metadata-normalizer'
import type { RecordItem } from '../../shared/contracts'
import type { Db } from '../database/client'
import { applyResolvedMetadata, getRecord } from '../database/repositories/records'
import { resolveMetadataDeduped } from './metadata-resolver'

/**
 * 从一次同步的结果里挑出「需要排本地元数据补全」的记录：
 * 只有真正 `applied` 的 record。skipped（内容一致）/ conflict / failed 一律不排，
 * 避免重复抓取和冲突期间的无效请求。
 */
export function recordIdsToResolve(outcome: {
  results: Array<{ entityType: string; id: string; status: string }>
}): string[] {
  return outcome.results
    .filter((item) => item.entityType === 'record' && item.status === 'applied')
    .map((item) => item.id)
}

/**
 * 记录级元数据补全（IPC / 后台队列共用入口）。
 *
 * - 只处理 `link` 载体且有 URL 的记录；其余载体原样返回；
 * - 非 `force` 且本记录已 `ok` → 直接用库内缓存（§八：不每次打开都抓）；
 * - 同 URL 的并发请求在 resolver 里合并；
 * - 抓取结果只写 `record_metadata`（Desktop 单方派生数据，**不进同步指纹**），
 *   抓取失败只把该表的状态记为 failed，**记录本身与同步基线都不受影响**；
 * - 记录在抓取期间被删除 → 写入返回 null，不产生孤儿数据；
 * - `expectedUrl`：后台队列入队时的 URL。执行时记录 URL 已经变了就直接放弃，
 *   绝不把旧链接的结果写到新链接上（第二道防线是 applyResolvedMetadata 的
 *   读写同事务校验）；`fetchText` 供自动化测试注入固定响应。
 */
export async function resolveRecordMetadata(
  db: Db,
  id: string,
  force: boolean,
  expectedUrl?: string,
  fetchText?: TextFetcher
): Promise<RecordItem | null> {
  const record = getRecord(db, id)
  if (!record) return null
  if (record.carrier !== 'link' || !record.urlString.trim()) return record
  if (expectedUrl !== undefined && record.urlString !== expectedUrl) return record
  if (!force && record.metadataStatus === 'ok') return record

  const parsed = parseLink(record.urlString)
  if (!parsed.valid) {
    // 防御：非法 URL 不抓取，但也不能留在 pending（UI 已阻止保存，这里兜底）。
    if (record.metadataStatus === 'pending') {
      return applyResolvedMetadata(db, id, record.urlString, {
        ...emptyMetadata('generic', ''),
        errorMessage: '不是有效的网页地址'
      })
    }
    return record
  }

  // 请求开始时锁定 URL：写入时会核对它，期间被改过就丢弃结果（§第三轮 3）。
  const lockedUrl = record.urlString
  const resolved = await resolveMetadataDeduped(lockedUrl, fetchText)
  return applyResolvedMetadata(db, id, lockedUrl, resolved)
}
