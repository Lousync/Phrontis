import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronLeft, Eye, Pencil } from 'lucide-react'
import type { SummaryRecord } from '../../../types'
import { saveSummary, openExternal } from '../../../lib/ipc'
import { summaryLabel } from '../../../lib/summary'
import { MarkdownPreview } from '../../../components/shared/MarkdownPreview'
import { SummaryStats, NextTasks } from '../components/SummaryPanel'

const KIND_BADGE: Record<SummaryRecord['kind'], { text: string; cls: string }> = {
  week: { text: '周', cls: 'bg-[var(--accent)]/12 text-[var(--accent)]' },
  month: { text: '月', cls: 'bg-[var(--info)]/12 text-[var(--info)]' },
  year: { text: '年', cls: 'bg-[var(--warning)]/12 text-[var(--warning)]' },
}

/**
 * 层级总结文档（周 / 月 / 年）—— 一段窗口一份文件，正文由用户写。
 *
 * 与日记的区别（别把它塞回编辑器组件）：
 *   · 日记是「每天一篇」，MarkdownEditor 与 entryId 强耦合（心情 / 标签 / 日期 / 模板全是日记专属）；
 *   · 这里是「一段窗口一份」，只有正文 + 实时统计 + 下期任务三块，所以用轻量编辑区
 *     （textarea ⇄ 预览切换），不拉 Monaco —— 顺带避免总结页把 monaco 主包拖进首屏。
 *
 * 统计**不落库**：每次进视图按窗口实时查（DP v3.2.0 第 12 项拍板③），
 * 于是补录了打卡/补写了日记之后，总结里的数字会跟着变，而正文（复盘文字）是用户自己的。
 */
export function SummaryDoc({ summary, onBack, onSaved }: {
  summary: SummaryRecord
  onBack: () => void
  onSaved: (s: SummaryRecord) => void
}) {
  const [content, setContent] = useState(summary.contentMd)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)

  const dirtyRef = useRef(false)
  const latestRef = useRef(content)
  latestRef.current = content
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 回调经 ref 转发：父方传内联箭头时，若进依赖数组会让「卸载前落盘」的 effect 每次渲染都重建
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  // 切换总结（同一视图内换窗口）时重置编辑态
  useEffect(() => {
    setContent(summary.contentMd)
    dirtyRef.current = false
    setSavedAt(null)
  }, [summary.id, summary.contentMd])

  /** 落盘（幂等：没有未保存改动就直接返回） */
  const flush = useCallback(async (): Promise<void> => {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    setSaving(true)
    try {
      const saved = await saveSummary(summary.id, latestRef.current)
      onSavedRef.current(saved)
      setSavedAt(new Date())
    } catch (e) {
      console.error('[SummaryDoc] 保存失败', e)
      dirtyRef.current = true // 交还给下一次机会，避免静默丢字
    } finally {
      setSaving(false)
    }
  }, [summary.id])

  // 卸载前落盘：离开总结视图（返回列表 / 切模块）不能让没保存的复盘文字丢掉
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    void flush()
  }, [flush])

  const onChange = useCallback((v: string) => {
    setContent(v)
    dirtyRef.current = true
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void flush() }, 900)
  }, [flush])

  const badge = KIND_BADGE[summary.kind]
  const title = summary.title || summaryLabel(summary.kind, summary.start, summary.end)

  return (
    <div className="kb-view-in flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2.5 border-b border-[var(--border-color)] px-8 py-3">
        <button
          onClick={onBack}
          className="flex items-center gap-0.5 rounded pl-0.5 pr-1.5 py-1 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ChevronLeft size={14} /> 返回
        </button>
        <span className={`rounded px-1.5 py-[1px] text-[11px] font-medium ${badge.cls}`}>{badge.text}</span>
        <span className="text-[14px] font-medium text-[var(--text-primary)]">{title}</span>
        <span className="text-[11.5px] text-[var(--text-muted)] tabular-nums">{summary.start} ~ {summary.end}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">
            {saving ? '保存中…' : savedAt ? '已保存' : ''}
          </span>
          <button
            onClick={() => void flush()}
            disabled={saving}
            className="rounded border border-[var(--border-color)] px-2 py-[3px] text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
          >
            保存
          </button>
          <button
            onClick={() => setPreview((v) => !v)}
            title={preview ? '回到编辑' : '预览'}
            className="flex items-center gap-1 rounded border border-[var(--border-color)] px-2 py-[3px] text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            {preview ? <><Pencil size={11} /> 编辑</> : <><Eye size={11} /> 预览</>}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6">
          <h2 className="text-[22px] font-bold text-[var(--text-primary)]">📊 {title}</h2>

          <SummaryStats start={summary.start} end={summary.end} />

          {preview ? (
            <div className="mt-8">
              {content.trim()
                ? <MarkdownPreview content={content} onLinkClick={(href) => openExternal(href)} />
                : <p className="text-[13px] text-[var(--text-muted)]">还没有正文。</p>}
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => onChange(e.target.value)}
              placeholder="这一期的复盘写在这里…（自动保存）"
              spellCheck={false}
              className="mt-8 min-h-[220px] w-full resize-none border-none bg-transparent text-[15px] leading-7 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
            />
          )}

          <NextTasks kind={summary.kind} start={summary.start} end={summary.end} />
        </div>
      </div>
    </div>
  )
}
