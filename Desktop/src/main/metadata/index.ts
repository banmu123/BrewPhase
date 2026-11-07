import { parseLink } from '../../shared/link-parser'
import type { RecordItem } from '../../shared/contracts'
import type { Db } from '../database/client'
import { applyResolvedMetadata, getRecord } from '../database/repositories/records'
import { resolveMetadataDeduped } from './metadata-resolver'

/**
 * 记录级元数据补全（IPC 入口）。
 *
 * - 只处理 `link` 载体且有 URL 的记录；其余载体原样返回；
 * - 非 `force` 且本记录已 `ok` → 直接用库内缓存（§八：不每次打开都抓）；
 * - 同 URL 的并发请求在 resolver 里合并；
 * - 抓取失败只把 `metadata_status` 记为 failed，**记录本身不受影响**；
 * - 记录在抓取期间被删除 → 写入返回 null，不产生孤儿数据。
 */
export async function resolveRecordMetadata(
  db: Db,
  deviceId: string,
  id: string,
  force: boolean
): Promise<RecordItem | null> {
  const record = getRecord(db, id)
  if (!record) return null
  if (record.carrier !== 'link' || !record.urlString.trim()) return record
  if (!force && record.metadataStatus === 'ok') return record
  const parsed = parseLink(record.urlString)
  if (!parsed.valid) return record
  const resolved = await resolveMetadataDeduped(record.urlString)
  return applyResolvedMetadata(db, deviceId, id, resolved)
}
