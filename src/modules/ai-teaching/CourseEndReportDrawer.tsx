import { useEffect, useState } from 'react'
import { Loader2, ScrollText, X } from 'lucide-react'
import { aiTeachCourseGetEndReport } from '../../lib/ipc'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'

/** AI教学 · 结课报告抽屉（右侧 520px；正文走 MarkdownPreview，复用全局抽屉动效） */
export function CourseEndReportDrawer({ wsId, onClose }: { wsId: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void aiTeachCourseGetEndReport(wsId).then(r => {
      if (!alive) return
      setContent(r?.markdown ?? '')
      setLoading(false)
    }).catch(() => { if (alive) { setContent(''); setLoading(false) } })
    return () => { alive = false }
  }, [wsId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[120] flex justify-end kb-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="flex h-full w-[520px] max-w-[94vw] flex-col border-l border-[var(--border-color)] bg-[var(--bg-primary)] shadow-2xl kb-view-in">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-4 py-2.5">
          <ScrollText size={13} className="text-[var(--accent)]" />
          <span className="text-[13px] font-medium text-[var(--text-primary)]">结课报告</span>
          <span className="flex-1" />
          <button onClick={onClose} aria-label="关闭" data-tip="关闭"
            className="rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><X size={13} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]"><Loader2 size={13} className="animate-spin" />加载中</div>
          ) : content ? (
            <MarkdownPreview content={content} />
          ) : (
            <div className="text-[12px] text-[var(--text-muted)]">还没有结课报告</div>
          )}
        </div>
      </div>
    </div>
  )
}
