import type { CSSProperties } from 'react'
import type { Bean } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { deckCardStyle, DECK_REST, SPACE_CARD_LIMIT } from './deck-model'
import { CoffeeEmpty } from './empty-states'

/**
 * Coffee：一摞错开叠放的豆袋。
 *
 * 和 Records 共用同一套姿态（`deck-model` 的固定数组）：绝对定位、每张按索引
 * 向右下错开，第一张留在文档流里撑高容器，hover 整叠展开、单张再抬起来。
 *
 * 早先这里是「一排 5 包横着铺满整列」——每包被压掉 70%，五包只剩五条竖边，
 * 既读不出是哪一包，展开时还会顶出列外。叠成一摞之后每包都看得见。
 *
 * 卡片的动作就是「进入咖啡空间」，所以不自己绑 onClick——交给外层 section。
 */
export function CoffeeStack({ beans }: { beans: Bean[] }) {
  const { t } = useI18n()
  const shown = beans.slice(0, SPACE_CARD_LIMIT)

  if (shown.length === 0) {
    return <CoffeeEmpty />
  }

  // 整叠扇开量 = 实际用到的姿态里最大的 x 位移；CSS 用它把整摞居中。
  const fan = Math.max(...DECK_REST.slice(0, shown.length).map((pose) => pose.x))

  return (
    <div className="coffee-shelf" style={{ '--deck-fan': `${fan}px` } as CSSProperties}>
      {shown.map((bean, index) => {
        // 只接受纯文件名：`imagePath` 来自 iOS，带目录的路径不该拼进 bpmedia://。
        const image = bean.imagePath && !bean.imagePath.includes('/') ? api.records.mediaUrl(bean.imagePath) : null
        return (
          <article
            key={bean.id}
            className="coffee-shelf__card"
            style={deckCardStyle(index)}
            aria-label={bean.name || t.studio.coffee.unnamed}
          >
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
