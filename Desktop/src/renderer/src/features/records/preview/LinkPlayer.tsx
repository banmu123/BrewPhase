import { useEffect, useMemo, useState } from 'react'
import { embedURL } from '@shared/link-embed'
import { parseLink } from '@shared/link-parser'
import type { RecordPreview } from './preview-model'

/**
 * 详情里的平台播放器（YouTube / B 站）。
 *
 * 默认只挂封面，点播放才真正创建 iframe：
 * - 切记录就加载播放器 = 每选一条发一堆跨域请求，用户多数时候只想看看是什么；
 * - 侧栏只有 336px 宽，16:9 的播放器在栏里看不清，所以「放大」用同一个
 *   DOM 节点做整屏缩放（iframe 不重挂，视频不会从头开始）。
 *
 * 播放地址来自 `@shared/link-embed`：只由内容 ID 拼，不读记录里的 URL。
 */
export function LinkPlayer(props: { preview: RecordPreview }) {
  const { preview } = props
  const platform = preview.platform.platform
  // 记录里的 contentID 是权威值；早期同步过来的记录可能没有这个字段，
  // 再按地址现认一次——有地址却显示「不能播」才是最让人困惑的状态。
  const contentId = preview.videoId ?? parseLink(preview.detailUrl ?? '').contentId
  const src = useMemo(() => embedURL(platform, contentId), [platform, contentId])

  const [playing, setPlaying] = useState(false)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    if (!zoomed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomed(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomed])

  // 不能播就不渲染播放器：正文、备注、外部打开都不受影响。
  if (!src) return null

  return (
    <div className={zoomed ? 'link-player link-player--zoomed' : 'link-player'} data-platform={platform}>
      <div className="link-player__stage">
        {playing ? (
          <iframe
            className="link-player__frame"
            src={src}
            title={preview.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button
            type="button"
            className="link-player__cover"
            aria-label={`播放：${preview.title}`}
            onClick={() => setPlaying(true)}
          >
            {preview.remoteImage ? (
              <img src={preview.remoteImage} alt="" loading="lazy" referrerPolicy="no-referrer" />
            ) : (
              <span className="link-player__fallback">{preview.platform.label}</span>
            )}
            <span className="link-player__play" aria-hidden="true" />
          </button>
        )}
      </div>

      {zoomed ? (
        <button type="button" className="link-player__close" onClick={() => setZoomed(false)}>
          关闭
        </button>
      ) : (
        <div className="link-player__bar">
          {/* 播放中不必再说明状态：iframe 摆在那里，「收起」就是它的反面动作。 */}
          {!playing && <span className="link-player__note">点封面在 App 内播放</span>}
          <span className="link-player__actions">
            {playing && (
              <button type="button" className="button button--ghost" onClick={() => setPlaying(false)}>
                收起
              </button>
            )}
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                setPlaying(true)
                setZoomed(true)
              }}
            >
              放大
            </button>
            {preview.detailUrl && (
              <a className="button button--ghost" href={preview.detailUrl} target="_blank" rel="noreferrer">
                浏览器打开
              </a>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
