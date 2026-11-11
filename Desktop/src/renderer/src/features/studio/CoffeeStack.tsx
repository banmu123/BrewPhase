import type { Bean } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { stackStyle } from './StackSection'
import { CoffeeEmpty } from './empty-states'

/** 每包的初始倾角：固定值而非随机，重渲染不会跳。 */
const TILTS = [-2.6, 1.8, -1.2, 2.4, -0.7]

/**
 * Coffee Shelf：像书架上错开叠放的豆袋。最多取 5 包真实豆子，
 * 有 imagePath 就用真实包装图，没有就用统一占位（不伪造图片）。
 *
 * 叠放靠负边距（每张的压叠量不同，避免排成一列等距卡片）+ 索引递增的
 * 微量下沉，hover 整区时按 `--spread` 展开；悬停那一包抬起来、淡入信息，
 * 其余稍微退后。只改 transform / opacity，不触发布局。
 */
export function CoffeeStack({ beans }: { beans: Bean[] }) {
  const { t } = useI18n()
  const shown = beans.slice(0, 5)

  if (shown.length === 0) {
    return <CoffeeEmpty />
  }

  return (
    <div className="coffee-shelf">
      {shown.map((bean, index) => {
        // 只接受纯文件名：`imagePath` 来自 iOS，带目录的路径不该拼进 bpmedia://。
        const image = bean.imagePath && !bean.imagePath.includes('/') ? api.records.mediaUrl(bean.imagePath) : null
        return (
          <article key={bean.id} className="coffee-shelf__card" style={stackStyle(index, TILTS[index])}>
            <div className="coffee-shelf__face">
              {image ? (
                <img src={image} alt="" loading="lazy" />
              ) : (
                <div className="coffee-shelf__placeholder" data-roast={bean.roastLevel}>
                  <span className="coffee-shelf__monogram">
                    {(bean.name || t.studio.coffee.unnamed).slice(0, 1)}
                  </span>
                </div>
              )}
            </div>
            <div className="coffee-shelf__info">
              <strong>{bean.name || t.studio.coffee.unnamed}</strong>
              <span>{bean.roaster || t.studio.coffee.noRoaster}</span>
              {bean.origin && <span>{bean.origin}</span>}
              <span className="mono">
                {bean.remainingG.toFixed(0)} / {bean.weightG.toFixed(0)}g
              </span>
            </div>
          </article>
        )
      })}
    </div>
  )
}
