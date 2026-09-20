import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Coins, FileEdit, CalendarDays, ChevronRight } from 'lucide-react'
import { agentUsageGet, agentSessionChanges } from '../../lib/ipc'
import type { AiUsageDay, SessionFileChange } from '../../types'
import { Collapsible } from '../shared/Collapsible'

/**
 * 右栏 AI 态 · token 面板（v3.4.0 批次5；2026-09-20 反馈重设计为两卡版）。
 *
 * 出现时机 = aiChat 中间标签打开期间右栏原位替换小对话（⤢ 语义）。
 * 两卡（2026-09-20 反馈：只留 AI 数据、整栏不出滚动条、空间要填满）：
 *   ① 消耗卡 —— 今日大数字 + 近 7 天输入/输出双段堆叠柱状图（悬停看数值）+
 *      会话消耗 TOP（近 7 天，折叠区）；
 *   ② 改动文件卡 —— flex:1 吃掉剩余高度，条数按容器高度自适应（行高定长 26px，
 *      ResizeObserver 重算），点击回访该文件。
 * 数据只读拉取（agent:usage:get / agent:sessionChanges:get），30s 轻轮询跟随新消耗。
 */

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

function dayKey(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']
/** 改动文件行定长（h-[26px]）——自适应条数 = 容器高 ÷ 行高 */
const FILE_ROW_H = 26
const FILE_ROWS_MAX = 12
const POLL_MS = 30_000

interface Props {
  /** 改动文件行点击 → 打开该文件 */
  onOpenChangeFile: (relPath: string) => void
}

export function AiUsagePanel({ onOpenChangeFile }: Props) {
  const [days, setDays] = useState<Record<string, AiUsageDay>>({})
  const [changes, setChanges] = useState<SessionFileChange[]>([])
  const [topOpen, setTopOpen] = useState(false)
  const [visibleRows, setVisibleRows] = useState(6)
  const listRef = useRef<HTMLUListElement | null>(null)

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

  const today = useMemo(() => days[dayKey(0)] ?? { in: 0, out: 0, cache: 0, calls: 0, sessions: {} }, [days])
  const todayTotal = today.in + today.out

  /** 近 7 天按日取数（旧→新），供堆叠柱状图 */
  const chartDays = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const offset = 6 - i
    const key = dayKey(offset)
    const day = days[key] ?? { in: 0, out: 0 }
    const date = new Date()
    date.setDate(date.getDate() - offset)
    return {
      key,
      title: `${key.slice(5)} · ${fmtTok(day.in + day.out)} tokens（输入 ${fmtTok(day.in)} / 输出 ${fmtTok(day.out)}）`,
      label: offset === 0 ? '今' : WEEKDAY[date.getDay()],
      in: day.in,
      out: day.out,
      today: offset === 0,
    }
  }), [days])
  const chartMax = Math.max(...chartDays.map(d => d.in + d.out), 1)

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

  /** 改动文件：新→旧排序；可见条数按容器高度自适应（ResizeObserver） */
  const sortedChanges = useMemo(
    () => [...changes].sort((a, b) => b.at.localeCompare(a.at)),
    [changes],
  )
  const clipped = sortedChanges.length > visibleRows

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const compute = () => {
      setVisibleRows(Math.max(2, Math.min(FILE_ROWS_MAX, Math.floor(el.clientHeight / FILE_ROW_H))))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div data-wb="aiUsagePanel" className="kb-view-fade flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-2.5 pb-2.5 pt-2">
      {/* ── ① 消耗卡：今日大数字 + 7 天双段堆叠柱 + 会话 TOP（折叠） ── */}
      <div className="shrink-0 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--text-secondary)]">
          <Coins size={12} className="text-[var(--accent)]" />
          今日消耗
          <span className="ml-auto flex items-center gap-1 text-[10px] font-normal text-[var(--text-muted)]">
            <CalendarDays size={10} />
            {dayKey(0).slice(5)}
          </span>
        </div>
        <div className="mt-1 text-[19px] font-semibold leading-tight text-[var(--text-primary)]" title={`${today.calls} 次 LLM 调用`}>
          {fmtTok(todayTotal)}
          <small className="ml-1 text-[10.5px] font-normal text-[var(--text-muted)]">tokens</small>
        </div>
        <div className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
          输入 {fmtTok(today.in)} · 输出 {fmtTok(today.out)} · {today.calls} 次调用{today.cache > 0 && todayTotal > 0 ? ` · 缓存命中 ${Math.min(100, Math.round((today.cache / Math.max(todayTotal, 1)) * 100))}%` : ''}
        </div>

        {/* 近 7 天双段堆叠柱：浅=输入 / 深=输出，悬停看当日数值 */}
        <div className="mt-2 flex h-[96px] items-end gap-2" role="img" aria-label="近 7 天 token 消耗堆叠柱状图">
          {chartDays.map(d => (
            <div key={d.key} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={d.title}>
              <div
                className={`flex w-full max-w-[22px] flex-col justify-end overflow-hidden rounded-t-[5px] rounded-b-[2px] ${d.today ? 'outline outline-1 outline-[var(--accent)] outline-offset-1' : ''}`}
                style={{ height: `${Math.round(((d.in + d.out) / chartMax) * 100)}%` }}
              >
                <i
                  className="w-full bg-[var(--accent)]"
                  style={{ height: `${d.in + d.out > 0 ? Math.round((d.out / (d.in + d.out)) * 100) : 0}%` }}
                />
                <i
                  className="w-full bg-[color-mix(in_srgb,var(--accent)_50%,white)]"
                  style={{ height: `${d.in + d.out > 0 ? Math.round((d.in / (d.in + d.out)) * 100) : 0}%` }}
                />
              </div>
              <span className="text-[9px] not-italic text-[var(--text-disabled)]">{d.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]"><i className="inline-block h-2 w-2 rounded-[2px] bg-[color-mix(in_srgb,var(--accent)_50%,white)]" />输入</span>
          <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]"><i className="inline-block h-2 w-2 rounded-[2px] bg-[var(--accent)]" />输出</span>
          <span className="ml-auto text-[10px] text-[var(--text-disabled)]">悬停柱条看当日数值</span>
        </div>

        {/* 会话消耗 TOP（近 7 天）——折叠区，默认收起 */}
        <button
          onClick={() => setTopOpen(v => !v)}
          className="mt-2 flex w-full items-center gap-1.5 border-t border-[var(--border-color)] pt-2 text-left text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          会话消耗 TOP · 近 7 天
          <ChevronRight size={11} className={`kb-chevron ml-auto ${topOpen ? 'rotate-90' : ''}`} />
        </button>
        <Collapsible open={topOpen}>
          {() => (
            <div className="space-y-2 pt-2">
              {weekTop.length === 0 ? (
                <div className="py-1 text-[11px] text-[var(--text-muted)]">本周还没有对话消耗记录</div>
              ) : (
                weekTop.map(s => (
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
                ))
              )}
            </div>
          )}
        </Collapsible>
      </div>

      {/* ── ② 改动文件卡：flex:1 吃掉剩余高度，条数按容器高度自适应 ── */}
      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-2">
        <div className="flex shrink-0 items-center gap-1.5 text-[11.5px] font-semibold text-[var(--text-secondary)]">
          <FileEdit size={12} className="text-[var(--accent)]" />
          改动文件
          <span className="ml-auto text-[10px] font-normal text-[var(--text-muted)]">本次运行 · AI 读写 · 共 {sortedChanges.length} 条</span>
        </div>
        {sortedChanges.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-2 text-[11px] text-[var(--text-muted)]">暂无改动。让 AI 帮你写点什么试试。</div>
        ) : (
          <>
            <ul ref={listRef} className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-hidden">
              {sortedChanges.slice(0, visibleRows).map((c, i) => (
                <li key={`${c.at}-${i}`} className="h-[26px]">
                  <button
                    onClick={() => c.file && onOpenChangeFile(c.file)}
                    disabled={!c.file}
                    title={c.file ? `${c.action} · ${c.file}` : c.action}
                    className="group/cf flex h-full w-full items-center gap-1.5 rounded-md px-1 text-left transition-colors enabled:hover:bg-[var(--bg-hover)]"
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
            {clipped && (
              <div className="shrink-0 px-1 pt-1 text-[9.5px] text-[var(--text-disabled)]">
                仅显示最近 {visibleRows} 条 / 共 {sortedChanges.length} 条
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
