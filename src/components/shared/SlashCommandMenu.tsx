/**
 * 斜杠指令弹层（v3.1.1 条目10）—— 三聊天面共用的纯展示组件
 *
 * 数据源两层候选：
 *  - 「指令」= src/lib/chatCommands.ts 的 CHAT_COMMANDS 单一真源（当前 /compress）；
 *  - 「Skill · 已安装」= aiToolsListSkills() 现有 IPC（过滤 disabled）——显式调用入口。
 *
 * 键盘语义在宿主 textarea 的 onKeyDown 局部拦截（↑↓ 换高亮 / Enter 选中 /
 * Tab 只补全 / Esc 仅关弹层并 stopPropagation，不进各面板的全局 Esc 浮层链）。
 * 本组件只负责渲染与 hover，不持有任何业务状态。
 */
import { useMemo } from 'react'
import type { SkillInfo } from '../../types'
import { CHAT_COMMANDS } from '../../lib/chatCommands'
import { Zap, Wrench, Check } from 'lucide-react'

export interface SlashMenuItem {
  kind: 'command' | 'skill'
  /** 指令名（不带 /）或 Skill 注册名 */
  name: string
  /** 展示标题：指令 = /name；Skill = title */
  title: string
  /** 展示描述（已截断为一句） */
  desc: string
  /** 过滤匹配用全文（title+完整描述），展示与匹配分离 */
  search: string
}

/** 弹层一行文案：取第一句（。/；/—— 之前），超 40 字截断——弹层是速查索引，全文留给悬浮/文档 */
function shortDesc(d: string): string {
  const one = d.replace(/\s+/g, ' ').trim()
  const cut = one.search(/。|；|——/)
  const s = cut > 8 ? one.slice(0, cut) : one
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

/** 合并两张候选表（指令在前、Skill 在后），调用面只需各自拉一次 skills 列表 */
export function buildSlashItems(skills: SkillInfo[]): SlashMenuItem[] {
  const cmds: SlashMenuItem[] = CHAT_COMMANDS.map((c) => ({
    kind: 'command',
    name: c.name,
    title: `/${c.name}`,
    desc: shortDesc(c.desc),
    search: `${c.name} ${c.desc}`,
  }))
  const sks: SlashMenuItem[] = (skills ?? [])
    .filter((s) => !s.disabled)
    .map((s) => ({ kind: 'skill', name: s.registryName, title: s.title, desc: shortDesc(s.description), search: `${s.title} ${s.description}` }))
  return [...cmds, ...sks]
}

/** 前缀过滤：匹配 title 或 desc 或全文（大小写不敏感）；query 为空返回全部 */
export function filterSlashItems(items: SlashMenuItem[], query: string): SlashMenuItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((it) => it.title.toLowerCase().includes(q) || it.search.toLowerCase().includes(q))
}

interface Props {
  items: SlashMenuItem[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (item: SlashMenuItem) => void
}

export function SlashCommandMenu({ items, activeIndex, onHover, onPick }: Props) {
  // 分组边界：items 已按 buildSlashItems 顺序（指令段在前），按 kind 切组渲染组标题
  const groups = useMemo(() => {
    const g: { kind: 'command' | 'skill'; label: string; start: number; list: SlashMenuItem[] }[] = []
    items.forEach((it, i) => {
      const last = g[g.length - 1]
      if (last && last.kind === it.kind) last.list.push(it)
      else g.push({ kind: it.kind, label: it.kind === 'command' ? '指令' : 'Skill · 已安装', start: i, list: [it] })
    })
    return g
  }, [items])

  if (items.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1.5 z-30 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg kb-pop p-3 text-[12px] text-[var(--text-muted)]">
        没有匹配的指令或 Skill
      </div>
    )
  }

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1.5 z-30 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg kb-pop overflow-hidden"
      role="listbox"
    >
      <div className="max-h-[38vh] overflow-y-auto py-1">
        {groups.map((g) => (
          <div key={g.kind}>
            <div className="px-3 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-[var(--text-muted)] select-none">
              {g.label}
            </div>
            {g.list.map((it, j) => {
              const idx = g.start + j
              const active = idx === activeIndex
              return (
                <button
                  key={it.kind + it.name}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => onHover(idx)}
                  onClick={() => onPick(it)}
                  className={
                    'w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors ' +
                    (active ? 'bg-[var(--bg-hover)]' : '')
                  }
                >
                  <span className={'mt-0.5 shrink-0 ' + (active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')}>
                    {it.kind === 'command' ? <Zap size={13} /> : <Wrench size={13} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={'text-[12.5px] font-medium truncate ' + (active ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]')}>
                        {it.title}
                      </span>
                      {it.kind === 'skill' && (
                        <span className="shrink-0 text-[10px] px-1 rounded bg-[var(--bg-hover)] text-[var(--text-muted)]">显式调用</span>
                      )}
                    </span>
                    <span className="block text-[11px] leading-snug text-[var(--text-muted)] line-clamp-2">{it.desc}</span>
                  </span>
                  {active && (
                    <span className="mt-1 shrink-0 text-[10px] text-[var(--text-muted)] flex items-center gap-0.5">
                      <Check size={11} /> Enter
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="px-3 py-1.5 border-t border-[var(--border-color)] text-[10px] text-[var(--text-muted)] flex items-center gap-2 select-none">
        <span>↑↓ 选择</span><span>Enter 选中</span><span>Tab 补全</span><span>Esc 关闭</span>
      </div>
    </div>
  )
}
