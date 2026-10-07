import { useState } from 'react'
import { Highlighter, Languages, Sparkles, X, Copy, Lightbulb, Check } from 'lucide-react'
import type { SelectionRect } from '../pdf/TextSelectionBar'
import { EXCERPT_COLOR_IDS, EXCERPT_COLOR_NAMES, type ExcerptColor, type ExcerptType } from '../../../types'
import { useSettings } from '../../../lib/SettingsContext'

/**
 * TXT 划选浮条（书架阅读器 · 摘录先行批次；2026-09-20「两个勾画菜单」合并轮扩为全量）。
 * 与 PDF 的 TextSelectionBar 同语言（fixed 锚定选区、越界翻面）：
 * 5 色点 / 摘录 / 想法 / 问 AI / 翻译 / 复制——问 AI 与翻译经 `ai-assistant:selection-action` 事件
 * 借用 AssistantPanel 的问答/翻译链路（阅读域内全局浮钮已让位，本条是唯一菜单）。
 *
 * 多色高亮：最左 5 个色点（色板单源 EXCERPT_COLOR_IDS），点色即「以该色高亮」建 type:'highlight'；
 * 上次用色落 settings（excerptLastColor），点色/摘录/想法均同步记忆。
 */
export function ExcerptCaptureBar({ rect, text, onCreate, onAsk, onTranslate, onClose }: {
  rect: SelectionRect
  text: string
  onCreate: (text: string, color: ExcerptColor, type: ExcerptType, note?: string) => void
  /** 问 AI：AssistantPanel 会话引用链路（事件桥） */
  onAsk?: (text: string) => void
  /** 翻译：AssistantPanel 翻译卡片链路（事件桥，带选区矩形定位） */
  onTranslate?: (text: string, rect: SelectionRect) => void
  onClose: () => void
}) {
  const { s, update } = useSettings()
  const lastColor = (EXCERPT_COLOR_IDS.includes(s.excerptLastColor as ExcerptColor) ? s.excerptLastColor : 'y') as ExcerptColor
  const [ideaOpen, setIdeaOpen] = useState(false)
  const [ideaText, setIdeaText] = useState('')

  if (!rect) return null
  const BAR_H = 34
  const showAbove = rect.top > BAR_H + 56
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 340))
  const top = showAbove ? rect.top - BAR_H - 8 : rect.top + rect.height + 8

  const pickColor = (color: ExcerptColor) => {
    update('excerptLastColor', color)
    onCreate(text, color, 'highlight')
  }
  const doExcerpt = () => {
    update('excerptLastColor', lastColor)
    onCreate(text, lastColor, 'excerpt')
  }
  const doIdea = () => {
    update('excerptLastColor', lastColor)
    onCreate(text, lastColor, 'idea', ideaText.trim() || undefined)
    setIdeaText('')
    setIdeaOpen(false)
  }

  return (
    <div className="kb-pop fixed z-[60] select-none" style={{ left, top }}>
      <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 px-1 py-0.5 text-[12px] text-[var(--text-secondary)] shadow-lg backdrop-blur">
        {EXCERPT_COLOR_IDS.map((c) => (
          <button key={c} onClick={() => pickColor(c)} title={`以${EXCERPT_COLOR_NAMES[c]}色高亮`}
            className={`kb-exc-dot kb-exc-${c} hover:scale-110 transition-transform`} />
        ))}
        <div className="mx-0.5 h-4 w-px bg-[var(--border-color)]" />
        <button onClick={doExcerpt} title="存为摘录（右栏阅读侧栏可回看/跳回）"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <Highlighter size={12.5} />摘录
        </button>
        <button onClick={() => setIdeaOpen((v) => !v)} title="记想法（独立类型，存为备注）"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <Lightbulb size={12.5} />想法
        </button>
        <div className="mx-0.5 h-4 w-px bg-[var(--border-color)]" />
        {onAsk && (
          <button onClick={() => onAsk(text)} title="选中片段发给 AI（收进侧栏引用胶囊）"
            className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <Sparkles size={12.5} />问 AI
          </button>
        )}
        {onTranslate && (
          <button onClick={() => onTranslate(text, rect)} title="翻译选中文本"
            className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <Languages size={12.5} />翻译
          </button>
        )}
        <button onClick={() => { void navigator.clipboard?.writeText(text).catch(() => {}) }} title="复制选中文本"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <Copy size={12.5} />复制
        </button>
        <button onClick={onClose} title="关闭" className="rounded p-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <X size={11} />
        </button>
      </div>
      {ideaOpen && (
        <div className="kb-pop mt-1 w-[280px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 p-2 shadow-lg backdrop-blur">
          <div className="mb-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">「{text}」</div>
          <textarea autoFocus value={ideaText} onChange={(e) => setIdeaText(e.target.value)} placeholder="一句话想法…"
            className="w-full resize-none rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1.5 py-1 text-[11.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" rows={2} />
          <div className="mt-1 flex justify-end gap-1">
            <button onClick={() => { setIdeaText(''); setIdeaOpen(false) }} className="rounded px-2 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">取消</button>
            <button onClick={doIdea} className="flex items-center gap-1 rounded bg-[var(--accent)] px-2 py-0.5 text-[11px] text-white hover:opacity-90"><Check size={11} />保存并高亮</button>
          </div>
        </div>
      )}
    </div>
  )
}
