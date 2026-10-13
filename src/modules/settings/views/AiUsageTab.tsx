import { useEffect, useState, useCallback } from 'react'
import { Gauge } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { llmGetUsage, llmUsageBreakdown } from '../../../lib/ipc'
import { prettyModelName } from '../../../lib/modelNames'
import type { AiToolUsage, LlmUsageBreakdownEntry, LlmUsageInfo } from '../../../types'

/**
 * 设置 → AI 工具 → 用量（2026-10-13 独立成页签）。
 *
 * 之前两处统计分散且都不在"用量"这个概念下：
 *   · 「工具调用量」常驻在页签区**之外**——切页签它纹丝不动，看起来像页面串了域；
 *   · 「Token 用量」藏在「模型」页签里——找模型配置的人会撞见统计，找统计的人不会往模型翻。
 * 现在合成一页：工具调用量（含月度上限）+ 模型 token 用量与按供应商/模型细分。
 */
export function AiUsageTab({ usage, onUsageChange }: {
  usage: AiToolUsage
  onUsageChange: (u: AiToolUsage) => void
}) {
  const { s, update } = useSettings()
  const [llm, setLlm] = useState<LlmUsageInfo>({ monthTokens: 0 })
  const [breakdown, setBreakdown] = useState<{ month: string; entries: LlmUsageBreakdownEntry[] }>({ month: '', entries: [] })

  const refresh = useCallback(async () => {
    try {
      const [u, b] = await Promise.all([llmGetUsage(), llmUsageBreakdown()])
      setLlm(u)
      setBreakdown(b)
    } catch { /* 统计读不到不该挡住整个设置页 */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const limit = s.aiToolMonthlyLimit ?? 0
  const pct = limit > 0 ? Math.min(100, Math.round((usage.used / limit) * 100)) : 0
  const overLimit = limit > 0 && usage.used >= limit

  return (
    <div className="space-y-8">
      {/* 工具调用量（上限与统计同处一行，改完立即反映到进度条，不用等刷新） */}
      <div data-setting-anchor="aiTools.usage">
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">工具调用量</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">
          本自然月内所有 AI 工具调用次数（内置工具与 MCP 外部工具均计入）。
        </p>
        <div className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] max-w-md">
          <div className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 text-[var(--text-primary)]">
              <Gauge size={14} className="text-[var(--accent)]" />
              本月调用
            </span>
            <span className={`tabular-nums ${overLimit ? 'text-red-400' : 'text-[var(--text-secondary)]'}`}>
              {usage.used} / {limit > 0 ? limit : '不限'}
            </span>
          </div>
          {limit > 0 && (
            <div className="mt-2 h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${overLimit ? 'bg-red-500' : 'bg-[var(--accent)]'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          <label data-setting-anchor="aiTools.monthlyLimit" className="mt-3 pt-2.5 border-t border-[var(--border-color)] flex items-center justify-between gap-3 text-[12px]">
            <span className="text-[var(--text-muted)]">月度调用上限（0 = 不限）</span>
            <input
              type="number"
              min={0}
              value={String(limit)}
              onChange={e => {
                const n = Math.max(0, Math.floor(Number(e.target.value) || 0))
                void update('aiToolMonthlyLimit', n)
                onUsageChange({ ...usage, limit: n })
              }}
              className="w-28 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-right outline-none focus:border-[var(--accent)]"
            />
          </label>
          <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed mt-1.5">
            达到上限后调用将被拒绝。
          </p>
        </div>
      </div>

      {/* 模型 token 用量（仅统计不限额） */}
      <div data-setting-anchor="aiTools.llmUsage">
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">Token 用量</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">
          本月累计消耗（↑输入 ↓输出，仅统计、不设限额拦截）；每次对话回复下方的 ↑↓ 标记为单轮消耗。
        </p>
        <div className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] max-w-md">
          <div className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 text-[var(--text-primary)]">
              <Gauge size={14} className="text-[var(--accent)]" />
              本月 tokens
            </span>
            <span className="tabular-nums text-[var(--text-secondary)]">{llm.monthTokens.toLocaleString()}</span>
          </div>
          {(llm.monthPromptTokens != null || llm.monthCompletionTokens != null) && (
            <div className="mt-0.5 flex items-center justify-end gap-3 text-[11px] tabular-nums text-[var(--text-muted)]">
              <span>↑ {(llm.monthPromptTokens ?? 0).toLocaleString()} 输入</span>
              <span>↓ {(llm.monthCompletionTokens ?? 0).toLocaleString()} 输出</span>
            </div>
          )}
          {breakdown.entries.length > 0 && (
            <div className="mt-3 pt-2.5 border-t border-[var(--border-color)]">
              <p className="text-[11px] text-[var(--text-muted)] mb-1.5">按供应商/模型细分（{breakdown.month}）</p>
              <div className="space-y-1">
                {breakdown.entries.slice(0, 8).map(e => (
                  <div key={`${e.providerId}-${e.model}`} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-[var(--text-secondary)]" title={`${e.provider} · ${e.model}`}>{e.provider} · {prettyModelName(e.model)}</span>
                    <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{e.calls} 次 · ↑{e.promptTokens.toLocaleString()} ↓{e.completionTokens.toLocaleString()} · 合计 {e.tokens.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed mt-3 pt-2.5 border-t border-[var(--border-color)]">
            单次调用的 maxTokens 上限在「模型」页签的「对话输出」里设置。
          </p>
        </div>
      </div>
    </div>
  )
}
