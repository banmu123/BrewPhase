import type { CSSProperties } from 'react'
import type { Canvas } from '@shared/contracts'
import { useI18n } from '../../i18n'
import { CanvasThumbnail } from '../canvas/CanvasThumbnail'
import { deckCardStyle, DECK_REST, SPACE_CARD_LIMIT } from './deck-model'
import { CanvasEmpty } from './empty-states'

/**
 * Canvas：一摞摊开的稿纸，姿态与 Coffee / Records 完全一致。
 *
 * 缩略图复用 `CanvasThumbnail`——它按真实节点的世界坐标等比装入（最多 8 个，
 * 带缓存），不截图、不造假内容；这里只把高度交给 CSS（16:10 随卡宽缩放）。
 *
 * 三个空间共用 `deck-model` 的固定姿态，于是「叠放」只有一套实现：
 * 换卡宽、换卡面，不换叠法。稿纸宽度由 CSS 上限收住，缩略图不会被拉成长条。
 */
export function CanvasStack({ canvases }: { canvases: Canvas[] }) {
  const { t, formatDate } = useI18n()
  const shown = canvases.slice(0, SPACE_CARD_LIMIT)

  if (shown.length === 0) {
    return <CanvasEmpty />
  }

  // 整叠扇开量 = 实际用到的姿态里最大的 x 位移；CSS 用它把整摞居中。
  const fan = Math.max(...DECK_REST.slice(0, shown.length).map((pose) => pose.x))

  return (
    <div className="canvas-deck" style={{ '--deck-fan': `${fan}px` } as CSSProperties}>
      {shown.map((canvas, index) => (
        <article
          key={canvas.id}
          className="canvas-deck__card"
          style={deckCardStyle(index)}
          aria-label={canvas.name || t.studio.canvas.untitled}
        >
          <div className="canvas-deck__preview">
            <CanvasThumbnail canvas={canvas} height="fluid" />
          </div>
          <div className="canvas-deck__meta">
            <strong>{canvas.name || t.studio.canvas.untitled}</strong>
            <span>{t.studio.canvas.updated(formatDate(canvas.updatedAt))}</span>
          </div>
        </article>
      ))}
    </div>
  )
}
