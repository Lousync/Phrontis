import type { CSSProperties, ReactNode } from 'react'
import {
  CalendarCheck2, Timer, FileText, BookOpen, LayoutGrid, Check, ListTodo,
  type LucideIcon,
} from 'lucide-react'
import type { DashboardSnapshot } from '../../types'
import { Heatmap } from './Heatmap'

/**
 * 看板卡片注册表 —— **卡片清单的唯一真相源**。
 *
 * 与 `src/lib/appModules.ts` 同款思路：清单只写一处，消费者（渲染、编辑卡片弹层、
 * setting 默认值、契约脚本）都从这里取。抄成多份必然飘。
 *
 * 分组只决定**色相**（卡片背景渐变与水印取它），不决定业务含义：
 *   today → --accent　study → --success-ink　log → --warning-ink
 * 全部是主题令牌，换主题包整套跟着变 —— 这正是「卡片配色跟随主题」的落法。
 *
 * ⚠️ `id` 同时是 setting `dashboardCards` 里存的成员名，改名要同步 settings.ts 的默认值。
 */

export type CardGroup = 'today' | 'study' | 'log' | 'plugin'

export interface CardDef {
  id: string
  label: string
  group: CardGroup
  Icon: LucideIcon
  /** 首批默认显示的几张（其余可在「编辑卡片」里勾出来） */
  defaultOn: boolean
  /** 默认格子比例（宽 2-6 列 × 高 1-4 行，2026-09-28 栅格化）；用户改过的存 dashboardTileLayout */
  w: number
  h: number
}

export const HUE: Record<CardGroup, string> = {
  today: 'var(--accent)',
  study: 'var(--success-ink)',
  log: 'var(--warning-ink)',
  plugin: 'var(--accent)',
}

export const CARD_REGISTRY: readonly CardDef[] = [
  // 「今天该做的」= 常驻主磁贴（2026-09-28 栅格化降维，拍板：不再独占全宽横幅）：默认 4×2 置顶，
  // 可拖/可改尺寸，但**不参与显隐勾选** —— 渲染侧强制在场，setting dashboardCards 不含它
  // （沿用「主卡不在此列」口径，存量设置零迁移）。defaultOn: false 是为了让 settings 默认值不含它。
  { id: 'todos', label: '今天该做的', group: 'today', Icon: ListTodo, defaultOn: false, w: 2, h: 3 },
  // 「打卡连续」→「今日打卡」（看板方案 §5 反馈 4②，2026-09-27 拍板）：正文改为打卡项列表、可勾选。
  // id 保持 'habit' —— 它是 setting dashboardCards 里存的成员名，改 id 会牵连存量设置。
  { id: 'habit', label: '今日打卡', group: 'today', Icon: CalendarCheck2, defaultOn: true, w: 2, h: 2 },
  { id: 'usage', label: '今日使用', group: 'today', Icon: Timer, defaultOn: true, w: 2, h: 2 },
  { id: 'notes', label: '最近编辑', group: 'study', Icon: FileText, defaultOn: true, w: 2, h: 2 },
  // 「待复习错题」卡已随反馈 4① 移除（2026-09-27）—— 注册表 / 快照 / 设置默认值三处同步删。
  { id: 'book', label: '在读的书', group: 'study', Icon: BookOpen, defaultOn: true, w: 2, h: 2 },
  { id: 'heatmap', label: '使用热力图', group: 'study', Icon: LayoutGrid, defaultOn: true, w: 2, h: 2 },
]

/** setting `dashboardCards` 的默认值就是这里拼出来的，别再手抄一份 */
export const DEFAULT_CARD_IDS: string[] = CARD_REGISTRY.filter((c) => c.defaultOn).map((c) => c.id)

/** 卡片背景档位（与 setting `dashboardBg` 的取值一一对应） */
export type CardBg = 'none' | 'tint' | 'mark' | 'glow'

export const CARD_BG_OPTIONS: ReadonlyArray<{ id: CardBg; label: string }> = [
  { id: 'none', label: '素色' },
  { id: 'tint', label: '渐变' },
  { id: 'mark', label: '渐变+水印' },
  { id: 'glow', label: '角光' },
]

/** 背景美化：全走 `--h`（分组色相）+ 主题令牌，明暗主题下都成立 */
export function cardBgStyle(bg: CardBg, hue: string): CSSProperties {
  if (bg === 'tint' || bg === 'mark') {
    return { backgroundImage: `linear-gradient(152deg, color-mix(in srgb, ${hue} 16%, transparent), transparent 66%)` }
  }
  if (bg === 'glow') {
    return { backgroundImage: `radial-gradient(200px 150px at 106% -16%, color-mix(in srgb, ${hue} 38%, transparent), transparent 72%)` }
  }
  return {}
}

/* ==================== 卡片外壳 ==================== */

export function Card({ def, bg, w = 2, h = 2, children }: { def: CardDef; bg: CardBg; w?: number; h?: number; children: ReactNode }) {
  const hue = HUE[def.group]
  return (
    <section
      className="kb-item-in relative flex flex-col overflow-hidden rounded-[10px] border border-[var(--border-color)] transition-transform duration-150 hover:-translate-y-px"
      style={{
        backgroundColor: 'var(--card-bg)',
        ...cardBgStyle(bg, hue),
        gridColumn: `span ${w} / span ${w}`,
        gridRow: `span ${h} / span ${h}`,
      }}
    >
      {/* 水印：出界一半，读作「角落纹样」而不是一块可见图形 */}
      {bg === 'mark' && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-2.5 -bottom-3.5 opacity-[0.105] [html.theme-light_&]:opacity-[0.07]"
          style={{ color: hue }}
        >
          <def.Icon size={84} />
        </span>
      )}
      {/* 顶部玻璃高光描边（呼应窗口的液态玻璃令牌） */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, var(--glass-edge) 22%, var(--glass-edge) 78%, transparent)' }} />
      <div className="relative z-[1] flex items-center gap-[7px] px-3 pb-1.5 pt-2.5">
        <span style={{ color: 'var(--accent)' }}><def.Icon size={15} /></span>
        <b className="text-[12.5px] font-semibold text-[var(--text-primary)]">{def.label}</b>
      </div>
      <div className="relative z-[1] min-h-0 flex-1 overflow-hidden px-3 pb-3">{children}</div>
    </section>
  )
}

/* ==================== 小件 ==================== */

function Big({ value, unit }: { value: string | number; unit: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <b className="text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-[var(--text-primary)]">{value}</b>
      <span className="text-xs text-[var(--text-muted)]">{unit}</span>
    </div>
  )
}

function Caption({ children }: { children: ReactNode }) {
  return <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">{children}</div>
}

/** 横向进度条（复用应用里既有的 pbar 观感） */
function Bar({ pct }: { pct: number }) {
  return (
    <span className="block h-1 flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
      <i className="block h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  )
}

/* ==================== 各卡片正文 ==================== */

/** 今日打卡列表（反馈 4②，2026-09-27 拍板）：逐项列出 + 直接勾选；超出 max-h 卡内滚动
 *  （滚动条悬停卡片才可见 —— .kb-thin-scroll，index.css）。聚合数字不在此处：streak 在 hero 统计 pill。
 *  紧凑档 max-h 收到约 3 项（反馈 3）。
 *  勾选反馈（反馈 7，与打卡列表 TodayView 同款）：勾选瞬间在勾选圈位置按**习惯色**炸彩纸
 *  （坐标由调用方回传主组件统一 burstConfetti），圈体挂 ck-pop 弹跳 —— key 强制重挂保证动画重播。 */
function HabitCard({ snap, compact, onToggleHabit }: { snap: DashboardSnapshot; compact?: boolean; onToggleHabit?: (habitId: string, pos?: { x: number; y: number }) => void }) {
  const h = snap.habit
  if (h.items.length === 0) return <Caption>还没有打卡项</Caption>
  return (
    <div className={`kb-thin-scroll -mx-1 overflow-y-auto px-1 ${compact ? 'max-h-[111px]' : 'max-h-[148px]'}`}>
      {h.items.map((it) => (
        <button
          key={it.id}
          type="button"
          title={it.done ? '取消打卡' : '打卡'}
          onClick={(e) => {
            if (it.done) { onToggleHabit?.(it.id); return } // 取消勾不庆祝（同打卡列表口径）
            const r = e.currentTarget.getBoundingClientRect()
            onToggleHabit?.(it.id, { x: r.left + 14, y: r.top + r.height / 2 })
          }}
          className="flex w-full items-center gap-2.5 rounded-md px-1 py-1.5 text-left hover:bg-[var(--bg-hover)]"
        >
          <span
            key={it.done ? 'd' : 'u'}
            className={`grid h-[15px] w-[15px] flex-none place-items-center rounded-[4px] border-[1.5px] transition-colors ${it.done ? 'ck-pop' : ''}`}
            style={it.done
              ? { background: it.color || 'var(--accent)', borderColor: it.color || 'var(--accent)', color: '#fff' }
              : { borderColor: 'var(--text-muted)', color: 'transparent' }}
          >
            <Check size={10} />
          </span>
          <span className={`min-w-0 flex-1 truncate text-[12.5px] ${it.done ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
            {it.name}
          </span>
        </button>
      ))}
    </div>
  )
}

function UsageCard({ snap, compact }: { snap: DashboardSnapshot; compact?: boolean }) {
  // 口径固定「今日」（2026-09-28 拍板：区间切换器撤除 —— 它只影响这一张卡，语义不成立）；
  // 近 7 天柱状图保留（固定跨度，不随任何切换变）。
  const keys = Object.keys(snap.usage.days).sort()
  const total = keys.length > 0 ? (snap.usage.days[keys[keys.length - 1]] ?? 0) : 0
  const last7 = keys.slice(-7).map((k) => snap.usage.days[k] ?? 0)
  const max = Math.max(1, ...last7)
  return (
    <>
      <Big value={total} unit="分钟 今日" />
      <Caption>{total >= 60 ? `共 ${Math.floor(total / 60)} 小时 ${total % 60} 分` : '还没到一小时'}</Caption>
      <div className={`mt-3 flex items-end gap-1.5 ${compact ? 'h-[38px]' : 'h-[50px]'}`}>
        {last7.map((v, i) => (
          <i
            key={i}
            className="flex-1 rounded-t-[4px] rounded-b-[2px] transition-[height] duration-300"
            style={{ height: `${Math.max(4, (v / max) * 100)}%`, background: 'color-mix(in srgb, var(--accent) 55%, var(--bg-tertiary))' }}
          />
        ))}
      </div>
      <div className="mt-1 text-center text-[10px] text-[var(--text-muted)]">最近 7 天</div>
    </>
  )
}

/** 今天该做的（2026-09-28 主卡降维成磁贴）：待办两栏 + 进度条脚注；空态压成单行。
 *  常驻 —— 渲染侧强制在场（不在 dashboardCards 勾选清单里），可拖/可改尺寸、无 ×。 */
function TodoCard({ snap, compact, onMarkDone, onJumpSchedule }: {
  snap: DashboardSnapshot
  compact?: boolean
  onMarkDone?: (id: string) => void
  onJumpSchedule?: () => void
}) {
  const openTodos = [...snap.todos.overdue.map((t) => ({ ...t, late: true })), ...snap.todos.today.map((t) => ({ ...t, late: false }))]
  // 快照侧本就有上限（overdue 3 + today 4 = 7 条）；窄卡（默认 2×3）单栏，紧凑档再收
  const shownTodos = compact ? openTodos.slice(0, 4) : openTodos.slice(0, 7)
  const hiddenTodoCount = openTodos.length - shownTodos.length
  const donePct = snap.todos.totalToday > 0 ? Math.round((snap.todos.doneToday / snap.todos.totalToday) * 100) : 0
  return (
    <div className="flex h-full flex-col">
      {openTodos.length === 0 ? (
        <div className="py-1 text-[12.5px] text-[var(--text-muted)]">今天没有待办，清爽一天。</div>
      ) : (
        <div className="kb-thin-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {shownTodos.map((t) => (
            <div key={t.id} className="flex items-start gap-2.5 break-inside-avoid rounded-md py-1 hover:bg-[var(--bg-hover)]">
              <button
                type="button"
                onClick={() => onMarkDone?.(t.id)}
                title="标记完成"
                className="mt-0.5 grid h-[15px] w-[15px] flex-none place-items-center rounded-[4px] border-[1.5px] border-[var(--text-muted)] text-transparent transition-colors hover:border-[var(--accent)]"
              >
                <Check size={10} />
              </button>
              <div className="min-w-0 flex-1">
                <div className={`truncate text-[12.5px] ${t.late ? 'text-[var(--danger-ink)]' : 'text-[var(--text-primary)]'}`}>{t.title}</div>
                <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                  {t.time && <span>{t.time}</span>}
                  {t.late && <span className="rounded-full px-1.5" style={{ background: 'var(--danger-bg)', color: 'var(--danger-ink)' }}>逾期</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-auto flex items-center gap-3 border-t border-[var(--border-color)] pt-1.5 text-[11px] text-[var(--text-muted)]">
        <span className="flex-none">{snap.todos.doneToday}/{snap.todos.totalToday} 已完成</span>
        <span className="block h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
          <i className="block h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${donePct}%` }} />
        </span>
        {hiddenTodoCount > 0 && (
          <button
            type="button"
            onClick={onJumpSchedule}
            title="去日程处理剩余待办"
            className="flex-none rounded-md px-1 py-0.5 text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            还有 {hiddenTodoCount} 件 → 去日程
          </button>
        )}
      </div>
    </div>
  )
}

function NotesCard({ snap, compact, onOpenNote }: { snap: DashboardSnapshot; compact?: boolean; onOpenNote?: (relPath: string) => void }) {
  if (snap.recentNotes.length === 0) return <Caption>最近还没有编辑过笔记</Caption>
  const items = compact ? snap.recentNotes.slice(0, 4) : snap.recentNotes
  return (
    <div className="-mx-1">
      {items.map((n, i) => (
        <button
          key={n.id}
          type="button"
          title="在笔记区打开"
          onClick={() => onOpenNote?.(n.path)}
          className="flex w-full items-center gap-2.5 rounded-md px-1 py-1.5 text-left text-[12.5px] hover:bg-[var(--bg-hover)]"
        >
          <span className="h-[5px] w-[5px] flex-none rounded-full" style={{ background: i === 0 ? 'var(--accent)' : 'var(--text-muted)' }} />
          <span className="truncate text-[var(--text-primary)]">{n.title || '未命名'}</span>
          <span className="ml-auto flex-none text-[11px] text-[var(--text-muted)]">{relTime(n.updatedAt)}</span>
        </button>
      ))}
    </div>
  )
}

function BookCard({ snap, onOpenBook }: { snap: DashboardSnapshot; onOpenBook?: (relPath: string) => void }) {
  if (snap.reading.length === 0) return <Caption>书架里还没有在读的书</Caption>
  return (
    <div className="flex flex-col gap-3">
      {snap.reading.map((b) => (
        <button
          key={b.relPath}
          type="button"
          title="去书架继续阅读"
          onClick={() => onOpenBook?.(b.relPath)}
          className="flex gap-2.5 rounded-md text-left hover:bg-[var(--bg-hover)]"
        >
          <span className="grid h-[58px] w-[42px] flex-none place-items-center rounded-[5px] px-1 text-center text-[9px] text-[#cfc9f5]" style={{ background: 'linear-gradient(150deg,#534ab7,#2f2a63)', boxShadow: 'inset -3px 0 0 rgba(0,0,0,.28)' }}>
            {(b.displayName || '').slice(0, 6)}
          </span>
          <span className="min-w-0 flex-1 py-0.5">
            <span className="block truncate text-[12.5px] text-[var(--text-primary)]">{b.displayName || '未命名'}</span>
            <span className="mt-2 flex items-center gap-2">
              <Bar pct={b.pct} />
              <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{Math.round(b.pct)}%</span>
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

function HeatmapCard({ snap }: { snap: DashboardSnapshot }) {
  // 只记录「使用时长」一个指标（2026-09-28 拍板：专注时长切换器撤除，pomodoro 数据仍在快照里备用）
  const keys = Object.keys(snap.usage.days).sort()
  if (keys.length === 0) {
    return (
      <div className="py-7 text-center text-[12.5px] text-[var(--text-muted)]">
        还没有使用记录
      </div>
    )
  }
  const days = snap.usage.days
  return <Heatmap days={days} fromKey={keys[0]} toKey={keys[keys.length - 1]} unit="使用" />
}

/* ==================== 分发 ==================== */

export function CardBody({ def, snap, compact, onMarkDone, onToggleHabit, onOpenNote, onOpenBook, onJumpSchedule }: {
  def: CardDef; snap: DashboardSnapshot
  /** 紧凑档（看板方案 §5 反馈 3）：视口 <1000px 时收列表/图表高度，保证默认窗口无滚动条 */
  compact?: boolean
  onMarkDone?: (id: string) => void
  onToggleHabit?: (habitId: string, pos?: { x: number; y: number }) => void
  onOpenNote?: (relPath: string) => void
  onOpenBook?: (relPath: string) => void
  onJumpSchedule?: () => void
}) {
  switch (def.id) {
    case 'todos': return <TodoCard snap={snap} compact={compact} onMarkDone={onMarkDone} onJumpSchedule={onJumpSchedule} />
    case 'habit': return <HabitCard snap={snap} compact={compact} onToggleHabit={onToggleHabit} />
    case 'usage': return <UsageCard snap={snap} compact={compact} />
    case 'notes': return <NotesCard snap={snap} compact={compact} onOpenNote={onOpenNote} />
    case 'book': return <BookCard snap={snap} onOpenBook={onOpenBook} />
    case 'heatmap': return <HeatmapCard snap={snap} />
    default: return null
  }
}

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / n 天前 / YYYY-MM-DD */
export function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day === 1) return '昨天'
  if (day < 30) return `${day} 天前`
  return iso.slice(0, 10)
}
