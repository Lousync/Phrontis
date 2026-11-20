import { useLayoutEffect, useRef, useState } from 'react'
import { Highlighter, Languages, Sparkles, X, Copy, Lightbulb, Check } from 'lucide-react'
import type { SelectionRect } from '../pdf/TextSelectionBar'
import { EXCERPT_COLOR_IDS, EXCERPT_COLOR_NAMES, type ExcerptColor, type ExcerptType } from '../../../types'
import { useSettings } from '../../../lib/SettingsContext'
import { FLOAT_GAP, clampFloatingLeft, floatingBounds, placeFloatingVertically, toCssBottom } from '../../../lib/floatingPlacement'

/**
 * TXT 划选浮条（书架阅读器 · 摘录先行批次；2026-09-20「两个勾画菜单」合并轮扩为全量）。
 * 与 PDF 的 TextSelectionBar 同语言（fixed 锚定选区、越界翻面）：
 * 5 色点 / 摘录 / 想法 / 问 AI / 翻译 / 复制——问 AI 与翻译经 `ai-assistant:selection-action` 事件
 * 借用 AssistantPanel 的问答/翻译链路（阅读域内全局浮钮已让位，本条是唯一菜单）。
 *
 * 定位口径见 `lib/floatingPlacement`：横向夹进**阅读面**（不是整个窗口）并与悬浮 AI 侧栏取交，
 * 否则选区靠右时浮条右半截会滑进侧栏底下（表象：右侧按钮像被盖住、点不到）；放不下就限宽换行。
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

  // 定位：先渲染再量宽高（useLayoutEffect 在绘制前跑，不会闪），尺寸变化（开「想法」框）后重摆
  const barRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; top?: number; bottom?: number; maxW: number } | null>(null)
  const rectTop = rect?.top ?? 0
  const rectLeft = rect?.left ?? 0
  const rectHeight = rect?.height ?? 0
  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const place = () => {
      const bounds = floatingBounds(el)
      const maxW = Math.max(180, bounds.right - bounds.left - FLOAT_GAP * 2)
      const left = clampFloatingLeft(rectLeft, Math.min(el.offsetWidth, maxW), bounds)
      // 浮条习惯在选区上方（不压住要点的原文），上方实在没位置才翻到下方
      const v = placeFloatingVertically({
        anchorTop: rectTop,
        anchorBottom: rectTop + rectHeight,
        bounds,
        cap: 360,
        prefer: 'above',
        minUsable: 46,
      })
      setBox({
        left,
        top: v.top,
        bottom: v.bottomEdge !== undefined ? toCssBottom(v.bottomEdge) : undefined,
        maxW,
      })
    }
    place()
    // 换行 / 「想法」框展开都会改尺寸 —— 尺寸变了就重摆，别让浮条自己顶出可视区
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [rectLeft, rectTop, rectHeight])

  if (!rect) return null

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
    <div ref={barRef} className="kb-pop origin-top fixed z-[60] select-none"
      style={{ left: box?.left ?? rectLeft, top: box?.top, bottom: box?.bottom, maxWidth: box?.maxW }}>
      <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 px-1 py-0.5 text-[12px] text-[var(--text-secondary)] shadow-lg backdrop-blur">
        {EXCERPT_COLOR_IDS.map((c) => (
          <button key={c} onClick={() => pickColor(c)} data-tip={`以${EXCERPT_COLOR_NAMES[c]}色高亮`} aria-label={`以${EXCERPT_COLOR_NAMES[c]}色高亮`}
            className={`kb-exc-dot kb-exc-${c} hover:scale-110 transition-transform`} />
        ))}
        <div className="mx-0.5 h-4 w-px bg-[var(--border-color)]" />
        <button onClick={doExcerpt} data-tip="存为摘录（右栏阅读侧栏可回看/跳回）" aria-label="存为摘录（右栏阅读侧栏可回看/跳回）"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <Highlighter size={12.5} />摘录
        </button>
        <button onClick={() => setIdeaOpen((v) => !v)} data-tip="记想法（独立类型，存为备注）" aria-label="记想法（独立类型，存为备注）"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <Lightbulb size={12.5} />想法
        </button>
        <div className="mx-0.5 h-4 w-px bg-[var(--border-color)]" />
        {onAsk && (
          <button onClick={() => onAsk(text)} data-tip="选中片段发给 AI（收进侧栏引用胶囊）" aria-label="选中片段发给 AI（收进侧栏引用胶囊）"
            className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <Sparkles size={12.5} />问 AI
          </button>
        )}
        {onTranslate && (
          <button onClick={() => onTranslate(text, rect)} data-tip="翻译选中文本" aria-label="翻译选中文本"
            className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <Languages size={12.5} />翻译
          </button>
        )}
        <button onClick={() => { void navigator.clipboard?.writeText(text).catch(() => {}) }} data-tip="复制选中文本" aria-label="复制选中文本"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <Copy size={12.5} />复制
        </button>
        <button onClick={onClose} data-tip="关闭" aria-label="关闭" className="rounded p-1 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <X size={11} />
        </button>
      </div>
      {ideaOpen && (
        <div className="kb-pop origin-top mt-1 w-[280px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 p-2 shadow-lg backdrop-blur">
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
