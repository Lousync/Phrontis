import { useMemo, useState } from 'react'
import type { UsageModelRow } from '../../types'
import { fmtTokens, exactTokens, fmtUsd, providerLabel } from './usageModel'

type SortKey = 'calls' | 'i0' | 'ir' | 'iw' | 'out' | 'tot' | 'cost' | 'share'

const COLS: Array<{ k: SortKey | 'name'; label: string; right?: boolean }> = [
  { k: 'name', label: '供应商 · 模型' },
  { k: 'calls', label: '调用数', right: true },
  { k: 'i0', label: '未缓存输入', right: true },
  { k: 'ir', label: '缓存读', right: true },
  { k: 'iw', label: '缓存写', right: true },
  { k: 'out', label: '输出', right: true },
  { k: 'tot', label: '合计', right: true },
  { k: 'cost', label: '估算费用', right: true },
  { k: 'share', label: '占比', right: true },
]

const totOf = (r: UsageModelRow): number => r.i0 + r.ir + r.iw + r.out

export function UsageBreakdown({ models }: { models: UsageModelRow[] }) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'tot', dir: -1 })

  const rows = useMemo(() => {
    const val = (r: UsageModelRow): number => {
      switch (sort.k) {
        case 'calls': return r.calls
        case 'i0': return r.i0
        case 'ir': return r.ir
        case 'iw': return r.iw
        case 'out': return r.out
        case 'cost': return r.cost ?? -1
        case 'share': return r.share
        default: return totOf(r)
      }
    }
    return [...models].sort((a, b) => (val(a) - val(b)) * sort.dir)
  }, [models, sort])

  if (models.length === 0) {
    return <div className="grid place-items-center py-6 text-[12px] text-[var(--text-muted)]">这段时间没有按模型记账</div>
  }

  const click = (k: SortKey) => setSort((s) => s.k === k ? { k, dir: s.dir === 1 ? -1 : 1 } : { k, dir: -1 })

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="text-[11px] text-[var(--text-muted)]">
            {COLS.map((c) => (
              <th
                key={c.k}
                onClick={() => c.k !== 'name' && click(c.k as SortKey)}
                className={`whitespace-nowrap border-b border-[var(--border-color)] px-2 py-1.5 font-medium ${c.right ? 'text-right' : 'text-left'} ${c.k !== 'name' ? 'cursor-pointer select-none hover:text-[var(--text-primary)]' : ''}`}
              >
                {c.label}{sort.k === c.k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="text-[var(--text-primary)] hover:bg-[var(--bg-hover)]/60">
              <td className="whitespace-nowrap px-2 py-1.5">
                <span className="text-[var(--text-muted)]">{providerLabel(r.provider)}</span>
                <span className="mx-1 text-[var(--text-disabled)]">·</span>
                <span>{r.model}</span>
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.calls}</td>
              <td className="px-2 py-1.5 text-right tabular-nums" title={exactTokens(r.i0)}>{fmtTokens(r.i0)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums" title={exactTokens(r.ir)}>{fmtTokens(r.ir)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-[var(--text-muted)]" title="上游未上报缓存写即为 0">{fmtTokens(r.iw)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums" title={exactTokens(r.out)}>{fmtTokens(r.out)}</td>
              <td className="px-2 py-1.5 text-right font-medium tabular-nums" title={exactTokens(totOf(r))}>{fmtTokens(totOf(r))}</td>
              <td className={`px-2 py-1.5 text-right tabular-nums ${r.cost === null ? 'text-[var(--text-muted)]' : ''}`}>{fmtUsd(r.cost)}</td>
              <td className="px-2 py-1.5">
                <div className="flex items-center justify-end gap-1.5">
                  <span className="h-[5px] w-[46px] overflow-hidden rounded-full bg-[var(--bg-hover)]">
                    <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.round(r.share * 100)}%` }} />
                  </span>
                  <span className="w-9 text-right tabular-nums text-[var(--text-muted)]">{(r.share * 100).toFixed(1)}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
