import type { RecordItem } from '@shared/contracts'
import { api } from '../../shared/api'
import { useAppStore } from '../../app/store'
import { useI18n } from '../../i18n'
import { deckCard, deckCardStyle, DECK_LIMIT } from './deck-model'
import { RecordsEmpty } from './empty-states'

const GLYPHS: Record<string, string> = { text: '¶', link: '↗', video: '▶', image: '▣' }

/**
 * Records Deck：一叠灵感收藏卡，不是瀑布流。
 *
 * 最新几张真实记录前后错位叠放（姿态来自 deck-model 的固定数组，渲染稳定）；
 * hover 整叠时卡片向各自方向展开、能看清彼此，离开后回到紧凑叠放。
 * 点击某张卡沿用既有跨页路径 `openRecord(id)` —— RecordsPage 消费后
 * 打开它已有的详情浮层，这里不复制任何 Modal。
 *
 * 卡面按载体差异化：图片用真实缩略图（bpmedia://）、链接用安全远程图
 * 或「标题 + 域名」纸笺、文字用真实正文摘要。没有任何占位数据。
 *
 * 叠放用 absolute 定位，舞台高度由 CSS min-height 保证（与 Coffee /
 * Canvas 同一约定），不会把页面布局高度抽掉。
 */
export function RecordsStack({ items }: { items: RecordItem[] }) {
  const { t } = useI18n()
  const openRecord = useAppStore((state) => state.openRecord)
  const shown = items.slice(0, DECK_LIMIT).map((item, index) => deckCard(item, index, api.records.mediaUrl))

  if (shown.length === 0) {
    return <RecordsEmpty />
  }

  return (
    <div className="records-deck">
      {shown.map((card) => {
        const glyph = GLYPHS[card.item.carrier] ?? '▣'
        const label = card.title || card.body || t.studio.records.untitled
        return (
          <button
            key={card.item.id}
            type="button"
            className={`records-deck__card records-deck__card--${card.item.carrier}`}
            style={deckCardStyle(card.index)}
            aria-label={label}
            onClick={(event) => {
              // 卡片自己的语义（打开详情）优先：不让 section 的「进入空间」抢走。
              event.stopPropagation()
              openRecord(card.item.id)
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {card.image ? (
              <span className="records-deck__media">
                <img src={card.image} alt="" loading="lazy" />
                {card.item.carrier === 'video' && (
                  <span className="records-deck__play" aria-hidden="true">
                    ▶
                  </span>
                )}
                <span className="records-deck__chip" aria-hidden="true">
                  {glyph}
                </span>
              </span>
            ) : card.body ? (
              <span className="records-deck__paper">
                <span className="records-deck__body">{card.body}</span>
              </span>
            ) : (
              // 没有封面的链接/视频：纸笺上就是它自己的标题与来源。
              <span className="records-deck__paper">
                <span className="records-deck__glyph" aria-hidden="true">
                  {glyph}
                </span>
                <span className="records-deck__body">{(card.title || t.studio.records.untitled).slice(0, 70)}</span>
                {card.source && <span className="records-deck__source">{card.source.slice(0, 40)}</span>}
              </span>
            )}

            {/* 标题只有一条来源：记录自己的 title。文字记录没有标题时卡面就是正文，
                不再压一个「未命名记录」的条子上去。 */}
            {card.title && (
              <span className="records-deck__meta">
                <strong>{card.title.slice(0, 60)}</strong>
                {card.source && <span>{card.source.slice(0, 40)}</span>}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
