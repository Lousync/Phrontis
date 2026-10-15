import { Info } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * 设置页的「标题 + 说明」（2026-10-13 帮助披露改造 · docs/help-disclosure-pattern.md 形态 B）。
 *
 * 起因：AI 设置重排后，几乎每个小节都挂着一段常驻解释（为什么这么做、原来在哪、边界在哪），
 * 整页读下来是散文，控件反而被埋住。按披露规范处理 —— **说明一字不删，只是默认收起**，
 * 悬停标题行平滑展开（`grid-rows 0fr → 1fr`，不用 max-height 硬切），标题旁的 ⓘ 是入口。
 *
 * 两个刻意的取舍：
 *   · 悬停感应范围 = 标题行这一小条，不是整个小节 —— 小节里往往有长列表/输入框，
 *     若整块响应，鼠标划过控件时说明展开会把下面的内容顶走，比常驻还烦。
 *   · 没有 hint 时不留任何图标：能删的复述句就直接删，不要为了"有个 ⓘ"而留半句话。
 *
 * h2 = 页内大节（15px），h3 = 大节里的子节（13px）。`right` 放标题右侧的操作按钮。
 */
export function SectionHead({ title, hint, right, size = 'lg', className }: {
  title: ReactNode
  hint?: ReactNode
  right?: ReactNode
  size?: 'lg' | 'md'
  className?: string
}) {
  const titleText = (
    <>
      <span className="truncate">{title}</span>
      {hint ? <Info size={12} className="shrink-0 text-[var(--text-disabled)]" /> : null}
    </>
  )
  const line = size === 'lg'
    ? <h2 className="flex items-center gap-1.5 min-w-0 text-[15px] font-medium text-[var(--text-primary)]">{titleText}</h2>
    : <h3 className="flex items-center gap-1.5 min-w-0 text-[13px] font-medium text-[var(--text-primary)]">{titleText}</h3>

  return (
    <div className={`group ${className ?? 'mb-3'}`}>
      <div className="flex items-center justify-between gap-2">
        {line}
        {right}
      </div>
      {hint ? (
        <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 motion-reduce:transition-none group-hover:grid-rows-[1fr]">
          <div className="overflow-hidden">
            <div className="pt-1 text-[11.5px] text-[var(--text-muted)] leading-relaxed max-w-md">{hint}</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
