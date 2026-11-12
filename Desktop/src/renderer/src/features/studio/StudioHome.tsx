import { useCallback, useEffect, useState } from 'react'
import type { Bean, Canvas, RecordItem } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { useAppStore } from '../../app/store'
import { WorkContextSection } from './WorkContextSection'
import { CoffeeStack } from './CoffeeStack'
import { RecordsStack } from './RecordsStack'
import { CanvasStack } from './CanvasStack'
import { StackSection } from './StackSection'

/**
 * Studio Home：应用默认首页，也是三个空间的唯一入口。
 *
 * 只读三空间已有 API 的**真实数据**，不复制业务对象、不生成假封面；
 * 首页本身只是引用式预览，后续要固定内容时加的是引用关系而非副本。
 * 预览数量刻意收敛：Records 取 8 条、Deck 只摆前 5 张（DECK_LIMIT），
 * Canvas 3 块，Coffee 5 包，避免一次加载过多媒体。
 *
 * 版面是「一张桌子」而不是三块面板：左列是桌上正在用的东西（咖啡架在上、
 * 画布稿纸在下且向内缩进），右列是摊开的收藏库。三块内容共享同一张桌面
 * 底色，只靠一条发丝线、留白与字号分层——没有谁被装进一个矩形里。
 */
export function StudioHome() {
  const { t } = useI18n()
  const setModule = useAppStore((state) => state.setModule)
  const [beans, setBeans] = useState<Bean[]>([])
  const [records, setRecords] = useState<RecordItem[]>([])
  const [canvases, setCanvases] = useState<Canvas[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [nextBeans, nextRecords, nextCanvases] = await Promise.all([
        api.coffee.listBeans(),
        api.records.list({ search: '', carrier: null, tagId: null, limit: 8, offset: 0 }),
        api.canvas.list()
      ])
      setBeans(nextBeans)
      setRecords(nextRecords)
      setCanvases(nextCanvases)
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 本地写入/MCP、以及 iOS 同步进来后首页要跟着更新；回到首页也会重新 mount 取一次。
  useEffect(() => api.app.onChanged(() => void load()), [load])
  useEffect(() => api.sync.onChanged(() => void load()), [load])

  return (
    <div className="studio-home">
      <div className="studio-home__inner">
        <header className="studio-hero">
          <span className="overline">{t.studio.overline}</span>
          <h1 className="studio-hero__title">{t.studio.title}</h1>
          <p className="studio-hero__sub">{t.studio.subtitle}</p>
        </header>

        {error && <div className="error">{error}</div>}

        <div className="studio-desk">
          <StackSection
            space="coffee"
            overline={t.studio.coffee.overline}
            label={t.navigation.coffee}
            hint={t.studio.coffee.hint}
            count={t.studio.coffee.count(beans.length)}
            openLabel={t.studio.coffee.open}
            onOpen={() => setModule('coffee')}
          >
            <CoffeeStack beans={beans} />
          </StackSection>

          <StackSection
            space="canvas"
            overline={t.studio.canvas.overline}
            label={t.navigation.canvas}
            hint={t.studio.canvas.hint}
            count={t.studio.canvas.count(canvases.length)}
            openLabel={t.studio.canvas.open}
            onOpen={() => setModule('canvas')}
          >
            <CanvasStack canvases={canvases} />
          </StackSection>

          <StackSection
            space="records"
            overline={t.studio.records.overline}
            label={t.navigation.records}
            hint={t.studio.records.hint}
            openLabel={t.studio.records.open}
            onOpen={() => setModule('records')}
          >
            <RecordsStack items={records} />
          </StackSection>
        </div>

        <WorkContextSection />
      </div>
    </div>
  )
}
