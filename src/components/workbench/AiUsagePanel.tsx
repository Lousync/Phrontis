import { useCallback, useEffect, useMemo, useState } from 'react'
import { Coins, FileEdit, History, CalendarDays } from 'lucide-react'
import { agentUsageGet, agentSessionChanges } from '../../lib/ipc'
import type { AiUsageDay, SessionFileChange } from '../../types'

/**
 * 右栏 AI 态 · token 面板（v3.4.0 批次5，方案 §4；原型 v15「AI 面板形态」）。
 *
 * 出现时机 = aiChat 中间标签打开期间右栏原位替换小对话（⤢ 语义：标签开着 → 面板，
 * 关标签 → 变回对话）。三卡：今日消耗 / 改动文件（本次运行 AI 读写）/ 会话消耗 TOP（近 7 天）。
 * 数据只读拉取（agent:usage:get / agent:sessionChanges:get），30s 轻轮询跟随新消耗。
 */

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

function todayKey(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const POLL_MS = 30_000

interface Props {
  /** 改动文件行点击 → 编辑区打开该文件 */
  onOpenChangeFile: (relPath: string) => void
}

export function AiUsagePanel({ onOpenChangeFile }: Props) {
  const [days, setDays] = useState<Record<string, AiUsageDay>>({})
  const [changes, setChanges] = useState<SessionFileChange[]>([])

  const refresh = useCallback(async () => {
    try {
      const [u, c] = await Promise.all([
        agentUsageGet(),
        agentSessionChanges(),
      ])
      setDays(u.days ?? {})
      setChanges(Array.isArray(c) ? c : [])
    } catch { /* 主进程未就绪等：保持旧数据 */ }
  }, [])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(t)
  }, [refresh])

  const today = useMemo(() => days[todayKey()] ?? { in: 0, out: 0, cache: 0, calls: 0, sessions: {} }, [days])

  /** 近 7 天按会话聚合（in+out），取 TOP 5 */
  const weekTop = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const agg = new Map<string, { title: string; in: number; out: number }>()
    for (const [key, day] of Object.entries(days)) {
      const t = new Date(`${key}T00:00:00`).getTime()
      if (!Number.isFinite(t) || t < cutoff) continue
      for (const [sid, s] of Object.entries(day.sessions ?? {})) {
        const cur = agg.get(sid) ?? { title: s.title, in: 0, out: 0 }
        cur.in += s.in
        cur.out += s.out
        if (s.title) cur.title = s.title
        agg.set(sid, cur)
      }
    }
    return [...agg.entries()]
      .map(([id, s]) => ({ id, ...s, total: s.in + s.out }))
      .filter(s => s.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
  }, [days])

  const weekMax = weekTop[0]?.total ?? 0
  const todayTotal = today.in + today.out

  return (
    <div data-wb="aiUsagePanel" className="kb-view-fade flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-2.5 pt-2">
      {/* 今日消耗 */}
      <div className="shrink-0 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--text-secondary)]">
          <Coins size={12} className="text-[var(--accent)]" />
          今日消耗
          <span className="ml-auto flex items-center gap-1 text-[10px] font-normal text-[var(--text-muted)]">
            <CalendarDays size={10} />
            {todayKey().slice(5)}
          </span>
        </div>
        <div className="mt-1 text-[19px] font-semibold leading-tight text-[var(--text-primary)]" title={`${today.calls} 次 LLM 调用`}>
          {todayTotal.toLocaleString()}
          <small className="ml-1 text-[10.5px] font-normal text-[var(--text-muted)]">
            tokens（输入 {fmtTok(today.in)} / 输出 {fmtTok(today.out)}）
          </small>
        </div>
      </div>

      {/* 改动文件（本次运行 · AI 读写；内存通道，重启即清） */}
      <div className="shrink-0 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--text-secondary)]">
          <FileEdit size={12} className="text-[var(--accent)]" />
          改动文件
          <span className="ml-auto text-[10px] font-normal text-[var(--text-muted)]">本次运行 · AI 读写</span>
        </div>
        {changes.length === 0 ? (
          <div className="py-2 text-[11px] text-[var(--text-muted)]">暂无改动。让 AI 帮你写点什么试试。</div>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {changes.slice(0, 10).map((c, i) => (
              <li key={`${c.at}-${i}`}>
                <button
                  onClick={() => c.file && onOpenChangeFile(c.file)}
                  disabled={!c.file}
                  title={c.file ? `${c.action} · ${c.file}` : c.action}
                  className="group/cf flex w-full items-center gap-1.5 rounded-md px-1 py-[3px] text-left transition-colors enabled:hover:bg-[var(--bg-hover)]"
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9.5px] font-semibold ${
                    c.op === 'A'
                      ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]'
                      : 'bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                  }`}>{c.op}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-primary)]">{c.target}</span>
                  <span className="shrink-0 text-[9.5px] text-[var(--text-disabled)]">{c.at.slice(11, 16)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 会话消耗 TOP（近 7 天，按会话聚合，输入/输出双色条） */}
      <div className="shrink-0 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--text-secondary)]">
          <History size={12} className="text-[var(--accent)]" />
          会话消耗 TOP
          <span className="ml-auto text-[10px] font-normal text-[var(--text-muted)]">近 7 天</span>
        </div>
        {weekTop.length === 0 ? (
          <div className="py-2 text-[11px] text-[var(--text-muted)]">本周还没有对话消耗记录</div>
        ) : (
          <div className="mt-1.5 space-y-2">
            {weekTop.map(s => (
              <div key={s.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-primary)]" title={s.title}>{s.title || '未命名会话'}</span>
                  <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">{fmtTok(s.total)}</span>
                </div>
                <div className="mt-1 flex h-[5px] w-full overflow-hidden rounded-full bg-[var(--bg-hover)]">
                  <i className="h-full bg-[var(--accent)]" style={{ width: weekMax > 0 ? `${(s.in / weekMax) * 100}%` : '0%' }} title={`输入 ${fmtTok(s.in)}`} />
                  <i className="h-full bg-[color-mix(in_srgb,var(--accent)_42%,#9db1f7)]" style={{ width: weekMax > 0 ? `${(s.out / weekMax) * 100}%` : '0%' }} title={`输出 ${fmtTok(s.out)}`} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
