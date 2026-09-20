import { Highlighter, Languages, Sparkles, X, Copy } from 'lucide-react'
import type { SelectionRect } from '../pdf/TextSelectionBar'

/**
 * TXT 划选浮条（书架阅读器 · 摘录先行批次；2026-09-20「两个勾画菜单」合并轮扩为全量）。
 * 与 PDF 的 TextSelectionBar 同语言（fixed 锚定选区、越界翻面）：
 * 摘录 / 问 AI / 翻译 / 复制——问 AI 与翻译经 `ai-assistant:selection-action` 事件
 * 借用 AssistantPanel 的问答/翻译链路（阅读域内全局浮钮已让位，本条是唯一菜单）。
 */
export function ExcerptCaptureBar({ rect, text, onCreate, onAsk, onTranslate, onClose }: {
  rect: SelectionRect
  text: string
  onCreate: (text: string) => void
  /** 问 AI：AssistantPanel 会话引用链路（事件桥） */
  onAsk?: (text: string) => void
  /** 翻译：AssistantPanel 翻译卡片链路（事件桥，带选区矩形定位） */
  onTranslate?: (text: string, rect: SelectionRect) => void
  onClose: () => void
}) {
  if (!rect) return null
  const BAR_H = 34
  const showAbove = rect.top > BAR_H + 56
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 340))
  const top = showAbove ? rect.top - BAR_H - 8 : rect.top + rect.height + 8
  return (
    <div className="kb-pop fixed z-[60] select-none" style={{ left, top }}>
      <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 px-1 py-0.5 text-[12px] text-[var(--text-secondary)] shadow-lg backdrop-blur">
        <button onClick={() => onCreate(text)} title="存为摘录（右栏阅读侧栏可回看/跳回）"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <Highlighter size={12.5} />摘录
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
    </div>
  )
}
