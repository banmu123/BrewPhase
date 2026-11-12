import { useEffect, useState } from 'react'
import { prepareImage, sendImage } from '../lib/image-transfer'
import { MAX_SELECTED_TEXT, clampText, type CaptureDraft } from '../shared/protocol'

/**
 * 截图编辑页：预览 → 选中的文字（可编辑）→ 我的备注 → 保存。
 *
 * 截图本身与页面信息来自 `chrome.storage.session` 的临时草稿；保存成功后
 * 立即清除，取消也会清除。图片以分块方式经 Service Worker → Native Host
 * 送进 Desktop，不在扩展里留副本。
 */

type Status = 'loading' | 'ready' | 'saving' | 'saved' | 'failed'

export function CapturePage() {
  const [draft, setDraft] = useState<CaptureDraft | null>(null)
  const [selectedText, setSelectedText] = useState('')
  const [note, setNote] = useState('')
  const [status, setStatus] = useState<Status>('loading')
  const [message, setMessage] = useState('')
  const [recordId, setRecordId] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const stored = await chrome.storage.session.get('captureDraft')
      const value = stored.captureDraft as CaptureDraft | undefined
      if (!value || value.kind !== 'screenshot') {
        setStatus('failed')
        setMessage('没有可编辑的截图草稿')
        return
      }
      setDraft(value)
      setSelectedText(value.selectedText)
      setNote(value.note)
      setStatus('ready')
    })()
  }, [])

  async function save(): Promise<void> {
    if (!draft || status === 'saving' || status === 'saved') return
    setStatus('saving')
    setMessage('')

    try {
      const prepared = await prepareImage(draft.dataUrl)
      const response = await sendImage(prepared, {
        title: draft.page.title,
        sourceUrl: draft.page.url,
        selectedText: clampText(selectedText.trim(), MAX_SELECTED_TEXT),
        note
      })

      if (response.success) {
        setStatus('saved')
        setRecordId(response.data?.recordId ?? null)
        await chrome.storage.session.remove('captureDraft')
        return
      }

      setStatus('failed')
      setMessage(errorText(response.code))
    } catch (error) {
      setStatus('failed')
      setMessage(error instanceof Error ? error.message : '保存失败，请重试')
    }
  }

  async function cancel(): Promise<void> {
    await chrome.storage.session.remove('captureDraft')
    window.close()
  }

  return (
    <div className="capture">
      <header className="capture__head">
        <div className="capture__brand">
          <span className="capture__mark" aria-hidden="true">
            <CupIcon />
          </span>
          <span className="capture__name">BrewPhase</span>
          <span className="capture__product">Capture</span>
        </div>
        <span className="capture__hint">截图只会保存在这台电脑上</span>
      </header>

      {status === 'loading' && <div className="capture__loading">正在读取截图…</div>}

      {status === 'failed' && !draft && (
        <div className="capture__empty">
          <h1>截图草稿已失效</h1>
          <p>{message}</p>
          <button type="button" className="button" onClick={() => window.close()}>
            关闭
          </button>
        </div>
      )}

      {draft && (
        <div className="capture__body">
          <div className="capture__preview">
            <img src={draft.dataUrl} alt="当前页面截图预览" />
          </div>

          <section className="capture__source">
            <span className="overline">当前网页</span>
            <h1>{draft.page.title || draft.page.domain}</h1>
            <p>{draft.page.url}</p>
          </section>

          <label className="capture__field">
            <span className="overline">选中的文字</span>
            <textarea
              value={selectedText}
              onChange={(event) => setSelectedText(event.target.value)}
              placeholder="这段文字来自网页；可以删改，也可以留空"
              rows={4}
              maxLength={MAX_SELECTED_TEXT}
            />
          </label>

          <label className="capture__field">
            <span className="overline">我的备注</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="写下你对这张截图的理解或后续想法…"
              rows={4}
              maxLength={20_000}
            />
          </label>

          {status === 'saved' ? (
            <div className="capture__saved">
              <div>
                <strong>已保存到 BrewPhase Records</strong>
                {recordId && <span className="mono"> {recordId.slice(0, 8)}</span>}
              </div>
              <button type="button" className="button" onClick={() => window.close()}>
                关闭
              </button>
            </div>
          ) : (
            <div className="capture__actions">
              <button type="button" className="button button--ghost" onClick={() => void cancel()}>
                取消
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => void save()}
                disabled={status === 'saving'}
              >
                {status === 'saving' ? '正在保存…' : '保存到 BrewPhase'}
              </button>
            </div>
          )}

          {status === 'failed' && message && <p className="capture__error">{message}</p>}
        </div>
      )}
    </div>
  )
}

function errorText(code: string): string {
  if (code === 'APP_NOT_RUNNING') return '请先启动 BrewPhase Desktop'
  if (code === 'INVALID_REQUEST') return '图片数据没有通过校验，请重试'
  return '保存失败，请稍后重试'
}

function CupIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 8h11v6.2A4.8 4.8 0 0 1 11.2 19H9.8A4.8 4.8 0 0 1 5 14.2V8Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M16 9.5h1.6a2.4 2.4 0 0 1 0 4.8H16" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
