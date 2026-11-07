import type { AppInfo } from '@shared/contracts'
import { SYNC_PROTOCOL_VERSION } from '@shared/contracts'

/**
 * 更多：应用信息、数据位置、以及**还没实现**的东西说清楚。
 *
 * 这一页的诚实性很重要：局域网同步只完成了协议 v1 的结构定义，界面不能
 * 假装「点一下就能配对」。所以这里显示的是状态，不是开关。
 */
export function SettingsPage({ info }: { info: AppInfo | null }) {
  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__titles">
          <h1 className="page-title">更多</h1>
          <p className="page-sub">本地优先 · 不传云端</p>
        </div>
      </header>

      <div className="page-body">
      <div className="columns" data-inspector="off">
      <section className="column">
        <div className="section">
          <span className="overline">应用</span>
          <div className="note">
            版本 {info?.appVersion ?? '—'}
            <br />
            数据库 schema v{info?.dbSchemaVersion ?? '—'}
            <br />
            同步协议 v{SYNC_PROTOCOL_VERSION}
            <br />
            平台 {info?.platform ?? '—'}
          </div>
        </div>

        <div className="section">
          <span className="overline">数据</span>
          <div className="note">
            全部数据存在本机的 SQLite 与 media 目录里，不上传、不登录、不需要网络。
            <br />
            <span className="mono" style={{ fontSize: 10 }}>
              {info?.dataDir ?? '—'}
            </span>
          </div>
        </div>
      </section>

      <section className="column column--main">
        <div className="detail-body">
          <span className="overline">局域网同步（Phase 2）</span>
          <h2 className="detail-title">还没实现，只有协议结构。</h2>
          <p className="note">
            Desktop 将作为 Host 跑一个本地 HTTP 服务，通过 Bonjour 广播，用一次性配对码
            与 iOS 交换设备凭据；之后按 change log 增量同步，媒体按块传输并校验 SHA-256，删除用
            tombstone。协议类型已经落在 <span className="mono">src/shared/contracts/sync</span>，
            服务端与配对界面在下一阶段实现。
          </p>
          <div className="hairline" />
          <span className="overline">这一版明确没有做</span>
          <ul className="note" style={{ paddingLeft: 18, lineHeight: 2 }}>
            <li>局域网服务与配对二维码</li>
            <li>媒体文件传输与冲突合并</li>
            <li>Reminders 的系统通知调度（只存意图）</li>
            <li>画布手绘工具、连线与分组</li>
            <li>视频播放器（只有数据与封面）</li>
          </ul>
        </div>
      </section>
      </div>
      </div>
    </div>
  )
}
