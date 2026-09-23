/**
 * 划词引用胶囊条（会话引用形式）：显示在 ChatBody 输入区上方。
 *
 * 两处宿主共用：
 *   - 悬浮侧栏（AssistantPanel/index.tsx）
 *   - 工作台右栏 docked AI 态（WorkbenchRightPanel.tsx，B-26 补入）
 *
 * 行为：折叠态（默认）只显示「N 条对话引用」按钮 + 全部清空按钮；
 *       展开态列出每条引用（截断 3 行）+ 逐条移除。
 *       发送时由宿主的 `prepareBody` 把引用嵌入消息正文（markdown 引用块）并清空。
 *
 * ★ 本组件只负责**渲染与交互**，不持有引用数据（数据由宿主 state + ref 管理）。
 */
import { useState } from 'react'
import { Quote, X } from 'lucide-react'

export function QuoteChips({ quotes, onRemove, onRemoveAll }: {
  quotes: string[]
  onRemove: (index: number) => void
  onRemoveAll: () => void
}) {
  const [open, setOpen] = useState(false)
  if (quotes.length === 0) return null
  return (
    <div className="mb-1 flex items-center gap-1.5">
      <button onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
        title="点击查看/管理引用片段">
        <Quote size={10} className="text-[var(--accent)]" />
        <span>{quotes.length} 条对话引用</span>
      </button>
      <button onClick={() => { setOpen(false); onRemoveAll() }} title="移除全部引用"
        className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
        <X size={10} />
      </button>
      {open && (
        <div className="mt-1 space-y-1 w-full">
          {quotes.map((q, i) => (
            <div key={`${i}-${q.slice(0, 16)}`} className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <Quote size={10} className="mt-[3px] shrink-0 text-[var(--accent)]" />
              <span className="flex-1 min-w-0 text-[11px] leading-[1.5] text-[var(--text-secondary)] line-clamp-3">【引用 {i + 1}】{q}</span>
              <button onClick={() => onRemove(i)} title="移除此引用"
                className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
