import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * 完成后的「工具摘要行 + 可展开清单」（docs/ai-reply-loading-plan.md §3.2 / R8）。
 *
 * 为什么要有它：生成中**完全不显示**工具行（用户明确认为「工具调用的展示对体验价值不大」，
 * 是有意为之），那么过程就不该在完成后又整片铺回来 —— 成熟工具的做法都是把过程收成一行
 * （ChatGPT / Claude 的 "Thought for Ns"）。三条口径：
 *   ① **默认收起、永不自动展开**；
 *   ② 展开体最多列 MAX_TOOL_STEPS_SHOWN 步，其余折成「还有 M 步」（模块内常量，不进设置项）；
 *   ③ **0 个工具时不出现这一行**（纯 LLM 轮次没有过程可交代）。
 *
 * 收起/展开走既有 `.kb-collapse`（grid-rows 过渡），不另造高度补间（铁律 13）。
 */

/** 展开体一次最多列几步 */
const MAX_TOOL_STEPS_SHOWN = 5

export interface TraceRowView {
  key: string
  /** 工具名（已可读化）或「思考」 */
  label: string
  /** 工具的目标（文件路径 / 查询串…）；非工具行不传 */
  target?: string
  /** 这一步算不算「工具」—— 摘要行的「用了 N 个工具」只数它 */
  isTool: boolean
  ok: boolean
  durationMs?: number
}

export function ToolSummary({ rows }: { rows: TraceRowView[] }) {
  const [open, setOpen] = useState(false)
  const toolCount = rows.filter(r => r.isTool).length
  if (toolCount === 0) return null

  const totalMs = rows.reduce((a, r) => a + (r.durationMs ?? 0), 0)
  const shown = rows.slice(0, MAX_TOOL_STEPS_SHOWN)
  const rest = rows.length - shown.length

  return (
    <div className="kb-toolsum">
      <button type="button" className="kb-toolsum__head" aria-expanded={open}
        title="展开本轮的工具调用清单"
        onClick={() => setOpen(v => !v)}>
        <span>用了 {toolCount} 个工具{totalMs > 0 ? ` · 总耗时 ${(totalMs / 1000).toFixed(1)}s` : ''}</span>
        <ChevronDown size={11} className={`kb-chevron ${open ? 'rotate-180' : ''}`} />
      </button>
      {/* 懒挂内层子树：外层 grid 常驻 DOM，靠 open 类切 grid-template-rows */}
      <div className={`kb-collapse${open ? ' open' : ''}`}>
        <div>
          <div className="kb-toolsum__list">
            {shown.map(r => (
              <div key={r.key} className="kb-toolsum__item">
                <span className={`kb-toolsum__dot${r.ok ? '' : ' is-fail'}`} />
                <span>{r.label}</span>
                {r.target && <code title={r.target}>{r.target}</code>}
                {r.durationMs != null && r.durationMs > 0 && (
                  <span className="dur">{(r.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>
            ))}
            {rest > 0 && <div className="kb-toolsum__more">还有 {rest} 步</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
