import { Gauge, ArrowRight } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { HelpHint } from '../../../components/shared/HelpHint'
import { SectionHead } from './SectionHead'
import type { AiToolUsage } from '../../../types'

/**
 * 设置 → AI → 用量（v3.9.0 收敛）。
 *
 * 本页**只留工具调用量**（月度上限 + 本月进度，与拦截逻辑同源）；原先的「Token 用量」块
 * 与按模型明细表**整体移交**给整窗「用量」模块 —— 那里有趋势 / 热力图 / 费用 / 账户额度，
 * 设置页再摆一份就是两处口径、两处维护（v3.9.0 方案 §6.1）。
 *
 * 用 `tab:open` 事件跳看板（App 侧通用监听），不直接 import 工作台内部函数。
 */
export function AiUsageTab({ usage, onUsageChange }: {
  usage: AiToolUsage
  onUsageChange: (u: AiToolUsage) => void
}) {
  const { s, update } = useSettings()

  const limit = s.aiToolMonthlyLimit ?? 0
  const pct = limit > 0 ? Math.min(100, Math.round((usage.used / limit) * 100)) : 0
  const overLimit = limit > 0 && usage.used >= limit

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
            <span className={`tabular-nums ${overLimit ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]'}`}>
              {usage.used} / {limit > 0 ? limit : '不限'}
            </span>
          </div>
          {limit > 0 && (
            <div className="mt-2 h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${overLimit ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          <label data-setting-anchor="aiTools.monthlyLimit" className="mt-3 pt-2.5 border-t border-[var(--border-color)] flex items-center justify-between gap-3 text-[12px]">
            {/* 括号里的边界说明进 ⓘ：标签只说"是什么"，"0 是什么意思"是 hover 才需要的信息 */}
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

        {/* Token / 费用 / 额度看板入口：明细唯一由「用量」模块承担 */}
        <button
          data-setting-anchor="aiTools.llmUsage"
          onClick={() => window.dispatchEvent(new CustomEvent('tab:open', { detail: { tab: 'usage' } }))}
          className="group mt-3 flex w-full max-w-md items-center justify-between rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-2.5 text-left hover:bg-[var(--bg-hover)]"
        >
          <span className="min-w-0">
            <span className="block text-[12.5px] text-[var(--text-primary)]">打开用量看板</span>
            <span className="block text-[11px] text-[var(--text-muted)]">全部 AI 调用的 token / 估算费用 / 账户额度</span>
          </span>
          <ArrowRight size={15} className="flex-none text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </div>
  )
}
