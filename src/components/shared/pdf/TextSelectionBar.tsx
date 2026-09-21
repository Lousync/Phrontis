import { useState } from 'react'
import { X, Copy, Languages, GraduationCap, Loader2, Highlighter, Lightbulb, Check } from 'lucide-react'
import { EXCERPT_COLOR_IDS, EXCERPT_COLOR_NAMES, type ExcerptColor, type ExcerptType } from '../../../types'
import { useSettings } from '../../../lib/SettingsContext'

export interface SelectionRect { left: number; top: number; width: number; height: number }

export interface TranslateState {
  loading: boolean
  text: string
  error?: string
  /** 命中 translationRepo 缓存时提示「已缓存」，避免用户误以为又付了一轮 LLM */
  cached?: boolean
}

interface Props {
  /** 选区几何（viewport 坐标）；null = 不显示 */
  rect: SelectionRect | null
  translate: TranslateState | null
  onCopy: () => void
  onTranslate: () => void
  /** 问 AI：跳转 AI 教学并带上选段上下文（2026-09-21 反馈：阅读器不出题，quiz 入口已整条移除） */
  onAsk: () => void
  onClose: () => void
  /** 存为摘录（摘录先行批次）：传入才渲染色点/摘录/想法；无摘录域的调用方不传 */
  onCreateExcerpt?: (color: ExcerptColor, type: ExcerptType, note?: string) => void
}

/**
 * 划词 AI 工具条（方案 §6）：文本层选区浮条 —— 5 色点 / 摘录 / 想法 / 问 AI / 翻译（带缓存）/ 复制。
 * fixed 定位按选区 rect 锚定，越界自动翻面。色板单源 EXCERPT_COLOR_IDS，上次用色落 settings。
 */
export function TextSelectionBar({ rect, translate, onCopy, onTranslate, onAsk, onClose, onCreateExcerpt }: Props) {
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
    if (!onCreateExcerpt) return
    update('excerptLastColor', color)
    onCreateExcerpt(color, 'highlight')
  }
  const doExcerpt = () => {
    if (!onCreateExcerpt) return
    update('excerptLastColor', lastColor)
    onCreateExcerpt(lastColor, 'excerpt')
  }
  const doIdea = () => {
    if (!onCreateExcerpt) return
    update('excerptLastColor', lastColor)
    onCreateExcerpt(lastColor, 'idea', ideaText.trim() || undefined)
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
        {onCreateExcerpt && (
          <>
            <button onClick={doExcerpt} title="存为摘录（右栏阅读侧栏可回看/跳回）"
              className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
              <Highlighter size={12.5} />摘录
            </button>
            <button onClick={() => setIdeaOpen((v) => !v)} title="记想法（独立类型，存为备注）"
              className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
              <Lightbulb size={12.5} />想法
            </button>
          </>
        )}
        <button onClick={onAsk} title="跳转 AI 教学，带着选段上下文讲解"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <GraduationCap size={12.5} />问 AI
        </button>
        <button onClick={onTranslate} title="翻译（带缓存）"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          {translate?.loading ? <Loader2 size={12.5} className="animate-spin" /> : <Languages size={12.5} />}翻译
        </button>
        <button onClick={onCopy} title="复制选中文本"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <Copy size={12.5} />复制
        </button>
        <button onClick={onClose} title="关闭" className="rounded p-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <X size={11} />
        </button>
      </div>
      {onCreateExcerpt && ideaOpen && (
        <div className="kb-pop mt-1 w-[280px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 p-2 shadow-lg backdrop-blur">
          <textarea autoFocus value={ideaText} onChange={(e) => setIdeaText(e.target.value)} placeholder="一句话想法…"
            className="w-full resize-none rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1.5 py-1 text-[11.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" rows={2} />
          <div className="mt-1 flex justify-end gap-1">
            <button onClick={() => { setIdeaText(''); setIdeaOpen(false) }} className="rounded px-2 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">取消</button>
            <button onClick={doIdea} className="flex items-center gap-1 rounded bg-[var(--accent)] px-2 py-0.5 text-[11px] text-white hover:opacity-90"><Check size={11} />保存并高亮</button>
          </div>
        </div>
      )}
      {translate && !translate.loading && (
        <div className="kb-view-in mt-1 max-w-[420px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 px-2.5 py-2 text-[12px] leading-relaxed text-[var(--text-primary)] shadow-lg backdrop-blur">
          {translate.error ? (
            <span className="text-[var(--text-warning)]">翻译失败：{translate.error}</span>
          ) : (
            <>
              {translate.cached && <span className="mr-1.5 text-[10.5px] text-[var(--text-tertiary)]">缓存</span>}
              <span className="whitespace-pre-wrap">{translate.text}</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
