import type { Canvas } from '@shared/contracts'
import { useI18n } from '../../i18n'
import { CanvasThumbnail } from '../canvas/CanvasThumbnail'
import { stackStyle } from './StackSection'
import { CanvasEmpty } from './empty-states'

/**
 * Creative Space：复用 Gallery 的 CanvasThumbnail —— 它按真实节点的
 * 世界坐标等比装入，最多绘 8 个（带缓存），不需要截图任务，也不会造假缩略图。
 *
 * 表现是「摊在桌上的几张稿纸」：卡片按索引轻微偏移、旋转叠放，
 * hover 整区时展开（只改 transform），悬停那张抬起来并显示更新时间。
 * 首页最多摆 3 块，避免同时发起过多节点查询。
 *
 * 稿纸宽度由 CSS 上限（约 430px）收住，缩略图比例才不会随列宽被拉成
 * 3:1 的长条；容器再窄时卡片跟着变窄，spread 只是位移、不撑破列宽。
 */
export function CanvasStack({ canvases }: { canvases: Canvas[] }) {
  const { t, formatDate } = useI18n()
  const shown = canvases.slice(0, 3)

  if (shown.length === 0) {
    return <CanvasEmpty />
  }

  return (
    <div className="canvas-deck">
      {shown.map((canvas, index) => (
        <article key={canvas.id} className="canvas-deck__card" style={stackStyle(index)}>
          <div className="canvas-deck__preview">
            <CanvasThumbnail canvas={canvas} height={180} />
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
