import { Star } from 'lucide-react'
import type { IntelAiRec, IntelSourceKey } from '../../types'
import { SOURCE_META, INTEL_SOURCE_KEYS } from '../../lib/intelPure'

/**
 * 情报模块侧栏（v3.12.0，docs/intel-module-plan.md §6.3）：
 * portal 挂进 WorkbenchLeftPanel 模块态 slot（App 收集 slot DOM 传模块，照 ScheduleSidebar 同型）。
 * 源列表 8 项（SOURCE_META 渲染名 + 徽标色 + 计数，点击 = feed 筛选该源）；
 * 「我的」分组：✨ AI 推荐（有推荐才渲染；副标题 query；hover ✕ 清空）＋ ♥ 收藏夹。
 */

export type IntelFeedFilter = 'all' | 'fav' | 'airec' | IntelSourceKey

interface Props {
  active: IntelFeedFilter
  counts: { perSource: Record<string, number>; all: number; fav: number; airec: number }
  aiRec: IntelAiRec | null
  onSelect: (f: IntelFeedFilter) => void
  onClearAiRec: () => void
}

export function IntelSidebar({ active, counts, aiRec, onSelect, onClearAiRec }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-1.5 py-2">
      <div className="px-2.5 pb-1 pt-1 text-[10.5px] tracking-wider text-[var(--text-muted)]">内容来源</div>
      <SideRow
        active={active === 'all'}
        label="全部"
        count={counts.all}
        onClick={() => onSelect('all')}
      />
      {INTEL_SOURCE_KEYS.map((key) => (
        <SideRow
          key={key}
          active={active === key}
          label={SOURCE_META[key].label}
          count={counts.perSource[key] ?? 0}
          dot={SOURCE_META[key].fg}
          onClick={() => onSelect(key)}
        />
      ))}
      <div className="px-2.5 pb-1 pt-3 text-[10.5px] tracking-wider text-[var(--text-muted)]">我的</div>
      {aiRec && aiRec.ids.length > 0 && (
        <SideRow
          active={active === 'airec'}
          label="✨ AI 推荐"
          count={aiRec.ids.length}
          title={aiRec.query ? `来自询问：「${aiRec.query}」——问过 AI 后出现，再问即刷新` : undefined}
          onClear={onClearAiRec}
          clearTitle="清空 AI 推荐"
          onClick={() => onSelect('airec')}
        />
      )}
      <SideRow
        active={active === 'fav'}
        label="♥ 收藏夹"
        labelIcon={<Star size={12} className={active === 'fav' ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'} />}
        count={counts.fav}
        onClick={() => onSelect('fav')}
      />
    </div>
  )
}

function SideRow({ active, label, count, dot, onClick, onClear, title, clearTitle, labelIcon }: {
  active: boolean
  label: string
  count: number
  dot?: string
  onClick: () => void
  onClear?: () => void
  title?: string
  clearTitle?: string
  labelIcon?: React.ReactNode
}) {
  return (
    <div
      data-intel-filter={label}
      onClick={onClick}
      title={title}
      className={`group flex min-h-[30px] cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-0.5 text-[12.5px] transition-colors ${
        active
          ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
          : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
      }`}
    >
      {dot && <span className="size-2 shrink-0 rounded-full" style={{ background: dot }} />}
      {labelIcon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {onClear && (
        <button
          onClick={(e) => { e.stopPropagation(); onClear() }}
          title={clearTitle}
          className="hidden size-[15px] shrink-0 items-center justify-center rounded-[3px] text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] group-hover:flex"
        >
          ✕
        </button>
      )}
      <span className={`shrink-0 text-[11px] ${active ? 'opacity-80' : 'text-[var(--text-muted)]'}`}>{count}</span>
    </div>
  )
}
