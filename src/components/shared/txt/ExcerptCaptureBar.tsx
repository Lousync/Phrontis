import { Highlighter, X } from 'lucide-react'
import type { SelectionRect } from '../pdf/TextSelectionBar'

/**
 * TXT 划选摘录浮条（书架阅读器 · 摘录先行批次）。
 * 与 PDF 的 TextSelectionBar 同语言（fixed 锚定选区、越界翻面），但职责单一：
 * 复制 / 存为摘录 / 关闭——TXT 阅读器不做翻译/讲题（那是 PDF 文本层的 AI 工具链）。
 */
export function ExcerptCaptureBar({ rect, text, onCreate, onClose }: {
  rect: SelectionRect
  text: string
  onCreate: (text: string) => void
  onClose: () => void
}) {
  if (!rect) return null
  const BAR_H = 34
  const showAbove = rect.top > BAR_H + 56
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 260))
  const top = showAbove ? rect.top - BAR_H - 8 : rect.top + rect.height + 8
  return (
    <div className="kb-pop fixed z-[60] select-none" style={{ left, top }}>
      <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 px-1 py-0.5 text-[12px] text-[var(--text-secondary)] shadow-lg backdrop-blur">
        <button onClick={() => onCreate(text)} title="存为摘录（右栏阅读侧栏可回看/跳回）"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <Highlighter size={12.5} />摘录
        </button>
        <div className="mx-0.5 h-4 w-px bg-[var(--border-color)]" />
        <button onClick={() => { void navigator.clipboard?.writeText(text).catch(() => {}) }} title="复制选中文本"
          className="rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">复制</button>
        <button onClick={onClose} title="关闭" className="rounded p-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <X size={11} />
        </button>
      </div>
    </div>
  )
}
