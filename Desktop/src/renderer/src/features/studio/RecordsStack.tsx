import type { RecordItem } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { isSafeRemoteImage, recordDisplayTitle } from '../records/preview/preview-model'
import { stackStyle } from './StackSection'

/** 固定宽高比组合：不同类型自然交错，但不随渲染随机跳动。 */
const SHAPES = [
  { width: 172, height: 218 },
  { width: 214, height: 150 },
  { width: 158, height: 196 },
  { width: 202, height: 168 },
  { width: 166, height: 214 },
  { width: 220, height: 156 }
]

const GLYPHS: Record<string, string> = { text: '¶', link: '↗', video: '▶', image: '▣' }

/**
 * Personal Library：图片 / 链接 / 文字三种真实记录用不同宽高比散放。
 * 本地媒体走 bpmedia://，远程缩略图只放行 https；文字记录显示真实正文摘要。
 *
 * 多栏瀑布流（CSS columns）——每张卡按自己的宽高比占位，没有两行对齐的网格感。
 * 不常驻任何操作按钮：hover 时当前卡上浮，标题与来源在 80ms 后淡入。
 */
export function RecordsStack({ items }: { items: RecordItem[] }) {
  const { t } = useI18n()
  const shown = items.slice(0, 6)

  if (shown.length === 0) {
    return <div className="studio-empty">{t.studio.records.empty}</div>
  }

  return (
    <div className="records-library">
      {shown.map((item, index) => {
        const shape = SHAPES[index % SHAPES.length]
        const local = item.previewPath ?? item.mediaPath
        const remote = isSafeRemoteImage(item.thumbnailURLString)
        const image = local ? api.records.mediaUrl(local) : remote
        const title = recordDisplayTitle(item) || t.studio.records.untitled
        // 只显示人写的来源/作者；`provider`（generic / github / youtube）是内部
        // 字段，摆到界面上就是「generic」这种黑话。
        const source = item.sourceName || item.authorName || ''
        const glyph = GLYPHS[item.carrier] ?? '▣'
        return (
          <article
            key={item.id}
            className={`library-card library-card--${item.carrier}`}
            style={{ ...stackStyle(index), aspectRatio: `${shape.width} / ${shape.height}` }}
          >
            {image ? (
              <>
                <img src={image} alt="" loading="lazy" />
                <span className="library-card__chip" aria-hidden="true">
                  {glyph}
                </span>
              </>
            ) : item.carrier === 'text' ? (
              <div className="library-card__text">
                <p>{(item.note || item.summary || '').slice(0, 180)}</p>
              </div>
            ) : (
              // 链接/视频没有缩略图时，卡片正面就是它自己的标题与来源：
              // 这是记录里真实存在的内容，不是占位图。
              <div className="library-card__fallback">
                <span className="library-card__glyph" aria-hidden="true">
                  {glyph}
                </span>
                <strong>{title.slice(0, 70)}</strong>
                {source && <span className="library-card__source">{source.slice(0, 40)}</span>}
              </div>
            )}

            {(image || item.carrier === 'text') && (
              <div className="library-card__meta">
                <strong>{title.slice(0, 60)}</strong>
                {source && <span>{source.slice(0, 40)}</span>}
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}
