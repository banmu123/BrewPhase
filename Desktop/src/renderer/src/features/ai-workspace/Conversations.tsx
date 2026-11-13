import { useCallback, useEffect, useState } from 'react'
import type { AIConversationDetail, AIConversationSummary } from '@shared/contracts'
import { api } from '../../shared/api'
import { useI18n } from '../../i18n'
import { Markdown } from './markdown'

/**
 * 讨论记录：保存下来的 Multi-AI 结果。
 *
 * 列表只显示问题行；点进去看每个平台的回答与执行状态（failed/timeout
 * 也会如实标注——失败的讨论同样值得留着，它记录了当时发生了什么）。
 */
export function Conversations() {
  const { t } = useI18n()
  const [list, setList] = useState<AIConversationSummary[] | null>(null)
  const [detail, setDetail] = useState<AIConversationDetail | null>(null)

  const refresh = useCallback(async () => {
    try {
      setList(await api.aiChat.conversations())
    } catch {
      setList([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function open(id: string): Promise<void> {
    setDetail(await api.aiChat.conversation(id))
  }

  async function remove(id: string): Promise<void> {
    await api.aiChat.deleteConversation(id)
    setDetail(null)
    void refresh()
  }

  if (detail) {
    return (
      <section className="ai-conversations">
        <button className="direction__link" onClick={() => setDetail(null)}>
          ‹ {t.aiWorkspace.conversations.back}
        </button>
        <p className="ai-conversations__prompt">{detail.conversation.prompt}</p>
        <div className="ai-conversations__messages">
          {detail.messages.map((message) => (
            <article key={message.id} className="ai-conversations__message" data-role={message.role}>
              {message.role === 'user' ? (
                <>
                  <span className="overline">{t.aiWorkspace.conversations.question}</span>
                  <p>{message.content}</p>
                </>
              ) : (
                <>
                  <span className="ai-conversations__provider">
                    {message.provider === 'user' ? '' : (t.aiWorkspace.providers as Record<string, string>)[message.provider] ?? message.provider}
                    {message.status !== 'completed' && (
                      <span className="ai-conversations__status">
                        {t.aiWorkspace.taskState[message.status as keyof typeof t.aiWorkspace.taskState] ?? message.status}
                      </span>
                    )}
                  </span>
                  {message.content ? (
                    <Markdown source={message.content} />
                  ) : (
                    <p className="multi-ai__card-note">{t.aiWorkspace.result.noContent}</p>
                  )}
                </>
              )}
            </article>
          ))}
        </div>
      </section>
    )
  }

  return (
    <section className="ai-conversations">
      <p className="settings-lead">{t.aiWorkspace.conversations.lead}</p>
      {list && list.length === 0 && <p className="ai-conversations__empty">{t.aiWorkspace.conversations.empty}</p>}
      <div className="ai-conversations__list">
        {(list ?? []).map((item) => (
          <div key={item.id} className="ai-conversations__row">
            <button className="ai-conversations__open" onClick={() => void open(item.id)}>
              <span className="ai-conversations__title">{item.title || item.prompt}</span>
              <span className="ai-conversations__meta">
                {item.providers.split(',').filter(Boolean).map((p) => (t.aiWorkspace.providers as Record<string, string>)[p] ?? p).join(' · ')}
              </span>
            </button>
            <button className="direction__link direction__link--danger" onClick={() => void remove(item.id)}>
              {t.aiWorkspace.conversations.delete}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
