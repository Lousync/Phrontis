/**
 * 图谱左栏（2026-09-21 用户需求）：图谱态的分区导航 + 进群。
 * 交互口径（原型 v2 拍板）：单击行为只有一种 —— 进群 = 画布只画该群（GraphView 按
 * applyGroupFilter 裁数据 + fit 适屏），再点同一行退出回全库；无「变灰淡化」过渡态。
 * 版式口径与原型一致：圆角行 + 彩点 + pill 计数；选中行左侧 accent 竖条；无说明性长文。
 */
import { useMemo, useState } from 'react'
import type { GraphIndexData, GraphNode } from '../../../../lib/graphTypes'
import { buildGraphGroups, groupMemberPages, isPackTag, type GraphGroupInfo } from './graphGroups'

interface Props {
  data: GraphIndexData
  activeKey: string | null
  onSelect: (key: string | null) => void
  /** 底部清单点页名 → 在编辑器打开（与选中卡片「在编辑器中打开」同链路） */
  onOpenPage: (n: GraphNode) => void
}

const KIND_COLOR: Record<string, string> = {
  all: 'var(--text-muted)',
  dir: 'var(--text-secondary)',
  tag: 'var(--success)',
  orphan: 'var(--text-disabled)',
  unresolved: 'var(--warning)',
}

const TAG_PREVIEW = 8          // 标签区默认条数（按成员页数降序）
const LIST_MAX = 30            // 底部清单最多渲染行数（超出给「…共 N 页」）

function Row({ g, active, onSelect, chevron, onChevron, sub }: {
  g: GraphGroupInfo
  active: boolean
  onSelect: () => void
  chevron?: boolean
  onChevron?: () => void
  sub?: boolean
}) {
  return (
    <div
      onClick={onSelect}
      className={`group/row relative flex items-center gap-1.5 mx-0.5 rounded-md cursor-pointer select-none ${
        sub ? 'pl-6 pr-1.5 py-[3px]' : 'px-2 py-1'
      } ${active ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
    >
      {active && <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-sm bg-[var(--accent)]" />}
      <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: KIND_COLOR[g.kind] }} />
      <span className="flex-1 min-w-0 truncate text-[12px]">{g.name}</span>
      <span className={`shrink-0 min-w-[22px] text-center text-[10px] leading-none px-1 py-[3px] rounded-full tabular-nums ${
        active ? 'text-[var(--text-primary)] bg-[var(--bg-primary)]' : 'text-[var(--text-muted)] group-hover/row:text-[var(--text-secondary)] group-hover/row:bg-[var(--bg-primary)]'
      }`}>{g.n}</span>
      {chevron !== undefined && (
        <span
          onClick={(e) => { e.stopPropagation(); onChevron?.() }}
          className="shrink-0 w-4 text-center text-[9px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          {chevron ? '▾' : '▸'}
        </span>
      )}
    </div>
  )
}

export function GraphSidebar({ data, activeKey, onSelect, onOpenPage }: Props) {
  const groups = useMemo(() => buildGraphGroups(data), [data])
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // 默认展开页数最多的一级目录（其他收起，避免长树把标签/待处理挤走）
    const top = groups.dirs[0]
    return top ? new Set([top.key]) : new Set()
  })
  const [showAllTags, setShowAllTags] = useState(false)
  const [showPack, setShowPack] = useState(false)

  const toggleDir = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 底部清单：当前群的成员页（unresolved 群 = 引用它的源页）
  const listPages = useMemo<GraphNode[]>(() => {
    if (!activeKey || activeKey === 'all') return data.nodes.filter((n) => n.kind === 'page')
    if (activeKey.startsWith('unresolved:')) {
      const name = activeKey.slice('unresolved:'.length)
      const u = data.unresolved.find((x) => x.name === name)
      const byId = new Map(data.nodes.map((n) => [n.id, n]))
      return (u?.refs ?? []).map((id) => byId.get(id)).filter((n): n is GraphNode => Boolean(n))
    }
    return groupMemberPages(data, activeKey)
  }, [data, activeKey])

  const visibleTags = useMemo(() => {
    const main = groups.tags.filter((t) => showPack || !isPackTag(t.name))
    return showAllTags ? main : main.slice(0, TAG_PREVIEW)
  }, [groups.tags, showAllTags, showPack])
  const packHidden = groups.tags.filter((t) => isPackTag(t.name)).length
  const activeListTitle = activeKey
    ? (activeKey === 'all' ? '全库' : activeKey.startsWith('dir:') ? activeKey.slice(4).split('/').pop() : activeKey.split(':').slice(1).join(':'))
    : '全库'

  return (
    <div className="flex h-full flex-col min-h-0 bg-[var(--bg-primary)]">
      {/* 头部：标题 + 两行统计，无说明文 */}
      <div className="shrink-0 px-3 pt-2.5 pb-1">
        <div className="text-[13px] font-semibold text-[var(--text-primary)]">图谱</div>
        <div className="text-[10.5px] text-[var(--text-muted)] mt-0.5">{groups.pageTotal} 页 · {groups.tagTotal} 标签</div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
        {/* 全库 */}
        <div className="mt-1.5">
          <Row g={{ key: 'all', kind: 'all', name: '全库', n: groups.pageTotal }} active={activeKey === 'all' || activeKey === null} onSelect={() => onSelect(null)} />
        </div>

        {/* 目录 */}
        <div className="mt-3">
          <div className="px-2 pb-1 text-[10.5px] tracking-wider text-[var(--text-muted)]">目录</div>
          {groups.dirs.map((d) => {
            const kids = groups.subDirs.get(d.key)
            return (
              <div key={d.key}>
                <Row
                  g={d}
                  active={activeKey === d.key}
                  onSelect={() => onSelect(activeKey === d.key ? null : d.key)}
                  chevron={kids ? Boolean(expanded.has(d.key)) : undefined}
                  onChevron={kids ? () => toggleDir(d.key) : undefined}
                />
                {kids && expanded.has(d.key) && kids.map((k) => (
                  <Row key={k.key} g={k} sub active={activeKey === k.key} onSelect={() => onSelect(activeKey === k.key ? null : k.key)} />
                ))}
              </div>
            )
          })}
        </div>

        {/* 标签 */}
        <div className="mt-3">
          <div className="flex items-center gap-1 px-2 pb-1 text-[10.5px] tracking-wider text-[var(--text-muted)]">
            <span>标签</span>
            <span className="flex-1" />
            {!showPack && packHidden > 0 && (
              <button onClick={() => setShowPack(true)} title="显示知识包短码标签"
                className="px-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                知识包
              </button>
            )}
            {showPack && (
              <button onClick={() => setShowPack(false)} title="隐藏知识包短码标签"
                className="px-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                隐藏短码
              </button>
            )}
            <button onClick={() => setShowAllTags((v) => !v)}
              className="px-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              {showAllTags ? '收起' : '全部'}
            </button>
          </div>
          {visibleTags.map((t) => (
            <Row key={t.key} g={t} active={activeKey === t.key} onSelect={() => onSelect(activeKey === t.key ? null : t.key)} />
          ))}
        </div>

        {/* 待处理 */}
        <div className="mt-3">
          <div className="px-2 pb-1 text-[10.5px] tracking-wider text-[var(--text-muted)]">待处理</div>
          <Row g={groups.orphan} active={activeKey === 'orphan'} onSelect={() => onSelect(activeKey === 'orphan' ? null : 'orphan')} />
          {groups.unresolved.map((u) => (
            <Row key={u.key} g={u} active={activeKey === u.key} onSelect={() => onSelect(activeKey === u.key ? null : u.key)} />
          ))}
        </div>
      </div>

      {/* 底部清单：当前群的成员页，点页名在编辑器打开 */}
      <div className="shrink-0 flex flex-col border-t border-[var(--border-color)] max-h-[32%]">
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border-color)] text-[10.5px] text-[var(--text-muted)]">
          <span className="truncate">{activeListTitle}</span>
          <span className="flex-1" />
          <span className="tabular-nums">{listPages.length} 页</span>
        </div>
        <div className="overflow-y-auto py-1 px-1.5">
          {listPages.slice(0, LIST_MAX).map((p) => (
            <div
              key={p.id}
              onClick={() => onOpenPage(p)}
              title={p.path || p.title}
              className="px-2 py-[3px] rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer truncate"
            >
              {p.title}
            </div>
          ))}
          {listPages.length > LIST_MAX && (
            <div className="px-2 py-[3px] text-[10.5px] text-[var(--text-muted)]">…共 {listPages.length} 页</div>
          )}
          {listPages.length === 0 && (
            <div className="px-2 py-1.5 text-[10.5px] text-[var(--text-muted)]">该群暂无页面</div>
          )}
        </div>
      </div>
    </div>
  )
}
