import { useEffect, useState } from 'react'
import type { WorkContextStudioItem } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { useAppStore } from '../../app/store'
import { useBrowserStore } from '../browser/browser-store'

/**
 * Studio Home「继续工作」区块（Work Context V1）。
 *
 * 极轻量：只展示最近活动的上下文（标题 / 进度摘要 / 下一步 / 资源计数），
 * 资源 chip 点击跳转到对应空间或内置浏览器。不是任务看板，没有拖拽。
 * 数据经只读 IPC；创建与更新走 MCP（本区块只读）。
 */
export function WorkContextSection() {
  const { t } = useI18n()
  const setModule = useAppStore((state) => state.setModule)
  const navigate = useBrowserStore((state) => state.navigate)
  const [items, setItems] = useState<WorkContextStudioItem[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void api.app
        .studioList()
        .then((list) => {
          if (!cancelled) setItems(list)
        })
        .catch((error) => {
          console.error('[work-context] studioList failed:', String(error).slice(0, 200))
          if (!cancelled) setItems([])
        })
    }
    load()
    // MCP 写入（含外部 Agent）会广播 workContexts 域：首页无需手动刷新。
    const unsubscribe = api.app.onChanged((domain) => {
      if (domain === 'workContexts') load()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  if (items === null || items.length === 0) return null

  return (
    <section className="work-context" aria-label={t.studio.workContext.title}>
      <header className="work-context__head">
        <span className="overline">{t.studio.workContext.overline}</span>
        <h2 className="work-context__title">{t.studio.workContext.title}</h2>
      </header>

      <div className="work-context__list">
        {items.map((item) => (
          <article key={item.id} className="work-context__card">
            <div className="work-context__row">
              <h3 className="work-context__name">{item.title}</h3>
              <span className="work-context__status" data-status={item.status}>
                {t.studio.workContext.status[item.status]}
              </span>
            </div>

            {item.summary && <p className="work-context__summary">{item.summary}</p>}
            {item.nextStep && (
              <p className="work-context__next">
                <span className="overline">{t.studio.workContext.nextStep}</span>
                {item.nextStep}
              </p>
            )}

            <div className="work-context__resources">
              <span className="work-context__count">
                {t.studio.workContext.counts(item.recordCount, item.canvasCount, item.urlCount)}
              </span>
              {item.resources.slice(0, 6).map((resource) =>
                resource.resourceType === 'record' ? (
                  <button
                    key={resource.id}
                    type="button"
                    className="work-context__chip"
                    onClick={() => setModule('records')}
                  >
                    {resource.label}
                  </button>
                ) : resource.resourceType === 'canvas' ? (
                  <button
                    key={resource.id}
                    type="button"
                    className="work-context__chip"
                    onClick={() => setModule('canvas')}
                  >
                    {resource.label}
                  </button>
                ) : (
                  <button
                    key={resource.id}
                    type="button"
                    className="work-context__chip"
                    onClick={() => void navigate(resource.resourceId)}
                  >
                    {resource.label}
                  </button>
                )
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
