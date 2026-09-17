import { X, Copy, Languages, GraduationCap, ListChecks, Loader2 } from 'lucide-react'

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
  /** intent：讲题（解释）/ 出题（生成练习，落 quiz 围栏闭环） */
  onAsk: (intent: 'explain' | 'quiz') => void
  onClose: () => void
}

/**
 * 划词 AI 工具条（方案 §6）：文本层选区浮条 —— 复制 / 翻译（translationRepo 缓存通道，
 * 结果内嵌卡片纯展示）/ AI 讲题 / 出题（kb-ai-teaching-ask 跳转 AI 教学新会话）。
 * fixed 定位按选区 rect 锚定，越界自动翻面。
 */
export function TextSelectionBar({ rect, translate, onCopy, onTranslate, onAsk, onClose }: Props) {
  if (!rect) return null
  const BAR_H = 34
  const showAbove = rect.top > BAR_H + 56
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 300))
  const top = showAbove ? rect.top - BAR_H - 8 : rect.top + rect.height + 8
  return (
    <div className="kb-pop fixed z-[60] select-none" style={{ left, top }}>
      <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 px-1 py-0.5 text-[12px] text-[var(--text-secondary)] shadow-lg backdrop-blur">
        <button onClick={onCopy} title="复制选中文本"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <Copy size={12.5} />复制
        </button>
        <button onClick={onTranslate} title="翻译（带缓存）"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          {translate?.loading ? <Loader2 size={12.5} className="animate-spin" /> : <Languages size={12.5} />}翻译
        </button>
        <div className="mx-0.5 h-4 w-px bg-[var(--border-color)]" />
        <button onClick={() => onAsk('explain')} title="跳转 AI 教学，带着选段上下文讲解"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <GraduationCap size={12.5} />讲题
        </button>
        <button onClick={() => onAsk('quiz')} title="根据选段出练习题（落知识库可作答）"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <ListChecks size={12.5} />出题
        </button>
        <button onClick={onClose} title="关闭" className="rounded p-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <X size={11} />
        </button>
      </div>
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
