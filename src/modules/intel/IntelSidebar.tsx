import { useState } from 'react'
import { ChevronDown, Star } from 'lucide-react'
import type { IntelAiRec, IntelCustomSource, IntelSection } from '../../types'
import { SOURCE_META, INTEL_SOURCE_KEYS, SECTIONS, SECTION_META } from '../../lib/intelPure'

/**
 * 情报模块侧栏（v3.13.0 报纸化，docs/intel-module-plan.md D13）：
 * 源列表按版面分四组（科技 / 时政·国内 / 国际 / 财经），组头点击 = 筛选该版面，
 * 组头右侧 chevron 可折叠源列表（.kb-chevron 令牌，折叠态组件内记忆）；
 * 自定义 RSS 源挂进其所属版面组（名取 name，附 📰 标记）。
 * 「我的」分组：✨ AI 推荐（有推荐才渲染；副标题 query；hover ✕ 清空）＋ ♥ 收藏夹。
 */

export type IntelFeedFilter = 'all' | 'fav' | 'airec' | IntelSection | (`custom:${string}` | IntelSourceKeyOfBuiltin)

/** 内置源 key（filter 联合里单列出来，避免和 custom: 前缀混在一个模板串里丢提示） */
type IntelSourceKeyOfBuiltin = (typeof INTEL_SOURCE_KEYS)[number]

interface Props {
  active: IntelFeedFilter
  counts: { perSource: Record<string, number>; perSection: Record<string, number>; all: number; fav: number; airec: number }
  aiRec: IntelAiRec | null
  customSources: IntelCustomSource[]
  onSelect: (f: IntelFeedFilter) => void
  onClearAiRec: () => void
}

export function IntelSidebar({ active, counts, aiRec, customSources, onSelect, onClearAiRec }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const toggle = (sec: string) => setCollapsed((prev) => {
    const n = new Set(prev)
    if (n.has(sec)) n.delete(sec)
    else n.add(sec)
    return n
  })
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-1.5 py-2">
      <div className="px-2.5 pb-1 pt-1 text-[10.5px] tracking-wider text-[var(--text-muted)]">内容来源</div>
      <SideRow
        active={active === 'all'}
        label="全部"
        count={counts.all}
        onClick={() => onSelect('all')}
      />
      {SECTIONS.map((sec) => {
        const builtin = INTEL_SOURCE_KEYS.filter((k) => SOURCE_META[k].section === sec)
        const customs = customSources.filter((c) => c.section === sec)
        const groupCount = (counts.perSection[sec] ?? 0)
        if (builtin.length === 0 && customs.length === 0) return null
        const open = !collapsed.has(sec)
        return (
          <div key={sec} className="mt-0.5">
            <div
              className={`group/sec flex min-h-[30px] cursor-pointer select-none items-center gap-1.5 rounded-md px-2.5 py-0.5 text-[12.5px] transition-colors ${
                active === sec ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              }`}
              onClick={() => onSelect(sec)}
              title={`筛选「${SECTION_META[sec].label}」版面（共 ${groupCount} 条）`}
            >
              <button
                onClick={(e) => { e.stopPropagation(); toggle(sec) }}
                title={open ? '折叠该版面源列表' : '展开该版面源列表'}
                className="flex size-4 shrink-0 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <ChevronDown size={12} className={`kb-chevron ${open ? '' : '-rotate-90'}`} />
              </button>
              <span className="min-w-0 flex-1 truncate font-medium">{SECTION_META[sec].label}</span>
              <span className={`shrink-0 text-[11px] ${active === sec ? 'opacity-80' : 'text-[var(--text-muted)]'}`}>{groupCount}</span>
            </div>
            {/* kb-collapse 既有范式：外层 grid 常驻 DOM 驱动 0fr↔1fr，箭头 .kb-chevron + rotate 属性 */}
            <div className={`kb-collapse ml-[13px]${open ? ' open' : ''}`}>
              <div>
                {builtin.map((key) => (
                  <SideRow
                    key={key}
                    active={active === key}
                    label={SOURCE_META[key].label}
                    count={counts.perSource[key] ?? 0}
                    dot={SOURCE_META[key].fg}
                    onClick={() => onSelect(key)}
                  />
                ))}
                {customs.map((c) => (
                  <SideRow
                    key={`custom:${c.id}`}
                    active={active === `custom:${c.id}`}
                    label={c.name}
                    count={counts.perSource[`custom:${c.id}`] ?? 0}
                    dot="#4f8f6a"
                    title={`${c.url}${c.enabled ? '' : '（已停用，设置 › 模块 › 情报）'}`}
                    labelIcon={<span className="shrink-0 text-[10px] text-[var(--text-muted)]">📰</span>}
                    onClick={() => onSelect(`custom:${c.id}`)}
                  />
                ))}
              </div>
            </div>
          </div>
        )
      })}
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
