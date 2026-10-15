import { useEffect, useState, useCallback } from 'react'
import { Gauge } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { llmGetUsage, llmUsageBreakdown } from '../../../lib/ipc'
import { prettyModelName } from '../../../lib/modelNames'
import { fmtTokens, exactTokens } from '../../../lib/numFormat'
import { HelpHint } from '../../../components/shared/HelpHint'
import { SectionHead } from './SectionHead'
import type { AiToolUsage, LlmUsageBreakdownEntry, LlmUsageInfo } from '../../../types'

/**
 * 设置 → AI → 用量（2026-10-13 独立成页签）。
 *
 * 之前两处统计分散且都不在"用量"这个概念下：
 *   · 「工具调用量」常驻在页签区**之外**——切页签它纹丝不动，看起来像页面串了域；
 *   · 「Token 用量」藏在「模型」页签里——找模型配置的人会撞见统计，找统计的人不会往模型翻。
 * 现在合成一页：工具调用量（含月度上限）+ 模型 token 用量与按供应商/模型细分。
 *
 * Token 用量块 2026-10-15 按原型 D 重排（tmp/ai-usage-proto，用户拍板）：
 *   本月大数字 + 次数/输入/输出三格 + 今日一行 + 明细表（列对齐 + 占比列）。
 *   数字走 fmtTokens 紧凑口径（千以下原样 / K / M，悬停看精确值）。
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
  // 本月次数与明细同源（breakdown 只聚合成功调用），和「今日 N 次」口径一致
  const monthCalls = breakdown.entries.reduce((sum, e) => sum + e.calls, 0)

  return (
    <div className="space-y-8">
      {/* 工具调用量（上限与统计同处一行，改完立即反映到进度条，不用等刷新） */}
      <div data-setting-anchor="aiTools.usage">
        <SectionHead title="工具调用量" className="mb-4"
          hint="本自然月内 AI 工具的调用总次数，内置工具与外部 MCP 工具均计入。" />
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
            {/* 括号里的边界说明（22 字）进 ⓘ：标签只说"是什么"，"0 是什么意思"是 hover 才需要的信息 */}
            <span className="flex items-center gap-1.5 text-[var(--text-muted)]">
              月度调用上限
              <HelpHint text="0 表示不限；超出后本月的调用会被拒绝，下月 1 日自动恢复。" />
            </span>
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
        </div>
      </div>

      {/* 模型 token 用量（仅统计不限额）。
          ★ 供应商名兜底：审计里记的是调用当时的名字，供应商被删/改名后可能为空 → 显示「已删除的供应商」，
            不再落到底层的 id（此前截图里出现过「1 · Qwen3.8 Flash」）。 */}
      <div data-setting-anchor="aiTools.llmUsage">
        <SectionHead title="Token 用量" className="mb-4"
          hint="本月与今日的模型消耗（↑ 输入 / ↓ 输出），仅统计，不设限额拦截。数字按 K/M 缩写（千以下原样），悬停看精确值。" />
        <div className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] max-w-md">
          <div className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 text-[var(--text-primary)]">
              <Gauge size={14} className="text-[var(--accent)]" />
              本月 tokens
            </span>
            <span className="text-[19px] font-semibold tabular-nums leading-none" title={exactTokens(llm.monthTokens)}>
              {fmtTokens(llm.monthTokens)}
            </span>
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            <UsageStat label="调用次数" value={String(monthCalls)} />
            <UsageStat label="输入 ↑" tone="in" value={fmtTokens(llm.monthPromptTokens ?? 0)} title={exactTokens(llm.monthPromptTokens ?? 0)} />
            <UsageStat label="输出 ↓" tone="out" value={fmtTokens(llm.monthCompletionTokens ?? 0)} title={exactTokens(llm.monthCompletionTokens ?? 0)} />
          </div>
          {/* 今日一行：字段是 2026-10-15 新增（llm:getUsage），旧快照没有 → 字段存在才显示 */}
          {llm.todayTokens != null && (
            <div className="mt-2.5 pt-2 border-t border-[var(--border-color)] flex items-center justify-between text-[11.5px] tabular-nums text-[var(--text-muted)]">
              <span>今日</span>
              <span>
                <span className="text-emerald-400">↑ {fmtTokens(llm.todayPromptTokens ?? 0)}</span>
                <span className="mx-1.5 text-red-400">↓ {fmtTokens(llm.todayCompletionTokens ?? 0)}</span>
                · {llm.todayCalls ?? 0} 次
              </span>
            </div>
          )}
          {breakdown.entries.length > 0 ? (
            <div className="mt-3 pt-2.5 border-t border-[var(--border-color)]">
              <p className="text-[11px] text-[var(--text-muted)] mb-1">按供应商/模型细分（{breakdown.month}）</p>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-[10px] text-[var(--text-disabled)]">
                    <th className="text-left font-normal py-1">供应商 · 模型</th>
                    <th className="text-right font-normal py-1 pl-2">次数</th>
                    <th className="text-right font-normal py-1 pl-2">输入</th>
                    <th className="text-right font-normal py-1 pl-2">输出</th>
                    <th className="text-right font-normal py-1 pl-2">合计</th>
                    <th className="text-right font-normal py-1 pl-2">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.entries.map(e => {
                    const name = e.provider?.trim() || '已删除的供应商'
                    const full = `${e.provider || name} · ${prettyModelName(e.model)}`
                    const share = llm.monthTokens > 0 ? `${(e.tokens / llm.monthTokens * 100).toFixed(1)}%` : '—'
                    return (
                      <tr key={`${e.providerId}-${e.model}`} className="border-t border-[var(--border-color)]">
                        <td className="py-1.5 pr-2 max-w-0 truncate" title={full}>
                          <span className="text-[var(--text-secondary)]">{name}</span>
                          <span className="text-[var(--text-muted)]"> · {prettyModelName(e.model)}</span>
                        </td>
                        <td className="text-right tabular-nums text-[var(--text-muted)] pl-2">{e.calls}</td>
                        <td className="text-right tabular-nums text-emerald-400 pl-2" title={exactTokens(e.promptTokens)}>{fmtTokens(e.promptTokens)}</td>
                        <td className="text-right tabular-nums text-red-400 pl-2" title={exactTokens(e.completionTokens)}>{fmtTokens(e.completionTokens)}</td>
                        <td className="text-right tabular-nums font-medium text-[var(--text-primary)] pl-2" title={exactTokens(e.tokens)}>{fmtTokens(e.tokens)}</td>
                        <td className="text-right tabular-nums text-[var(--text-muted)] pl-2">{share}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 pt-2.5 border-t border-[var(--border-color)] text-[11px] text-[var(--text-muted)]">
              本月还没有模型调用记录。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** 概览三格（次数 / 输入 / 输出）：底色同卡片系，数字右对齐由外层网格居中呈现 */
function UsageStat({ label, value, title, tone }: {
  label: string
  value: string
  title?: string
  tone?: 'in' | 'out'
}) {
  return (
    <div className="rounded-md bg-[var(--bg-hover)] px-2 py-1.5 text-center">
      <div className="text-[10px] text-[var(--text-muted)]">{label}</div>
      <div
        className={`text-[12.5px] font-medium tabular-nums ${
          tone === 'in' ? 'text-emerald-400' : tone === 'out' ? 'text-red-400' : 'text-[var(--text-primary)]'
        }`}
        title={title}
      >
        {value}
      </div>
    </div>
  )
}
