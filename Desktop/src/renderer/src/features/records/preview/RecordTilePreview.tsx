import { useMemo, useState } from 'react'
import type { RecordItem } from '@shared/contracts'
import { BilibiliMark, ForkGlyph, GitHubMark, PlayGlyph, StarGlyph, XMark, YouTubeMark } from './PlatformMarks'
import { buildPreview, formatCount, type RecordPreview } from './preview-model'

/**
 * 记录卡片的平台差异化媒体区（§平台差异化设计）。
 *
 * 同一张卡片系统里呈现平台独有的内容结构：GitHub 是仓库信息卡、
 * YouTube/Bilibili 是 16:9 封面 + 播放钮、X 是作者 + 正文主体、
 * 其余是通用网页预览 / 本地媒体。元数据全部来自记录本身，
 * 加载失败或缺失时落到平台 fallback，绝不伪造、绝不空白占位。
 */

export function RecordTilePreview(props: { item: RecordItem; mediaUrl: (name: string) => string }) {
  const preview = useMemo(() => buildPreview(props.item, props.mediaUrl), [props.item, props.mediaUrl])
  return <PreviewBody preview={preview} mediaUrl={props.mediaUrl} />
}

function PreviewBody(props: { preview: RecordPreview; mediaUrl: (name: string) => string }) {
  const { preview } = props
  switch (preview.platform.platform) {
    case 'github':
      return <GitHubPreview preview={preview} />
    case 'youtube':
    case 'bilibili':
      return <VideoPreview preview={preview} />
    case 'x':
      return <XPreview preview={preview} />
    default:
      return <GenericPreview preview={preview} mediaUrl={props.mediaUrl} />
  }
}

/** 平台角标：媒体区左上角的小 chip，品牌色只落在文字/图形上。 */
function PlatformChip(props: { preview: RecordPreview }) {
  return (
    <span className="preview-chip" style={{ color: props.preview.platform.accent }}>
      <PlatformGlyph preview={props.preview} size={11} />
      <span>{props.preview.platform.label}</span>
    </span>
  )
}

function PlatformGlyph(props: { preview: RecordPreview; size?: number }) {
  switch (props.preview.platform.platform) {
    case 'github': return <GitHubMark size={props.size ?? 12} />
    case 'youtube': return <YouTubeMark size={props.size ?? 12} />
    case 'bilibili': return <BilibiliMark size={props.size ?? 12} />
    case 'x': return <XMark size={props.size ?? 11} />
    default: return null
  }
}

/**
 * 远程缩略图：加载失败落平台 fallback，绝不让记录消失或一直空着。
 * `cover` = 铺满媒体区（绝对定位）；`inline` = 文档流内的圆角图（X 动态）。
 */
function RemoteThumb(props: {
  src: string
  alt: string
  fallback: React.ReactNode
  variant?: 'cover' | 'inline'
}) {
  const [failed, setFailed] = useState(false)
  if (failed) return <>{props.fallback}</>
  return (
    <img
      className={`preview-thumb${props.variant === 'inline' ? ' preview-thumb--inline' : ''}`}
      src={props.src}
      alt={props.alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

/** 平台 fallback 卡：品牌 mark 居中 + 名称，替代空白图与随机占位。 */
function PlatformFallbackCard(props: { preview: RecordPreview }) {
  return (
    <span className="preview-fallback" style={{ color: props.preview.platform.accent }}>
      <PlatformGlyph preview={props.preview} size={22} />
      <span className="preview-fallback__label">{props.preview.platform.label}</span>
    </span>
  )
}

/** 播放钮：视频平台的轻量入口（仅视觉，点击行为仍是整卡打开逻辑）。 */
function PlayOverlay() {
  return (
    <span className="preview-play" aria-hidden>
      <PlayGlyph size={15} />
    </span>
  )
}

// MARK: - GitHub 仓库卡

function GitHubPreview(props: { preview: RecordPreview }) {
  const { preview } = props
  return (
    <span className="preview-media preview-media--auto">
      <PlatformChip preview={preview} />
      {preview.remoteImage ? (
        <RemoteThumb
          src={preview.remoteImage}
          alt={preview.repositoryName ?? preview.title}
          fallback={<RepoCardBody preview={preview} />}
        />
      ) : (
        <RepoCardBody preview={preview} />
      )}
    </span>
  )
}

function RepoCardBody(props: { preview: RecordPreview }) {
  const { preview } = props
  return (
    <span className="preview-repo">
      <span className="preview-repo__id">
        <GitHubMark size={13} />
        <span className="mono">{preview.repositoryName || preview.title}</span>
      </span>
      {(preview.title || preview.language) && (
        <span className="preview-repo__desc">{preview.title || preview.language}</span>
      )}
      {(preview.stars !== null || preview.forks !== null || preview.language) && (
        <span className="preview-repo__stats">
          {preview.language && (
            <span className="preview-repo__lang">
              <span className="preview-repo__lang-dot" />
              {preview.language}
            </span>
          )}
          {preview.stars !== null && preview.stars > 0 && (
            <span><StarGlyph /> {formatCount(preview.stars)}</span>
          )}
          {preview.forks !== null && preview.forks > 0 && (
            <span><ForkGlyph /> {formatCount(preview.forks)}</span>
          )}
        </span>
      )}
    </span>
  )
}

// MARK: - YouTube / Bilibili 视频卡（共享组件，平台配置差异化）

function VideoPreview(props: { preview: RecordPreview }) {
  const { preview } = props
  return (
    <span className="preview-media preview-media--video">
      <PlatformChip preview={preview} />
      {preview.remoteImage ? (
        <RemoteThumb
          src={preview.remoteImage}
          alt={preview.title}
          fallback={<PlatformFallbackCard preview={preview} />}
        />
      ) : (
        <PlatformFallbackCard preview={preview} />
      )}
      {preview.playable && <PlayOverlay />}
    </span>
  )
}

// MARK: - X 动态卡

function XPreview(props: { preview: RecordPreview }) {
  const { preview } = props
  const initial = (preview.author ?? preview.platform.label).replace('@', '').charAt(0).toUpperCase()
  return (
    <span className="preview-media preview-media--auto preview-x">
      <PlatformChip preview={preview} />
      <span className="preview-x__author">
        <span className="preview-x__avatar" style={{ color: preview.platform.accent }}>
          {initial}
        </span>
        <span className="preview-x__id">
          <span className="preview-x__name">{preview.author ?? 'X'}</span>
        </span>
      </span>
      {preview.body && <span className="preview-x__body">{preview.body}</span>}
      {preview.remoteImage && (
        <RemoteThumb
          src={preview.remoteImage}
          alt={preview.title}
          variant="inline"
          fallback={<span className="preview-x__body preview-x__body--ghost">{preview.title}</span>}
        />
      )}
    </span>
  )
}

// MARK: - 通用网页 / 本地媒体

function GenericPreview(props: { preview: RecordPreview; mediaUrl: (name: string) => string }) {
  const { preview } = props
  if (preview.kind === 'local-media' && preview.localMedia) {
    return (
      <span className="preview-media">
        <img
          className="preview-thumb"
          src={props.mediaUrl(preview.localMedia)}
          alt={preview.title}
          loading="lazy"
        />
        {preview.playable && <PlayOverlay />}
      </span>
    )
  }
  if (preview.kind === 'text') {
    return (
      <span className="preview-media preview-media--auto preview-x">
        <span className="preview-x__body">{preview.body ?? preview.title}</span>
      </span>
    )
  }
  return (
    <span className="preview-media">
      <PlatformChip preview={preview} />
      {preview.remoteImage ? (
        <RemoteThumb
          src={preview.remoteImage}
          alt={preview.title}
          fallback={<PlatformFallbackCard preview={preview} />}
        />
      ) : (
        <PlatformFallbackCard preview={preview} />
      )}
    </span>
  )
}
