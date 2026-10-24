import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { fmtThinkSec, ThinkEvent, ToolEvent } from './ProcessRail'

/**
 * 完成后的「过程摘要行 + 可展开事件流」（v3.10.0 事件流）。
 *
 * 生成态 `StreamBubble` 退场后由它接管：默认收起，头部交代「思考多久 / 几个工具」，
 * 展开后与生成态共用同一套 `.kb-ev-rail`，避免过程前后两套观感。
 *
 * 三条口径：
 *   ① **默认收起、永不自动展开**；
 *   ② 展开体不再做 5 步截断 —— 用户主动点开就是要看完整过程；
 *   ③ 0 思考 + 0 工具时不出现（纯 LLM 且无 reasoning 的轮次没有过程可交代）。
 *
 * 思考正文不落库（主进程只存 `thinkingMs`），所以完成态思考行只有时长、没有展开体。
 */

export interface TraceRowView {
  key: string
  kind: 'think' | 'tool'
  /** 工具中文动作标签，或「思考」 */
  label: string
  /** 工具的目标（实时事件才有；trace 不落库） */
  target?: string
  ok: boolean
  /** 工具耗时；思考行为该轮 thinkingMs */
  durationMs?: number
}

export function ProcessSummary({ rows }: { rows: TraceRowView[] }) {
  const { s } = useSettings()
  const showThinking = s.aiShowThinking !== false
  const [open, setOpen] = useState(false)

  const visible = showThinking ? rows : rows.filter(r => r.kind !== 'think')
  const toolCount = visible.filter(r => r.kind === 'tool').length
  const thinkMs = visible.reduce((a, r) => a + (r.kind === 'think' ? (r.durationMs ?? 0) : 0), 0)
  if (visible.length === 0) return null

  const headParts: string[] = []
  if (thinkMs > 0) headParts.push(`思考 ${fmtThinkSec(thinkMs)}`)
  if (toolCount > 0) headParts.push(`${toolCount} 个工具`)
  const head = `过程${headParts.length > 0 ? ` · ${headParts.join(' · ')}` : ''}`

  return (
    <div className="kb-procsum">
      <button type="button" className="kb-procsum__head" aria-expanded={open}
        title="展开本轮的过程与工具调用"
        onClick={() => setOpen(v => !v)}>
        <span>{head}</span>
        <ChevronDown size={11} className={`kb-chevron ${open ? 'rotate-180' : ''}`} />
      </button>
      {/* 懒挂内层子树：外层 grid 常驻 DOM，靠 open 类切 grid-template-rows */}
      <div className={`kb-collapse${open ? ' open' : ''}`}>
        <div>
          <div className="kb-ev-rail">
            {visible.map(r => r.kind === 'think'
              ? <ThinkEvent key={r.key} durationMs={r.durationMs} />
              : <ToolEvent key={r.key} label={r.label} target={r.target}
                  state={r.ok ? 'done' : 'fail'} durationMs={r.durationMs} />)}
          </div>
        </div>
      </div>
    </div>
  )
}
